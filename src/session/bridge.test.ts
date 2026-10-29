import "fake-indexeddb/auto";
import { expect, test, vi } from "vitest";
import { createSession } from "@/composables/session-context";
import { createMutation } from "@/composables/useMutation";
import { i18n } from "@/i18n";
import { productDescriptors } from "@/i18n/descriptors";
import { hydrateSettings } from "@/lib/settings-storage";
import { createManualClock } from "@/test/session-clock";
import { createSessionPorts, sessionMessage } from "@/test/session-ports";
import { snapshotFixture } from "@/test-utils/headscale.test";
import { type AuthSessionDependencies, SESSION_IDLE_MS } from "./auth-session";
import { createSessionBridge, type SessionBridgeOptions } from "./bridge";
import type { ProfileActions } from "./profile-actions";
import { type ApiCommand, createSessionProtocol } from "./protocol";
import { createSessionRuntime } from "./runtime";
import type { SessionResult, WorkerErrorDto } from "./types";

function fixture(
  execute?: AuthSessionDependencies["execute"],
  schedule?: SessionBridgeOptions["schedule"],
) {
  const clock = createManualClock();
  let identity = 0;
  const runtime = createSessionRuntime({
    auth: {
      workerId: "worker",
      now: clock.now,
      newSessionId: () => `session-${++identity}`,
      async openCredential(input) {
        return {
          profile: {
            id: input.profileId,
            name: input.profileId,
            baseUrl: "https://fixture.test",
          },
          apiKey: "connection-private",
          credentialVersion: "credential",
          keyEpoch: "epoch",
        };
      },
      async readCurrentProfile(candidate) {
        return candidate.profile;
      },
      async validateCredential() {},
      execute: execute ?? (async () => ({ ok: true, value: { users: [] } })),
    },
  });
  const unavailable = async () => ({
    ok: false as const,
    error: { kind: "unavailable" as const },
  });
  const profiles: ProfileActions = {
    list: unavailable,
    save: unavailable,
    migrate: unavailable,
    changePassword: unavailable,
    delete: unavailable,
    reset: unavailable,
  };
  const protocol = createSessionProtocol({
    runtime,
    profiles,
    workerId: "worker",
    buildId: "worker-build",
    storageVersion: 3,
  });
  const pairs: ReturnType<typeof createSessionPorts>[] = [];
  const bridge = createSessionBridge({
    openPort() {
      const pair = createSessionPorts();
      pairs.push(pair);
      protocol.connect(pair.worker);
      return pair.page;
    },
    ownerTabId: () => "owner",
    buildId: "worker-build",
    storageVersion: 3,
    now: clock.now,
    schedule,
  });
  return {
    bridge,
    clock,
    runtime,
    protocol,
    profiles,
    pairs,
    async close() {
      bridge.dispose();
      for (const pair of pairs) pair.close();
      await protocol.dispose();
      await runtime.dispose();
    },
  };
}

async function unlock(f: ReturnType<typeof fixture>, profileId = "profile") {
  const result = await f.bridge.unlock({
    profileId,
    password: "password",
    expectedCredentialVersion: "credential",
    expectedIdentity: f.bridge.getSessionSnapshot()?.identity ?? null,
    expectedWorkerId: "worker",
  });
  expect(result).toMatchObject({ ok: true });
  const identity = f.bridge.getSessionSnapshot()?.identity;
  expect.assert(identity);
  return identity;
}

test("the page handshake publishes one stable safe projection and explicit checks do not unlock", async () => {
  const f = fixture();
  let notifications = 0;
  const stop = f.bridge.subscribe(() => notifications++);
  try {
    expect(await f.bridge.connect()).toMatchObject({
      ok: true,
      value: { status: "locked" },
    });
    const snapshot = f.bridge.getSnapshot();
    expect(snapshot).toMatchObject({
      status: "ready-locked",
      workerId: "worker",
      buildId: "worker-build",
    });
    expect(f.bridge.getSnapshot()).toBe(snapshot);
    expect(await f.bridge.check()).toMatchObject({
      ok: true,
      value: { status: "locked" },
    });
    expect(f.bridge.getSnapshot()).toBe(snapshot);
    expect(notifications).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain("connection-private");
  } finally {
    stop();
    await f.close();
  }
});

test("a renewal records the new expiry without waking subscribers", async () => {
  const f = fixture();
  try {
    await f.bridge.connect();
    const identity = await unlock(f);
    const before = f.bridge.getSessionSnapshot();
    let notifications = 0;
    const stop = f.bridge.subscribe(() => notifications++);
    f.clock.advance(1000);
    expect(await f.bridge.touch(identity)).toMatchObject({ ok: true });
    stop();
    expect(notifications).toBe(0);
    expect(f.bridge.getSessionSnapshot()).toMatchObject({
      identity,
      expiresAt: (before?.expiresAt ?? 0) + 1000,
    });
  } finally {
    await f.close();
  }
});

// The expiry timers themselves are exercised by the runtime tests in src/session/runtime.test.ts.
test("a reply queued before expiry cannot publish after expiry even though no timer ran", async () => {
  const f = fixture();
  try {
    await f.bridge.connect();
    const identity = await unlock(f);
    const pair = f.pairs[0];
    expect.assert(pair);
    pair.pause();
    const pending = f.bridge.read(identity, {
      endpoint: "listUsers",
      input: {},
    });
    await expect.poll(() => pair.queued()).toBeGreaterThan(0);
    f.clock.advance(SESSION_IDLE_MS);
    expect(f.runtime.auth.getSnapshot().status).toBe("unlocked");
    pair.resume();
    expect(await pending).toMatchObject({ ok: false });
    expect(f.bridge.getSessionSnapshot()).toMatchObject({
      status: "locked",
      reason: "expired",
    });
  } finally {
    await f.close();
  }
});

test("a hidden one-time key result waits for same-session recovery and is delivered exactly once", async () => {
  const f = fixture(async () => ({
    ok: true,
    value: { apiKey: "new-business-key" },
  }));
  let deliveries = 0;
  try {
    await f.bridge.connect();
    const identity = await unlock(f);
    f.bridge.suspend();
    const result = f.bridge
      .write(identity, {
        endpoint: "createApiKey",
        input: { expiration: "2027-01-01T00:00:00Z" },
      })
      .then((value) => {
        deliveries++;
        return value;
      });
    const pair = f.pairs[0];
    expect.assert(pair);
    await sessionMessage(
      pair.page,
      (value) => (value as { requestId?: number }).requestId === 2,
    );
    expect(deliveries).toBe(0);
    expect(await f.bridge.resume()).toMatchObject({ ok: true });
    expect(await result).toEqual({
      ok: true,
      value: { apiKey: "new-business-key" },
    });
    await f.bridge.resume();
    expect(deliveries).toBe(1);
  } finally {
    await f.close();
  }
});

function scheduler() {
  const timers: {
    milliseconds: number;
    callback(): void;
    cancelled: boolean;
  }[] = [];
  return {
    timers,
    schedule(milliseconds: number, callback: () => void) {
      const timer = { milliseconds, callback, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    fire(milliseconds: number) {
      for (const timer of timers.slice())
        if (!timer.cancelled && timer.milliseconds <= milliseconds) {
          timer.cancelled = true;
          timer.callback();
        }
    },
  };
}

test("silent Worker death ends waiting within the command deadline and clears the authorization projection", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const timer = scheduler();
  const f = fixture(async () => {
    started.resolve();
    await release.promise;
    return { ok: true, value: "late" };
  }, timer.schedule);
  try {
    await f.bridge.connect();
    const identity = await unlock(f);
    const result = f.bridge.write(identity, {
      endpoint: "setPolicy",
      input: { policy: "{}" },
    });
    await started.promise;
    f.pairs[0]?.worker.close();
    expect(
      timer.timers.some(
        (entry) => entry.milliseconds === 20_000 && !entry.cancelled,
      ),
    ).toBe(true);
    timer.fire(20_000);
    expect(await result).toEqual({
      ok: false,
      error: { kind: "unavailable", outcome: "unknown" },
    });
    expect(f.bridge.getSnapshot()).toMatchObject({
      status: "unavailable",
      session: null,
    });
    expect(
      await f.bridge.read(identity, { endpoint: "listUsers", input: {} }),
    ).toMatchObject({
      ok: false,
    });
  } finally {
    release.resolve();
    await f.close();
  }
});

test("hello has a bounded deadline without relying on a port close event", async () => {
  const timer = scheduler();
  const pair = createSessionPorts();
  const bridge = createSessionBridge({
    openPort: () => pair.page,
    ownerTabId: () => "owner",
    buildId: "build",
    storageVersion: 3,
    schedule: timer.schedule,
  });
  try {
    const pending = bridge.connect();
    expect(timer.timers.some((entry) => entry.milliseconds === 10_000)).toBe(
      true,
    );
    timer.fire(10_000);
    expect(await pending).toEqual({
      ok: false,
      error: { kind: "unavailable" },
    });
    expect(bridge.getSnapshot().status).toBe("unavailable");
  } finally {
    bridge.dispose();
    pair.close();
  }
});

test("timely hidden replies stop their communication deadline while waiting for recovery", async () => {
  const timer = scheduler();
  const f = fixture(
    async () => ({ ok: true, value: { apiKey: "one-time-business-key" } }),
    timer.schedule,
  );
  try {
    await f.bridge.connect();
    const identity = await unlock(f);
    f.bridge.suspend();
    const pending = f.bridge.write(identity, {
      endpoint: "createApiKey",
      input: { expiration: "2027-01-01T00:00:00Z" },
    });
    const pair = f.pairs[0];
    expect.assert(pair);
    await sessionMessage(
      pair.page,
      (value) => (value as { requestId?: number }).requestId === 2,
    );
    expect(timer.timers.some((entry) => entry.milliseconds === 20_000)).toBe(
      true,
    );
    timer.fire(20_000);
    expect(f.bridge.getSnapshot().status).toBe("ready-unlocked");
    await f.bridge.resume();
    expect(await pending).toEqual({
      ok: true,
      value: { apiKey: "one-time-business-key" },
    });
  } finally {
    await f.close();
  }
});

test("page cancellation aborts only its matching Worker request and settled cancellation cannot publish a late result", async () => {
  const started = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<void>();
  const f = fixture(async (_command, context) => {
    started.resolve(context.signal);
    await release.promise;
    return { ok: true, value: "late" };
  });
  try {
    await f.bridge.connect();
    const identity = await unlock(f);
    const abort = new AbortController();
    const pending = f.bridge.read(
      identity,
      { endpoint: "listUsers", input: {} },
      { signal: abort.signal },
    );
    const signal = await started.promise;
    abort.abort();
    await expect.poll(() => signal.aborted).toBe(true);
    expect(await pending).toEqual({ ok: false, error: { kind: "cancelled" } });
    release.resolve();
    expect(await f.bridge.check()).toMatchObject({
      ok: true,
      value: { status: "unlocked" },
    });
  } finally {
    release.resolve();
    await f.close();
  }
});

test("a reply for a request that is no longer pending is ignored", async () => {
  const f = fixture();
  try {
    await f.bridge.connect();
    const snapshot = f.bridge.getSnapshot();
    f.pairs[0]?.worker.postMessage({
      type: "reply",
      requestId: 9_999,
      snapshot: snapshot.session,
      result: { ok: true, value: "orphan" },
    });
    expect(await f.bridge.check()).toMatchObject({
      ok: true,
      value: { status: "locked" },
    });
    expect(f.bridge.getSnapshot()).toBe(snapshot);
  } finally {
    await f.close();
  }
});

test("malformed messages and port deserialization errors fail closed without hanging pending work", async () => {
  const f = fixture();
  try {
    await f.bridge.connect();
    await unlock(f);
    f.pairs[0]?.page.dispatchEvent(new MessageEvent("messageerror"));
    expect(f.bridge.getSnapshot()).toMatchObject({
      status: "unavailable",
      session: null,
    });
  } finally {
    await f.close();
  }
});

test("unavailable SharedWorker construction is a typed failure", async () => {
  const bridge = createSessionBridge({
    openPort() {
      throw new Error("unavailable");
    },
    ownerTabId: () => "owner",
    storageVersion: 3,
    buildId: "build",
  });
  try {
    await expect(
      Promise.resolve().then(() => bridge.connect()),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "unavailable" },
    });
    expect(bridge.getSnapshot().status).toBe("unavailable");
  } finally {
    bridge.dispose();
  }
});

test("buffered results and in-flight work share a 64-command bound", async () => {
  const f = fixture();
  const results: Promise<unknown>[] = [];
  try {
    await f.bridge.connect();
    const identity = await unlock(f);
    f.bridge.suspend();
    for (let index = 0; index < 63; index++)
      results.push(
        f.bridge.read(identity, { endpoint: "listUsers", input: {} }),
      );
    const pair = f.pairs[0];
    expect.assert(pair);
    await sessionMessage(
      pair.page,
      (value) => (value as { requestId?: number }).requestId === 64,
    );
    const extra = f.bridge.read(identity, { endpoint: "listUsers", input: {} });
    const result = await Promise.race([
      extra,
      Promise.resolve("still-pending"),
    ]);
    expect(result).toEqual({ ok: false, error: { kind: "busy" } });
    expect(await f.bridge.resume()).toMatchObject({ ok: true });
    expect(await Promise.all(results)).toHaveLength(63);
  } finally {
    await f.close();
    await Promise.all(results);
  }
});

test("a handshake with incompatible Worker storage or protocol metadata never grants authorization", async () => {
  const pair = createSessionPorts();
  const bridge = createSessionBridge({
    openPort: () => pair.page,
    ownerTabId: () => "owner",
    buildId: "build",
    storageVersion: 3,
  });
  try {
    const pending = bridge.connect();
    pair.worker.postMessage({
      type: "hello",
      protocolVersion: 9,
      storageVersion: 2,
      workerId: "worker",
      buildId: "old",
      snapshot: {
        status: "locked",
        identity: null,
        profile: null,
        expiresAt: null,
        pendingProfileId: null,
        reason: "initial",
        revision: 0,
        apiKeyPrefix: null,
      },
    });
    expect(await pending).toEqual({
      ok: false,
      error: { kind: "reload-required" },
    });
    expect(bridge.getSnapshot()).toMatchObject({
      status: "reload-required",
      session: null,
    });
  } finally {
    bridge.dispose();
    pair.close();
  }
});

test("a Worker from another build reads as reload-required even when the rest of its hello differs", async () => {
  const pair = createSessionPorts();
  const bridge = createSessionBridge({
    openPort: () => pair.page,
    ownerTabId: () => "owner",
    buildId: "page-build",
    storageVersion: 3,
  });
  try {
    const pending = bridge.connect();
    // An older Worker: no `reads`, and a snapshot without a field this build added.
    pair.worker.postMessage({
      type: "hello",
      protocolVersion: 1,
      storageVersion: 3,
      workerId: "worker",
      buildId: "older-build",
      snapshot: {
        status: "locked",
        identity: null,
        profile: null,
        expiresAt: null,
        revision: 0,
      },
    });
    expect(await pending).toEqual({
      ok: false,
      error: { kind: "reload-required" },
    });
    expect(bridge.getSnapshot().status).toBe("reload-required");
  } finally {
    bridge.dispose();
    pair.close();
  }
});

test("a Worker from a different build never grants authorization and nothing is sent afterwards", async () => {
  const pair = createSessionPorts();
  const bridge = createSessionBridge({
    openPort: () => pair.page,
    ownerTabId: () => "owner",
    buildId: "page-build",
    storageVersion: 3,
  });
  try {
    const pending = bridge.connect();
    pair.worker.postMessage({
      type: "hello",
      protocolVersion: 1,
      storageVersion: 3,
      workerId: "worker",
      buildId: "other-build",
      snapshot: {
        status: "locked",
        identity: null,
        profile: null,
        expiresAt: null,
        pendingProfileId: null,
        reason: "initial",
        revision: 0,
        apiKeyPrefix: null,
      },
    });
    expect(await pending).toEqual({
      ok: false,
      error: { kind: "reload-required" },
    });
    expect(bridge.getSnapshot()).toMatchObject({
      status: "reload-required",
      session: null,
      workerId: null,
      buildId: null,
    });
    const posted = vi.spyOn(pair.page, "postMessage");
    expect(await bridge.listProfiles()).toEqual({
      ok: false,
      error: { kind: "unavailable" },
    });
    expect(posted).not.toHaveBeenCalled();
  } finally {
    bridge.dispose();
    pair.close();
  }
});

test("the bridge forwards the published key prefix into its frozen snapshot", async () => {
  const pair = createSessionPorts();
  const bridge = createSessionBridge({
    openPort: () => pair.page,
    ownerTabId: () => "owner",
    buildId: "build",
    storageVersion: 3,
  });
  const locked = {
    status: "locked",
    identity: null,
    profile: null,
    expiresAt: null,
    pendingProfileId: null,
    reason: "initial",
    revision: 0,
    apiKeyPrefix: null,
  };
  try {
    const pending = bridge.connect();
    pair.worker.postMessage({
      type: "hello",
      protocolVersion: 1,
      storageVersion: 3,
      workerId: "worker",
      buildId: "build",
      snapshot: locked,
    });
    await pending;
    expect(bridge.getSessionSnapshot()?.apiKeyPrefix).toBeNull();
    pair.worker.postMessage({
      type: "snapshot",
      snapshot: {
        ...locked,
        status: "unlocked",
        identity: { workerId: "worker", sessionId: "session" },
        profile: {
          id: "profile",
          name: "Profile",
          baseUrl: "https://fixture.test",
        },
        expiresAt: 5_000,
        reason: null,
        revision: 1,
        apiKeyPrefix: "hskey-api-abcdefghijkl-***",
      },
    });
    await expect
      .poll(() => bridge.getSessionSnapshot()?.apiKeyPrefix)
      .toBe("hskey-api-abcdefghijkl-***");
  } finally {
    bridge.dispose();
    pair.close();
  }
});

test("old Worker identities and out-of-order snapshots cannot replace the current page projection", async () => {
  const f = fixture();
  try {
    await f.bridge.connect();
    const identity = await unlock(f);
    const snapshot = f.bridge.getSessionSnapshot();
    expect.assert(snapshot);
    f.pairs[0]?.page.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "snapshot",
          snapshot: {
            ...snapshot,
            revision: snapshot.revision + 99,
            identity: { ...identity, workerId: "old-worker" },
          },
        },
      }),
    );
    expect(f.bridge.getSessionSnapshot()).toBe(snapshot);
    f.pairs[0]?.page.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "snapshot",
          snapshot: {
            ...snapshot,
            revision: snapshot.revision - 1,
            status: "locked",
            identity: null,
            profile: null,
            expiresAt: null,
          },
        },
      }),
    );
    expect(f.bridge.getSessionSnapshot()).toBe(snapshot);
  } finally {
    await f.close();
  }
});

test.each([
  ["lock", "createApiKey", { kind: "stale", outcome: "unknown" }],
  ["expire", "createApiKey", { kind: "expired", outcome: "unknown" }],
  ["lock", "listUsers", { kind: "stale" }],
  ["expire", "listUsers", { kind: "expired" }],
] as const)(
  "a hidden %s result of %s is discarded after the session ends",
  async (action, endpoint, error) => {
    const f = fixture(async () => ({
      ok: true,
      value: { apiKey: "never-deliver" },
    }));
    try {
      await f.bridge.connect();
      const identity = await unlock(f);
      f.bridge.suspend();
      const pending =
        endpoint === "listUsers"
          ? f.bridge.read(identity, { endpoint, input: {} })
          : f.bridge.write(identity, {
              endpoint,
              input: { expiration: "2027-01-01T00:00:00Z" },
            });
      const pair = f.pairs[0];
      expect.assert(pair);
      await sessionMessage(
        pair.page,
        (value) => (value as { requestId?: number }).requestId === 2,
      );
      if (action === "lock") await f.bridge.lock(identity);
      else f.clock.advance(SESSION_IDLE_MS);
      expect(await f.bridge.resume()).toMatchObject({
        ok: true,
        value: { status: "locked" },
      });
      expect(await pending).toEqual({ ok: false, error });
    } finally {
      await f.close();
    }
  },
);

test("another peer's valid touch permits a queued old-deadline result from the same identity", async () => {
  const f = fixture(async () => ({
    ok: true,
    value: { apiKey: "renewed-business-key" },
  }));
  try {
    await f.bridge.connect();
    const identity = await unlock(f);
    const pair = f.pairs[0];
    expect.assert(pair);
    pair.pause();
    const pending = f.bridge.write(identity, {
      endpoint: "createApiKey",
      input: { expiration: "2027-01-01T00:00:00Z" },
    });
    await expect.poll(() => pair.queued()).toBeGreaterThan(0);
    f.clock.advance(SESSION_IDLE_MS - 1);
    expect(f.runtime.auth.touch(identity)).toMatchObject({ ok: true });
    f.clock.advance(2);
    pair.resume();
    expect(await pending).toEqual({
      ok: true,
      value: { apiKey: "renewed-business-key" },
    });
  } finally {
    await f.close();
  }
});

test("a new suspension prevents an older resume check from releasing buffered results", async () => {
  const f = fixture();
  let delivered = false;
  try {
    await f.bridge.connect();
    const identity = await unlock(f);
    f.bridge.suspend();
    const pending = f.bridge
      .read(identity, { endpoint: "listUsers", input: {} })
      .then((result) => {
        delivered = true;
        return result;
      });
    const pair = f.pairs[0];
    expect.assert(pair);
    await sessionMessage(
      pair.page,
      (value) => (value as { requestId?: number }).requestId === 2,
    );
    pair.pause();
    const oldResume = f.bridge.resume();
    await expect.poll(() => pair.queued()).toBeGreaterThan(0);
    f.bridge.suspend();
    pair.resume();
    await oldResume;
    expect(delivered).toBe(false);
    await f.bridge.resume();
    expect(await pending).toMatchObject({ ok: true });
  } finally {
    await f.close();
  }
});

test("a malformed snapshot fails closed instead of throwing from the port event handler", async () => {
  const f = fixture();
  try {
    await f.bridge.connect();
    await unlock(f);
    expect(() =>
      f.pairs[0]?.page.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "snapshot", snapshot: null },
        }),
      ),
    ).not.toThrow();
    expect(f.bridge.getSnapshot()).toMatchObject({
      status: "unavailable",
      session: null,
    });
  } finally {
    await f.close();
  }
});

test("restricted owner storage fails closed and closes the opened port", async () => {
  const pair = createSessionPorts();
  let closed = 0;
  const bridge = createSessionBridge({
    openPort: () => ({
      postMessage: pair.page.postMessage.bind(pair.page),
      addEventListener: pair.page.addEventListener.bind(pair.page),
      removeEventListener: pair.page.removeEventListener.bind(pair.page),
      start: () => pair.page.start(),
      close() {
        closed++;
        pair.page.close();
      },
    }),
    ownerTabId() {
      throw new DOMException("Storage blocked", "SecurityError");
    },
    buildId: "build",
    storageVersion: 3,
  });
  try {
    await expect(
      Promise.resolve().then(() => bridge.connect()),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "unavailable" },
    });
    expect(bridge.getSnapshot()).toMatchObject({
      status: "unavailable",
      session: null,
    });
    expect(closed).toBe(1);
  } finally {
    bridge.dispose();
    pair.close();
  }
});

test("a duplicate hello cannot replace an established Worker identity", async () => {
  const f = fixture();
  try {
    await f.bridge.connect();
    await unlock(f);
    const current = f.bridge.getSessionSnapshot();
    expect.assert(current);
    f.pairs[0]?.page.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "hello",
          workerId: "imposter",
          buildId: "build",
          protocolVersion: 1,
          storageVersion: 3,
          snapshot: {
            ...current,
            identity: { workerId: "imposter", sessionId: "new" },
            revision: current.revision + 1,
          },
        },
      }),
    );
    expect(f.bridge.getSnapshot()).toMatchObject({
      status: "unavailable",
      session: null,
      workerId: null,
    });
  } finally {
    await f.close();
  }
});

test("profile commands round-trip cloned inputs and reset notification cannot turn a committed reset into failure", async () => {
  const f = fixture();
  const calls: unknown[] = [];
  let changed = 0;
  let reconnect: Promise<unknown> | undefined;
  const version = { keyEpoch: "epoch", profilesRevision: 1 };
  const expected = {
    version,
    ownerTabId: "owner",
    profile: { id: "profile", credentialVersion: "credential" },
  };
  const commit = {
    version,
    profile: {
      id: "profile",
      name: "Profile",
      baseUrl: "https://fixture.test",
      scope: "persistent" as const,
      keyEpoch: "epoch",
      updatedAt: "2026-10-11",
      credentialVersion: "credential",
      credentialKind: "password" as const,
    },
  };
  f.profiles.list = async (context) => {
    calls.push(context.ownerTabId);
    return {
      ok: true,
      value: { profiles: [commit.profile], version, unreadableRecords: 0 },
    };
  };
  f.profiles.save = async (input, context) => {
    calls.push({ input, owner: context.ownerTabId });
    f.protocol.notifyProfiles();
    return { ok: true, value: { saved: true, commit, activation: null } };
  };
  f.profiles.migrate = async (input) => {
    calls.push(input);
    f.protocol.notifyProfiles();
    return { ok: true, value: commit };
  };
  f.profiles.changePassword = async (input) => {
    calls.push(input);
    f.protocol.notifyProfiles();
    return { ok: true, value: commit };
  };
  f.profiles.delete = async (input) => {
    calls.push(input);
    f.protocol.notifyProfiles();
    return { ok: true, value: { version } };
  };
  f.profiles.reset = async (input) => {
    calls.push(input);
    f.protocol.notifyReset(version);
    return {
      ok: true,
      value: { committed: true, version, sessionMetadataCleared: false },
    };
  };
  const stopProfiles = f.bridge.subscribeProfiles(() => changed++);
  const stopReset = f.bridge.subscribeReset((received) => {
    expect(received).toEqual(version);
    reconnect = f.bridge.reconnect();
  });
  try {
    const first = f.bridge.connect();
    expect(f.bridge.connect()).toBe(first);
    await first;
    expect(await f.bridge.connect()).toMatchObject({ ok: true });
    expect(await f.bridge.listProfiles()).toMatchObject({
      ok: true,
      value: { profiles: [commit.profile] },
    });
    expect(
      await f.bridge.saveProfile({
        kind: "credentials",
        expected: { ...expected, profile: null },
        profile: {
          id: "profile",
          name: "Profile",
          baseUrl: "https://fixture.test",
          scope: "persistent",
        },
        apiKey: "input-only-secret",
        password: "input-only-password",
        validation: "required",
        activate: false,
        expectedWorkerId: "worker",
        expectedIdentity: null,
      }),
    ).toMatchObject({ ok: true, value: { saved: true, activation: null } });
    expect(
      await f.bridge.saveProfile({
        kind: "metadata",
        expected,
        name: "Renamed",
        scope: "session",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await f.bridge.migrateProfile({
        expected,
        password: "new-password",
        legacyPassword: "old-password",
      }),
    ).toMatchObject({ ok: true, value: commit });
    expect(
      await f.bridge.changeProfilePassword({
        expected,
        password: "old-password",
        newPassword: "new-password",
      }),
    ).toMatchObject({ ok: true, value: commit });
    expect(await f.bridge.deleteProfile(expected)).toEqual({
      ok: true,
      value: { version },
    });
    await expect.poll(() => changed).toBe(5);
    expect(calls[0]).toBe("owner");
    expect(calls[1]).toMatchObject({
      owner: "owner",
      input: { apiKey: "input-only-secret", expected: { profile: null } },
    });
    expect(await f.bridge.resetStorage(version)).toEqual({
      ok: true,
      value: { committed: true, version, sessionMetadataCleared: false },
    });
    await expect.poll(() => reconnect !== undefined).toBe(true);
    await reconnect;
    expect(f.bridge.getSnapshot().status).toBe("ready-locked");
    expect(JSON.stringify(f.bridge.getSnapshot())).not.toMatch(
      /input-only|password/,
    );
  } finally {
    stopProfiles();
    stopReset();
    await f.close();
  }
});

test("fault DTOs survive the port while a stale or pre-cancelled call never dispatches", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return {
      ok: false,
      error: {
        kind: "api",
        code: "HTTP_STATUS",
        message: "Request failed",
        status: 409,
        data: { message: "conflict" },
      },
    };
  });
  try {
    expect(await f.bridge.check()).toEqual({
      ok: false,
      error: { kind: "unavailable" },
    });
    await f.bridge.connect();
    const identity = await unlock(f);
    expect(await f.bridge.touch(identity)).toMatchObject({ ok: true });
    expect(
      await f.bridge.read(
        { ...identity, sessionId: "stale" },
        { endpoint: "listUsers", input: {} },
      ),
    ).toMatchObject({ ok: false, error: { kind: "stale" } });
    const signal = AbortSignal.abort();
    expect(
      await f.bridge.read(
        identity,
        { endpoint: "listUsers", input: {} },
        { signal },
      ),
    ).toMatchObject({ ok: false, error: { kind: "cancelled" } });
    expect(calls).toBe(0);
    expect(
      await f.bridge.read(identity, { endpoint: "listUsers", input: {} }),
    ).toEqual({
      ok: false,
      error: {
        kind: "api",
        code: "HTTP_STATUS",
        message: "Request failed",
        status: 409,
        data: { message: "conflict" },
      },
    });
    expect(calls).toBe(1);
    f.bridge.dispose();
    expect(await f.bridge.connect()).toMatchObject({
      ok: false,
      error: { kind: "unavailable" },
    });
  } finally {
    await f.close();
  }
});

test.each(["unavailable", "reload-required"] as const)(
  "Worker startup errors reach the page as %s",
  async (kind) => {
    const pair = createSessionPorts();
    const bridge = createSessionBridge({
      openPort: () => pair.page,
      ownerTabId: () => "owner",
      buildId: "build",
      storageVersion: 3,
    });
    try {
      const started = bridge.reconnect();
      pair.worker.postMessage({ type: "error", error: { kind } });
      expect(await started).toEqual({ ok: false, error: { kind } });
      expect(bridge.getSnapshot().status).toBe(kind);
    } finally {
      bridge.dispose();
      pair.close();
    }
  },
);

test("a failed page post resolves every command and retains no authorization", async () => {
  const f = fixture();
  try {
    await f.bridge.connect();
    const identity = await unlock(f);
    const pair = f.pairs[0];
    expect.assert(pair);
    pair.page.postMessage = () => {
      throw new DOMException("Port failed", "DataCloneError");
    };
    expect(
      await f.bridge.read(identity, { endpoint: "listUsers", input: {} }),
    ).toEqual({
      ok: false,
      error: { kind: "unavailable" },
    });
    expect(f.bridge.getSnapshot()).toMatchObject({
      status: "unavailable",
      session: null,
    });
  } finally {
    await f.close();
  }
});

test.each([
  null,
  { type: "unexpected" },
  { type: "reply", requestId: 1, result: { ok: false, error: null } },
  {
    type: "snapshot",
    snapshot: {
      status: "locked",
      revision: 0,
      reason: "initial",
      pendingProfileId: null,
      identity: null,
      profile: { apiKey: "never-publish" },
      expiresAt: null,
    },
  },
])("malformed Worker reply is rejected: %j", async (message) => {
  const f = fixture();
  try {
    await f.bridge.connect();
    f.pairs[0]?.page.dispatchEvent(
      new MessageEvent("message", { data: message }),
    );
    expect(f.bridge.getSnapshot()).toMatchObject({
      status: "unavailable",
      session: null,
    });
  } finally {
    await f.close();
  }
});

/** Starts a suspended write, waits until the Worker has answered it, and returns the handle. */
async function held(
  f: ReturnType<typeof fixture>,
  command: Parameters<ReturnType<typeof fixture>["bridge"]["write"]>[1],
) {
  await f.bridge.connect();
  const identity = await unlock(f);
  f.bridge.suspend();
  const pending = f.bridge.write(identity, command);
  const pair = f.pairs[0];
  expect.assert(pair);
  await sessionMessage(
    pair.page,
    (value) => (value as { requestId?: number }).requestId === 2,
  );
  return { identity, pending, pair };
}

test("a write answered by the Worker but not yet delivered is unconfirmed when the port is lost", async () => {
  const f = fixture(async () => ({ ok: true, value: { policy: "{}" } }));
  try {
    const { pending, pair } = await held(f, {
      endpoint: "setPolicy",
      input: { policy: "{}" },
    });
    pair.page.dispatchEvent(new MessageEvent("messageerror"));
    expect(await pending).toEqual({
      ok: false,
      error: { kind: "unavailable", outcome: "unknown" },
    });
  } finally {
    await f.close();
  }
});

test("a read cannot have been applied, so losing the port carries no outcome", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const timer = scheduler();
  const f = fixture(async () => {
    started.resolve();
    await release.promise;
    return { ok: true, value: undefined };
  }, timer.schedule);
  try {
    await f.bridge.connect();
    const identity = await unlock(f);
    const result = f.bridge.read(identity, {
      endpoint: "listUsers",
      input: {},
    });
    await started.promise;
    timer.fire(20_000);
    expect(await result).toEqual({ ok: false, error: { kind: "unavailable" } });
  } finally {
    release.resolve();
    await f.close();
  }
});

test("a page cancellation after the write was posted is unconfirmed, a read cancellation is not", async () => {
  for (const [publish, command, error] of [
    [
      "write",
      { endpoint: "setPolicy", input: { policy: "{}" } },
      { kind: "cancelled", outcome: "unknown" },
    ],
    ["read", { endpoint: "listUsers", input: {} }, { kind: "cancelled" }],
  ] as const) {
    const started = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<void>();
    const f = fixture(async (_command, context) => {
      started.resolve(context.signal);
      await release.promise;
      return { ok: true, value: "late" };
    });
    try {
      await f.bridge.connect();
      const identity = await unlock(f);
      const abort = new AbortController();
      const pending = f.bridge[publish](identity, command, {
        signal: abort.signal,
      });
      const signal = await started.promise;
      abort.abort();
      await expect.poll(() => signal.aborted).toBe(true);
      expect(await pending).toEqual({ ok: false, error });
    } finally {
      release.resolve();
      await f.close();
    }
  }
});

test("a held API write failure keeps the original server evidence after the session changes", async () => {
  const failure = {
    ok: false,
    error: {
      kind: "api",
      code: "HTTP_STATUS",
      message: "rejected",
      status: 400,
    },
  } as const;
  const f = fixture(async () => failure);
  try {
    const { identity, pending } = await held(f, {
      endpoint: "setPolicy",
      input: { policy: "{}" },
    });
    await f.bridge.lock(identity);
    await f.bridge.resume();
    expect(await pending).toEqual(failure);
  } finally {
    await f.close();
  }
});

const lateApiFailure = (message: string): WorkerErrorDto => ({
  kind: "api",
  code: "HTTP_STATUS",
  status: 400,
  message,
  data: { code: 3, message },
});

test.each<{
  endpoint: "setTags" | "setPolicy" | "checkPolicy";
  error: WorkerErrorDto;
  status: "possibly-applied" | "pre-rejected" | "not-dispatched";
  sameProfile?: boolean;
}>([
  {
    endpoint: "setTags",
    error: lateApiFailure("persisting node: disk full"),
    status: "possibly-applied",
    sameProfile: true,
  },
  {
    endpoint: "setPolicy",
    error: lateApiFailure("reloading policy: failed"),
    status: "possibly-applied",
    sameProfile: true,
  },
  {
    endpoint: "setTags",
    error: lateApiFailure("persisting node: disk full"),
    status: "possibly-applied",
  },
  {
    endpoint: "setPolicy",
    error: lateApiFailure("reloading policy: failed"),
    status: "possibly-applied",
  },
  {
    endpoint: "setPolicy",
    error: lateApiFailure("update is disabled for modes other than 'database'"),
    status: "pre-rejected",
  },
  {
    endpoint: "setTags",
    error: { kind: "api", code: "REQ_INPUT_INVALID", message: "invalid input" },
    status: "not-dispatched",
  },
  {
    endpoint: "checkPolicy",
    error: lateApiFailure("policy invalid"),
    status: "pre-rejected",
  },
])(
  "a suspended $endpoint failure keeps $status evidence without retrying or blocking a new session (same profile: $sameProfile)",
  async ({ endpoint, error, status, sameProfile }) => {
    const data = snapshotFixture();
    let writes = 0;
    const f = fixture(async (operation) => {
      if (operation.type === "api.write") {
        writes++;
        return { ok: false, error };
      }
      const reads: Record<string, unknown> = {
        listUsers: { users: data.users },
        listNodes: { nodes: data.nodes },
        listPreAuthKeys: { preAuthKeys: data.preAuthKeys },
        listApiKeys: { apiKeys: data.apiKeys },
        getPolicy: data.policy,
        health: data.health,
        version: data.version,
      };
      return { ok: true, value: reads[operation.endpoint] };
    });
    let stop: (() => void) | undefined;
    try {
      await f.bridge.connect();
      await unlock(f);
      await hydrateSettings();
      const session = createSession({ bridge: f.bridge, profiles: null });
      stop = session.start();
      await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
      const pair = f.pairs[0];
      expect.assert(pair);
      f.bridge.suspend();
      const received = sessionMessage(pair.page, (value) => {
        const reply = value as {
          type: string;
          result?: SessionResult<unknown>;
        };
        return (
          reply.type === "reply" &&
          reply.result?.ok === false &&
          reply.result.error.kind === "api"
        );
      });
      const command: ApiCommand =
        endpoint === "setTags"
          ? { endpoint, input: { nodeId: "1", tags: ["tag:new", "tag:extra"] } }
          : { endpoint, input: { policy: '{"tagOwners":{"tag:new":[]}}' } };
      const key =
        endpoint === "setTags"
          ? "node-tags"
          : endpoint === "setPolicy"
            ? "save-policy"
            : "check-policy";
      const mutation = createMutation(session);
      const pending = mutation.mutateDetailed(key, command);
      await received;
      await unlock(f, sameProfile ? "profile" : "other-profile");
      const result = await pending;
      expect(result.outcome.status).toBe(status);
      expect(result.outcome.failure).toMatchObject({
        kind: "api",
        code: error.kind === "api" ? error.code : "",
        message:
          endpoint === "setPolicy" && status === "pre-rejected"
            ? i18n._(productDescriptors.policyUpdateDisabled.id)
            : error.kind === "api"
              ? error.message
              : "",
      });
      expect(result.outcome.refresh).toBe("not-requested");
      expect(session.feedback.actionOutcome(key)).toBeUndefined();
      expect(session.feedback.actionError(key)).toBe("");
      expect(writes).toBe(1);
      await f.bridge.resume();
      await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
      await unlock(f);
      await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
      expect(writes).toBe(1);
      expect((await mutation.mutateDetailed(key, command)).outcome.status).toBe(
        "not-dispatched",
      );
      expect(writes).toBe(1);
      const next = await createMutation(session).mutateDetailed(key, command);
      expect(next.outcome.status).toBe(status);
      expect(writes).toBe(2);
    } finally {
      stop?.();
      await f.close();
    }
  },
);

test.each(["read", "write"] as const)(
  "a %s failure arriving with the changed snapshot keeps only safe write evidence",
  async (publish) => {
    const failure = {
      ok: false,
      error: lateApiFailure("persisting policy: disk full"),
    } as const;
    const f = fixture(async () => failure);
    try {
      await f.bridge.connect();
      const identity = await unlock(f);
      const pair = f.pairs[0];
      expect.assert(pair);
      pair.pause();
      const pending =
        publish === "write"
          ? f.bridge.write(identity, {
              endpoint: "setPolicy",
              input: { policy: "{}" },
            })
          : f.bridge.read(identity, { endpoint: "getPolicy" });
      await expect.poll(() => pair.queued()).toBeGreaterThan(0);
      f.runtime.auth.lock(identity);
      pair.page.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "reply",
            requestId: 2,
            result: failure,
            snapshot: f.runtime.auth.getSnapshot(),
          },
        }),
      );
      expect(await pending).toEqual(
        publish === "write" ? failure : { ok: false, error: { kind: "stale" } },
      );
    } finally {
      await f.close();
    }
  },
);

test("a held plain session failure of a write is not a definite answer", async () => {
  const f = fixture(async () => ({ ok: false, error: { kind: "cancelled" } }));
  try {
    const { identity, pending } = await held(f, {
      endpoint: "setPolicy",
      input: { policy: "{}" },
    });
    await f.bridge.lock(identity);
    await f.bridge.resume();
    expect(await pending).toEqual({
      ok: false,
      error: { kind: "stale", outcome: "unknown" },
    });
  } finally {
    await f.close();
  }
});

test("a write for another identity is a bare stale and never reaches the Worker", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return { ok: true, value: { apiKey: "never" } };
  });
  try {
    await f.bridge.connect();
    const identity = await unlock(f);
    expect(
      await f.bridge.write(
        { ...identity, sessionId: "stale" },
        {
          endpoint: "createApiKey",
          input: { expiration: "2027-01-01T00:00:00Z" },
        },
      ),
    ).toEqual({ ok: false, error: { kind: "stale" } });
    expect(calls).toBe(0);
  } finally {
    await f.close();
  }
});

test("a late message from a replaced port cannot change the current connection", async () => {
  const f = fixture();
  const listeners: EventListener[][] = [];
  const bridge = createSessionBridge({
    openPort() {
      const pair = createSessionPorts();
      f.pairs.push(pair);
      f.protocol.connect(pair.worker);
      const mine: EventListener[] = [];
      listeners.push(mine);
      // A port that keeps delivering after removeEventListener, like a message already in flight.
      return {
        postMessage: (message) => pair.page.postMessage(message),
        addEventListener(
          type: string,
          listener: EventListenerOrEventListenerObject,
        ) {
          if (type === "message") mine.push(listener as EventListener);
          pair.page.addEventListener(type, listener);
        },
        removeEventListener: () => {},
        start: () => pair.page.start(),
        close: () => pair.page.close(),
      };
    },
    ownerTabId: () => "owner",
    buildId: "worker-build",
    storageVersion: 3,
    now: f.clock.now,
  });
  try {
    await bridge.connect();
    await bridge.reconnect();
    expect(listeners).toHaveLength(2);
    expect(bridge.getSnapshot().status).toBe("ready-locked");
    for (const listener of listeners[0] ?? [])
      listener(
        new MessageEvent("message", {
          data: { type: "error", error: { kind: "busy" } },
        }),
      );
    expect(bridge.getSnapshot().status).toBe("ready-locked");
  } finally {
    bridge.dispose();
    await f.close();
  }
});
