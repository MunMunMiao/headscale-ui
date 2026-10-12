import {
  encryptLegacyKey,
  legacySalt,
  makeLegacyCanary,
  seedLegacyDeviceKey,
} from "@/test-utils/legacy-vault";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { assert, beforeEach, expect, test, vi } from "vitest";
import { idbGet, idbGetAll, idbPut } from "@/test-utils/storage";
import {
  decryptProfileKey,
  deriveKeyFromPassword,
  encryptProfileKey,
  ProfileUnlockError,
} from "./api-key-crypto";
import { __resetForTest, openHeadscaleDb } from "./idb";
import { readLegacyProfileKey } from "./legacy-profile-crypto";
import {
  changeProfilePassword,
  commitProfile,
  deleteStoredProfile,
  listProfileSummaries,
  migrateProfile,
  type PasswordStoredProfile,
  readProfileForOwner,
  updateProfileMetadata,
} from "./profile-storage";
import { clearAllSecureData } from "./secure-storage";
import {
  readVaultState,
  subscribeVaultChanges,
  VAULT_STATE_KEY,
  VaultDataError,
  type VaultVersion,
} from "./vault-state";

beforeEach(() => {
  __resetForTest();
  globalThis.indexedDB = new IDBFactory();
});

async function version(): Promise<VaultVersion> {
  return readVaultState(await idbGet("meta", VAULT_STATE_KEY));
}

async function legacy(id: string, extra: Record<string, unknown> = {}) {
  const state = await version();
  const value = {
    id,
    name: id,
    baseUrl: "https://headscale.test",
    apiKey: "historical-token",
    scope: "persistent",
    keyEpoch: state.keyEpoch,
    updatedAt: "yesterday",
    opaque: { preserved: true },
    ...extra,
  };
  await idbPut("profiles", value);
  return value;
}

async function encrypted(id: string): Promise<PasswordStoredProfile> {
  const state = await version();
  const binding = {
    profileId: id,
    canonicalBaseUrl: "https://headscale.test",
    credentialVersion: `version-${id}`,
  };
  return {
    id,
    name: id,
    baseUrl: binding.canonicalBaseUrl,
    keyEpoch: state.keyEpoch,
    scope: "persistent",
    updatedAt: "today",
    credentialVersion: binding.credentialVersion,
    apiKey: await encryptProfileKey({
      ...binding,
      apiKey: "fixture-api-key",
      password: "new password",
    }),
  };
}

test("worker repository lists only owner-visible summaries and never exposes stored ciphertext", async () => {
  await legacy("public");
  await legacy("own", { scope: "session", ownerTabId: "owner-a" });
  const foreign = await legacy("foreign", { scope: "session", ownerTabId: "owner-b" });
  const broken = await legacy("unreadable", { apiKey: { unsupported: true } });
  vi.stubGlobal("window", undefined);
  vi.stubGlobal("sessionStorage", undefined);
  try {
    const result = await listProfileSummaries("owner-a");
    expect(result.profiles.map((item) => item.id).sort()).toEqual(["own", "public", "unreadable"]);
    expect(result.profiles.find((item) => item.id === "public")).toMatchObject({
      credentialKind: "legacy-plaintext",
      credentialVersion: null,
    });
    expect(result.profiles.find((item) => item.id === "unreadable")).toMatchObject({
      credentialKind: "unreadable",
    });
    for (const summary of result.profiles) expect(summary).not.toHaveProperty("apiKey");
    expect(await readProfileForOwner("foreign", "owner-a")).toBeNull();
    expect(await readProfileForOwner("missing", "owner-a")).toBeNull();
    expect(await readProfileForOwner("own", "owner-a")).toMatchObject({
      profile: { id: "own", apiKey: "historical-token" },
    });
    expect(await idbGet("profiles", "foreign")).toEqual(foreign);
    expect(await idbGet("profiles", "unreadable")).toEqual(broken);
    expect(await idbGetAll("keys")).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("commits an independent-password record and refuses a stale vault revision", async () => {
  const profile = await encrypted("new");
  const expected = { version: await version(), ownerTabId: "owner-a", profile: null };
  const result = await commitProfile(expected, profile);
  expect(result.profile).toMatchObject({
    id: "new",
    credentialKind: "password",
    credentialVersion: "version-new",
  });
  expect(result.profile).not.toHaveProperty("apiKey");
  expect(await idbGet("profiles", "new")).toEqual(profile);
  await expect(commitProfile(expected, { ...profile, name: "late" })).rejects.toThrow("changed");
  expect(await idbGet("profiles", "new")).toEqual(profile);
  expect(result.version.profilesRevision).toBe(expected.version.profilesRevision + 1);
});

test("migrates one historical plaintext row while preserving other records and extra fields", async () => {
  const original = await legacy("migrate");
  const other = await legacy("other", { scope: "session", ownerTabId: "other-owner" });
  const expected = {
    version: await version(),
    ownerTabId: "owner-a",
    profile: { id: "migrate", credentialVersion: null },
  };
  const result = await migrateProfile({ expected, password: "per-server password" });
  expect(result.profile).toMatchObject({ id: "migrate", credentialKind: "password" });
  expect(result.profile.credentialVersion).toEqual(expect.any(String));
  const saved = await idbGet<PasswordStoredProfile>("profiles", "migrate");
  assert(saved);
  expect(saved).toMatchObject({
    id: original.id,
    opaque: original.opaque,
    keyEpoch: original.keyEpoch,
  });
  expect(saved?.apiKey).toMatchObject({ v: 2, scheme: "password" });
  expect(
    await decryptProfileKey({
      profileId: "migrate",
      canonicalBaseUrl: saved.baseUrl,
      credentialVersion: saved.credentialVersion,
      secret: saved.apiKey,
      password: "per-server password",
    }),
  ).toBe("historical-token");
  expect(await idbGet("profiles", "other")).toEqual(other);
  expect(await idbGetAll("keys")).toEqual([]);
  expect((await openHeadscaleDb()).version).toBe(3);
});

test("changing one profile password leaves every other profile usable and an incorrect password leaves the row untouched", async () => {
  const first = await encrypted("first");
  const other = await encrypted("other");
  await idbPut("profiles", { ...first, opaque: { keep: "field" } });
  await idbPut("profiles", other);
  const expected = {
    version: await version(),
    ownerTabId: "owner-a",
    profile: { id: first.id, credentialVersion: first.credentialVersion },
  };
  const original = await idbGet("profiles", first.id);
  await expect(
    changeProfilePassword({ expected, password: "incorrect", newPassword: "replacement password" }),
  ).rejects.toBeInstanceOf(ProfileUnlockError);
  expect(await idbGet("profiles", first.id)).toEqual(original);
  const result = await changeProfilePassword({
    expected,
    password: "new password",
    newPassword: " replacement password ",
  });
  expect(result.profile.keyEpoch).toBe(first.keyEpoch);
  expect(result.profile.credentialVersion).not.toBe(first.credentialVersion);
  const saved = await idbGet<PasswordStoredProfile>("profiles", first.id);
  assert(saved);
  expect(saved).toMatchObject({ opaque: { keep: "field" } });
  const binding = {
    profileId: first.id,
    canonicalBaseUrl: saved.baseUrl,
    credentialVersion: saved.credentialVersion,
    secret: saved.apiKey,
  };
  await expect(decryptProfileKey({ ...binding, password: "new password" })).rejects.toBeInstanceOf(
    ProfileUnlockError,
  );
  expect(await decryptProfileKey({ ...binding, password: " replacement password " })).toBe(
    "fixture-api-key",
  );
  expect(await idbGet("profiles", other.id)).toEqual(other);
  expect(
    await decryptProfileKey({
      profileId: other.id,
      canonicalBaseUrl: other.baseUrl,
      credentialVersion: other.credentialVersion,
      secret: other.apiKey,
      password: "new password",
    }),
  ).toBe("fixture-api-key");
});

async function oldEncrypted(id: string) {
  const deviceKey = await seedLegacyDeviceKey();
  const salt = legacySalt();
  const key = await deriveKeyFromPassword("legacy password", salt, 310000);
  const canary = await makeLegacyCanary(key, salt, 310000);
  await idbPut("meta", canary, "password-canary");
  const row = await legacy(id, { apiKey: await encryptLegacyKey("old-secret", key, "password") });
  return { row, canary, deviceKey };
}

test.each(["last-put", "request-success-abort", "canary-delete"])(
  "migration preserves old ciphertext, material and revision on %s",
  async (failure) => {
    const original = await oldEncrypted("migrate");
    const expected = {
      version: await version(),
      ownerTabId: "owner-a",
      profile: { id: "migrate", credentialVersion: null },
    };
    const put = IDBObjectStore.prototype.put;
    const remove = IDBObjectStore.prototype.delete;
    const putSpy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      ...args
    ) {
      if (this.name === "profiles" && failure === "last-put")
        throw new DOMException("profile quota", "QuotaExceededError");
      const request = put.apply(this, args);
      if (this.name === "profiles" && failure === "request-success-abort")
        request.addEventListener("success", () => this.transaction.abort(), { once: true });
      return request;
    });
    const removeSpy = vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function (
      this: IDBObjectStore,
      ...args
    ) {
      if (this.name === "meta" && args[0] === "password-canary" && failure === "canary-delete")
        throw new DOMException("canary quota", "QuotaExceededError");
      return remove.apply(this, args);
    });
    const changed = vi.fn();
    const stop = subscribeVaultChanges(changed);
    try {
      await expect(
        migrateProfile({ expected, password: "new password", legacyPassword: "legacy password" }),
      ).rejects.toThrow();
      expect(changed).not.toHaveBeenCalled();
    } finally {
      putSpy.mockRestore();
      removeSpy.mockRestore();
      stop();
    }
    __resetForTest();
    expect(await idbGet("profiles", "migrate")).toEqual(original.row);
    expect(await idbGet("meta", "password-canary")).toEqual(original.canary);
    expect(await version()).toEqual(expected.version);
    const deviceKey = await idbGet<CryptoKey>("keys", "device-key");
    const deviceCipher = await encryptLegacyKey(
      "device-key-preserved",
      original.deviceKey,
      "device",
    );
    expect(await readLegacyProfileKey({ secret: deviceCipher, deviceKey })).toBe(
      "device-key-preserved",
    );
    expect(
      await readLegacyProfileKey({
        secret: original.row.apiKey,
        canary: original.canary,
        password: "legacy password",
      }),
    ).toBe("old-secret");
  },
);

test("a tampered canary with an oversized iteration count is rejected without touching the stored row", async () => {
  const original = await oldEncrypted("migrate");
  await idbPut("meta", { ...original.canary, iterations: 9e15 }, "password-canary");
  const stored = await idbGet("meta", "password-canary");
  const expected = {
    version: await version(),
    ownerTabId: "owner-a",
    profile: { id: "migrate", credentialVersion: null },
  };
  const derive = vi.spyOn(crypto.subtle, "deriveKey").mockRejectedValue(new Error("must not run"));
  try {
    await expect(
      migrateProfile({ expected, password: "new password", legacyPassword: "legacy password" }),
    ).rejects.toBeInstanceOf(VaultDataError);
    expect(derive).not.toHaveBeenCalled();
  } finally {
    derive.mockRestore();
  }
  expect(await idbGet("profiles", "migrate")).toEqual(original.row);
  expect(await idbGet("meta", "password-canary")).toEqual(stored);
  expect(await version()).toEqual(expected.version);
});

test("wrong migration passwords never mark corrupted and unknown foreign rows prevent legacy-material retirement", async () => {
  const original = await oldEncrypted("migrate");
  const unknown = await legacy("foreign", {
    scope: "session",
    ownerTabId: "owner-b",
    apiKey: { format: "unknown" },
  });
  const expected = {
    version: await version(),
    ownerTabId: "owner-a",
    profile: { id: "migrate", credentialVersion: null },
  };
  await expect(
    migrateProfile({ expected, password: "new password", legacyPassword: "wrong" }),
  ).rejects.toBeInstanceOf(ProfileUnlockError);
  expect(await idbGet("profiles", "migrate")).toEqual(original.row);
  await migrateProfile({ expected, password: "new password", legacyPassword: "legacy password" });
  expect(await idbGet("profiles", "foreign")).toEqual(unknown);
  expect(await idbGet("keys", "device-key")).toBeDefined();
  expect(await idbGet("meta", "password-canary")).toEqual(original.canary);
});

test.each(["create", "change-password", "reset"])(
  "a %s committed during migration wins and the stale migration publishes nothing",
  async (operation) => {
    const original = await legacy("migrate");
    const other = await encrypted("other");
    await idbPut("profiles", other);
    const expected = {
      version: await version(),
      ownerTabId: "owner-a",
      profile: { id: "migrate", credentialVersion: null },
    };
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const nativeEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    const gate = vi.spyOn(crypto.subtle, "encrypt").mockImplementationOnce(async (...args) => {
      const encrypted = await nativeEncrypt(...args);
      started.resolve();
      await release.promise;
      return encrypted;
    });
    const task = migrateProfile({ expected, password: "migration password" });
    await started.promise;
    if (operation === "create") {
      const next = await encrypted("winner");
      await commitProfile({ version: await version(), ownerTabId: "owner-a", profile: null }, next);
    } else if (operation === "change-password") {
      await changeProfilePassword({
        expected: {
          version: await version(),
          ownerTabId: "owner-a",
          profile: { id: other.id, credentialVersion: other.credentialVersion },
        },
        password: "new password",
        newPassword: "winner password",
      });
    } else await clearAllSecureData();
    const winnerRows = await idbGetAll("profiles");
    const winnerVersion = await version();
    const changed = vi.fn();
    const stop = subscribeVaultChanges(changed);
    release.resolve();
    try {
      await expect(task).rejects.toThrow("changed");
      expect(changed).not.toHaveBeenCalled();
    } finally {
      gate.mockRestore();
      stop();
    }
    __resetForTest();
    expect(await idbGetAll("profiles")).toEqual(winnerRows);
    expect(await version()).toEqual(winnerVersion);
    if (operation !== "reset") expect(await idbGet("profiles", "migrate")).toEqual(original);
  },
);

test("repository deletion is owner-fenced and atomically removes every well-formed active preference for that profile", async () => {
  const profile = await encrypted("delete");
  await idbPut("profiles", { ...profile, scope: "session", ownerTabId: "owner-a" });
  await idbPut("meta", { profileId: profile.id, operationId: "old-a" }, "active-profile:owner-a");
  await idbPut("meta", { profileId: profile.id, operationId: "old-b" }, "active-profile:owner-b");
  const keep = { profileId: "keep", operationId: "keep" };
  await idbPut("meta", keep, "active-profile-id");
  const malformed = { profileId: profile.id, unknown: true };
  await idbPut("meta", "not a marker", "active-profile:text");
  await idbPut("meta", null, "active-profile:empty");
  await idbPut("meta", malformed, "active-profile:malformed");
  const expected = {
    version: await version(),
    ownerTabId: "owner-a",
    profile: { id: profile.id, credentialVersion: profile.credentialVersion },
  };
  await expect(deleteStoredProfile({ ...expected, ownerTabId: "owner-b" })).rejects.toThrow(
    "changed",
  );
  const deleted = await deleteStoredProfile(expected);
  expect(deleted.version.profilesRevision).toBe(expected.version.profilesRevision + 1);
  expect(await idbGet("profiles", profile.id)).toBeUndefined();
  expect(await idbGet("meta", "active-profile:owner-a")).toBeUndefined();
  expect(await idbGet("meta", "active-profile:owner-b")).toBeUndefined();
  expect(await idbGet("meta", "active-profile-id")).toEqual(keep);
  expect(await idbGet("meta", "active-profile:text")).toBe("not a marker");
  expect(await idbGet("meta", "active-profile:empty")).toBeNull();
  expect(await idbGet("meta", "active-profile:malformed")).toEqual(malformed);
});

test("a missing, changed or already-migrated target cannot be overwritten by an old intent", async () => {
  const profile = await encrypted("current");
  await idbPut("profiles", profile);
  const current = await version();
  const create = { version: current, ownerTabId: "owner-a", profile: null };
  const update = {
    ...create,
    profile: { id: profile.id, credentialVersion: profile.credentialVersion },
  };
  await expect(commitProfile(create, profile)).rejects.toThrow("changed");
  await expect(
    commitProfile(
      { ...update, profile: { id: "wrong", credentialVersion: profile.credentialVersion } },
      profile,
    ),
  ).rejects.toThrow("changed");
  await expect(
    commitProfile({ ...update, profile: { id: profile.id, credentialVersion: "stale" } }, profile),
  ).rejects.toThrow("changed");
  await expect(commitProfile(update, { ...profile, keyEpoch: "old-epoch" })).rejects.toThrow(
    "changed",
  );
  await expect(
    commitProfile(update, { ...profile, baseUrl: `${profile.baseUrl}/` }),
  ).rejects.toThrow("cannot be read");
  await expect(migrateProfile({ expected: update, password: "password" })).rejects.toThrow(
    "changed",
  );
  await expect(migrateProfile({ expected: create, password: "password" })).rejects.toThrow(
    "changed",
  );
  await expect(
    changeProfilePassword({ expected: create, password: "password", newPassword: "password" }),
  ).rejects.toThrow("changed");
  await expect(deleteStoredProfile(create)).rejects.toThrow("changed");
  await expect(
    changeProfilePassword({
      expected: { ...update, profile: { id: "missing", credentialVersion: "missing" } },
      password: "password",
      newPassword: "password",
    }),
  ).rejects.toThrow("changed");
  expect(await idbGet("profiles", profile.id)).toEqual(profile);
  expect(await version()).toEqual(current);
});

test("malformed metadata remains recoverable and prevents retirement of any old key material", async () => {
  const legacyRecord = await oldEncrypted("broken");
  const invalid = { ...legacyRecord.row, id: 42, apiKey: { unknown: true } };
  await idbPut("profiles", invalid);
  await idbPut("profiles", { ...legacyRecord.row, apiKey: { unknown: true } });
  await expect(readProfileForOwner("broken", "owner-a")).rejects.toThrow("cannot be read");
  const listed = await listProfileSummaries("owner-a");
  expect(listed.profiles.map((profile) => profile.id)).toEqual(["broken"]);
  expect(listed.unreadableRecords).toBe(2);
  const valid = await encrypted("new");
  await commitProfile({ version: await version(), ownerTabId: "owner-a", profile: null }, valid);
  expect(await idbGet("profiles", 42)).toEqual(invalid);
  expect(await idbGet("keys", "device-key")).toBeDefined();
  expect(await idbGet("meta", "password-canary")).toEqual(legacyRecord.canary);
});

test("legacy records must be explicitly migrated instead of changing a global password through the per-profile action", async () => {
  await legacy("legacy");
  await expect(
    changeProfilePassword({
      expected: {
        version: await version(),
        ownerTabId: "owner-a",
        profile: { id: "legacy", credentialVersion: null },
      },
      password: "old",
      newPassword: "new",
    }),
  ).rejects.toThrow("cannot be read");
  expect((await idbGet<{ apiKey: string }>("profiles", "legacy"))?.apiKey).toBe("historical-token");
});

test("a native delete request that succeeds before transaction abort cannot publish deletion", async () => {
  const profile = await encrypted("delete-abort");
  await idbPut("profiles", profile);
  const active = { profileId: profile.id, operationId: "keep" };
  await idbPut("meta", active, "active-profile-id");
  const expected = {
    version: await version(),
    ownerTabId: "owner-a",
    profile: { id: profile.id, credentialVersion: profile.credentialVersion },
  };
  const remove = IDBObjectStore.prototype.delete;
  const spy = vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    const request = remove.apply(this, args);
    if (this.name === "profiles")
      request.addEventListener("success", () => this.transaction.abort(), { once: true });
    return request;
  });
  const changed = vi.fn();
  const stop = subscribeVaultChanges(changed);
  try {
    await expect(deleteStoredProfile(expected)).rejects.toThrow();
    expect(changed).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
    stop();
  }
  __resetForTest();
  expect(await idbGet("profiles", profile.id)).toEqual(profile);
  expect(await idbGet("meta", "active-profile-id")).toEqual(active);
  expect(await version()).toEqual(expected.version);
});

test.each(["commit", "delete"] as const)(
  "a pre-cancelled %s never changes storage",
  async (operation) => {
    const profile = await encrypted("cancelled");
    await idbPut("profiles", profile);
    const expected = {
      version: await version(),
      ownerTabId: "owner-a",
      profile: { id: profile.id, credentialVersion: profile.credentialVersion },
    };
    const signal = AbortSignal.abort();
    await expect(
      operation === "commit"
        ? commitProfile(expected, { ...profile, name: "must not save" }, signal)
        : deleteStoredProfile(expected, signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await idbGet("profiles", profile.id)).toEqual(profile);
    expect(await version()).toEqual(expected.version);
  },
);

test.each(["migrate", "change-password"] as const)(
  "cancelling %s during crypto prevents its later commit",
  async (operation) => {
    const profile =
      operation === "migrate" ? await legacy("cancelled") : await encrypted("cancelled");
    await idbPut("profiles", profile);
    const expected = {
      version: await version(),
      ownerTabId: "owner-a",
      profile: {
        id: "cancelled",
        credentialVersion: operation === "migrate" ? null : "version-cancelled",
      },
    };
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    const held = vi.spyOn(crypto.subtle, "encrypt").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return encrypt(...args);
    });
    const controller = new AbortController();
    const pending =
      operation === "migrate"
        ? migrateProfile({ expected, password: "new password" }, controller.signal)
        : changeProfilePassword(
            { expected, password: "new password", newPassword: "replacement" },
            controller.signal,
          );
    const outcome = pending.catch((error: unknown) => error);
    try {
      await entered.promise;
      controller.abort();
      release.resolve();
      expect(await outcome).toMatchObject({ name: "AbortError" });
      expect(await idbGet("profiles", "cancelled")).toEqual(profile);
      expect(await version()).toEqual(expected.version);
    } finally {
      release.resolve();
      held.mockRestore();
    }
  },
);

test.each(["commit", "delete"] as const)(
  "cancelling %s after request success aborts the still-open transaction",
  async (operation) => {
    const profile = await encrypted("cancelled");
    await idbPut("profiles", profile);
    const expected = {
      version: await version(),
      ownerTabId: "owner-a",
      profile: { id: profile.id, credentialVersion: profile.credentialVersion },
    };
    const controller = new AbortController();
    const method = operation === "commit" ? "put" : "delete";
    const original = IDBObjectStore.prototype[method];
    const spy = vi.spyOn(IDBObjectStore.prototype, method).mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<typeof original>
    ) {
      const request = Reflect.apply(original, this, args) as IDBRequest;
      if (this.name === "profiles")
        request.addEventListener("success", () => controller.abort(), { once: true });
      return request;
    });
    try {
      await expect(
        operation === "commit"
          ? commitProfile(expected, { ...profile, name: "must not save" }, controller.signal)
          : deleteStoredProfile(expected, controller.signal),
      ).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    __resetForTest();
    expect(await idbGet("profiles", profile.id)).toEqual(profile);
    expect(await version()).toEqual(expected.version);
  },
);

test.each(["legacy", "password"] as const)(
  "updates %s display metadata without decryption or credential rotation",
  async (kind) => {
    const row = kind === "legacy" ? await legacy("rename") : await encrypted("rename");
    await idbPut("profiles", row);
    const expected = {
      version: await version(),
      ownerTabId: "owner-a",
      profile: { id: "rename", credentialVersion: kind === "legacy" ? null : "version-rename" },
    };
    const decrypt = vi.spyOn(crypto.subtle, "decrypt");
    try {
      const saved = await updateProfileMetadata(expected, { name: " Renamed ", scope: "session" });
      expect(saved.profile).toMatchObject({
        id: "rename",
        name: "Renamed",
        scope: "session",
        ownerTabId: "owner-a",
        credentialVersion: expected.profile.credentialVersion,
      });
      expect(saved.profile).not.toHaveProperty("apiKey");
      expect(await idbGet("profiles", "rename")).toMatchObject({
        ...row,
        name: "Renamed",
        scope: "session",
        ownerTabId: "owner-a",
        updatedAt: expect.any(String),
      });
      expect(decrypt).not.toHaveBeenCalled();
      expect(saved.version.profilesRevision).toBe(expected.version.profilesRevision + 1);
      await expect(
        updateProfileMetadata(expected, { name: "Stale", scope: "persistent" }),
      ).rejects.toThrow("changed in another operation");
      await expect(
        updateProfileMetadata(
          { version: saved.version, ownerTabId: "owner-b", profile: expected.profile },
          { name: "Foreign", scope: "session" },
        ),
      ).rejects.toThrow("changed in another operation");
    } finally {
      decrypt.mockRestore();
    }
  },
);

test("a metadata update needs an existing profile reference and drops obsolete legacy flags", async () => {
  const profile = await encrypted("flagged");
  await idbPut("profiles", { ...profile, corrupted: true });
  const current = await version();
  await expect(
    updateProfileMetadata(
      { version: current, ownerTabId: "owner-a", profile: null },
      { name: "new", scope: "persistent" },
    ),
  ).rejects.toThrow("changed");
  expect(await idbGet("profiles", "flagged")).toEqual({ ...profile, corrupted: true });
  await updateProfileMetadata(
    {
      version: current,
      ownerTabId: "owner-a",
      profile: { id: profile.id, credentialVersion: profile.credentialVersion },
    },
    { name: "renamed", scope: "persistent" },
  );
  expect(await idbGet("profiles", "flagged")).toMatchObject({ name: "renamed" });
  expect(await idbGet("profiles", "flagged")).not.toHaveProperty("corrupted");
});

test("a row that is not a plain record is unreadable", async () => {
  await idbPut("profiles", Object.assign([], { id: "array-row" }));
  await expect(readProfileForOwner("array-row", "owner-a")).rejects.toBeInstanceOf(VaultDataError);
  expect(await idbGet("profiles", "array-row")).toHaveProperty("id", "array-row");
});

test("renaming a profile to a blank name stores its base URL instead of an empty name", async () => {
  const profile = await encrypted("blank-name");
  await idbPut("profiles", profile);
  const saved = await updateProfileMetadata(
    {
      version: await version(),
      ownerTabId: "owner-a",
      profile: { id: profile.id, credentialVersion: profile.credentialVersion },
    },
    { name: "   ", scope: "persistent" },
  );
  expect(saved.profile.name).toBe("https://headscale.test");
  expect(await idbGet("profiles", profile.id)).toMatchObject({ name: "https://headscale.test" });
});

test("deleting a password profile keeps the device key and canary while another legacy record remains", async () => {
  const kept = await oldEncrypted("legacy-keep");
  const profile = await encrypted("to-delete");
  await idbPut("profiles", profile);
  await deleteStoredProfile({
    version: await version(),
    ownerTabId: "owner-a",
    profile: { id: profile.id, credentialVersion: profile.credentialVersion },
  });
  expect(await idbGet("profiles", profile.id)).toBeUndefined();
  expect(await idbGet("profiles", "legacy-keep")).toEqual(kept.row);
  expect(await idbGet("keys", "device-key")).toBeDefined();
  expect(await idbGet("meta", "password-canary")).toEqual(kept.canary);
});

test("a stored record without descriptive fields stays visible as unreadable under its id", async () => {
  await idbPut("profiles", { id: "bare" });
  const listed = await listProfileSummaries("owner-a");
  expect(listed.unreadableRecords).toBe(1);
  expect(listed.profiles).toEqual([
    expect.objectContaining({
      id: "bare",
      name: "bare",
      baseUrl: "",
      updatedAt: "",
      keyEpoch: "",
      credentialKind: "unreadable",
    }),
  ]);
  await expect(readProfileForOwner("bare", "owner-a")).rejects.toBeInstanceOf(VaultDataError);
});
