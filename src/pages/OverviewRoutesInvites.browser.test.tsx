import "fake-indexeddb/auto";
import type { FetchHandle } from "@defjs/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { HeadscaleSnapshot } from "@/api/contracts";
import { setLocale } from "@/i18n";
import { getProductCopy } from "@/i18n/product-copy";
import { hydrateSettings } from "@/lib/settings-storage";
import { expectNetworkTokensLtr } from "@/test/bidi";
import { authenticateTestSession, prepareTestSession, renderSessionPage } from "@/test/session";

import HomePage from "./HomePage";
import InvitesPage from "./InvitesPage";
import RoutesPage from "./RoutesPage";

beforeEach(async () => {
  await hydrateSettings();
  setLocale("en-US");
});

const alice = { id: "1", name: "alice", displayName: "Alice Ops", email: "alice@example.com" };
const bob = { id: "2", name: "bob" };
function fixture(): HeadscaleSnapshot {
  return {
    health: { databaseConnectivity: true, serverReachable: true },
    version: { version: "0.29.4" },
    users: [alice, bob],
    apiKeys: [],
    policy: { policy: '{"acls":[]}' },
    nodes: [
      {
        id: "1",
        name: "edge",
        givenName: "edge-router",
        user: alice,
        online: true,
        ipAddresses: ["100.64.0.1", "fd7a::1"],
        // 192.168.0.0/24 is approved but no longer advertised.
        approvedRoutes: ["10.42.0.0/16", "192.168.0.0/24"],
        availableRoutes: ["10.42.0.0/16", "0.0.0.0/0", "::/0"],
        subnetRoutes: [],
        tags: [],
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
        aclTags: ["tag:server"],
      },
      {
        id: "2",
        key: "used-key",
        user: bob,
        reusable: false,
        ephemeral: true,
        used: true,
        expiration: "2099-01-01T00:00:00Z",
        aclTags: [],
      },
      {
        id: "3",
        key: "expired-key",
        user: alice,
        reusable: false,
        ephemeral: false,
        used: false,
        expiration: "2000-01-01T00:00:00Z",
        aclTags: [],
      },
    ],
  };
}
interface Call {
  method: string;
  path: string;
  // routes is only present on route approvals.
  body: Record<string, unknown> & { routes: string[] };
}
async function setup(path = "/", tweak?: (backend: HeadscaleSnapshot) => void) {
  setLocale("en-US");
  const backend = fixture();
  tweak?.(backend);
  const calls: Call[] = [];
  let failure = "";
  let hold: Promise<void> | undefined;
  let holdWrites: Promise<void> | undefined;
  const transport: FetchHandle = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const body =
      request.method === "GET" || request.method === "DELETE" ? {} : await request.json();
    calls.push({ method: request.method, path: url.pathname, body });
    if (hold && request.method === "GET") await hold;
    if (holdWrites && request.method !== "GET") await holdWrites;
    if (failure && request.method !== "GET")
      return Response.json({ message: failure }, { status: 500 });
    const approval = /^\/api\/v1\/node\/(\d+)\/approve_routes$/.exec(url.pathname);
    if (request.method === "POST" && approval) {
      const node = backend.nodes.find((candidate) => candidate.id === approval[1]);
      if (!node) return Response.json({ message: "Node not found" }, { status: 404 });
      // Headscale re-adds both exit prefixes whenever either one is submitted.
      const exit = body.routes.some((route: string) => route === "0.0.0.0/0" || route === "::/0")
        ? ["0.0.0.0/0", "::/0"]
        : [];
      node.approvedRoutes = Array.from(new Set([...body.routes, ...exit]));
      return Response.json({ node });
    }
    if (request.method === "POST" && url.pathname === "/api/v1/preauthkey") {
      const preAuthKey = {
        id: "4",
        key: "created-key",
        ...body,
        user: backend.users.find((user) => user.id === body.user),
        used: false,
      };
      backend.preAuthKeys.push(preAuthKey);
      return Response.json({ preAuthKey });
    }
    if (request.method === "POST" && url.pathname === "/api/v1/preauthkey/expire") {
      const key = backend.preAuthKeys.find((key) => key.id === body.id);
      if (!key) throw new Error("Unknown fixture key");
      key.expiration = "2000-01-01T00:00:00Z";
      return Response.json({});
    }
    if (request.method === "DELETE") {
      backend.preAuthKeys = backend.preAuthKeys.filter(
        (key) => key.id !== url.searchParams.get("id"),
      );
      return Response.json({});
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
  setLocale("en-US");
  await authenticateTestSession(session);
  const { router } = await renderSessionPage(
    session,
    path === "/routes" ? <RoutesPage /> : path === "/invites" ? <InvitesPage /> : <HomePage />,
    path,
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
    router,
    fail: (message: string) => {
      failure = message;
    },
    pauseWrites: () => {
      let release: (() => void) | undefined;
      holdWrites = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        holdWrites = undefined;
        release?.();
      };
    },
    pause: () => {
      let release: (() => void) | undefined;
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        hold = undefined;
        release?.();
      };
    },
  };
}
afterEach(() => vi.restoreAllMocks());
// Page tests run on the system clock because session and bridge timers read Date.now().
function expectAboutDaysFromNow(value: unknown, days: number) {
  const delta = Date.parse(String(value)) - (Date.now() + days * 86_400_000);
  expect(delta).toBeGreaterThan(-120_000);
  expect(delta).toBeLessThan(120_000);
}
// Catches incorrect dashboard counts or refresh binding to the wrong segment.
test("overview shows current counts and refreshes all segments", async () => {
  const ctx = await setup();
  expect(document.querySelector('[data-testid="overview-stats"]')).not.toBeNull();
  await expect
    .element(page.getByTestId("overview-stat-online").getByText("1", { exact: true }))
    .toHaveTextContent("1");
  await expect
    .element(page.getByTestId("overview-stat-total").getByText("2", { exact: true }))
    .toHaveTextContent("2");
  await expect
    .element(page.getByTestId("overview-stat-users").getByText("2", { exact: true }))
    .toHaveTextContent("2");
  await expect
    .element(page.getByTestId("overview-stat-invites").getByText("1", { exact: true }))
    .toHaveTextContent("1");
  await expect
    .element(page.getByTestId("overview-stat-routes").getByText("2", { exact: true }))
    .toHaveTextContent("2");
  await expect.element(page.getByTestId("device-ip-1-1")).toHaveTextContent("fd7a::1");
  const release = ctx.pause();
  await page.getByTestId("refresh-data").click();
  await expect.element(page.getByTestId("refresh-data")).toBeDisabled();
  const node = ctx.backend.nodes[1];
  if (!node) throw new Error("Fixture has no offline node");
  node.online = true;
  release();
  await expect
    .element(page.getByTestId("overview-stat-online").getByText("2", { exact: true }))
    .toHaveTextContent("2");
  expect(ctx.calls.map((call) => call.path)).toContain("/api/v1/policy");
});
// Catches loss of the approval confirmation or approving all exit routes on an individual action.
test("individual route approval preserves approved routes and requires confirmation", async () => {
  const ctx = await setup("/routes");
  expect(document.querySelector('[data-testid="route-node-1"]')).not.toBeNull();
  await page.getByTestId("approve-route-1-0").click();
  await expect.element(page.getByTestId("approve-route-target")).toHaveTextContent("0.0.0.0/0");
  expect(ctx.calls.filter((call) => call.method === "POST")).toEqual([]);
  await page.getByTestId("approve-route-cancel").click();
  await page.getByTestId("approve-route-1-0").click();
  await page.getByTestId("approve-route-confirm").click();
  await expect.element(page.getByTestId("route-approved-1-2")).toHaveTextContent("0.0.0.0/0");
  // The approved-but-unadvertised 192.168.0.0/24 must survive the write.
  expect(ctx.calls.find((call) => call.method === "POST")?.body).toEqual({
    routes: ["10.42.0.0/16", "192.168.0.0/24", "0.0.0.0/0"],
  });
  await expect.element(page.getByTestId("approve-route-dialog")).not.toBeInTheDocument();
});
// Catches bulk approval losing a route or failure closing the confirmation and hiding its error.
test("bulk route approval retains the dialog on failure and retries with every route", async () => {
  const ctx = await setup("/routes");
  expect(document.querySelector('[data-testid="route-node-1"]')).not.toBeNull();
  await page.getByTestId("approve-routes-1").click();
  await expect.element(page.getByTestId("approve-routes-target-1")).toHaveTextContent("::/0");
  ctx.fail("Route approval failed");
  await page.getByTestId("approve-routes-confirm").click();
  await expect
    .element(page.getByTestId("approve-routes-error"))
    .toHaveTextContent("Route approval failed");
  ctx.fail("");
  await page.getByTestId("approve-routes-confirm").click();
  await expect.element(page.getByTestId("approve-routes-dialog")).not.toBeInTheDocument();
  const everyRoute = ["0.0.0.0/0", "10.42.0.0/16", "192.168.0.0/24", "::/0"];
  expect(ctx.backend.nodes[0]?.approvedRoutes.toSorted()).toEqual(everyRoute);
  const written = posts(ctx).at(-1)?.body.routes ?? [];
  expect(written.toSorted()).toEqual(everyRoute);
  expect(written.slice(0, 2)).toEqual(["10.42.0.0/16", "192.168.0.0/24"]);
  await expect.element(page.getByTestId("approve-routes-1")).toBeDisabled();
});
// Catches a stale refreshed route reopening a canceled dialog or failing to remove a disappeared route.
test("route dialog refresh closes disappeared targets and ignores canceled refreshes", async () => {
  const ctx = await setup("/routes");
  expect(document.querySelector('[data-testid="route-node-1"]')).not.toBeNull();
  const release = ctx.pause();
  await page.getByTestId("approve-route-1-0").click();
  await page.getByTestId("approve-route-cancel").click();
  release();
  await expect.element(page.getByTestId("approve-route-dialog")).not.toBeInTheDocument();
  const node = ctx.backend.nodes[0];
  if (!node) throw new Error("Fixture has no route node");
  node.availableRoutes = ["10.42.0.0/16"];
  await page.getByTestId("approve-route-1-0").click();
  await expect.element(page.getByTestId("approve-route-dialog")).not.toBeInTheDocument();
  expect(ctx.calls.filter((call) => call.method === "POST")).toEqual([]);
});
// Catches changed route targets or omitted member context in navigation.
test("route links preserve member context and device search", async () => {
  const ctx = await setup("/routes");
  expect(document.querySelector('[data-testid="route-node-1"]')).not.toBeNull();
  await page.getByTestId("route-user-link-1").click();
  await expect.element(page.getByTestId("test-route")).toBeInTheDocument();
  expect(ctx.router.state.location.search).toEqual({ user: "1", from: "routes" });
  await ctx.router.navigate({ to: "/routes" });
  await page.getByTestId("route-machine-link-1").click();
  await expect.element(page.getByTestId("test-route")).toBeInTheDocument();
  expect(ctx.router.state.location.search).toEqual({ search: "edge-router" });
});
// Catches dropped searchable fields or incorrect used/tagged/expired/ready filters.
test("auth key search and filters compose without changing backend keys", async () => {
  await setup("/invites");
  expect(document.querySelector('[data-testid="invite-table"]')).not.toBeNull();
  await page.getByTestId("invite-search").fill("alice");
  await expect.element(page.getByTestId("invite-1")).toBeVisible();
  await expect.element(page.getByTestId("invite-2")).not.toBeInTheDocument();
  await page.getByTestId("invite-search").fill("");
  for (const [filter, present, absent] of [
    ["used", "2", "1"],
    ["tagged", "1", "2"],
    ["expired", "3", "1"],
    ["ready", "1", "3"],
  ] as const) {
    await page.getByTestId("invite-filter").selectOptions(filter);
    await expect.element(page.getByTestId(`invite-${present}`)).toBeVisible();
    await expect.element(page.getByTestId(`invite-${absent}`)).not.toBeInTheDocument();
  }
  await page.getByTestId("invite-search").fill("not-existing");
  await expect
    .element(page.getByTestId("invite-table"))
    .toMatchTextContent(/No auth keys match these filters\./);
});
// Catches changing the user's edited form after late snapshot refresh, payload loss, or omitted install command.
test("auth key creation preserves draft across refresh and exposes the new key and install command", async () => {
  const ctx = await setup("/invites");
  expect(document.querySelector('[data-testid="invite-table"]')).not.toBeNull();
  const release = ctx.pause();
  await page.getByTestId("open-create-invite").click();
  await page.getByTestId("invite-user").selectOptions("2");
  await page.getByTestId("invite-tags").fill("tag:server");
  await page.getByTestId("invite-reusable").click();
  await page.getByTestId("invite-ephemeral").click();
  release();
  await expect.element(page.getByTestId("invite-user")).toHaveValue("2");
  await expect.element(page.getByTestId("invite-tags")).toHaveValue("tag:server");
  ctx.fail("Create rejected");
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("create-invite-error"))
    .toHaveTextContent("Create rejected");
  ctx.fail("");
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("created-invite"))
    .toMatchTextContent(
      "tailscale up --login-server https://fixture.invalid --authkey created-key",
    );
  await expect.element(page.getByTestId("invite-create-dialog")).not.toBeInTheDocument();
  const created = ctx.backend.preAuthKeys.find((key) => key.id === "4");
  // The dialog starts from a one-time key, so the toggled checkbox asks for a reusable one.
  expect(created).toMatchObject({
    user: bob,
    reusable: true,
    ephemeral: true,
    aclTags: ["tag:server"],
  });
  expectAboutDaysFromNow(created?.expiration, 7);
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await page.getByTestId("copy-created-invite").click();
  await expect.element(page.getByTestId("copy-created-invite")).toHaveTextContent("Copied");
  expect(write).toHaveBeenCalledWith("created-key");
  await page.getByTestId("copy-created-install-command").click();
  expect(write).toHaveBeenLastCalledWith(
    "tailscale up --login-server https://fixture.invalid --authkey created-key",
  );
});
// Catches the previously edited expiration being remembered as the next default.
test("next open does not remember the edited expiration", async () => {
  const ctx = await setup("/invites");
  expect(document.querySelector('[data-testid="invite-table"]')).not.toBeNull();
  const nextYear = new Date().getFullYear() + 1;
  await page.getByTestId("open-create-invite").click();
  await page.getByTestId("invite-expiration").click();
  await page.getByRole("combobox", { name: "Choose the Year" }).selectOptions(String(nextYear));
  const day = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-slot="calendar-cell-trigger"]'),
  ).find((el) => el.textContent?.trim() === "15" && !el.closest('[data-outside="true"]'));
  if (!day) throw new Error("Day 15 is missing");
  day.click();
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("create-invite").click();
  await expect.element(page.getByTestId("invite-create-dialog")).not.toBeInTheDocument();
  await page.getByTestId("open-create-invite").click();
  await page.getByTestId("create-invite").click();
  await expect.element(page.getByTestId("invite-create-dialog")).not.toBeInTheDocument();
  const created = ctx.backend.preAuthKeys.filter((key) => key.id === "4");
  expect(created).toHaveLength(2);
  expect(new Date(String(created[0]?.expiration)).getFullYear()).toBe(nextYear);
  expectAboutDaysFromNow(created[1]?.expiration, 7);
});
// Catches destructive actions bypassing confirmation or discarding the visible failure.
test("auth key expire and delete confirm, retain failures and refresh their result", async () => {
  const ctx = await setup("/invites");
  expect(document.querySelector('[data-testid="invite-table"]')).not.toBeNull();
  await page.getByTestId("invite-actions-trigger-1").click();
  await page.getByTestId("expire-invite-1").click();
  expect(ctx.calls.filter((call) => call.method === "POST")).toEqual([]);
  await page.getByTestId("cancel-invite-action").click();
  await page.getByTestId("invite-actions-trigger-1").click();
  await page.getByTestId("expire-invite-1").click();
  ctx.fail("Cannot expire");
  await page.getByTestId("confirm-invite-action").click();
  await expect.element(page.getByTestId("invite-action-error")).toHaveTextContent("Cannot expire");
  ctx.fail("");
  await page.getByTestId("confirm-invite-action").click();
  await expect.element(page.getByTestId("expire-invite-dialog")).not.toBeInTheDocument();
  expect(ctx.backend.preAuthKeys[0]?.expiration).toBe("2000-01-01T00:00:00Z");
  await page.getByTestId("invite-actions-trigger-1").click();
  await page.getByTestId("delete-invite-1").click();
  await page.getByTestId("confirm-invite-action").click();
  await expect.element(page.getByTestId("invite-1")).not.toBeInTheDocument();
});
// Catches missing identity refresh or owner link losing the detail-popup query.
test("auth keys refresh identity and open member details with popup context", async () => {
  const ctx = await setup("/invites");
  expect(document.querySelector('[data-testid="invite-table"]')).not.toBeNull();
  await page.getByTestId("refresh-auth-keys").click();
  await expect.poll(() => ctx.calls.some((call) => call.path === "/api/v1/preauthkey")).toBe(true);
  expect(ctx.calls.some((call) => call.path === "/api/v1/node")).toBe(false);
  await page.getByTestId("invite-owner-link-1").click();
  await expect.element(page.getByTestId("test-route")).toBeInTheDocument();
  expect(ctx.router.state.location.search).toEqual({ user: "1", from: "invites", popup: "user" });
});

test("rejected route-link navigation preserves the displayed route data", async () => {
  const ctx = await setup("/routes");
  vi.spyOn(ctx.router, "navigate").mockRejectedValue(new Error("Navigation canceled"));
  await page.getByTestId("route-user-link-1").click();
  await expect.element(page.getByTestId("route-node-1")).toBeVisible();
  await page.getByTestId("route-machine-link-1").click();
  await expect.element(page.getByTestId("route-node-1")).toMatchTextContent("edge-router");
  expect(ctx.router.state.location.pathname).toBe("/routes");
  expect(ctx.session.snapshot.getSnapshot().snapshot.nodes[0]?.approvedRoutes).toEqual([
    "10.42.0.0/16",
    "192.168.0.0/24",
  ]);
});

type Ctx = Awaited<ReturnType<typeof setup>>;
function routeNode(backend: HeadscaleSnapshot) {
  const node = backend.nodes[0];
  if (!node) throw new Error("Fixture has no route node");
  return node;
}
function posts(ctx: Ctx) {
  return ctx.calls.filter((call) => call.method === "POST");
}
// Opens a dialog and waits until the refresh it starts has settled.
async function openSettled(ctx: Ctx, testId: string) {
  await page.getByTestId(testId).click();
  await expect.poll(() => ctx.calls.some((call) => call.path === "/api/v1/node")).toBe(true);
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
}

// Catches Approve all rebuilding the approved set from the advertised list (F134/F135).
test("Approve all keeps approved routes that are no longer advertised", async () => {
  const ctx = await setup("/routes");
  await openSettled(ctx, "approve-routes-1");
  await page.getByTestId("approve-routes-confirm").click();
  await expect.element(page.getByTestId("approve-routes-dialog")).not.toBeInTheDocument();
  expect(posts(ctx)[0]?.body.routes).toEqual([
    "10.42.0.0/16",
    "192.168.0.0/24",
    "0.0.0.0/0",
    "::/0",
  ]);
});

// Catches a click-time copy of the node reaching the Approve all dialog (F138).
test("Approve all re-reads the node when it opens and approves what is pending now", async () => {
  const ctx = await setup("/routes");
  const node = routeNode(ctx.backend);
  node.approvedRoutes.push("10.88.0.0/16");
  node.availableRoutes = ["10.42.0.0/16", "0.0.0.0/0", "172.31.0.0/16"];
  await page.getByTestId("approve-routes-1").click();
  await expect
    .element(page.getByTestId("approve-routes-target-1"))
    .toHaveTextContent("172.31.0.0/16");
  await expect.element(page.getByTestId("approve-routes-target-2")).not.toBeInTheDocument();
  await page.getByTestId("approve-routes-confirm").click();
  await expect.element(page.getByTestId("approve-routes-dialog")).not.toBeInTheDocument();
  expect(posts(ctx)[0]?.body.routes).toEqual([
    "10.42.0.0/16",
    "192.168.0.0/24",
    "10.88.0.0/16",
    "0.0.0.0/0",
    "172.31.0.0/16",
  ]);
});

// Catches a route advertised after the dialog opened being approved without being seen.
test("Approve all keeps a concurrent approval and never approves an unseen advertised route", async () => {
  const ctx = await setup("/routes");
  await openSettled(ctx, "approve-routes-1");
  const node = routeNode(ctx.backend);
  node.approvedRoutes.push("10.77.0.0/16");
  node.availableRoutes.push("172.16.0.0/12");
  await ctx.session.snapshot.refreshSnapshot();
  await page.getByTestId("approve-routes-confirm").click();
  await expect.element(page.getByTestId("approve-routes-dialog")).not.toBeInTheDocument();
  const written = posts(ctx)[0]?.body.routes;
  expect(written).toEqual(["10.42.0.0/16", "192.168.0.0/24", "10.77.0.0/16", "0.0.0.0/0", "::/0"]);
  expect(written).not.toContain("172.16.0.0/12");
});

// Catches Approve all opening on routes another admin already approved.
test("Approve all closes without a write when nothing is pending any more", async () => {
  const ctx = await setup("/routes");
  routeNode(ctx.backend).approvedRoutes = ["10.42.0.0/16", "0.0.0.0/0", "::/0"];
  const release = ctx.pause();
  await page.getByTestId("approve-routes-1").click();
  await expect.element(page.getByTestId("approve-routes-dialog")).toBeVisible();
  release();
  await expect.element(page.getByTestId("approve-routes-dialog")).not.toBeInTheDocument();
  expect(posts(ctx)).toEqual([]);
});

// Catches a write built from a snapshot that is being replaced.
test("every route Confirm button is disabled while a snapshot refresh is running", async () => {
  const ctx = await setup("/routes");
  for (const [open, confirm, cancel] of [
    ["approve-routes-1", "approve-routes-confirm", "approve-routes-cancel"],
    ["approve-route-1-0", "approve-route-confirm", "approve-route-cancel"],
    ["revoke-route-1-0", "revoke-route-confirm", "revoke-route-cancel"],
  ] as const) {
    const release = ctx.pause();
    await page.getByTestId(open).click();
    await expect.element(page.getByTestId(confirm)).toBeDisabled();
    await expect.element(page.getByTestId(cancel)).toBeEnabled();
    release();
    await expect.element(page.getByTestId(confirm)).toBeEnabled();
    await page.getByTestId(cancel).click();
    await expect.element(page.getByTestId(confirm)).not.toBeInTheDocument();
  }
  expect(posts(ctx)).toEqual([]);
});

// Catches the single-route approval writing over an approval made meanwhile.
test("single route approval is built on the live approved set", async () => {
  const ctx = await setup("/routes");
  await openSettled(ctx, "approve-route-1-0");
  routeNode(ctx.backend).approvedRoutes.push("10.77.0.0/16");
  await ctx.session.snapshot.refreshSnapshot();
  await page.getByTestId("approve-route-confirm").click();
  await expect.element(page.getByTestId("approve-route-dialog")).not.toBeInTheDocument();
  expect(posts(ctx)[0]?.body.routes).toEqual([
    "10.42.0.0/16",
    "192.168.0.0/24",
    "10.77.0.0/16",
    "0.0.0.0/0",
  ]);
});

// Catches approved routes that can never be taken back (F137).
test("revoking an advertised route names it, keeps the rest and shows it as pending again", async () => {
  const ctx = await setup("/routes");
  await expect
    .element(page.getByTestId("revoke-route-1-0"))
    .toHaveAttribute("aria-label", "Revoke route: 10.42.0.0/16, edge-router");
  await page.getByTestId("revoke-route-1-0").click();
  const dialog = page.getByTestId("revoke-route-dialog");
  await expect.element(dialog).toMatchTextContent("Revoke route approval");
  await expect.element(dialog).toMatchTextContent("edge-router");
  await expect.element(dialog).toMatchTextContent("Devices stop using this route");
  await expect.element(page.getByTestId("revoke-route-target-0")).toHaveTextContent("10.42.0.0/16");
  await page.getByTestId("revoke-route-cancel").click();
  await expect.element(dialog).not.toBeInTheDocument();
  expect(posts(ctx)).toEqual([]);

  await page.getByTestId("revoke-route-1-0").click();
  ctx.fail("Revoke denied");
  await page.getByTestId("revoke-route-confirm").click();
  await expect.element(page.getByTestId("revoke-route-error")).toHaveTextContent("Revoke denied");
  await expect.element(dialog).toBeVisible();
  ctx.fail("");
  await page.getByTestId("revoke-route-confirm").click();
  await expect.element(dialog).not.toBeInTheDocument();
  expect(posts(ctx).map((call) => call.body.routes)).toEqual([
    ["192.168.0.0/24"],
    ["192.168.0.0/24"],
  ]);
  await expect.element(page.getByTestId("route-approved-1-0")).toHaveTextContent("192.168.0.0/24");
  await expect
    .element(page.getByTestId("pending-route-value-1-0"))
    .toHaveTextContent("10.42.0.0/16");
});

// Catches revoke being limited to advertised routes.
test("an approved route that is no longer advertised can be revoked", async () => {
  const ctx = await setup("/routes");
  await page.getByTestId("revoke-route-1-1").click();
  await page.getByTestId("revoke-route-confirm").click();
  await expect.element(page.getByTestId("revoke-route-dialog")).not.toBeInTheDocument();
  expect(posts(ctx)[0]?.body.routes).toEqual(["10.42.0.0/16"]);
  await expect.element(page.getByTestId("route-approved-1-1")).not.toBeInTheDocument();
});

// Catches the last approved route being impossible to revoke.
test("revoking the only approved route writes an empty set", async () => {
  const ctx = await setup("/routes", (backend) => {
    routeNode(backend).approvedRoutes = ["192.168.0.0/24"];
  });
  await page.getByTestId("revoke-route-1-0").click();
  await page.getByTestId("revoke-route-confirm").click();
  await expect.element(page.getByTestId("revoke-route-dialog")).not.toBeInTheDocument();
  expect(posts(ctx)[0]?.body).toEqual({ routes: [] });
  expect(routeNode(ctx.backend).approvedRoutes).toEqual([]);
  await expect.element(page.getByTestId("route-approved-1-0")).not.toBeInTheDocument();
});

// Catches a half revoke of the IPv4/IPv6 exit pair, which Headscale silently undoes.
test("revoking one exit route revokes the pair", async () => {
  const ctx = await setup("/routes", (backend) => {
    routeNode(backend).approvedRoutes = ["10.42.0.0/16", "0.0.0.0/0", "::/0"];
  });
  await page.getByTestId("revoke-route-1-1").click();
  await expect.element(page.getByTestId("revoke-route-target-0")).toHaveTextContent("0.0.0.0/0");
  await expect.element(page.getByTestId("revoke-route-target-1")).toHaveTextContent("::/0");
  await expect.element(page.getByTestId("revoke-route-target-2")).not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("revoke-route-dialog"))
    .toMatchTextContent("Exit routes are revoked as a pair");
  await page.getByTestId("revoke-route-confirm").click();
  await expect.element(page.getByTestId("revoke-route-dialog")).not.toBeInTheDocument();
  expect(posts(ctx)[0]?.body.routes).toEqual(["10.42.0.0/16"]);
  expect(routeNode(ctx.backend).approvedRoutes).toEqual(["10.42.0.0/16"]);
});

// Catches revoking a route another admin has already revoked.
test("revoke closes without a write when the route is already gone", async () => {
  const ctx = await setup("/routes");
  const release = ctx.pause();
  await page.getByTestId("revoke-route-1-1").click();
  await expect.element(page.getByTestId("revoke-route-dialog")).toBeVisible();
  routeNode(ctx.backend).approvedRoutes = ["10.42.0.0/16"];
  release();
  await expect.element(page.getByTestId("revoke-route-dialog")).not.toBeInTheDocument();
  expect(posts(ctx)).toEqual([]);
});

// Catches a write that closes the dialog while it is still pending.
test("the revoke dialog cannot be dismissed while its write is pending", async () => {
  const ctx = await setup("/routes");
  await openSettled(ctx, "revoke-route-1-1");
  const release = ctx.pauseWrites();
  await page.getByTestId("revoke-route-confirm").click();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("revoke-route-dialog")).toBeVisible();
  release();
  await expect.element(page.getByTestId("revoke-route-dialog")).not.toBeInTheDocument();
  expect(posts(ctx)).toHaveLength(1);
});

// Catches route values reordering in a right-to-left locale ("0/::" symptom).
test("route values stay left-to-right in Arabic", async () => {
  const ctx = await setup("/routes");
  await setLocale("ar");
  try {
    expectNetworkTokensLtr(document.body, 6);
    await openSettled(ctx, "approve-route-1-0");
    expectNetworkTokensLtr(page.getByTestId("approve-route-dialog").element(), 1);
    await page.getByTestId("approve-route-cancel").click();
    await openSettled(ctx, "approve-routes-1");
    expectNetworkTokensLtr(page.getByTestId("approve-routes-dialog").element(), 2);
    await page.getByTestId("approve-routes-cancel").click();
    await openSettled(ctx, "revoke-route-1-0");
    expectNetworkTokensLtr(page.getByTestId("revoke-route-dialog").element(), 1);
  } finally {
    await setLocale("en-US");
  }
});

function nodeAt(id: string): HeadscaleSnapshot["nodes"][number] {
  return {
    id,
    name: `node-${id}`,
    user: alice,
    online: true,
    ipAddresses: [`100.64.0.${id}`, "fd7a::1"],
    approvedRoutes: [],
    availableRoutes: [],
    subnetRoutes: [],
    tags: [],
  };
}
// Catches the Home page showing the oldest four devices.
test("recent devices are the four newest by numeric id", async () => {
  await setup("/", (backend) => {
    backend.nodes = ["1", "2", "3", "4", "5", "6", "10"].map(nodeAt);
  });
  await expect.element(page.getByTestId("recent-device-status-10")).toBeVisible();
  expect(
    Array.from(document.querySelectorAll('[data-testid^="recent-device-status-"]'), (badge) =>
      badge.getAttribute("data-testid"),
    ),
  ).toEqual([
    "recent-device-status-10",
    "recent-device-status-6",
    "recent-device-status-5",
    "recent-device-status-4",
  ]);
  await expect.element(page.getByTestId("recent-device-10")).toBeVisible();
  await expect.element(page.getByTestId("recent-device-status-1")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("recent-device-status-2")).not.toBeInTheDocument();
});

// Catches a Home page with an empty list and no hint.
test("Home explains how to add the first device when there are none", async () => {
  await setup("/", (backend) => {
    backend.nodes = [];
  });
  await expect
    .element(page.getByTestId("recent-devices-empty"))
    .toHaveTextContent(
      "Install Tailscale on another device and connect it to this Headscale server.",
    );
  expect(document.querySelector('[data-testid^="recent-device-"]')).toBeNull();
});

// Catches device addresses reordering in a right-to-left locale.
test("Home device addresses stay left-to-right in Arabic", async () => {
  await setup("/");
  await setLocale("ar");
  try {
    expectNetworkTokensLtr(page.getByTestId("device-ip-1-1").element(), 1);
    expectNetworkTokensLtr(page.getByTestId("device-ip-1-0").element(), 1);
  } finally {
    await setLocale("en-US");
  }
});

// Catches a literal 0 rendered in the tags cell and untagged keys differing from tagged ones.
test("the ACL tags cell is empty for untagged keys", async () => {
  await setup("/invites");
  const columns = Array.from(document.querySelectorAll("th"), (cell) => cell.textContent);
  const label = getProductCopy("en-US").aclTags;
  expect(columns).toContain(label);
  const index = columns.indexOf(label);
  for (const id of ["2", "3"]) {
    const cell = document.querySelector(`[data-testid="invite-${id}"]`)?.children[index];
    expect(cell?.textContent).toBe("");
    expect(cell?.getAttribute("data-testid")).toBe(`invite-tags-${id}`);
  }
  await expect.element(page.getByTestId("invite-tag-1-0")).toHaveTextContent("tag:server");
  expect(
    page
      .getByTestId("invite-tags-1")
      .element()
      .contains(page.getByTestId("invite-tag-1-0").element()),
  ).toBe(true);
});

// Catches an expired unused key still reading as available.
test("an expired unused key reads Expired and is found by searching for it", async () => {
  await setup("/invites");
  await expect.element(page.getByTestId("invite-status-3")).toHaveTextContent("Expired");
  expect(page.getByTestId("invite-status-3").element().className).toContain("rose");
  await expect.element(page.getByTestId("invite-status-1")).toHaveTextContent("Ready");
  await page.getByTestId("invite-search").fill("expired");
  await expect.element(page.getByTestId("invite-3")).toBeVisible();
  await expect.element(page.getByTestId("invite-1")).not.toBeInTheDocument();
});

// Catches a Ready badge that stays Ready after the key's expiry passes.
test("a key that expires while the page is open flips to Expired without any action", async () => {
  const ctx = await setup("/invites");
  const key = ctx.backend.preAuthKeys[0];
  if (!key) throw new Error("Fixture has no key");
  key.expiration = new Date(Date.now() + 1500).toISOString();
  await ctx.session.snapshot.refreshSnapshot();
  await expect.element(page.getByTestId("invite-status-1")).toHaveTextContent("Ready");
  ctx.calls.length = 0;
  await expect
    .element(page.getByTestId("invite-status-1"), { timeout: 6000 })
    .toHaveTextContent("Expired");
  expect(ctx.calls).toEqual([]);
});

// Catches an owner-less key being shown as an unknown owner or linking to a user.
test("a key without an owner says so, has no owner link and is searchable", async () => {
  await setup("/invites", (backend) => {
    backend.preAuthKeys.push({
      id: "7",
      key: "tag-only-key",
      reusable: false,
      ephemeral: false,
      used: false,
      expiration: "2099-01-01T00:00:00Z",
      aclTags: ["tag:ci"],
    });
  });
  await expect.element(page.getByTestId("invite-7")).toMatchTextContent("No owner (tags only)");
  await expect.element(page.getByTestId("invite-owner-link-7")).not.toBeInTheDocument();
  await page.getByTestId("invite-search").fill("no owner");
  await expect.element(page.getByTestId("invite-7")).toBeVisible();
  await expect.element(page.getByTestId("invite-1")).not.toBeInTheDocument();
});

// Catches an owner-less, tag-only key being impossible to create.
test("an owner-less tag-only key is created without a user", async () => {
  const ctx = await setup("/invites");
  await page.getByTestId("open-create-invite").click();
  await page.getByTestId("invite-user").selectOptions("");
  await page.getByTestId("invite-tags").fill("tag:ci");
  await page.getByTestId("create-invite").click();
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  expect(posts(ctx)[0]?.body).not.toHaveProperty("user");
  expect(posts(ctx)[0]?.body.aclTags).toEqual(["tag:ci"]);
  await expect.element(page.getByTestId("invite-4")).toMatchTextContent("No owner (tags only)");
});

// Catches a rejected clipboard write being silent or an unhandled rejection.
test("a rejected clipboard write on the created key shows Copy failed", async () => {
  const ctx = await setup("/invites");
  ctx.session.deviceSetup.setState({ lastCreatedInvite: "shown-once-key" });
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
  await page.getByTestId("copy-created-invite").click();
  await expect.element(page.getByTestId("copy-created-invite")).toMatchTextContent("Copy failed");
});

// Catches a created key that is not announced or focused, and focus being stolen on revisit.
test("the created key group takes focus once and not again on a later visit", async () => {
  const ctx = await setup("/invites", (backend) => {
    for (let index = 10; index < 45; index++)
      backend.preAuthKeys.push({
        id: String(index),
        key: `filler-${index}`,
        user: alice,
        reusable: false,
        ephemeral: false,
        used: false,
        expiration: "2099-01-01T00:00:00Z",
        aclTags: [],
      });
  });
  await page.viewport(1366, 768);
  await page.getByTestId("open-create-invite").click();
  await page.getByTestId("create-invite").click();
  const card = page.getByRole("group", { name: "Auth key created" });
  await expect.element(card).toBeVisible();
  await expect.poll(() => card.element().contains(document.activeElement)).toBe(true);
  await expect.poll(() => card.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
  expect(card.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight + 1);
  await ctx.router.navigate({ to: "/home" });
  await expect.element(page.getByTestId("test-route")).toBeInTheDocument();
  const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
  await ctx.router.navigate({ to: "/invites" });
  await expect.element(card).toBeVisible();
  expect(card.element().contains(document.activeElement)).toBe(false);
  expect(scroll).not.toHaveBeenCalled();
});

// Catches an unnamed table.
test("the invites table has an accessible name", async () => {
  await setup("/invites");
  await expect.element(page.getByRole("table", { name: "Auth keys" })).toBeInTheDocument();
});

// Catches the Escape key dismissing a route approval whose write is still in flight.
test.each([
  [
    "approve-routes-1",
    "approve-routes-dialog",
    "approve-routes-confirm",
    ["10.42.0.0/16", "192.168.0.0/24", "0.0.0.0/0", "::/0"],
  ],
  [
    "approve-route-1-0",
    "approve-route-dialog",
    "approve-route-confirm",
    ["10.42.0.0/16", "192.168.0.0/24", "0.0.0.0/0"],
  ],
] as const)(
  "the %s dialog cannot be dismissed while its write is pending",
  async (open, dialog, confirm, routes) => {
    const ctx = await setup("/routes");
    await openSettled(ctx, open);
    const release = ctx.pauseWrites();
    await page.getByTestId(confirm).click();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByTestId(dialog)).toBeVisible();
    release();
    await expect.element(page.getByTestId(dialog)).not.toBeInTheDocument();
    expect(posts(ctx)).toHaveLength(1);
    expect(posts(ctx)[0]?.body.routes).toEqual(routes);
  },
);

// Catches a refresh button that stays clickable (or never refreshes) while the routes are reloading.
test("the routes refresh button reloads nodes and is disabled meanwhile", async () => {
  const ctx = await setup("/routes");
  const release = ctx.pause();
  await page.getByTestId("refresh-routes").click();
  await expect.element(page.getByTestId("refresh-routes")).toBeDisabled();
  release();
  await expect.element(page.getByTestId("refresh-routes")).toBeEnabled();
  expect(ctx.calls.some((call) => call.method === "GET" && call.path === "/api/v1/node")).toBe(
    true,
  );
});

// Catches a node whose routes were all withdrawn losing its approved routes or its placeholder.
test("a node with approved routes but nothing advertised says so", async () => {
  await setup("/routes", (backend) => {
    routeNode(backend).availableRoutes = [];
  });
  const copy = getProductCopy("en-US");
  await expect.element(page.getByTestId("route-node-1")).toMatchTextContent(copy.noRouteValues);
  await expect.element(page.getByTestId("route-approved-1-0")).toHaveTextContent("10.42.0.0/16");
  await expect.element(page.getByTestId("approve-routes-1")).toBeDisabled();
  await expect.element(page.getByTestId("approve-routes-1")).toHaveTextContent(copy.routesApproved);
});

// Pins the decision that a write is attempted from the dialog's copy when its node vanishes, and the server's answer is shown.
test.each([
  [
    "approve-routes-1",
    "approve-routes-dialog",
    "approve-routes-confirm",
    "approve-routes-error",
    ["10.42.0.0/16", "192.168.0.0/24", "0.0.0.0/0", "::/0"],
  ],
  [
    "approve-route-1-0",
    "approve-route-dialog",
    "approve-route-confirm",
    "approve-route-error",
    ["10.42.0.0/16", "192.168.0.0/24", "0.0.0.0/0"],
  ],
  [
    "revoke-route-1-1",
    "revoke-route-dialog",
    "revoke-route-confirm",
    "revoke-route-error",
    ["10.42.0.0/16"],
  ],
] as const)(
  "a route dialog left open on a vanished node writes from its own copy and shows the server error (%s)",
  async (open, dialog, confirm, error, routes) => {
    const ctx = await setup("/routes");
    await openSettled(ctx, open);
    ctx.backend.nodes = ctx.backend.nodes.filter((node) => node.id !== "1");
    await ctx.session.snapshot.refreshSnapshot();
    await page.getByTestId(confirm).click();
    await expect.element(page.getByTestId(error)).toHaveTextContent("Node not found");
    expect(posts(ctx)).toHaveLength(1);
    expect(posts(ctx)[0]?.path).toBe("/api/v1/node/1/approve_routes");
    expect(posts(ctx)[0]?.body.routes).toEqual(routes);
    await expect.element(page.getByTestId(dialog)).toBeVisible();
  },
);

// Catches Escape dismissing the create dialog while the key is being created.
test("the create dialog cannot be dismissed while its write is pending", async () => {
  const ctx = await setup("/invites");
  await page.getByTestId("open-create-invite").click();
  const release = ctx.pauseWrites();
  await page.getByTestId("create-invite").click();
  await userEvent.keyboard("{Escape}");
  // data-open drops the moment the dialog starts closing, while it stays visible during its exit animation.
  await expect.element(page.getByTestId("invite-create-dialog")).toHaveAttribute("data-open");
  release();
  await expect.element(page.getByTestId("invite-create-dialog")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  expect(posts(ctx)).toHaveLength(1);
});

// Catches Escape dismissing the expire dialog while the write is in flight.
test("the expire dialog cannot be dismissed while its write is pending", async () => {
  const ctx = await setup("/invites");
  await page.getByTestId("invite-actions-trigger-1").click();
  await page.getByTestId("expire-invite-1").click();
  const release = ctx.pauseWrites();
  await page.getByTestId("confirm-invite-action").click();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("expire-invite-dialog")).toBeVisible();
  release();
  await expect.element(page.getByTestId("expire-invite-dialog")).not.toBeInTheDocument();
  expect(posts(ctx)).toHaveLength(1);
});

// Catches the create form keeping an owner who no longer exists.
test("the create form falls back to the first visible owner when the default owner is gone", async () => {
  await setup("/invites", (backend) => {
    backend.users = [bob];
  });
  await page.getByTestId("open-create-invite").click();
  await expect.element(page.getByTestId("invite-user")).toHaveValue("2");
});

// Catches the create form offering a hidden or missing owner when no user is visible.
test("the create form has no owner when no user is visible", async () => {
  await setup("/invites", (backend) => {
    backend.users = [{ id: "9", name: "tagged-devices" }];
  });
  await page.getByTestId("open-create-invite").click();
  await expect.element(page.getByTestId("invite-user")).toHaveValue("");
  await page.getByTestId("create-invite").click();
  await expect.element(page.getByTestId("invite-create-dialog")).toBeVisible();
});

// Catches a plain subnet route being presented (or approved) with the exit-route wording and styling.
test("a plain subnet route is approved without the exit-route warning", async () => {
  const ctx = await setup("/routes", (backend) => {
    routeNode(backend).availableRoutes = ["10.42.0.0/16", "172.16.0.0/12"];
  });
  const copy = getProductCopy("en-US");
  await openSettled(ctx, "approve-route-1-0");
  await expect
    .element(page.getByTestId("approve-route-dialog"))
    .toMatchTextContent(copy.approveRouteTitle);
  await page.getByTestId("approve-route-confirm").click();
  await expect.element(page.getByTestId("approve-route-dialog")).not.toBeInTheDocument();
  expect(posts(ctx)[0]?.body.routes).toEqual(["10.42.0.0/16", "192.168.0.0/24", "172.16.0.0/12"]);
});

test("approving all plain subnet routes uses the plain wording", async () => {
  const ctx = await setup("/routes", (backend) => {
    routeNode(backend).availableRoutes = ["10.42.0.0/16", "172.16.0.0/12"];
  });
  const copy = getProductCopy("en-US");
  await openSettled(ctx, "approve-routes-1");
  await expect
    .element(page.getByTestId("approve-routes-dialog"))
    .toMatchTextContent(copy.approveRoutesTitle);
  await page.getByTestId("approve-routes-confirm").click();
  await expect.element(page.getByTestId("approve-routes-dialog")).not.toBeInTheDocument();
  expect(posts(ctx)[0]?.body.routes).toEqual(["10.42.0.0/16", "192.168.0.0/24", "172.16.0.0/12"]);
});

// Catches a tag-managed device exposing its internal owner as a link.
test("a node owned by the tag-managed user has no owner link", async () => {
  await setup("/routes", (backend) => {
    routeNode(backend).user = { id: "9", name: "tagged-devices" };
  });
  await expect.element(page.getByTestId("route-node-1")).toBeVisible();
  await expect.element(page.getByTestId("route-user-link-1")).not.toBeInTheDocument();
});
