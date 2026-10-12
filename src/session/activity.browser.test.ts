import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createManualClock } from "@/test/session-clock";
import { attachSessionActivity, type SessionActivityBridge } from "./activity";
import { createAuthSession, SESSION_IDLE_MS } from "./auth-session";
import type { SessionIdentity } from "./types";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function fixture() {
  const container = document.createElement("section");
  container.innerHTML = `
    <button type="button" data-testid="activity-button">Session action</button>
    <input aria-label="Session input" data-testid="activity-input" />
    <div data-testid="activity-scroll" style="height: 100px; width: 200px; overflow: auto">
      <div style="height: 1000px">Scrollable content</div>
    </div>
  `;
  document.body.append(container);
  cleanups.push(() => container.remove());
  const input = container.querySelector("input");
  const button = container.querySelector("button");
  const scroller = container.querySelector<HTMLElement>('[data-testid="activity-scroll"]');
  if (!input || !button || !scroller) throw new Error("Missing activity test controls");
  input.focus();
  expect(document.activeElement).toBe(input);
  expect(document.visibilityState).toBe("visible");

  const events: Event[] = [];
  const record = (event: Event) => events.push(event);
  for (const type of ["pointerdown", "keydown", "wheel", "input", "mousemove", "scroll"]) {
    document.addEventListener(type, record, true);
    cleanups.push(() => document.removeEventListener(type, record, true));
  }
  for (const type of ["focus", "pageshow"]) {
    window.addEventListener(type, record, true);
    cleanups.push(() => window.removeEventListener(type, record, true));
  }

  const clock = createManualClock(0);
  const session = createAuthSession({
    workerId: "activity-worker",
    now: clock.now,
    newSessionId: () => "activity-session",
    openCredential: async (request) => ({
      profile: {
        id: request.profileId,
        name: "Activity profile",
        baseUrl: "https://headscale.test",
      },
      credentialVersion: request.expectedCredentialVersion,
      keyEpoch: "activity-epoch",
      apiKey: "test-activity-credential",
    }),
    readCurrentProfile: async (candidate) => candidate.profile,
    validateCredential: async () => {},
    execute: async () => ({ ok: true, value: undefined }),
  });
  const unlocked = await session.unlock({
    profileId: "activity-profile",
    password: "test activity password",
    expectedWorkerId: "activity-worker",
    expectedIdentity: null,
    expectedCredentialVersion: "activity-credential",
    operationId: "activity-unlock",
    ownerTabId: "activity-tab",
    portId: "activity-port",
  });
  expect(unlocked.ok).toBe(true);
  const bridge = {
    getSessionSnapshot: session.getSnapshot,
    touch: vi.fn(async (expected: SessionIdentity) => session.touch(expected)),
    check: vi.fn(async () => session.check()),
    suspend: vi.fn(),
    resume: vi.fn(async () => session.check()),
    dispose: vi.fn(),
  } satisfies SessionActivityBridge;
  const attach = () => {
    const dispose = attachSessionActivity({ document, window, now: clock.now }, bridge);
    cleanups.push(dispose);
    return dispose;
  };
  return { attach, bridge, clock, session, events, input, button, scroller };
}

test.each(["pointerdown", "keydown", "wheel", "input"])(
  "Chromium's trusted %s immediately extends the session deadline",
  async (type) => {
    const { attach, bridge, clock, session, events } = await fixture();
    attach();
    clock.advance(5_000);
    if (type === "pointerdown") await page.getByTestId("activity-button").click();
    if (type === "keydown") await userEvent.keyboard("{ArrowRight}");
    if (type === "wheel") await page.getByTestId("activity-scroll").wheel({ delta: { y: 80 } });
    if (type === "input") await page.getByTestId("activity-input").fill("Native input");

    await expect.poll(() => bridge.touch.mock.calls.length).toBe(1);
    expect(
      events
        .filter((event) => ["pointerdown", "keydown", "wheel", "input"].includes(event.type))
        .map((event) => ({ type: event.type, isTrusted: event.isTrusted })),
    ).toEqual([{ type, isTrusted: true }]);
    expect(bridge.touch).toHaveBeenCalledWith({
      workerId: "activity-worker",
      sessionId: "activity-session",
    });
    expect(session.getSnapshot().expiresAt).toBe(SESSION_IDLE_MS + 5_000);
  },
);

test("foreground events share a one-second leading throttle", async () => {
  const { attach, bridge, clock, session, events } = await fixture();
  attach();
  await page.getByTestId("activity-button").click();
  expect(bridge.touch).toHaveBeenCalledTimes(1);
  clock.advance(999);
  await page.getByTestId("activity-input").fill("Within the throttle");
  await userEvent.keyboard("{ArrowRight}");
  await page.getByTestId("activity-scroll").wheel({ delta: { y: 80 } });
  await expect.poll(() => events.some((event) => event.type === "wheel")).toBe(true);
  expect(bridge.touch).toHaveBeenCalledTimes(1);
  expect(session.getSnapshot().expiresAt).toBe(SESSION_IDLE_MS);
  clock.advance(1);
  await page.getByTestId("activity-input").fill("At the throttle boundary");
  expect(bridge.touch).toHaveBeenCalledTimes(2);
  expect(session.getSnapshot().expiresAt).toBe(SESSION_IDLE_MS + 1_000);
});

test("synthetic activity, native scrolling, movement and focus do not renew", async () => {
  const { attach, bridge, clock, session, events, input, button, scroller } = await fixture();
  attach();
  clock.advance(5_000);
  button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a" }));
  scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 80 }));
  input.value = "Programmatic input";
  input.dispatchEvent(new InputEvent("input", { bubbles: true, data: input.value }));
  expect(events.filter((event) => !event.isTrusted).map((event) => event.type)).toEqual([
    "pointerdown",
    "keydown",
    "wheel",
    "input",
  ]);

  scroller.scrollTo({ top: 80, behavior: "instant" });
  await expect.poll(() => events.some((event) => event.type === "scroll")).toBe(true);
  expect(scroller.scrollTop).toBe(80);
  expect(events.find((event) => event.type === "scroll")?.isTrusted).toBe(true);
  await page.getByTestId("activity-button").hover();
  await page.getByTestId("activity-input").hover();
  expect(events.some((event) => event.type === "mousemove" && event.isTrusted)).toBe(true);

  button.focus();
  expect(events.some((event) => event.type === "focus" && event.isTrusted)).toBe(true);
  expect(bridge.resume).toHaveBeenCalledTimes(1);
  await bridge.resume.mock.results[0]?.value;
  // A DOM pageshow delivery checks the listener; BFCache restoration is a deployment test.
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  expect(bridge.resume).toHaveBeenCalledTimes(2);
  await bridge.resume.mock.results[1]?.value;
  expect(bridge.touch).not.toHaveBeenCalled();
  expect(session.getSnapshot().expiresAt).toBe(SESSION_IDLE_MS);
});

test("dispose and reattach leave exactly one activity listener and release lifecycle listeners", async () => {
  const { attach, bridge, clock } = await fixture();
  const first = attach();
  first();
  first();
  const second = attach();
  await page.getByTestId("activity-button").click();
  expect(bridge.touch).toHaveBeenCalledTimes(1);
  second();
  const resumesBeforeDisposal = bridge.resume.mock.calls.length;
  clock.advance(1_000);
  await page.getByTestId("activity-input").click();
  await userEvent.keyboard("x");
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  expect(bridge.touch).toHaveBeenCalledTimes(1);
  expect(bridge.resume).toHaveBeenCalledTimes(resumesBeforeDisposal);
  attach();
  await page.getByTestId("activity-button").click();
  expect(bridge.touch).toHaveBeenCalledTimes(2);
});

test.each([SESSION_IDLE_MS, SESSION_IDLE_MS + 1])(
  "a click at %i ms expires the session without running a timer",
  async (elapsed) => {
    const { attach, bridge, clock, session, events } = await fixture();
    attach();
    const unlocked = session.getSnapshot();
    clock.advance(elapsed);
    expect(session.getSnapshot()).toBe(unlocked);
    expect(unlocked.status).toBe("unlocked");
    expect(bridge.touch).not.toHaveBeenCalled();

    await page.getByTestId("activity-button").click();
    expect(events.some((event) => event.type === "pointerdown" && event.isTrusted)).toBe(true);
    expect(bridge.touch).toHaveBeenCalledTimes(1);
    await expect(bridge.touch.mock.results[0]?.value).resolves.toEqual({
      ok: false,
      error: { kind: "expired" },
    });
    expect(session.getSnapshot()).toMatchObject({
      status: "locked",
      identity: null,
      profile: null,
      expiresAt: null,
      reason: "expired",
    });
    await page.getByTestId("activity-button").click();
    expect(bridge.touch).toHaveBeenCalledTimes(1);
  },
);
