import "fake-indexeddb/auto";
import { forceCloseDatabase, IDBFactory } from "fake-indexeddb";
import { unwrap } from "idb";
import { beforeEach, expect, test, vi } from "vitest";
import { idbGet, idbPut } from "@/test-utils/storage";
import {
  __resetForTest,
  bindTransactionAbort,
  DB_NAME,
  DB_VERSION,
  getDatabaseStatus,
  openHeadscaleDb,
  subscribeDatabaseStatus,
} from "./idb";

beforeEach(() => {
  __resetForTest();
  globalThis.indexedDB = new IDBFactory();
});
function oldDatabase(version = 1): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, version);
    request.onupgradeneeded = () => {
      for (const name of ["profiles", "keys", "meta"])
        if (!request.result.objectStoreNames.contains(name))
          request.result.createObjectStore(
            name,
            name === "profiles" ? { keyPath: "id" } : undefined,
          );
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function seedOld(active: string, scope?: string, ownerTabId?: string) {
  const db = await oldDatabase();
  const tx = db.transaction(["profiles", "meta"], "readwrite");
  tx.objectStore("profiles").put({
    id: "legacy",
    scope,
    ownerTabId,
    apiKey: "legacy-key",
    opaque: { untouched: true },
  });
  tx.objectStore("meta").put(active, "active-profile-id");
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
test("reports unavailable storage and permits a fresh open after a failed request", async () => {
  const original = indexedDB;
  vi.stubGlobal("indexedDB", undefined);
  await expect(openHeadscaleDb()).rejects.toThrow("not available");
  vi.stubGlobal("indexedDB", original);
  const db = await oldDatabase(DB_VERSION + 1);
  db.close();
  await expect(openHeadscaleDb()).rejects.toHaveProperty(
    "name",
    "VersionError",
  );
  __resetForTest();
  globalThis.indexedDB = new IDBFactory();
  expect((await openHeadscaleDb()).version).toBe(DB_VERSION);
});
test("exposes a blocked upgrade and resumes after the old connection closes", async () => {
  const old = await oldDatabase();
  const blocked = Promise.withResolvers<void>();
  const stop = subscribeDatabaseStatus(() => {
    if (getDatabaseStatus() === "blocked") blocked.resolve();
  });
  const opening = openHeadscaleDb();
  await blocked.promise;
  expect(getDatabaseStatus()).toBe("blocked");
  old.close();
  await opening;
  expect(getDatabaseStatus()).toBe("ready");
  stop();
});
test("a blocked open that then fails is no longer blocked", async () => {
  const old = await oldDatabase();
  const nativeOpen = indexedDB.open.bind(indexedDB);
  const interception = vi
    .spyOn(indexedDB, "open")
    .mockImplementationOnce((...args) => {
      const request = nativeOpen(...args);
      request.addEventListener(
        "upgradeneeded",
        () => request.transaction?.abort(),
        { once: true },
      );
      return request;
    });
  const blocked = Promise.withResolvers<void>();
  const stop = subscribeDatabaseStatus(() => {
    if (getDatabaseStatus() === "blocked") blocked.resolve();
  });
  const opening = openHeadscaleDb();
  const rejection = expect(opening).rejects.toThrow();
  await blocked.promise;
  old.close();
  await rejection;
  interception.mockRestore();
  stop();
  expect(getDatabaseStatus()).toBe("opening");
});
test("closes on versionchange and refuses subsequent writes until reload", async () => {
  await openHeadscaleDb();
  const next = await oldDatabase(DB_VERSION + 1);
  expect(getDatabaseStatus()).toBe("reload-required");
  await expect(idbPut("meta", "late", "late-write")).rejects.toThrow("Reload");
  next.close();
});
test("reopens after an unexpectedly terminated connection", async () => {
  const db = await openHeadscaleDb();
  const closed = new Promise<void>((resolve) =>
    db.addEventListener("close", () => resolve(), { once: true }),
  );
  // fake-indexeddb's declaration incorrectly accepts the constructor, not an instance.
  (forceCloseDatabase as unknown as (database: IDBDatabase) => void)(
    unwrap(db),
  );
  await closed;
  expect(await openHeadscaleDb()).not.toBe(db);
});
test.each(["persistent", "session", undefined])(
  "upgrades legacy active references and preserves opaque data: %s",
  async (scope) => {
    await seedOld("legacy", scope, "old-owner");
    await openHeadscaleDb();
    expect(await idbGet("profiles", "legacy")).toMatchObject({
      opaque: { untouched: true },
      keyEpoch: expect.any(String),
    });
    if (scope === "session") {
      expect(await idbGet("meta", "active-profile-id")).toBeUndefined();
      expect(await idbGet("meta", "active-profile:old-owner")).toMatchObject({
        profileId: "legacy",
        operationId: expect.any(String),
      });
    } else
      expect(await idbGet("meta", "active-profile-id")).toMatchObject({
        profileId: "legacy",
        operationId: expect.any(String),
      });
  },
);
test("an upgrade never replaces a key epoch a v1 record already carries", async () => {
  const db = await oldDatabase();
  const tx = db.transaction("profiles", "readwrite");
  tx.objectStore("profiles").put({
    id: "has-epoch",
    keyEpoch: "pre-existing",
    apiKey: "k",
  });
  tx.objectStore("profiles").put({ id: "plain", apiKey: "k" });
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  await openHeadscaleDb();
  const state = await idbGet<{ keyEpoch: string }>("meta", "vault-state");
  expect(await idbGet("profiles", "has-epoch")).toEqual({
    id: "has-epoch",
    keyEpoch: "pre-existing",
    apiKey: "k",
  });
  expect(await idbGet("profiles", "plain")).toMatchObject({
    keyEpoch: state?.keyEpoch,
  });
});
test("a legacy session profile without an owner loses its global active reference and gains no owner key", async () => {
  await seedOld("legacy", "session");
  await openHeadscaleDb();
  expect(await idbGet("meta", "active-profile-id")).toBeUndefined();
  const keys = await (await openHeadscaleDb()).getAllKeys("meta");
  expect(
    keys.filter((key) => String(key).startsWith("active-profile")),
  ).toEqual([]);
  expect(await idbGet("profiles", "legacy")).toMatchObject({
    keyEpoch: expect.any(String),
  });
});
test("drops only an orphaned active reference during upgrade", async () => {
  await seedOld("missing");
  await openHeadscaleDb();
  expect(await idbGet("meta", "active-profile-id")).toBeUndefined();
  expect(await idbGet("profiles", "legacy")).toBeDefined();
});
test("an aborted upgrade leaves the v1 records untouched", async () => {
  await seedOld("legacy");
  const original = IDBObjectStore.prototype.put;
  const interception = vi
    .spyOn(IDBObjectStore.prototype, "put")
    .mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === "profiles")
        throw new DOMException("upgrade quota", "QuotaExceededError");
      return original.apply(this, args);
    });
  await expect(openHeadscaleDb()).rejects.toThrow("upgrade quota");
  interception.mockRestore();
  const old = await oldDatabase();
  expect(old.version).toBe(1);
  const request = old
    .transaction("profiles")
    .objectStore("profiles")
    .get("legacy");
  const row = await new Promise<unknown>((resolve) => {
    request.onsuccess = () => resolve(request.result);
  });
  expect(row).not.toHaveProperty("keyEpoch");
  old.close();
});

test("an upgrade aborted by the browser preserves v1 data and can be retried without an unhandled cleanup failure", async () => {
  await seedOld("legacy", "persistent");
  const nativeOpen = indexedDB.open.bind(indexedDB);
  const interception = vi
    .spyOn(indexedDB, "open")
    .mockImplementationOnce((...args) => {
      const request = nativeOpen(...args);
      request.addEventListener(
        "upgradeneeded",
        () => request.transaction?.abort(),
        { once: true },
      );
      return request;
    });
  await expect(openHeadscaleDb()).rejects.toThrow();
  interception.mockRestore();
  const old = await oldDatabase();
  expect(old.version).toBe(1);
  const request = old
    .transaction("profiles")
    .objectStore("profiles")
    .get("legacy");
  const row = await new Promise<unknown>((resolve) => {
    request.onsuccess = () => resolve(request.result);
  });
  expect(row).toMatchObject({
    id: "legacy",
    apiKey: "legacy-key",
    opaque: { untouched: true },
  });
  expect(row).not.toHaveProperty("keyEpoch");
  old.close();
  expect((await openHeadscaleDb()).version).toBe(DB_VERSION);
});

test("opens schema v3 without rewriting any legacy credential or allocating a device key", async () => {
  const legacy = await oldDatabase(2);
  const raw = [
    {
      id: "plaintext",
      apiKey: "historical-token",
      scope: "persistent",
      opaque: { keep: [1, 2] },
    },
    {
      id: "owner",
      apiKey: { v: 1, scheme: "device", iv: "old-iv", ct: "old-cipher" },
      scope: "session",
      ownerTabId: "owner-a",
    },
    {
      id: "foreign",
      apiKey: {
        v: 1,
        scheme: "password",
        iv: "foreign-iv",
        ct: "foreign-cipher",
      },
      scope: "session",
      ownerTabId: "owner-b",
    },
    { id: "unreadable", apiKey: { unknown: true }, opaque: "preserve" },
  ];
  const tx = legacy.transaction(["profiles", "meta"], "readwrite");
  for (const row of raw) tx.objectStore("profiles").put(row);
  tx.objectStore("meta").put(
    { v: 1, keyEpoch: "legacy-epoch", profilesRevision: 4 },
    "vault-state",
  );
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  legacy.close();
  const database = await openHeadscaleDb();
  expect(database.version).toBe(3);
  for (const row of raw)
    expect(await database.get("profiles", row.id)).toEqual(row);
  expect(await database.getAll("keys")).toEqual([]);
  expect(await database.get("meta", "vault-state")).toEqual({
    v: 1,
    keyEpoch: "legacy-epoch",
    profilesRevision: 4,
  });
});

test("a transaction bound to an already aborted signal is rolled back immediately", () => {
  const abort = vi.fn(() => {
    throw new DOMException("finished", "InvalidStateError");
  });
  const release = bindTransactionAbort({ abort }, AbortSignal.abort());
  expect(abort).toHaveBeenCalledTimes(1);
  expect(() => release()).not.toThrow();
});

test("a later abort rolls the transaction back once and release detaches it", () => {
  const controller = new AbortController();
  const bound = { abort: vi.fn() };
  const released = { abort: vi.fn() };
  const release = bindTransactionAbort(bound, controller.signal);
  bindTransactionAbort(released, controller.signal)();
  expect(bound.abort).not.toHaveBeenCalled();
  controller.abort();
  release();
  expect(bound.abort).toHaveBeenCalledTimes(1);
  expect(released.abort).not.toHaveBeenCalled();
});
