import "fake-indexeddb/auto";
import type { FetchHandle } from "@defjs/core";
import { I18nProvider } from "@lingui/react";
import { act, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { HeadscaleSnapshot } from "@/api/contracts";
import AssignMemberDialog, {
  type AssignMemberOption,
} from "@/components/AssignMemberDialog";
import { i18n, setLocale } from "@/i18n";
import { getProductCopy } from "@/i18n/product-copy";
import { hydrateSettings } from "@/lib/settings-storage";
import {
  authenticateTestSession,
  prepareTestSession,
  renderSessionPage,
} from "@/test/session";
import MembersPage from "./MembersPage";

const copy = getProductCopy("en-US");
const alice = {
  id: "1",
  name: "alice",
  displayName: "Alice",
  email: "alice@example.com",
};
// No display name, email or provider: the row label is the user name itself.
const bob = { id: "2", name: "bob" };
const POLICY = JSON.stringify({
  groups: { "group:ops": ["alice@example.com"], "group:home": [] },
  tagOwners: { "tag:server": ["alice@example.com"] },
  acls: [{ action: "accept", src: ["group:ops"], dst: ["tag:server:22"] }],
});
function fixture(): HeadscaleSnapshot {
  return {
    health: { databaseConnectivity: true, serverReachable: true },
    version: { version: "0.29.4" },
    users: [{ ...alice }, { ...bob }, { id: "0", name: "tagged-devices" }],
    apiKeys: [],
    policy: { policy: POLICY },
    nodes: [
      {
        id: "1",
        name: "edge",
        givenName: "edge-router",
        user: alice,
        online: true,
        ipAddresses: ["100.64.0.1"],
        approvedRoutes: [],
        availableRoutes: [],
        subnetRoutes: [],
        tags: [],
      },
      {
        id: "2",
        name: "laptop",
        user: alice,
        online: false,
        ipAddresses: ["100.64.0.2"],
        approvedRoutes: [],
        availableRoutes: [],
        subnetRoutes: [],
        tags: [],
      },
    ],
    preAuthKeys: [
      {
        id: "1",
        key: "ready-key",
        user: alice,
        reusable: false,
        ephemeral: false,
        used: false,
        expiration: "2099-01-01T00:00:00Z",
        aclTags: [],
      },
    ],
  };
}
interface Call {
  origin: string;
  method: string;
  path: string;
  body: Record<string, unknown>;
}
async function setup(search = "", policy = POLICY) {
  await page.viewport(1366, 768);
  const backend = fixture();
  backend.policy = { policy };
  const calls: Call[] = [];
  const failingReads = new Set<string>();
  const failingWrites = new Map<string, string>();
  const renameResults = new Map<string, string>();
  const renameResponseUsers = new Map<
    string,
    HeadscaleSnapshot["users"][number]
  >();
  const readWaits = new Map<string, Promise<void>>();
  function pauseRead(path: string, origin = "") {
    const gate = Promise.withResolvers<void>();
    const key = `${origin}${path}`;
    readWaits.set(key, gate.promise);
    return () => {
      readWaits.delete(key);
      gate.resolve();
    };
  }
  const writeWaits = new Map<string, Promise<void>>();
  function pauseWrite(path: string) {
    const gate = Promise.withResolvers<void>();
    writeWaits.set(path, gate.promise);
    return () => {
      writeWaits.delete(path);
      gate.resolve();
    };
  }
  let renameWait: Promise<void> | undefined;
  function pauseRename() {
    const gate = Promise.withResolvers<void>();
    renameWait = gate.promise;
    return () => {
      renameWait = undefined;
      gate.resolve();
    };
  }
  const transport: FetchHandle = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const raw = await request.clone().text();
    const body = raw ? JSON.parse(raw) : {};
    calls.push({
      origin: url.origin,
      method: request.method,
      path: url.pathname,
      body,
    });
    if (request.method === "GET" && failingReads.has(url.pathname))
      return Response.json(
        { code: 13, message: "read failed" },
        { status: 500 },
      );
    if (request.method === "GET")
      await (readWaits.get(`${url.origin}${url.pathname}`) ??
        readWaits.get(url.pathname));
    if (request.method !== "GET") await writeWaits.get(url.pathname);
    if (request.method !== "GET" && failingWrites.has(url.pathname))
      return Response.json(
        { code: 9, message: failingWrites.get(url.pathname) },
        { status: 400 },
      );
    if (request.method === "POST" && url.pathname === "/api/v1/user") {
      const user = {
        id: String(backend.users.length + 10),
        ...body,
      } as typeof bob;
      backend.users.push(user);
      return Response.json({ user });
    }
    if (request.method === "POST" && url.pathname.includes("/rename/")) {
      await renameWait;
      const user = backend.users.find(
        (u) => u.id === url.pathname.split("/")[4],
      );
      if (!user) throw new Error("Missing fixture user");
      user.name =
        renameResults.get(user.id) ??
        decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      return Response.json({ user: renameResponseUsers.get(user.id) ?? user });
    }
    if (
      request.method === "DELETE" &&
      url.pathname.startsWith("/api/v1/user/")
    ) {
      const id = url.pathname.split("/").at(-1);
      backend.users = backend.users.filter((u) => u.id !== id);
      return Response.json({});
    }
    if (request.method === "PUT" && url.pathname === "/api/v1/policy") {
      backend.policy = { policy: String(body.policy) };
      return Response.json(backend.policy);
    }
    if (request.method === "POST" && url.pathname === "/api/v1/preauthkey") {
      const preAuthKey = {
        id: "2",
        key: "created-key",
        ...body,
        user: backend.users.find((u) => u.id === body.user),
        used: false,
      };
      backend.preAuthKeys.push({ ...preAuthKey, key: "hskey-auth-abc-***" });
      return Response.json({ preAuthKey });
    }
    const responses: Record<string, unknown> = {
      "/api/v1/health": backend.health,
      "/version": backend.version,
      "/api/v1/user": { users: backend.users },
      "/api/v1/node": { nodes: backend.nodes },
      "/api/v1/preauthkey": { preAuthKeys: backend.preAuthKeys },
      "/api/v1/apikey": { apiKeys: [] },
      "/api/v1/policy": backend.policy,
    };
    return Response.json(responses[url.pathname]);
  };
  const session = await prepareTestSession(transport);
  await setLocale("en-US");
  await authenticateTestSession(session);
  const rendered = await renderSessionPage(
    session,
    <MembersPage />,
    `/members${search}`,
  );
  await expect
    .poll(() => session.snapshot.getSnapshot().snapshot.health?.serverReachable)
    .toBe(true);
  await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
  calls.length = 0;
  return {
    backend,
    calls,
    session,
    failingReads,
    failingWrites,
    renameResults,
    renameResponseUsers,
    pauseRename,
    pauseRead,
    pauseWrite,
    ...rendered,
  };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
afterEach(() => vi.restoreAllMocks());
const writes = (ctx: Ctx) => ctx.calls.filter((call) => call.method !== "GET");
const summary = (ctx: Ctx) =>
  writes(ctx).map((call) => `${call.method} ${call.path}`);
async function expectCreateBlocked(ctx: Ctx, errorId: string) {
  await expect
    .poll(
      () =>
        writes(ctx).length > 0 ||
        Boolean(document.querySelector(`[data-testid="${errorId}"]`)),
    )
    .toBe(true);
  expect(writes(ctx)).toEqual([]);
}
async function memberAction(action: string, name: string) {
  await page.getByTestId(`member-actions-trigger-${name}`).click();
  await page.getByTestId(`${action}-member-${name}`).click();
}
function text(testid: string) {
  return String(
    document.querySelector(`[data-testid="${testid}"]`)?.textContent,
  );
}
function submitTwice(testid: string) {
  const form = page.getByTestId(testid).element().closest("form");
  expect.assert(form);
  // 两个事件在 React 提交 disabled 状态前到达，不能产生两次业务请求。
  form.requestSubmit();
  form.requestSubmit();
}
function captureDownloads() {
  const csv = { text: async (): Promise<string | undefined> => undefined };
  vi.spyOn(URL, "createObjectURL").mockImplementation((value) => {
    csv.text = () => (value as Blob).text();
    return "blob:fixture";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  return csv;
}

test("usability: member export adds stable identity while preserving filters and CSV protection", async () => {
  const csv = captureDownloads();
  const ctx = await setup();
  const user = {
    id: "2",
    name: "=bob",
    displayName: 'Shared "label"',
    email: "bob@example.com",
  };
  ctx.backend.users = [{ ...alice }, user];
  ctx.session.snapshot.applyPatch({
    users: structuredClone(ctx.backend.users),
  });
  await page.getByTestId("user-search").fill("=bob");
  await page.getByTestId("export-users").click();
  expect(await csv.text()).toBe(
    '"name","email","provider","machines","joined","id","username"\n"Shared ""label""","bob@example.com","","0","","2","\'=bob"',
  );
});

test("usability: unreadable policy defaults to user-only deletion instead of unavailable cleanup", async () => {
  const ctx = await setup("", "{ unreadable");
  await memberAction("delete", "bob");
  await expect
    .element(page.getByTestId("delete-member-cleanup-policy"))
    .not.toBeChecked();
  await expect
    .element(page.getByTestId("delete-member-cleanup-policy"))
    .toBeDisabled();
  await expect.element(page.getByTestId("confirm-delete-member")).toBeEnabled();
  await page.getByTestId("confirm-delete-member").click();
  await expect
    .element(page.getByTestId("delete-member-dialog"))
    .not.toBeInTheDocument();
  expect(summary(ctx)).toEqual(["DELETE /api/v1/user/2"]);
  expect(ctx.backend.users.some((user) => user.id === "2")).toBe(false);
});

// Headscale has no roles: an id-1 "owner" or a "system" service account would invent permissions.
test("the users page shows no invented roles in the table, toolbar, details or export", async () => {
  const csv = captureDownloads();
  await setup();
  await expect.element(page.getByTestId("member-alice")).toBeVisible();
  expect(document.querySelector('[data-testid="user-filter"]')).toBeNull();
  expect(document.querySelector('[data-testid^="member-role-"]')).toBeNull();
  const headers = Array.from(document.querySelectorAll("thead th"), (th) =>
    th.textContent?.trim(),
  );
  expect(headers).not.toContain("Role");
  await page.getByTestId("export-users").click();
  expect(await csv.text()).toMatch(
    /^"name","email","provider","machines","joined","id","username"\n/,
  );
  await page.getByTestId("member-detail-link-alice").click();
  await expect.element(page.getByTestId("user-detail-dialog")).toBeVisible();
  expect(text("user-detail-dialog")).not.toContain("Role");
});

test("user creation validates the name and email inline and sends nothing until both are valid", async () => {
  const ctx = await setup();
  await page.getByTestId("open-create-member").click();
  await expect
    .element(page.getByTestId("member-email"))
    .toHaveAttribute("type", "email");
  for (const id of ["member-display", "member-email"])
    expect(document.querySelector(`label[for="${id}"]`)?.textContent).toContain(
      copy.optionalField,
    );
  await page.getByTestId("create-member").click();
  await expect
    .element(page.getByTestId("member-name-error"))
    .toHaveTextContent(copy.userNameRequired);
  await expect
    .element(page.getByTestId("member-name"))
    .toHaveAttribute("aria-invalid", "true");
  await expect.element(page.getByTestId("member-name")).toHaveFocus();
  await page.getByTestId("member-name").fill("Bad User!");
  await expect
    .element(page.getByTestId("member-name-error"))
    .toHaveTextContent(copy.userNameInvalid);
  await page.getByTestId("member-name").fill("alice");
  await expect
    .element(page.getByTestId("member-name-error"))
    .toHaveTextContent(copy.userNameTaken);
  await page.getByTestId("member-name").fill(" carol ");
  await expect
    .element(page.getByTestId("member-name-error"))
    .not.toBeInTheDocument();
  await page.getByTestId("member-email").fill("not-an-email");
  await expect.element(page.getByTestId("create-member")).toBeDisabled();
  await expect
    .element(page.getByTestId("member-email-error"))
    .toHaveTextContent(copy.emailInvalid);
  await expect
    .element(page.getByTestId("member-email"))
    .toHaveAttribute("aria-invalid", "true");
  expect(writes(ctx)).toEqual([]);
  await page.getByTestId("member-email").fill("carol@example.com");
  await page.getByTestId("create-member").click();
  await expect.element(page.getByTestId("member-carol")).toBeVisible();
  expect(summary(ctx)).toEqual(["POST /api/v1/user"]);
  expect(writes(ctx)[0]?.body).toMatchObject({
    name: "carol",
    email: "carol@example.com",
  });
});

test("rejects a new member that makes an existing policy principal ambiguous", async () => {
  const ctx = await setup();
  await page.getByTestId("open-create-member").click();
  await page.getByTestId("member-name").fill("alice-copy");
  await page.getByTestId("member-email").fill("alice@example.com");
  await page.getByTestId("create-member").click();
  await expect
    .poll(
      () =>
        ctx.backend.users.length > 3 ||
        document
          .querySelector('[data-testid="member-email"]')
          ?.getAttribute("aria-invalid") === "true",
    )
    .toBe(true);
  expect(
    ctx.calls.filter(
      (call) => call.method === "POST" && call.path === "/api/v1/user",
    ),
  ).toEqual([]);
  expect(ctx.backend.users.map((user) => user.id)).toEqual(["1", "2", "0"]);
  expect(ctx.backend.policy?.policy).toBe(POLICY);
  await expect
    .element(page.getByTestId("member-email"))
    .toHaveAttribute("aria-invalid", "true");
  await expect.element(page.getByTestId("member-email-error")).toBeVisible();
  await expect
    .element(page.getByTestId("member-name"))
    .toHaveValue("alice-copy");
});

test.each(["name", "email"] as const)(
  "G01 a conflicting %s can be corrected without losing format validation or the normalized draft",
  async (field) => {
    const ctx = await setup();
    await page.getByTestId("open-create-member").click();
    await page
      .getByTestId("member-name")
      .fill(field === "name" ? "alice@example.com" : "Carol");
    await page
      .getByTestId("member-email")
      .fill(field === "email" ? "alice@example.com" : "Carol@Example.com");
    await page.getByTestId("member-display").fill("  Carol User  ");
    await page.getByTestId("create-member").click();
    await expectCreateBlocked(ctx, `member-${field}-error`);
    await expect
      .element(page.getByTestId(`member-${field}-error`))
      .toBeVisible();
    await page
      .getByTestId(`member-${field}`)
      .fill(field === "name" ? "bad name" : "not-email");
    await expect
      .element(page.getByTestId(`member-${field}-error`))
      .toHaveTextContent(
        field === "name" ? copy.userNameInvalid : copy.emailInvalid,
      );
    await page
      .getByTestId(`member-${field}`)
      .fill(field === "name" ? "  Carol  " : "  Carol@Example.com  ");
    await expect
      .element(page.getByTestId(`member-${field}-error`))
      .not.toBeInTheDocument();
    await expect.element(page.getByTestId("create-member")).toBeEnabled();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByTestId("member-Carol")).toBeVisible();
    expect(summary(ctx)).toEqual(["POST /api/v1/user"]);
    expect(writes(ctx)[0]?.body).toEqual({
      name: "Carol",
      displayName: "Carol User",
      email: "Carol@Example.com",
    });
    expect(ctx.backend.policy?.policy).toBe(POLICY);
  },
);

test("G01 submission rereads identity instead of trusting the directory from dialog open", async () => {
  const ctx = await setup();
  await page.getByTestId("open-create-member").click();
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  await page.getByTestId("member-name").fill("carol");
  await page.getByTestId("member-email").fill("late@example.com");
  ctx.backend.users.push({
    id: "7",
    name: "external",
    email: "late@example.com",
  });
  expect(ctx.session.snapshot.userById("7")).toBeUndefined();
  const readStart = ctx.calls.length;
  await page.getByTestId("create-member").click();
  await expectCreateBlocked(ctx, "member-email-error");
  await expect.element(page.getByTestId("member-email-error")).toBeVisible();
  expect(
    ctx.calls.slice(readStart).map((call) => `${call.method} ${call.path}`),
  ).toEqual([
    "GET /api/v1/user",
    "GET /api/v1/preauthkey",
    "GET /api/v1/apikey",
  ]);
  expect(ctx.session.snapshot.userById("7")?.name).toBe("external");
  await expect
    .element(page.getByTestId("member-email"))
    .toHaveValue("late@example.com");
});

test.each(["/api/v1/user", "/api/v1/preauthkey", "/api/v1/apikey"])(
  "G01 a failed identity read at %s sends no create and permits an explicit read retry",
  async (path) => {
    const ctx = await setup();
    await page.getByTestId("open-create-member").click();
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
    ctx.failingReads.add(path);
    await page.getByTestId("member-name").fill("  carol  ");
    await page.getByTestId("member-display").fill("  Carol User  ");
    await page.getByTestId("create-member").click();
    await expectCreateBlocked(ctx, "create-member-error");
    await expect
      .element(page.getByTestId("create-member-error"))
      .toMatchTextContent(/No create request was sent/);
    expect(ctx.session.feedback.actionOutcome("create-member")).toBeUndefined();
    await expect.element(page.getByTestId("member-name")).toHaveValue("carol");
    await expect
      .element(page.getByTestId("member-display"))
      .toHaveValue("Carol User");
    await expect.element(page.getByTestId("create-member")).toBeEnabled();
    ctx.failingReads.clear();
    await page.getByTestId("create-member").click();
    await expect.element(page.getByTestId("member-carol")).toBeVisible();
    expect(summary(ctx)).toEqual(["POST /api/v1/user"]);
    expect(writes(ctx)[0]?.body).toEqual({
      name: "carol",
      displayName: "Carol User",
      email: "",
    });
  },
);

test("G01 repeated submits remain locked across the fresh identity read and dispatch only once", async () => {
  const ctx = await setup();
  await page.getByTestId("open-create-member").click();
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  await page.getByTestId("member-name").fill("carol");
  const readStart = ctx.calls.length;
  const release = ctx.pauseRead("/api/v1/user");
  try {
    submitTwice("create-member");
    await expect
      .poll(() =>
        ctx.calls
          .slice(readStart)
          .some(
            (call) => call.path === "/api/v1/user" && call.method === "GET",
          ),
      )
      .toBe(true);
    expect(writes(ctx)).toEqual([]);
    await expect
      .element(page.getByTestId("create-member"))
      .toHaveAttribute("aria-busy", "true");
    await expect
      .element(page.getByTestId("member-name"))
      .toHaveAttribute("readonly");
    await expect
      .element(page.getByTestId("cancel-create-member"))
      .toBeDisabled();
    await userEvent.keyboard("{Escape}");
    await expect
      .element(page.getByTestId("member-create-dialog"))
      .toBeVisible();
    submitTwice("create-member");
  } finally {
    release();
  }
  await expect.element(page.getByTestId("member-carol")).toBeVisible();
  expect(summary(ctx)).toEqual(["POST /api/v1/user"]);
});

test.each([
  "switch",
  "logout",
  "held-draft",
  "discarded-view",
  "unmount",
  "reopen",
] as const)(
  "G01 a pending identity read cannot create after %s",
  async (change) => {
    const ctx = await setup();
    await page.getByTestId("open-create-member").click();
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
    await page.getByTestId("member-name").fill("old-draft");
    const readStart = ctx.calls.length;
    const release = ctx.pauseRead("/api/v1/user", "https://fixture.invalid");
    try {
      await page.getByTestId("create-member").click();
      await expect
        .poll(() =>
          ctx.calls
            .slice(readStart)
            .some(
              (call) => call.path === "/api/v1/user" && call.method === "GET",
            ),
        )
        .toBe(true);
      expect(writes(ctx)).toEqual([]);
      if (change === "switch") {
        await authenticateTestSession(ctx.session, "https://other.invalid");
        expect(ctx.session.auth.getSessionSnapshot()?.profile?.baseUrl).toBe(
          "https://other.invalid",
        );
        expect(
          ctx.calls.some((call) => call.origin === "https://other.invalid"),
        ).toBe(true);
      } else if (change === "logout") {
        await ctx.session.profiles.logout();
      } else if (change === "held-draft" || change === "discarded-view") {
        expect(
          ctx.session.drafts.hold({ id: "other", name: "Other server" }),
        ).toBe(true);
        if (change === "discarded-view") ctx.session.drafts.discard();
      } else {
        await ctx.router.navigate({ to: "/devices" });
        await expect
          .element(page.getByTestId("test-route"))
          .toHaveTextContent("/devices");
        if (change === "reopen") {
          await ctx.router.navigate({ to: "/members" });
          await page.getByTestId("open-create-member").click();
          await page.getByTestId("member-name").fill("new-draft");
        }
      }
    } finally {
      release();
    }
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
    if (change === "reopen") {
      await expect
        .element(page.getByTestId("member-name"))
        .toHaveValue("new-draft");
      await expect
        .element(page.getByTestId("member-name-error"))
        .not.toBeInTheDocument();
      await page.getByTestId("create-member").click();
      await expect.element(page.getByTestId("member-new-draft")).toBeVisible();
      expect(writes(ctx).map((call) => call.body.name)).toEqual(["new-draft"]);
    } else {
      if (change !== "unmount")
        await expect
          .element(page.getByTestId("create-member"))
          .toHaveAttribute("aria-busy", "false");
      expect(writes(ctx)).toEqual([]);
    }
    expect(ctx.backend.users.some((user) => user.name === "old-draft")).toBe(
      false,
    );
    expect(ctx.backend.policy?.policy).toBe(POLICY);
  },
);

test("G01 closing a failed preflight forgets its error and draft before reopening", async () => {
  const ctx = await setup();
  await page.getByTestId("open-create-member").click();
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  ctx.failingReads.add("/api/v1/user");
  await page.getByTestId("member-name").fill("old-draft");
  await page.getByTestId("create-member").click();
  await expectCreateBlocked(ctx, "create-member-error");
  await expect.element(page.getByTestId("create-member-error")).toBeVisible();
  await page.getByTestId("cancel-create-member").click();
  ctx.failingReads.clear();
  await page.getByTestId("open-create-member").click();
  await expect
    .element(page.getByTestId("create-member-error"))
    .not.toBeInTheDocument();
  await expect.element(page.getByTestId("member-name")).toHaveValue("");
  expect(writes(ctx)).toEqual([]);
});

test.each(["provider-owned", "already-ambiguous"] as const)(
  "G01 a %s alias does not globally prohibit unrelated creation or rewrite policy",
  async (directory) => {
    const ctx = await setup();
    ctx.backend.users.push({
      id: "7",
      name: "external",
      ...(directory === "provider-owned"
        ? { providerId: "alice@example.com" }
        : { email: "alice@example.com" }),
    });
    await ctx.session.snapshot.refreshSegments(["identity"]);
    await page.getByTestId("open-create-member").click();
    await page.getByTestId("member-name").fill("carol");
    await page.getByTestId("member-email").fill("alice@example.com");
    await page.getByTestId("create-member").click();
    await expect.element(page.getByTestId("member-carol")).toBeVisible();
    expect(summary(ctx)).toEqual(["POST /api/v1/user"]);
    expect(ctx.backend.policy?.policy).toBe(POLICY);
  },
);

test("member text fields trim on blur without showing validation errors before submission", async () => {
  await setup();
  await page.getByTestId("open-create-member").click();
  for (const [id, value] of [
    ["member-name", "Carol"],
    ["member-display", "Carol User"],
    ["member-email", "carol@example.com"],
  ]) {
    await page.getByTestId(id).fill(`  ${value}  `);
    await userEvent.keyboard("{Tab}");
    await expect.element(page.getByTestId(id)).toHaveValue(value);
  }
  await page.getByTestId("member-name").fill("invalid name");
  await userEvent.keyboard("{Tab}");
  await expect
    .element(page.getByTestId("member-name-error"))
    .not.toBeInTheDocument();
  await page.getByTestId("cancel-create-member").click();
  await memberAction("rename", "bob");
  await page.getByTestId("rename-member-name").fill("  Robert  ");
  await userEvent.keyboard("{Tab}");
  await expect
    .element(page.getByTestId("rename-member-name"))
    .toHaveValue("Robert");
});

test("Enter normalizes the display name as well as name and email before creating a member", async () => {
  const ctx = await setup();
  await page.getByTestId("open-create-member").click();
  await page.getByTestId("member-name").fill("  Alice  ");
  await page.getByTestId("member-email").fill("  Alice@example.com  ");
  await page.getByTestId("member-display").fill("  Alice User  ");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("member-Alice")).toBeVisible();
  expect(writes(ctx)[0]?.body).toEqual({
    name: "Alice",
    displayName: "Alice User",
    email: "Alice@example.com",
  });
  expect(summary(ctx)).toEqual(["POST /api/v1/user"]);
});

test("member creation submits once while pending and retains a normalized failed draft for retry", async () => {
  const ctx = await setup();
  ctx.failingWrites.set("/api/v1/user", "Create denied");
  const release = ctx.pauseWrite("/api/v1/user");
  await page.getByTestId("open-create-member").click();
  await page.getByTestId("member-name").fill("  carol  ");
  await page.getByTestId("member-display").fill("  Carol User  ");
  try {
    submitTwice("create-member");
    await expect.poll(() => summary(ctx)).toEqual(["POST /api/v1/user"]);
    await expect
      .element(page.getByTestId("create-member"))
      .toHaveAttribute("aria-busy", "true");
    await expect
      .element(page.getByTestId("cancel-create-member"))
      .toBeDisabled();
  } finally {
    release();
  }
  await expect
    .element(page.getByTestId("create-member-error"))
    .toMatchTextContent("Create denied");
  await expect
    .element(page.getByTestId("member-display"))
    .toHaveValue("Carol User");
  await expect.element(page.getByTestId("create-member")).toBeEnabled();
  ctx.failingWrites.clear();
  await page.getByTestId("create-member").click();
  await expect.element(page.getByTestId("member-carol")).toBeVisible();
  expect(summary(ctx)).toEqual(["POST /api/v1/user", "POST /api/v1/user"]);
  expect(writes(ctx)[1]?.body).toMatchObject({
    name: "carol",
    displayName: "Carol User",
  });
});

test("the create dialog explains its own fields and forgets input when it is dismissed", async () => {
  await setup();
  await page.getByTestId("open-create-member").click();
  await expect
    .element(page.getByTestId("member-create-dialog"))
    .toMatchTextContent(copy.createMemberDescription);
  expect(text("member-create-dialog")).not.toContain(copy.membersSubtitle);
  await page.getByTestId("member-name").fill("draft name");
  await page.getByTestId("member-email").fill("draft");
  await page.getByTestId("create-member").click();
  await expect.element(page.getByTestId("member-name-error")).toBeVisible();
  await page.getByTestId("cancel-create-member").click();
  await expect
    .element(page.getByTestId("member-create-dialog"))
    .not.toBeInTheDocument();
  await page.getByTestId("open-create-member").click();
  await expect.element(page.getByTestId("member-name")).toHaveValue("");
  await expect.element(page.getByTestId("member-email")).toHaveValue("");
  expect(
    document.querySelector('[data-testid="member-name-error"]'),
  ).toBeNull();
  await page.getByTestId("member-display").fill("Draft");
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByTestId("member-create-dialog"))
    .not.toBeInTheDocument();
  await page.getByTestId("open-create-member").click();
  await expect.element(page.getByTestId("member-display")).toHaveValue("");
});

test("rename validates on the first submit and follows subsequent changes without writing invalid names", async () => {
  const ctx = await setup();
  await memberAction("rename", "bob");
  const confirm = page.getByTestId("confirm-rename-member");
  await expect.element(confirm).toBeDisabled();
  await page.getByTestId("rename-member-name").fill("b ob");
  await expect
    .element(page.getByTestId("rename-member-name-error"))
    .not.toBeInTheDocument();
  await confirm.click();
  await expect
    .element(page.getByTestId("rename-member-name-error"))
    .toHaveTextContent(copy.userNameInvalid);
  await expect.element(page.getByTestId("rename-member-name")).toHaveFocus();
  for (const [value, message] of [
    ["   ", copy.userNameRequired],
    [" bob ", ""],
    ["alice", copy.userNameTaken],
    ["b ob", copy.userNameInvalid],
  ]) {
    await page.getByTestId("rename-member-name").fill(value);
    await expect.element(confirm).toBeDisabled();
    if (message)
      await expect
        .element(page.getByTestId("rename-member-name-error"))
        .toHaveTextContent(message);
    else
      await expect
        .element(page.getByTestId("rename-member-name-error"))
        .not.toBeInTheDocument();
  }
  await userEvent.keyboard("{Enter}");
  expect(writes(ctx)).toEqual([]);
  await page.getByTestId("rename-member-name").fill(" bob2 ");
  await expect.element(confirm).toBeEnabled();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("member-bob2")).toBeVisible();
  expect(summary(ctx)).toEqual(["POST /api/v1/user/2/rename/bob2"]);
});

test("a user name containing @ is rewritten in the policy without a doubled suffix", async () => {
  const policy = JSON.stringify({
    groups: { "group:ops": ["ops@corp"] },
    acls: [{ action: "accept", src: ["ops@corp"], dst: ["tag:server:22"] }],
  });
  const ctx = await setup("", policy);
  ctx.backend.users.push({ id: "7", name: "ops@corp" });
  await ctx.session.snapshot.refreshSnapshot();
  await memberAction("rename", "ops@corp");
  await expect
    .element(page.getByTestId("rename-member-policy-impact"))
    .toMatchTextContent("group:ops");
  await page.getByTestId("rename-member-name").fill("ops2@corp");
  await page.getByTestId("confirm-rename-member").click();
  await page.getByTestId("policy-publication-confirm").click();
  await expect
    .element(page.getByTestId("rename-member-dialog"))
    .not.toBeInTheDocument();
  expect(summary(ctx)).toEqual([
    "POST /api/v1/user/7/rename/ops2%40corp",
    "PUT /api/v1/policy",
  ]);
  const saved = JSON.parse(String(writes(ctx)[1]?.body.policy));
  expect(saved.groups["group:ops"]).toEqual(["ops2@corp"]);
  expect(saved.acls[0].src).toEqual(["ops2@corp"]);
});

// The partial state must come from this dialog's own rename, not from a snapshot that changed elsewhere.
test("a rename made elsewhere while the dialog is open does not skip this rename", async () => {
  const ctx = await setup(
    "",
    JSON.stringify({ groups: { "group:ops": ["alice@"] }, acls: [] }),
  );
  await memberAction("rename", "alice");
  await expect
    .element(page.getByTestId("rename-member-policy-impact"))
    .toBeVisible();
  const renamed = ctx.backend.users.find((user) => user.id === "1");
  if (!renamed) throw new Error("Missing fixture user");
  renamed.name = "alice-elsewhere";
  ctx.session.snapshot.applyPatch({
    users: structuredClone(ctx.backend.users),
  });
  await expect
    .element(page.getByTestId("member-alice-elsewhere"))
    .toBeInTheDocument();
  await expect.element(page.getByTestId("rename-member-name")).toBeEnabled();
  expect(
    document.querySelector('[data-testid="rename-member-policy-pending"]'),
  ).toBeNull();
  await page.getByTestId("rename-member-name").fill("alice2");
  await page.getByTestId("confirm-rename-member").click();
  await page.getByTestId("policy-publication-confirm").click();
  await expect
    .element(page.getByTestId("rename-member-dialog"))
    .not.toBeInTheDocument();
  expect(summary(ctx)).toEqual([
    "POST /api/v1/user/1/rename/alice2",
    "PUT /api/v1/policy",
  ]);
  expect(
    JSON.parse(String(ctx.backend.policy?.policy)).groups["group:ops"],
  ).toEqual(["alice2@"]);
});

// A source page in the URL only matters when the admin dismisses the details they came for.
test("row actions under a source-page link stay on their action", async () => {
  const ctx = await setup("?user=2&from=devices");
  await memberAction("create-invite-for", "bob");
  await expect.element(page.getByTestId("invite-create-dialog")).toBeVisible();
  expect(ctx.router.state.location.pathname).toBe("/members");
  await page.getByTestId("cancel-create-invite").click();
  await expect
    .element(page.getByTestId("invite-create-dialog"))
    .not.toBeInTheDocument();
  await page.getByTestId("member-actions-trigger-bob").click();
  await page.getByTestId("view-member-machines-bob").click();
  await expect.poll(() => ctx.router.state.location.pathname).toBe("/devices");
  expect(ctx.router.state.location.search).toEqual({ user: "2" });
});

test("view devices links to the exact user rather than a text search", async () => {
  const ctx = await setup();
  await page.getByTestId("member-actions-trigger-alice").click();
  await page.getByTestId("view-member-machines-alice").click();
  await expect.poll(() => ctx.router.state.location.pathname).toBe("/devices");
  expect(ctx.router.state.location.search).toEqual({ user: "1" });
});

test("user details open at the top and show the user name, list placeholders and active keys", async () => {
  const ctx = await setup();
  await page.viewport(900, 420);
  await page.getByTestId("member-detail-link-alice").click();
  await expect.element(page.getByTestId("user-detail-dialog")).toBeVisible();
  await expect
    .poll(() => document.activeElement?.getAttribute("data-testid"))
    .toBe("user-detail-dialog");
  expect(
    document.querySelector('[data-testid="user-detail-dialog"]')?.scrollTop,
  ).toBe(0);
  await expect
    .element(page.getByTestId("user-detail-username"))
    .toHaveTextContent(`${copy.memberName}: alice`);
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("member-detail-link-bob").click();
  const details = page.getByTestId("user-detail-dialog");
  await expect.element(details).toMatchTextContent(copy.noActiveAuthKeys);
  expect(text("user-detail-dialog")).not.toContain(copy.noAuthKeys);
  expect(text("user-detail-dialog")).toContain(`${copy.email}: -`);
  expect(text("user-detail-dialog")).toContain(`${copy.authSource}: -`);
  expect(text("user-detail-dialog")).not.toContain(copy.unknown);
  await userEvent.keyboard("{Escape}");
  ctx.backend.users.push({ id: "6", name: "", displayName: "Display Only" });
  await ctx.session.snapshot.refreshSnapshot();
  await page.getByTestId("member-detail-link-").click();
  await expect
    .element(page.getByTestId("user-detail-username"))
    .toHaveTextContent(`${copy.memberName}: -`);
});

test("rows show the user name under a display name and device chips name their status", async () => {
  const ctx = await setup();
  ctx.backend.nodes.push({
    ...structuredClone(ctx.backend.nodes[1]),
    id: "3",
    givenName: "old-phone",
    expiry: "2000-01-01T00:00:00Z",
  } as HeadscaleSnapshot["nodes"][number]);
  await ctx.session.snapshot.refreshSnapshot();
  await expect
    .element(page.getByTestId("member-detail-link-alice"))
    .toHaveTextContent("Alice");
  await expect
    .element(page.getByTestId("member-username-alice"))
    .toHaveTextContent("alice");
  await expect
    .element(page.getByTestId("member-alice"))
    .toMatchTextContent("alice@example.com");
  expect(
    document.querySelector('[data-testid="member-username-bob"]'),
  ).toBeNull();
  await expect
    .element(page.getByTestId("member-device-tag-alice-1"))
    .toMatchTextContent("Online");
  await expect
    .element(page.getByTestId("member-device-tag-alice-2"))
    .toMatchTextContent("Offline");
  await expect
    .element(page.getByTestId("member-device-tag-alice-3"))
    .toMatchTextContent("Expired");
});

test("the count shows filtered totals and export is disabled when no row matches", async () => {
  await setup();
  const count = page.getByTestId("user-count");
  await expect.element(count).toHaveTextContent("2 / 2");
  await expect
    .element(page.getByTestId("export-users"))
    .toHaveAttribute("title", copy.exportData);
  await page.getByTestId("user-search").fill("zzz-no-match");
  await expect.element(count).toHaveTextContent("0 / 2");
  await expect.element(page.getByTestId("export-users")).toBeDisabled();
  await expect
    .element(page.getByTestId("members-state"))
    .toHaveTextContent(copy.noUsersMatch);
});

test("loading, failed and empty user lists are not reported as unmatched filters", async () => {
  const ctx = await setup();
  ctx.session.snapshot.resetSnapshot();
  await expect
    .element(page.getByTestId("members-state"))
    .toHaveTextContent(copy.membersLoading);
  ctx.failingReads.add("/api/v1/user");
  await ctx.session.snapshot.refreshSnapshot();
  await expect
    .element(page.getByTestId("members-state"))
    .toMatchTextContent(copy.membersLoadFailed);
  expect(text("members-state")).not.toContain("read failed");
  ctx.failingReads.clear();
  ctx.backend.users = ctx.backend.users.filter((user) => user.id === "0");
  await page.getByTestId("retry-members").click();
  await expect
    .element(page.getByTestId("members-state"))
    .toHaveTextContent(copy.noUsersYet);
  await expect.element(page.getByTestId("export-users")).toBeDisabled();
});

test("removing a policy reference has a 24px target and asks before saving", async () => {
  const ctx = await setup("?user=1&popup=user");
  await expect.element(page.getByTestId("user-detail-dialog")).toBeVisible();
  const remove = document.querySelector<HTMLButtonElement>(
    '[data-testid^="remove-user-policy-reference-group-"]',
  );
  if (!remove?.dataset.testid)
    throw new Error("Missing reference remove button");
  // Layout size: the dialog's opening zoom transform shrinks the bounding rect for a moment.
  expect(remove.offsetWidth).toBeGreaterThanOrEqual(24);
  expect(remove.offsetHeight).toBeGreaterThanOrEqual(24);
  await page.getByTestId(remove.dataset.testid).click();
  await expect
    .element(page.getByTestId("remove-user-policy-reference-confirm"))
    .toMatchTextContent(copy.removeReferenceDescription);
  await page.getByTestId("cancel-remove-user-policy-reference").click();
  await expect
    .element(page.getByTestId("remove-user-policy-reference-confirm"))
    .not.toBeInTheDocument();
  expect(writes(ctx)).toEqual([]);
  await page.getByTestId(remove.dataset.testid).click();
  await page.getByTestId("confirm-remove-user-policy-reference").click();
  expect(writes(ctx)).toEqual([]);
  await page.getByTestId("policy-publication-confirm").click();
  await expect
    .element(page.getByTestId(remove.dataset.testid.replace("remove-", "")))
    .not.toBeInTheDocument();
  await expect.element(page.getByTestId("user-detail-dialog")).toBeVisible();
  expect(summary(ctx)).toEqual(["PUT /api/v1/policy"]);
  expect(
    JSON.parse(String(ctx.backend.policy?.policy)).groups["group:ops"],
  ).toEqual([]);
});

test("deleting a user shows its devices and keys and is disabled while it still owns devices", async () => {
  const ctx = await setup();
  await memberAction("delete", "alice");
  const summaryText = page.getByTestId("delete-member-summary");
  await expect
    .element(summaryText)
    .toMatchTextContent(`${copy.memberDevices}: 2`);
  await expect
    .element(summaryText)
    .toMatchTextContent(`${copy.activeAuthKeys}: 1`);
  await expect
    .element(page.getByTestId("delete-member-devices"))
    .toMatchTextContent(copy.deleteMemberOwnsDevices);
  expect(text("delete-member-devices")).toContain("edge-router");
  expect(text("delete-member-devices")).toContain("laptop");
  await expect
    .element(page.getByTestId("confirm-delete-member"))
    .toBeDisabled();
  ctx.backend.nodes = [];
  await ctx.session.snapshot.refreshSnapshot();
  await expect
    .element(page.getByTestId("delete-member-devices"))
    .not.toBeInTheDocument();
  await expect
    .element(summaryText)
    .toMatchTextContent(`${copy.memberDevices}: 0`);
  await expect.element(page.getByTestId("confirm-delete-member")).toBeEnabled();
  await page.getByTestId("confirm-delete-member").click();
  await page.getByTestId("policy-publication-confirm").click();
  await expect
    .element(page.getByTestId("delete-member-dialog"))
    .not.toBeInTheDocument();
  expect(summary(ctx)).toEqual(["DELETE /api/v1/user/1", "PUT /api/v1/policy"]);
});

test("an auth key created from a user row is single-use by default and revealed on the keys page", async () => {
  const ctx = await setup();
  await memberAction("create-invite-for", "bob");
  await expect.element(page.getByTestId("invite-user")).toHaveValue("2");
  await expect.element(page.getByTestId("invite-reusable")).not.toBeChecked();
  await page.getByTestId("create-invite").click();
  await expect.poll(() => ctx.router.state.location.pathname).toBe("/invites");
  expect(writes(ctx)[0]?.body).toMatchObject({ user: "2", reusable: false });
  expect(ctx.session.deviceSetup.getSnapshot()).toMatchObject({
    lastCreatedInvite: "created-key",
    revealCreatedInvite: true,
  });
});

test("an external invite action and same-tick Escape cannot discard the open invite editor", async () => {
  const ctx = await setup();
  await memberAction("create-invite-for", "bob");
  const gate = Promise.withResolvers<void>();
  let pending: Promise<unknown> | undefined;
  try {
    await act(async () => {
      pending = ctx.session.feedback.runAction(
        "create-invite",
        () => gate.promise,
      );
      page
        .getByTestId("invite-user")
        .element()
        .dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        );
    });
    await expect
      .element(page.getByTestId("invite-create-dialog"))
      .toBeVisible();
    expect(ctx.session.feedback.isActionPending("create-invite")).toBe(true);
  } finally {
    gate.resolve();
    await pending;
  }
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByTestId("invite-create-dialog"))
    .not.toBeInTheDocument();
  expect(writes(ctx)).toEqual([]);
});

test("at 790px every row keeps a visible actions menu without horizontal scrolling", async () => {
  await setup();
  await page.viewport(790, 800);
  for (const name of ["alice", "bob"])
    await expect
      .element(page.getByTestId(`member-actions-trigger-mobile-${name}`))
      .toBeVisible();
  const container = document.querySelector<HTMLElement>(
    '[data-testid="user-table"] [data-slot="table-container"]',
  );
  if (!container) throw new Error("Missing table container");
  expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth);
});

test("F13 direct ACL, SSH, grants and autoApprovers references are not called absent", async () => {
  const policy = {
    acls: [{ action: "accept", src: ["bob@"], dst: ["*:22"] }],
    ssh: [
      {
        action: "accept",
        src: ["bob@"],
        dst: ["autogroup:self"],
        users: ["root"],
      },
    ],
    grants: [{ src: ["bob@"], dst: ["*"], ip: ["tcp:443"] }],
    autoApprovers: { exitNode: ["bob@"] },
  };
  const ctx = await setup("?user=2&popup=user", JSON.stringify(policy));
  const details = page.getByTestId("user-detail-dialog");
  await expect.element(details).toBeVisible();
  await expect.element(details).not.toMatchTextContent("No policy references.");
  await expect
    .element(details)
    .toMatchTextContent("Team memberships and tag management");
  await expect
    .element(details)
    .toMatchTextContent("No team memberships or tag management permissions.");
  expect(JSON.parse(String(ctx.backend.policy?.policy))).toEqual(policy);
  expect(writes(ctx)).toEqual([]);
});

test.each([1366, 375])(
  "OIDC rename preserves provider identity and stable policy references at %ipx",
  async (width) => {
    const providerId = "https://oidc.example/subject";
    const policy = { groups: { "group:ops": [`${providerId}@`] }, acls: [] };
    const ctx = await setup("", JSON.stringify(policy));
    ctx.backend.users.push({
      id: "7",
      name: "oidc-user",
      provider: "oidc",
      providerId,
      email: "oidc@example.com",
    });
    await ctx.session.snapshot.refreshSnapshot();
    await page.viewport(width, 800);
    const suffix = width < 1024 ? "mobile-" : "";
    await page.getByTestId(`member-actions-trigger-${suffix}oidc-user`).click();
    const rename = page.getByTestId(`rename-member-${suffix}oidc-user`);
    await expect.element(rename).not.toHaveAttribute("aria-disabled", "true");
    await rename.click();
    await page.getByTestId("rename-member-name").fill("oidc-renamed");
    await page.getByTestId("confirm-rename-member").click();
    await expect.element(page.getByTestId("member-oidc-renamed")).toBeVisible();
    expect(summary(ctx)).toEqual(["POST /api/v1/user/7/rename/oidc-renamed"]);
    expect(ctx.backend.users.find((user) => user.id === "7")).toMatchObject({
      name: "oidc-renamed",
      provider: "oidc",
      providerId,
      email: "oidc@example.com",
    });
    expect(JSON.parse(String(ctx.backend.policy?.policy))).toEqual(policy);
  },
);

test.each([1366, 375])(
  "F15 a local user with providerId can still rename at %ipx",
  async (width) => {
    const ctx = await setup();
    ctx.backend.users.push({
      id: "7",
      name: "local-user",
      provider: "cli",
      providerId: "urn:local",
    });
    await ctx.session.snapshot.refreshSnapshot();
    await page.viewport(width, 800);
    const suffix = width < 1024 ? "mobile-" : "";
    await page
      .getByTestId(`member-actions-trigger-${suffix}local-user`)
      .click();
    await page.getByTestId(`rename-member-${suffix}local-user`).click();
    await page.getByTestId("rename-member-name").fill("local-renamed");
    await page.getByTestId("confirm-rename-member").click();
    await expect
      .element(page.getByTestId("member-local-renamed"))
      .toBeVisible();
    expect(summary(ctx)).toEqual(["POST /api/v1/user/7/rename/local-renamed"]);
  },
);

test.each(["a", "1ops", "ops!", "a@@b", "ops@"])(
  "create and rename preserve the measured REST username contract for %s",
  async (name) => {
    const ctx = await setup();
    await page.getByTestId("open-create-member").click();
    await page.getByTestId("member-name").fill(name);
    await page.getByTestId("create-member").click();
    await expect.element(page.getByTestId(`member-${name}`)).toBeVisible();
    expect(writes(ctx)[0]?.body.name).toBe(name);
    const created = ctx.backend.users.find((user) => user.name === name);
    expect.assert(created);
    await memberAction("rename", name);
    await page
      .getByTestId("rename-member-name")
      .fill("contract-temporary-name");
    await page.getByTestId("confirm-rename-member").click();
    await expect
      .element(page.getByTestId("member-contract-temporary-name"))
      .toBeVisible();
    await memberAction("rename", "contract-temporary-name");
    await page.getByTestId("rename-member-name").fill(name);
    await expect
      .element(page.getByTestId("confirm-rename-member"))
      .toBeEnabled();
    await page.getByTestId("confirm-rename-member").click();
    await expect.element(page.getByTestId(`member-${name}`)).toBeVisible();
    expect(summary(ctx)).toEqual([
      "POST /api/v1/user",
      `POST /api/v1/user/${created.id}/rename/contract-temporary-name`,
      `POST /api/v1/user/${created.id}/rename/${encodeURIComponent(name)}`,
    ]);
  },
);

test("F23 a server user-not-empty rejection only asks to handle owned machines", async () => {
  const ctx = await setup();
  ctx.backend.preAuthKeys.push({
    ...ctx.backend.preAuthKeys[0],
    id: "2",
    user: bob,
  });
  ctx.failingWrites.set("/api/v1/user/2", "user not empty: node(s) found");
  await ctx.session.snapshot.refreshSnapshot();
  await memberAction("delete", "bob");
  await expect.element(page.getByTestId("confirm-delete-member")).toBeEnabled();
  await page.getByTestId("confirm-delete-member").click();
  await expect
    .element(page.getByTestId("delete-member-error"))
    .toHaveTextContent(
      "User still owns machines. Remove or reassign them before deleting the user.",
    );
  expect(summary(ctx)).toEqual(["DELETE /api/v1/user/2"]);
  expect(ctx.backend.users.some((user) => user.id === "2")).toBe(true);
  expect(ctx.backend.preAuthKeys.some((key) => key.id === "2")).toBe(true);
  expect(ctx.backend.policy?.policy).toBe(POLICY);
  await expect.element(page.getByTestId("delete-member-dialog")).toBeVisible();
  await expect.element(page.getByTestId("member-bob")).toBeVisible();
});

test.each(["rename", "delete", "reference"] as const)(
  "D11 %s follow-up requires full raw review without undoing the completed user action",
  async (kind) => {
    const ctx = await setup(
      "",
      kind === "reference" ? POLICY : RENAME_TARGET_POLICY,
    );
    async function requestPolicy() {
      if (kind === "reference") {
        const button = document.querySelector<HTMLButtonElement>(
          '[data-testid^="remove-user-policy-reference-tagOwner-"]',
        );
        expect.assert(button);
        button.click();
        await page.getByTestId("confirm-remove-user-policy-reference").click();
      } else await page.getByTestId(`confirm-${kind}-member`).click();
    }
    if (kind === "reference")
      await page.getByTestId("member-detail-link-alice").click();
    else {
      await memberAction(kind, "bob");
      if (kind === "rename")
        await page.getByTestId("rename-member-name").fill("robert");
    }
    await requestPolicy();
    await expect
      .poll(
        () =>
          Boolean(
            document.querySelector('[data-testid="policy-publication-review"]'),
          ) || ctx.calls.some((call) => call.method === "PUT"),
      )
      .toBe(true);
    expect(ctx.calls.filter((call) => call.method === "PUT")).toEqual([]);
    await expect
      .element(page.getByTestId("policy-publication-review"))
      .toBeVisible();
    const submitted =
      page.getByTestId("policy-publication-submitted").element().textContent ??
      "";
    expect(
      page.getByTestId("policy-publication-original").element().textContent,
    ).toBe(kind === "reference" ? POLICY : RENAME_TARGET_POLICY);
    await page.getByTestId("policy-publication-cancel").click();
    if (kind === "rename")
      expect(ctx.backend.users.find((user) => user.id === "2")?.name).toBe(
        "robert",
      );
    if (kind === "delete")
      expect(ctx.backend.users.some((user) => user.id === "2")).toBe(false);
    expect(ctx.backend.policy?.policy).toBe(
      kind === "reference" ? POLICY : RENAME_TARGET_POLICY,
    );
    const userWrites = writes(ctx).filter(
      (call) => call.path !== "/api/v1/policy",
    );
    await requestPolicy();
    await page.getByTestId("policy-publication-confirm").click();
    await expect.poll(() => ctx.backend.policy?.policy).toBe(submitted);
    expect(
      writes(ctx).filter((call) => call.path !== "/api/v1/policy"),
    ).toEqual(userWrites);
    expect(ctx.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  },
);

test.each(["groups", "tags"] as const)(
  "D11 %s assignment requires full raw review before any policy write",
  async (kind) => {
    const original = `// retained for raw review\n${POLICY}`;
    const ctx = await setup("", original);
    const item =
      kind === "groups"
        ? ctx.session.policy.policyDesignerState.groups[0]
        : ctx.session.policy.policyDesignerState.tagOwners[0];
    await page.getByTestId("member-actions-trigger-bob").click();
    await page.getByTestId(`assign-member-${kind}-bob`).click();
    await page.getByTestId(`assign-user-${kind}-option-${item.id}`).click();
    await page.getByTestId(`assign-user-${kind}-apply`).click();
    await expect
      .poll(
        () =>
          Boolean(
            document.querySelector('[data-testid="policy-publication-review"]'),
          ) ||
          !document.querySelector(`[data-testid="assign-user-${kind}-dialog"]`),
      )
      .toBe(true);
    expect(writes(ctx)).toEqual([]);
    await expect
      .element(page.getByTestId("policy-publication-review"))
      .toBeVisible();
    expect(
      page.getByTestId("policy-publication-original").element().textContent,
    ).toBe(original);
    const submitted =
      page.getByTestId("policy-publication-submitted").element().textContent ??
      "";
    const expected = JSON.parse(POLICY);
    expected[kind === "groups" ? "groups" : "tagOwners"][
      kind === "groups" ? "group:ops" : "tag:server"
    ].push("bob@");
    expect(JSON.parse(submitted)).toEqual(expected);
    await page.getByTestId("policy-publication-cancel").click();
    await expect
      .element(page.getByTestId(`assign-user-${kind}-option-${item.id}`))
      .toHaveAttribute("aria-checked", "true");
    expect(writes(ctx)).toEqual([]);
    await page.getByTestId(`assign-user-${kind}-apply`).click();
    await page.getByTestId("policy-publication-confirm").click();
    await expect
      .element(page.getByTestId(`assign-user-${kind}-dialog`))
      .not.toBeInTheDocument();
    expect(summary(ctx)).toEqual(["PUT /api/v1/policy"]);
    expect(writes(ctx)[0]?.body).toEqual({ policy: submitted });
  },
);

test.each(["rename", "delete"] as const)(
  "D11 a version change during %s does not automatically review or publish its policy follow-up",
  async (kind) => {
    const ctx = await setup("", RENAME_TARGET_POLICY);
    await memberAction(kind, "bob");
    if (kind === "rename")
      await page.getByTestId("rename-member-name").fill("robert");
    const path =
      kind === "rename" ? "/api/v1/user/2/rename/robert" : "/api/v1/user/2";
    const release = ctx.pauseWrite(path);
    await page.getByTestId(`confirm-${kind}-member`).click();
    try {
      await expect.poll(() => writes(ctx).length).toBe(1);
      ctx.backend.version = { version: "0.29.5" };
      await ctx.session.snapshot.refreshSegments(["fabric"]);
    } finally {
      release();
    }
    await expect
      .poll(() => ctx.session.feedback.isActionPending(`${kind}-member`))
      .toBe(false);
    await expect
      .element(page.getByTestId("policy-publication-review"))
      .not.toBeInTheDocument();
    expect(summary(ctx)).toEqual([
      `${kind === "rename" ? "POST" : "DELETE"} ${path}`,
    ]);
    expect(ctx.backend.policy?.policy).toBe(RENAME_TARGET_POLICY);
    if (kind === "rename")
      expect(ctx.backend.users.find((user) => user.id === "2")?.name).toBe(
        "robert",
      );
    else expect(ctx.backend.users.some((user) => user.id === "2")).toBe(false);
  },
);

test.each(["rename-target", "reuse-deleted-id"] as const)(
  "D11 %s cannot inherit the old targeted publication confirmation",
  async (change) => {
    const ctx = await setup("", RENAME_TARGET_POLICY);
    if (change === "rename-target") {
      const groupId = ctx.session.policy.policyDesignerState.groups[0].id;
      await page.getByTestId("member-actions-trigger-bob").click();
      await page.getByTestId("assign-member-groups-bob").click();
      await page.getByTestId(`assign-user-groups-option-${groupId}`).click();
      await page.getByTestId("assign-user-groups-apply").click();
    } else {
      await memberAction("delete", "bob");
      await page.getByTestId("confirm-delete-member").click();
    }
    await expect
      .element(page.getByTestId("policy-publication-review"))
      .toBeVisible();
    if (change === "rename-target") {
      const target = ctx.backend.users.find((user) => user.id === "2");
      expect.assert(target);
      target.name = "renamed-elsewhere";
    } else ctx.backend.users.push({ id: "2", name: "replacement-user" });
    await ctx.session.snapshot.refreshSegments(["identity"]);
    await page.getByTestId("policy-publication-confirm").click();
    await expect
      .element(page.getByTestId("policy-publication-review"))
      .not.toBeInTheDocument();
    expect(writes(ctx).filter((call) => call.method === "PUT")).toEqual([]);
    expect(ctx.backend.policy?.policy).toBe(RENAME_TARGET_POLICY);
  },
);

test.each(["groups", "tags", "rename"] as const)(
  "%s publication refuses a reviewed principal reassigned to another user without a name change",
  async (kind) => {
    const ctx = await setup(
      "",
      kind === "rename"
        ? RENAME_TARGET_POLICY
        : JSON.stringify({
            groups: { "group:ops": [] },
            tagOwners: { "tag:server": [] },
            acls: [],
          }),
    );
    if (kind === "rename") {
      await memberAction("rename", "bob");
      await page.getByTestId("rename-member-name").fill("robert");
      await page.getByTestId("confirm-rename-member").click();
    } else {
      const optionId =
        kind === "groups"
          ? ctx.session.policy.policyDesignerState.groups[0].id
          : ctx.session.policy.policyDesignerState.tagOwners[0].id;
      await page.getByTestId("member-actions-trigger-alice").click();
      await page.getByTestId(`assign-member-${kind}-alice`).click();
      await page.getByTestId(`assign-user-${kind}-option-${optionId}`).click();
      await page.getByTestId(`assign-user-${kind}-apply`).click();
    }
    await expect
      .element(page.getByTestId("policy-publication-review"))
      .toBeVisible();
    const original = ctx.backend.policy?.policy;
    const target = ctx.backend.users.find(
      (user) => user.id === (kind === "rename" ? "2" : "1"),
    );
    expect.assert(target);
    const originalName = target.name;
    // Provider identities take precedence over email/name aliases in Headscale's directory.
    ctx.backend.users.push({
      id: "7",
      name: "different-user",
      providerId: kind === "rename" ? "robert" : "alice@example.com",
    });
    await ctx.session.snapshot.refreshSegments(["identity"]);
    expect(target.name).toBe(originalName);
    await page.getByTestId("policy-publication-confirm").click();
    await expect
      .element(page.getByTestId("policy-publication-review"))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByTestId("policy-save-notice"))
      .toHaveTextContent(copy.policySaveContextChanged);
    expect(writes(ctx).filter((call) => call.method === "PUT")).toEqual([]);
    expect(ctx.backend.policy?.policy).toBe(original);
  },
);

test.each(["groups", "tags", "rename"] as const)(
  "%s publication refuses an alias reassigned to a different user after review",
  async (kind) => {
    const ctx = await setup(
      "",
      kind === "rename" ? RENAME_TARGET_POLICY : POLICY,
    );
    let principal = "bob@";
    if (kind === "rename") {
      await memberAction("rename", "bob");
      await page.getByTestId("rename-member-name").fill("robert");
      await page.getByTestId("confirm-rename-member").click();
      principal = "robert@";
    } else {
      const optionId =
        kind === "groups"
          ? ctx.session.policy.policyDesignerState.groups[0].id
          : ctx.session.policy.policyDesignerState.tagOwners[0].id;
      await page.getByTestId("member-actions-trigger-bob").click();
      await page.getByTestId(`assign-member-${kind}-bob`).click();
      await page.getByTestId(`assign-user-${kind}-option-${optionId}`).click();
      await page.getByTestId(`assign-user-${kind}-apply`).click();
    }
    await expect
      .element(page.getByTestId("policy-publication-review"))
      .toBeVisible();
    const previous = ctx.backend.policy?.policy;
    ctx.backend.users.push({
      id: "7",
      name: "external",
      providerId: principal.slice(0, -1),
    });
    await ctx.session.snapshot.refreshSegments(["identity"]);
    const target = ctx.backend.users.find((user) => user.id === "2");
    expect(target?.name).toBe(principal.slice(0, -1));
    await page.getByTestId("policy-publication-confirm").click();
    await expect
      .element(page.getByTestId("policy-publication-review"))
      .not.toBeInTheDocument();
    expect(writes(ctx).filter((call) => call.method === "PUT")).toEqual([]);
    expect(ctx.backend.policy?.policy).toBe(previous);
    await expect
      .element(page.getByTestId("policy-save-notice"))
      .toHaveTextContent(copy.policySaveContextChanged);
  },
);

test("D11 unavailable version metadata does not prohibit a newly reviewed policy with fresh resource reads", async () => {
  const ctx = await setup();
  ctx.failingReads.add("/version");
  await ctx.session.snapshot.refreshSnapshot();
  expect(ctx.session.tagLifecycle.captureScope()?.versionFresh).toBe(false);
  const groupId = ctx.session.policy.policyDesignerState.groups[0].id;
  await page.getByTestId("member-actions-trigger-bob").click();
  await page.getByTestId("assign-member-groups-bob").click();
  await page.getByTestId(`assign-user-groups-option-${groupId}`).click();
  await page.getByTestId("assign-user-groups-apply").click();
  await expect
    .element(page.getByTestId("policy-publication-review"))
    .toBeVisible();
  expect(writes(ctx)).toEqual([]);
  await page.getByTestId("policy-publication-confirm").click();
  await expect
    .element(page.getByTestId("assign-user-groups-dialog"))
    .not.toBeInTheDocument();
  expect(summary(ctx)).toEqual(["PUT /api/v1/policy"]);
  expect(ctx.session.tagLifecycle.captureScope()?.versionFresh).toBe(false);
});

test.each(["changed", "unavailable"] as const)(
  "D11 a %s version cancels old confirmation without losing the member selection",
  async (version) => {
    const ctx = await setup();
    const groupId = ctx.session.policy.policyDesignerState.groups[0].id;
    await page.getByTestId("member-actions-trigger-bob").click();
    await page.getByTestId("assign-member-groups-bob").click();
    await page.getByTestId(`assign-user-groups-option-${groupId}`).click();
    await page.getByTestId("assign-user-groups-apply").click();
    await expect
      .element(page.getByTestId("policy-publication-review"))
      .toBeVisible();
    if (version === "changed") ctx.backend.version = { version: "0.29.5" };
    else ctx.failingReads.add("/version");
    await ctx.session.snapshot.refreshSnapshot();
    await expect
      .element(page.getByTestId("policy-publication-review"))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByTestId(`assign-user-groups-option-${groupId}`))
      .toHaveAttribute("aria-checked", "true");
    expect(writes(ctx)).toEqual([]);
    ctx.backend.version = { version: "0.29.4" };
    ctx.failingReads.clear();
    await ctx.session.snapshot.refreshSnapshot();
    await expect
      .element(page.getByTestId("policy-publication-review"))
      .not.toBeInTheDocument();
    expect(writes(ctx)).toEqual([]);
    await page.getByTestId("assign-user-groups-apply").click();
    await page.getByTestId("policy-publication-confirm").click();
    await expect
      .element(page.getByTestId("assign-user-groups-dialog"))
      .not.toBeInTheDocument();
    expect(summary(ctx)).toEqual(["PUT /api/v1/policy"]);
  },
);

test("D11 a new Access draft invalidates the reviewed targeted assignment without publishing it", async () => {
  const ctx = await setup();
  const tagId = ctx.session.policy.policyDesignerState.tagOwners[0].id;
  await page.getByTestId("member-actions-trigger-bob").click();
  await page.getByTestId("assign-member-tags-bob").click();
  await page.getByTestId(`assign-user-tags-option-${tagId}`).click();
  await page.getByTestId("assign-user-tags-apply").click();
  await expect
    .element(page.getByTestId("policy-publication-review"))
    .toBeVisible();
  const next = structuredClone(ctx.session.policy.policyDesignerState);
  next.groups[0].name = "group:unsaved-access-edit";
  ctx.session.policy.commitState(next);
  await page.getByTestId("policy-publication-confirm").click();
  await expect
    .element(page.getByTestId("policy-publication-review"))
    .not.toBeInTheDocument();
  expect(writes(ctx)).toEqual([]);
  expect(ctx.session.policy.isPolicyDirty).toBe(true);
  expect(ctx.session.policy.policyDesignerState.groups[0].name).toBe(
    "group:unsaved-access-edit",
  );
});

test("D11 an intervening remote raw change is displayed and never overwritten", async () => {
  const ctx = await setup();
  const groupId = ctx.session.policy.policyDesignerState.groups[0].id;
  await page.getByTestId("member-actions-trigger-bob").click();
  await page.getByTestId("assign-member-groups-bob").click();
  await page.getByTestId(`assign-user-groups-option-${groupId}`).click();
  await page.getByTestId("assign-user-groups-apply").click();
  await expect
    .element(page.getByTestId("policy-publication-review"))
    .toBeVisible();
  const original = ctx.backend.policy?.policy;
  const remote = `// added by another operator\n${original}`;
  ctx.backend.policy = { policy: remote };
  await page.getByTestId("policy-publication-confirm").click();
  await expect
    .element(page.getByTestId("policy-publication-current"))
    .toBeVisible();
  expect(
    page.getByTestId("policy-publication-current").element().textContent,
  ).toBe(remote);
  expect(
    page.getByTestId("policy-publication-original").element().textContent,
  ).toBe(original);
  await expect
    .element(page.getByTestId("policy-publication-confirm"))
    .toBeDisabled();
  expect(writes(ctx)).toEqual([]);
  expect(ctx.backend.policy.policy).toBe(remote);
});

test("F01 assignment and deletion never borrow a provider-owned email alias", async () => {
  const policy = {
    groups: { "group:ops": ["shared@example.com@"] },
    tagOwners: { "tag:server": ["shared@example.com"] },
    acls: [{ action: "accept", src: ["shared@example.com@"], dst: ["*:22"] }],
  };
  const ctx = await setup("", JSON.stringify(policy));
  ctx.backend.users = [
    { id: "1", name: "alice", email: "shared@example.com" },
    {
      id: "2",
      name: "oidc-user",
      provider: "oidc",
      providerId: "shared@example.com",
    },
  ];
  ctx.backend.nodes = [];
  await ctx.session.snapshot.refreshSnapshot();
  const groupId = ctx.session.policy.policyDesignerState.groups[0].id;
  await page.getByTestId("member-actions-trigger-alice").click();
  await page.getByTestId("assign-member-groups-alice").click();
  await expect
    .element(page.getByTestId(`assign-user-groups-option-${groupId}`))
    .toHaveAttribute("aria-checked", "false");
  await page.getByTestId(`assign-user-groups-option-${groupId}`).click();
  await page.getByTestId("assign-user-groups-apply").click();
  await page.getByTestId("policy-publication-confirm").click();
  await expect
    .element(page.getByTestId("assign-user-groups-dialog"))
    .not.toBeInTheDocument();
  expect(
    JSON.parse(String(ctx.backend.policy?.policy)).groups["group:ops"],
  ).toEqual(["shared@example.com@", "alice@"]);
  const tagId = ctx.session.policy.policyDesignerState.tagOwners[0].id;
  await page.getByTestId("member-actions-trigger-alice").click();
  await page.getByTestId("assign-member-tags-alice").click();
  await expect
    .element(page.getByTestId(`assign-user-tags-option-${tagId}`))
    .toHaveAttribute("aria-checked", "false");
  await page.getByTestId(`assign-user-tags-option-${tagId}`).click();
  await page.getByTestId("assign-user-tags-apply").click();
  await page.getByTestId("policy-publication-confirm").click();
  await expect
    .element(page.getByTestId("assign-user-tags-dialog"))
    .not.toBeInTheDocument();
  expect(
    JSON.parse(String(ctx.backend.policy?.policy)).tagOwners["tag:server"],
  ).toEqual(["shared@example.com", "alice@"]);
  await memberAction("delete", "alice");
  await page.getByTestId("confirm-delete-member").click();
  await page.getByTestId("policy-publication-confirm").click();
  await expect
    .element(page.getByTestId("delete-member-dialog"))
    .not.toBeInTheDocument();
  expect(JSON.parse(String(ctx.backend.policy?.policy))).toEqual(policy);
  expect(summary(ctx)).toEqual([
    "PUT /api/v1/policy",
    "PUT /api/v1/policy",
    "DELETE /api/v1/user/1",
    "PUT /api/v1/policy",
  ]);
});

test("F01 ambiguous aliases cannot be assigned or removed as one user's references", async () => {
  const policy = {
    groups: { "group:ops": ["shared@example.com@"] },
    tagOwners: { "tag:server": ["shared@example.com"] },
    acls: [],
  };
  const ctx = await setup("", JSON.stringify(policy));
  ctx.backend.users = [
    { id: "1", name: "alice", email: "shared@example.com" },
    { id: "2", name: "shared@example.com" },
  ];
  await ctx.session.snapshot.refreshSnapshot();
  await page.getByTestId("member-detail-link-shared@example.com").click();
  await expect.element(page.getByTestId("user-detail-dialog")).toBeVisible();
  expect(
    document.querySelectorAll('[data-testid^="remove-user-policy-reference-"]')
      .length,
  ).toBe(0);
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("member-actions-trigger-shared@example.com").click();
  await expect
    .element(page.getByTestId("assign-member-groups-shared@example.com"))
    .toHaveAttribute("aria-disabled", "true");
  await expect
    .element(page.getByTestId("assign-member-tags-shared@example.com"))
    .toHaveAttribute("aria-disabled", "true");
  await page.getByTestId("delete-member-shared@example.com").click();
  await page.getByTestId("confirm-delete-member").click();
  await expect
    .element(page.getByTestId("delete-member-dialog"))
    .not.toBeInTheDocument();
  expect(summary(ctx)).toEqual(["DELETE /api/v1/user/2"]);
  expect(JSON.parse(String(ctx.backend.policy?.policy))).toEqual(policy);
});

test("F01 rename retargets both internal-@ spellings instead of stranding the suffixed one", async () => {
  const ctx = await setup(
    "",
    JSON.stringify({
      groups: { "group:ops": ["ops@corp", "ops@corp@"] },
      tagOwners: { "tag:server": ["ops@corp@"] },
      acls: [{ action: "accept", src: ["ops@corp@"], dst: ["*:22"] }],
    }),
  );
  ctx.backend.users.push({ id: "7", name: "ops@corp" });
  await ctx.session.snapshot.refreshSnapshot();
  await memberAction("rename", "ops@corp");
  await page.getByTestId("rename-member-name").fill("ops2@corp");
  await page.getByTestId("confirm-rename-member").click();
  await page.getByTestId("policy-publication-confirm").click();
  await expect
    .element(page.getByTestId("rename-member-dialog"))
    .not.toBeInTheDocument();
  const saved = JSON.parse(String(ctx.backend.policy?.policy));
  expect(saved.groups["group:ops"]).toEqual(["ops2@corp"]);
  expect(saved.tagOwners["tag:server"]).toEqual(["ops2@corp"]);
  expect(saved.acls[0].src).toEqual(["ops2@corp"]);
});

test("F01 renaming a name shadowed by another provider leaves that provider's references alone", async () => {
  const policy = { groups: { "group:ops": ["bob@"] }, acls: [] };
  const ctx = await setup("", JSON.stringify(policy));
  ctx.backend.users.push({
    id: "7",
    name: "oidc-bob",
    provider: "oidc",
    providerId: "bob",
  });
  await ctx.session.snapshot.refreshSnapshot();
  await memberAction("rename", "bob");
  await page.getByTestId("rename-member-name").fill("robert");
  await page.getByTestId("confirm-rename-member").click();
  await expect
    .element(page.getByTestId("rename-member-dialog"))
    .not.toBeInTheDocument();
  expect(summary(ctx)).toEqual(["POST /api/v1/user/2/rename/robert"]);
  expect(JSON.parse(String(ctx.backend.policy?.policy))).toEqual(policy);
});

test.each(["email", "providerId"] as const)(
  "F01 renaming preserves an unchanged %s that also matched the old name",
  async (field) => {
    const policy = {
      groups: { "group:ops": ["bob@example.com", "bob@example.com@"] },
      acls: [],
    };
    const ctx = await setup("", JSON.stringify(policy));
    ctx.backend.users.push({
      id: "7",
      name: "bob@example.com",
      [field]: "bob@example.com",
    });
    await ctx.session.snapshot.refreshSnapshot();
    await memberAction("rename", "bob@example.com");
    await page.getByTestId("rename-member-name").fill("bob-new");
    await page.getByTestId("confirm-rename-member").click();
    await expect
      .element(page.getByTestId("rename-member-dialog"))
      .not.toBeInTheDocument();
    expect(summary(ctx)).toEqual(["POST /api/v1/user/7/rename/bob-new"]);
    expect(JSON.parse(String(ctx.backend.policy?.policy))).toEqual(policy);
  },
);

test.each([
  { field: "name", identity: "alice@", other: "alice@", encoded: "alice@@" },
  {
    field: "email",
    identity: "alice@example.com@",
    other: "alice@example.com",
    encoded: "alice@example.com@@",
  },
  {
    field: "providerId",
    identity: "urn:alice@",
    other: "urn:alice@",
    encoded: "urn:alice@@",
  },
] as const)(
  "F01 trailing-@ $field removal and deletion preserve the other identity",
  async ({ field, identity, other, encoded }) => {
    const policy = {
      groups: { "group:ops": [other, encoded] },
      tagOwners: { "tag:server": [other, encoded] },
      acls: [{ action: "accept", src: [other, encoded], dst: ["*:22"] }],
    };
    const ctx = await setup("", JSON.stringify(policy));
    const target = { id: "7", name: "target", [field]: identity };
    ctx.backend.users = [
      { id: "1", name: "plain", [field]: identity.slice(0, -1) },
      target,
    ];
    ctx.backend.nodes = [];
    await ctx.session.snapshot.refreshSnapshot();
    const groupId = ctx.session.policy.policyDesignerState.groups[0].id;
    await page.getByTestId(`member-actions-trigger-${target.name}`).click();
    await page.getByTestId(`assign-member-groups-${target.name}`).click();
    await expect
      .element(page.getByTestId(`assign-user-groups-option-${groupId}`))
      .toHaveAttribute("aria-checked", "true");
    await page.getByTestId(`assign-user-groups-option-${groupId}`).click();
    await page.getByTestId("assign-user-groups-apply").click();
    await page.getByTestId("policy-publication-confirm").click();
    await expect
      .element(page.getByTestId("assign-user-groups-dialog"))
      .not.toBeInTheDocument();
    expect(
      JSON.parse(String(ctx.backend.policy?.policy)).groups["group:ops"],
    ).toEqual([other]);
    await memberAction("delete", target.name);
    await page.getByTestId("confirm-delete-member").click();
    await page.getByTestId("policy-publication-confirm").click();
    await expect
      .element(page.getByTestId("delete-member-dialog"))
      .not.toBeInTheDocument();
    const saved = JSON.parse(String(ctx.backend.policy?.policy));
    expect(saved.groups["group:ops"]).toEqual([other]);
    expect(saved.tagOwners["tag:server"]).toEqual([other]);
    expect(saved.acls[0].src).toEqual([other]);
    expect(summary(ctx)).toEqual([
      "PUT /api/v1/policy",
      "DELETE /api/v1/user/7",
      "PUT /api/v1/policy",
    ]);
  },
);

test("F01 renaming alice to alice@ retargets the distinct name instead of treating it as a no-op", async () => {
  const ctx = await setup(
    "",
    JSON.stringify({
      groups: { "group:ops": ["alice@", "alice@example.com"] },
      acls: [{ action: "accept", src: ["alice@"], dst: ["*:22"] }],
    }),
  );
  await memberAction("rename", "alice");
  await expect
    .element(page.getByTestId("confirm-rename-member"))
    .toBeDisabled();
  await page.getByTestId("rename-member-name").fill("alice@");
  await page.getByTestId("confirm-rename-member").click();
  await page.getByTestId("policy-publication-confirm").click();
  await expect
    .element(page.getByTestId("rename-member-dialog"))
    .not.toBeInTheDocument();
  expect(summary(ctx)).toEqual([
    "POST /api/v1/user/1/rename/alice%40",
    "PUT /api/v1/policy",
  ]);
  const saved = JSON.parse(String(ctx.backend.policy?.policy));
  expect(saved.groups["group:ops"]).toEqual(["alice@@", "alice@example.com"]);
  expect(saved.acls[0].src).toEqual(["alice@@"]);
});

test("a rename response that retains the original name never retargets policy to the requested name", async () => {
  const policy = JSON.stringify({
    groups: { "group:ops": ["bob@"] },
    acls: [],
  });
  const ctx = await setup("", policy);
  ctx.renameResults.set("2", "bob");
  await memberAction("rename", "bob");
  await page.getByTestId("rename-member-name").fill("robert");
  await page.getByTestId("confirm-rename-member").click();
  await expect
    .element(page.getByTestId("rename-member-dialog"))
    .not.toBeInTheDocument();
  expect(summary(ctx)).toEqual(["POST /api/v1/user/2/rename/robert"]);
  expect(ctx.backend.policy?.policy).toBe(policy);
  await expect.element(page.getByTestId("member-bob")).toBeVisible();
});

const RENAME_TARGET_POLICY = JSON.stringify({
  groups: { "group:ops": ["bob@"] },
  tagOwners: { "tag:server": ["bob@"] },
  acls: [{ action: "accept", src: ["bob@"], dst: ["bob@:22"] }],
});

test("a confirmed deletion retries only identity reads after its directory refresh fails", async () => {
  const ctx = await setup("", RENAME_TARGET_POLICY);
  await memberAction("delete", "bob");
  ctx.failingReads.add("/api/v1/user");
  await page.getByTestId("confirm-delete-member").click();
  await expect
    .poll(() => ctx.session.feedback.actionOutcome("delete-member"))
    .toMatchObject({ status: "confirmed", refresh: "failed" });
  await expect.element(page.getByTestId("confirm-delete-member")).toBeEnabled();
  expect(ctx.backend.users.some((user) => user.id === "2")).toBe(false);
  expect(ctx.session.snapshot.userById("2")?.name).toBe("bob");
  expect(summary(ctx)).toEqual(["DELETE /api/v1/user/2"]);

  const reads = ctx.calls.filter(
    (call) => call.method === "GET" && call.path === "/api/v1/user",
  ).length;
  submitTwice("confirm-delete-member");
  await expect
    .poll(
      () =>
        ctx.calls.filter(
          (call) => call.method === "GET" && call.path === "/api/v1/user",
        ).length,
    )
    .toBeGreaterThan(reads);
  await expect.element(page.getByTestId("confirm-delete-member")).toBeEnabled();
  expect(summary(ctx)).toEqual(["DELETE /api/v1/user/2"]);
  await expect
    .element(page.getByTestId("delete-member-cleanup-pending"))
    .toHaveTextContent(copy.deleteMemberCleanupPending);
  await expect
    .element(page.getByTestId("delete-member-cleanup-policy"))
    .toBeDisabled();
  await expect
    .element(page.getByTestId("policy-publication-review"))
    .not.toBeInTheDocument();
  await expect.element(page.getByTestId("delete-member-dialog")).toBeVisible();

  ctx.failingReads.clear();
  const retryStart = ctx.calls.length;
  await page.getByTestId("confirm-delete-member").click();
  await expect
    .element(page.getByTestId("policy-publication-review"))
    .toBeVisible();
  expect(
    ctx.calls.slice(retryStart).map((call) => `${call.method} ${call.path}`),
  ).toEqual([
    "GET /api/v1/user",
    "GET /api/v1/preauthkey",
    "GET /api/v1/apikey",
  ]);
  expect(summary(ctx)).toEqual(["DELETE /api/v1/user/2"]);
  await page.getByTestId("policy-publication-confirm").click();
  await expect
    .element(page.getByTestId("delete-member-dialog"))
    .not.toBeInTheDocument();
  expect(summary(ctx)).toEqual(["DELETE /api/v1/user/2", "PUT /api/v1/policy"]);
  expect(JSON.parse(String(ctx.backend.policy?.policy))).toEqual({
    groups: { "group:ops": [] },
    tagOwners: { "tag:server": [] },
    acls: [],
  });
});

test("a confirmed deletion cannot publish cleanup when its refreshed policy adds unsupported references", async () => {
  const ctx = await setup("", RENAME_TARGET_POLICY);
  await memberAction("delete", "bob");
  const release = ctx.pauseWrite("/api/v1/user/2");
  const changed = JSON.stringify({
    ...JSON.parse(RENAME_TARGET_POLICY),
    future: { audience: "bob@" },
  });
  try {
    await page.getByTestId("confirm-delete-member").click();
    await expect.poll(() => summary(ctx)).toEqual(["DELETE /api/v1/user/2"]);
    ctx.backend.policy = { policy: changed };
  } finally {
    release();
  }
  await expect
    .element(page.getByTestId("confirm-delete-member"))
    .toHaveAttribute("aria-busy", "false");
  expect(ctx.session.snapshot.userById("2")).toBeUndefined();
  expect(ctx.session.policy.getSnapshot().policyDraft).toBe(changed);
  expect(ctx.session.policy.isPolicyDirty).toBe(false);
  await expect
    .element(page.getByTestId("policy-publication-review"))
    .not.toBeInTheDocument();
  await expect.element(page.getByTestId("delete-member-dialog")).toBeVisible();
  expect(summary(ctx)).toEqual(["DELETE /api/v1/user/2"]);
  expect(ctx.backend.policy?.policy).toBe(changed);
});

const deletedUserTakeovers = [
  { via: "name", target: bob, replacement: { id: "99", name: "bob" } },
  {
    via: "providerId",
    target: bob,
    replacement: { id: "99", name: "external", providerId: "bob" },
  },
  {
    via: "former providerId",
    target: { ...bob, providerId: "bob" },
    replacement: { id: "99", name: "bob" },
  },
  {
    via: "reused id",
    target: bob,
    replacement: { id: "2", name: "replacement-user" },
  },
];

test.each(deletedUserTakeovers)(
  "delete recovery preserves the full policy when $via is taken over during its identity read",
  async ({ target, replacement }) => {
    const ctx = await setup("", RENAME_TARGET_POLICY);
    ctx.backend.users = ctx.backend.users.map((user) =>
      user.id === target.id ? { ...target } : user,
    );
    await ctx.session.snapshot.refreshSegments(["identity"]);
    await memberAction("delete", "bob");
    ctx.failingReads.add("/api/v1/user");
    await page.getByTestId("confirm-delete-member").click();
    await expect
      .poll(() => ctx.session.feedback.actionOutcome("delete-member"))
      .toMatchObject({ status: "confirmed", refresh: "failed" });
    await expect
      .element(page.getByTestId("confirm-delete-member"))
      .toBeEnabled();
    expect(ctx.backend.users.some((user) => user.id === "2")).toBe(false);
    expect(ctx.session.snapshot.userById("2")?.name).toBe("bob");

    ctx.failingReads.clear();
    const readStart = ctx.calls.length;
    const release = ctx.pauseRead("/api/v1/user");
    try {
      await page.getByTestId("confirm-delete-member").click();
      await expect
        .poll(() =>
          ctx.calls
            .slice(readStart)
            .some((call) => call.path === "/api/v1/user"),
        )
        .toBe(true);
      expect(summary(ctx)).toEqual(["DELETE /api/v1/user/2"]);
      ctx.backend.users.push({ ...replacement });
    } finally {
      release();
    }
    await expect
      .element(page.getByTestId("confirm-delete-member"))
      .toHaveAttribute("aria-busy", "false");
    expect(ctx.session.snapshot.userById(replacement.id)).toMatchObject(
      replacement,
    );
    // Exercise any offered publication too: the old id being absent is not proof of orphaned aliases.
    if (document.querySelector('[data-testid="policy-publication-review"]')) {
      await page.getByTestId("policy-publication-confirm").click();
      await expect.poll(() => ctx.session.policy.isPolicySaving).toBe(false);
    }
    expect(ctx.backend.policy?.policy).toBe(RENAME_TARGET_POLICY);
    expect(summary(ctx)).toEqual(["DELETE /api/v1/user/2"]);
    await expect
      .element(page.getByTestId("policy-publication-review"))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByTestId("policy-save-notice"))
      .toHaveTextContent(copy.policySaveContextChanged);
  },
);

test.each(deletedUserTakeovers)(
  "delete publication refuses a $via takeover applied locally immediately before confirmation",
  async ({ target, replacement }) => {
    const ctx = await setup("", RENAME_TARGET_POLICY);
    ctx.backend.users = ctx.backend.users.map((user) =>
      user.id === target.id ? { ...target } : user,
    );
    await ctx.session.snapshot.refreshSegments(["identity"]);
    await memberAction("delete", "bob");
    await page.getByTestId("confirm-delete-member").click();
    await expect
      .element(page.getByTestId("policy-publication-review"))
      .toBeVisible();
    expect(ctx.session.snapshot.userById("2")).toBeUndefined();
    const confirm = page.getByTestId("policy-publication-confirm").element();
    expect.assert(confirm instanceof HTMLButtonElement);
    ctx.backend.users.push({ ...replacement });
    ctx.session.snapshot.applyPatch({
      users: structuredClone(ctx.backend.users),
    });
    confirm.click();
    await expect.poll(() => ctx.session.policy.isPolicySaving).toBe(false);
    expect(ctx.backend.policy?.policy).toBe(RENAME_TARGET_POLICY);
    expect(summary(ctx)).toEqual(["DELETE /api/v1/user/2"]);
    await expect
      .element(page.getByTestId("policy-publication-review"))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByTestId("policy-save-notice"))
      .toHaveTextContent(copy.policySaveContextChanged);
  },
);

test("delete recovery cleans only unclaimed aliases after another id takes the deleted name", async () => {
  const references = ["bob@", "bob@example.com", "bob@example.com@"];
  const policy = {
    hosts: { retained: "100.64.0.9" },
    groups: { "group:ops": references },
    tagOwners: { "tag:server": references },
    acls: [
      { action: "accept", src: references, dst: ["tag:server:22"] },
      {
        action: "accept",
        src: ["alice@example.com"],
        dst: ["bob@example.com:443"],
      },
      { action: "accept", src: ["alice@example.com"], dst: ["bob@:443"] },
    ],
  };
  const ctx = await setup("", JSON.stringify(policy));
  ctx.backend.users = ctx.backend.users.map((user) =>
    user.id === "2" ? { ...user, email: "bob@example.com" } : user,
  );
  await ctx.session.snapshot.refreshSegments(["identity"]);
  await memberAction("delete", "bob");
  ctx.failingReads.add("/api/v1/user");
  await page.getByTestId("confirm-delete-member").click();
  await expect
    .poll(() => ctx.session.feedback.actionOutcome("delete-member"))
    .toMatchObject({ status: "confirmed", refresh: "failed" });
  await expect.element(page.getByTestId("confirm-delete-member")).toBeEnabled();
  ctx.backend.users.push({ id: "99", name: "bob" });
  ctx.failingReads.clear();
  await page.getByTestId("confirm-delete-member").click();
  await expect
    .element(page.getByTestId("policy-publication-review"))
    .toBeVisible();
  const expected = {
    hosts: { retained: "100.64.0.9" },
    groups: { "group:ops": ["bob@"] },
    tagOwners: { "tag:server": ["bob@"] },
    acls: [
      { action: "accept", src: ["bob@"], dst: ["tag:server:22"] },
      { action: "accept", src: ["alice@example.com"], dst: ["bob@:443"] },
    ],
  };
  const submitted =
    page.getByTestId("policy-publication-submitted").element().textContent ??
    "";
  expect(JSON.parse(submitted)).toEqual(expected);
  expect(summary(ctx)).toEqual(["DELETE /api/v1/user/2"]);
  await page.getByTestId("policy-publication-confirm").click();
  await expect
    .element(page.getByTestId("delete-member-dialog"))
    .not.toBeInTheDocument();
  expect(summary(ctx)).toEqual(["DELETE /api/v1/user/2", "PUT /api/v1/policy"]);
  expect(writes(ctx)[1]?.body).toEqual({ policy: submitted });
  expect(JSON.parse(String(ctx.backend.policy?.policy))).toEqual(expected);
});

test.each(["session", "version"] as const)(
  "delete recovery cannot open a review after its %s changes while the identity read is pending",
  async (change) => {
    const ctx = await setup("", RENAME_TARGET_POLICY);
    await memberAction("delete", "bob");
    ctx.failingReads.add("/api/v1/user");
    await page.getByTestId("confirm-delete-member").click();
    await expect
      .poll(() => ctx.session.feedback.actionOutcome("delete-member"))
      .toMatchObject({ status: "confirmed", refresh: "failed" });
    await expect
      .element(page.getByTestId("confirm-delete-member"))
      .toBeEnabled();
    ctx.failingReads.clear();
    const readStart = ctx.calls.length;
    const release = ctx.pauseRead("/api/v1/user");
    try {
      await page.getByTestId("confirm-delete-member").click();
      await expect
        .poll(() =>
          ctx.calls
            .slice(readStart)
            .some((call) => call.path === "/api/v1/user"),
        )
        .toBe(true);
      if (change === "session") ctx.session.snapshot.rebindSession();
      else {
        ctx.backend.version = { version: "0.29.5" };
        await ctx.session.snapshot.refreshSegments(["fabric"]);
      }
    } finally {
      release();
    }
    await expect
      .element(page.getByTestId("confirm-delete-member"))
      .toHaveAttribute("aria-busy", "false");
    await expect
      .element(page.getByTestId("policy-publication-review"))
      .not.toBeInTheDocument();
    expect(summary(ctx)).toEqual(["DELETE /api/v1/user/2"]);
    expect(ctx.backend.policy?.policy).toBe(RENAME_TARGET_POLICY);
    expect(ctx.backend.users.some((user) => user.id === "2")).toBe(false);
  },
);

test.each(["rename", "delete"] as const)(
  "%s submits once across both stages and retries only a known pre-rejected policy after configuration repair",
  async (action) => {
    const ctx = await setup("", RENAME_TARGET_POLICY);
    ctx.failingWrites.set(
      "/api/v1/policy",
      "update is disabled for modes other than 'database'",
    );
    await memberAction(action, "bob");
    if (action === "rename")
      await page.getByTestId("rename-member-name").fill(" robert ");
    const userPath =
      action === "rename" ? "/api/v1/user/2/rename/robert" : "/api/v1/user/2";
    const userWrite = `${action === "rename" ? "POST" : "DELETE"} ${userPath}`;
    const release = ctx.pauseWrite(userPath);
    try {
      submitTwice(`confirm-${action}-member`);
      await expect.poll(() => summary(ctx)).toEqual([userWrite]);
      await expect
        .element(page.getByTestId(`confirm-${action}-member`))
        .toHaveAttribute("aria-busy", "true");
      await userEvent.keyboard("{Escape}");
      await expect
        .element(page.getByTestId(`${action}-member-dialog`))
        .toBeVisible();
    } finally {
      release();
    }
    await page.getByTestId("policy-publication-confirm").click();
    await expect
      .element(page.getByTestId(`${action}-member-policy-error`))
      .toMatchTextContent(copy.policyUpdateDisabled);
    const checkbox =
      action === "rename"
        ? "rename-member-update-policy"
        : "delete-member-cleanup-policy";
    await expect.element(page.getByTestId(checkbox)).toBeDisabled();
    await expect
      .element(page.getByTestId(`confirm-${action}-member`))
      .toBeEnabled();
    expect(summary(ctx)).toEqual([userWrite, "PUT /api/v1/policy"]);
    expect(ctx.backend.policy?.policy).toBe(RENAME_TARGET_POLICY);
    ctx.failingWrites.clear();
    submitTwice(`confirm-${action}-member`);
    await page.getByTestId("policy-publication-confirm").click();
    await expect
      .element(page.getByTestId(`${action}-member-dialog`))
      .not.toBeInTheDocument();
    expect(summary(ctx)).toEqual([
      userWrite,
      "PUT /api/v1/policy",
      "PUT /api/v1/policy",
    ]);
    expect(
      JSON.parse(String(ctx.backend.policy?.policy)).groups["group:ops"],
    ).toEqual(action === "rename" ? ["robert@"] : []);
  },
);

test.each(["groups", "tags"] as const)(
  "%s assignment retains choices after known pre-rejection and requires another review after repair",
  async (kind) => {
    const ctx = await setup();
    const optionId =
      kind === "groups"
        ? ctx.session.policy.policyDesignerState.groups[0].id
        : ctx.session.policy.policyDesignerState.tagOwners[0].id;
    await page.getByTestId("member-actions-trigger-bob").click();
    await page.getByTestId(`assign-member-${kind}-bob`).click();
    const prefix = `assign-user-${kind}`;
    const option = page.getByTestId(`${prefix}-option-${optionId}`);
    await option.click();
    ctx.failingWrites.set(
      "/api/v1/policy",
      "update is disabled for modes other than 'database'",
    );
    const release = ctx.pauseWrite("/api/v1/policy");
    try {
      submitTwice(`${prefix}-apply`);
      await expect
        .element(page.getByTestId("policy-publication-review"))
        .toBeVisible();
      expect(writes(ctx)).toEqual([]);
      const confirm = page
        .getByTestId("policy-publication-confirm")
        .element() as HTMLButtonElement;
      confirm.click();
      confirm.click();
      await expect.poll(() => summary(ctx)).toEqual(["PUT /api/v1/policy"]);
      await expect.element(option).toBeDisabled();
      await expect
        .element(page.getByTestId(`${prefix}-apply`))
        .toHaveAttribute("aria-busy", "true");
    } finally {
      release();
    }
    await expect
      .element(page.getByTestId(`${prefix}-error`))
      .toMatchTextContent(copy.policyUpdateDisabled);
    await expect.element(option).toHaveAttribute("aria-checked", "true");
    await expect.element(page.getByTestId(`${prefix}-apply`)).toBeEnabled();
    ctx.failingWrites.clear();
    await page.getByTestId(`${prefix}-apply`).click();
    await page.getByTestId("policy-publication-confirm").click();
    await expect
      .element(page.getByTestId(`${prefix}-dialog`))
      .not.toBeInTheDocument();
    expect(summary(ctx)).toEqual(["PUT /api/v1/policy", "PUT /api/v1/policy"]);
    const saved = JSON.parse(String(ctx.backend.policy?.policy));
    expect(
      kind === "groups"
        ? saved.groups["group:ops"]
        : saved.tagOwners["tag:server"],
    ).toEqual(["alice@example.com", "bob@"]);
  },
);

test.each([
  ["groups", "review"],
  ["groups", "confirmation"],
  ["tags", "review"],
  ["tags", "confirmation"],
] as const)(
  "%s publication refuses a principal that now resolves to another user id before %s despite an unchanged target name",
  async (kind, changeBefore) => {
    const ctx = await setup();
    const optionId =
      kind === "groups"
        ? ctx.session.policy.policyDesignerState.groups[0].id
        : ctx.session.policy.policyDesignerState.tagOwners[0].id;
    await page.getByTestId("member-actions-trigger-bob").click();
    await page.getByTestId(`assign-member-${kind}-bob`).click();
    await page.getByTestId(`assign-user-${kind}-option-${optionId}`).click();
    const apply = page
      .getByTestId(`assign-user-${kind}-apply`)
      .element() as HTMLButtonElement;
    if (changeBefore === "confirmation") {
      await page.getByTestId(`assign-user-${kind}-apply`).click();
      await expect
        .element(page.getByTestId("policy-publication-review"))
        .toBeVisible();
    }
    ctx.backend.users = ctx.backend.users.map((user) =>
      user.id === "1" ? { ...user, providerId: "bob" } : user,
    );
    ctx.session.snapshot.applyPatch({ users: ctx.backend.users });
    if (changeBefore === "review") apply.click();
    else
      (
        page
          .getByTestId("policy-publication-confirm")
          .element() as HTMLButtonElement
      ).click();
    await expect
      .element(page.getByTestId("policy-publication-review"))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByTestId(`assign-user-${kind}-dialog`))
      .toBeVisible();
    await expect
      .element(page.getByTestId(`assign-user-${kind}-dialog`))
      .toMatchTextContent(copy.policySaveContextChanged);
    expect(summary(ctx)).toEqual([]);
    expect(ctx.backend.policy?.policy).toBe(POLICY);
    expect(ctx.backend.users.find((user) => user.id === "2")?.name).toBe("bob");
  },
);

test.each(["groups", "tags"] as const)(
  "%s assignment leaves an uncertain write non-blocking without automatically replaying it",
  async (kind) => {
    const ctx = await setup();
    const optionId =
      kind === "groups"
        ? ctx.session.policy.policyDesignerState.groups[0].id
        : ctx.session.policy.policyDesignerState.tagOwners[0].id;
    await page.getByTestId("member-actions-trigger-bob").click();
    await page.getByTestId(`assign-member-${kind}-bob`).click();
    await page.getByTestId(`assign-user-${kind}-option-${optionId}`).click();
    ctx.failingWrites.set("/api/v1/policy", "Unclassified policy failure");
    await page.getByTestId(`assign-user-${kind}-apply`).click();
    await page.getByTestId("policy-publication-confirm").click();
    await expect
      .element(page.getByTestId(`assign-user-${kind}-dialog`))
      .toMatchTextContent(/server may have saved the change/i);
    expect(
      ctx.session.feedback.actionOutcome(`assign-user-${kind}`)?.status,
    ).toBe("possibly-applied");
    expect(summary(ctx)).toEqual(["PUT /api/v1/policy"]);
    expect(ctx.backend.policy?.policy).toBe(POLICY);
    ctx.failingWrites.clear();
    await page.getByTestId(`assign-user-${kind}-apply`).click();
    await expect
      .element(page.getByTestId("policy-publication-review"))
      .toBeVisible();
    expect(summary(ctx)).toEqual(["PUT /api/v1/policy"]);
    await page.getByTestId("policy-publication-confirm").click();
    await expect
      .element(page.getByTestId(`assign-user-${kind}-dialog`))
      .not.toBeInTheDocument();
    expect(summary(ctx)).toEqual(["PUT /api/v1/policy", "PUT /api/v1/policy"]);
    const saved = JSON.parse(String(ctx.backend.policy?.policy));
    expect(
      kind === "groups"
        ? saved.groups["group:ops"]
        : saved.tagOwners["tag:server"],
    ).toEqual(["alice@example.com", "bob@"]);
  },
);

test.each(["groups", "tags"] as const)(
  "%s assignment never publishes an Access draft that appeared after opening",
  async (kind) => {
    const ctx = await setup();
    const optionId =
      kind === "groups"
        ? ctx.session.policy.policyDesignerState.groups[0].id
        : ctx.session.policy.policyDesignerState.tagOwners[0].id;
    await page.getByTestId("member-actions-trigger-bob").click();
    await page.getByTestId(`assign-member-${kind}-bob`).click();
    const prefix = `assign-user-${kind}`;
    await page.getByTestId(`${prefix}-option-${optionId}`).click();
    const state = ctx.session.policy.policyDesignerState;
    ctx.session.policy.commitState({
      ...state,
      extras: { hosts: { unsaved: "10.0.0.1" } },
    });
    await page.getByTestId(`${prefix}-apply`).click();
    await expect.element(page.getByTestId(`${prefix}-dialog`)).toBeVisible();
    await expect
      .element(page.getByTestId(`${prefix}-apply`))
      .toHaveAttribute("aria-busy", "false");
    await expect
      .element(page.getByTestId(`${prefix}-option-${optionId}`))
      .toHaveAttribute("aria-checked", "true");
    expect(writes(ctx)).toEqual([]);
    expect(ctx.session.policy.isPolicyDirty).toBe(true);
    expect(ctx.session.policy.policyPayload?.hosts).toEqual({
      unsaved: "10.0.0.1",
    });
    expect(ctx.backend.policy?.policy).toBe(POLICY);
  },
);

test.each(["create", "rename", "delete", "groups", "tags"] as const)(
  "an active %s draft held by a session change cannot submit a write",
  async (action) => {
    const ctx = await setup();
    let submitId: string;
    let errorId: string;
    if (action === "create") {
      await page.getByTestId("open-create-member").click();
      await page.getByTestId("member-name").fill("carol");
      submitId = "create-member";
      errorId = "create-member-error";
    } else if (action === "rename" || action === "delete") {
      await memberAction(action, "bob");
      if (action === "rename")
        await page.getByTestId("rename-member-name").fill("robert");
      submitId = `confirm-${action}-member`;
      errorId = `${action}-member-error`;
    } else {
      const optionId =
        action === "groups"
          ? ctx.session.policy.policyDesignerState.groups[0].id
          : ctx.session.policy.policyDesignerState.tagOwners[0].id;
      await page.getByTestId("member-actions-trigger-bob").click();
      await page.getByTestId(`assign-member-${action}-bob`).click();
      await page
        .getByTestId(`assign-user-${action}-option-${optionId}`)
        .click();
      submitId = `assign-user-${action}-apply`;
      errorId = `assign-user-${action}-error`;
    }
    expect(ctx.session.drafts.hold({ id: "other", name: "Other server" })).toBe(
      true,
    );
    await page.getByTestId(submitId).click();
    await expect.element(page.getByTestId(errorId)).toBeVisible();
    expect(writes(ctx)).toEqual([]);
    expect(ctx.backend.policy?.policy).toBe(POLICY);
    expect(ctx.backend.users.map((user) => user.name)).toEqual([
      "alice",
      "bob",
      "tagged-devices",
    ]);
  },
);

// The option promises the new name, not an unrelated alias: unsafe destinations must not be sent.
test.each([
  {
    newName: "robert",
    other: { providerId: "robert" },
    email: "bob@example.com",
  },
  {
    newName: "robert@example.com",
    other: { email: "robert@example.com" },
    email: "bob@example.com",
  },
  { newName: "robert", other: { providerId: "robert" }, email: "" },
])(
  "P1 rename blocks an unsafe $newName destination before either write (email=$email)",
  async ({ newName, other, email }) => {
    const ctx = await setup("", RENAME_TARGET_POLICY);
    ctx.backend.users = [
      { ...bob, email },
      { id: "7", name: "external", ...other },
    ];
    await ctx.session.snapshot.refreshSnapshot();
    await memberAction("rename", "bob");
    await page.getByTestId("rename-member-name").fill(newName);
    await expect
      .element(page.getByTestId("confirm-rename-member"))
      .toBeDisabled();
    await expect
      .element(page.getByTestId("rename-member-target-error"))
      .toMatchTextContent(/name.*uniquely.*user.*directory/i);
    await userEvent.keyboard("{Enter}");
    expect(writes(ctx)).toEqual([]);
    expect(ctx.backend.users[0]?.name).toBe("bob");
    expect(ctx.backend.policy?.policy).toBe(RENAME_TARGET_POLICY);
    // Choosing a different name must recover without dismissing or losing the reference update.
    await page.getByTestId("rename-member-name").fill("robert-safe");
    await page.getByTestId("confirm-rename-member").click();
    await page.getByTestId("policy-publication-confirm").click();
    await expect
      .element(page.getByTestId("rename-member-dialog"))
      .not.toBeInTheDocument();
    expect(JSON.parse(String(ctx.backend.policy?.policy))).toMatchObject({
      groups: { "group:ops": ["robert-safe@"] },
      tagOwners: { "tag:server": ["robert-safe@"] },
      acls: [{ src: ["robert-safe@"], dst: ["robert-safe@:22"] }],
    });
  },
);

test("P1 an explicit rename-only choice leaves references untouched despite a name collision", async () => {
  const ctx = await setup("", RENAME_TARGET_POLICY);
  ctx.backend.users.push({ id: "7", name: "external", providerId: "robert" });
  await ctx.session.snapshot.refreshSnapshot();
  await memberAction("rename", "bob");
  await page.getByTestId("rename-member-name").fill("robert");
  await expect
    .element(page.getByTestId("confirm-rename-member"))
    .toBeDisabled();
  await page.getByTestId("rename-member-update-policy").click();
  await page.getByTestId("confirm-rename-member").click();
  await expect
    .element(page.getByTestId("rename-member-dialog"))
    .not.toBeInTheDocument();
  expect(summary(ctx)).toEqual(["POST /api/v1/user/2/rename/robert"]);
  expect(ctx.backend.policy?.policy).toBe(RENAME_TARGET_POLICY);
});

test("P1 a collision without old-name references does not prevent a rename", async () => {
  const ctx = await setup();
  ctx.backend.users.push({ id: "7", name: "external", providerId: "robert" });
  await ctx.session.snapshot.refreshSnapshot();
  await memberAction("rename", "bob");
  await page.getByTestId("rename-member-name").fill("robert");
  await page.getByTestId("confirm-rename-member").click();
  await expect
    .element(page.getByTestId("rename-member-dialog"))
    .not.toBeInTheDocument();
  expect(summary(ctx)).toEqual(["POST /api/v1/user/2/rename/robert"]);
  expect(ctx.backend.policy?.policy).toBe(POLICY);
});

test.each([
  { actual: "robert", other: { providerId: "robert" }, blocked: true },
  {
    actual: "robert@example.com",
    other: { email: "robert@example.com" },
    blocked: true,
  },
  { actual: "robert-actual", other: { providerId: "robert" }, blocked: false },
])(
  "P1 the actual rename response $actual is rechecked before updating references",
  async ({ actual, other, blocked }) => {
    const ctx = await setup("", RENAME_TARGET_POLICY);
    ctx.backend.users.push({ id: "7", name: "external", ...other });
    await ctx.session.snapshot.refreshSnapshot();
    ctx.renameResults.set("2", actual);
    await memberAction("rename", "bob");
    await page.getByTestId("rename-member-name").fill("robert-requested");
    await page.getByTestId("confirm-rename-member").click();
    if (blocked) {
      await expect
        .element(page.getByTestId("rename-member-policy-pending"))
        .toHaveTextContent(copy.renameMemberPolicyPending);
      await expect
        .element(page.getByTestId("rename-member-target-error"))
        .toMatchTextContent(/name.*uniquely.*user.*directory/i);
      await expect
        .element(page.getByTestId("confirm-rename-member"))
        .toBeDisabled();
      expect(summary(ctx)).toEqual([
        "POST /api/v1/user/2/rename/robert-requested",
      ]);
      expect(ctx.backend.policy?.policy).toBe(RENAME_TARGET_POLICY);
      // Fixing the directory permits only the outstanding policy step, never a second rename.
      ctx.backend.users = ctx.backend.users.filter((user) => user.id !== "7");
      await ctx.session.snapshot.refreshSnapshot();
      await page.getByTestId("confirm-rename-member").click();
    }
    await page.getByTestId("policy-publication-confirm").click();
    await expect
      .element(page.getByTestId("rename-member-dialog"))
      .not.toBeInTheDocument();
    expect(summary(ctx)).toEqual([
      "POST /api/v1/user/2/rename/robert-requested",
      "PUT /api/v1/policy",
    ]);
    const token =
      actual === "robert@example.com" ? "robert@example.com" : `${actual}@`;
    expect(JSON.parse(String(ctx.backend.policy?.policy))).toMatchObject({
      groups: { "group:ops": [token] },
      tagOwners: { "tag:server": [token] },
      acls: [{ src: [token], dst: [`${token}:22`] }],
    });
  },
);

test("P1 a collision in the live directory before React rerenders prevents the rename", async () => {
  const ctx = await setup("", RENAME_TARGET_POLICY);
  await memberAction("rename", "bob");
  await page.getByTestId("rename-member-name").fill("robert");
  await expect.element(page.getByTestId("confirm-rename-member")).toBeEnabled();
  const confirm = document.querySelector<HTMLButtonElement>(
    '[data-testid="confirm-rename-member"]',
  );
  if (!confirm) throw new Error("Missing rename button");
  ctx.session.snapshot.applyPatch({
    users: [
      ...ctx.backend.users,
      { id: "7", name: "external", providerId: "robert" },
    ],
  });
  confirm.click();
  await expect
    .element(page.getByTestId("rename-member-target-error"))
    .toBeVisible();
  expect(writes(ctx)).toEqual([]);
  expect(ctx.backend.policy?.policy).toBe(RENAME_TARGET_POLICY);
});

test("native rename submission rejects unchanged names and a directory collision during validation", async () => {
  const ctx = await setup("", RENAME_TARGET_POLICY);
  await memberAction("rename", "bob");
  const form = page.getByTestId("rename-member-form").element();
  expect.assert(form instanceof HTMLFormElement);
  await act(async () => {
    form.requestSubmit();
  });
  await expect
    .element(page.getByTestId("confirm-rename-member"))
    .toBeDisabled();
  expect(writes(ctx)).toEqual([]);

  await page.getByTestId("rename-member-name").fill("robert");
  await act(async () => {
    form.requestSubmit();
    ctx.backend.users.push({ id: "7", name: "external", providerId: "robert" });
    ctx.session.snapshot.applyPatch({
      users: structuredClone(ctx.backend.users),
    });
    await ctx.session.snapshot.refreshSnapshot();
  });
  await expect
    .element(page.getByTestId("rename-member-target-error"))
    .toBeVisible();
  await expect.element(page.getByTestId("rename-member-dialog")).toBeVisible();
  expect(writes(ctx)).toEqual([]);
  expect(ctx.backend.policy?.policy).toBe(RENAME_TARGET_POLICY);
  expect(ctx.backend.users.find((user) => user.id === "2")?.name).toBe("bob");
});

test.each(["renamed-again", "deleted"])(
  "P1 retry does not manufacture a target after the current user is %s",
  async (change) => {
    const ctx = await setup("", RENAME_TARGET_POLICY);
    ctx.failingWrites.set("/api/v1/policy", "Policy denied");
    await memberAction("rename", "bob");
    await page.getByTestId("rename-member-name").fill("robert");
    await page.getByTestId("confirm-rename-member").click();
    await expect
      .element(page.getByTestId("rename-member-policy-pending"))
      .toBeVisible();
    await page.getByTestId("policy-publication-confirm").click();
    await expect
      .element(page.getByTestId("rename-member-policy-error"))
      .toMatchTextContent("Policy denied");
    ctx.failingWrites.clear();
    ctx.backend.users =
      change === "deleted"
        ? ctx.backend.users.filter((user) => user.id !== "2")
        : ctx.backend.users.map((user) =>
            user.id === "2" ? { ...user, name: "renamed-elsewhere" } : user,
          );
    await ctx.session.snapshot.refreshSnapshot();
    await expect
      .element(page.getByTestId("confirm-rename-member"))
      .toBeDisabled();
    await expect
      .element(page.getByTestId("rename-member-target-error"))
      .toBeVisible();
    expect(summary(ctx)).toEqual([
      "POST /api/v1/user/2/rename/robert",
      "PUT /api/v1/policy",
    ]);
    expect(ctx.backend.policy?.policy).toBe(RENAME_TARGET_POLICY);
  },
);

test("P1 a collision arriving during rename is checked in the refreshed directory", async () => {
  const ctx = await setup("", RENAME_TARGET_POLICY);
  await memberAction("rename", "bob");
  await page.getByTestId("rename-member-name").fill("robert");
  const release = ctx.pauseRename();
  await page.getByTestId("confirm-rename-member").click();
  await expect
    .poll(() => summary(ctx))
    .toEqual(["POST /api/v1/user/2/rename/robert"]);
  ctx.backend.users.push({ id: "7", name: "external", providerId: "robert" });
  release();
  await expect
    .element(page.getByTestId("rename-member-target-error"))
    .toBeVisible();
  await expect
    .element(page.getByTestId("rename-member-policy-pending"))
    .toBeVisible();
  expect(summary(ctx)).toEqual(["POST /api/v1/user/2/rename/robert"]);
  expect(ctx.backend.policy?.policy).toBe(RENAME_TARGET_POLICY);
});

test.each(["https://fixture.invalid", "https://other.invalid"])(
  "P1 reconnecting to %s during rename never replays the policy step",
  async (baseUrl) => {
    const ctx = await setup("", RENAME_TARGET_POLICY);
    await memberAction("rename", "bob");
    await page.getByTestId("rename-member-name").fill("robert");
    const release = ctx.pauseRename();
    await page.getByTestId("confirm-rename-member").click();
    await expect
      .poll(() => summary(ctx))
      .toEqual(["POST /api/v1/user/2/rename/robert"]);
    await authenticateTestSession(ctx.session, baseUrl);
    release();
    await expect
      .poll(() => ctx.session.feedback.isActionPending("rename-member"))
      .toBe(false);
    expect(summary(ctx)).toEqual(["POST /api/v1/user/2/rename/robert"]);
    expect(ctx.backend.policy?.policy).toBe(RENAME_TARGET_POLICY);
  },
);

test("P1 a draft created during rename is not published with the identity migration", async () => {
  const ctx = await setup("", RENAME_TARGET_POLICY);
  await memberAction("rename", "bob");
  await page.getByTestId("rename-member-name").fill("robert");
  const release = ctx.pauseRename();
  await page.getByTestId("confirm-rename-member").click();
  await expect
    .poll(() => summary(ctx))
    .toEqual(["POST /api/v1/user/2/rename/robert"]);
  const state = ctx.session.policy.policyDesignerState;
  ctx.session.policy.commitState({
    ...state,
    extras: { hosts: { unsaved: "10.0.0.1" } },
  });
  release();
  await expect
    .element(page.getByTestId("rename-member-policy-pending"))
    .toBeVisible();
  expect(ctx.session.policy.policyPayload?.hosts).toEqual({
    unsaved: "10.0.0.1",
  });
  expect(ctx.session.policy.isPolicyDirty).toBe(true);
  expect(summary(ctx)).toEqual(["POST /api/v1/user/2/rename/robert"]);
  expect(ctx.backend.policy?.policy).toBe(RENAME_TARGET_POLICY);
});

test("P1 a response for a different user never receives the renamed user's references", async () => {
  const ctx = await setup("", RENAME_TARGET_POLICY);
  const other = { id: "7", name: "external", providerId: "external" };
  ctx.backend.users.push(other);
  ctx.renameResponseUsers.set("2", other);
  await ctx.session.snapshot.refreshSnapshot();
  await memberAction("rename", "bob");
  await page.getByTestId("rename-member-name").fill("robert");
  await page.getByTestId("confirm-rename-member").click();
  await expect
    .element(page.getByTestId("rename-member-policy-pending"))
    .toBeVisible();
  await expect
    .element(page.getByTestId("rename-member-target-error"))
    .toBeVisible();
  await expect
    .element(page.getByTestId("confirm-rename-member"))
    .toBeDisabled();
  expect(summary(ctx)).toEqual(["POST /api/v1/user/2/rename/robert"]);
  expect(ctx.backend.policy?.policy).toBe(RENAME_TARGET_POLICY);
});

function Assignment({
  options,
  onApply = () => {},
  onSelectionChange,
  isSubmitting = false,
}: {
  options: AssignMemberOption[];
  onApply?: (selection: string[]) => void | Promise<void>;
  onSelectionChange?: () => void;
  isSubmitting?: boolean;
}) {
  const [open, setOpen] = useState(true);
  return (
    <AssignMemberDialog
      open={open}
      onOpenChange={setOpen}
      title="Assign groups"
      description="Choose memberships"
      options={options}
      applyLabel="Apply"
      cancelLabel="Cancel"
      emptyLabel="No groups"
      assignedLabel="Assigned"
      testidPrefix="groups"
      onApply={onApply}
      onSelectionChange={onSelectionChange}
      isSubmitting={isSubmitting}
    />
  );
}
test("native assignment submission ignores unchanged and externally busy drafts without losing a removal", async () => {
  await hydrateSettings();
  await setLocale("en-US");
  const applied: string[][] = [];
  const options = [{ id: "a", name: "Alpha", assigned: true }];
  const onApply = (selection: string[]) => {
    applied.push(selection);
  };
  const view = (isSubmitting = false) => (
    <I18nProvider i18n={i18n}>
      <Assignment
        options={options}
        onApply={onApply}
        isSubmitting={isSubmitting}
      />
    </I18nProvider>
  );
  const screen = await render(view());
  await act(async () => {
    submitTwice("groups-apply");
  });
  await expect.element(page.getByTestId("groups-apply")).toBeDisabled();
  expect(applied).toEqual([]);

  await page.getByTestId("groups-option-a").click();
  await screen.rerender(view(true));
  await act(async () => {
    submitTwice("groups-apply");
  });
  await expect
    .element(page.getByTestId("groups-option-a"))
    .toHaveAttribute("aria-checked", "false");
  expect(applied).toEqual([]);

  await screen.rerender(view());
  await page.getByTestId("groups-apply").click();
  await expect.poll(() => applied).toEqual([[]]);
});

test("assignment ignores a reentrant checkbox event after submitting starts", async () => {
  await hydrateSettings();
  await setLocale("en-US");
  const gate = Promise.withResolvers<void>();
  const applied: string[][] = [];
  let selectionChanges = 0;
  await render(
    <I18nProvider i18n={i18n}>
      <Assignment
        options={[
          { id: "a", name: "Alpha", assigned: false },
          { id: "b", name: "Beta", assigned: false },
          { id: "c", name: "Gamma", assigned: false },
        ]}
        onSelectionChange={() => {
          selectionChanges++;
          if (selectionChanges !== 2) return;
          const form = page.getByTestId("groups-form").element();
          const other = page.getByTestId("groups-option-c").element();
          expect.assert(form instanceof HTMLFormElement);
          expect.assert(other instanceof HTMLButtonElement);
          // 选择回调同步提交时，尚未渲染禁用态的另一行也不能重入修改集合。
          form.requestSubmit();
          other.click();
        }}
        onApply={async (selection) => {
          applied.push(selection);
          await gate.promise;
        }}
      />
    </I18nProvider>,
  );
  await page.getByTestId("groups-option-a").click();
  try {
    await page.getByTestId("groups-option-b").click();
    await expect.poll(() => applied).toEqual([["a", "b"]]);
    await expect
      .element(page.getByTestId("groups-option-c"))
      .toHaveAttribute("aria-checked", "false");
    expect(selectionChanges).toBe(2);
  } finally {
    gate.resolve();
  }
});

test("assignment awaits onApply without relying on external busy state and blocks duplicate submit", async () => {
  await hydrateSettings();
  await setLocale("en-US");
  const gate = Promise.withResolvers<void>();
  const applied: string[][] = [];
  await render(
    <I18nProvider i18n={i18n}>
      <Assignment
        options={[{ id: "a", name: "Alpha", assigned: false }]}
        onApply={async (selection) => {
          applied.push(selection);
          await gate.promise;
        }}
      />
    </I18nProvider>,
  );
  await page.getByTestId("groups-option-a").click();
  try {
    submitTwice("groups-apply");
    await expect.poll(() => applied).toEqual([["a"]]);
    await expect
      .element(page.getByTestId("groups-apply"))
      .toHaveAttribute("aria-busy", "true");
    await expect.element(page.getByTestId("groups-option-a")).toBeDisabled();
    await expect.element(page.getByTestId("groups-cancel")).toBeDisabled();
  } finally {
    gate.resolve();
  }
  await expect.element(page.getByTestId("groups-apply")).toBeEnabled();
  await expect
    .element(page.getByTestId("groups-option-a"))
    .toHaveAttribute("aria-checked", "true");
  await page.getByTestId("groups-apply").click();
  await expect.poll(() => applied).toEqual([["a"], ["a"]]);
});

// A periodic refresh re-renders the open dialog with new server assignments.
test("a refresh while the assignment dialog is open keeps the unsaved selection", async () => {
  await hydrateSettings();
  await setLocale("en-US");
  const before = [
    { id: "a", name: "Alpha", assigned: true },
    { id: "b", name: "Beta", assigned: false },
  ];
  const after = [
    { id: "a", name: "Alpha", assigned: false },
    { id: "b", name: "Beta", assigned: false },
  ];
  const screen = await render(
    <I18nProvider i18n={i18n}>
      <Assignment options={before} />
    </I18nProvider>,
  );
  await page.getByTestId("groups-option-b").click();
  await expect
    .element(page.getByTestId("groups-option-b"))
    .toHaveAttribute("aria-checked", "true");
  await screen.rerender(
    <I18nProvider i18n={i18n}>
      <Assignment options={after} />
    </I18nProvider>,
  );
  await expect
    .element(page.getByTestId("groups-assigned-a"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("groups-option-a"))
    .toHaveAttribute("aria-checked", "true");
  await expect
    .element(page.getByTestId("groups-option-b"))
    .toHaveAttribute("aria-checked", "true");
});
