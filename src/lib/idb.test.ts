import "fake-indexeddb/auto";
import { beforeEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import {
  __resetForTest,
  DB_NAME,
  idbClear,
  idbDelete,
  idbGet,
  idbGetAll,
  idbPut,
  openHeadscaleDb,
  STORE_META,
  STORE_PROFILES,
  withTransaction,
} from "./idb";

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  __resetForTest();
});

describe("IndexedDB wrapper", () => {
  test("rejects clearly when IndexedDB is unavailable", async () => {
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined });
    __resetForTest();

    await expect(openHeadscaleDb()).rejects.toThrow(
      "IndexedDB is not available in this environment",
    );
  });

  test("puts, reads, lists, deletes, and clears records", async () => {
    await idbPut(STORE_PROFILES, { id: "profile-a", name: "A" });
    await idbPut(STORE_META, "value-a", "key-a");
    await idbPut(STORE_META, "value-b", "key-b");

    expect(await idbGet<{ id: string }>(STORE_PROFILES, "profile-a")).toEqual({
      id: "profile-a",
      name: "A",
    });
    expect(await idbGetAll<string>(STORE_META)).toEqual(["value-a", "value-b"]);

    await idbDelete(STORE_META, "key-a");
    expect(await idbGet(STORE_META, "key-a")).toBeUndefined();
    await idbClear(STORE_META);
    expect(await idbGetAll(STORE_META)).toEqual([]);
  });

  test("propagates database-open request errors", async () => {
    const upgradedDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    upgradedDb.close();
    __resetForTest();

    await expect(openHeadscaleDb()).rejects.toHaveProperty("name", "VersionError");
  });

  test("propagates object-store request errors", async () => {
    await openHeadscaleDb();
    const failure = new DOMException("simulated request failure", "UnknownError");
    const descriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "get");
    const request = { error: failure, result: undefined } as unknown as IDBRequest<undefined>;
    Object.defineProperty(request, "onerror", {
      configurable: true,
      set(handler: ((this: IDBRequest, ev: Event) => unknown) | null) {
        queueMicrotask(() => handler?.call(request, new Event("error")));
      },
    });
    Object.defineProperty(IDBObjectStore.prototype, "get", {
      configurable: true,
      value: () => request,
    });

    try {
      await expect(idbGet(STORE_META, "missing")).rejects.toBe(failure);
    } finally {
      if (descriptor) Object.defineProperty(IDBObjectStore.prototype, "get", descriptor);
    }
  });

  test("commits all writes in a completed transaction", async () => {
    await withTransaction([STORE_META], "readwrite", (tx) => {
      tx.objectStore(STORE_META).put("written", "transaction-key");
    });

    expect(await idbGet(STORE_META, "transaction-key")).toBe("written");
  });

  test("preserves a callback error even when the callback already aborted", async () => {
    const failure = new Error("transaction callback failed");

    await expect(
      withTransaction([STORE_META], "readwrite", (tx) => {
        tx.abort();
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  test("rejects and rolls back an asynchronous transaction error", async () => {
    await idbPut(STORE_META, "original", "duplicate-key");

    let failure: unknown;
    try {
      await withTransaction([STORE_META], "readwrite", (tx) => {
        tx.objectStore(STORE_META).add("replacement", "duplicate-key");
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toHaveProperty("name", "ConstraintError");
    expect(await idbGet(STORE_META, "duplicate-key")).toBe("original");
  });
});
