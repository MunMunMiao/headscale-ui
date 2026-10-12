import { openHeadscaleDb, STORE_META } from "./idb";
import { readVaultState, VAULT_STATE_KEY, VaultConflictError } from "./vault-state";

const SETTINGS_META_KEY = "ui-settings";
type SettingsRecord = Record<string, string>;
const cache = { values: {} as SettingsRecord, hydrated: false, keyEpoch: "" };

function ensureHydrated(): void {
  if (!cache.hydrated)
    throw new Error(
      "settings-storage accessed before hydrateSettings(); call hydrateSettings() in main.ts first",
    );
}
function settingsRecord(raw: unknown): SettingsRecord {
  const values: SettingsRecord = {};
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw))
      if (typeof value === "string") values[key] = value;
  }
  return values;
}
export async function hydrateSettings(): Promise<void> {
  const db = await openHeadscaleDb();
  const tx = db.transaction(STORE_META, "readonly");
  const [rawVersion, rawValues] = await Promise.all([
    tx.store.get(VAULT_STATE_KEY),
    tx.store.get(SETTINGS_META_KEY),
    tx.done,
  ]);
  const version = readVaultState(rawVersion);
  const values = settingsRecord(rawValues);
  cache.values = values;
  cache.keyEpoch = version.keyEpoch;
  cache.hydrated = true;
}
export function isSettingsHydrated(): boolean {
  return cache.hydrated;
}
export function readSetting(key: string): string | null {
  ensureHydrated();
  return cache.values[key] ?? null;
}
export function captureSettingsWriteEpoch(): string {
  ensureHydrated();
  return cache.keyEpoch;
}
export function clearSettingsProjection(keyEpoch: string): void {
  cache.values = {};
  cache.keyEpoch = keyEpoch;
  cache.hydrated = true;
}
export async function writeSetting(
  key: string,
  value: string,
  expectedKeyEpoch: string,
): Promise<void> {
  ensureHydrated();
  const db = await openHeadscaleDb();
  const tx = db.transaction(STORE_META, "readwrite");
  try {
    const version = readVaultState(await tx.store.get(VAULT_STATE_KEY));
    if (version.keyEpoch !== expectedKeyEpoch) throw new VaultConflictError();
    const values = settingsRecord(await tx.store.get(SETTINGS_META_KEY));
    values[key] = value;
    await tx.store.put(values, SETTINGS_META_KEY);
    await tx.done;
    cache.values = values;
    cache.keyEpoch = version.keyEpoch;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* Preserve the request or validation failure. */
    }
    await tx.done.catch(() => undefined);
    throw error;
  }
}
export const settingsStorageTestingHandle = {
  reset() {
    cache.values = {};
    cache.hydrated = false;
    cache.keyEpoch = "";
  },
};
