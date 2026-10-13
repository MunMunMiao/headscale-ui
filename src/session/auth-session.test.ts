import { expect, test, vi } from "vitest";
import { createManualClock } from "@/test/session-clock";
import {
  type AuthSessionDependencies,
  createAuthSession,
  SESSION_IDLE_MS,
  SessionFault,
  type UnlockInput,
} from "./auth-session";
import { executeOperation } from "./operation-dispatch";
import type { PublicSessionSnapshot, SessionIdentity, SessionResult } from "./types";
import { ApiError } from "./types";

function successful<T>(result: SessionResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Unexpected failure: ${result.error.kind}`);
  return result.value;
}

function identityOf(snapshot: PublicSessionSnapshot): SessionIdentity {
  if (!snapshot.identity) throw new Error("Expected an unlocked identity");
  return snapshot.identity;
}

function fixture(overrides: Partial<AuthSessionDependencies> = {}) {
  const clock = createManualClock();
  let sequence = 0;
  const execute = vi.fn<AuthSessionDependencies["execute"]>(async (_command, context) => {
    context.requireCurrent();
    return { ok: true, value: { users: [] } };
  });
  const deps: AuthSessionDependencies = {
    workerId: "worker-a",
    now: clock.now,
    newSessionId: () => `session-${++sequence}`,
    openCredential: async (input) => ({
      profile: { id: input.profileId, name: input.profileId, baseUrl: "https://headscale.test" },
      credentialVersion: input.expectedCredentialVersion,
      keyEpoch: "epoch-a",
      apiKey: "worker-only-key",
    }),
    readCurrentProfile: async (candidate) => candidate.profile,
    validateCredential: async () => {},
    execute,
    ...overrides,
  };
  const session = createAuthSession(deps);
  const input = (profileId = "profile-a"): UnlockInput => ({
    profileId,
    password: " profile password ",
    expectedWorkerId: "worker-a",
    expectedIdentity: session.getSnapshot().identity,
    expectedCredentialVersion: "credential-1",
    operationId: `unlock-${profileId}`,
    ownerTabId: "tab-a",
    portId: "port-a",
  });
  return { session, clock, deps, execute, input };
}

test("credential validation preserves API fault semantics without exposing the connection secret", async () => {
  const f = fixture();
  const active = successful(await f.session.unlock(f.input()));
  f.deps.validateCredential = async () => {
    throw new ApiError({
      kind: "api",
      code: "HTTP_STATUS",
      status: 503,
      message: "Rejected worker-only-key",
      data: { code: 14, message: "Unavailable worker-only-key", details: [] },
    });
  };
  expect(await f.session.unlock(f.input("profile-b"))).toEqual({
    ok: false,
    error: {
      kind: "api",
      code: "HTTP_STATUS",
      status: 503,
      message: "Rejected [redacted]",
      data: { code: 14, message: "Unavailable [redacted]", details: [] },
    },
  });
  expect(f.session.getSnapshot()).toMatchObject({
    status: "unlocked",
    identity: active.identity,
    profile: active.profile,
  });
});

test("unlock starts a 30 minute session with a stable, public-only snapshot", async () => {
  const { session, input } = fixture();
  const unlocked = successful(await session.unlock(input()));
  expect(unlocked).toEqual({
    status: "unlocked",
    identity: { workerId: "worker-a", sessionId: "session-1" },
    profile: { id: "profile-a", name: "profile-a", baseUrl: "https://headscale.test" },
    expiresAt: 2_800_000,
    pendingProfileId: null,
    reason: null,
    revision: 2,
    apiKeyPrefix: null,
  });
  expect(session.getSnapshot()).toBe(unlocked);
  expect(session.getSnapshot()).toBe(unlocked);
  expect(structuredClone(unlocked)).toEqual(unlocked);
  expect(JSON.stringify(unlocked)).not.toMatch(/worker-only-key|profile password|credential-1/);
  expect(Object.isFrozen(unlocked)).toBe(true);
  expect(Object.isFrozen(unlocked.identity)).toBe(true);
  expect(Object.isFrozen(unlocked.profile)).toBe(true);
});

const newFormatKey = "hskey-api-abcdefghijkl-secretSECRETsecretSECRETsecret";
const legacyKey = "abcdefg.secretSECRETsecretSECRETsecret";
test.each([
  ["a new-format key", newFormatKey, "hskey-api-abcdefghijkl-***"],
  ["a legacy key", legacyKey, "abcdefg***"],
  ["a key with no listed form", "worker-only-key", null],
])("an unlock with %s publishes only its listed prefix", async (_name, apiKey, prefix) => {
  const f = fixture({
    openCredential: async (input) => ({
      profile: { id: input.profileId, name: input.profileId, baseUrl: "https://headscale.test" },
      credentialVersion: input.expectedCredentialVersion,
      keyEpoch: "epoch-a",
      apiKey,
    }),
  });
  expect(f.session.getSnapshot().apiKeyPrefix).toBeNull();
  const unlocked = successful(await f.session.unlock(f.input()));
  expect(unlocked.apiKeyPrefix).toBe(prefix);
  expect(structuredClone(unlocked)).toEqual(unlocked);
  expect(JSON.stringify(unlocked)).not.toContain(apiKey.slice(prefix === null ? 0 : 20));
});

test.each([
  ["lock", (f: ReturnType<typeof fixture>, id: SessionIdentity) => f.session.lock(id)],
  ["expiry", (f: ReturnType<typeof fixture>) => f.clock.set(SESSION_IDLE_MS + 1_000_000)],
  ["clock reversal", (f: ReturnType<typeof fixture>) => f.clock.set(1)],
  ["profile change", (f: ReturnType<typeof fixture>) => f.session.invalidateProfile("profile-a")],
])("%s clears the published key prefix", async (_name, end) => {
  const f = fixture({
    openCredential: async (input) => ({
      profile: { id: input.profileId, name: input.profileId, baseUrl: "https://headscale.test" },
      credentialVersion: input.expectedCredentialVersion,
      keyEpoch: "epoch-a",
      apiKey: newFormatKey,
    }),
  });
  const identity = identityOf(successful(await f.session.unlock(f.input())));
  expect(f.session.getSnapshot().apiKeyPrefix).not.toBeNull();
  end(f, identity);
  f.session.check();
  expect(f.session.getSnapshot()).toMatchObject({ status: "locked", apiKeyPrefix: null });
});

test("touch checks the deadline before extending it, including exact equality", async () => {
  const { session, input, clock, execute } = fixture();
  const identity = identityOf(successful(await session.unlock(input())));
  clock.set(2_799_999);
  expect(successful(session.touch(identity)).expiresAt).toBe(4_599_999);
  clock.set(4_599_999);
  expect(session.touch(identity)).toEqual({ ok: false, error: { kind: "expired" } });
  expect(
    await session.execute(identity, { type: "api.read", endpoint: "listUsers", input: {} }),
  ).toEqual({
    ok: false,
    error: { kind: "expired" },
  });
  expect(execute).not.toHaveBeenCalled();
  expect(session.getSnapshot()).toMatchObject({
    status: "locked",
    reason: "expired",
    identity: null,
    profile: null,
    expiresAt: null,
  });
});

test("without running a timer, passive checks expire while the getter stays pure", async () => {
  const { session, input, clock } = fixture();
  const unlocked = successful(await session.unlock(input()));
  clock.advance(1_800_000);
  expect(session.getSnapshot()).toBe(unlocked);
  expect(session.check()).toEqual({ ok: false, error: { kind: "expired" } });
  expect(session.getSnapshot().status).toBe("locked");
  expect(successful(session.check()).status).toBe("locked");
});

test("an expired execute is rejected before invoking the transport", async () => {
  const { session, input, clock, execute } = fixture();
  const identity = identityOf(successful(await session.unlock(input())));
  clock.advance(1_800_000);
  expect(
    await session.execute(identity, { type: "api.read", endpoint: "listUsers", input: {} }),
  ).toEqual({
    ok: false,
    error: { kind: "expired" },
  });
  expect(execute).not.toHaveBeenCalled();
});

test("only user activity renews; execute and unchanged checks keep the snapshot", async () => {
  const { session, input, clock } = fixture();
  const unlocked = successful(await session.unlock(input()));
  clock.advance(90_000);
  expect(
    successful(
      await session.execute(identityOf(unlocked), {
        type: "api.read",
        endpoint: "listUsers",
        input: {},
      }),
    ),
  ).toEqual({ users: [] });
  expect(successful(session.check(identityOf(unlocked)))).toBe(unlocked);
  expect(session.getSnapshot()).toBe(unlocked);
  expect(session.getSnapshot().expiresAt).toBe(2_800_000);
});

test("an observed backwards clock locks the session and aborts its requests", async () => {
  let signal: AbortSignal | undefined;
  const held = Promise.withResolvers<SessionResult<unknown>>();
  const { session, input, clock } = fixture({
    execute: async (_command, context) => {
      signal = context.signal;
      return held.promise;
    },
  });
  const identity = identityOf(successful(await session.unlock(input())));
  const pending = session.execute(identity, { type: "api.read", endpoint: "listUsers", input: {} });
  clock.set(999_999);
  expect(session.touch(identity)).toEqual({ ok: false, error: { kind: "locked" } });
  expect(session.getSnapshot().reason).toBe("clock-reversed");
  expect(signal?.aborted).toBe(true);
  held.resolve({ ok: true, value: "old result" });
  expect(await pending).toEqual({ ok: false, error: { kind: "locked" } });
});

test("a clock reversal observed during a pending unlock fails it as locked and unlocks nothing", async () => {
  const f = fixture();
  successful(await f.session.unlock(f.input()));
  const open = f.deps.openCredential;
  const release = Promise.withResolvers<void>();
  f.deps.openCredential = async (input, signal) => {
    await release.promise;
    return open(input, signal);
  };
  const pending = f.session.unlock(f.input("profile-b"));
  f.clock.set(f.clock.now() - 1);
  expect(f.session.check()).toEqual({ ok: false, error: { kind: "locked" } });
  release.resolve();
  expect(await pending).toEqual({ ok: false, error: { kind: "locked" } });
  expect(f.session.getSnapshot()).toMatchObject({
    status: "locked",
    reason: "clock-reversed",
    pendingProfileId: null,
    identity: null,
  });
});

test("the transport guard rechecks a deadline reached after request admission", async () => {
  const clock = createManualClock();
  let guardError: unknown;
  const { session, input } = fixture({
    now: clock.now,
    execute: async (_command, context) => {
      clock.advance(1_800_000);
      try {
        context.requireCurrent();
      } catch (error) {
        guardError = error;
        throw error;
      }
      return { ok: true, value: "must not send" };
    },
  });
  const identity = identityOf(successful(await session.unlock(input())));
  expect(
    await session.execute(identity, { type: "api.read", endpoint: "listUsers", input: {} }),
  ).toEqual({
    ok: false,
    error: { kind: "expired" },
  });
  expect(guardError).toBeInstanceOf(SessionFault);
});

test("an HTTP result decoded after expiration is rejected even if its promise succeeds", async () => {
  const clock = createManualClock();
  const { session, input } = fixture({
    now: clock.now,
    execute: async () => {
      clock.advance(1_800_000);
      return { ok: true, value: "late decoded response" };
    },
  });
  const identity = identityOf(successful(await session.unlock(input())));
  expect(
    await session.execute(identity, { type: "api.read", endpoint: "listUsers", input: {} }),
  ).toEqual({
    ok: false,
    error: { kind: "expired" },
  });
});

test("locking invalidates a pending decrypt and never validates its late credential", async () => {
  const opened = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const validateCredential = vi.fn(async () => {});
  let signal: AbortSignal | undefined;
  const { session, input, deps } = fixture({ validateCredential });
  const open = deps.openCredential;
  deps.openCredential = async (value, cancellation) => {
    signal = cancellation;
    opened.resolve();
    await release.promise;
    return open(value, cancellation);
  };
  const pending = session.unlock(input());
  await opened.promise;
  expect(session.getSnapshot().pendingProfileId).toBe("profile-a");
  expect(successful(session.lock(null)).status).toBe("locked");
  expect(signal?.aborted).toBe(true);
  release.resolve();
  expect(await pending).toEqual({ ok: false, error: { kind: "stale" } });
  expect(validateCredential).not.toHaveBeenCalled();
  expect(session.getSnapshot().pendingProfileId).toBeNull();
});

test("a second unlock is busy while the first owns the only candidate", async () => {
  const release = Promise.withResolvers<void>();
  const { session, input } = fixture({ validateCredential: () => release.promise });
  const pending = session.unlock(input());
  expect(await session.unlock(input("profile-b"))).toEqual({ ok: false, error: { kind: "busy" } });
  expect(session.getSnapshot().pendingProfileId).toBe("profile-a");
  release.resolve();
  expect(successful(await pending).profile?.id).toBe("profile-a");
});

test("failed candidate credentials preserve the still-valid current session", async () => {
  const { session, input, deps } = fixture();
  const original = successful(await session.unlock(input()));
  deps.openCredential = async () => {
    throw new SessionFault("unlock-failed");
  };
  expect(await session.unlock(input("profile-b"))).toEqual({
    ok: false,
    error: { kind: "unlock-failed" },
  });
  expect(session.getSnapshot()).toMatchObject({
    identity: original.identity,
    expiresAt: original.expiresAt,
    pendingProfileId: null,
  });
  expect(
    successful(
      await session.execute(identityOf(original), {
        type: "api.read",
        endpoint: "listUsers",
        input: {},
      }),
    ),
  ).toEqual({ users: [] });
});

test("candidate failure cannot restore an old session that expired during validation", async () => {
  const { session, input, deps, clock } = fixture();
  successful(await session.unlock(input()));
  deps.validateCredential = async () => {
    clock.advance(1_800_000);
    throw new SessionFault("unlock-failed");
  };
  expect(await session.unlock(input("profile-b"))).toEqual({
    ok: false,
    error: { kind: "expired" },
  });
  expect(session.getSnapshot()).toMatchObject({
    status: "locked",
    pendingProfileId: null,
    reason: "expired",
  });
});

test("peer activity while a switch is validating does not invalidate the candidate", async () => {
  const { session, input, deps, clock } = fixture();
  const original = successful(await session.unlock(input()));
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  deps.validateCredential = async () => {
    started.resolve();
    await release.promise;
  };
  const switching = session.unlock(input("profile-b"));
  await started.promise;
  clock.advance(1000);
  successful(session.touch(identityOf(original)));
  release.resolve();
  const switched = successful(await switching);
  expect(switched.profile?.id).toBe("profile-b");
  expect(switched.identity).not.toEqual(original.identity);
});

test("a changed credential version cannot commit a candidate", async () => {
  const { session, input, deps } = fixture();
  deps.readCurrentProfile = async () => null;
  expect(await session.unlock(input())).toEqual({ ok: false, error: { kind: "storage-conflict" } });
  expect(session.getSnapshot()).toMatchObject({ status: "locked", pendingProfileId: null });
});

test.each(["id", "baseUrl"] as const)(
  "a metadata refresh cannot rebind a candidate's %s",
  async (field) => {
    const f = fixture();
    f.deps.readCurrentProfile = async (candidate) => ({ ...candidate.profile, [field]: "changed" });
    expect(await f.session.unlock(f.input())).toEqual({
      ok: false,
      error: { kind: "storage-conflict" },
    });
    expect(f.session.getSnapshot().status).toBe("locked");
  },
);

test("unlock rejects a credential different from the requested profile or version", async () => {
  for (const change of ["profile", "version"] as const) {
    const { session, input, deps } = fixture();
    const open = deps.openCredential;
    deps.openCredential = async (...args) => {
      const credential = await open(...args);
      if (change === "profile") credential.profile = { ...credential.profile, id: "other" };
      else credential.credentialVersion = "changed";
      return credential;
    };
    expect(await session.unlock(input())).toEqual({
      ok: false,
      error: { kind: "storage-conflict" },
    });
  }
});

test("unlock validates identity, nonempty password, and cancellation before opening credentials", async () => {
  const { session, input, deps } = fixture();
  const open = vi.fn(deps.openCredential);
  deps.openCredential = open;
  expect(await session.unlock({ ...input(), expectedWorkerId: "old-worker" })).toEqual({
    ok: false,
    error: { kind: "stale" },
  });
  expect(
    await session.unlock({
      ...input(),
      expectedIdentity: { workerId: "worker-a", sessionId: "old-session" },
    }),
  ).toEqual({ ok: false, error: { kind: "stale" } });
  expect(await session.unlock({ ...input(), password: "" })).toEqual({
    ok: false,
    error: { kind: "unlock-failed" },
  });
  const controller = new AbortController();
  controller.abort();
  expect(await session.unlock(input(), { signal: controller.signal })).toEqual({
    ok: false,
    error: { kind: "cancelled" },
  });
  expect(open).not.toHaveBeenCalled();
});

test("every successful unlock replaces identity and old messages cannot affect its successor", async () => {
  const { session, input } = fixture();
  const first = identityOf(successful(await session.unlock(input())));
  const second = identityOf(successful(await session.unlock(input())));
  expect(second.sessionId).not.toBe(first.sessionId);
  expect(session.touch(first)).toEqual({ ok: false, error: { kind: "stale" } });
  expect(session.lock(first)).toEqual({ ok: false, error: { kind: "stale" } });
  expect(session.lock(null)).toEqual({ ok: false, error: { kind: "stale" } });
  expect(
    await session.execute(first, { type: "api.read", endpoint: "listUsers", input: {} }),
  ).toEqual({
    ok: false,
    error: { kind: "stale" },
  });
  expect(session.getSnapshot().identity).toEqual(second);
  successful(session.lock(second));
  expect(session.getSnapshot().status).toBe("locked");
});

test("normal activity preserves an in-flight request but a switch aborts and rejects it", async () => {
  const { session, input, deps, clock } = fixture();
  const first = identityOf(successful(await session.unlock(input())));
  let pending = Promise.withResolvers<SessionResult<unknown>>();
  let signal: AbortSignal | undefined;
  deps.execute = async (_command, context) => {
    signal = context.signal;
    return pending.promise;
  };
  const firstRead = session.execute(first, { type: "api.read", endpoint: "listUsers", input: {} });
  clock.advance(10);
  successful(session.touch(first));
  expect(signal?.aborted).toBe(false);
  pending.resolve({ ok: true, value: "same-session" });
  expect(successful(await firstRead)).toBe("same-session");
  pending = Promise.withResolvers();
  const staleRead = session.execute(first, { type: "api.read", endpoint: "listUsers", input: {} });
  successful(await session.unlock(input("profile-b")));
  expect(signal?.aborted).toBe(true);
  pending.resolve({ ok: true, value: "old-session" });
  expect(await staleRead).toEqual({ ok: false, error: { kind: "stale" } });
});

test("snapshots notify only on changes and subscriptions can be released", async () => {
  const { session, input } = fixture();
  const listener = vi.fn();
  const stop = session.subscribe(listener);
  const snapshot = successful(await session.unlock(input()));
  expect(listener).toHaveBeenCalledTimes(2);
  expect(successful(session.touch(identityOf(snapshot)))).toBe(snapshot);
  expect(listener).toHaveBeenCalledTimes(2);
  stop();
  const locked = successful(session.lock(snapshot.identity));
  expect(listener).toHaveBeenCalledTimes(2);
  expect(successful(session.lock(null))).toBe(locked);
});

test("expiry during successful candidate validation remains expired instead of becoming stale", async () => {
  const { session, input, deps, clock } = fixture();
  successful(await session.unlock(input()));
  deps.validateCredential = async () => {
    clock.advance(1_800_000);
  };
  expect(await session.unlock(input("profile-b"))).toEqual({
    ok: false,
    error: { kind: "expired" },
  });
  expect(session.getSnapshot().reason).toBe("expired");
});

test("candidate validation has a final-send guard for lock and elapsed idle deadlines", async () => {
  for (const invalidate of ["lock", "expiry"] as const) {
    const { session, input, deps, clock } = fixture();
    const original = identityOf(successful(await session.unlock(input())));
    let sendCount = 0;
    deps.validateCredential = async (_credential, _signal, requireCurrent) => {
      if (invalidate === "lock") session.lock(original);
      else clock.advance(1_800_000);
      requireCurrent();
      sendCount++;
    };
    expect(await session.unlock(input("profile-b"))).toEqual({
      ok: false,
      error: { kind: invalidate === "lock" ? "stale" : "expired" },
    });
    expect(sendCount).toBe(0);
  }
});

test("cancelling a request stops its signal and cannot deliver a late success", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  const { session, input } = fixture({
    execute: async (_command, context) => {
      signal = context.signal;
      started.resolve();
      await release.promise;
      return { ok: true, value: "cancelled response" };
    },
  });
  const identity = identityOf(successful(await session.unlock(input())));
  const controller = new AbortController();
  const pending = session.execute(
    identity,
    { type: "api.read", endpoint: "listUsers", input: {} },
    { signal: controller.signal },
  );
  await started.promise;
  controller.abort();
  expect(signal?.aborted).toBe(true);
  release.resolve();
  expect(await pending).toEqual({ ok: false, error: { kind: "cancelled" } });
  expect(session.getSnapshot().identity).toEqual(identity);
});

test("already-cancelled requests never enter the transport", async () => {
  const { session, input, execute } = fixture();
  const identity = identityOf(successful(await session.unlock(input())));
  expect(
    await session.execute(
      identity,
      { type: "api.read", endpoint: "listUsers", input: {} },
      { signal: AbortSignal.abort() },
    ),
  ).toEqual({ ok: false, error: { kind: "cancelled" } });
  expect(execute).not.toHaveBeenCalled();
});

test("cancelling an unlock stops validation and leaves the old session valid", async () => {
  const { session, input, deps } = fixture();
  const original = identityOf(successful(await session.unlock(input())));
  const controller = new AbortController();
  let signal: AbortSignal | undefined;
  deps.validateCredential = async (_credential, cancellation) => {
    signal = cancellation;
    controller.abort();
  };
  expect(await session.unlock(input("profile-b"), { signal: controller.signal })).toEqual({
    ok: false,
    error: { kind: "cancelled" },
  });
  expect(signal?.aborted).toBe(true);
  expect(session.getSnapshot()).toMatchObject({ identity: original, pendingProfileId: null });
});

test("untrusted errors are sanitized and typed API failures stay within the result envelope", async () => {
  const { session, input, deps } = fixture();
  deps.openCredential = async () => {
    throw new Error("password=secret");
  };
  expect(await session.unlock(input())).toEqual({ ok: false, error: { kind: "unlock-failed" } });
  const normal = fixture();
  const identity = identityOf(successful(await normal.session.unlock(normal.input())));
  normal.deps.execute = async () => {
    throw new Error("Authorization: Bearer secret");
  };
  expect(
    await normal.session.execute(identity, { type: "api.read", endpoint: "listUsers", input: {} }),
  ).toEqual({
    ok: false,
    error: { kind: "unavailable" },
  });
  const apiResult = {
    ok: false,
    error: { kind: "api", code: "NET_TIMEOUT", message: "Request timed out" },
  } as const;
  normal.deps.execute = async () => apiResult;
  expect(
    await normal.session.execute(identity, { type: "api.read", endpoint: "listUsers", input: {} }),
  ).toBe(apiResult);
});

test("execution binds a private identity even if the caller mutates its original object", async () => {
  const { session, input, deps } = fixture();
  const expected = { ...identityOf(successful(await session.unlock(input()))) };
  const release = Promise.withResolvers<void>();
  let finalCheck: (() => unknown) | undefined;
  deps.execute = async (_command, context) => {
    finalCheck = context.requireCurrent;
    await release.promise;
    finalCheck();
    return { ok: true, value: "old" };
  };
  const pending = session.execute(expected, { type: "api.read", endpoint: "listUsers", input: {} });
  const next = identityOf(successful(await session.unlock(input("profile-b"))));
  expected.sessionId = next.sessionId;
  release.resolve();
  expect(await pending).toEqual({ ok: false, error: { kind: "stale" } });
});

test("a completed candidate cannot authorize another validation request", async () => {
  let retained: (() => void) | undefined;
  const { session, input } = fixture({
    validateCredential: async (_credential, _signal, requireCurrent) => {
      retained = requireCurrent;
    },
  });
  successful(await session.unlock(input()));
  expect(retained).toThrow("stale");
});

test("unlock and lock also enforce elapsed deadlines instead of bypassing them", async () => {
  for (const operation of ["unlock", "lock"] as const) {
    const { session, input, clock } = fixture();
    const identity = identityOf(successful(await session.unlock(input())));
    clock.advance(1_800_000);
    const result =
      operation === "unlock" ? await session.unlock(input("profile-b")) : session.lock(identity);
    expect(result).toEqual({ ok: false, error: { kind: "expired" } });
    expect(session.getSnapshot().status).toBe("locked");
  }
});

test("a request cancelled between admission and its final-send guard never sends", async () => {
  const controller = new AbortController();
  let sends = 0;
  const { session, input } = fixture({
    execute: async (_command, context) => {
      controller.abort();
      context.requireCurrent();
      sends++;
      return { ok: true, value: "cannot send" };
    },
  });
  const identity = identityOf(successful(await session.unlock(input())));
  expect(
    await session.execute(
      identity,
      { type: "api.read", endpoint: "listUsers", input: {} },
      { signal: controller.signal },
    ),
  ).toEqual({ ok: false, error: { kind: "cancelled" } });
  expect(sends).toBe(0);
});

test("a rejected transport completion is also checked against the captured identity", async () => {
  const release = Promise.withResolvers<void>();
  const { session, input } = fixture({
    execute: async () => {
      await release.promise;
      throw new Error("old transport failure");
    },
  });
  const identity = identityOf(successful(await session.unlock(input())));
  const pending = session.execute(identity, { type: "api.read", endpoint: "listUsers", input: {} });
  successful(await session.unlock(input("profile-b")));
  release.resolve();
  expect(await pending).toEqual({ ok: false, error: { kind: "stale" } });
});

test("native abort rejection is a cancelled request while its session remains valid", async () => {
  const controller = new AbortController();
  const { session, input } = fixture({
    execute: async () => {
      controller.abort();
      throw new DOMException("The operation was aborted", "AbortError");
    },
  });
  const identity = identityOf(successful(await session.unlock(input())));
  expect(
    await session.execute(
      identity,
      { type: "api.read", endpoint: "listUsers", input: {} },
      { signal: controller.signal },
    ),
  ).toEqual({ ok: false, error: { kind: "cancelled" } });
  expect(session.getSnapshot().identity).toEqual(identity);
});

test("public profile projection never spreads secret or unknown fields from a storage record", async () => {
  const { session, input, deps } = fixture();
  const open = deps.openCredential;
  deps.openCredential = async (...args) => {
    const credential = await open(...args);
    const raw = {
      ...credential.profile,
      apiKey: "must-stay-private",
      unknownLegacyField: "private-data",
    };
    return { ...credential, profile: raw };
  };
  const snapshot = successful(await session.unlock(input()));
  expect(snapshot.profile).toEqual({
    id: "profile-a",
    name: "profile-a",
    baseUrl: "https://headscale.test",
  });
  expect(JSON.stringify(snapshot)).not.toContain("must-stay-private");
  expect(JSON.stringify(snapshot)).not.toContain("unknownLegacyField");
});

test("committed display-name changes update metadata without renewing or replacing authorization", async () => {
  const f = fixture();
  const original = successful(await f.session.unlock(f.input()));
  f.clock.advance(60_000);
  expect(f.session.updateProfileName("another-profile", "Other")).toBe(original);
  const renamed = f.session.updateProfileName("profile-a", "Renamed");
  expect(renamed.profile).toEqual({
    id: "profile-a",
    name: "Renamed",
    baseUrl: "https://headscale.test",
  });
  expect(renamed.identity).toBe(original.identity);
  expect(renamed.expiresAt).toBe(original.expiresAt);
  expect(Object.isFrozen(renamed.profile)).toBe(true);
  expect(f.session.updateProfileName("profile-a", "Renamed")).toBe(renamed);
  expect(
    (
      await f.session.execute(identityOf(original), {
        type: "api.read",
        endpoint: "listUsers",
        input: {},
      })
    ).ok,
  ).toBe(true);
});

test("credential change invalidates the current profile and cancels its outstanding requests", async () => {
  const release = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  const f = fixture({
    execute: async (_command, context) => {
      signal = context.signal;
      await release.promise;
      return { ok: true, value: "old private data" };
    },
  });
  const original = successful(await f.session.unlock(f.input()));
  const pending = f.session.execute(identityOf(original), {
    type: "api.read",
    endpoint: "listUsers",
    input: {},
  });
  expect(f.session.invalidateProfile("another-profile")).toBe(original);
  const changed = f.session.invalidateProfile("profile-a");
  expect(changed).toMatchObject({ status: "locked", reason: "profile-changed", identity: null });
  expect(signal?.aborted).toBe(true);
  release.resolve();
  expect(await pending).toEqual({ ok: false, error: { kind: "locked" } });
  expect(f.session.updateProfileName("profile-a", "After lock")).toBe(changed);
});

test("changing a pending candidate only cancels that candidate, preserving another active server", async () => {
  const f = fixture();
  const original = successful(await f.session.unlock(f.input()));
  const open = f.deps.openCredential;
  const release = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  f.deps.openCredential = async (input, received) => {
    signal = received;
    await release.promise;
    return open(input, received);
  };
  const pending = f.session.unlock(f.input("profile-b"));
  const changed = f.session.invalidateProfile("profile-b");
  expect(changed.identity).toBe(original.identity);
  expect(changed.pendingProfileId).toBeNull();
  expect(signal?.aborted).toBe(true);
  release.resolve();
  expect(await pending).toEqual({ ok: false, error: { kind: "storage-conflict" } });
  expect(
    (
      await f.session.execute(identityOf(original), {
        type: "api.read",
        endpoint: "listUsers",
        input: {},
      })
    ).ok,
  ).toBe(true);
});

const writeCommands = [
  { type: "api.write", endpoint: "createApiKey", input: { expiration: "2027-01-01T00:00:00Z" } },
  { type: "api.write", endpoint: "setPolicy", input: { policy: "{}" } },
] as const;
const readCommand = { type: "api.read", endpoint: "listUsers", input: {} } as const;

// Each scenario ends an in-flight request that the transport had already started.
const interrupted = [
  {
    name: "idle expiry after the transport answered",
    kind: "expired",
    run: async (f: ReturnType<typeof fixture>) => {
      f.execute.mockImplementationOnce(async () => {
        f.clock.advance(SESSION_IDLE_MS);
        return { ok: true, value: "late decoded response" };
      });
      return { release: () => {} };
    },
  },
  {
    name: "a lock while the request is in flight",
    kind: "locked",
    run: async (f: ReturnType<typeof fixture>, identity: SessionIdentity) => {
      const held = Promise.withResolvers<SessionResult<unknown>>();
      f.execute.mockImplementationOnce(() => held.promise);
      return {
        interrupt: () => f.session.lock(identity),
        release: () => held.resolve({ ok: true, value: "late response" }),
      };
    },
  },
  {
    name: "an unlock of another profile",
    kind: "stale",
    run: async (f: ReturnType<typeof fixture>) => {
      const held = Promise.withResolvers<SessionResult<unknown>>();
      f.execute.mockImplementationOnce(() => held.promise);
      return {
        interrupt: () => f.session.unlock(f.input("profile-b")),
        release: () => held.resolve({ ok: true, value: "late response" }),
      };
    },
  },
  {
    name: "a rejected transport",
    kind: "unavailable",
    run: async (f: ReturnType<typeof fixture>) => {
      const held = Promise.withResolvers<SessionResult<unknown>>();
      f.execute.mockImplementationOnce(() => held.promise);
      return { release: () => held.reject(new Error("transport lost")) };
    },
  },
] as const;

test.each(interrupted)("a write ended by $name is unconfirmed, a read is not", async (scenario) => {
  for (const [command, outcome] of [
    ...writeCommands.map((command) => [command, { outcome: "unknown" }] as const),
    [readCommand, {}] as const,
  ]) {
    const f = fixture();
    const identity = identityOf(successful(await f.session.unlock(f.input())));
    const { interrupt, release } = (await scenario.run(f, identity)) as {
      interrupt?: () => unknown;
      release: () => void;
    };
    const pending = f.session.execute(identity, command);
    await interrupt?.();
    release();
    expect(await pending, command.endpoint).toEqual({
      ok: false,
      error: { kind: scenario.kind, ...outcome },
    });
  }
});

test.each(writeCommands)(
  "$endpoint aborted by its caller mid-flight is unconfirmed",
  async (command) => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = fixture({
      execute: async () => {
        started.resolve();
        await release.promise;
        return { ok: true, value: "late response" };
      },
    });
    const identity = identityOf(successful(await f.session.unlock(f.input())));
    const controller = new AbortController();
    const pending = f.session.execute(identity, command, { signal: controller.signal });
    await started.promise;
    controller.abort();
    release.resolve();
    expect(await pending).toEqual({ ok: false, error: { kind: "cancelled", outcome: "unknown" } });
  },
);

test.each(writeCommands)(
  "$endpoint rejected before dispatch carries no outcome",
  async (command) => {
    const f = fixture();
    const identity = identityOf(successful(await f.session.unlock(f.input())));
    expect(await f.session.execute({ ...identity, sessionId: "other" }, command)).toEqual({
      ok: false,
      error: { kind: "stale" },
    });
    expect(await f.session.execute(identity, command, { signal: AbortSignal.abort() })).toEqual({
      ok: false,
      error: { kind: "cancelled" },
    });
    f.clock.advance(SESSION_IDLE_MS);
    expect(await f.session.execute(identity, command)).toEqual({
      ok: false,
      error: { kind: "expired" },
    });
    expect(f.execute).not.toHaveBeenCalled();
  },
);

test("a definite server answer is returned untouched", async () => {
  const failure: SessionResult<never> = {
    ok: false,
    error: { kind: "api", code: "HTTP_STATUS", message: "rejected", status: 400 },
  };
  const f = fixture({ execute: async () => failure });
  const identity = identityOf(successful(await f.session.unlock(f.input())));
  expect(await f.session.execute(identity, writeCommands[0])).toBe(failure);
});

test("a write whose late 200 reply is discarded by an unlock is reported as unconfirmed", async () => {
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let acceptedWrites = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      await request.json();
      acceptedWrites++;
      received.resolve();
      await release.promise;
      return Response.json({ policy: "{}" });
    },
  });
  try {
    const f = fixture({
      execute: executeOperation,
      openCredential: async (input) => ({
        profile: { id: input.profileId, name: input.profileId, baseUrl: server.url.origin },
        credentialVersion: input.expectedCredentialVersion,
        keyEpoch: "epoch-a",
        apiKey: "worker-only-key",
      }),
    });
    const identity = identityOf(successful(await f.session.unlock(f.input())));
    const pending = f.session.execute(identity, {
      type: "api.write",
      endpoint: "setPolicy",
      input: { policy: "{}" },
    });
    await received.promise;
    successful(await f.session.unlock(f.input("profile-b")));
    release.resolve();
    expect(await pending).toEqual({ ok: false, error: { kind: "stale", outcome: "unknown" } });
    expect(acceptedWrites).toBe(1);
  } finally {
    release.resolve();
    server.stop(true);
  }
});
