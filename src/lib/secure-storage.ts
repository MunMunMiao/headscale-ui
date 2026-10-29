import {
  bindTransactionAbort,
  openHeadscaleDb,
  STORE_KEYS,
  STORE_META,
  STORE_PROFILES,
} from "./idb";
import { clearSettingsProjection } from "./settings-storage";
import {
  assertVaultVersion,
  newVaultState,
  notifyVaultChanged,
  readVaultState,
  VAULT_STATE_KEY,
  VaultConflictError,
  type VaultVersion,
} from "./vault-state";

const SESSION_STORAGE_PREFIX = "headscale-ui-";
export interface SecureResetResult {
  committed: true;
  sessionMetadataCleared: boolean;
  version: VaultVersion;
}

/** A reset proceeds when the vault record is unreadable, or matches `expected`; `null` means "repair only if unreadable". */
function assertResettable(raw: unknown, expected: VaultVersion | null): void {
  let current: VaultVersion | null = null;
  try {
    current = readVaultState(raw);
  } catch {
    /* An unreadable record is what a repair reset replaces. */
  }
  if (current) {
    if (expected === null) throw new VaultConflictError();
    assertVaultVersion(current, expected);
  }
}

/** Refuses a reset that would fail before any session state is touched; the reset re-checks atomically. */
export async function assertResetExpected(
  expected: VaultVersion | null,
): Promise<void> {
  const db = await openHeadscaleDb();
  assertResettable(await db.get(STORE_META, VAULT_STATE_KEY), expected);
}

/**
 * `undefined` wipes unconditionally (test helpers). Otherwise the vault is wiped when its
 * record is unreadable, or when it matches `expected`; `null` means "repair only if unreadable".
 */
export async function clearAllSecureData(
  expected?: VaultVersion | null,
  signal?: AbortSignal,
): Promise<SecureResetResult> {
  signal?.throwIfAborted();
  const db = await openHeadscaleDb();
  const tx = db.transaction(
    [STORE_PROFILES, STORE_KEYS, STORE_META],
    "readwrite",
  );
  const stopAbort = bindTransactionAbort(tx, signal);
  const version = newVaultState();
  try {
    if (expected !== undefined)
      assertResettable(
        await tx.objectStore(STORE_META).get(VAULT_STATE_KEY),
        expected,
      );
    await tx.objectStore(STORE_PROFILES).clear();
    await tx.objectStore(STORE_KEYS).clear();
    await tx.objectStore(STORE_META).clear();
    await tx.objectStore(STORE_META).put(version, VAULT_STATE_KEY);
    await tx.done;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* Preserve the original transaction error. */
    }
    await tx.done.catch(() => undefined);
    throw error;
  } finally {
    stopAbort();
  }
  clearSettingsProjection(version.keyEpoch);
  notifyVaultChanged(version, true);
  return {
    committed: true,
    sessionMetadataCleared: clearSessionMetadata(),
    version,
  };
}

export function clearSessionMetadata(): boolean {
  try {
    if (typeof sessionStorage === "undefined") return false;
    const keys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(SESSION_STORAGE_PREFIX)) keys.push(key);
    }
    for (const key of keys) sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
