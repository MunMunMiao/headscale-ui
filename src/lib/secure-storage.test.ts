import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test, vi } from "vitest";
import { idbDelete, idbGet, idbGetAll, idbPut } from "@/test-utils/storage";
import { __resetForTest } from "./idb";
import { clearAllSecureData } from "./secure-storage";
import { readVaultState, subscribeVaultChanges } from "./vault-state";

function memoryStore(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, String(value));
    },
  };
}
beforeEach(() => {
  __resetForTest();
  globalThis.indexedDB = new IDBFactory();
  vi.stubGlobal("sessionStorage", memoryStore());
});
async function seed() {
  await idbPut("profiles", { id: "profile-a" });
  await idbPut("keys", "device-key", "key-a");
  await idbPut("meta", "metadata", "meta-a");
}
test("clears all stores atomically, keeps an epoch sentinel and removes only owned session keys", async () => {
  await seed();
  const before = await idbGet("meta", "vault-state");
  sessionStorage.setItem("headscale-ui-tab-id", "tab-a");
  sessionStorage.setItem("other-app", "keep");
  const changes = vi.fn();
  const stop = subscribeVaultChanges(changes);
  expect(await clearAllSecureData()).toEqual({
    committed: true,
    sessionMetadataCleared: true,
    version: expect.objectContaining({ profilesRevision: 0 }),
  });
  stop();
  expect(await idbGetAll("profiles")).toEqual([]);
  expect(await idbGetAll("keys")).toEqual([]);
  const remaining = await idbGetAll("meta");
  expect(remaining).toEqual([{ v: 1, keyEpoch: expect.any(String), profilesRevision: 0 }]);
  expect(remaining[0]).not.toEqual(before);
  expect(changes).toHaveBeenCalledWith(
    expect.objectContaining({ reset: true, profilesRevision: 0 }),
  );
  expect(sessionStorage.getItem("headscale-ui-tab-id")).toBeNull();
  expect(sessionStorage.getItem("other-app")).toBe("keep");
});
test.each(["profiles", "keys", "meta"])(
  "an abort at %s clear preserves every store and session metadata",
  async (store) => {
    await seed();
    sessionStorage.setItem("headscale-ui-tab-id", "tab-a");
    const before = await Promise.all([idbGetAll("profiles"), idbGetAll("keys"), idbGetAll("meta")]);
    const original = IDBObjectStore.prototype.clear;
    const interception = vi.spyOn(IDBObjectStore.prototype, "clear").mockImplementation(function (
      this: IDBObjectStore,
    ) {
      if (this.name === store) throw new DOMException("reset abort", "UnknownError");
      return original.call(this);
    });
    await expect(clearAllSecureData()).rejects.toThrow("reset abort");
    interception.mockRestore();
    expect(
      await Promise.all([idbGetAll("profiles"), idbGetAll("keys"), idbGetAll("meta")]),
    ).toEqual(before);
    expect(sessionStorage.getItem("headscale-ui-tab-id")).toBe("tab-a");
  },
);
test("reports committed data separately from failed session metadata cleanup", async () => {
  await seed();
  sessionStorage.setItem("headscale-ui-tab-id", "tab-a");
  const spy = vi.spyOn(sessionStorage, "removeItem").mockImplementation(() => {
    throw new DOMException("denied", "SecurityError");
  });
  expect(await clearAllSecureData()).toEqual({
    committed: true,
    sessionMetadataCleared: false,
    version: expect.objectContaining({ profilesRevision: 0 }),
  });
  spy.mockRestore();
  expect(await idbGetAll("profiles")).toEqual([]);
  expect(sessionStorage.getItem("headscale-ui-tab-id")).toBe("tab-a");
});
test("worker reset commits storage without claiming to have cleared another page's session metadata", async () => {
  await seed();
  vi.stubGlobal("sessionStorage", undefined);
  expect(await clearAllSecureData()).toEqual({
    committed: true,
    sessionMetadataCleared: false,
    version: expect.objectContaining({ profilesRevision: 0 }),
  });
  expect(await idbGetAll("profiles")).toEqual([]);
});

test("reset compares the caller's vault revision before clearing and returns its committed epoch", async () => {
  await seed();
  const expected = readVaultState(await idbGet("meta", "vault-state"));
  const current = { ...expected, profilesRevision: expected.profilesRevision + 1 };
  await idbPut("meta", current, "vault-state");
  const before = await Promise.all([idbGetAll("profiles"), idbGetAll("keys"), idbGetAll("meta")]);
  await expect(clearAllSecureData(expected)).rejects.toThrow("changed in another operation");
  expect(await Promise.all([idbGetAll("profiles"), idbGetAll("keys"), idbGetAll("meta")])).toEqual(
    before,
  );
  const result = await clearAllSecureData(current);
  const committed = readVaultState(await idbGet("meta", "vault-state"));
  expect("version" in result ? result.version : undefined).toEqual(committed);
  expect(committed.keyEpoch).not.toBe(current.keyEpoch);
});

test("request-success cancellation aborts reset before it commits and preserves page metadata", async () => {
  await seed();
  sessionStorage.setItem("headscale-ui-tab-id", "keep");
  const expected = readVaultState(await idbGet("meta", "vault-state"));
  const before = await Promise.all([idbGetAll("profiles"), idbGetAll("keys"), idbGetAll("meta")]);
  const controller = new AbortController();
  const clear = IDBObjectStore.prototype.clear;
  const spy = vi.spyOn(IDBObjectStore.prototype, "clear").mockImplementation(function (
    this: IDBObjectStore,
  ) {
    const request = clear.call(this);
    if (this.name === "profiles")
      request.addEventListener("success", () => controller.abort(), { once: true });
    return request;
  });
  try {
    await expect(clearAllSecureData(expected, controller.signal)).rejects.toThrow();
  } finally {
    spy.mockRestore();
  }
  expect(await Promise.all([idbGetAll("profiles"), idbGetAll("keys"), idbGetAll("meta")])).toEqual(
    before,
  );
  expect(sessionStorage.getItem("headscale-ui-tab-id")).toBe("keep");
});

const unreadableVaultStates = [
  ["deleted", async () => idbDelete("meta", "vault-state")],
  [
    "malformed",
    async () => idbPut("meta", { v: 1, keyEpoch: "", profilesRevision: -1 }, "vault-state"),
  ],
] as const;
test.each(unreadableVaultStates)(
  "a %s vault state is repaired by a null or stale expectation",
  async (_name, damage) => {
    for (const expected of [null, { keyEpoch: "stale", profilesRevision: 3 }]) {
      await seed();
      await damage();
      const result = await clearAllSecureData(expected);
      const committed = readVaultState(await idbGet("meta", "vault-state"));
      expect(committed.profilesRevision).toBe(0);
      expect(result.version).toEqual(committed);
      expect(await idbGetAll("profiles")).toEqual([]);
      expect(await idbGetAll("keys")).toEqual([]);
      expect(await idbGetAll("meta")).toEqual([committed]);
    }
  },
);
test("a null expectation never wipes a readable vault", async () => {
  await seed();
  const before = await Promise.all([idbGetAll("profiles"), idbGetAll("keys"), idbGetAll("meta")]);
  await expect(clearAllSecureData(null)).rejects.toThrow("changed in another operation");
  expect(await Promise.all([idbGetAll("profiles"), idbGetAll("keys"), idbGetAll("meta")])).toEqual(
    before,
  );
});

test("a storage failure while reading the vault version is not mistaken for an unreadable record", async () => {
  await seed();
  const before = await Promise.all([idbGetAll("profiles"), idbGetAll("keys"), idbGetAll("meta")]);
  const expected = readVaultState(await idbGet("meta", "vault-state"));
  const get = IDBObjectStore.prototype.get;
  const spy = vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (
    this: IDBObjectStore,
    ...args: Parameters<IDBObjectStore["get"]>
  ) {
    if (this.name === "meta") throw new DOMException("storage offline", "UnknownError");
    return get.apply(this, args);
  });
  try {
    await expect(clearAllSecureData(expected)).rejects.toThrow("storage offline");
  } finally {
    spy.mockRestore();
  }
  expect(await Promise.all([idbGetAll("profiles"), idbGetAll("keys"), idbGetAll("meta")])).toEqual(
    before,
  );
});
