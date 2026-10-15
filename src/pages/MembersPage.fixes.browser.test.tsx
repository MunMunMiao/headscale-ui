import "fake-indexeddb/auto";
import type { FetchHandle } from "@defjs/core";
import { I18nProvider } from "@lingui/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { HeadscaleSnapshot } from "@/api/contracts";
import AssignMemberDialog, { type AssignMemberOption } from "@/components/AssignMemberDialog";
import { i18n, setLocale, t } from "@/i18n";
import { getProductCopy } from "@/i18n/product-copy";
import { hydrateSettings } from "@/lib/settings-storage";
import { authenticateTestSession, prepareTestSession, renderSessionPage } from "@/test/session";
import MembersPage from "./MembersPage";

const copy = getProductCopy("en-US");
const alice = { id: "1", name: "alice", displayName: "Alice", email: "alice@example.com" };
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
  const transport: FetchHandle = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const raw = await request.clone().text();
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ method: request.method, path: url.pathname, body });
    if (request.method === "GET" && failingReads.has(url.pathname))
      return Response.json({ code: 13, message: "read failed" }, { status: 500 });
    if (request.method === "POST" && url.pathname === "/api/v1/user") {
      const user = { id: String(backend.users.length + 10), ...body } as typeof bob;
      backend.users.push(user);
      return Response.json({ user });
    }
    if (request.method === "POST" && url.pathname.includes("/rename/")) {
      const user = backend.users.find((u) => u.id === url.pathname.split("/")[4]);
      if (!user) throw new Error("Missing fixture user");
      user.name = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      return Response.json({ user });
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/api/v1/user/")) {
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
  const rendered = await renderSessionPage(session, <MembersPage />, `/members${search}`);
  await expect
    .poll(() => session.snapshot.getSnapshot().snapshot.health?.serverReachable)
    .toBe(true);
  await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
  calls.length = 0;
  return { backend, calls, session, failingReads, ...rendered };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
afterEach(() => vi.restoreAllMocks());
const writes = (ctx: Ctx) => ctx.calls.filter((call) => call.method !== "GET");
const summary = (ctx: Ctx) => writes(ctx).map((call) => `${call.method} ${call.path}`);
async function memberAction(action: string, name: string) {
  await page.getByTestId(`member-actions-trigger-${name}`).click();
  await page.getByTestId(`${action}-member-${name}`).click();
}
function text(testid: string) {
  return String(document.querySelector(`[data-testid="${testid}"]`)?.textContent);
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

// Headscale has no roles: an id-1 "owner" or a "system" service account would invent permissions.
test("the users page shows no invented roles in the table, toolbar, details or export", async () => {
  const csv = captureDownloads();
  await setup();
  await expect.element(page.getByTestId("member-alice")).toBeVisible();
  expect(document.querySelector('[data-testid="user-filter"]')).toBeNull();
  expect(document.querySelector('[data-testid^="member-role-"]')).toBeNull();
  const headers = Array.from(document.querySelectorAll("thead th"), (th) => th.textContent?.trim());
  expect(headers).not.toContain("Role");
  await page.getByTestId("export-users").click();
  expect(await csv.text()).toMatch(/^"name","email","provider","machines","joined"\n/);
  await page.getByTestId("member-detail-link-alice").click();
  await expect.element(page.getByTestId("user-detail-dialog")).toBeVisible();
  expect(text("user-detail-dialog")).not.toContain("Role");
});

test("user creation validates the name and email inline and sends nothing until both are valid", async () => {
  const ctx = await setup();
  await page.getByTestId("open-create-member").click();
  await expect.element(page.getByTestId("member-email")).toHaveAttribute("type", "email");
  for (const id of ["member-display", "member-email"])
    expect(document.querySelector(`label[for="${id}"]`)?.textContent).toContain(copy.optionalField);
  await page.getByTestId("create-member").click();
  await expect
    .element(page.getByTestId("member-name-error"))
    .toHaveTextContent(copy.userNameRequired);
  await expect.element(page.getByTestId("member-name")).toHaveAttribute("aria-invalid", "true");
  await expect.element(page.getByTestId("member-name")).toHaveFocus();
  await page.getByTestId("member-name").fill("Bad User!");
  await expect
    .element(page.getByTestId("member-name-error"))
    .toHaveTextContent(copy.userNameInvalid);
  await page.getByTestId("member-name").fill("alice");
  await expect.element(page.getByTestId("member-name-error")).toHaveTextContent(copy.userNameTaken);
  await page.getByTestId("member-name").fill(" carol ");
  await expect.element(page.getByTestId("member-name-error")).not.toBeInTheDocument();
  await page.getByTestId("member-email").fill("not-an-email");
  await page.getByTestId("create-member").click();
  await expect.element(page.getByTestId("member-email-error")).toHaveTextContent(copy.emailInvalid);
  await expect.element(page.getByTestId("member-email")).toHaveAttribute("aria-invalid", "true");
  expect(writes(ctx)).toEqual([]);
  await page.getByTestId("member-email").fill("carol@example.com");
  await page.getByTestId("create-member").click();
  await expect.element(page.getByTestId("member-carol")).toBeVisible();
  expect(summary(ctx)).toEqual(["POST /api/v1/user"]);
  expect(writes(ctx)[0]?.body).toMatchObject({ name: "carol", email: "carol@example.com" });
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
  await expect.element(page.getByTestId("member-create-dialog")).not.toBeInTheDocument();
  await page.getByTestId("open-create-member").click();
  await expect.element(page.getByTestId("member-name")).toHaveValue("");
  await expect.element(page.getByTestId("member-email")).toHaveValue("");
  expect(document.querySelector('[data-testid="member-name-error"]')).toBeNull();
  await page.getByTestId("member-display").fill("Draft");
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("member-create-dialog")).not.toBeInTheDocument();
  await page.getByTestId("open-create-member").click();
  await expect.element(page.getByTestId("member-display")).toHaveValue("");
});

test("rename confirm stays disabled for a blank, unchanged, taken or invalid name", async () => {
  const ctx = await setup();
  await memberAction("rename", "bob");
  const confirm = page.getByTestId("confirm-rename-member");
  await expect.element(confirm).toBeDisabled();
  for (const [value, message] of [
    ["   ", copy.userNameRequired],
    [" bob ", ""],
    ["alice", copy.userNameTaken],
    ["b ob", copy.userNameInvalid],
  ]) {
    await page.getByTestId("rename-member-name").fill(value);
    await expect.element(confirm).toBeDisabled();
    if (message)
      await expect.element(page.getByTestId("rename-member-name-error")).toHaveTextContent(message);
    else await expect.element(page.getByTestId("rename-member-name-error")).not.toBeInTheDocument();
  }
  await userEvent.keyboard("{Enter}");
  expect(writes(ctx)).toEqual([]);
  await page.getByTestId("rename-member-name").fill(" bob2 ");
  await expect.element(confirm).toBeEnabled();
  await confirm.click();
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
  await expect.element(page.getByTestId("rename-member-dialog")).not.toBeInTheDocument();
  expect(summary(ctx)).toEqual(["POST /api/v1/user/7/rename/ops2%40corp", "PUT /api/v1/policy"]);
  const saved = JSON.parse(String(writes(ctx)[1]?.body.policy));
  expect(saved.groups["group:ops"]).toEqual(["ops2@corp"]);
  expect(saved.acls[0].src).toEqual(["ops2@corp"]);
});

// The partial state must come from this dialog's own rename, not from a snapshot that changed elsewhere.
test("a rename made elsewhere while the dialog is open does not skip this rename", async () => {
  const ctx = await setup("", JSON.stringify({ groups: { "group:ops": ["alice@"] }, acls: [] }));
  await memberAction("rename", "alice");
  await expect.element(page.getByTestId("rename-member-policy-impact")).toBeVisible();
  const renamed = ctx.backend.users.find((user) => user.id === "1");
  if (!renamed) throw new Error("Missing fixture user");
  renamed.name = "alice-elsewhere";
  ctx.session.snapshot.applyPatch({ users: structuredClone(ctx.backend.users) });
  await expect.element(page.getByTestId("member-alice-elsewhere")).toBeInTheDocument();
  await expect.element(page.getByTestId("rename-member-name")).toBeEnabled();
  expect(document.querySelector('[data-testid="rename-member-policy-pending"]')).toBeNull();
  await page.getByTestId("rename-member-name").fill("alice2");
  await page.getByTestId("confirm-rename-member").click();
  await expect.element(page.getByTestId("rename-member-dialog")).not.toBeInTheDocument();
  expect(summary(ctx)).toEqual(["POST /api/v1/user/1/rename/alice2", "PUT /api/v1/policy"]);
  expect(JSON.parse(String(ctx.backend.policy?.policy)).groups["group:ops"]).toEqual(["alice2@"]);
});

// A source page in the URL only matters when the admin dismisses the details they came for.
test("row actions under a source-page link stay on their action", async () => {
  const ctx = await setup("?user=2&from=devices");
  await memberAction("create-invite-for", "bob");
  await expect.element(page.getByTestId("invite-create-dialog")).toBeVisible();
  expect(ctx.router.state.location.pathname).toBe("/members");
  await page.getByTestId("cancel-create-invite").click();
  await expect.element(page.getByTestId("invite-create-dialog")).not.toBeInTheDocument();
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
  expect(document.querySelector('[data-testid="user-detail-dialog"]')?.scrollTop).toBe(0);
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
  await expect.element(page.getByTestId("member-detail-link-alice")).toHaveTextContent("Alice");
  await expect.element(page.getByTestId("member-username-alice")).toHaveTextContent("alice");
  await expect.element(page.getByTestId("member-alice")).toMatchTextContent("alice@example.com");
  expect(document.querySelector('[data-testid="member-username-bob"]')).toBeNull();
  await expect.element(page.getByTestId("member-device-tag-alice-1")).toMatchTextContent("Online");
  await expect.element(page.getByTestId("member-device-tag-alice-2")).toMatchTextContent("Offline");
  await expect.element(page.getByTestId("member-device-tag-alice-3")).toMatchTextContent("Expired");
});

test("the count is a named status and export is disabled when no row matches", async () => {
  await setup();
  const count = page.getByTestId("user-count");
  await expect.element(count).toHaveAttribute("role", "status");
  await expect.element(count).toMatchTextContent(t("usersShown", { shown: 2, total: 2 }));
  await expect.element(page.getByTestId("export-users")).toHaveAttribute("title", copy.exportData);
  await page.getByTestId("user-search").fill("zzz-no-match");
  await expect.element(count).toMatchTextContent(t("usersShown", { shown: 0, total: 2 }));
  await expect.element(page.getByTestId("export-users")).toBeDisabled();
  await expect.element(page.getByTestId("members-state")).toHaveTextContent(copy.noUsersMatch);
});

test("loading, failed and empty user lists are not reported as unmatched filters", async () => {
  const ctx = await setup();
  ctx.session.snapshot.resetSnapshot();
  await expect.element(page.getByTestId("members-state")).toHaveTextContent(copy.membersLoading);
  ctx.failingReads.add("/api/v1/user");
  await ctx.session.snapshot.refreshSnapshot();
  await expect
    .element(page.getByTestId("members-state"))
    .toMatchTextContent(copy.membersLoadFailed);
  expect(text("members-state")).not.toContain("read failed");
  ctx.failingReads.clear();
  ctx.backend.users = ctx.backend.users.filter((user) => user.id === "0");
  await page.getByTestId("retry-members").click();
  await expect.element(page.getByTestId("members-state")).toHaveTextContent(copy.noUsersYet);
  await expect.element(page.getByTestId("export-users")).toBeDisabled();
});

test("removing a policy reference has a 24px target and asks before saving", async () => {
  const ctx = await setup("?user=1&popup=user");
  await expect.element(page.getByTestId("user-detail-dialog")).toBeVisible();
  const remove = document.querySelector<HTMLButtonElement>(
    '[data-testid^="remove-user-policy-reference-group-"]',
  );
  if (!remove?.dataset.testid) throw new Error("Missing reference remove button");
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
  await expect
    .element(page.getByTestId(remove.dataset.testid.replace("remove-", "")))
    .not.toBeInTheDocument();
  await expect.element(page.getByTestId("user-detail-dialog")).toBeVisible();
  expect(summary(ctx)).toEqual(["PUT /api/v1/policy"]);
  expect(JSON.parse(String(ctx.backend.policy?.policy)).groups["group:ops"]).toEqual([]);
});

test("deleting a user shows its devices and keys and is disabled while it still owns devices", async () => {
  const ctx = await setup();
  await memberAction("delete", "alice");
  const summaryText = page.getByTestId("delete-member-summary");
  await expect.element(summaryText).toMatchTextContent(`${copy.memberDevices}: 2`);
  await expect.element(summaryText).toMatchTextContent(`${copy.activeAuthKeys}: 1`);
  await expect
    .element(page.getByTestId("delete-member-devices"))
    .toMatchTextContent(copy.deleteMemberOwnsDevices);
  expect(text("delete-member-devices")).toContain("edge-router");
  expect(text("delete-member-devices")).toContain("laptop");
  await expect.element(page.getByTestId("confirm-delete-member")).toBeDisabled();
  ctx.backend.nodes = [];
  await ctx.session.snapshot.refreshSnapshot();
  await expect.element(page.getByTestId("delete-member-devices")).not.toBeInTheDocument();
  await expect.element(summaryText).toMatchTextContent(`${copy.memberDevices}: 0`);
  await expect.element(page.getByTestId("confirm-delete-member")).toBeEnabled();
  await page.getByTestId("confirm-delete-member").click();
  await expect.element(page.getByTestId("delete-member-dialog")).not.toBeInTheDocument();
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

test("at 790px every row keeps a visible actions menu without horizontal scrolling", async () => {
  await setup();
  await page.viewport(790, 800);
  for (const name of ["alice", "bob"])
    await expect.element(page.getByTestId(`member-actions-trigger-mobile-${name}`)).toBeVisible();
  const container = document.querySelector<HTMLElement>(
    '[data-testid="user-table"] [data-slot="table-container"]',
  );
  if (!container) throw new Error("Missing table container");
  expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth);
});

function Assignment({ options }: { options: AssignMemberOption[] }) {
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
      onApply={() => {}}
    />
  );
}
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
  await expect.element(page.getByTestId("groups-option-b")).toHaveAttribute("aria-checked", "true");
  await screen.rerender(
    <I18nProvider i18n={i18n}>
      <Assignment options={after} />
    </I18nProvider>,
  );
  await expect.element(page.getByTestId("groups-assigned-a")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("groups-option-a")).toHaveAttribute("aria-checked", "true");
  await expect.element(page.getByTestId("groups-option-b")).toHaveAttribute("aria-checked", "true");
});
