import "fake-indexeddb/auto";
import type { FetchHandle } from "@defjs/core";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { HeadscaleSnapshot } from "@/api/contracts";
import { i18n, setLocale } from "@/i18n";
import { commonDescriptors, productDescriptors } from "@/i18n/descriptors";
import { getProductCopy } from "@/i18n/product-copy";
import {
  authenticateTestSession,
  prepareTestSession,
  renderSessionPage,
} from "@/test/session";
import RoutesPage from "./RoutesPage";

afterEach(() => vi.restoreAllMocks());

async function setup() {
  await page.viewport(1366, 900);
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
        online: true,
        user: { id: "1", name: "alice" },
        ipAddresses: ["100.64.0.1"],
        tags: [],
        approvedRoutes: ["10.1.0.0/16"],
        availableRoutes: ["10.1.0.0/16", "10.2.0.0/16", "10.3.0.0/16"],
        subnetRoutes: [],
      },
    ],
  };
  const writes: string[][] = [];
  let readFailure = false;
  let failAfterWrite = false;
  let writeFailure = false;
  let heldWrite: Promise<void> | undefined;
  let heldRead: Promise<void> | undefined;
  const transport: FetchHandle = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/api/v1/node/1/approve_routes") {
      const { routes } = await request.json();
      writes.push(routes);
      await heldWrite;
      if (writeFailure)
        return Response.json(
          { message: "Route operator diagnostic" },
          { status: 400 },
        );
      backend.nodes[0].approvedRoutes = routes;
      if (failAfterWrite) readFailure = true;
      return Response.json({ node: backend.nodes[0] });
    }
    if (request.method !== "GET")
      throw new Error(`Unexpected write ${request.method} ${path}`);
    if (path === "/api/v1/node") {
      await heldRead;
      if (readFailure)
        return Response.json(
          { message: "Fresh read unavailable" },
          { status: 503 },
        );
    }
    const reads: Record<string, unknown> = {
      "/api/v1/health": backend.health,
      "/version": backend.version,
      "/api/v1/user": { users: backend.users },
      "/api/v1/node": { nodes: backend.nodes },
      "/api/v1/preauthkey": { preAuthKeys: backend.preAuthKeys },
      "/api/v1/apikey": { apiKeys: backend.apiKeys },
      "/api/v1/policy": backend.policy,
    };
    return Response.json(reads[path]);
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
  const rendered = await renderSessionPage(session, <RoutesPage />, "/routes");
  await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
  return {
    backend,
    session,
    writes,
    ...rendered,
    failRead(value = true) {
      readFailure = value;
    },
    failWrite() {
      writeFailure = true;
    },
    failRefresh() {
      failAfterWrite = true;
    },
    holdWrites() {
      const held = Promise.withResolvers<void>();
      heldWrite = held.promise;
      return () => {
        heldWrite = undefined;
        held.resolve();
      };
    },
    holdReads() {
      const held = Promise.withResolvers<void>();
      heldRead = held.promise;
      return () => {
        heldRead = undefined;
        held.resolve();
      };
    },
  };
}

function currentToasts() {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-slot="toast"]:not([data-ending-style])',
    ),
  );
}
const actions = [
  ["approve-route", "approve-route-1-0", ["10.1.0.0/16", "10.2.0.0/16"]],
  [
    "approve-routes",
    "approve-routes-1",
    ["10.1.0.0/16", "10.2.0.0/16", "10.3.0.0/16"],
  ],
  ["revoke-route", "revoke-route-1-0", []],
] as const;

test("long route approval keeps its full list scrollable and its actions reachable on a phone", async () => {
  const ctx = await setup();
  await page.viewport(375, 700);
  const routes = Array.from(
    { length: 30 },
    (_, index) => `10.${index + 1}.0.0/16`,
  );
  ctx.backend.nodes[0].availableRoutes = routes;
  ctx.backend.nodes[0].approvedRoutes = [];
  await page.getByTestId("approve-routes-1").click();
  const confirm = page.getByTestId("approve-routes-confirm");
  const cancel = page.getByTestId("approve-routes-cancel");
  await expect.element(confirm).toBeEnabled();
  const review = page.getByTestId("approve-routes-dialog");
  const dialog = review.element();
  await expect
    .poll(() =>
      dialog
        .getAnimations({ subtree: true })
        .some((animation) => animation.playState === "running"),
    )
    .toBe(false);
  expect(
    review
      .getByTestId(/^approve-routes-target-/)
      .elements()
      .map((element) => element.textContent),
  ).toEqual(routes);
  const bounds = dialog.getBoundingClientRect();
  expect(bounds.top).toBeGreaterThanOrEqual(15.5);
  expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight - 15.5);
  expect(dialog.scrollHeight).toBeGreaterThan(dialog.clientHeight);

  await review.wheel({ delta: { y: -dialog.scrollHeight } });
  await expect.poll(() => dialog.scrollTop).toBe(0);
  await review.wheel({ delta: { y: dialog.scrollHeight } });
  await expect
    .poll(() =>
      Math.abs(dialog.scrollHeight - dialog.clientHeight - dialog.scrollTop),
    )
    .toBeLessThanOrEqual(1);
  expect(dialog.scrollTop).toBeGreaterThan(0);
  for (const action of [confirm, cancel]) {
    const actionBounds = action.element().getBoundingClientRect();
    expect(actionBounds.top).toBeGreaterThanOrEqual(bounds.top);
    expect(actionBounds.bottom).toBeLessThanOrEqual(bounds.bottom);
  }
  await cancel.click();
  await expect.element(review).not.toBeInTheDocument();
  expect(ctx.writes).toEqual([]);
  expect(ctx.backend.nodes[0].approvedRoutes).toEqual([]);
});

// The dialogs close on confirmation. A missing or reused operation token loses or misattributes
// that result; a failed subsequent GET must not transform the successful write into a retry.
test.each(actions)(
  "unified feedback: %s confirms the actual full-set write once",
  async (action, trigger, expected) => {
    const ctx = await setup();
    await page.getByTestId(trigger).click();
    await expect.element(page.getByTestId(`${action}-confirm`)).toBeEnabled();
    await page.getByTestId(`${action}-confirm`).click();
    await expect
      .element(page.getByTestId(`${action}-dialog`))
      .not.toBeInTheDocument();
    await expect.poll(() => currentToasts().length).toBe(1);
    expect(currentToasts()[0]?.textContent).toContain("Request confirmed");
    expect(
      currentToasts()[0]
        ?.querySelector('[data-slot="notice"]')
        ?.getAttribute("data-tone"),
    ).toBe("success");
    expect(ctx.writes).toEqual([expected]);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect.poll(() => currentToasts().length).toBe(0);
    expect(ctx.writes).toEqual([expected]);
    expect(ctx.session.feedback.actionOutcome(action)).toMatchObject({
      status: "confirmed",
      refresh: "succeeded",
    });
  },
);

test.each(actions)(
  "unified feedback: %s keeps a confirmed write successful when its refresh fails",
  async (action, trigger, expected) => {
    const ctx = await setup();
    await page.getByTestId(trigger).click();
    await expect.element(page.getByTestId(`${action}-confirm`)).toBeEnabled();
    ctx.failRefresh();
    await page.getByTestId(`${action}-confirm`).click();
    await expect
      .element(page.getByTestId(`${action}-dialog`))
      .not.toBeInTheDocument();
    await expect.poll(() => currentToasts().length).toBe(1);
    expect(currentToasts()[0]?.textContent).toContain("Request confirmed");
    expect(currentToasts()[0]?.textContent).toContain(
      getProductCopy("en-US").tagRefreshFailed,
    );
    expect(
      currentToasts()[0]
        ?.querySelector('[data-slot="notice"]')
        ?.getAttribute("data-tone"),
    ).toBe("warning");
    expect(ctx.writes).toEqual([expected]);
    expect(ctx.session.feedback.actionError(action)).toBe("");
    expect(ctx.session.feedback.actionOutcome(action)).toMatchObject({
      status: "confirmed",
      refresh: "failed",
    });
  },
);

test.each(actions)(
  "unified feedback: %s retains uncertain evidence in one persistent owner instead of a duplicate toast",
  async (action, trigger, expected) => {
    const ctx = await setup();
    await page.getByTestId(trigger).click();
    await expect.element(page.getByTestId(`${action}-confirm`)).toBeEnabled();
    ctx.failWrite();
    await page.getByTestId(`${action}-confirm`).click();
    const error = page.getByTestId(`${action}-error`);
    await expect.element(error).toBeVisible();
    await expect
      .element(
        error.getByText("The change may have been applied", { exact: true }),
      )
      .toBeVisible();
    expect(currentToasts()).toHaveLength(0);
    expect(error.element().querySelector("details")?.open).toBe(false);
    await error.getByText("Details", { exact: true }).click();
    await expect
      .element(error.getByText("Route operator diagnostic", { exact: true }))
      .toBeVisible();
    expect(ctx.writes).toEqual([expected]);
    expect(ctx.session.feedback.actionOutcome(action)?.status).toBe(
      "possibly-applied",
    );
  },
);

test.each(actions)(
  "unified feedback: %s read failure keeps its visible gate and retry without duplicate feedback",
  async (action, trigger) => {
    const ctx = await setup();
    ctx.failRead();
    await page.getByTestId(trigger).click();
    await expect.element(page.getByTestId(`${action}-retry`)).toBeVisible();
    await expect.element(page.getByTestId(`${action}-confirm`)).toBeDisabled();
    await expect
      .element(
        page
          .getByTestId(`${action}-error`)
          .getByText(getProductCopy("en-US").routeRefreshRequired, {
            exact: true,
          }),
      )
      .toBeVisible();
    expect(currentToasts()).toHaveLength(0);
    expect(ctx.writes).toEqual([]);
    ctx.backend.nodes[0].approvedRoutes.push("10.4.0.0/16");
    ctx.failRead(false);
    await page.getByTestId(`${action}-retry`).click();
    await expect.element(page.getByTestId(`${action}-confirm`)).toBeEnabled();
    await page.getByTestId(`${action}-cancel`).click();
    expect(ctx.writes).toEqual([]);
  },
);

test.each(actions)(
  "unified feedback: an unmounted %s owner cannot announce a late write",
  async (action, trigger, expected) => {
    const ctx = await setup();
    await page.getByTestId(trigger).click();
    await expect.element(page.getByTestId(`${action}-confirm`)).toBeEnabled();
    const release = ctx.holdWrites();
    try {
      await page.getByTestId(`${action}-confirm`).click();
      await expect.poll(() => ctx.writes.length).toBe(1);
      await ctx.router.navigate({ to: "/devices" });
    } finally {
      release();
    }
    await expect
      .poll(() => ctx.session.feedback.isActionPending(action))
      .toBe(false);
    expect(currentToasts()).toHaveLength(0);
    expect(ctx.writes).toEqual([expected]);
  },
);

test("unified feedback: consecutive route operations with the same title each announce their own result", async () => {
  const ctx = await setup();
  for (let attempt = 0; attempt < 2; ++attempt) {
    await page.getByTestId("approve-route-1-0").click();
    await expect
      .element(page.getByTestId("approve-route-confirm"))
      .toBeEnabled();
    await page.getByTestId("approve-route-confirm").click();
    await expect
      .element(page.getByTestId("approve-route-dialog"))
      .not.toBeInTheDocument();
  }
  await expect.poll(() => currentToasts().length).toBe(2);
  expect(ctx.writes).toEqual([
    ["10.1.0.0/16", "10.2.0.0/16"],
    ["10.1.0.0/16", "10.2.0.0/16", "10.3.0.0/16"],
  ]);
});

test.each([
  ["refresh-routes", "Refresh data"],
  ["revoke-route-1-0", "Revoke route: 10.1.0.0/16, edge-router"],
] as const)(
  "unified feedback: %s short help follows keyboard focus and Escape",
  async (id, name) => {
    await setup();
    const trigger = page.getByTestId(id);
    for (
      let step = 0;
      step < 20 && document.activeElement !== trigger.element();
      ++step
    )
      await userEvent.tab();
    await expect.element(trigger).toHaveFocus();
    await expect.element(page.getByText(name, { exact: true })).toBeVisible();
    expect(trigger.element().querySelector("button")).toBeNull();
    await userEvent.keyboard("{Escape}");
    await expect
      .element(page.getByText(name, { exact: true }))
      .not.toBeInTheDocument();
    await expect.element(trigger).toHaveFocus();
  },
);
