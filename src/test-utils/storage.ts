import type { StoreNames } from "idb";
import { type HeadscaleDb, openHeadscaleDb } from "@/lib/idb";
import { testDouble } from "@/test/dom";

export async function idbGet<T = unknown>(
  store: StoreNames<HeadscaleDb>,
  key: IDBValidKey,
): Promise<T | undefined> {
  const db = await openHeadscaleDb();
  const get: (...args: never[]) => Promise<unknown> = Reflect.get(db, "get");
  return testDouble<T | undefined>(Reflect.apply(get, db, [store, key]));
}

export async function idbGetAll<T = unknown>(
  store: StoreNames<HeadscaleDb>,
): Promise<T[]> {
  const db = await openHeadscaleDb();
  const getAll: (...args: never[]) => Promise<unknown> = Reflect.get(
    db,
    "getAll",
  );
  return testDouble<T[]>(Reflect.apply(getAll, db, [store]));
}

export async function idbPut(
  store: StoreNames<HeadscaleDb>,
  value: unknown,
  key?: string,
): Promise<void> {
  const db = await openHeadscaleDb();
  const tx = db.transaction(store, "readwrite");
  const target = tx.objectStore(store);
  void target.put(value, key);
  await tx.done;
}

export async function idbDelete(
  store: StoreNames<HeadscaleDb>,
  key: string,
): Promise<void> {
  const db = await openHeadscaleDb();
  await db.delete(store, key);
}

export async function idbClear(store: StoreNames<HeadscaleDb>): Promise<void> {
  const db = await openHeadscaleDb();
  await db.clear(store);
}
