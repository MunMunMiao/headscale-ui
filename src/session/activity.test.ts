import { expect, test, vi } from "vitest";
import { createManualClock } from "@/test/session-clock";
import {
  attachSessionActivity,
  type SessionActivityBridge,
  type SessionActivitySource,
} from "./activity";
import type { PublicSessionSnapshot, SessionResult } from "./types";

function sourceTarget() {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  return {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
      if (!listener) return;
      const group = listeners.get(type) ?? new Set();
      group.add(listener);
      listeners.set(type, group);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
      if (listener) listeners.get(type)?.delete(listener);
    },
    fire(type: string, isTrusted = false, fields: Record<string, unknown> = {}) {
      const event = { ...fields, type, isTrusted } as Event;
      for (const listener of listeners.get(type) ?? []) {
        if (typeof listener === "function") listener(event);
        else listener.handleEvent(event);
      }
    },
    listenerCount() {
      return [...listeners.values()].reduce((sum, group) => sum + group.size, 0);
    },
  };
}

function fixture() {
  const clock = createManualClock(0);
  let snapshot: PublicSessionSnapshot = {
    status: "unlocked",
    identity: { workerId: "worker-a", sessionId: "session-a" },
    profile: { id: "a", name: "A", baseUrl: "https://headscale.test" },
    expiresAt: 1_800_000,
    pendingProfileId: null,
    reason: null,
    revision: 1,
    apiKeyPrefix: null,
  };
  const document = sourceTarget();
  const window = sourceTarget();
  const source: SessionActivitySource = { document, window, now: clock.now };
  const result = async (): Promise<SessionResult<PublicSessionSnapshot>> => ({
    ok: true,
    value: snapshot,
  });
  const bridge: SessionActivityBridge = {
    getSessionSnapshot: () => snapshot,
    touch: vi.fn(result),
    check: vi.fn(result),
    suspend: vi.fn(),
    resume: vi.fn(result),
    dispose: vi.fn(),
  };
  return {
    source,
    document,
    window,
    clock,
    bridge,
    replace: (value: PublicSessionSnapshot) => {
      snapshot = value;
    },
  };
}

test("trusted foreground activity renews immediately with a one-second leading throttle", () => {
  const { source, document, bridge, clock } = fixture();
  const dispose = attachSessionActivity(source, bridge);
  document.fire("pointerdown", true);
  expect(bridge.touch).toHaveBeenCalledWith({ workerId: "worker-a", sessionId: "session-a" });
  clock.advance(999);
  document.fire("keydown", true);
  document.fire("wheel", true);
  expect(bridge.touch).toHaveBeenCalledTimes(1);
  clock.advance(1);
  document.fire("input", true);
  expect(bridge.touch).toHaveBeenCalledTimes(2);
  clock.advance(1_800_000);
  expect(bridge.touch).toHaveBeenCalledTimes(2);
  dispose();
});

test("synthetic events, mouse movement and scroll never renew the session", () => {
  const { source, document, window, bridge } = fixture();
  const dispose = attachSessionActivity(source, bridge);
  for (const event of ["pointerdown", "keydown", "wheel", "input"]) document.fire(event);
  for (const event of ["mousemove", "pointermove", "scroll"]) document.fire(event, true);
  window.fire("focus", true);
  expect(bridge.touch).not.toHaveBeenCalled();
  expect(bridge.resume).toHaveBeenCalledTimes(1);
  dispose();
});

test("hidden and frozen pages suspend delivery and ignore activity until validated on resume", async () => {
  const { source, document, window, bridge } = fixture();
  const dispose = attachSessionActivity(source, bridge);
  document.visibilityState = "hidden";
  document.fire("visibilitychange", true);
  document.fire("pointerdown", true);
  expect(bridge.suspend).toHaveBeenCalledTimes(1);
  expect(bridge.touch).not.toHaveBeenCalled();
  document.visibilityState = "visible";
  const resumed = Promise.withResolvers<SessionResult<PublicSessionSnapshot>>();
  bridge.resume = vi.fn(() => resumed.promise);
  window.fire("pageshow", true);
  document.fire("keydown", true);
  expect(bridge.touch).not.toHaveBeenCalled();
  resumed.resolve({ ok: true, value: bridge.getSessionSnapshot() as PublicSessionSnapshot });
  await resumed.promise;
  document.fire("keydown", true);
  expect(bridge.touch).toHaveBeenCalledTimes(1);
  document.fire("freeze", true);
  document.fire("pointerdown", true);
  expect(bridge.suspend).toHaveBeenCalledTimes(2);
  expect(bridge.touch).toHaveBeenCalledTimes(1);
  document.fire("resume", true);
  expect(bridge.resume).toHaveBeenCalledTimes(2);
  dispose();
});

test("a failed resume keeps activity suspended; lifecycle events never touch", async () => {
  const { source, window, document, bridge } = fixture();
  bridge.resume = vi.fn(
    async (): Promise<SessionResult<PublicSessionSnapshot>> => ({
      ok: false,
      error: { kind: "unavailable" },
    }),
  );
  const dispose = attachSessionActivity(source, bridge);
  window.fire("focus", true);
  await Promise.resolve();
  document.fire("pointerdown", true);
  expect(bridge.touch).not.toHaveBeenCalled();
  expect(bridge.resume).toHaveBeenCalledTimes(1);
  dispose();
});

test("locked or disconnected snapshots cannot produce activity messages", () => {
  const { source, document, bridge } = fixture();
  const dispose = attachSessionActivity(source, bridge);
  bridge.getSessionSnapshot = () => null;
  document.fire("pointerdown", true);
  bridge.getSessionSnapshot = () => ({
    status: "locked",
    identity: null,
    profile: null,
    expiresAt: null,
    pendingProfileId: null,
    reason: "expired",
    revision: 2,
    apiKeyPrefix: null,
  });
  document.fire("keydown", true);
  expect(bridge.touch).not.toHaveBeenCalled();
  dispose();
});

test("each new identity gets its first activity immediately and dispose releases every listener", () => {
  const { source, document, window, bridge, replace } = fixture();
  const dispose = attachSessionActivity(source, bridge);
  document.fire("pointerdown", true);
  replace({
    ...(bridge.getSessionSnapshot() as Extract<PublicSessionSnapshot, { status: "unlocked" }>),
    identity: { workerId: "worker-a", sessionId: "session-b" },
  });
  document.fire("pointerdown", true);
  expect(bridge.touch).toHaveBeenCalledTimes(2);
  dispose();
  dispose();
  expect(document.listenerCount() + window.listenerCount()).toBe(0);
  window.fire("focus", true);
  document.fire("keydown", true);
  expect(bridge.touch).toHaveBeenCalledTimes(2);
  const again = attachSessionActivity(source, bridge);
  document.fire("pointerdown", true);
  expect(bridge.touch).toHaveBeenCalledTimes(3);
  again();
});

test("a page opened in the background stays suspended until a visible resume check succeeds", async () => {
  const { source, document, window, bridge } = fixture();
  document.visibilityState = "hidden";
  const dispose = attachSessionActivity(source, bridge);
  window.fire("focus", true);
  expect(bridge.suspend).toHaveBeenCalledTimes(1);
  expect(bridge.resume).not.toHaveBeenCalled();
  document.visibilityState = "visible";
  document.fire("visibilitychange", true);
  await Promise.resolve();
  document.fire("pointerdown", true);
  expect(bridge.resume).toHaveBeenCalledTimes(1);
  expect(bridge.touch).toHaveBeenCalledTimes(1);
  window.fire("pagehide", true, { persisted: true });
  expect(bridge.suspend).toHaveBeenCalledTimes(2);
  dispose();
});

test("permanent pagehide disconnects this page while BFCache suspension keeps its connection", async () => {
  const f = fixture();
  const cleanup = attachSessionActivity(f.source, f.bridge);
  f.window.fire("pagehide", true, { persisted: true });
  expect(f.bridge.dispose).not.toHaveBeenCalled();
  f.window.fire("pageshow", true, { persisted: true });
  await Promise.resolve();
  f.document.fire("pointerdown", true);
  expect(f.bridge.touch).toHaveBeenCalledTimes(1);
  f.window.fire("pagehide", true, { persisted: false });
  expect(f.bridge.dispose).toHaveBeenCalledTimes(1);
  expect(f.document.listenerCount() + f.window.listenerCount()).toBe(0);
  f.window.fire("focus", true);
  expect(f.bridge.resume).toHaveBeenCalledTimes(1);
  cleanup();
  expect(f.bridge.dispose).toHaveBeenCalledTimes(1);
});

test("a stale resume result cannot undo a newer suspension or another resume failure", async () => {
  const { source, document, window, bridge } = fixture();
  const first = Promise.withResolvers<SessionResult<PublicSessionSnapshot>>();
  const second = Promise.withResolvers<SessionResult<PublicSessionSnapshot>>();
  bridge.resume = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const dispose = attachSessionActivity(source, bridge);
  window.fire("focus", true);
  document.fire("freeze", true);
  document.fire("resume", true);
  second.resolve({ ok: false, error: { kind: "unavailable" } });
  await second.promise;
  first.resolve({ ok: true, value: bridge.getSessionSnapshot() as PublicSessionSnapshot });
  await first.promise;
  document.fire("pointerdown", true);
  expect(bridge.touch).not.toHaveBeenCalled();
  dispose();
});

test("a pending resume can finish after disposal without reinstalling or enabling listeners", async () => {
  const { source, document, window, bridge } = fixture();
  const resumed = Promise.withResolvers<SessionResult<PublicSessionSnapshot>>();
  bridge.resume = () => resumed.promise;
  const dispose = attachSessionActivity(source, bridge);
  window.fire("pageshow", true);
  dispose();
  resumed.resolve({ ok: true, value: bridge.getSessionSnapshot() as PublicSessionSnapshot });
  await resumed.promise;
  document.fire("keydown", true);
  expect(bridge.touch).not.toHaveBeenCalled();
  expect(document.listenerCount() + window.listenerCount()).toBe(0);
});
