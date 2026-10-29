import { Effect } from "effect";
import { expect, test, vi } from "vitest";
import { createManualClock } from "@/test/session-clock";
import {
  type AuthSessionDependencies,
  SESSION_IDLE_MS,
  SessionFault,
} from "./auth-session";
import { createSessionRuntime } from "./runtime";
import type { ApiFailure } from "./types";

function dependencies(): AuthSessionDependencies {
  return {
    workerId: "worker",
    now: () => 0,
    newSessionId: () => "session",
    async openCredential() {
      return {
        profile: {
          id: "profile",
          name: "Profile",
          baseUrl: "https://headscale.test",
        },
        credentialVersion: "credential",
        keyEpoch: "epoch",
        apiKey: "fixture-connection-key",
      };
    },
    async readCurrentProfile(candidate) {
      return candidate.profile;
    },
    async validateCredential() {},
    async execute() {
      return { ok: true, value: {} };
    },
  };
}

test("runs a typed operation and preserves a resolved failure through the Effect error channel", async () => {
  const runtime = createSessionRuntime({ auth: dependencies() });
  runtime.attachPort("port-a");
  try {
    await expect(
      runtime.runOperation("port-a", "success", async () => ({
        ok: true,
        value: { count: 3 },
      })),
    ).resolves.toEqual({ ok: true, value: { count: 3 } });
    const failure: ApiFailure = {
      kind: "api",
      code: "HTTP_STATUS",
      message: "Unavailable",
      status: 503,
      data: { message: "server unavailable" },
    };
    await expect(
      runtime.runOperation("port-a", "failure", async () => ({
        ok: false,
        error: failure,
      })),
    ).resolves.toEqual({ ok: false, error: failure });
  } finally {
    await runtime.dispose();
  }
});

test("refuses operations from unknown or disposed ports without running their callback", async () => {
  const runtime = createSessionRuntime({ auth: dependencies() });
  let executions = 0;
  const task = async () => {
    executions++;
    return { ok: true as const, value: "private" };
  };
  await expect(
    runtime.runOperation("missing", "id", task),
  ).resolves.toMatchObject({ ok: false });
  await runtime.dispose();
  expect(runtime.attachPort("late")).toBe(false);
  await expect(runtime.runOperation("late", "id", task)).resolves.toMatchObject(
    { ok: false },
  );
  expect(executions).toBe(0);
});

function unlockInput() {
  return {
    profileId: "profile",
    password: "password",
    expectedWorkerId: "worker",
    expectedIdentity: null,
    expectedCredentialVersion: "credential",
    operationId: "unlock",
    ownerTabId: "owner-a",
    portId: "port-a",
  };
}

test("a pending decrypt never blocks another port's lock and its late completion cannot unlock", async () => {
  const deps = dependencies();
  const started = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<void>();
  const open = deps.openCredential;
  deps.openCredential = async (input, signal) => {
    started.resolve(signal);
    await release.promise;
    return open(input, signal);
  };
  const runtime = createSessionRuntime({ auth: deps });
  runtime.attachPort("port-a");
  runtime.attachPort("port-b");
  const pending = runtime.runOperation("port-a", "1", (signal) =>
    runtime.auth.unlock(unlockInput(), { signal }),
  );
  const signal = await started.promise;
  try {
    expect(
      await runtime.runOperation("port-b", "1", async () =>
        runtime.auth.check(),
      ),
    ).toMatchObject({
      ok: true,
      value: { status: "locked", pendingProfileId: "profile" },
    });
    expect(
      await runtime.runOperation("port-b", "2", async () =>
        runtime.auth.lock(null),
      ),
    ).toMatchObject({ ok: true });
    expect(signal.aborted).toBe(true);
    release.resolve();
    expect(await pending).toMatchObject({ ok: false });
    expect(runtime.auth.getSnapshot().status).toBe("locked");
  } finally {
    release.resolve();
    await runtime.dispose();
  }
});

test("cancels only the matching port and request id while preserving the other port's request", async () => {
  const runtime = createSessionRuntime({ auth: dependencies() });
  runtime.attachPort("port-a");
  runtime.attachPort("port-b");
  const release = Promise.withResolvers<void>();
  const startedA = Promise.withResolvers<AbortSignal>();
  const startedB = Promise.withResolvers<AbortSignal>();
  const a = runtime.runOperation("port-a", "same-id", async (signal) => {
    startedA.resolve(signal);
    await release.promise;
    return { ok: true, value: "a" };
  });
  const b = runtime.runOperation("port-b", "same-id", async (signal) => {
    startedB.resolve(signal);
    await release.promise;
    return { ok: true, value: "b" };
  });
  const [signalA, signalB] = await Promise.all([
    startedA.promise,
    startedB.promise,
  ]);
  try {
    await runtime.cancel("port-a", "same-id");
    expect(signalA.aborted).toBe(true);
    expect(signalB.aborted).toBe(false);
    expect(await a).toEqual({ ok: false, error: { kind: "cancelled" } });
    release.resolve();
    expect(await b).toEqual({ ok: true, value: "b" });
    await runtime.cancel("missing", "same-id");
  } finally {
    release.resolve();
    await runtime.dispose();
  }
});

test("detaching a port interrupts its work without locking the shared current session", async () => {
  const runtime = createSessionRuntime({ auth: dependencies() });
  runtime.attachPort("port-a");
  runtime.attachPort("port-b");
  expect(await runtime.auth.unlock(unlockInput())).toMatchObject({ ok: true });
  const started = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<void>();
  const pending = runtime.runOperation("port-a", "1", async (signal) => {
    started.resolve(signal);
    await release.promise;
    return { ok: true, value: "late" };
  });
  const signal = await started.promise;
  try {
    await runtime.detachPort("port-a");
    expect(signal.aborted).toBe(true);
    expect(runtime.auth.getSnapshot().status).toBe("unlocked");
    expect(await pending).toMatchObject({
      ok: false,
      error: { kind: "cancelled" },
    });
    expect(
      await runtime.runOperation("port-a", "2", async () => ({
        ok: true,
        value: "forbidden",
      })),
    ).toMatchObject({ ok: false });
    expect(
      await runtime.runOperation("port-b", "1", async () =>
        runtime.auth.check(),
      ),
    ).toMatchObject({ ok: true, value: { status: "unlocked" } });
    await runtime.detachPort("missing");
  } finally {
    release.resolve();
    await runtime.dispose();
  }
});

test("scope disposal interrupts active work and locks the session even if a dependency ignores abort", async () => {
  const deps = dependencies();
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<AbortSignal>();
  deps.execute = async (_command, context) => {
    started.resolve(context.signal);
    await release.promise;
    return { ok: true, value: "late-success" };
  };
  const runtime = createSessionRuntime({ auth: deps });
  runtime.attachPort("port-a");
  await runtime.auth.unlock(unlockInput());
  const identity = runtime.auth.getSnapshot().identity;
  if (!identity) throw new Error("fixture did not unlock");
  const pending = runtime.runOperation("port-a", "1", (signal) =>
    runtime.auth.execute(
      identity,
      { type: "api.read", endpoint: "listUsers", input: {} },
      { signal },
    ),
  );
  const signal = await started.promise;
  await runtime.dispose();
  expect(signal.aborted).toBe(true);
  expect(await pending).toMatchObject({
    ok: false,
    error: { kind: "cancelled" },
  });
  release.resolve();
  await Promise.resolve();
  expect(runtime.auth.getSnapshot().status).toBe("locked");
  await runtime.dispose();
});

test("duplicate and excess requests cannot allocate unbounded work, and classified errors remain typed", async () => {
  const runtime = createSessionRuntime({ auth: dependencies() });
  expect(runtime.attachPort("port-a")).toBe(true);
  expect(runtime.attachPort("port-a")).toBe(false);
  const release = Promise.withResolvers<void>();
  const pending = Array.from({ length: 64 }, (_, index) =>
    runtime.runOperation("port-a", String(index), async () => {
      await release.promise;
      return { ok: true, value: index };
    }),
  );
  try {
    expect(
      await runtime.runOperation("port-a", "0", async () => ({
        ok: true,
        value: "duplicate",
      })),
    ).toMatchObject({ ok: false, error: { kind: "invalid-request" } });
    expect(
      await runtime.runOperation("port-a", "65", async () => ({
        ok: true,
        value: "excess",
      })),
    ).toMatchObject({ ok: false, error: { kind: "busy" } });
    release.resolve();
    await Promise.all(pending);
    expect(
      await runtime.runOperation("port-a", "error", async () => {
        throw new SessionFault("expired");
      }),
    ).toMatchObject({ ok: false, error: { kind: "expired" } });
    expect(
      await runtime.runOperation("port-a", "unknown", async () => {
        throw new Error("do not leak sensitive details");
      }),
    ).toEqual({ ok: false, error: { kind: "unavailable" } });
  } finally {
    release.resolve();
    await runtime.dispose();
  }
});

test("an idle timer releases the current session, while advancing the authoritative clock alone runs no timer", async () => {
  const deps = dependencies();
  const clock = createManualClock();
  deps.now = clock.now;
  const timer = Promise.withResolvers<void>();
  const expired = Promise.withResolvers<void>();
  const delays: number[] = [];
  const runtime = createSessionRuntime({
    auth: deps,
    idleSleep(milliseconds) {
      delays.push(milliseconds);
      return Effect.promise(() => timer.promise);
    },
  });
  const stop = runtime.auth.subscribe(() => {
    if (runtime.auth.getSnapshot().reason === "expired") expired.resolve();
  });
  try {
    await runtime.auth.unlock(unlockInput());
    expect(delays).toEqual([SESSION_IDLE_MS]);
    clock.advance(SESSION_IDLE_MS);
    expect(runtime.auth.getSnapshot().status).toBe("unlocked");
    timer.resolve();
    await expired.promise;
    expect(runtime.auth.getSnapshot()).toMatchObject({
      status: "locked",
      reason: "expired",
      identity: null,
    });
  } finally {
    timer.resolve();
    stop();
    await runtime.dispose();
  }
});

test("touch replaces the expiry task and an interrupted old timer cannot lock the renewed session", async () => {
  const deps = dependencies();
  const clock = createManualClock();
  deps.now = clock.now;
  const timers: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  const runtime = createSessionRuntime({
    auth: deps,
    idleSleep() {
      const timer = Promise.withResolvers<void>();
      timers.push(timer);
      return Effect.promise(() => timer.promise);
    },
  });
  try {
    expect(runtime.attachPort("port-a")).toBe(true);
    expect(runtime.attachPort("port-a")).toBe(false);
    await runtime.auth.unlock(unlockInput());
    const identity = runtime.auth.getSnapshot().identity;
    expect.assert(identity);
    clock.advance(1000);
    expect(runtime.auth.touch(identity)).toMatchObject({ ok: true });
    expect(timers).toHaveLength(2);
    clock.advance(SESSION_IDLE_MS - 1000);
    timers[0]?.resolve();
    await Effect.runPromise(Effect.yieldNow);
    expect(runtime.auth.getSnapshot()).toMatchObject({
      status: "unlocked",
      identity,
    });
    expect(runtime.auth.lock(identity)).toMatchObject({ ok: true });
    timers[1]?.resolve();
    await Effect.runPromise(Effect.yieldNow);
    expect(runtime.auth.getSnapshot()).toMatchObject({
      status: "locked",
      reason: "user",
    });
  } finally {
    for (const timer of timers) timer.resolve();
    await runtime.dispose();
    await runtime.dispose();
  }
});

test("reset cancellation interrupts every other port task while allowing the reset command to commit", async () => {
  const runtime = createSessionRuntime({ auth: dependencies() });
  runtime.attachPort("a");
  runtime.attachPort("b");
  const release = Promise.withResolvers<void>();
  const signals: AbortSignal[] = [];
  const ready = Promise.withResolvers<void>();
  const task = async (signal: AbortSignal) => {
    signals.push(signal);
    if (signals.length === 2) ready.resolve();
    await release.promise;
    return { ok: true as const, value: "late" };
  };
  const a = runtime.runOperation("a", "same", task);
  const b = runtime.runOperation("b", "same", task);
  await ready.promise;
  try {
    const reset = await runtime.runOperation("a", "reset", async (signal) => {
      // Yield so the reset fiber is registered and the exclusion is what protects it.
      await Promise.resolve();
      await runtime.cancelPending({ portId: "a", requestId: "reset" });
      return {
        ok: true,
        value: {
          committed: true,
          allCancelled: signals.every((pending) => pending.aborted),
          resetCancelled: signal.aborted,
        },
      };
    });
    expect(reset).toEqual({
      ok: true,
      value: { committed: true, allCancelled: true, resetCancelled: false },
    });
    expect(await a).toMatchObject({ ok: false, error: { kind: "cancelled" } });
    expect(await b).toMatchObject({ ok: false, error: { kind: "cancelled" } });
  } finally {
    release.resolve();
    await runtime.dispose();
  }
});

function controlledTimers() {
  const timers: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  const delays: number[] = [];
  return {
    timers,
    delays,
    idleSleep(milliseconds: number) {
      delays.push(milliseconds);
      const timer = Promise.withResolvers<void>();
      timers.push(timer);
      return Effect.promise(() => timer.promise);
    },
  };
}

test("a timer that fires early re-arms for the remainder and then expires the session", async () => {
  const deps = dependencies();
  const clock = createManualClock();
  deps.now = clock.now;
  const { timers, delays, idleSleep } = controlledTimers();
  const runtime = createSessionRuntime({ auth: deps, idleSleep });
  const expired = Promise.withResolvers<void>();
  const stop = runtime.auth.subscribe(() => {
    if (runtime.auth.getSnapshot().reason === "expired") expired.resolve();
  });
  try {
    await runtime.auth.unlock(unlockInput());
    expect(delays).toEqual([SESSION_IDLE_MS]);
    clock.advance(SESSION_IDLE_MS - 5);
    timers[0]?.resolve();
    await Effect.runPromise(Effect.yieldNow);
    expect(runtime.auth.getSnapshot().status).toBe("unlocked");
    expect(delays).toEqual([SESSION_IDLE_MS, 5]);
    clock.advance(5);
    timers[1]?.resolve();
    await expired.promise;
    expect(runtime.auth.getSnapshot()).toMatchObject({
      status: "locked",
      reason: "expired",
      identity: null,
    });
    expect(delays).toHaveLength(2);
  } finally {
    for (const timer of timers) timer.resolve();
    stop();
    await runtime.dispose();
  }
});

test("a touch between an early firing and its re-armed timer leaves one fresh timer and no double expiry", async () => {
  const deps = dependencies();
  const clock = createManualClock();
  deps.now = clock.now;
  const { timers, delays, idleSleep } = controlledTimers();
  const runtime = createSessionRuntime({ auth: deps, idleSleep });
  try {
    await runtime.auth.unlock(unlockInput());
    const identity = runtime.auth.getSnapshot().identity;
    expect.assert(identity);
    clock.advance(SESSION_IDLE_MS - 5);
    timers[0]?.resolve();
    await Effect.runPromise(Effect.yieldNow);
    expect(delays).toEqual([SESSION_IDLE_MS, 5]);
    expect(runtime.auth.touch(identity)).toMatchObject({ ok: true });
    expect(delays).toEqual([SESSION_IDLE_MS, 5, SESSION_IDLE_MS]);
    clock.advance(5);
    timers[1]?.resolve();
    await Effect.runPromise(Effect.yieldNow);
    expect(runtime.auth.getSnapshot()).toMatchObject({
      status: "unlocked",
      identity,
    });
    expect(delays).toHaveLength(3);
  } finally {
    for (const timer of timers) timer.resolve();
    await runtime.dispose();
  }
});

test("the production Effect.sleep path re-arms an early timer and locks without sending a command", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const deps = dependencies();
  const clock = createManualClock();
  deps.now = clock.now;
  let commands = 0;
  deps.execute = async () => {
    commands++;
    return { ok: true, value: {} };
  };
  const runtime = createSessionRuntime({ auth: deps });
  try {
    await runtime.auth.unlock(unlockInput());
    clock.advance(SESSION_IDLE_MS - 1);
    await vi.advanceTimersByTimeAsync(SESSION_IDLE_MS);
    expect(runtime.auth.getSnapshot().status).toBe("unlocked");
    clock.advance(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.auth.getSnapshot()).toMatchObject({
      status: "locked",
      reason: "expired",
      identity: null,
    });
    expect(commands).toBe(0);
  } finally {
    vi.useRealTimers();
    await runtime.dispose();
  }
});
