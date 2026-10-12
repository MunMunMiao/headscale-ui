import type { StoreNames } from "idb";
import { type HeadscaleDb, openHeadscaleDb } from "@/lib/idb";

export async function idbGet<T = unknown>(
  store: StoreNames<HeadscaleDb>,
  key: IDBValidKey,
): Promise<T | undefined> {
  const db = await openHeadscaleDb();
  return (await db.get(store, key as string)) as T | undefined;
}

export async function idbGetAll<T = unknown>(store: StoreNames<HeadscaleDb>): Promise<T[]> {
  const db = await openHeadscaleDb();
  return (await db.getAll(store)) as T[];
}

export async function idbPut(
  store: StoreNames<HeadscaleDb>,
  value: unknown,
  key?: string,
): Promise<void> {
  const db = await openHeadscaleDb();
  const tx = db.transaction(store, "readwrite");
  if (store === "keys") await tx.objectStore("keys").put(value as CryptoKey, key);
  else if (store === "meta") await tx.objectStore("meta").put(value, key);
  else await tx.objectStore("profiles").put(value);
  await tx.done;
}

export async function idbDelete(store: StoreNames<HeadscaleDb>, key: string): Promise<void> {
  const db = await openHeadscaleDb();
  await db.delete(store, key);
}

export async function idbClear(store: StoreNames<HeadscaleDb>): Promise<void> {
  const db = await openHeadscaleDb();
  await db.clear(store);
}
