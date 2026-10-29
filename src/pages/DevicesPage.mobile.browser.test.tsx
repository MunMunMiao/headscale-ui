import "fake-indexeddb/auto";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { setLocale } from "@/i18n";
import {
  authenticateTestSession,
  prepareTestSession,
  renderSessionPage,
} from "@/test/session";
import { snapshotFixture } from "@/test-utils/headscale.test";
import DevicesPage from "./DevicesPage";

// Base UI caches platform detection on import. Emulate Android before importing the UI,
// including UA client hints used by development builds, not only a narrow desktop viewport.
await vi.hoisted(async () => {
  const { cdp } = await import("vitest/browser");
  await cdp().send("Emulation.setUserAgentOverride", {
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36",
    platform: "Android",
    userAgentMetadata: {
      brands: [{ brand: "Chromium", version: "152" }],
      fullVersion: "152.0.0.0",
      platform: "Android",
      platformVersion: "14.0.0",
      architecture: "arm",
      model: "Pixel 8",
      mobile: true,
    },
  });
  await cdp().send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 5,
  });
});

afterAll(async () => {
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await cdp().send("Emulation.setUserAgentOverride", { userAgent: "" });
  await cdp().send("Emulation.clearDeviceMetricsOverride");
  await page.viewport(1366, 900);
});
afterEach(() => vi.restoreAllMocks());

async function setup() {
  await page.viewport(320, 812);
  await cdp().send("Emulation.setDeviceMetricsOverride", {
    width: 320,
    height: 812,
    deviceScaleFactor: 1,
    mobile: true,
  });
  const snapshot = snapshotFixture();
  snapshot.nodes[0].tags = ["tag:legacy", "tag:extra"];
  snapshot.policy = { policy: '{"tagOwners":{"tag:prod":[],"tag:extra":[]}}' };
  const writes: string[] = [];
  const session = await prepareTestSession(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method !== "GET") writes.push(`${request.method} ${path}`);
    const readings: Record<string, unknown> = {
      "/api/v1/health": snapshot.health,
      "/version": snapshot.version,
      "/api/v1/user": { users: snapshot.users },
      "/api/v1/node": { nodes: snapshot.nodes },
      "/api/v1/preauthkey": { preAuthKeys: snapshot.preAuthKeys },
      "/api/v1/apikey": { apiKeys: snapshot.apiKeys },
      "/api/v1/policy": snapshot.policy,
    };
    return Response.json(readings[path]);
  });
  await setLocale("en-US");
  await authenticateTestSession(session);
  const rendered = await renderSessionPage(
    session,
    <DevicesPage />,
    "/devices",
  );
  await expect.poll(() => session.snapshot.getSnapshot().isReady).toBe(true);
  await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
  expect(window.innerWidth).toBe(320);
  expect(window.innerHeight).toBe(812);
  expect(
    document.querySelector('meta[name="viewport"]')?.getAttribute("content"),
  ).toContain("width=device-width");
  expect(navigator.platform).toBe("Android");
  expect(navigator.userAgent).toContain("Android 14; Pixel 8");
  expect(navigator.maxTouchPoints).toBe(5);
  expect(matchMedia("(pointer: coarse)").matches).toBe(true);
  return { writes, snapshot, session, ...rendered };
}

async function press(testId: string, input: "virtual" | "pointer" | "touch") {
  const element = page.getByTestId(testId).element();
  element.scrollIntoView({ block: "center" });
  await new Promise(requestAnimationFrame);
  const bounds = element.getBoundingClientRect();
  const frame = window.frameElement?.getBoundingClientRect();
  const x = bounds.x + bounds.width / 2 + (frame?.x ?? 0);
  const y = bounds.y + bounds.height / 2 + (frame?.y ?? 0);
  if (input === "touch") {
    await cdp().send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y, force: 0.5 }],
    });
    await cdp().send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } else {
    await cdp().send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await cdp().send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
      force: input === "virtual" ? 0 : 0.5,
    });
    await cdp().send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
  }
}

test.each(
  [
    ["edit-node-tags", "node-tags-dialog"],
    ["rename-node", "rename-node-dialog"],
    ["view-node-details", "device-detail-dialog"],
    ["restore-personal", "add-device-dialog"],
    ["expire-node", "expire-node-dialog"],
    ["remove-node", "remove-node-dialog"],
  ].flatMap(([action, dialogId]) =>
    (["virtual", "pointer", "touch"] as const).map((input) => ({
      action,
      dialogId,
      input,
    })),
  ),
)(
  "Android $input $action returns focus to the original device actions trigger",
  async ({ action, dialogId, input }) => {
    const ctx = await setup();
    const focusHistory: string[] = [];
    const trackFocus = (event: FocusEvent) => {
      const target = event.target as HTMLElement;
      focusHistory.push(target.dataset.testid || target.tagName);
    };
    document.addEventListener("focusin", trackFocus);
    try {
      const trigger = page.getByTestId("machine-actions-trigger-mobile-1");
      await press("machine-actions-trigger-mobile-1", input);
      await expect
        .element(page.getByTestId(`${action}-action-mobile-1`))
        .toBeVisible();
      await press(`${action}-action-mobile-1`, input);
      await expect.element(page.getByTestId(dialogId)).toBeVisible();
      if (action === "edit-node-tags") {
        await page.getByTestId("node-tags-search").click();
        await page.getByTestId("node-tags-search").fill("tag:prod");
        await userEvent.keyboard("{Enter}");
        await expect
          .element(page.getByTestId("node-tags-remove-tag:legacy"))
          .toBeVisible();
        await expect
          .element(page.getByTestId("node-tags-remove-tag:extra"))
          .toBeVisible();
        expect(
          document.querySelector('[data-testid="node-tags-review"]'),
        ).toBeNull();
      }
      await userEvent.keyboard("{Escape}");
      await expect.element(page.getByTestId(dialogId)).not.toBeInTheDocument();
      await expect.element(trigger).toBeVisible();
      await expect
        .element(trigger, { message: focusHistory.join(" → ") })
        .toHaveFocus();
      expect(ctx.writes).toHaveLength(0);
    } finally {
      document.removeEventListener("focusin", trackFocus);
    }
  },
);

test("keyboard menu navigation returns focus after closing the tag editor", async () => {
  const ctx = await setup();
  const trigger = page.getByTestId("machine-actions-trigger-mobile-1");
  (trigger.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByTestId("view-node-details-action-mobile-1"))
    .toHaveFocus();
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
  await expect.element(page.getByTestId("node-tags-dialog")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(trigger).toHaveFocus();
  expect(ctx.writes).toHaveLength(0);
});

test("direct details and setup openers do not reuse a previous row menu trigger", async () => {
  const ctx = await setup();
  await press("machine-actions-trigger-mobile-1", "virtual");
  await expect
    .element(page.getByTestId("edit-node-tags-action-mobile-1"))
    .toBeVisible();
  await press("edit-node-tags-action-mobile-1", "virtual");
  await expect.element(page.getByTestId("node-tags-dialog")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByTestId("machine-actions-trigger-mobile-1"))
    .toHaveFocus();
  await press("device-detail-link-2", "virtual");
  await expect.element(page.getByTestId("device-detail-dialog")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("device-detail-link-2")).toHaveFocus();
  await press("add-device-toggle", "virtual");
  await expect.element(page.getByTestId("add-device-dialog")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("add-device-toggle")).toHaveFocus();
  expect(ctx.writes).toHaveLength(0);
});

test("tag editor to personal restoration retains the original row trigger", async () => {
  const ctx = await setup();
  await press("machine-actions-trigger-mobile-1", "virtual");
  await expect
    .element(page.getByTestId("edit-node-tags-action-mobile-1"))
    .toBeVisible();
  await press("edit-node-tags-action-mobile-1", "virtual");
  await expect.element(page.getByTestId("node-tags-restore")).toBeEnabled();
  await press("node-tags-restore", "virtual");
  const dialog = page.getByTestId("add-device-dialog");
  await expect.element(dialog).toBeVisible();
  await expect
    .poll(() => dialog.element().contains(document.activeElement))
    .toBe(true);
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByTestId("machine-actions-trigger-mobile-1"))
    .toHaveFocus();
  expect(ctx.writes).toHaveLength(0);
});

test("a removed row opener falls back to existing focus history without focusing a detached node", async () => {
  const ctx = await setup();
  const fallback = page.getByTestId("device-detail-link-2");
  (fallback.element() as HTMLElement).focus();
  await press("machine-actions-trigger-mobile-1", "virtual");
  await expect
    .element(page.getByTestId("edit-node-tags-action-mobile-1"))
    .toBeVisible();
  await press("edit-node-tags-action-mobile-1", "virtual");
  await expect.element(page.getByTestId("node-tags-dialog")).toBeVisible();
  const original = page
    .getByTestId("machine-actions-trigger-mobile-1")
    .element() as HTMLElement;
  const focus = vi.spyOn(original, "focus");
  ctx.snapshot.nodes = ctx.snapshot.nodes.filter((node) => node.id !== "1");
  expect(await ctx.session.snapshot.refreshSegments(["fabric"])).toBe(true);
  await expect.poll(() => original.isConnected).toBe(false);
  await userEvent.keyboard("{Escape}");
  await expect.element(fallback).toHaveFocus();
  expect(focus).not.toHaveBeenCalled();
  expect(ctx.writes).toHaveLength(0);
});
