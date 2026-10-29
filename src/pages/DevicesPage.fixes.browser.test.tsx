import "fake-indexeddb/auto";
import type { FetchHandle } from "@defjs/core";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { HeadscaleSnapshot } from "@/api/contracts";
import { createMutation } from "@/composables/useMutation";
import { i18n, setLocale, t } from "@/i18n";
import { commonDescriptors, productDescriptors } from "@/i18n/descriptors";
import { getProductCopy } from "@/i18n/product-copy";
import {
  authenticateTestSession,
  prepareTestSession,
  renderSessionPage,
} from "@/test/session";
import DevicesPage from "./DevicesPage";

const copy = getProductCopy("en-US");
const alice = {
  id: "1",
  name: "alice",
  displayName: "Alice",
  email: "alice@example.com",
};
const bob = {
  id: "2",
  name: "bob",
  displayName: "Bob",
  email: "bob@example.com",
};
const AUTH_ID = "hskey-authreq-a1B2c3D4e5F6g7H8i9J0k1L2";

function fixture(): HeadscaleSnapshot {
  return {
    health: { databaseConnectivity: true, serverReachable: true },
    version: { version: "0.29.4" },
    users: [{ ...alice }, { ...bob }, { id: "0", name: "tagged-devices" }],
    apiKeys: [],
    policy: {
      policy: JSON.stringify({
        tagOwners: {
          "tag:server": ["alice@example.com"],
          "tag:web": [],
          "tag:db": [],
          "tag:remote": [],
          "tag:local": [],
          "tag:external": [],
          "tag:once": [],
          "tag:x": [],
        },
      }),
    },
    nodes: [
      {
        id: "1",
        name: "edge",
        givenName: "edge-router",
        user: alice,
        online: true,
        lastSeen: "2001-01-01T00:00:00Z",
        ipAddresses: ["100.64.0.1"],
        approvedRoutes: ["10.42.0.0/16"],
        availableRoutes: ["10.42.0.0/16", "0.0.0.0/0"],
        subnetRoutes: [],
        tags: ["tag:server"],
        registerMethod: "REGISTER_METHOD_AUTH_KEY",
      },
      {
        id: "2",
        name: "laptop",
        user: bob,
        online: false,
        lastSeen: "2001-01-01T00:00:00Z",
        ipAddresses: ["100.64.0.2"],
        approvedRoutes: [],
        availableRoutes: [],
        subnetRoutes: [],
        tags: [],
        expiry: "2000-01-01T00:00:00Z",
        registerMethod: "REGISTER_METHOD_CLI",
      },
    ],
    preAuthKeys: [],
  };
}

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

async function setup(
  search = "",
  patch: (backend: HeadscaleSnapshot) => void = () => {},
) {
  await page.viewport(1366, 768);
  const backend = fixture();
  patch(backend);
  const calls: Call[] = [];
  let failure = "";
  let readFailure = false;
  let failReadsAfterWrite = false;
  let failIdentityReads = false;
  let writeHold: Promise<void> | undefined;
  let readHold: Promise<void> | undefined;
  const transport: FetchHandle = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const raw = await request.clone().text();
    const body = raw ? JSON.parse(raw) : Object.fromEntries(url.searchParams);
    calls.push({ method: request.method, path: url.pathname, body });
    if (writeHold && request.method !== "GET") await writeHold;
    if (readHold && request.method === "GET") await readHold;
    if (
      readFailure &&
      request.method === "GET" &&
      (url.pathname === "/api/v1/node" ||
        (failIdentityReads &&
          (url.pathname === "/api/v1/user" ||
            url.pathname === "/api/v1/preauthkey")))
    )
      return Response.json(
        { message: "Fresh read unavailable" },
        { status: 503 },
      );
    if (request.method !== "GET" && failReadsAfterWrite) readFailure = true;
    if (failure && request.method !== "GET")
      return Response.json({ message: failure }, { status: 500 });
    if (request.method === "POST" && url.pathname === "/api/v1/preauthkey") {
      const preAuthKey = { id: "9", key: "created-key", used: false, ...body };
      backend.preAuthKeys.push({
        ...preAuthKey,
        user: undefined,
        key: "masked",
      });
      return Response.json({ preAuthKey: { ...preAuthKey, user: undefined } });
    }
    if (request.method === "POST" && url.pathname === "/api/v1/auth/register") {
      const node = {
        ...backend.nodes[1],
        id: "3",
        name: "registered",
        givenName: "registered",
        tags: [],
        user: backend.users.find((user) => user.name === body.user),
      };
      backend.nodes.push(node as (typeof backend.nodes)[number]);
      return Response.json({ node });
    }
    if (request.method === "POST" && url.pathname.startsWith("/api/v1/auth/"))
      return Response.json({});
    if (url.pathname.includes("/node/") && request.method !== "GET") {
      const node = backend.nodes.find(
        (n) => n.id === url.pathname.split("/")[4],
      );
      if (!node) throw new Error("Missing fixture node");
      if (url.pathname.includes("/rename/"))
        node.givenName = decodeURIComponent(
          url.pathname.split("/").at(-1) ?? "",
        );
      if (url.pathname.endsWith("/tags")) {
        const tags = body.tags as string[];
        const owners =
          JSON.parse(backend.policy?.policy || "{}").tagOwners ?? {};
        if (
          !tags.length ||
          tags.some((tag) => !(tag in owners) || tag !== tag.toLowerCase())
        )
          return Response.json(
            { message: "undefined or invalid tags" },
            { status: 400 },
          );
        node.tags = tags;
        delete node.user;
      }
      return Response.json({ node });
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
  // Catalog extraction has a separate owner; exercise fixed-key notifications with fixture copy.
  i18n.load("en-US", {
    [commonDescriptors.notifications.id]: "Notifications",
    [productDescriptors.feedbackRequestConfirmed.id]: "Request confirmed",
    [productDescriptors.feedbackRequestNotSent.id]: "Request not sent",
    [productDescriptors.feedbackRequestRejected.id]: "Request rejected",
    [productDescriptors.feedbackRefreshFailed.id]: "Could not refresh data",
    [productDescriptors.feedbackPossiblyApplied.id]:
      "The change may have been applied",
  });
  const rendered = await renderSessionPage(
    session,
    <DevicesPage />,
    `/devices${search}`,
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
    ...rendered,
    writes: () => calls.filter((call) => call.method !== "GET"),
    nodeReads: () =>
      calls.filter(
        (call) => call.method === "GET" && call.path === "/api/v1/node",
      ),
    fail: (message: string) => {
      failure = message;
    },
    failRefresh: () => {
      failReadsAfterWrite = true;
    },
    failInventory: () => {
      failIdentityReads = true;
      failReadsAfterWrite = true;
    },
    holdReads: () => {
      let release!: () => void;
      readHold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        readHold = undefined;
        release();
      };
    },
    holdWrites: () => {
      let release!: () => void;
      writeHold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        writeHold = undefined;
        release();
      };
    },
  };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
afterEach(() => vi.restoreAllMocks());

function isOpen(testid: string) {
  return (
    document
      .querySelector(`[data-testid="${testid}"]`)
      ?.hasAttribute("data-open") === true
  );
}
async function openWizard(task: "server" | "client") {
  await page.getByTestId("add-device-toggle").click();
  await page
    .getByTestId(task === "server" ? "add-linux-device" : "add-client-device")
    .click();
}
async function toGenerateStep(task: "server" | "client") {
  await openWizard(task);
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("add-device-next").click();
}
async function generateKey(task: "server" | "client" = "client") {
  await toGenerateStep(task);
  await page.getByTestId("generate-install-script").click();
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
}
async function openMenu(id: string, item: string) {
  await page.getByTestId(`machine-actions-trigger-${id}`).click();
  await page.getByTestId(`${item}-action-${id}`).click();
}
async function chooseTags(prefix: "setup-tags" | "node-tags", tags: string[]) {
  for (const button of Array.from(
    document.querySelectorAll(`[data-testid^="${prefix}-remove-"]`),
  )) {
    const id = button.getAttribute("data-testid");
    expect.assert(id);
    await page.getByTestId(id).click();
  }
  for (const tag of tags) {
    if (prefix === "node-tags")
      await page.getByTestId(`${prefix}-option-${tag}`).click();
    else {
      await page.getByTestId(`${prefix}-search`).fill(tag);
      await page.getByTestId(`${prefix}-add`).click();
    }
  }
}
async function confirmTags() {
  await page.getByTestId("node-tags-confirm").click();
  await page.getByTestId("node-tags-apply").click();
}
async function trustRegistration(
  user = "1",
  server = "https://fixture.invalid",
) {
  await page.getByTestId("pending-registration-user").selectOptions(user);
  await page.getByTestId("restore-login-server").fill(server);
  await page.getByTestId("restore-server-confirm").click();
  await page.getByTestId("restore-source-confirm").click();
}
function keyWrites(ctx: Ctx) {
  return ctx.writes().filter((call) => call.path === "/api/v1/preauthkey");
}
function expectDays(value: unknown, days: number) {
  const delta = Date.parse(String(value)) - (Date.now() + days * 86_400_000);
  expect(Math.abs(delta)).toBeLessThan(120_000);
}

function currentToasts() {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-slot="toast"]:not([data-ending-style])',
    ),
  );
}

test("G27: a slow setup inventory refresh keeps the created key usable without claiming failure", async () => {
  const ctx = await setup();
  await generateKey("server");
  const secret = ctx.session.deviceSetup.getSnapshot().lastCreatedInvite;
  const copied = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const release = ctx.holdReads();
  try {
    await page.getByTestId("setup-refresh-devices").click();
    await expect
      .poll(() => ctx.session.snapshot.getSnapshot().segmentStatus.identity)
      .toBe("loading");
    expect(
      ctx.session.snapshot.getSnapshot().refreshErrors.identity,
    ).toBeUndefined();
    await expect
      .element(page.getByTestId("copy-setup-install-command"))
      .toBeEnabled();
    await page.getByTestId("copy-setup-install-command").click();
    expect(copied.mock.calls.some(([value]) => value.includes(secret))).toBe(
      true,
    );
    expect(
      ctx.session.deviceSetup.getSnapshot().lastCreatedInvite === secret,
    ).toBe(true);
    expect(keyWrites(ctx)).toHaveLength(1);
    await expect
      .element(page.getByTestId("setup-created-refresh-failed"))
      .not.toBeInTheDocument();
  } finally {
    release();
  }
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  expect(
    ctx.session.deviceSetup.getSnapshot().lastCreatedInvite === secret,
  ).toBe(true);
  expect(keyWrites(ctx)).toHaveLength(1);
});

test("a confirmed setup key whose inventory read fails keeps the explanation on the created card", async () => {
  const ctx = await setup();
  const add = vi.spyOn(ctx.session.feedback.toastManager, "add");
  ctx.failInventory();
  await generateKey("server");
  expect(ctx.session.feedback.actionOutcome("create-invite")).toMatchObject({
    status: "confirmed",
    refresh: "failed",
  });
  const note = page
    .getByTestId("created-invite")
    .getByTestId("setup-created-refresh-failed");
  await expect
    .element(note)
    .toHaveTextContent(copy.inviteCreateConfirmedRefreshFailed);
  expect(note.element().textContent ?? "").not.toContain("created-key");
  expect(JSON.stringify(add.mock.calls)).not.toContain("created-key");
  expect(
    currentToasts().every(
      (toast) => !toast.textContent?.includes("created-key"),
    ),
  ).toBe(true);
  expect(keyWrites(ctx)).toHaveLength(1);
});

test("an unrelated fabric refresh failure does not claim the setup inventory is unknown", async () => {
  const ctx = await setup();
  const add = vi.spyOn(ctx.session.feedback.toastManager, "add");
  ctx.failRefresh();
  await generateKey("server");
  expect(ctx.session.feedback.actionOutcome("create-invite")).toMatchObject({
    status: "confirmed",
    refresh: "failed",
  });
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  await expect
    .element(page.getByTestId("setup-created-refresh-failed"))
    .not.toBeInTheDocument();
  expect(JSON.stringify(add.mock.calls)).not.toContain("created-key");
  expect(keyWrites(ctx)).toHaveLength(1);
});

test("unified feedback: a replacement SSH draft is not cleared by a retired completion", async () => {
  const ctx = await setup();
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("add-pending-node").click();
  await page.getByTestId("pending-registration-kind").selectOptions("ssh");
  await page.getByTestId("pending-node-key").fill(AUTH_ID);
  const replacement = {
    kind: "ssh" as const,
    user: "2",
    key: "hskey-authreq-Z1Y2x3W4v5U6t7S8r9Q0p1N2",
  };
  const release = ctx.holdWrites();
  try {
    await page.getByTestId("approve-ssh-check").click();
    await expect.poll(() => ctx.writes().length).toBe(1);
    await ctx.router.navigate({ to: "/routes" });
    // Public-store ownership boundary: a replacement owner has supplied a different draft.
    ctx.session.deviceSetup.setState({ pendingRegistrationForm: replacement });
    await ctx.router.navigate({ to: "/devices" });
    await expect
      .element(page.getByTestId("pending-node-key"))
      .toHaveValue(replacement.key);
  } finally {
    release();
  }
  await expect
    .poll(() => ctx.session.feedback.isActionPending("approve-auth-request"))
    .toBe(false);
  expect(ctx.session.deviceSetup.getSnapshot()).toMatchObject({
    pendingRegistrationForm: replacement,
    task: "pending",
    step: "pending",
  });
  await expect
    .element(page.getByTestId("pending-node-key"))
    .toHaveValue(replacement.key);
  await expect.element(page.getByTestId("approve-ssh-check")).toBeEnabled();
  await expect
    .element(page.getByTestId("ssh-check-result"))
    .not.toBeInTheDocument();
  expect(currentToasts()).toHaveLength(0);
  expect(ctx.writes()).toHaveLength(1);
});

test.each(["approve", "reject"] as const)(
  "unified feedback: SSH %s keeps uncertain evidence in one persistent owner",
  async (action) => {
    const ctx = await setup();
    await page.getByTestId("add-device-toggle").click();
    await page.getByTestId("add-pending-node").click();
    await page.getByTestId("pending-registration-kind").selectOptions("ssh");
    await page.getByTestId("pending-node-key").fill(AUTH_ID);
    ctx.fail("SSH operator diagnostic");
    await page.getByTestId(`${action}-ssh-check`).click();
    const error = page.getByTestId(`${action}-ssh-check-error`);
    await expect
      .element(
        error.getByText("The change may have been applied", { exact: true }),
      )
      .toBeVisible();
    expect(currentToasts()).toHaveLength(0);
    expect(error.element().querySelector("details")?.open).toBe(false);
    await error.getByText("Details", { exact: true }).click();
    await expect
      .element(error.getByText("SSH operator diagnostic", { exact: true }))
      .toBeVisible();
    expect(ctx.writes()).toHaveLength(1);
    await expect
      .element(page.getByTestId("pending-node-key"))
      .toHaveValue(AUTH_ID);
  },
);

test.each(["approve", "reject"] as const)(
  "unified feedback: a retired SSH %s owner does not announce in the reopened wizard",
  async (action) => {
    const ctx = await setup();
    await page.getByTestId("add-device-toggle").click();
    await page.getByTestId("add-pending-node").click();
    await page.getByTestId("pending-registration-kind").selectOptions("ssh");
    await page.getByTestId("pending-node-key").fill(AUTH_ID);
    const release = ctx.holdWrites();
    try {
      await page.getByTestId(`${action}-ssh-check`).click();
      await expect.poll(() => ctx.writes().length).toBe(1);
      await ctx.router.navigate({ to: "/routes" });
    } finally {
      release();
    }
    await expect
      .poll(() =>
        ctx.session.feedback.isActionPending(`${action}-auth-request`),
      )
      .toBe(false);
    await ctx.router.navigate({ to: "/devices" });
    await expect
      .element(page.getByTestId("pending-registration-kind"))
      .toHaveValue("ssh");
    await expect.element(page.getByTestId("pending-node-key")).toHaveValue("");
    expect(
      ctx.session.deviceSetup.getSnapshot().pendingRegistrationForm.key,
    ).toBe("");
    await expect
      .element(page.getByTestId("ssh-check-result"))
      .not.toBeInTheDocument();
    expect(currentToasts()).toHaveLength(0);
    expect(ctx.writes()).toHaveLength(1);
  },
);

test("unified feedback: a stale SSH submission reports not sent without a write or a result card", async () => {
  const ctx = await setup();
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("add-pending-node").click();
  await page.getByTestId("pending-registration-kind").selectOptions("ssh");
  await authenticateTestSession(ctx.session, "https://other-fixture.invalid");
  await expect.poll(() => ctx.session.drafts.getSnapshot().stale).toBeTruthy();
  await page.getByTestId("pending-node-key").fill(AUTH_ID);
  await page.getByTestId("approve-ssh-check").click();
  await expect.poll(() => currentToasts().length).toBe(1);
  expect(currentToasts()[0]?.textContent).toContain("Request not sent");
  expect(currentToasts()[0]?.textContent).not.toContain(AUTH_ID);
  await expect
    .element(page.getByTestId("ssh-check-result"))
    .not.toBeInTheDocument();
  expect(ctx.writes()).toEqual([]);
});

// Missing page publication loses the result once the dialog closes; using a cached outcome
// or treating a failed refresh as a failed write gives the wrong tone or encourages replay.
test.each(["rename", "expire", "remove"] as const)(
  "unified feedback: %s publishes one confirmed result after the dialog closes",
  async (action) => {
    const ctx = await setup();
    await openMenu(action === "expire" ? "1" : "2", `${action}-node`);
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
    if (action === "rename")
      await page.getByTestId("rename-node-dialog-input").fill("renamed-device");
    await page.getByTestId(`${action}-node-confirm`).click();
    await expect
      .element(page.getByTestId(`${action}-node-dialog`))
      .not.toBeInTheDocument();
    await expect.poll(() => currentToasts().length).toBe(1);
    expect(currentToasts()[0]?.textContent).toContain("Request confirmed");
    expect(
      currentToasts()[0]
        ?.querySelector('[data-slot="notice"]')
        ?.getAttribute("data-tone"),
    ).toBe("success");
    expect(ctx.writes()).toHaveLength(1);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect.poll(() => currentToasts().length).toBe(0);
    expect(ctx.writes()).toHaveLength(1);
    expect(ctx.session.feedback.actionOutcome(`${action}-node`)).toMatchObject({
      status: "confirmed",
      refresh: "succeeded",
    });
  },
);

test.each(["rename", "expire", "remove"] as const)(
  "unified feedback: confirmed %s with a failed read warns without inviting a second write",
  async (action) => {
    const ctx = await setup();
    await openMenu(action === "expire" ? "1" : "2", `${action}-node`);
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
    if (action === "rename")
      await page.getByTestId("rename-node-dialog-input").fill("renamed-device");
    ctx.failRefresh();
    await page.getByTestId(`${action}-node-confirm`).click();
    await expect
      .element(page.getByTestId(`${action}-node-dialog`))
      .not.toBeInTheDocument();
    await expect.poll(() => currentToasts().length).toBe(1);
    const toast = currentToasts()[0];
    expect(toast?.textContent).toContain("Request confirmed");
    expect(toast?.textContent).toContain(copy.tagRefreshFailed);
    expect(
      toast?.querySelector('[data-slot="notice"]')?.getAttribute("data-tone"),
    ).toBe("warning");
    expect(ctx.session.feedback.actionError(`${action}-node`)).toBe("");
    expect(ctx.session.feedback.actionOutcome(`${action}-node`)).toMatchObject({
      status: "confirmed",
      refresh: "failed",
    });
    expect(ctx.writes()).toHaveLength(1);
  },
);

test("unified feedback: identical success titles belong to two actual rename operations", async () => {
  const ctx = await setup();
  for (const name of ["first-name", "second-name"]) {
    await openMenu("2", "rename-node");
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
    await page.getByTestId("rename-node-dialog-input").fill(name);
    await page.getByTestId("rename-node-confirm").click();
    await expect
      .element(page.getByTestId("rename-node-dialog"))
      .not.toBeInTheDocument();
  }
  await expect.poll(() => currentToasts().length).toBe(2);
  expect(
    currentToasts().every((toast) =>
      toast.textContent?.includes("Request confirmed"),
    ),
  ).toBe(true);
  expect(ctx.writes()).toHaveLength(2);
});

test("unified feedback: an unmounted rename owner cannot publish a late result", async () => {
  const ctx = await setup();
  await openMenu("2", "rename-node");
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  await page.getByTestId("rename-node-dialog-input").fill("late-name");
  const release = ctx.holdWrites();
  try {
    await page.getByTestId("rename-node-confirm").click();
    await expect.poll(() => ctx.writes().length).toBe(1);
    await ctx.router.navigate({ to: "/routes" });
  } finally {
    release();
  }
  await expect
    .poll(() => ctx.session.feedback.isActionPending("rename-node"))
    .toBe(false);
  expect(currentToasts()).toHaveLength(0);
  expect(ctx.writes()).toHaveLength(1);
});

test.each(["rename", "expire", "remove"] as const)(
  "unified feedback: an uncertain %s keeps one persistent warning and expandable diagnostics",
  async (action) => {
    const ctx = await setup();
    await openMenu(action === "expire" ? "1" : "2", `${action}-node`);
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
    if (action === "rename")
      await page.getByTestId("rename-node-dialog-input").fill("uncertain-name");
    ctx.fail("backend diagnostic for the operator");
    await page.getByTestId(`${action}-node-confirm`).click();
    const error = page.getByTestId(`${action}-node-error`);
    await expect.element(error).toBeVisible();
    await expect
      .element(
        error.getByText("The change may have been applied", { exact: true }),
      )
      .toBeVisible();
    expect(currentToasts()).toHaveLength(0);
    const details = error.element().querySelector("details");
    expect(details?.open).toBe(false);
    const summary = error.getByText("Details", { exact: true });
    (summary.element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    await expect
      .element(
        error.getByText("backend diagnostic for the operator", { exact: true }),
      )
      .toBeVisible();
    expect(ctx.writes()).toHaveLength(1);
    const outcome = structuredClone(
      ctx.session.feedback.actionOutcome(`${action}-node`),
    );
    await page.getByTestId(`${action}-node-verify`).click();
    await expect
      .element(page.getByTestId(`${action}-node-dialog`))
      .not.toBeInTheDocument();
    expect(ctx.router.state.location.pathname).toBe("/devices");
    expect(ctx.session.feedback.actionOutcome(`${action}-node`)).toEqual(
      outcome,
    );
    expect(ctx.writes()).toHaveLength(1);
  },
);

test.each([
  ["refresh-machines", "Refresh data"],
  ["export-machines", "Export data"],
] as const)(
  "unified feedback: %s short help opens with Tab and closes with Escape",
  async (id, label) => {
    await setup();
    const button = page.getByTestId(id);
    for (
      let step = 0;
      step < 20 && document.activeElement !== button.element();
      ++step
    )
      await userEvent.tab();
    await expect.element(button).toHaveFocus();
    await expect.element(page.getByText(label, { exact: true })).toBeVisible();
    expect(button.element().querySelector("button")).toBeNull();
    await userEvent.keyboard("{Escape}");
    await expect
      .element(page.getByText(label, { exact: true }))
      .not.toBeInTheDocument();
    await expect.element(button).toHaveFocus();
  },
);

test.each([
  ["setup-tags-search", "  tag:web,  tag:db  ", "  tag:web,  tag:db  "],
  [
    "pending-node-key",
    `  https://fixture.invalid/register/${AUTH_ID}  `,
    `https://fixture.invalid/register/${AUTH_ID}`,
  ],
  [
    "setup-login-server",
    "  https://login.example.com/path/  ",
    "https://login.example.com/path/",
  ],
  ["rename-node-dialog-input", "  New-Host-1  ", "New-Host-1"],
  ["node-tags-search", "  tag:web,  tag:db  ", "  tag:web,  tag:db  "],
])(
  "keeps %s independent of submitting, normalizing fields but not search queries",
  async (id, raw, expected) => {
    const ctx = await setup();
    if (id === "setup-tags-search") await openWizard("server");
    else if (id === "pending-node-key") {
      await page.getByTestId("add-device-toggle").click();
      await page.getByTestId("add-pending-node").click();
    } else if (id === "setup-login-server") await generateKey();
    else
      await openMenu(
        "2",
        id === "node-tags-search" ? "edit-node-tags" : "rename-node",
      );
    const writesBefore = ctx.writes().length;
    const input = page.getByTestId(id);
    await input.fill(raw);
    await userEvent.tab();
    await expect.element(input).toHaveValue(expected);
    expect(ctx.writes()).toHaveLength(writesBefore);
    if (id === "pending-node-key")
      expect(
        ctx.session.deviceSetup.getSnapshot().pendingRegistrationForm.key,
      ).toBe(expected);
    if (id === "setup-login-server")
      expect(ctx.session.deviceSetup.getSnapshot().loginServer).toBe(expected);
  },
);

test("tag search Enter does not advance; explicit choices and expiry Enter preserve the payload", async () => {
  const ctx = await setup();
  await openWizard("server");
  await page.getByTestId("setup-tags-search").fill("  tag:web  ");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("setup-device-step")).toBeVisible();
  expect(ctx.writes()).toEqual([]);
  await chooseTags("setup-tags", ["  tag:web  ", "  tag:db  "]);
  await page.getByTestId("add-device-next").click();
  await expect.element(page.getByTestId("setup-auth-key-step")).toBeVisible();
  await page.getByTestId("setup-expiration").fill(" 12days ");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("setup-generate-step")).toBeVisible();
  expect(ctx.session.deviceSetup.getSnapshot().authKeyExpiryDays).toBe(12);
  await page.getByTestId("generate-install-script").click();
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  expect(keyWrites(ctx)[0]?.body.aclTags).toEqual(["tag:web", "tag:db"]);
  expectDays(keyWrites(ctx)[0]?.body.expiration, 12);
});

test.each(["device", "ssh"] as const)(
  "Enter submits the normalized %s request once while busy",
  async (kind) => {
    const ctx = await setup();
    await page.getByTestId("add-device-toggle").click();
    await page.getByTestId("add-pending-node").click();
    await page.getByTestId("pending-registration-kind").selectOptions(kind);
    const key = page.getByTestId("pending-node-key");
    const link = `https://fixture.invalid/${kind === "device" ? "register" : "auth"}/${AUTH_ID}`;
    await key.fill(`  ${link}  `);
    if (kind === "device") await trustRegistration();
    await key.click();
    const release = ctx.holdWrites();
    try {
      await userEvent.keyboard("{Enter}{Enter}");
      await expect.poll(() => ctx.writes().length).toBe(1);
      await expect.element(key).toHaveValue(kind === "device" ? "" : link);
      expect(
        ctx.session.deviceSetup.getSnapshot().pendingRegistrationForm.key,
      ).toBe(kind === "device" ? "" : link);
      expect(ctx.writes()[0]).toMatchObject({
        method: "POST",
        path:
          kind === "device" ? "/api/v1/auth/register" : "/api/v1/auth/approve",
        body:
          kind === "device"
            ? { authId: AUTH_ID, user: "alice" }
            : { authId: AUTH_ID },
      });
      await expect
        .element(
          page.getByTestId(
            kind === "device" ? "register-pending-node" : "approve-ssh-check",
          ),
        )
        .toBeDisabled();
      await userEvent.keyboard("{Escape}");
      expect(isOpen("add-device-dialog")).toBe(true);
    } finally {
      release();
    }
    await expect
      .element(
        page.getByTestId(
          kind === "device" ? "registration-result" : "ssh-check-result",
        ),
      )
      .toBeVisible();
    expect(
      ctx.session.deviceSetup.getSnapshot().pendingRegistrationForm.key,
    ).toBe("");
  },
);

test("SSH reject keeps its own submit intent and normalized draft when the server refuses it", async () => {
  const ctx = await setup();
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("add-pending-node").click();
  await page.getByTestId("pending-registration-kind").selectOptions("ssh");
  await page.getByTestId("pending-node-key").fill(`  ${AUTH_ID}  `);
  ctx.fail("Request denied");
  await page.getByTestId("reject-ssh-check").click();
  await expect
    .element(page.getByTestId("reject-ssh-check-error"))
    .toMatchTextContent("Request denied");
  await expect
    .element(page.getByTestId("pending-node-key"))
    .toHaveValue(AUTH_ID);
  expect(
    ctx.session.deviceSetup.getSnapshot().pendingRegistrationForm.key,
  ).toBe(AUTH_ID);
  expect(ctx.writes()).toEqual([
    { method: "POST", path: "/api/v1/auth/reject", body: { authId: AUTH_ID } },
  ]);
  expect(ctx.nodeReads()).toEqual([]);
});

test("editing the login URL with Enter normalizes the stored value without minting another key", async () => {
  const ctx = await setup();
  await generateKey();
  const input = page.getByTestId("setup-login-server");
  await input.fill("  https://login.example.com/  ");
  await userEvent.keyboard("{Enter}");
  await expect.element(input).toHaveValue("https://login.example.com/");
  expect(ctx.session.deviceSetup.getSnapshot().loginServer).toBe(
    "https://login.example.com/",
  );
  expect(keyWrites(ctx)).toHaveLength(1);
  await expect
    .element(page.getByTestId("created-invite"))
    .toMatchTextContent("--login-server 'https://login.example.com'");
});

test("a late opening refresh cannot overwrite a normalized rename draft", async () => {
  const ctx = await setup();
  const release = ctx.holdReads();
  try {
    await openMenu("2", "rename-node");
    await page.getByTestId("rename-node-dialog-input").fill("  edited-name  ");
    await userEvent.tab();
    const node = ctx.backend.nodes.find((candidate) => candidate.id === "2");
    expect.assert(node);
    node.givenName = "server-refresh";
  } finally {
    release();
  }
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  await expect
    .element(page.getByTestId("rename-node-dialog-input"))
    .toHaveValue("edited-name");
  expect(ctx.writes()).toEqual([]);
  await page.getByTestId("rename-node-dialog-input").click();
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByTestId("rename-node-dialog"))
    .not.toBeInTheDocument();
  expect(ctx.writes()).toEqual([
    { method: "POST", path: "/api/v1/node/2/rename/edited-name", body: {} },
  ]);
});

test("a blocked native tags submission still adopts the opening refresh without losing server tags", async () => {
  const ctx = await setup();
  const release = ctx.holdReads();
  try {
    await openMenu("1", "edit-node-tags");
    const input = page.getByTestId("node-tags-search");
    await expect.element(input).toBeDisabled();
    await expect.element(page.getByTestId("node-tags-confirm")).toBeDisabled();
    (
      page.getByTestId("node-tags-form").element() as HTMLFormElement
    ).requestSubmit();
    await userEvent.tab();
    expect(ctx.writes()).toEqual([]);
    const node = ctx.backend.nodes.find((candidate) => candidate.id === "1");
    expect.assert(node);
    node.tags = ["tag:server", "tag:remote"];
  } finally {
    release();
  }
  await expect
    .element(page.getByTestId("node-tags-remove-tag:remote"))
    .toBeVisible();
  await page.getByTestId("node-tags-option-tag:web").click();
  await confirmTags();
  await expect.element(page.getByTestId("node-tags-result")).toBeVisible();
  expect(ctx.writes()).toEqual([
    {
      method: "POST",
      path: "/api/v1/node/1/tags",
      body: { tags: ["tag:server", "tag:remote", "tag:web"] },
    },
  ]);
});

test("native submission of an unchanged machine name cannot send a redundant write", async () => {
  const ctx = await setup();
  await openMenu("2", "rename-node");
  await expect
    .element(page.getByTestId("rename-node-dialog-input"))
    .toHaveValue("laptop");
  await expect.element(page.getByTestId("rename-node-confirm")).toBeDisabled();
  (
    page.getByTestId("rename-node-form").element() as HTMLFormElement
  ).requestSubmit();
  await userEvent.tab();
  expect(ctx.writes()).toEqual([]);
  await expect.element(page.getByTestId("rename-node-dialog")).toBeVisible();
  await page.getByTestId("rename-node-dialog-input").fill("  updated-name  ");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByTestId("rename-node-dialog"))
    .not.toBeInTheDocument();
  expect(ctx.writes()).toEqual([
    { method: "POST", path: "/api/v1/node/2/rename/updated-name", body: {} },
  ]);
});

test.each(["rename", "tags"] as const)(
  "an external %s write keeps the draft open and blocks native resubmission until settled",
  async (kind) => {
    const ctx = await setup();
    const prefix = kind === "rename" ? "rename-node" : "node-tags";
    const input = page.getByTestId(
      kind === "rename" ? "rename-node-dialog-input" : "node-tags-search",
    );
    await openMenu("1", kind === "rename" ? "rename-node" : "edit-node-tags");
    const draft = kind === "rename" ? "local-name" : "tag:local";
    if (kind === "rename") await input.fill(draft);
    else {
      await chooseTags("node-tags", [draft]);
      await input.fill(draft);
    }
    const release = ctx.holdWrites();
    const external = createMutation(ctx.session).mutate(
      kind === "rename" ? "rename-node" : "node-tags",
      kind === "rename"
        ? {
            endpoint: "renameNode",
            input: { nodeId: "1", newName: "external-name" },
          }
        : {
            endpoint: "setTags",
            input: { nodeId: "1", tags: ["tag:external"] },
          },
    );
    try {
      await expect.poll(() => ctx.writes().length).toBe(1);
      if (kind === "rename")
        await expect.element(input).toHaveAttribute("readonly");
      else await expect.element(input).toBeDisabled();
      await expect
        .element(page.getByTestId(`${prefix}-confirm`))
        .toHaveAttribute("aria-busy", "true");
      await expect.element(page.getByTestId(`${prefix}-cancel`)).toBeDisabled();
      (
        page.getByTestId(`${prefix}-form`).element() as HTMLFormElement
      ).requestSubmit();
      await userEvent.tab();
      await userEvent.keyboard("{Escape}");
      expect(isOpen(`${prefix}-dialog`)).toBe(true);
      await expect.element(input).toHaveValue(draft);
      expect(ctx.writes()).toHaveLength(1);
    } finally {
      release();
      await external;
    }
    if (kind === "rename")
      await expect.element(input).not.toHaveAttribute("readonly");
    else await expect.element(input).toBeEnabled();
    await expect.element(input).toHaveValue(draft);
    await page.getByTestId(`${prefix}-cancel`).click();
    await expect
      .element(page.getByTestId(`${prefix}-dialog`))
      .not.toBeInTheDocument();
    expect(ctx.writes()).toEqual([
      kind === "rename"
        ? {
            method: "POST",
            path: "/api/v1/node/1/rename/external-name",
            body: {},
          }
        : {
            method: "POST",
            path: "/api/v1/node/1/tags",
            body: { tags: ["tag:external"] },
          },
    ]);
  },
);

test.each(["rename", "tags"] as const)(
  "a held %s form submission rejects Escape and duplicate native submits",
  async (kind) => {
    const ctx = await setup();
    const prefix = kind === "rename" ? "rename-node" : "node-tags";
    await openMenu("1", kind === "rename" ? "rename-node" : "edit-node-tags");
    const input = page.getByTestId(
      kind === "rename" ? "rename-node-dialog-input" : "node-tags-search",
    );
    if (kind === "rename") await input.fill("  once-only  ");
    else {
      await chooseTags("node-tags", ["tag:once"]);
      await page.getByTestId("node-tags-confirm").click();
    }
    const form = page
      .getByTestId(`${prefix}-form`)
      .element() as HTMLFormElement;
    const release = ctx.holdWrites();
    try {
      if (kind === "rename") await userEvent.keyboard("{Enter}");
      else await page.getByTestId("node-tags-apply").click();
      await expect.poll(() => ctx.writes().length).toBe(1);
      form.requestSubmit();
      form.requestSubmit();
      await userEvent.keyboard("{Escape}");
      expect(isOpen(`${prefix}-dialog`)).toBe(true);
      if (kind === "rename")
        await expect.element(input).toHaveAttribute("readonly");
      else await expect.element(input).toBeDisabled();
      await expect
        .element(page.getByTestId(`${prefix}-confirm`))
        .toBeDisabled();
      await expect.element(page.getByTestId(`${prefix}-cancel`)).toBeDisabled();
      expect(ctx.writes()).toHaveLength(1);
    } finally {
      release();
    }
    if (kind === "rename")
      await expect
        .element(page.getByTestId(`${prefix}-dialog`))
        .not.toBeInTheDocument();
    else
      await expect.element(page.getByTestId("node-tags-result")).toBeVisible();
    expect(ctx.writes()).toEqual([
      kind === "rename"
        ? { method: "POST", path: "/api/v1/node/1/rename/once-only", body: {} }
        : {
            method: "POST",
            path: "/api/v1/node/1/tags",
            body: { tags: ["tag:once"] },
          },
    ]);
  },
);

test.each(["type", "preferences"] as const)(
  "an external key creation prevents %s navigation from resetting or advancing the wizard",
  async (step) => {
    const ctx = await setup();
    if (step === "type") await page.getByTestId("add-device-toggle").click();
    else {
      await openWizard("server");
      await chooseTags("setup-tags", ["tag:local"]);
    }
    const release = ctx.holdWrites();
    const external = createMutation(ctx.session).mutate("create-invite", {
      endpoint: "createPreAuthKey",
      input: {
        user: "1",
        reusable: false,
        ephemeral: false,
        aclTags: [],
        expiration: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      },
    });
    try {
      await expect.poll(() => keyWrites(ctx).length).toBe(1);
      if (step === "type") {
        await page.getByTestId("add-linux-device").click();
        await page.getByTestId("add-pending-node").click();
        await expect
          .element(page.getByTestId("add-device-options"))
          .toBeVisible();
        expect(ctx.session.deviceSetup.getSnapshot().task).toBeNull();
      } else {
        await expect
          .element(page.getByTestId("add-device-next"))
          .toBeDisabled();
        (
          page.getByTestId("setup-device-step").element() as HTMLFormElement
        ).requestSubmit();
        await userEvent.tab();
        await expect
          .element(page.getByTestId("setup-device-step"))
          .toBeVisible();
        await expect
          .element(page.getByTestId("setup-tags-remove-tag:local"))
          .toBeVisible();
      }
      expect(keyWrites(ctx)).toHaveLength(1);
    } finally {
      release();
      await external;
    }
    if (step === "type") await page.getByTestId("add-client-device").click();
    await page.getByTestId("add-device-next").click();
    await expect.element(page.getByTestId("setup-auth-key-step")).toBeVisible();
    expect(keyWrites(ctx)).toHaveLength(1);
  },
);

test("a pending external SSH decision blocks native approval without consuming the draft", async () => {
  const ctx = await setup();
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("add-pending-node").click();
  await page.getByTestId("pending-registration-kind").selectOptions("ssh");
  await page.getByTestId("pending-node-key").fill(AUTH_ID);
  const release = ctx.holdWrites();
  const external = createMutation(ctx.session, { skipRefresh: true }).mutate(
    "reject-auth-request",
    {
      endpoint: "authReject",
      input: { authId: AUTH_ID },
    },
  );
  try {
    await expect.poll(() => ctx.writes().length).toBe(1);
    await expect
      .element(page.getByTestId("pending-node-key"))
      .toHaveAttribute("readonly");
    (
      page.getByTestId("pending-registration-flow").element() as HTMLFormElement
    ).requestSubmit();
    await userEvent.tab();
    await expect
      .element(page.getByTestId("pending-node-key"))
      .toHaveValue(AUTH_ID);
    await expect
      .element(page.getByTestId("ssh-check-result"))
      .not.toBeInTheDocument();
    expect(ctx.writes()).toEqual([
      {
        method: "POST",
        path: "/api/v1/auth/reject",
        body: { authId: AUTH_ID },
      },
    ]);
  } finally {
    release();
    await external;
  }
  await page.getByTestId("approve-ssh-check").click();
  await expect
    .element(page.getByTestId("ssh-check-result"))
    .toHaveTextContent(copy.sshCheckApproved);
  expect(ctx.writes()).toEqual([
    { method: "POST", path: "/api/v1/auth/reject", body: { authId: AUTH_ID } },
    { method: "POST", path: "/api/v1/auth/approve", body: { authId: AUTH_ID } },
  ]);
  expect(ctx.nodeReads()).toEqual([]);
});

test("registration without an eligible owner fails native validation while SSH remains ownerless", async () => {
  const ctx = await setup("", (backend) => {
    backend.users = [{ id: "0", name: "tagged-devices" }];
  });
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("add-pending-node").click();
  await page.getByTestId("pending-node-key").fill(AUTH_ID);
  await expect
    .element(page.getByTestId("register-pending-node"))
    .toBeDisabled();
  (
    page.getByTestId("pending-registration-flow").element() as HTMLFormElement
  ).requestSubmit();
  await expect
    .element(page.getByTestId("pending-registration-user-error"))
    .toHaveTextContent(copy.noUsers);
  await expect
    .element(page.getByTestId("pending-registration-user"))
    .toHaveAttribute("aria-invalid", "true");
  expect(ctx.writes()).toEqual([]);
  await page.getByTestId("pending-registration-kind").selectOptions("ssh");
  await page.getByTestId("approve-ssh-check").click();
  await expect
    .element(page.getByTestId("ssh-check-result"))
    .toHaveTextContent(copy.sshCheckApproved);
  expect(ctx.writes()).toEqual([
    { method: "POST", path: "/api/v1/auth/approve", body: { authId: AUTH_ID } },
  ]);
});

test("login URL native validation has one accessible error and recovers without generating another key", async () => {
  const ctx = await setup();
  await generateKey();
  const input = page.getByTestId("setup-login-server");
  await input.fill("ftp://login.example.com/");
  await userEvent.keyboard("{Enter}");
  await expect.element(input).toHaveAttribute("aria-invalid", "true");
  await expect
    .element(input)
    .toHaveAttribute("aria-describedby", "setup-login-server-error");
  await expect
    .element(page.getByTestId("setup-login-server-error"))
    .toHaveTextContent(t("connectionInvalidUrl"));
  expect(
    document.querySelectorAll('[data-testid="setup-login-server-error"]'),
  ).toHaveLength(1);
  expect(document.getElementById("setup-login-server-hint")).toBeNull();
  await expect
    .element(page.getByTestId("copy-setup-install-command"))
    .not.toBeInTheDocument();
  expect(keyWrites(ctx)).toHaveLength(1);
  await input.fill("  https://login.example.com/  ");
  await expect
    .element(page.getByTestId("setup-login-server-error"))
    .not.toBeInTheDocument();
  await userEvent.keyboard("{Enter}");
  await expect.element(input).toHaveValue("https://login.example.com/");
  await expect.element(input).toHaveAttribute("aria-invalid", "false");
  await expect
    .element(page.getByTestId("copy-setup-install-command"))
    .toBeVisible();
  expect(keyWrites(ctx)).toHaveLength(1);
});

test("an external login-server change updates the touched field and generated command", async () => {
  const ctx = await setup();
  await generateKey();
  const input = page.getByTestId("setup-login-server");
  const defaultUrl = (input.element() as HTMLInputElement).value;
  await input.fill("https://draft.example.com/");
  await userEvent.tab();
  ctx.session.deviceSetup.setState({
    loginServer: "https://updated.example.com/",
  });
  await expect.element(input).toHaveValue("https://updated.example.com/");
  await expect
    .element(page.getByTestId("created-invite"))
    .toMatchTextContent("--login-server 'https://updated.example.com'");
  ctx.session.deviceSetup.setState({ loginServer: null });
  await expect.element(input).toHaveValue(defaultUrl);
  expect(ctx.session.deviceSetup.getSnapshot().loginServer).toBeNull();
  expect(keyWrites(ctx)).toHaveLength(1);
});

test("returning to a registration result does not register the same request again", async () => {
  const ctx = await setup();
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("add-pending-node").click();
  await page.getByTestId("pending-node-key").fill(AUTH_ID);
  await trustRegistration();
  await page.getByTestId("register-pending-node").click();
  await expect
    .element(page.getByTestId("registration-result"))
    .toMatchTextContent("registered");
  await page.getByTestId("add-device-prev").click();
  await expect.element(page.getByTestId("pending-node-key")).toHaveValue("");
  await expect
    .element(page.getByTestId("register-pending-node"))
    .toBeDisabled();
  await page.getByTestId("add-device-next").click();
  await expect
    .element(page.getByTestId("registration-result"))
    .toMatchTextContent("registered");
  expect(ctx.writes()).toEqual([
    {
      method: "POST",
      path: "/api/v1/auth/register",
      body: { authId: AUTH_ID, user: "alice" },
    },
  ]);
});

test("after a failed SSH decision the wrong-domain link is reported by the field, not duplicated as a hint", async () => {
  const ctx = await setup();
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("add-pending-node").click();
  await page.getByTestId("pending-registration-kind").selectOptions("ssh");
  await page.getByTestId("pending-node-key").fill(AUTH_ID);
  ctx.fail("Unknown SSH request");
  await page.getByTestId("approve-ssh-check").click();
  await expect
    .element(page.getByTestId("approve-ssh-check-error"))
    .toMatchTextContent("Unknown SSH request");
  await page
    .getByTestId("pending-node-key")
    .fill(`https://fixture.invalid/register/${AUTH_ID}`);
  await expect
    .element(page.getByTestId("pending-node-key-error"))
    .toHaveTextContent(copy.authRequestIsRegistration);
  await expect
    .element(page.getByTestId("pending-node-key"))
    .toHaveAttribute("aria-describedby", "pending-node-key-error");
  await expect
    .element(page.getByTestId("pending-node-key-hint"))
    .not.toBeInTheDocument();
  await expect.element(page.getByTestId("approve-ssh-check")).toBeDisabled();
  await expect.element(page.getByTestId("reject-ssh-check")).toBeDisabled();
  (
    page.getByTestId("pending-registration-flow").element() as HTMLFormElement
  ).requestSubmit();
  await userEvent.tab();
  expect(ctx.writes()).toEqual([
    { method: "POST", path: "/api/v1/auth/approve", body: { authId: AUTH_ID } },
  ]);
});

test("external pending-request updates reach the form without restoring an old key or submit kind", async () => {
  const ctx = await setup();
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("add-pending-node").click();
  await page.getByTestId("pending-node-key").fill("old request");
  ctx.session.deviceSetup.setState({
    pendingRegistrationForm: {
      kind: "ssh",
      user: "bob",
      key: `  ${AUTH_ID}  `,
    },
  });
  await expect
    .element(page.getByTestId("pending-registration-kind"))
    .toHaveValue("ssh");
  await expect
    .element(page.getByTestId("pending-node-key"))
    .toHaveValue(`  ${AUTH_ID}  `);
  await page.getByTestId("reject-ssh-check").click();
  await expect
    .element(page.getByTestId("ssh-check-result"))
    .toMatchTextContent(copy.sshCheckRejected);
  expect(ctx.writes()).toEqual([
    { method: "POST", path: "/api/v1/auth/reject", body: { authId: AUTH_ID } },
  ]);
  expect(ctx.session.deviceSetup.getSnapshot().pendingRegistrationForm).toEqual(
    {
      kind: "ssh",
      user: "bob",
      key: "",
    },
  );
});

test.each(["rename", "tags", "pending", "setup"] as const)(
  "a retained %s draft cannot write after switching sessions",
  async (kind) => {
    const ctx = await setup();
    if (kind === "rename") {
      await openMenu("2", "rename-node");
      await page.getByTestId("rename-node-dialog-input").fill("edited-name");
    } else if (kind === "tags") {
      await openMenu("1", "edit-node-tags");
      await chooseTags("node-tags", ["tag:web"]);
    } else if (kind === "setup") {
      await openWizard("server");
      await chooseTags("setup-tags", ["tag:server-draft"]);
      await page.getByTestId("add-device-next").click();
      await page.getByTestId("setup-reusable").click();
    } else {
      await page.getByTestId("add-device-toggle").click();
      await page.getByTestId("add-pending-node").click();
      await page.getByTestId("pending-node-key").fill(AUTH_ID);
    }
    await authenticateTestSession(ctx.session, "https://other-fixture.invalid");
    await expect
      .poll(() => ctx.session.drafts.getSnapshot().stale)
      .toBeTruthy();
    if (kind === "setup") {
      await page.getByTestId("add-device-prev").click();
      await expect
        .element(page.getByTestId("setup-tags-remove-tag:server-draft"))
        .toBeVisible();
      await page.getByTestId("add-device-next").click();
      await page.getByTestId("add-device-next").click();
      await expect
        .element(page.getByTestId("setup-generate-step"))
        .not.toMatchTextContent(copy.reusable);
    }
    if (kind === "pending") {
      await expect
        .element(page.getByTestId("pending-node-key"))
        .toHaveValue("");
      await expect
        .element(page.getByTestId("register-pending-node"))
        .toBeDisabled();
      (
        page
          .getByTestId("pending-registration-flow")
          .element() as HTMLFormElement
      ).requestSubmit();
      await expect
        .element(page.getByTestId("pending-node-key-error"))
        .toHaveTextContent(copy.authRequestInvalid);
      expect(ctx.writes()).toEqual([]);
      await page.getByTestId("pending-node-key").fill(AUTH_ID);
    }
    const action = {
      rename: "rename-node-confirm",
      tags: "node-tags-confirm",
      pending: "register-pending-node",
      setup: "generate-install-script",
    }[kind];
    if (kind === "tags" || kind === "pending") {
      await expect.element(page.getByTestId(action)).toBeDisabled();
      expect(ctx.writes()).toEqual([]);
      return;
    }
    if (kind === "setup") {
      await expect.element(page.getByTestId(action)).toBeDisabled();
      (page.getByTestId(action).element() as HTMLButtonElement).click();
    } else await page.getByTestId(action).click();
    const error = {
      rename: "rename-node-error",
      tags: "node-tags-error",
      pending: "register-pending-node-error",
      setup: "setup-generate-error",
    }[kind];
    await expect.element(page.getByTestId(error)).toBeVisible();
    expect(ctx.writes()).toEqual([]);
  },
);

// Fix 1/6: a client device must survive going offline, and the key is created in the wizard itself.
test("the client preset creates a non-ephemeral single-use key directly from the wizard", async () => {
  const ctx = await setup();
  await openWizard("client");
  await expect
    .element(page.getByTestId("setup-ephemeral"))
    .toHaveAttribute("aria-checked", "false");
  await page.getByTestId("add-device-next").click();
  await expect
    .element(page.getByTestId("setup-reusable"))
    .toHaveAttribute("aria-checked", "false");
  await expect.element(page.getByTestId("setup-owner")).toHaveValue("1");
  await page.getByTestId("add-device-next").click();
  await expect
    .element(page.getByTestId("generate-install-script"))
    .toHaveTextContent(copy.generateInstallCommand);
  await page.getByTestId("generate-install-script").click();
  await expect
    .element(page.getByTestId("created-invite"))
    .toMatchTextContent("created-key");
  expect(
    document.querySelector('[data-testid="invite-create-dialog"]'),
  ).toBeNull();
  const [write] = keyWrites(ctx);
  expect(write?.body).toMatchObject({
    user: "1",
    reusable: false,
    ephemeral: false,
    aclTags: [],
  });
  expectDays(write?.body.expiration, 7);
});

test("the server preset creates a reusable tag:server key for the chosen owner", async () => {
  const ctx = await setup();
  await openWizard("server");
  await expect
    .element(page.getByTestId("setup-tags-remove-tag:server"))
    .toBeVisible();
  await page.getByTestId("add-device-next").click();
  await expect
    .element(page.getByTestId("setup-reusable"))
    .toHaveAttribute("aria-checked", "true");
  await page.getByTestId("setup-owner").selectOptions("2");
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("generate-install-script").click();
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  expect(keyWrites(ctx)[0]?.body).toMatchObject({
    user: "2",
    reusable: true,
    ephemeral: false,
    aclTags: ["tag:server"],
  });
});

test("wizard switches and the day stepper reach the key payload and exit-node command", async () => {
  const ctx = await setup();
  await openWizard("client");
  await page.getByTestId("setup-tags-enabled").click();
  await page.getByTestId("setup-ephemeral").click();
  await page.getByTestId("setup-exit-node").click();
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("setup-owner").selectOptions("");
  await page.getByTestId("setup-reusable").click();
  await page.getByTestId("setup-expiration").fill("0");
  await page.getByTestId("setup-expiration-increment").click();
  await expect.element(page.getByTestId("setup-expiration")).toHaveValue("2");
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("generate-install-script").click();
  await expect
    .element(page.getByTestId("created-invite"))
    .toMatchTextContent("--advertise-exit-node");
  const body = keyWrites(ctx)[0]?.body;
  expect(body).toMatchObject({
    reusable: true,
    ephemeral: true,
    aclTags: ["tag:server"],
  });
  expect(body).not.toHaveProperty("user");
  expectDays(body?.expiration, 2);
});

// Fix 6: an owner-less key needs tags, and tags are checked before they reach the server.
test("the wizard requires tags for an owner-less key and rejects malformed tags", async () => {
  const ctx = await setup();
  await openWizard("client");
  await page.getByTestId("setup-tags-search").fill("tag:web db");
  await expect.element(page.getByTestId("setup-tags-add")).toBeDisabled();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("setup-device-step")).toBeVisible();
  expect(ctx.writes()).toEqual([]);
  await page.getByTestId("setup-tags-clear").click();
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("setup-owner").selectOptions("");
  await expect.element(page.getByTestId("add-device-next")).toBeDisabled();
  (
    page.getByTestId("setup-auth-key-step").element() as HTMLFormElement
  ).requestSubmit();
  await expect
    .element(page.getByTestId("setup-owner-error"))
    .toHaveTextContent(copy.inviteTagsRequired);
  await expect.element(page.getByTestId("setup-auth-key-step")).toBeVisible();
  await page.getByTestId("add-device-prev").click();
  await chooseTags("setup-tags", ["tag:server", "tag:web"]);
  await page.getByTestId("add-device-next").click();
  await expect
    .element(page.getByTestId("setup-owner-error"))
    .not.toBeInTheDocument();
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("generate-install-script").click();
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  const body = keyWrites(ctx)[0]?.body;
  expect(body).toMatchObject({ aclTags: ["tag:server", "tag:web"] });
  expect(body).not.toHaveProperty("user");
});

test("a rejected key shows the error in the wizard and a held key disables Generate", async () => {
  const ctx = await setup();
  await toGenerateStep("client");
  ctx.fail("Key denied");
  await page.getByTestId("generate-install-script").click();
  await expect
    .element(page.getByTestId("setup-generate-error"))
    .toMatchTextContent("Key denied");
  await expect
    .element(page.getByTestId("created-invite"))
    .not.toBeInTheDocument();
  ctx.fail("");
  await expect
    .element(page.getByTestId("generate-install-script"))
    .toBeEnabled();
  await expect
    .element(page.getByTestId("invite-create-new-operation"))
    .not.toBeInTheDocument();
  const release = ctx.holdWrites();
  await page.getByTestId("generate-install-script").click();
  await expect
    .element(page.getByTestId("generate-install-script"))
    .toBeDisabled();
  await expect
    .element(page.getByTestId("setup-generate-error"))
    .not.toBeInTheDocument();
  release();
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  expect(keyWrites(ctx)).toHaveLength(2);
});

test("a held Generate locks historical steps for mouse and keyboard and preserves the submitted summary", async () => {
  const ctx = await setup();
  await toGenerateStep("server");
  const release = ctx.holdWrites();
  try {
    await page.getByTestId("generate-install-script").click();
    await expect.poll(() => keyWrites(ctx).length).toBe(1);
    for (const id of ["preferences", "authKey"]) {
      const step = page.getByTestId(`add-device-step-${id}`);
      await expect.element(step).toBeDisabled();
      (step.element() as HTMLButtonElement).click();
      (step.element() as HTMLButtonElement).focus();
      await userEvent.keyboard("{Enter}");
    }
    // A delayed activation of the page opener must not reset an in-flight wizard either.
    (
      page.getByTestId("add-device-toggle").element() as HTMLButtonElement
    ).click();
    await expect.element(page.getByTestId("setup-generate-step")).toBeVisible();
    await expect.element(page.getByTestId("add-device-prev")).toBeDisabled();
    await expect.element(page.getByTestId("add-device-finish")).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    expect(isOpen("add-device-dialog")).toBe(true);
    expect(keyWrites(ctx)).toHaveLength(1);
  } finally {
    release();
  }
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  await expect
    .element(page.getByTestId("setup-generate-step"))
    .toMatchTextContent("tag:server");
  await expect
    .element(page.getByTestId("setup-generate-step"))
    .toMatchTextContent(copy.reusable);
  expect(keyWrites(ctx)[0]?.body).toMatchObject({
    user: "1",
    aclTags: ["tag:server"],
    reusable: true,
    ephemeral: false,
  });
});

test("opening a new wizard asks before discarding a key shared from Auth keys", async () => {
  const ctx = await setup();
  ctx.session.deviceSetup.setState({ lastCreatedInvite: "previous-key" });
  await page.getByTestId("add-device-toggle").click();
  await expect.element(page.getByTestId("discard-key-dialog")).toBeVisible();
  expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe(
    "previous-key",
  );
  await page.getByTestId("discard-key-cancel").click();
  expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe(
    "previous-key",
  );
  await expect
    .element(page.getByTestId("add-device-dialog"))
    .not.toBeInTheDocument();
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("discard-key-confirm").click();
  await expect.element(page.getByTestId("add-device-options")).toBeVisible();
  expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe("");
  await userEvent.keyboard("{Escape}");
  expect(ctx.writes()).toEqual([]);
});

test("a second discard confirmation in the same turn does not open the wizard twice", async () => {
  const ctx = await setup();
  ctx.session.deviceSetup.setState({ lastCreatedInvite: "previous-key" });
  await page.getByTestId("add-device-toggle").click();
  await expect.element(page.getByTestId("discard-key-dialog")).toBeVisible();
  const confirm = page
    .getByTestId("discard-key-confirm")
    .element() as HTMLButtonElement;
  confirm.click();
  confirm.click();
  await expect.element(page.getByTestId("add-device-options")).toBeVisible();
  expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe("");
  expect(ctx.writes()).toEqual([]);
});

test("a late confirm activation during discard-dialog dismissal keeps the saved key", async () => {
  const ctx = await setup();
  ctx.session.deviceSetup.setState({ lastCreatedInvite: "previous-key" });
  await page.getByTestId("add-device-toggle").click();
  const confirm = page
    .getByTestId("discard-key-confirm")
    .element() as HTMLButtonElement;
  await page.getByTestId("discard-key-cancel").click();
  confirm.click();
  await expect
    .element(page.getByTestId("discard-key-dialog"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("add-device-dialog"))
    .not.toBeInTheDocument();
  expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe(
    "previous-key",
  );
  expect(ctx.writes()).toEqual([]);
});

test("the wizard rejects uppercase tags before navigation or a key write", async () => {
  const ctx = await setup();
  await openWizard("server");
  await page.getByTestId("setup-tags-search").fill("tag:Server");
  await expect.element(page.getByTestId("setup-tags-add")).toBeDisabled();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("setup-device-step")).toBeVisible();
  await expect
    .element(page.getByTestId("setup-tags-remove-tag:server"))
    .toBeVisible();
  expect(keyWrites(ctx)).toEqual([]);
});

test("SetTags never accepts malformed free text or an empty collection through native submission", async () => {
  const ctx = await setup();
  await openMenu("2", "edit-node-tags");
  for (const query of ["", "  ", ", ,\t", "tag:Server"]) {
    await page.getByTestId("node-tags-search").fill(query);
    (
      page.getByTestId("node-tags-form").element() as HTMLFormElement
    ).requestSubmit();
    await expect.element(page.getByTestId("node-tags-confirm")).toBeDisabled();
    await expect
      .element(page.getByTestId("node-tags-search"))
      .toHaveAttribute("aria-invalid", "true");
    await expect.element(page.getByTestId("node-tags-required")).toBeVisible();
    expect(ctx.writes()).toEqual([]);
  }
  expect(
    document.querySelector('[data-testid="node-tags-option-tag:Server"]'),
  ).toBeNull();
});

test("the first-device shortcut cannot discard a previously created key", async () => {
  const ctx = await setup("", (backend) => {
    backend.nodes = [];
  });
  ctx.session.deviceSetup.setState({ lastCreatedInvite: "previous-key" });
  await page.getByTestId("add-first-device").click();
  await expect.element(page.getByTestId("discard-key-dialog")).toBeVisible();
  await page.getByTestId("discard-key-cancel").click();
  expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe(
    "previous-key",
  );
});

test("tagged-key creators are explained and result help distinguishes desktop commands from mobile sign-in", async () => {
  await setup();
  await openWizard("server");
  await page.getByTestId("add-device-next").click();
  await expect
    .element(page.getByTestId("setup-owner"))
    .toHaveAttribute("aria-describedby", "setup-owner-hint");
  await expect
    .element(page.getByTestId("setup-owner-hint"))
    .toMatchTextContent("creator, not the owner");
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("generate-install-script").click();
  const result = page.getByTestId("created-invite");
  await expect.element(result).toMatchTextContent("Connection command");
  await expect.element(result).toMatchTextContent("Install Tailscale first");
  await expect.element(result).toMatchTextContent("cannot be retrieved again");
  await expect
    .element(page.getByTestId("setup-install-docs"))
    .toHaveAttribute("href", "https://tailscale.com/kb/1017/install");
  await expect
    .element(page.getByTestId("setup-install-docs"))
    .toHaveAttribute("target", "_blank");
  await page.getByTestId("add-device-finish").click();
  await generateKey("client");
  await expect
    .element(page.getByTestId("setup-mobile-help"))
    .toMatchTextContent("not a mobile command");
  await expect
    .element(page.getByTestId("setup-android-docs"))
    .toHaveAttribute(
      "href",
      "https://headscale.net/stable/usage/connect/android/",
    );
  await expect
    .element(page.getByTestId("setup-ios-docs"))
    .toHaveAttribute(
      "href",
      "https://headscale.net/stable/usage/connect/apple/#ios",
    );
});

test("the mobile device count, refresh and export share one reachable row", async () => {
  await setup();
  await page.viewport(375, 812);
  const count = page
    .getByTestId("machine-count")
    .element()
    .getBoundingClientRect();
  for (const id of ["refresh-machines", "export-machines"]) {
    const button = page.getByTestId(id);
    await expect.element(button).toBeVisible();
    const bounds = button.element().getBoundingClientRect();
    expect(count.top).toBeGreaterThanOrEqual(bounds.top);
    expect(count.bottom).toBeLessThanOrEqual(bounds.bottom);
    expect(bounds.width).toBeGreaterThanOrEqual(24);
    expect(bounds.height).toBeGreaterThanOrEqual(24);
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(375);
    expect(button.element().getAttribute("aria-label")).toBeTruthy();
  }
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
});

// An undeclared key tag is legal; its status must be visible without claiming creation will fail.
test("the server preset shows undeclared status and a management route without forbidding key creation", async () => {
  const ctx = await setup("", (backend) => {
    backend.policy = {
      policy: JSON.stringify({ tagOwners: { "tag:db": [] } }),
    };
  });
  await openWizard("server");
  await expect
    .element(page.getByTestId("setup-tags-selected"))
    .toMatchTextContent(copy.tagUndeclared);
  await expect
    .element(page.getByTestId("setup-tags-define-tag:server"))
    .toBeVisible();
  await chooseTags("setup-tags", ["tag:db"]);
  await expect
    .element(page.getByTestId("setup-tags-selected"))
    .toMatchTextContent(copy.tagDeclared);
  await page.getByTestId("setup-tags-manage").click();
  await expect.poll(() => ctx.router.state.location.pathname).toBe("/access");
  expect(ctx.writes()).toEqual([]);
});

test("unreadable policy marks key definitions unknown without dropping the selection", async () => {
  const ctx = await setup();
  await openWizard("server");
  await expect
    .element(page.getByTestId("setup-tags-selected"))
    .toMatchTextContent(copy.tagDeclared);
  for (const policy of [{ policy: '{"tagOwners":' }, null]) {
    ctx.session.snapshot.applyPatch({ policy });
    await expect
      .element(page.getByTestId("setup-tags-selected"))
      .toMatchTextContent(copy.tagDefinitionUnknown);
    await expect
      .element(page.getByTestId("setup-tags-remove-tag:server"))
      .toBeVisible();
    expect(
      document.querySelector('[data-testid="setup-tags-define-tag:server"]'),
    ).toBeNull();
  }
  expect(ctx.writes()).toEqual([]);
});

// Fix 4: the days field keeps what is typed and only settles the value when it is left.
test("the key lifetime field accepts typed values and clamps them on blur", async () => {
  const ctx = await setup();
  await openWizard("client");
  await page.getByTestId("add-device-next").click();
  const input = page.getByTestId("setup-expiration");
  await input.click();
  await userEvent.keyboard("{Backspace}");
  await expect.element(input).toHaveValue("");
  await userEvent.keyboard("30");
  await expect.element(input).toHaveValue("30");
  await userEvent.tab();
  await expect.element(input).toHaveValue("30");
  await input.fill("95");
  await expect.element(input).toHaveValue("95");
  await userEvent.tab();
  await expect.element(input).toHaveValue("90");
  await expect
    .element(page.getByTestId("setup-expiration-increment"))
    .toBeDisabled();
  await input.fill("0");
  await userEvent.tab();
  await expect.element(input).toHaveValue("1");
  await expect
    .element(page.getByTestId("setup-expiration-decrement"))
    .toBeDisabled();
  await input.fill("abc");
  await userEvent.tab();
  await expect.element(input).toHaveValue("1");
  await page.getByTestId("setup-expiration-increment").click();
  await expect.element(input).toHaveValue("2");
  await input.fill("12");
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("generate-install-script").click();
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  expectDays(keyWrites(ctx)[0]?.body.expiration, 12);
});

test("the day stepper buttons are named and the range hint describes the field", async () => {
  await setup();
  await openWizard("client");
  await page.getByTestId("add-device-next").click();
  await expect
    .element(page.getByRole("button", { name: copy.decreaseDays }))
    .toHaveAttribute("data-testid", "setup-expiration-decrement");
  await expect
    .element(page.getByRole("button", { name: copy.increaseDays }))
    .toHaveAttribute("data-testid", "setup-expiration-increment");
  await expect
    .element(page.getByTestId("setup-expiration"))
    .toHaveAttribute("aria-describedby", "setup-expiration-hint");
  await expect
    .element(page.getByTestId("setup-expiration-hint"))
    .toHaveTextContent(copy.mustBeBetweenDays);
  await page.getByTestId("setup-expiration").click();
  await userEvent.tab();
  await expect.element(page.getByTestId("setup-expiration")).toHaveValue("7");
});

test("the wizard owner falls back when the chosen user disappears or none is visible", async () => {
  const ctx = await setup();
  const refreshNotice = page
    .getByRole("region", { name: "Notifications", exact: true })
    .getByRole("dialog", { name: copy.dataRefreshed, exact: true });
  await openWizard("client");
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("setup-owner").selectOptions("2");
  const users = ctx.session.snapshot.getSnapshot().snapshot.users;
  ctx.session.snapshot.applyPatch({
    users: users.filter((user) => user.id !== "2"),
  });
  await expect.element(page.getByTestId("setup-owner")).toHaveValue("1");
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("generate-install-script").click();
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  expect(keyWrites(ctx)[0]?.body.user).toBe("1");
  await page.getByTestId("add-device-finish").click();
  await expect.element(refreshNotice).toBeVisible();
  await refreshNotice
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect.element(refreshNotice).not.toBeInTheDocument();

  await openWizard("server");
  await page.getByTestId("add-device-next").click();
  ctx.backend.users = [{ id: "0", name: "tagged-devices" }];
  ctx.session.snapshot.applyPatch({ users: ctx.backend.users });
  await expect.element(page.getByTestId("setup-owner")).toHaveValue("");
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("generate-install-script").click();
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  expect(keyWrites(ctx)[1]?.body).not.toHaveProperty("user");
  await page.getByTestId("add-device-finish").click();
  await expect.element(refreshNotice).toBeVisible();
  await refreshNotice
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect.element(refreshNotice).not.toBeInTheDocument();
  await openWizard("client");
  await page.getByTestId("add-device-next").click();
  await expect.element(page.getByTestId("setup-owner")).toHaveValue("");
  expect(keyWrites(ctx)).toHaveLength(2);
});

test("generating again requires discard confirmation before replacing a visible one-time key", async () => {
  const ctx = await setup();
  await generateKey();
  await page.getByTestId("generate-install-script").click();
  await expect.element(page.getByTestId("discard-key-dialog")).toBeVisible();
  expect(keyWrites(ctx)).toHaveLength(1);
  expect(
    ctx.session.deviceSetup.getSnapshot().lastCreatedInvite.length > 0,
  ).toBe(true);
  await page.getByTestId("discard-key-cancel").click();
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  expect(keyWrites(ctx)).toHaveLength(1);
  await page.getByTestId("generate-install-script").click();
  await page.getByTestId("discard-key-confirm").click();
  await expect
    .element(page.getByTestId("created-invite"))
    .not.toBeInTheDocument();
  expect(keyWrites(ctx)).toHaveLength(1);
  await page.getByTestId("generate-install-script").click();
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  expect(keyWrites(ctx)).toHaveLength(2);
});

test.each(["click", "keyboard"] as const)(
  "generating again by %s confirms before discarding a visible one-time key",
  async (activation) => {
    const ctx = await setup();
    await generateKey();
    const generate = page.getByTestId("generate-install-script");
    if (activation === "click") await generate.click();
    else {
      (generate.element() as HTMLButtonElement).focus();
      await userEvent.keyboard("{Enter}");
    }
    await expect.element(page.getByTestId("discard-key-dialog")).toBeVisible();
    expect(keyWrites(ctx)).toHaveLength(1);
    expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe(
      "created-key",
    );
    await page.getByTestId("discard-key-cancel").click();
    await expect.element(page.getByTestId("created-invite")).toBeVisible();
    expect(keyWrites(ctx)).toHaveLength(1);
    await generate.click();
    await page.getByTestId("discard-key-confirm").click();
    await expect
      .element(page.getByTestId("created-invite"))
      .not.toBeInTheDocument();
    expect(keyWrites(ctx)).toHaveLength(1);
    await generate.click();
    await expect.element(page.getByTestId("created-invite")).toBeVisible();
    expect(keyWrites(ctx)).toHaveLength(2);
  },
);

// A generated key cannot be recovered from the API: editing its options first asks to discard it.
test("going back from the generate step confirms before clearing the generated key", async () => {
  const ctx = await setup();
  await generateKey();
  await page.getByTestId("add-device-prev").click();
  await expect.element(page.getByTestId("discard-key-dialog")).toBeVisible();
  expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe(
    "created-key",
  );
  await page.getByTestId("discard-key-cancel").click();
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  await page.getByTestId("add-device-prev").click();
  await page.getByTestId("discard-key-confirm").click();
  await expect.element(page.getByTestId("setup-auth-key-step")).toBeVisible();
  expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe("");
  await page.getByTestId("add-device-next").click();
  await expect
    .element(page.getByTestId("created-invite"))
    .not.toBeInTheDocument();
  await page.getByTestId("generate-install-script").click();
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  await page.getByTestId("add-device-step-preferences").click();
  await expect.element(page.getByTestId("discard-key-dialog")).toBeVisible();
  expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe(
    "created-key",
  );
  await page.getByTestId("discard-key-confirm").click();
  await page.getByTestId("setup-ephemeral").click();
  expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe("");
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("add-device-next").click();
  await expect
    .element(page.getByTestId("created-invite"))
    .not.toBeInTheDocument();
});

// Fix 7: the login server may differ from the API address behind a proxy.
test("the login server URL is editable, validated and kept for the session", async () => {
  await setup();
  await generateKey();
  const field = page.getByTestId("setup-login-server");
  await expect.element(field).toHaveValue("https://fixture.invalid");
  await field.fill("https://hs.example.com/");
  await expect
    .element(page.getByTestId("created-invite"))
    .toMatchTextContent(
      "tailscale up --login-server 'https://hs.example.com' --authkey 'created-key'",
    );
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await page.getByTestId("copy-setup-install-command").click();
  expect(write).toHaveBeenCalledWith(
    "tailscale up --login-server 'https://hs.example.com' --authkey 'created-key'",
  );
  await field.fill("ftp://hs.example.com");
  await expect
    .element(page.getByTestId("setup-login-server-error"))
    .toHaveTextContent(t("connectionInvalidUrl"));
  await expect.element(field).toHaveAttribute("aria-invalid", "true");
  await expect
    .element(page.getByTestId("copy-setup-install-command"))
    .not.toBeInTheDocument();
  await field.fill("not a url");
  await expect
    .element(page.getByTestId("setup-login-server-error"))
    .toBeVisible();
  await field.fill("http://10.0.0.1:8080");
  await page.getByTestId("add-device-finish").click();
  await generateKey("server");
  await expect
    .element(page.getByTestId("setup-login-server"))
    .toHaveValue("http://10.0.0.1:8080");
});

// Fix 8: the created key is shown once; dismissing the wizard by accident must not lose it silently.
test("dismissing the wizard with a created key asks first and Done does not", async () => {
  const ctx = await setup();
  await generateKey();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("discard-key-dialog")).toBeVisible();
  await expect
    .element(page.getByTestId("discard-key-dialog"))
    .toMatchTextContent(copy.discardKeyDescription);
  await page.getByTestId("discard-key-cancel").click();
  await expect
    .element(page.getByTestId("discard-key-dialog"))
    .not.toBeInTheDocument();
  expect(isOpen("add-device-dialog")).toBe(true);
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("discard-key-confirm").click();
  await expect
    .element(page.getByTestId("add-device-dialog"))
    .not.toBeInTheDocument();
  expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe("");
  await generateKey();
  await page.getByTestId("add-device-finish").click();
  await expect
    .element(page.getByTestId("add-device-dialog"))
    .not.toBeInTheDocument();
  expect(
    document.querySelector('[data-testid="discard-key-dialog"]'),
  ).toBeNull();
  await openWizard("client");
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByTestId("add-device-dialog"))
    .not.toBeInTheDocument();
  expect(
    document.querySelector('[data-testid="discard-key-dialog"]'),
  ).toBeNull();
});

// Fix 9: the device joins after the key is used, so Done reloads the machines.
test("Done reloads the machine list and a registration refreshes it", async () => {
  const ctx = await setup();
  await generateKey();
  const before = ctx.nodeReads().length;
  await page.getByTestId("add-device-finish").click();
  await expect.poll(() => ctx.nodeReads().length).toBeGreaterThan(before);
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("add-pending-node").click();
  await page.getByTestId("pending-node-key").fill(AUTH_ID);
  await trustRegistration();
  await page.getByTestId("register-pending-node").click();
  await expect.element(page.getByTestId("registration-result")).toBeVisible();
  await expect.element(page.getByTestId("device-3")).toBeVisible();
});

// Fix 10: an SSH check has no result step; its validation hint remains visible.
test("the SSH check flow has a single step with Done and a visible validation hint", async () => {
  await setup();
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("add-pending-node").click();
  await expect
    .element(page.getByTestId("add-device-dialog"))
    .toMatchTextContent(copy.pendingRegistrationLead);
  await expect
    .element(page.getByTestId("add-device-dialog"))
    .not.toHaveTextContent(copy.deviceSetupLead);
  await expect.element(page.getByTestId("add-device-next")).toBeVisible();
  await page.getByTestId("pending-registration-kind").selectOptions("ssh");
  await expect
    .element(page.getByTestId("add-device-next"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("add-device-step-result"))
    .not.toBeInTheDocument();
  await page.getByTestId("pending-node-key").fill("bogus");
  const hint = page.getByTestId("pending-node-key-hint");
  await expect.element(hint).toBeVisible();
  await expect.element(hint).toHaveClass(/text-destructive/);
  await page.getByTestId("add-device-finish").click();
  await expect
    .element(page.getByTestId("add-device-dialog"))
    .not.toBeInTheDocument();
});

test("the client wizard header has one description line", async () => {
  await setup();
  await openWizard("client");
  const description = document.querySelector(
    '[data-testid="add-device-dialog"] p',
  );
  expect(description?.textContent).toBe(copy.deviceSetupLead);
});

// Tagging changes personal identity; restoring it is a separate non-authkey flow.
test("tagging a user-owned machine needs full review and acknowledgement; search Enter never submits", async () => {
  const ctx = await setup();
  await openMenu("2", "edit-node-tags");
  await chooseTags("node-tags", ["tag:web"]);
  await expect
    .element(page.getByTestId("node-tags-owner-warning"))
    .toMatchTextContent("Bob");
  await page.getByTestId("node-tags-search").click();
  await userEvent.keyboard("{Enter}");
  expect(ctx.writes()).toEqual([]);
  await page.getByTestId("node-tags-confirm").click();
  await expect.element(page.getByTestId("node-tags-apply")).toBeDisabled();
  await page.getByTestId("node-tags-acknowledge").click();
  await page.getByTestId("node-tags-apply").click();
  await expect.element(page.getByTestId("node-tags-result")).toBeVisible();
  expect(ctx.writes()).toEqual([
    {
      method: "POST",
      path: "/api/v1/node/2/tags",
      body: { tags: ["tag:web"] },
    },
  ]);
  expect(ctx.backend.nodes[1]?.user).toBeUndefined();
});

test("a tagged machine cannot be saved without tags", async () => {
  const ctx = await setup();
  await openMenu("1", "edit-node-tags");
  await expect
    .element(page.getByTestId("node-tags-remove-tag:server"))
    .toBeVisible();
  await chooseTags("node-tags", []);
  await expect
    .element(page.getByTestId("node-tags-required"))
    .toHaveTextContent(copy.tagsRequiredForTaggedNode);
  await expect.element(page.getByTestId("node-tags-confirm")).toBeDisabled();
  expect(
    document.querySelector('[data-testid="node-tags-owner-warning"]'),
  ).toBeNull();
  expect(ctx.writes()).toEqual([]);
});

test("the tagging warning names an unknown owner when the machine has no visible user", async () => {
  await setup("", (backend) => {
    const laptop = backend.nodes[1];
    if (laptop) laptop.user = { id: "0", name: "tagged-devices" };
  });
  await openMenu("2", "edit-node-tags");
  await expect.element(page.getByTestId("node-tags-confirm")).toBeDisabled();
  await chooseTags("node-tags", ["tag:web"]);
  await expect
    .element(page.getByTestId("node-tags-owner-warning"))
    .toMatchTextContent(copy.unknown);
});

test("tag search cannot add malformed text and explicit choices send the whole collection", async () => {
  const ctx = await setup();
  await openMenu("1", "edit-node-tags");
  await page.getByTestId("node-tags-search").fill("tag:web db, tag:");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("node-tags-empty")).toBeVisible();
  await expect
    .element(page.getByTestId("node-tags-remove-tag:server"))
    .toBeVisible();
  expect(ctx.writes()).toEqual([]);
  await page.getByTestId("node-tags-clear").click();
  await chooseTags("node-tags", ["tag:web", "tag:db", "tag:x"]);
  await confirmTags();
  await expect.element(page.getByTestId("node-tags-result")).toBeVisible();
  expect(ctx.writes()).toEqual([
    {
      method: "POST",
      path: "/api/v1/node/1/tags",
      body: { tags: ["tag:web", "tag:db", "tag:x"] },
    },
  ]);
});

// Fix 3: a rename sends a trimmed, valid DNS label and never the old name.
test("rename trims, refuses blank or unchanged names and validates the DNS label", async () => {
  const ctx = await setup();
  await openMenu("2", "rename-node");
  const input = page.getByTestId("rename-node-dialog-input");
  await expect.element(page.getByTestId("rename-node-confirm")).toBeDisabled();
  await input.fill("   ");
  await expect.element(page.getByTestId("rename-node-confirm")).toBeDisabled();
  await input.click();
  await userEvent.keyboard("{Enter}");
  for (const bad of ["Bad Name!", "-edge", "edge-", "a".repeat(64)]) {
    await input.fill(bad);
    (
      page.getByTestId("rename-node-form").element() as HTMLFormElement
    ).requestSubmit();
    await expect
      .element(page.getByTestId("rename-node-invalid"))
      .toHaveTextContent(copy.invalidMachineName);
    await expect.element(input).toHaveAttribute("aria-invalid", "true");
    await expect
      .element(page.getByTestId("rename-node-confirm"))
      .toBeDisabled();
  }
  await input.fill("x");
  await expect
    .element(page.getByTestId("rename-node-invalid"))
    .not.toBeInTheDocument();
  expect(ctx.writes()).toEqual([]);
  await input.fill("  New-Host-1  ");
  await page.getByTestId("rename-node-confirm").click();
  await expect
    .element(page.getByTestId("rename-node-dialog"))
    .not.toBeInTheDocument();
  expect(ctx.writes()).toEqual([
    { method: "POST", path: "/api/v1/node/2/rename/New-Host-1", body: {} },
  ]);
});

test("Enter that confirms an IME composition does not rename", async () => {
  const ctx = await setup();
  await openMenu("2", "rename-node");
  const input = page.getByTestId("rename-node-dialog-input");
  await input.fill("office");
  input.element().dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      isComposing: true,
    }),
  );
  await expect.element(page.getByTestId("rename-node-dialog")).toBeVisible();
  expect(ctx.writes()).toEqual([]);
  await input.click();
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByTestId("rename-node-dialog"))
    .not.toBeInTheDocument();
  expect(ctx.writes()).toEqual([
    { method: "POST", path: "/api/v1/node/2/rename/office", body: {} },
  ]);
});

// Fix 11: details speak the user's language and do not rely on colour alone.
test("details localize the register method and group routes by status", async () => {
  const ctx = await setup();
  await page.getByTestId("device-detail-link-1").click();
  const dialog = page.getByTestId("device-detail-dialog");
  await expect
    .element(page.getByTestId("device-detail-register-method-1"))
    .toHaveTextContent(`${copy.registerMethod}: ${copy.registerMethodAuthKey}`);
  await expect.element(dialog).not.toHaveTextContent("REGISTER_METHOD");
  await expect
    .element(page.getByTestId("device-detail-pending-routes-1"))
    .toMatchTextContent(new RegExp(`${copy.pendingRoutes}.*0\\.0\\.0\\.0/0`));
  await expect
    .element(page.getByTestId("device-detail-approved-routes-1"))
    .toMatchTextContent(
      new RegExp(`${copy.approvedRoutes}.*10\\.42\\.0\\.0/16`),
    );
  await expect.element(dialog).not.toHaveTextContent(copy.lastSeen);
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("device-detail-link-2").click();
  await expect
    .element(page.getByTestId("device-detail-register-method-2"))
    .toHaveTextContent(`${copy.registerMethod}: ${copy.registerMethodCli}`);
  await expect.element(dialog).toMatchTextContent(copy.lastSeen);
  await expect.element(dialog).toMatchTextContent(copy.noRouteValues);
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  for (const [method, label] of [
    ["REGISTER_METHOD_OIDC", copy.registerMethodOidc],
    ["REGISTER_METHOD_UNSPECIFIED", copy.unknown],
  ] as const) {
    // Opening details re-reads the server, so the server copy carries the method.
    ctx.backend.nodes = ctx.backend.nodes.map((node) =>
      node.id === "2" ? { ...node, registerMethod: method } : node,
    );
    await page.getByTestId("device-detail-link-2").click();
    await expect
      .element(page.getByTestId("device-detail-register-method-2"))
      .toHaveTextContent(`${copy.registerMethod}: ${label}`);
    await userEvent.keyboard("{Escape}");
    await expect.element(dialog).not.toBeInTheDocument();
  }
});

test("route chips carry a text status and online machines hide last seen", async () => {
  const ctx = await setup();
  await expect
    .element(page.getByTestId("device-pending-route-1-0"))
    .toMatchTextContent(
      new RegExp(
        `0\\.0\\.0\\.0/0.*${copy.routeStatusExit}.*${copy.routeStatusPending}`,
      ),
    );
  await expect
    .element(page.getByTestId("device-approved-route-1-0"))
    .toMatchTextContent(
      new RegExp(`10\\.42\\.0\\.0/16.*${copy.routeStatusApproved}`),
    );
  const routes = page.getByTestId("device-pending-routes-1");
  for (
    let step = 0;
    step < 40 && document.activeElement !== routes.element();
    ++step
  )
    await userEvent.tab();
  await expect.element(routes).toHaveFocus();
  await expect
    .element(page.getByText(copy.viewRoutes, { exact: true }))
    .toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByText(copy.viewRoutes, { exact: true }))
    .not.toBeInTheDocument();
  await expect.element(routes).toHaveFocus();
  await expect
    .element(page.getByTestId("device-1"))
    .not.toHaveTextContent(copy.lastSeen);
  await expect
    .element(page.getByTestId("device-2"))
    .toMatchTextContent(copy.lastSeen);
  await routes.click();
  await expect.poll(() => ctx.router.state.location.pathname).toBe("/routes");
  expect(ctx.router.state.location.search).toEqual({ node: "1" });
  expect(ctx.writes()).toEqual([]);
});

// Fix 12: expiring an expired machine is meaningless, and the menu must fit a short window.
test("an expired machine's menu offers Disable expiry but not Expire", async () => {
  await setup();
  await page.getByTestId("machine-actions-trigger-2").click();
  await expect
    .element(page.getByTestId("disable-expiry-node-action-2"))
    .toBeVisible();
  expect(
    document.querySelector('[data-testid="expire-node-action-2"]'),
  ).toBeNull();
});

test("a seven-item machine menu fits a 510 px high window without scrolling", async () => {
  await setup("", (backend) => {
    const laptop = backend.nodes[1];
    if (laptop) laptop.expiry = "2099-01-01T00:00:00Z";
  });
  for (const [width, trigger, menuId] of [
    [1366, "machine-actions-trigger-2", "machine-actions-menu-2"],
    [600, "machine-actions-trigger-mobile-2", "machine-actions-menu-mobile-2"],
  ] as const) {
    await page.viewport(width, 510);
    await page.getByTestId(trigger).click();
    const menu = page.getByTestId(menuId);
    await expect.element(menu).toBeVisible();
    expect(menu.element().querySelectorAll('[role="menuitem"]')).toHaveLength(
      7,
    );
    await expect
      .poll(() => menu.element().getBoundingClientRect().bottom)
      .toBeLessThanOrEqual(510);
    expect(menu.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(
      0,
    );
    expect(menu.element().scrollHeight).toBeLessThanOrEqual(
      menu.element().clientHeight + 1,
    );
    await userEvent.keyboard("{Escape}");
    await expect.element(menu).not.toBeInTheDocument();
  }
});

// Fix 13: links carry the machine, filters live in the URL, and an owner link filters exactly.
test("View routes and the pending routes link open the routes page for the machine", async () => {
  const ctx = await setup();
  await openMenu("1", "view-node-routes");
  await expect.poll(() => ctx.router.state.location.pathname).toBe("/routes");
  expect(ctx.router.state.location.search).toEqual({ node: "1" });
  await ctx.unmount();
  const next = await setup();
  await page.getByTestId("device-pending-routes-1").click();
  await expect.poll(() => next.router.state.location.pathname).toBe("/routes");
  expect(next.router.state.location.search).toEqual({ node: "1" });
});

test("search and status filter are written to the URL and restored from it", async () => {
  const ctx = await setup();
  await page.getByTestId("device-search").click();
  await userEvent.keyboard("lap");
  await expect
    .poll(() => ctx.router.state.location.search)
    .toEqual({ search: "lap" });
  await expect.element(page.getByTestId("device-search")).toHaveValue("lap");
  await page.getByTestId("machine-filter").selectOptions("expired");
  await expect
    .poll(() => ctx.router.state.location.search)
    .toEqual({ search: "lap", filter: "expired" });
  await expect.element(page.getByTestId("device-2")).toBeVisible();
  await page.getByTestId("clear-machine-filters").click();
  await expect.poll(() => ctx.router.state.location.search).toEqual({});
  await ctx.unmount();
  await setup("?filter=expired&search=lap");
  await expect
    .element(page.getByTestId("machine-filter"))
    .toHaveValue("expired");
  await expect.element(page.getByTestId("device-search")).toHaveValue("lap");
  await expect.element(page.getByTestId("device-1")).not.toBeInTheDocument();
});

test("an unknown filter in the URL lists all machines", async () => {
  await setup("?filter=bogus");
  await expect.element(page.getByTestId("machine-filter")).toHaveValue("all");
  await expect.element(page.getByTestId("device-2")).toBeVisible();
});

test("a ?user= link filters to that owner until its chip or Clear filters removes it", async () => {
  const ctx = await setup("?user=2");
  await expect.element(page.getByTestId("device-2")).toBeVisible();
  await expect.element(page.getByTestId("device-1")).not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("owner-filter-chip"))
    .toMatchTextContent("Bob");
  await page.getByRole("button", { name: copy.removeOwnerFilter }).click();
  await expect.element(page.getByTestId("device-1")).toBeVisible();
  expect(ctx.router.state.location.search).toEqual({});
  await ctx.unmount();
  const next = await setup("?user=1&search=edge");
  await expect.element(page.getByTestId("device-1")).toBeVisible();
  await page.getByTestId("clear-machine-filters").click();
  await expect.element(page.getByTestId("device-2")).toBeVisible();
  expect(next.router.state.location.search).toEqual({});
  await expect
    .element(page.getByTestId("owner-filter-chip"))
    .not.toBeInTheDocument();
});

test("a ?user= link for an unknown user shows its id and matches no machine", async () => {
  await setup("?user=77");
  await expect
    .element(page.getByTestId("owner-filter-chip"))
    .toMatchTextContent("77");
  await expect
    .element(page.getByTestId("machine-list"))
    .toMatchTextContent(copy.noDevices);
});

// Fix 14: the docs link keeps the console open and the visible count follows the filter.
test("Learn more opens a new tab and the result count updates with the filter", async () => {
  await setup();
  const link = page.getByTestId("install-docs-link");
  await expect.element(link).toHaveAttribute("target", "_blank");
  await expect.element(link).toHaveAttribute("rel", "noreferrer");
  const count = page.getByTestId("machine-count");
  await expect.element(count).toBeVisible();
  await expect.element(count).toHaveTextContent("2 / 2");
  await page.getByTestId("device-search").fill("edge");
  await expect.element(count).toHaveTextContent("1 / 2");
});

// Fix 15: at about 790 px the actions stay reachable without horizontal scrolling.
test("the machine table fits a 790 px wide window with reachable actions", async () => {
  await setup();
  await page.viewport(790, 700);
  await expect
    .element(page.getByTestId("machine-actions-trigger-mobile-1"))
    .toBeVisible();
  const list = page.getByTestId("machine-list").element();
  const table = list.querySelector("table");
  expect(table?.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
});

// Fix 16: the wizard footer stays reachable in a short window and the stepper keeps one row.
test("the wizard keeps its footer in view and its stepper on one row at 800x510", async () => {
  await setup();
  await page.viewport(800, 510);
  await openWizard("server");
  await expect.element(page.getByTestId("add-device-next")).toBeVisible();
  const next = page
    .getByTestId("add-device-next")
    .element()
    .getBoundingClientRect();
  expect(next.bottom).toBeLessThanOrEqual(510);
  const tops = Array.from(
    document.querySelectorAll('[data-testid^="add-device-step-"]'),
    (step) => step.getBoundingClientRect().top,
  );
  expect(tops).toHaveLength(3);
  expect(new Set(tops).size).toBe(1);
  const dialog = page
    .getByTestId("add-device-dialog")
    .element()
    .getBoundingClientRect();
  expect(dialog.left).toBeGreaterThan(0);
  expect(dialog.right).toBeLessThan(800);
});

// Fix 17: the export distinguishes advertised from approved routes.
test("the machine export lists advertised and approved routes separately", async () => {
  let text = async (): Promise<string | undefined> => undefined;
  vi.spyOn(URL, "createObjectURL").mockImplementation((value) => {
    text = () => (value as Blob).text();
    return "blob:fixture";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  await setup();
  await page.getByTestId("device-search").fill("edge");
  await page.getByTestId("export-machines").click();
  // The shell may prefix a byte order mark; only the columns matter here.
  const [header, row] = String(await text())
    .replace(/^﻿/, "")
    .split(/\r?\n/);
  expect(header).toBe(
    '"name","owner","status","addresses","tags","advertisedRoutes","approvedRoutes","lastSeen","expires"',
  );
  expect(row).toContain('"10.42.0.0/16 0.0.0.0/0","10.42.0.0/16"');
});
