import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fetchSnapshot } from "@/api/snapshot";
import { decryptProfileKey, encryptProfileKey } from "@/lib/api-key-crypto";
import { __resetForTest } from "@/lib/idb";
import {
  type PasswordStoredProfile,
  readProfileForOwner,
} from "@/lib/profile-storage";
import { readVaultState, subscribeVaultChanges } from "@/lib/vault-state";
import { createManualClock } from "@/test/session-clock";
import { startSnapshotServer } from "@/test-utils/headscale.test";
import { idbDelete, idbGet, idbPut } from "@/test-utils/storage";
import { createAuthSession, SessionFault } from "./auth-session";
import { executeOperation } from "./operation-dispatch";
import {
  createProfileActions,
  type ProfileActionContext,
  type ProfileActionDependencies,
  type ProfileSaveInput,
} from "./profile-actions";

const cleanup: (() => void)[] = [];
beforeEach(() => {
  __resetForTest();
  globalThis.indexedDB = new IDBFactory();
});
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function version() {
  return readVaultState(await idbGet("meta", "vault-state"));
}
function fixture() {
  const server = startSnapshotServer();
  cleanup.push(server.stop);
  const clock = createManualClock();
  let sequence = 0;
  const validate: ProfileActionDependencies["validate"] = async (context) => {
    await fetchSnapshot(
      (command) => executeOperation({ ...command, type: "api.read" }, context),
      {
        signal: context.signal,
      },
    );
  };
  const auth = createAuthSession({
    workerId: "worker-a",
    now: clock.now,
    newSessionId: () => `session-${++sequence}`,
    async openCredential(input) {
      const read = await readProfileForOwner(input.profileId, input.ownerTabId);
      if (!read?.profile.credentialVersion)
        throw new SessionFault("storage-conflict");
      const credentialVersion = read.profile.credentialVersion;
      const profile = read.profile;
      const apiKey = await decryptProfileKey({
        profileId: profile.id,
        canonicalBaseUrl: profile.baseUrl,
        credentialVersion,
        secret: profile.apiKey,
        password: input.password,
      });
      return {
        profile,
        apiKey,
        keyEpoch: profile.keyEpoch,
        credentialVersion,
      };
    },
    async readCurrentProfile(candidate) {
      const read = await readProfileForOwner(candidate.profile.id, "owner-a");
      return read &&
        read.version.keyEpoch === candidate.keyEpoch &&
        read.profile.credentialVersion === candidate.credentialVersion
        ? {
            id: read.profile.id,
            name: read.profile.name,
            baseUrl: read.profile.baseUrl,
          }
        : null;
    },
    validateCredential: (candidate, signal, requireCandidate) =>
      validate({
        signal,
        requireCurrent() {
          requireCandidate();
          return {
            baseUrl: candidate.profile.baseUrl,
            apiKey: candidate.apiKey,
          };
        },
      }),
    execute: executeOperation,
  });
  const deps: ProfileActionDependencies = {
    workerId: "worker-a",
    auth,
    validate,
    cancelPending: vi.fn(async () => {}),
    profilesCommitted: vi.fn(),
    resetCommitted: vi.fn(),
  };
  const actions = createProfileActions(deps);
  const context: ProfileActionContext = {
    ownerTabId: "owner-a",
    portId: "port-a",
    requestId: "1",
    signal: new AbortController().signal,
  };
  async function profile(
    id = "profile-a",
    password = " password ",
  ): Promise<PasswordStoredProfile> {
    const keyEpoch = (await version()).keyEpoch;
    const credentialVersion = `version-${id}`;
    const record: PasswordStoredProfile = {
      id,
      name: id,
      baseUrl: server.baseUrl,
      keyEpoch,
      credentialVersion,
      scope: "persistent",
      updatedAt: "2026-10-11",
      apiKey: await encryptProfileKey({
        profileId: id,
        canonicalBaseUrl: server.baseUrl,
        credentialVersion,
        apiKey: "fixture-connection-key",
        password,
      }),
    };
    await idbPut("profiles", record);
    return record;
  }
  async function expected(record: PasswordStoredProfile) {
    return {
      version: await version(),
      ownerTabId: "owner-a",
      profile: { id: record.id, credentialVersion: record.credentialVersion },
    };
  }
  const unlock = (record: PasswordStoredProfile) =>
    auth.unlock({
      profileId: record.id,
      password: " password ",
      expectedWorkerId: "worker-a",
      expectedIdentity: auth.getSnapshot().identity,
      expectedCredentialVersion: record.credentialVersion,
      ownerTabId: context.ownerTabId,
    });
  return {
    actions,
    auth,
    deps,
    context,
    profile,
    expected,
    unlock,
    server,
    clock,
  };
}

test("profile actions list only this port's owner-visible summaries", async () => {
  const f = fixture();
  await f.profile();
  const other = await f.profile("private-other");
  await idbPut("profiles", {
    ...other,
    scope: "session",
    ownerTabId: "owner-b",
  });
  const result = await f.actions.list(f.context);
  expect(result).toMatchObject({
    ok: true,
    value: {
      unreadableRecords: 0,
      profiles: [{ id: "profile-a", credentialKind: "password" }],
    },
  });
  expect(JSON.stringify(result)).not.toContain("ciphertext");
  expect(JSON.stringify(result)).not.toContain("fixture-connection-key");
});

test("committed metadata updates the current name without changing identity or ciphertext", async () => {
  const f = fixture();
  const row = await f.profile();
  expect((await f.unlock(row)).ok).toBe(true);
  const current = f.auth.getSnapshot();
  const decrypt = vi.spyOn(crypto.subtle, "decrypt");
  const result = await f.actions.save(
    {
      kind: "metadata",
      expected: await f.expected(row),
      name: "Renamed",
      scope: "session",
    },
    f.context,
  );
  expect(result).toMatchObject({
    ok: true,
    value: {
      saved: true,
      activation: null,
      commit: {
        profile: { name: "Renamed", scope: "session", ownerTabId: "owner-a" },
      },
    },
  });
  expect(f.auth.getSnapshot().identity).toBe(current.identity);
  expect(f.auth.getSnapshot().expiresAt).toBe(current.expiresAt);
  expect(f.auth.getSnapshot().profile?.name).toBe("Renamed");
  expect(
    (await idbGet<PasswordStoredProfile>("profiles", row.id))?.apiKey,
  ).toEqual(row.apiKey);
  expect(decrypt).not.toHaveBeenCalled();
  expect(f.deps.profilesCommitted).toHaveBeenCalledTimes(1);
});

test("profile writes use the handshake owner instead of the caller's forged owner", async () => {
  const f = fixture();
  const row = await f.profile("foreign");
  await idbPut("profiles", { ...row, scope: "session", ownerTabId: "owner-b" });
  const expected = { ...(await f.expected(row)), ownerTabId: "owner-b" };
  expect(
    await f.actions.save(
      { kind: "metadata", expected, name: "Stolen", scope: "persistent" },
      f.context,
    ),
  ).toEqual({ ok: false, error: { kind: "storage-conflict" } });
  expect((await idbGet<PasswordStoredProfile>("profiles", row.id))?.name).toBe(
    "foreign",
  );
  expect(f.deps.profilesCommitted).not.toHaveBeenCalled();
});

async function credentials(
  f: ReturnType<typeof fixture>,
): Promise<Extract<ProfileSaveInput, { kind: "credentials" }>> {
  return {
    kind: "credentials",
    expected: {
      version: await version(),
      ownerTabId: "forged-owner",
      profile: null,
    },
    profile: {
      id: "new-profile",
      name: " New server ",
      baseUrl: `${f.server.baseUrl}/`,
      scope: "session",
    },
    apiKey: " fixture-connection-key ",
    password: " new password ",
    validation: "required",
    activate: false,
    expectedWorkerId: "worker-a",
    expectedIdentity: f.auth.getSnapshot().identity,
  };
}

test("new server saves independently password-encrypted credentials after seven validation reads", async () => {
  const f = fixture();
  const input = await credentials(f);
  const result = await f.actions.save(input, f.context);
  expect(result).toMatchObject({
    ok: true,
    value: {
      saved: true,
      activation: null,
      commit: {
        profile: {
          name: "New server",
          baseUrl: f.server.baseUrl,
          ownerTabId: "owner-a",
          credentialKind: "password",
        },
      },
    },
  });
  expect(f.server.requests).toHaveLength(7);
  expect(f.deps.profilesCommitted).toHaveBeenCalledTimes(1);
  const saved = await idbGet<PasswordStoredProfile>("profiles", "new-profile");
  expect(saved).toBeDefined();
  if (!saved) return;
  expect(saved).not.toHaveProperty("password");
  expect(JSON.stringify(result)).not.toContain("fixture-connection-key");
  expect(JSON.stringify(result)).not.toContain("ciphertext");
  expect(
    await decryptProfileKey({
      profileId: saved.id,
      canonicalBaseUrl: saved.baseUrl,
      credentialVersion: saved.credentialVersion,
      secret: saved.apiKey,
      password: "new password",
    }),
  ).toBe("fixture-connection-key");
  await expect(
    decryptProfileKey({
      profileId: saved.id,
      canonicalBaseUrl: saved.baseUrl,
      credentialVersion: saved.credentialVersion,
      secret: saved.apiKey,
      password: " new password ",
    }),
  ).rejects.toThrow();
});

test("a blank profile name is saved as the normalized server address", async () => {
  const f = fixture();
  const input = await credentials(f);
  const result = await f.actions.save(
    { ...input, profile: { ...input.profile, name: "   " } },
    f.context,
  );
  expect(result).toMatchObject({
    ok: true,
    value: { commit: { profile: { name: f.server.baseUrl } } },
  });
  expect(await idbGet("profiles", "new-profile")).toMatchObject({
    name: f.server.baseUrl,
    baseUrl: f.server.baseUrl,
  });
});

test.each(["password", "apiKey", "baseUrl"] as const)(
  "invalid new server %s fails without sending or saving",
  async (field) => {
    const f = fixture();
    const input = await credentials(f);
    if (field === "baseUrl") input.profile.baseUrl = "/relative";
    else input[field] = field === "apiKey" ? "  " : "";
    expect(await f.actions.save(input, f.context)).toEqual({
      ok: false,
      error: { kind: "invalid-request" },
    });
    expect(f.server.requests).toEqual([]);
    expect(await idbGet("profiles", input.profile.id)).toBeUndefined();
  },
);

test("validation failure preserves storage; explicit save without validation requires a fresh call and cannot activate", async () => {
  const f = fixture();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json({ code: 7, message: "permission denied" }, { status: 403 }),
  });
  cleanup.push(() => {
    server.stop(true);
  });
  const input = await credentials(f);
  input.profile.baseUrl = server.url.origin;
  expect(await f.actions.save(input, f.context)).toMatchObject({
    ok: false,
    error: {
      kind: "api",
      code: "HTTP_STATUS",
      status: 403,
      data: { message: "permission denied" },
    },
  });
  expect(await idbGet("profiles", input.profile.id)).toBeUndefined();
  expect(
    await f.actions.save(
      { ...input, validation: "skip", activate: true },
      f.context,
    ),
  ).toEqual({ ok: false, error: { kind: "invalid-request" } });
  expect(
    await f.actions.save(
      {
        ...input,
        apiKey: " replacement-key ",
        password: " replacement-password ",
        validation: "skip",
      },
      f.context,
    ),
  ).toMatchObject({ ok: true, value: { saved: true, activation: null } });
  expect(f.auth.getSnapshot().status).toBe("locked");
});

test("changing existing credentials proves the old profile password and locks only after successful commit", async () => {
  const f = fixture();
  const row = await f.profile();
  expect((await f.unlock(row)).ok).toBe(true);
  const identity = f.auth.getSnapshot().identity;
  const input = await credentials(f);
  input.profile.id = row.id;
  input.expected = await f.expected(row);
  input.expectedIdentity = identity;
  expect(await f.actions.save(input, f.context)).toEqual({
    ok: false,
    error: { kind: "unlock-failed" },
  });
  expect(f.auth.getSnapshot().identity).toBe(identity);
  expect(await idbGet("profiles", row.id)).toEqual(row);
  expect(
    await f.actions.save({ ...input, password: " password " }, f.context),
  ).toMatchObject({
    ok: true,
    value: { saved: true },
  });
  expect(f.auth.getSnapshot()).toMatchObject({
    status: "locked",
    reason: "profile-changed",
  });
});

test.each([
  [" password ", " password "],
  ["password", " password "],
  ["x", " x "],
  ["        ", "        "],
])(
  "credential edits retain the matched historical password %j for input %j",
  async (storedPassword, password) => {
    const f = fixture();
    const row = await f.profile("historical", storedPassword);
    const input = await credentials(f);
    const result = await f.actions.save(
      {
        ...input,
        expected: await f.expected(row),
        profile: { ...input.profile, id: row.id },
        apiKey: "replacement-api-key",
        password,
        activate: true,
      },
      f.context,
    );
    expect(result).toMatchObject({
      ok: true,
      value: { activation: { ok: true, value: { status: "unlocked" } } },
    });
    const saved = await idbGet<PasswordStoredProfile>("profiles", row.id);
    expect.assert(saved);
    const binding = {
      profileId: saved.id,
      canonicalBaseUrl: saved.baseUrl,
      credentialVersion: saved.credentialVersion,
      secret: saved.apiKey,
    };
    expect(
      await decryptProfileKey({ ...binding, password: storedPassword }),
    ).toBe("replacement-api-key");
    if (storedPassword !== password)
      await expect(
        decryptProfileKey({ ...binding, password }),
      ).rejects.toThrow();
    expect(JSON.stringify(result)).not.toContain("matchedPassword");
    expect(JSON.stringify(result)).not.toContain("replacement-api-key");
    expect(saved).not.toHaveProperty("password");
  },
);

test.each(["new", "unreadable"] as const)(
  "%s profile writes reject trimmed new passwords shorter than eight before HTTP or storage",
  async (kind) => {
    const f = fixture();
    const input = await credentials(f);
    let original: unknown;
    if (kind === "unreadable") {
      const row = await f.profile();
      original = { ...row, apiKey: { v: 99 } };
      await idbPut("profiles", original);
      input.expected = await f.expected(row);
      input.profile.id = row.id;
    }
    for (const password of [" 1234567 ", "        "]) {
      expect(await f.actions.save({ ...input, password }, f.context)).toEqual({
        ok: false,
        error: { kind: "invalid-request" },
      });
      expect(await idbGet("profiles", input.profile.id)).toEqual(original);
      expect(f.server.requests).toEqual([]);
      expect(f.deps.profilesCommitted).not.toHaveBeenCalled();
    }
  },
);

test("save and activate uses the submitted password only inside the Worker", async () => {
  const f = fixture();
  const unlock = vi.spyOn(f.auth, "unlock");
  const input = await credentials(f);
  const result = await f.actions.save({ ...input, activate: true }, f.context);
  expect(result).toMatchObject({
    ok: true,
    value: {
      saved: true,
      activation: {
        ok: true,
        value: { status: "unlocked", profile: { id: input.profile.id } },
      },
    },
  });
  expect.assert(result.ok);
  expect(unlock).toHaveBeenCalledWith(
    {
      profileId: input.profile.id,
      password: "new password",
      expectedWorkerId: "worker-a",
      expectedIdentity: null,
      expectedCredentialVersion: result.value.commit.profile.credentialVersion,
      ownerTabId: "owner-a",
    },
    { signal: f.context.signal },
  );
  expect(f.auth.getSnapshot().status).toBe("unlocked");
  expect(JSON.stringify(result)).not.toContain(input.password);
  expect(JSON.stringify(result)).not.toContain("fixture-connection-key");
});

test("cancellation after commit reports saved:true with failed activation, preserving the committed record", async () => {
  const f = fixture();
  const input = await credentials(f);
  const controller = new AbortController();
  const stop = subscribeVaultChanges(() => controller.abort());
  cleanup.push(stop);
  const result = await f.actions.save(
    { ...input, activate: true },
    { ...f.context, signal: controller.signal },
  );
  expect(result).toMatchObject({
    ok: true,
    value: {
      saved: true,
      activation: { ok: false, error: { kind: "cancelled" } },
    },
  });
  expect(await idbGet("profiles", input.profile.id)).toBeDefined();
  expect(f.auth.getSnapshot().status).toBe("locked");
  expect(f.deps.profilesCommitted).toHaveBeenCalledTimes(1);
});

test.each(["cancelled", "transaction-abort"] as const)(
  "a save abandoned by %s before commit cannot publish a profile change",
  async (boundary) => {
    const f = fixture();
    const input = await credentials(f);
    const controller = new AbortController();
    if (boundary === "cancelled") controller.abort();
    else {
      const put = IDBObjectStore.prototype.put;
      vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
        this: IDBObjectStore,
        ...args
      ) {
        const request = put.apply(this, args);
        if (this.name === "profiles")
          request.addEventListener("success", () => this.transaction.abort(), {
            once: true,
          });
        return request;
      });
    }
    expect(
      await f.actions.save(input, { ...f.context, signal: controller.signal }),
    ).toMatchObject({
      ok: false,
      error: {
        kind: boundary === "cancelled" ? "cancelled" : "storage-failed",
      },
    });
    expect(await idbGet("profiles", input.profile.id)).toBeUndefined();
    expect(f.deps.profilesCommitted).not.toHaveBeenCalled();
  },
);

test("migration publishes only a committed summary and preserves it on a stale retry", async () => {
  const f = fixture();
  const row = {
    id: "legacy",
    name: "Old",
    baseUrl: f.server.baseUrl,
    scope: "persistent",
    keyEpoch: (await version()).keyEpoch,
    updatedAt: "old",
    apiKey: "legacy-plain-key",
    opaque: { keep: true },
  };
  await idbPut("profiles", row);
  const expected = {
    version: await version(),
    ownerTabId: "forged-owner",
    profile: { id: "legacy", credentialVersion: null },
  };
  const result = await f.actions.migrate(
    { expected, password: "migration password" },
    f.context,
  );
  expect(result).toMatchObject({
    ok: true,
    value: { profile: { id: "legacy", credentialKind: "password" } },
  });
  expect(JSON.stringify(result)).not.toContain("legacy-plain-key");
  expect(await idbGet("profiles", "legacy")).toMatchObject({
    opaque: row.opaque,
    apiKey: { v: 2, scheme: "password" },
  });
  expect(
    await f.actions.migrate({ expected, password: "retry" }, f.context),
  ).toEqual({
    ok: false,
    error: { kind: "storage-conflict" },
  });
  expect(f.deps.profilesCommitted).toHaveBeenCalledTimes(1);
});

test("password changes affect only their profile and a failed change preserves active authorization", async () => {
  const f = fixture();
  const current = await f.profile();
  const other = await f.profile("profile-b");
  expect((await f.unlock(current)).ok).toBe(true);
  const identity = f.auth.getSnapshot().identity;
  const expected = await f.expected(other);
  expect(
    await f.actions.changePassword(
      { expected, password: "wrong", newPassword: "next password" },
      f.context,
    ),
  ).toEqual({ ok: false, error: { kind: "unlock-failed" } });
  expect(await idbGet("profiles", other.id)).toEqual(other);
  expect(f.deps.profilesCommitted).not.toHaveBeenCalled();
  expect(
    await f.actions.changePassword(
      { expected, password: " password ", newPassword: "next password" },
      f.context,
    ),
  ).toMatchObject({ ok: true, value: { profile: { id: other.id } } });
  expect(f.auth.getSnapshot().identity).toBe(identity);
  expect(
    await f.actions.changePassword(
      {
        expected: await f.expected(current),
        password: " password ",
        newPassword: "next password",
      },
      f.context,
    ),
  ).toMatchObject({ ok: true });
  expect(f.auth.getSnapshot()).toMatchObject({
    status: "locked",
    reason: "profile-changed",
  });
});

test("deleting another server preserves the active one; deleting the current server locks it after commit", async () => {
  const f = fixture();
  const current = await f.profile();
  const other = await f.profile("profile-b");
  expect((await f.unlock(current)).ok).toBe(true);
  const identity = f.auth.getSnapshot().identity;
  expect((await f.actions.delete(await f.expected(other), f.context)).ok).toBe(
    true,
  );
  expect(f.auth.getSnapshot().identity).toBe(identity);
  expect(
    (await f.actions.delete(await f.expected(current), f.context)).ok,
  ).toBe(true);
  expect(f.auth.getSnapshot()).toMatchObject({
    status: "locked",
    reason: "profile-changed",
  });
  expect(await idbGet("profiles", current.id)).toBeUndefined();
  expect(f.deps.profilesCommitted).toHaveBeenCalledTimes(2);
});

test("deleting without a profile reference is a storage conflict that commits and locks nothing", async () => {
  const f = fixture();
  const current = await f.profile();
  expect((await f.unlock(current)).ok).toBe(true);
  const identity = f.auth.getSnapshot().identity;
  expect(
    await f.actions.delete(
      { version: await version(), ownerTabId: "owner-a", profile: null },
      f.context,
    ),
  ).toEqual({ ok: false, error: { kind: "storage-conflict" } });
  expect(f.auth.getSnapshot().identity).toBe(identity);
  expect(await idbGet("profiles", current.id)).toBeDefined();
  expect(f.deps.profilesCommitted).not.toHaveBeenCalled();
});

test("reset locks and cancels other operations before writing, then publishes the committed epoch", async () => {
  const f = fixture();
  const row = await f.profile();
  expect((await f.unlock(row)).ok).toBe(true);
  const expected = await version();
  let cancelled = false;
  f.deps.cancelPending = async (except) => {
    expect(except).toBe(f.context);
    expect(f.auth.getSnapshot().status).toBe("locked");
    expect(await idbGet("profiles", row.id)).toEqual(row);
    cancelled = true;
  };
  vi.stubGlobal("sessionStorage", undefined);
  const result = await f.actions.reset(expected, f.context);
  expect(result).toMatchObject({
    ok: true,
    value: {
      committed: true,
      sessionMetadataCleared: false,
      version: { profilesRevision: 0 },
    },
  });
  expect(cancelled).toBe(true);
  expect(f.deps.resetCommitted).toHaveBeenCalledWith(await version());
  expect(await idbGet("profiles", row.id)).toBeUndefined();
});

test("reset with a null expectation locks the session and reseeds a deleted vault state", async () => {
  const f = fixture();
  const row = await f.profile();
  expect((await f.unlock(row)).ok).toBe(true);
  await idbDelete("meta", "vault-state");
  const result = await f.actions.reset(null, f.context);
  expect(result).toMatchObject({ ok: true, value: { committed: true } });
  expect(f.auth.getSnapshot().status).toBe("locked");
  expect(f.deps.resetCommitted).toHaveBeenCalledWith(await version());
  expect(await idbGet("profiles", row.id)).toBeUndefined();
});

test("reset with a null expectation refuses a readable vault and keeps its data", async () => {
  const f = fixture();
  const row = await f.profile();
  expect(await f.actions.reset(null, f.context)).toEqual({
    ok: false,
    error: { kind: "storage-conflict" },
  });
  expect(await idbGet("profiles", row.id)).toEqual(row);
  expect(f.deps.resetCommitted).not.toHaveBeenCalled();
});

test("reset failure keeps the global session locked and original data recoverable", async () => {
  const f = fixture();
  const row = await f.profile();
  expect((await f.unlock(row)).ok).toBe(true);
  const expected = await version();
  const clear = IDBObjectStore.prototype.clear;
  const spy = vi
    .spyOn(IDBObjectStore.prototype, "clear")
    .mockImplementation(function (this: IDBObjectStore) {
      if (this.name === "keys")
        throw new DOMException("fixture abort", "UnknownError");
      return clear.call(this);
    });
  expect(await f.actions.reset(expected, f.context)).toEqual({
    ok: false,
    error: { kind: "storage-failed" },
  });
  spy.mockRestore();
  expect(f.auth.getSnapshot().status).toBe("locked");
  expect(await idbGet("profiles", row.id)).toEqual(row);
  expect(await version()).toEqual(expected);
  expect(f.deps.resetCommitted).not.toHaveBeenCalled();
});

test.each(["worker", "identity", "expiry"] as const)(
  "credential save rejects a stale %s boundary before sending",
  async (boundary) => {
    const f = fixture();
    const row = await f.profile();
    expect((await f.unlock(row)).ok).toBe(true);
    const input = await credentials(f);
    f.server.requests.length = 0;
    if (boundary === "worker") input.expectedWorkerId = "old-worker";
    if (boundary === "identity")
      input.expectedIdentity = {
        workerId: "worker-a",
        sessionId: "old-session",
      };
    if (boundary === "expiry") f.clock.advance(1_800_000);
    expect(await f.actions.save(input, f.context)).toEqual({
      ok: false,
      error: { kind: boundary === "expiry" ? "expired" : "stale" },
    });
    expect(f.server.requests).toEqual([]);
    expect(await idbGet("profiles", input.profile.id)).toBeUndefined();
  },
);

test("another tab switching server during validation cannot make the old save activate over it", async () => {
  const f = fixture();
  const other = await f.profile("server-b");
  const input = await credentials(f);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const validate = f.deps.validate;
  f.deps.validate = async (context) => {
    entered.resolve();
    await release.promise;
    await validate(context);
  };
  const pending = f.actions.save({ ...input, activate: true }, f.context);
  await entered.promise;
  expect((await f.unlock(other)).ok).toBe(true);
  const adopted = f.auth.getSnapshot().identity;
  release.resolve();
  expect(await pending).toEqual({ ok: false, error: { kind: "stale" } });
  expect(f.auth.getSnapshot().identity).toBe(adopted);
  expect(f.server.requests).toHaveLength(7);
  expect(await idbGet("profiles", input.profile.id)).toBeUndefined();
});

test("a credential save is busy while an existing unlock candidate is held", async () => {
  const f = fixture();
  const row = await f.profile();
  const input = await credentials(f);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "decrypt").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return decrypt(...args);
  });
  const unlocking = f.unlock(row);
  try {
    await entered.promise;
    expect(await f.actions.save(input, f.context)).toEqual({
      ok: false,
      error: { kind: "busy" },
    });
    expect(await idbGet("profiles", input.profile.id)).toBeUndefined();
  } finally {
    release.resolve();
    await unlocking;
  }
});

test("an already cancelled profile command does no work", async () => {
  const f = fixture();
  expect(
    await f.actions.list({ ...f.context, signal: AbortSignal.abort() }),
  ).toEqual({
    ok: false,
    error: { kind: "cancelled" },
  });
});

test("an older credential version cannot replace a server even with its correct password", async () => {
  const f = fixture();
  const row = await f.profile();
  const input = await credentials(f);
  input.profile.id = row.id;
  input.password = " password ";
  input.expected = {
    ...(await f.expected(row)),
    profile: { id: row.id, credentialVersion: "old-version" },
  };
  expect(await f.actions.save(input, f.context)).toEqual({
    ok: false,
    error: { kind: "storage-conflict" },
  });
  expect(await idbGet("profiles", row.id)).toEqual(row);
  expect(f.server.requests).toEqual([]);
});

test("a stale reset is refused before it can lock the shared session or cancel peers", async () => {
  const f = fixture();
  const row = await f.profile();
  expect((await f.unlock(row)).ok).toBe(true);
  const identity = f.auth.getSnapshot().identity;
  const stale = await version();
  await idbPut(
    "meta",
    { ...stale, profilesRevision: stale.profilesRevision + 1 },
    "vault-state",
  );
  expect(await f.actions.reset(stale, f.context)).toEqual({
    ok: false,
    error: { kind: "storage-conflict" },
  });
  expect(f.auth.getSnapshot().identity).toBe(identity);
  expect(f.deps.cancelPending).not.toHaveBeenCalled();
  expect(await idbGet("profiles", row.id)).toEqual(row);
});

test("credential saves store the canonical server URL and validate what the user typed", async () => {
  const f = fixture();
  const input = await credentials(f);
  input.profile.baseUrl = ` ${f.server.baseUrl.replace("http://", "HTTP://")}// `;
  expect(await f.actions.save(input, f.context)).toMatchObject({
    ok: true,
    value: { commit: { profile: { baseUrl: f.server.baseUrl } } },
  });
  const query = await credentials(f);
  query.profile.id = "query-profile";
  query.profile.baseUrl = `${f.server.baseUrl}/?token=secret`;
  expect(await f.actions.save(query, f.context)).toEqual({
    ok: false,
    error: { kind: "invalid-request" },
  });
  expect(await idbGet("profiles", "query-profile")).toBeUndefined();
});

test("an unreadable row is replaced with new credentials without its lost password", async () => {
  const f = fixture();
  const row = await f.profile();
  await idbPut("profiles", {
    ...row,
    apiKey: { v: 99 },
    credentialVersion: "",
  });
  const input = await credentials(f);
  const replace = {
    ...input,
    expected: {
      ...input.expected,
      profile: { id: row.id, credentialVersion: null },
    },
    profile: { ...input.profile, id: row.id, scope: "persistent" as const },
  };
  expect(
    await f.actions.save(
      {
        ...replace,
        expected: {
          ...replace.expected,
          profile: { id: row.id, credentialVersion: "x" },
        },
      },
      f.context,
    ),
  ).toEqual({ ok: false, error: { kind: "storage-conflict" } });
  expect(await f.actions.save(replace, f.context)).toMatchObject({
    ok: true,
    value: { commit: { profile: { id: row.id, credentialKind: "password" } } },
  });
  const saved = await idbGet<PasswordStoredProfile>("profiles", row.id);
  expect.assert(saved);
  expect(
    await decryptProfileKey({
      profileId: saved.id,
      canonicalBaseUrl: saved.baseUrl,
      credentialVersion: saved.credentialVersion,
      secret: saved.apiKey,
      password: "new password",
    }),
  ).toBe("fixture-connection-key");
  await expect(
    decryptProfileKey({
      profileId: saved.id,
      canonicalBaseUrl: saved.baseUrl,
      credentialVersion: saved.credentialVersion,
      secret: saved.apiKey,
      password: " new password ",
    }),
  ).rejects.toThrow();
});

test("credentials for one row cannot be written under another row's expectation", async () => {
  const f = fixture();
  const row = await f.profile();
  const input = await credentials(f);
  expect(
    await f.actions.save(
      { ...input, expected: await f.expected(row) },
      f.context,
    ),
  ).toEqual({
    ok: false,
    error: { kind: "storage-conflict" },
  });
  expect(await idbGet("profiles", input.profile.id)).toBeUndefined();
});

test("a failed read of a readable row is not mistaken for an unreadable row", async () => {
  const f = fixture();
  const row = await f.profile();
  const input = await credentials(f);
  const get = IDBObjectStore.prototype.get;
  let denied = false;
  vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    if (this.name === "profiles" && !denied) {
      denied = true;
      throw new DOMException("read denied", "UnknownError");
    }
    return get.apply(this, args);
  });
  expect(
    await f.actions.save(
      {
        ...input,
        expected: await f.expected(row),
        profile: { ...input.profile, id: row.id },
      },
      f.context,
    ),
  ).toEqual({ ok: false, error: { kind: "storage-failed" } });
  expect(await idbGet("profiles", row.id)).toEqual(row);
});

test("an unreadable vault state is not mistaken for an unreadable row", async () => {
  const f = fixture();
  const row = await f.profile();
  const input = await credentials(f);
  await idbPut("meta", { broken: true }, "vault-state");
  expect(
    await f.actions.save(
      {
        ...input,
        expected: {
          ...input.expected,
          profile: { id: row.id, credentialVersion: null },
        },
        profile: { ...input.profile, id: row.id },
      },
      f.context,
    ),
  ).toEqual({ ok: false, error: { kind: "storage-failed" } });
});
