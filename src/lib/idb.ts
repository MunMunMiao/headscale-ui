import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import { createStore } from "./store";
import { newVaultState, VAULT_STATE_KEY } from "./vault-state";

export const DB_NAME = "headscale-ui";
export const DB_VERSION = 3;
export const STORE_PROFILES = "profiles";
export const STORE_KEYS = "keys";
export const STORE_META = "meta";

// Validate persisted values at their read boundaries, including historical data.
export interface HeadscaleDb extends DBSchema {
  profiles: { key: IDBValidKey; value: unknown };
  keys: { key: string; value: CryptoKey };
  meta: { key: string; value: unknown };
}

let dbPromise: Promise<IDBPDatabase<HeadscaleDb>> | null = null;
let openedDb: IDBPDatabase<HeadscaleDb> | null = null;
let reloadRequired = false;
export type DatabaseStatus =
  "opening" | "ready" | "blocked" | "reload-required";
const status = createStore<{ status: DatabaseStatus }>({ status: "opening" });
export const getDatabaseStatus = () => status.getSnapshot().status;
export const subscribeDatabaseStatus = status.subscribe;

export async function openHeadscaleDb(): Promise<IDBPDatabase<HeadscaleDb>> {
  if (typeof indexedDB === "undefined")
    throw new Error("IndexedDB is not available in this environment");
  if (reloadRequired)
    throw new Error(
      "The local database was upgraded. Reload this page before continuing.",
    );
  if (!dbPromise) {
    status.setState({ status: "opening" });
    let upgradeError: unknown;
    dbPromise = openDB<HeadscaleDb>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, tx) {
        // openDB reports the upgrade failure; consume its parallel transaction promise.
        void tx.done.catch(() => undefined);
        if (!db.objectStoreNames.contains(STORE_PROFILES))
          db.createObjectStore(STORE_PROFILES, { keyPath: "id" });
        if (!db.objectStoreNames.contains(STORE_KEYS))
          db.createObjectStore(STORE_KEYS);
        if (!db.objectStoreNames.contains(STORE_META))
          db.createObjectStore(STORE_META);
        if (oldVersion < 2) {
          const migrate = async () => {
            const version = newVaultState();
            const profiles = tx.objectStore(STORE_PROFILES);
            const meta = tx.objectStore(STORE_META);
            await meta.put(version, VAULT_STATE_KEY);
            const records = await profiles.getAll();
            for (const raw of records) {
              if (
                raw !== null &&
                typeof raw === "object" &&
                !("keyEpoch" in raw)
              ) {
                await profiles.put({ ...raw, keyEpoch: version.keyEpoch });
              }
            }
            const active = await meta.get("active-profile-id");
            if (typeof active === "string") {
              const target = await profiles.get(active);
              if (
                target !== null &&
                typeof target === "object" &&
                "id" in target
              ) {
                const ref = {
                  profileId: active,
                  operationId: crypto.randomUUID(),
                };
                if ("scope" in target && target.scope === "session") {
                  if (
                    "ownerTabId" in target &&
                    typeof target.ownerTabId === "string"
                  ) {
                    await meta.put(ref, `active-profile:${target.ownerTabId}`);
                  }
                  await meta.delete("active-profile-id");
                } else {
                  await meta.put(ref, "active-profile-id");
                }
              } else {
                await meta.delete("active-profile-id");
              }
            }
          };
          void migrate().catch((error: unknown) => {
            upgradeError = error;
            try {
              tx.abort();
            } catch {
              /* An external abort may already have finished the transaction. */
            }
          });
        }
      },
      blocking() {
        reloadRequired = true;
        openedDb?.close();
        openedDb = null;
        dbPromise = null;
        status.setState({ status: "reload-required" });
      },
      blocked() {
        status.setState({ status: "blocked" });
      },
      terminated() {
        openedDb = null;
        dbPromise = null;
      },
    })
      .then((db) => {
        openedDb = db;
        status.setState({ status: "ready" });
        return db;
      })
      .catch((error: unknown) => {
        // A failed open is no longer blocked; reload-required is never overwritten.
        if (status.getSnapshot().status === "blocked")
          status.setState({ status: "opening" });
        dbPromise = null;
        throw upgradeError ?? error;
      });
  }
  return dbPromise;
}

/** Existing test isolation boundary; production connections close on versionchange. */
export function __resetForTest(): void {
  openedDb?.close();
  openedDb = null;
  dbPromise = null;
  reloadRequired = false;
  status.setState({ status: "opening" });
}
export function bindTransactionAbort(
  transaction: { abort(): void },
  signal?: AbortSignal,
): () => void {
  const abort = () => {
    try {
      transaction.abort();
    } catch {
      // A completed transaction cannot be rolled back by a later cancellation.
    }
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return () => signal?.removeEventListener("abort", abort);
}
