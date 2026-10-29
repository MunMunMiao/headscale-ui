import "fake-indexeddb/auto";
import type { FetchHandle } from "@defjs/core";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import type { HeadscaleSnapshot } from "@/api/contracts";
import { setLocale } from "@/i18n";
import {
  authenticateTestSession,
  prepareTestSession,
  renderSessionPage,
} from "@/test/session";
import HomePage from "./HomePage";
import RoutesPage from "./RoutesPage";

afterEach(() => vi.restoreAllMocks());

async function setup(element: ReactNode = <RoutesPage />, path = "/routes") {
  const backend: HeadscaleSnapshot = {
    health: { databaseConnectivity: true, serverReachable: true },
    version: { version: "0.29.4" },
    users: [{ id: "1", name: "alice" }],
    apiKeys: [],
    preAuthKeys: [],
    policy: { policy: '{"acls":[]}' },
    nodes: [
      {
        id: "1",
        name: "edge-router",
        online: false,
        lastSeen: "2026-01-01T12:00:00Z",
        expiry: "2099-01-01T00:00:00Z",
        ipAddresses: ["100.64.0.1"],
        tags: [],
        approvedRoutes: ["10.1.0.0/16"],
        availableRoutes: ["10.1.0.0/16", "10.2.0.0/16", "10.3.0.0/16"],
        subnetRoutes: [],
      },
    ],
  };
  const failures = new Set<string>();
  const writes: string[][] = [];
  let failReadsAfterWrite = false;
  let heldNodes: Promise<void> | undefined;
  const transport: FetchHandle = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const pathname = new URL(request.url).pathname;
    if (request.method === "GET" && pathname === "/api/v1/node")
      await heldNodes;
    if (
      request.method === "POST" &&
      pathname === "/api/v1/node/1/approve_routes"
    ) {
      const { routes } = await request.json();
      writes.push(routes);
      backend.nodes[0].approvedRoutes = routes;
      if (failReadsAfterWrite) failures.add("/api/v1/node");
      return Response.json({ node: backend.nodes[0] });
    }
    if (failures.has(pathname))
      return Response.json(
        { message: "Fresh read unavailable" },
        { status: 503 },
      );
    const reads: Record<string, unknown> = {
      "/api/v1/health": backend.health,
      "/version": backend.version,
      "/api/v1/user": { users: backend.users },
      "/api/v1/node": { nodes: backend.nodes },
      "/api/v1/preauthkey": { preAuthKeys: backend.preAuthKeys },
      "/api/v1/apikey": { apiKeys: backend.apiKeys },
      "/api/v1/policy": backend.policy,
    };
    return Response.json(reads[pathname]);
  };
  const session = await prepareTestSession(transport);
  setLocale("en-US");
  await authenticateTestSession(session);
  const { router } = await renderSessionPage(session, element, path);
  await expect.poll(() => session.snapshot.getSnapshot().isReady).toBe(true);
  await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
  return {
    backend,
    session,
    router,
    failures,
    writes,
    pauseNodes: () => {
      const deferred = Promise.withResolvers<void>();
      heldNodes = deferred.promise;
      return () => {
        heldNodes = undefined;
        deferred.resolve();
      };
    },
    failReadsAfterWrite: () => {
      failReadsAfterWrite = true;
    },
  };
}

test("overview links the counted online devices through the supported online filter", async () => {
  const ctx = await setup(<HomePage />, "/");
  ctx.backend.nodes.push({
    ...ctx.backend.nodes[0],
    id: "2",
    name: "online-node",
    online: true,
  });
  await ctx.session.snapshot.refreshSnapshot();
  await expect
    .element(page.getByTestId("overview-stat-online"))
    .toMatchTextContent("1");
  await page.getByTestId("overview-stat-online").click();
  await expect.poll(() => ctx.router.state.location.pathname).toBe("/devices");
  expect(ctx.router.state.location.search).toEqual({ filter: "online" });
});

test("overview names and counts only unused, unexpired auth keys, including those without expiry", async () => {
  const ctx = await setup(<HomePage />, "/");
  const key = {
    key: "prefix",
    reusable: false,
    ephemeral: false,
    used: false,
    aclTags: [],
  };
  ctx.backend.preAuthKeys = [
    { ...key, id: "1", expiration: "2099-01-01T00:00:00Z" },
    { ...key, id: "2", expiration: null },
    { ...key, id: "3", expiration: "2000-01-01T00:00:00Z" },
    { ...key, id: "4", used: true },
    { ...key, id: "5", used: true, reusable: true },
  ];
  await ctx.session.snapshot.refreshSnapshot();
  const stat = page.getByTestId("overview-stat-invites");
  await expect
    .element(stat)
    .toHaveAccessibleName("Unused, unexpired auth keys 2");
  await stat.click();
  await expect.poll(() => ctx.router.state.location.pathname).toBe("/invites");
});

test.each([
  [false, "2099-01-01T00:00:00Z", "Offline"],
  [true, "2099-01-01T00:00:00Z", "Online"],
  [false, "2000-01-01T00:00:00Z", "Expired"],
])(
  "route node context shows online=%s expiry=%s without banning approval",
  async (online, expiry, status) => {
    const ctx = await setup();
    Object.assign(ctx.backend.nodes[0], { online, expiry });
    await ctx.session.snapshot.refreshSnapshot();
    await expect
      .element(page.getByTestId("route-node-status-1"))
      .toHaveTextContent(status);
    await expect
      .element(page.getByTestId("route-node-expiry-1"))
      .toMatchTextContent("Expires:");
    if (!online) {
      await expect
        .element(page.getByTestId("route-node-last-seen-1"))
        .toMatchTextContent("Last seen:");
      await expect
        .element(page.getByTestId("route-node-last-seen-1"))
        .toMatchTextContent("2026");
    } else
      await expect
        .element(page.getByTestId("route-node-last-seen-1"))
        .not.toBeInTheDocument();
    await page.getByTestId("approve-route-1-0").click();
    await expect
      .element(page.getByTestId("approve-route-confirm"))
      .toBeEnabled();
    await page.getByTestId("approve-route-cancel").click();
  },
);

// A full-set write after a failed pre-read must not erase another administrator's route.
test.each([
  [
    "approve-route",
    "approve-route-1-0",
    ["10.1.0.0/16", "10.4.0.0/16", "10.2.0.0/16"],
  ],
  [
    "approve-routes",
    "approve-routes-1",
    ["10.1.0.0/16", "10.4.0.0/16", "10.2.0.0/16", "10.3.0.0/16"],
  ],
  ["revoke-route", "revoke-route-1-0", ["10.4.0.0/16"]],
] as const)(
  "%s blocks stale writes, allows cancel and retries with the latest approved set",
  async (action, trigger, expected) => {
    const ctx = await setup();
    ctx.backend.nodes[0].approvedRoutes.push("10.4.0.0/16");
    ctx.failures.add("/api/v1/node");
    await page.getByTestId(trigger).click();
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
    const confirm = page.getByTestId(`${action}-confirm`);
    await expect.element(confirm).toBeDisabled();
    (confirm.element() as HTMLButtonElement).click();
    expect(ctx.writes).toEqual([]);
    const error = page.getByTestId(`${action}-error`);
    await error.getByText("Details", { exact: true }).click();
    await expect
      .element(error.getByText(/Fresh read unavailable/))
      .toBeVisible();
    await page.getByTestId(`${action}-cancel`).click();
    await expect
      .element(page.getByTestId(`${action}-dialog`))
      .not.toBeInTheDocument();
    await page.getByTestId(trigger).click();
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
    ctx.failures.clear();
    await page.getByTestId(`${action}-retry`).click();
    await expect.element(confirm).toBeEnabled();
    await confirm.click();
    await expect
      .element(page.getByTestId(`${action}-dialog`))
      .not.toBeInTheDocument();
    expect(ctx.writes).toEqual([expected]);
    expect(ctx.backend.nodes[0].approvedRoutes).toEqual(expected);
  },
);

test.each([
  ["approve-route", "approve-route-1-0"],
  ["approve-routes", "approve-routes-1"],
  ["revoke-route", "revoke-route-1-0"],
])(
  "a superseded %s pre-read remains blocked and can be retried",
  async (action, trigger) => {
    const ctx = await setup();
    const release = ctx.pauseNodes();
    await page.getByTestId(trigger).click();
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(true);
    const newer = ctx.session.snapshot.refreshSegments(["fabric"]);
    release();
    await newer;
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
    await expect.element(page.getByTestId(`${action}-confirm`)).toBeDisabled();
    const error = page.getByTestId(`${action}-error`);
    await expect.element(error).toBeVisible();
    await expect.element(error).toMatchTextContent("Refresh route data");
    expect(ctx.writes).toEqual([]);
    await page.getByTestId(`${action}-retry`).click();
    await expect.element(page.getByTestId(`${action}-confirm`)).toBeEnabled();
    await page.getByTestId(`${action}-cancel`).click();
  },
);

test("policy and health failures do not block approval after a successful nodes read", async () => {
  const ctx = await setup();
  ctx.backend.nodes[0].approvedRoutes.push("10.4.0.0/16");
  ctx.failures.add("/api/v1/policy");
  ctx.failures.add("/api/v1/health");
  await page.getByTestId("approve-route-1-0").click();
  await expect.element(page.getByTestId("approve-route-confirm")).toBeEnabled();
  await page.getByTestId("approve-route-confirm").click();
  await expect
    .element(page.getByTestId("approve-route-dialog"))
    .not.toBeInTheDocument();
  expect(ctx.writes).toEqual([["10.1.0.0/16", "10.4.0.0/16", "10.2.0.0/16"]]);
});

test("a successful route write stays successful when its follow-up nodes read fails", async () => {
  const ctx = await setup();
  await page.getByTestId("approve-route-1-0").click();
  await expect.element(page.getByTestId("approve-route-confirm")).toBeEnabled();
  ctx.failReadsAfterWrite();
  await page.getByTestId("approve-route-confirm").click();
  await expect
    .element(page.getByTestId("approve-route-dialog"))
    .not.toBeInTheDocument();
  expect(ctx.writes).toEqual([["10.1.0.0/16", "10.2.0.0/16"]]);
  expect(ctx.session.snapshot.getSnapshot().refreshErrors.fabric).toContain(
    "Fresh read unavailable",
  );
  expect(ctx.session.feedback.actionError("approve-route")).toBe("");
});
