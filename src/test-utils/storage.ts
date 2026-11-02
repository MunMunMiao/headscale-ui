import type { StoreNames } from "idb";
import { type HeadscaleDb, openHeadscaleDb } from "@/lib/idb";

export async function idbGet<T = unknown>(
  store: StoreNames<HeadscaleDb>,
  key: IDBValidKey,
): Promise<T | undefined> {
  const db = await openHeadscaleDb();
  const get: Function = db.get;
  return Reflect.apply(get, db, [store, key]);
}

export async function idbGetAll<T = unknown>(
  store: StoreNames<HeadscaleDb>,
): Promise<T[]> {
  const db = await openHeadscaleDb();
  const getAll: Function = db.getAll;
  return Reflect.apply(getAll, db, [store]);
}

export async function idbPut(
  store: StoreNames<HeadscaleDb>,
  value: unknown,
  key?: string,
): Promise<void> {
  const db = await openHeadscaleDb();
  const tx = db.transaction(store, "readwrite");
  const target = tx.objectStore(store);
  Reflect.apply(target.put, target, [value, key]);
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
