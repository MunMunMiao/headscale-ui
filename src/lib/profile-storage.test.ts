import "fake-indexeddb/auto";
import { beforeEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import {
  type ApiKeySecret,
  decryptApiKey,
  deriveKeyFromPassword,
  encryptApiKey,
  generateCanarySalt,
  getOrCreateDeviceKey,
} from "./api-key-crypto";
import {
  __resetForTest,
  idbGet,
  idbGetAll,
  idbPut,
  openHeadscaleDb,
  STORE_KEYS,
  STORE_META,
  STORE_PROFILES,
} from "./idb";
import {
  type ConnectionProfile,
  hydrate,
  profileStorage,
  profileStorageTestingHandle,
  reencryptAll,
} from "./profile-storage";

const memoryStore = (): Storage => {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key) {
      return data.has(key) ? (data.get(key) as string) : null;
    },
    key(index) {
      return Array.from(data.keys())[index] ?? null;
    },
    removeItem(key) {
      data.delete(key);
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
  };
};

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  __resetForTest();
  profileStorageTestingHandle.reset();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: memoryStore(),
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: memoryStore(),
  });
});

async function makeSecret(plain: string): Promise<ApiKeySecret> {
  const key = await getOrCreateDeviceKey();
  return encryptApiKey(plain, key, "device");
}

function buildProfile(overrides: Partial<ConnectionProfile> & { apiKey: ApiKeySecret }) {
  const base: ConnectionProfile = {
    id: crypto.randomUUID(),
    name: "Test",
    baseUrl: "https://hs.example",
    apiKey: overrides.apiKey,
    updatedAt: new Date().toISOString(),
    scope: "persistent",
  };
  return { ...base, ...overrides };
}

function replaceObjectStoreMethod(
  method: "get" | "put" | "delete",
  replacement: (this: IDBObjectStore, ...args: unknown[]) => unknown,
): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, method);
  Object.defineProperty(IDBObjectStore.prototype, method, {
    configurable: true,
    value: replacement,
  });
  return () => {
    if (descriptor) Object.defineProperty(IDBObjectStore.prototype, method, descriptor);
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("hydrate", () => {
  test("calling sync API before hydrate throws", () => {
    expect(() => profileStorage.loadProfiles()).toThrow();
  });

  test("empty IDB → empty cache, persistent flag true", async () => {
    await hydrate();
    expect(profileStorage.loadProfiles()).toEqual([]);
    expect(profileStorage.isPersistentAvailable()).toBe(true);
    expect(profileStorage.hasAnyProfile()).toBe(false);
  });

  test("falls back to an in-memory cache without IndexedDB or sessionStorage", async () => {
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args) => void warnings.push(args);
    Reflect.deleteProperty(globalThis, "sessionStorage");
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined });
    __resetForTest();

    try {
      await hydrate();
    } finally {
      console.warn = originalWarn;
    }

    expect(profileStorage.isPersistentAvailable()).toBe(false);
    expect(profileStorage.loadProfiles()).toEqual([]);
    expect(profileStorage.currentTabId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(warnings[0]?.[0]).toContain("persistent profiles disabled");
  });

  test("skips invalid IDs and marks malformed secrets corrupted with safe defaults", async () => {
    await idbPut(STORE_PROFILES, { id: 123, name: "invalid id", apiKey: { invalid: true } });
    await idbPut(STORE_PROFILES, {
      id: "corrupted-defaults",
      mode: "unexpected",
      apiKey: { invalid: true },
    });
    await idbPut(STORE_PROFILES, {
      id: "mock-profile",
      mode: "mock",
      baseUrl: "https://mock.example.invalid",
      apiKey: await makeSecret("test-secret"),
    });

    await hydrate();

    expect(profileStorage.loadProfiles()).toHaveLength(2);
    expect(profileStorage.loadProfiles().find((p) => p.id === "corrupted-defaults")).toMatchObject({
      name: "Profile",
      baseUrl: "",
      scope: "persistent",
      corrupted: true,
      apiKey: { v: 1, scheme: "device", iv: "", ct: "" },
    });
    const mockProfile = profileStorage.loadProfiles().find((p) => p.id === "mock-profile");
    expect(mockProfile).toMatchObject({
      name: "https://mock.example.invalid",
    });
    expect(mockProfile?.corrupted).toBeUndefined();
  });

  test("marks plaintext profiles corrupted when no migration callback exists", async () => {
    await idbPut(STORE_PROFILES, {
      id: "plaintext-profile",
      apiKey: "plaintext-test-secret",
      scope: "persistent",
    });
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args) => void warnings.push(args);

    try {
      await hydrate();
    } finally {
      console.warn = originalWarn;
    }

    expect(profileStorage.loadProfiles()[0]).toMatchObject({
      id: "plaintext-profile",
      corrupted: true,
      apiKey: { v: 1, scheme: "device", iv: "", ct: "" },
    });
    expect(warnings[0]?.[0]).toContain("plaintext apiKey");
  });

  test("marks plaintext profiles corrupted when migration encryption fails", async () => {
    await idbPut(STORE_PROFILES, {
      id: "migration-failure",
      apiKey: "plaintext-test-secret",
      scope: "persistent",
    });
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args) => void errors.push(args);

    try {
      await hydrate({
        encryptLegacy: async () => {
          throw new Error("simulated encryption failure");
        },
      });
    } finally {
      console.error = originalError;
    }

    expect(profileStorage.loadProfiles()[0]?.corrupted).toBe(true);
    expect(errors[0]?.[0]).toContain("failed to encrypt legacy plaintext profile");
  });

  test("session profile from another tab is discarded", async () => {
    const stale = buildProfile({
      apiKey: await makeSecret("k"),
      scope: "session",
      ownerTabId: "other-tab",
    });
    await idbPut(STORE_PROFILES, stale);
    __resetForTest();
    profileStorageTestingHandle.reset();

    await hydrate();
    expect(profileStorage.loadProfiles()).toEqual([]);
    expect(await idbGetAll(STORE_PROFILES)).toHaveLength(0);
  });

  test("continues without loading a stale session profile when its deletion fails", async () => {
    const stale = buildProfile({
      id: "stale-session",
      apiKey: await makeSecret("test-secret"),
      scope: "session",
      ownerTabId: "other-tab",
    });
    await idbPut(STORE_PROFILES, stale);
    const restore = replaceObjectStoreMethod("delete", () => {
      throw new Error("simulated stale-profile deletion failure");
    });
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args) => void errors.push(args);

    try {
      await hydrate();
    } finally {
      restore();
      console.error = originalError;
    }

    expect(profileStorage.loadProfiles()).toEqual([]);
    expect(await idbGet(STORE_PROFILES, stale.id)).toEqual(stale);
    expect(errors[0]?.[0]).toContain("failed to discard stale session profile");
  });

  test("does not rewrite a migrated stale session profile after discarding it", async () => {
    sessionStorage.setItem("headscale-ui-tab-id", "current-tab");
    await idbPut(STORE_PROFILES, {
      id: "stale-plaintext-session",
      apiKey: "plaintext-test-secret",
      scope: "session",
      ownerTabId: "other-tab",
    });
    let migrations = 0;

    await hydrate({
      encryptLegacy: async () => {
        migrations++;
        return { v: 1, scheme: "device", iv: "test-iv", ct: "test-ct" };
      },
    });

    expect(migrations).toBe(1);
    expect(profileStorage.loadProfiles()).toEqual([]);
    expect(await idbGet(STORE_PROFILES, "stale-plaintext-session")).toBeUndefined();
  });

  test("session profile owned by current tab survives", async () => {
    await hydrate();
    const tabId = profileStorage.currentTabId();
    profileStorageTestingHandle.reset();
    __resetForTest();

    const mine = buildProfile({
      apiKey: await makeSecret("k"),
      scope: "session",
      ownerTabId: tabId,
    });
    await idbPut(STORE_PROFILES, mine);

    sessionStorage.setItem("headscale-ui-tab-id", tabId);
    await hydrate();
    expect(profileStorage.loadProfiles().map((p) => p.id)).toEqual([mine.id]);
  });

  test("restores the active profile ID from metadata", async () => {
    await idbPut(STORE_META, "active-profile", "active-profile-id");

    await hydrate();

    expect(profileStorage.readActiveProfile()).toBe("active-profile");
  });

  test("uses no active profile when its metadata request fails", async () => {
    await openHeadscaleDb();
    const failure = new DOMException("simulated metadata failure", "UnknownError");
    const request = { error: failure, result: undefined } as unknown as IDBRequest<undefined>;
    Object.defineProperty(request, "onerror", {
      configurable: true,
      set(handler: ((this: IDBRequest, ev: Event) => unknown) | null) {
        queueMicrotask(() => handler?.call(request, new Event("error")));
      },
    });
    const restore = replaceObjectStoreMethod("get", () => request);

    try {
      await hydrate();
    } finally {
      restore();
    }

    expect(profileStorage.readActiveProfile()).toBeNull();
  });
});

describe("legacy connection mode migration", () => {
  const encrypted: ApiKeySecret = {
    v: 1,
    scheme: "password",
    iv: "preserve-iv-without-unlocking",
    ct: "preserve-ciphertext-without-unlocking",
  };

  test.each([
    ["mock", "http://127.0.0.1:8080", false],
    ["mock", "  http://127.0.0.1:8080/  ", false],
    ["mock", "https://hs.example", true],
    ["real", "http://127.0.0.1:8080", true],
    [undefined, "http://127.0.0.1:8080", true],
    ["mock", "http://localhost:8080", true],
    ["mock", "http://127.0.0.1:8080//", true],
    ["unexpected", "http://127.0.0.1:8080", true],
  ])("migrates legacy mode %s at %s", async (mode, baseUrl, preserved) => {
    const record = {
      id: "legacy-profile",
      name: "User-chosen name",
      baseUrl,
      apiKey: encrypted,
      updatedAt: "2026-01-01T00:00:00.000Z",
      scope: "persistent",
    };
    await idbPut(STORE_PROFILES, mode === undefined ? record : { ...record, mode });
    await idbPut(STORE_META, record.id, "active-profile-id");

    await hydrate();

    expect(await idbGet(STORE_PROFILES, record.id)).toEqual(preserved ? record : undefined);
    expect(profileStorage.loadProfiles()).toEqual(preserved ? [record] : []);
    expect(profileStorage.readActiveProfile()).toBe(preserved ? record.id : null);
    expect(await idbGet(STORE_META, "active-profile-id")).toBe(preserved ? record.id : undefined);
  });

  test("preserves real credentials, keys, preferences and active reference across repeat hydration", async () => {
    const real = { ...buildProfile({ id: "real", apiKey: encrypted }), mode: "mock" };
    const { mode: _mode, ...expected } = real;
    await idbPut(STORE_PROFILES, real);
    await idbPut(STORE_PROFILES, {
      id: "demo",
      mode: "mock",
      baseUrl: "http://127.0.0.1:8080",
      apiKey: "legacy-demo-plaintext",
    });
    await idbPut(STORE_META, "real", "active-profile-id");
    await idbPut(STORE_META, { theme: "dark", locale: "zh-CN" }, "ui-settings");
    await idbPut(STORE_META, { salt: "saved-salt", canary: encrypted }, "password-canary");
    await idbPut(STORE_KEYS, "unchanged-device-key", "device-key");
    const encryptLegacy = async () => {
      throw new Error("Deleted demo credentials must not be encrypted");
    };

    await hydrate({ encryptLegacy });
    await hydrate({ encryptLegacy });

    expect(profileStorage.loadProfiles()).toEqual([expected]);
    expect(await idbGetAll(STORE_PROFILES)).toEqual([expected]);
    expect(profileStorage.readActiveProfile()).toBe("real");
    expect(await idbGet(STORE_META, "ui-settings")).toEqual({ theme: "dark", locale: "zh-CN" });
    expect(await idbGet(STORE_META, "password-canary")).toEqual({
      salt: "saved-salt",
      canary: encrypted,
    });
    expect(await idbGet(STORE_KEYS, "device-key")).toBe("unchanged-device-key");
  });

  test("rolls back profile deletion, mode rewrites and active reference when a write fails", async () => {
    const demo = {
      ...buildProfile({ id: "a-demo", apiKey: encrypted }),
      mode: "mock",
      baseUrl: "http://127.0.0.1:8080",
    };
    const real = { ...buildProfile({ id: "b-real", apiKey: encrypted }), mode: "real" };
    await idbPut(STORE_PROFILES, demo);
    await idbPut(STORE_PROFILES, real);
    await idbPut(STORE_META, demo.id, "active-profile-id");
    const restore = replaceObjectStoreMethod("put", function (value) {
      return this.add(value);
    });

    let failure: unknown;
    try {
      await hydrate();
    } catch (error) {
      failure = error;
    } finally {
      restore();
    }

    expect(failure).toBeInstanceOf(Error);
    expect(await idbGetAll(STORE_PROFILES)).toEqual([demo, real]);
    expect(await idbGet(STORE_META, "active-profile-id")).toBe(demo.id);
    expect(() => profileStorage.loadProfiles()).toThrow("accessed before hydrate");

    await hydrate();
    expect(profileStorage.loadProfiles().map((p) => p.id)).toEqual([real.id]);
    expect(profileStorage.readActiveProfile()).toBeNull();
  });

  test("invalidates a previously hydrated cache when a profile rewrite throws", async () => {
    await hydrate();
    const real = { ...buildProfile({ id: "real", apiKey: encrypted }), mode: "real" };
    await idbPut(STORE_PROFILES, real);
    const failure = new Error("Profile migration failed");
    const restore = replaceObjectStoreMethod("put", () => {
      throw failure;
    });
    let caught: unknown;

    try {
      await hydrate();
    } catch (error) {
      caught = error;
    } finally {
      restore();
    }

    expect(caught).toBe(failure);
    expect(await idbGet(STORE_PROFILES, real.id)).toEqual(real);
    expect(() => profileStorage.loadProfiles()).toThrow("accessed before hydrate");
  });

  test("rolls back demo deletion when reading its active reference fails asynchronously", async () => {
    const demo = {
      ...buildProfile({ id: "demo", apiKey: encrypted }),
      mode: "mock",
      baseUrl: "http://127.0.0.1:8080",
    };
    await idbPut(STORE_PROFILES, demo);
    await idbPut(STORE_META, demo.id, "active-profile-id");
    const restore = replaceObjectStoreMethod("get", function (key) {
      return this.add("duplicate", key as IDBValidKey);
    });
    let failure: unknown;

    try {
      await hydrate();
    } catch (error) {
      failure = error;
    } finally {
      restore();
    }

    expect(failure).toHaveProperty("name", "ConstraintError");
    expect(await idbGet(STORE_PROFILES, demo.id)).toEqual(demo);
    expect(await idbGet(STORE_META, "active-profile-id")).toBe(demo.id);
    expect(() => profileStorage.loadProfiles()).toThrow("accessed before hydrate");
  });

  test("rejects hydration and rolls back when clearing a deleted demo's active reference throws", async () => {
    const demo = {
      ...buildProfile({ id: "demo", apiKey: encrypted }),
      mode: "mock",
      baseUrl: "http://127.0.0.1:8080",
    };
    await idbPut(STORE_PROFILES, demo);
    await idbPut(STORE_META, demo.id, "active-profile-id");
    const originalDelete = IDBObjectStore.prototype.delete;
    const failure = new Error("Active profile migration failed");
    const restore = replaceObjectStoreMethod("delete", function (key) {
      if (this.name === STORE_META) throw failure;
      return originalDelete.call(this, key as IDBValidKey);
    });

    let caught: unknown;
    try {
      await hydrate();
    } catch (error) {
      caught = error;
    } finally {
      restore();
    }

    expect(caught).toBe(failure);
    expect(await idbGet(STORE_PROFILES, demo.id)).toEqual(demo);
    expect(await idbGet(STORE_META, "active-profile-id")).toBe(demo.id);
    expect(() => profileStorage.loadProfiles()).toThrow("accessed before hydrate");
  });
});

describe("save/load round-trip", () => {
  test("saveProfile + loadProfiles via cache", async () => {
    await hydrate();
    const secret = await makeSecret("hs_xyz");
    const profile = buildProfile({ apiKey: secret });
    profileStorage.saveProfile(profile, "persistent");

    expect(profileStorage.loadProfiles()).toHaveLength(1);
    expect(profileStorage.hasProfile(profile.id)).toBe(true);
    expect(profileStorage.getProfileScope(profile.id)).toBe("persistent");
    expect(profileStorage.getProfileScope("missing-profile")).toBeNull();
    expect(profileStorage.hasAnyProfile()).toBe(true);
  });

  test("keeps the cached profile when persistence fails", async () => {
    await hydrate();
    const profile = buildProfile({ apiKey: await makeSecret("test-secret") });
    const restore = replaceObjectStoreMethod("put", () => {
      throw new Error("simulated profile write failure");
    });
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args) => void errors.push(args);

    try {
      profileStorage.saveProfile(profile, "persistent");
      await settle();
    } finally {
      restore();
      console.error = originalError;
    }

    expect(profileStorage.hasProfile(profile.id)).toBe(true);
    expect(await idbGet(STORE_PROFILES, profile.id)).toBeUndefined();
    expect(errors[0]?.[0]).toContain("saveProfile idbPut failed");
  });

  test("saveProfile with session scope tags with current tab id", async () => {
    await hydrate();
    const tabId = profileStorage.currentTabId();
    const secret = await makeSecret("hs_session");
    const profile = buildProfile({ apiKey: secret, scope: "persistent" });
    profileStorage.saveProfile(profile, "session");

    const loaded = profileStorage.loadProfiles()[0];
    expect(loaded.scope).toBe("session");
    expect(loaded.ownerTabId).toBe(tabId);
  });

  test("deleteProfile drops cache + IDB", async () => {
    await hydrate();
    const profile = buildProfile({ apiKey: await makeSecret("k") });
    profileStorage.saveProfile(profile, "persistent");
    profileStorage.deleteProfile(profile.id);
    expect(profileStorage.hasProfile(profile.id)).toBe(false);
    await new Promise((r) => setTimeout(r, 10));
    expect(await idbGet(STORE_PROFILES, profile.id)).toBeUndefined();
  });

  test("set/read/clear active profile", async () => {
    await hydrate();
    const profile = buildProfile({ apiKey: await makeSecret("k") });
    profileStorage.saveProfile(profile, "persistent");

    profileStorage.setActiveProfile(profile.id, "persistent");
    expect(profileStorage.readActiveProfile()).toBe(profile.id);

    profileStorage.clearActiveProfile();
    expect(profileStorage.readActiveProfile()).toBeNull();
  });

  test("clears an active deleted profile from memory even when IDB deletion fails", async () => {
    await hydrate();
    const profile = buildProfile({ apiKey: await makeSecret("test-secret") });
    profileStorage.saveProfile(profile, "persistent");
    profileStorage.setActiveProfile(profile.id, "persistent");
    await settle();
    const restore = replaceObjectStoreMethod("delete", () => {
      throw new Error("simulated delete failure");
    });
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args) => void errors.push(args);

    try {
      profileStorage.deleteProfile(profile.id);
      await settle();
    } finally {
      restore();
      console.error = originalError;
    }

    expect(profileStorage.hasProfile(profile.id)).toBe(false);
    expect(profileStorage.readActiveProfile()).toBeNull();
    expect(await idbGet(STORE_PROFILES, profile.id)).toBeDefined();
    expect(await idbGet(STORE_META, "active-profile-id")).toBe(profile.id);
    expect(errors.map(([message]) => message)).toEqual([
      "[headscale-ui] clearActiveProfile idbDelete failed",
      "[headscale-ui] deleteProfile idbDelete failed",
    ]);
  });

  test("updates active profile memory when metadata persistence fails", async () => {
    await hydrate();
    const restore = replaceObjectStoreMethod("put", () => {
      throw new Error("simulated active-profile write failure");
    });
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args) => void errors.push(args);

    try {
      profileStorage.setActiveProfile("profile-a", "persistent");
      await settle();
    } finally {
      restore();
      console.error = originalError;
    }

    expect(profileStorage.readActiveProfile()).toBe("profile-a");
    expect(await idbGet(STORE_META, "active-profile-id")).toBeUndefined();
    expect(errors[0]?.[0]).toContain("setActiveProfile idbPut failed");
  });

  test("clears active profile memory when metadata deletion fails", async () => {
    await hydrate();
    profileStorage.setActiveProfile("profile-a", "persistent");
    await settle();
    const restore = replaceObjectStoreMethod("delete", () => {
      throw new Error("simulated active-profile deletion failure");
    });
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args) => void errors.push(args);

    try {
      profileStorage.clearActiveProfile();
      await settle();
    } finally {
      restore();
      console.error = originalError;
    }

    expect(profileStorage.readActiveProfile()).toBeNull();
    expect(await idbGet(STORE_META, "active-profile-id")).toBe("profile-a");
    expect(errors[0]?.[0]).toContain("clearActiveProfile idbDelete failed");
  });
});

describe("markCorrupted", () => {
  test("persisted to IDB and visible after re-hydrate", async () => {
    await hydrate();
    const profile = buildProfile({ apiKey: await makeSecret("k") });
    profileStorage.saveProfile(profile, "persistent");
    profileStorage.markCorrupted(profile.id);

    await new Promise((r) => setTimeout(r, 20));
    profileStorageTestingHandle.reset();
    __resetForTest();
    await hydrate();

    const reloaded = profileStorage.loadProfiles().find((p) => p.id === profile.id);
    expect(reloaded?.corrupted).toBe(true);
  });

  test("is a no-op for missing and already-corrupted profiles", async () => {
    await idbPut(STORE_PROFILES, {
      ...buildProfile({ id: "already-corrupted", apiKey: await makeSecret("test-secret") }),
      corrupted: true,
    });
    await hydrate();

    profileStorage.markCorrupted("missing-profile");
    profileStorage.markCorrupted("already-corrupted");

    expect(profileStorage.hasProfile("missing-profile")).toBe(false);
    expect(profileStorage.loadProfiles().find((p) => p.id === "already-corrupted")?.corrupted).toBe(
      true,
    );
  });

  test("keeps the corruption marker in memory when persistence fails", async () => {
    await hydrate();
    const profile = buildProfile({ apiKey: await makeSecret("test-secret") });
    profileStorage.saveProfile(profile, "persistent");
    await settle();
    const restore = replaceObjectStoreMethod("put", () => {
      throw new Error("simulated corrupted-profile write failure");
    });
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args) => void errors.push(args);

    try {
      profileStorage.markCorrupted(profile.id);
      await settle();
    } finally {
      restore();
      console.error = originalError;
    }

    expect(profileStorage.loadProfiles().find((p) => p.id === profile.id)?.corrupted).toBe(true);
    expect(
      ((await idbGet(STORE_PROFILES, profile.id)) as ConnectionProfile).corrupted,
    ).toBeUndefined();
    expect(errors[0]?.[0]).toContain("markCorrupted idbPut failed");
  });
});

describe("IDB plaintext migration", () => {
  test("plaintext apiKey written directly to IDB gets re-encrypted in place", async () => {
    const id = crypto.randomUUID();
    await idbPut(STORE_PROFILES, {
      id,
      name: "Mid",
      mode: "real",
      baseUrl: "https://hs.mid",
      apiKey: "hs_mid_plain",
      updatedAt: new Date().toISOString(),
      scope: "persistent",
    });

    const deviceKey = await getOrCreateDeviceKey();
    await hydrate({
      encryptLegacy: (plain) => encryptApiKey(plain, deviceKey, "device"),
    });

    const loaded = profileStorage.loadProfiles();
    expect(loaded[0].id).toBe(id);
    const plain = await decryptApiKey(loaded[0].apiKey, deviceKey);
    expect(plain).toBe("hs_mid_plain");

    const raw = (await idbGet(STORE_PROFILES, id)) as ConnectionProfile;
    expect(typeof raw.apiKey).toBe("object");
    expect((raw.apiKey as ApiKeySecret).scheme).toBe("device");
  });

  test("keeps the migrated profile in memory when rewriting IDB fails", async () => {
    await idbPut(STORE_PROFILES, {
      id: "migration-write-failure",
      apiKey: "plaintext-test-secret",
      scope: "persistent",
    });
    const migrated: ApiKeySecret = {
      v: 1,
      scheme: "device",
      iv: "test-iv",
      ct: "test-ct",
    };
    const restore = replaceObjectStoreMethod("put", () => {
      throw new Error("simulated migration write failure");
    });
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args) => void errors.push(args);

    try {
      await hydrate({ encryptLegacy: async () => migrated });
    } finally {
      restore();
      console.error = originalError;
    }

    expect(profileStorage.loadProfiles()[0]?.apiKey).toEqual(migrated);
    expect(
      (await idbGet<{ apiKey: unknown }>(STORE_PROFILES, "migration-write-failure"))?.apiKey,
    ).toBe("plaintext-test-secret");
    expect(errors[0]?.[0]).toContain("failed to write migrated profile");
  });
});

describe("reencryptAll", () => {
  test("happy path: every persistent profile transformed and persisted in one transaction", async () => {
    await hydrate();
    const deviceKey = await getOrCreateDeviceKey();
    const a = buildProfile({ apiKey: await encryptApiKey("token-a", deviceKey, "device") });
    const b = buildProfile({ apiKey: await encryptApiKey("token-b", deviceKey, "device") });
    profileStorage.saveProfile(a, "persistent");
    profileStorage.saveProfile(b, "persistent");
    await new Promise((r) => setTimeout(r, 20));

    const salt = generateCanarySalt();
    const passwordKey = await deriveKeyFromPassword("p", salt, 10_000);

    await reencryptAll({
      transform: async (current) => {
        const plain = await decryptApiKey(current, deviceKey);
        return encryptApiKey(plain, passwordKey, "password");
      },
      withinTransaction: (tx) => {
        tx.objectStore(STORE_META).put({ marker: 1 }, "password-canary");
      },
    });

    for (const p of profileStorage.loadProfiles()) {
      expect(p.apiKey.scheme).toBe("password");
      const plain = await decryptApiKey(p.apiKey, passwordKey);
      expect(plain).toMatch(/^token-[ab]$/);
    }

    const canary = (await idbGet(STORE_META, "password-canary")) as { marker: number };
    expect(canary?.marker).toBe(1);
  });

  test("memory phase failure leaves cache and IDB unchanged", async () => {
    await hydrate();
    const deviceKey = await getOrCreateDeviceKey();
    const a = buildProfile({ apiKey: await encryptApiKey("token-a", deviceKey, "device") });
    profileStorage.saveProfile(a, "persistent");
    await new Promise((r) => setTimeout(r, 20));

    const before = (await idbGet(STORE_PROFILES, a.id)) as ConnectionProfile;

    await expect(
      reencryptAll({
        transform: async () => {
          throw new Error("simulated failure mid-rotation");
        },
      }),
    ).rejects.toThrow("simulated failure");

    const after = (await idbGet(STORE_PROFILES, a.id)) as ConnectionProfile;
    expect(after.apiKey).toEqual(before.apiKey);
    const cached = profileStorage.loadProfiles()[0];
    expect(cached.apiKey).toEqual(before.apiKey);
  });

  test("corrupted profiles are skipped", async () => {
    await hydrate();
    const deviceKey = await getOrCreateDeviceKey();
    const good = buildProfile({ apiKey: await encryptApiKey("g", deviceKey, "device") });
    const bad = buildProfile({ apiKey: await encryptApiKey("b", deviceKey, "device") });
    profileStorage.saveProfile(good, "persistent");
    profileStorage.saveProfile(bad, "persistent");
    profileStorage.markCorrupted(bad.id);
    await new Promise((r) => setTimeout(r, 20));

    let calls = 0;
    await reencryptAll({
      transform: async (s) => {
        calls++;
        return s;
      },
    });

    expect(calls).toBe(1);
  });
});
