export const VAULT_STATE_KEY = "vault-state";

export interface VaultVersion {
  keyEpoch: string;
  profilesRevision: number;
}

export interface VaultState extends VaultVersion {
  v: 1;
}

export interface VaultChange extends VaultVersion {
  reset: boolean;
}
const changes = new EventTarget();
let channel: BroadcastChannel | null = null;
let subscribers = 0;

function broadcastChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  try {
    channel ??= new BroadcastChannel("headscale-ui-vault");
  } catch {
    return null;
  } // Visibility refresh and transaction CAS remain authoritative.
  return channel;
}

/** Notifications are hints. Consumers re-read IndexedDB before adopting state. */
export function subscribeVaultChanges(listener: (change: VaultChange) => void): () => void {
  let stopped = false;
  const handle = (event: Event) => listener((event as CustomEvent<VaultChange>).detail);
  changes.addEventListener("change", handle);
  const connection = broadcastChannel();
  if (connection && subscribers++ === 0)
    connection.onmessage = (event: MessageEvent<unknown>) => {
      const value = event.data;
      if (
        !value ||
        typeof value !== "object" ||
        !("reset" in value) ||
        typeof value.reset !== "boolean"
      )
        return;
      try {
        const version = readVaultState({ ...value, v: 1 });
        changes.dispatchEvent(
          new CustomEvent("change", {
            detail: {
              keyEpoch: version.keyEpoch,
              profilesRevision: version.profilesRevision,
              reset: value.reset,
            },
          }),
        );
      } catch {
        /* A malformed hint cannot change persistent state. */
      }
    };
  return () => {
    if (stopped) return;
    stopped = true;
    changes.removeEventListener("change", handle);
    if (connection && --subscribers === 0) {
      connection.close();
      channel = null;
    }
  };
}

export function notifyVaultChanged(version: VaultVersion, reset = false): void {
  const change: VaultChange = {
    keyEpoch: version.keyEpoch,
    profilesRevision: version.profilesRevision,
    reset,
  };
  changes.dispatchEvent(new CustomEvent("change", { detail: change }));
  const connection = broadcastChannel();
  try {
    connection?.postMessage(change);
  } catch {
    /* Missing a hint is safe: readers refresh on visibility and writers use CAS. */
  }
  if (connection && subscribers === 0) {
    connection.close();
    channel = null;
  }
}

export class VaultConflictError extends Error {
  constructor() {
    super(
      "Saved connections changed in another operation. Reload and retry; unlock again if the password changed.",
    );
    this.name = "VaultConflictError";
  }
}

export class VaultLockedError extends Error {
  constructor() {
    super("Unlock the saved connections before continuing.");
    this.name = "VaultLockedError";
  }
}

export class VaultDataError extends Error {
  constructor() {
    super("Some saved connection data cannot be read. Existing data has been preserved.");
    this.name = "VaultDataError";
  }
}

export function readVaultState(value: unknown): VaultState {
  if (value === null || typeof value !== "object") throw new VaultDataError();
  const state = value as Partial<VaultState>;
  const revision = state.profilesRevision;
  if (
    state.v !== 1 ||
    typeof state.keyEpoch !== "string" ||
    !state.keyEpoch ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) {
    throw new VaultDataError();
  }
  return state as VaultState;
}

export function assertVaultVersion(actual: VaultVersion, expected: VaultVersion): void {
  if (
    actual.keyEpoch !== expected.keyEpoch ||
    actual.profilesRevision !== expected.profilesRevision
  ) {
    throw new VaultConflictError();
  }
}

export function newVaultState(): VaultState {
  return { v: 1, keyEpoch: crypto.randomUUID(), profilesRevision: 0 };
}

export function advanceVaultState(current: VaultVersion, keyEpoch = current.keyEpoch): VaultState {
  if (current.profilesRevision === Number.MAX_SAFE_INTEGER) throw new VaultDataError();
  return { v: 1, keyEpoch, profilesRevision: current.profilesRevision + 1 };
}
