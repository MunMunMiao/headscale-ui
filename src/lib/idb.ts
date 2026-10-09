/**
 * IndexedDB Promise wrapper for the headscale-ui DB.
 *
 * Internal: only profile-storage / api-key-crypto / secure-storage may import this module.
 * Application code must go through profile-storage's API.
 */

export const DB_NAME = "headscale-ui";
export const DB_VERSION = 1;
export const STORE_PROFILES = "profiles";
export const STORE_KEYS = "keys";
export const STORE_META = "meta";

let dbPromise: Promise<IDBDatabase> | null = null;
let openedDb: IDBDatabase | null = null;

export function openHeadscaleDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is not available in this environment"));
  }
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_PROFILES)) {
          db.createObjectStore(STORE_PROFILES, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_KEYS)) {
          db.createObjectStore(STORE_KEYS);
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META);
        }
      };
      req.onsuccess = () => {
        openedDb = req.result;
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openHeadscaleDb();
  const tx = db.transaction(store, "readonly");
  return reqToPromise(tx.objectStore(store).get(key) as IDBRequest<T | undefined>);
}

export async function idbPut(store: string, value: unknown, key?: IDBValidKey): Promise<void> {
  const db = await openHeadscaleDb();
  const tx = db.transaction(store, "readwrite");
  await reqToPromise(
    key !== undefined ? tx.objectStore(store).put(value, key) : tx.objectStore(store).put(value),
  );
}

export async function idbDelete(store: string, key: IDBValidKey): Promise<void> {
  const db = await openHeadscaleDb();
  const tx = db.transaction(store, "readwrite");
  await reqToPromise(tx.objectStore(store).delete(key));
}

export async function idbGetAll<T>(store: string): Promise<T[]> {
  const db = await openHeadscaleDb();
  const tx = db.transaction(store, "readonly");
  return reqToPromise(tx.objectStore(store).getAll() as IDBRequest<T[]>);
}

export async function idbClear(store: string): Promise<void> {
  const db = await openHeadscaleDb();
  const tx = db.transaction(store, "readwrite");
  await reqToPromise(tx.objectStore(store).clear());
}

/**
 * Run a callback inside a single transaction across the given stores. Any synchronous
 * put/delete requests dispatched by `fn` are part of the same atomic transaction.
 * Used by reencryptAll to ensure all profiles flip schemes (and the canary updates) in one go.
 */
export async function withTransaction(
  stores: string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => void,
): Promise<void> {
  const db = await openHeadscaleDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IDB transaction aborted"));
    try {
      fn(tx);
    } catch (err) {
      try {
        tx.abort();
      } catch {
        // already failed; ignore
      }
      reject(err);
    }
  });
}

/**
 * Test only: close the live db connection and drop the cached promise so the next
 * call reopens against the current indexedDB. Closing is required before
 * `indexedDB.deleteDatabase` will succeed without `onblocked`.
 */
export function __resetForTest(): void {
  if (openedDb) {
    openedDb.close();
    openedDb = null;
  }
  dbPromise = null;
}
