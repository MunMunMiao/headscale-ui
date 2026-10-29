import { canonicalBaseUrl } from "@/api/connection";
import { normalizedBaseUrl } from "../utils/strings";
import {
  type ApiKeySecret,
  CANARY_KEY_ID,
  DEVICE_KEY_ID,
  encryptProfileKey,
  isEncryptedApiKey,
  normalizeNewProfilePassword,
  openProfileKey,
  type PasswordApiKeySecretV2,
  parsePasswordApiKeySecret,
} from "./api-key-crypto";
import {
  bindTransactionAbort,
  openHeadscaleDb,
  STORE_KEYS,
  STORE_META,
  STORE_PROFILES,
} from "./idb";
import { readLegacyProfileKey } from "./legacy-profile-crypto";
import {
  advanceVaultState,
  assertVaultVersion,
  notifyVaultChanged,
  readVaultState,
  VAULT_STATE_KEY,
  VaultConflictError,
  VaultDataError,
  type VaultVersion,
} from "./vault-state";

export type { VaultVersion } from "./vault-state";
export {
  VaultConflictError,
  VaultDataError,
  VaultLockedError,
} from "./vault-state";
export type ProfileStorageScope = "persistent" | "session";
interface StoredProfileFields {
  id: string;
  name: string;
  baseUrl: string;
  keyEpoch: string;
  updatedAt: string;
  scope: ProfileStorageScope;
  ownerTabId?: string;
}
export interface PasswordStoredProfile extends StoredProfileFields {
  apiKey: PasswordApiKeySecretV2;
  credentialVersion: string;
}
export interface LegacyStoredProfile extends StoredProfileFields {
  apiKey: ApiKeySecret | string;
  credentialVersion?: string;
}
export type StoredProfile = PasswordStoredProfile | LegacyStoredProfile;
export interface ProfileSummary extends StoredProfileFields {
  credentialVersion: string | null;
  credentialKind:
    | "password"
    | "legacy-device"
    | "legacy-password"
    | "legacy-plaintext"
    | "unreadable";
}
export interface ProfileWriteExpected {
  version: VaultVersion;
  ownerTabId: string;
  profile: { id: string; credentialVersion: string | null } | null;
}
export interface StoredProfileCommit {
  profile: ProfileSummary;
  version: VaultVersion;
}
export interface ProfileList {
  profiles: ProfileSummary[];
  version: VaultVersion;
  unreadableRecords: number;
}
export interface MigrateProfileInput {
  expected: ProfileWriteExpected;
  password: string;
  legacyPassword?: string;
}
export interface ChangeProfilePasswordInput {
  expected: ProfileWriteExpected;
  password: string;
  newPassword: string;
}

export async function updateProfileMetadata(
  expected: ProfileWriteExpected,
  patch: { name: string; scope: ProfileStorageScope },
  signal?: AbortSignal,
): Promise<StoredProfileCommit> {
  signal?.throwIfAborted();
  const reference = expected.profile;
  if (!reference) throw new VaultConflictError();
  const read = await readProfileForOwner(reference.id, expected.ownerTabId);
  if (!read) throw new VaultConflictError();
  assertVaultVersion(read.version, expected.version);
  assertProfileExpectation(read.profile, reference.id, expected);
  return persistProfile(
    expected,
    {
      ...read.profile,
      name: patch.name.trim() || read.profile.baseUrl,
      scope: patch.scope,
      updatedAt: new Date().toISOString(),
    },
    signal,
  );
}

export async function deleteStoredProfile(
  expected: ProfileWriteExpected,
  signal?: AbortSignal,
): Promise<{ version: VaultVersion; profileId: string }> {
  signal?.throwIfAborted();
  const reference = expected.profile;
  if (!reference) throw new VaultConflictError();
  const db = await openHeadscaleDb();
  const tx = db.transaction(
    [STORE_PROFILES, STORE_META, STORE_KEYS],
    "readwrite",
  );
  const stopAbort = bindTransactionAbort(tx, signal);
  let version: VaultVersion;
  try {
    const profiles = tx.objectStore(STORE_PROFILES);
    const meta = tx.objectStore(STORE_META);
    const current = readVaultState(await meta.get(VAULT_STATE_KEY));
    assertVaultVersion(current, expected.version);
    assertProfileExpectation(
      await profiles.get(reference.id),
      reference.id,
      expected,
    );
    await profiles.delete(reference.id);
    for (const key of await meta.getAllKeys()) {
      if (
        (key === ACTIVE_PROFILE_META_KEY ||
          key.startsWith(ACTIVE_PROFILE_PREFIX)) &&
        activeRef(await meta.get(key))?.profileId === reference.id
      )
        await meta.delete(key);
    }
    if (canRetireLegacyRecords(await profiles.getAll(), current)) {
      await tx.objectStore(STORE_KEYS).delete(DEVICE_KEY_ID);
      await meta.delete(CANARY_KEY_ID);
    }
    version = advanceVaultState(current);
    await meta.put(version, VAULT_STATE_KEY);
    await tx.done;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* The failed transaction may already be finished. */
    }
    await tx.done.catch(() => undefined);
    throw error;
  } finally {
    stopAbort();
  }
  notifyVaultChanged(version);
  return { version, profileId: reference.id };
}

export async function changeProfilePassword(
  input: ChangeProfilePasswordInput,
  signal?: AbortSignal,
): Promise<StoredProfileCommit> {
  signal?.throwIfAborted();
  const reference = input.expected.profile;
  if (!reference) throw new VaultConflictError();
  const read = await readProfileForOwner(
    reference.id,
    input.expected.ownerTabId,
  );
  if (!read) throw new VaultConflictError();
  assertVaultVersion(read.version, input.expected.version);
  assertProfileExpectation(read.profile, reference.id, input.expected);
  const profile = read.profile;
  if (
    profileSummary(profile, read.version).credentialKind !== "password" ||
    !profile.credentialVersion
  )
    throw new VaultDataError();
  const newPassword = normalizeNewProfilePassword(input.newPassword);
  const { apiKey } = await openProfileKey(
    {
      profileId: profile.id,
      canonicalBaseUrl: profile.baseUrl,
      credentialVersion: profile.credentialVersion,
      secret: profile.apiKey,
      password: input.password,
    },
    signal,
  );
  const credentialVersion = crypto.randomUUID();
  const secret = await encryptProfileKey({
    profileId: profile.id,
    canonicalBaseUrl: profile.baseUrl,
    credentialVersion,
    apiKey,
    password: newPassword,
  });
  return commitProfile(
    input.expected,
    {
      ...profile,
      apiKey: secret,
      credentialVersion,
      updatedAt: new Date().toISOString(),
    },
    signal,
  );
}

function visibleToOwner(
  value: Record<string, unknown>,
  ownerTabId: string,
): boolean {
  return value.scope !== "session" || value.ownerTabId === ownerTabId;
}

function profileSummary(raw: unknown, version: VaultVersion): ProfileSummary {
  const value = recordObject(raw);
  if (typeof value.id !== "string" || !value.id) throw new VaultDataError();
  const fields: StoredProfileFields = {
    id: value.id,
    name: typeof value.name === "string" ? value.name : value.id,
    baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : "",
    keyEpoch: typeof value.keyEpoch === "string" ? value.keyEpoch : "",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
    scope: value.scope === "session" ? "session" : "persistent",
  };
  if (typeof value.ownerTabId === "string")
    fields.ownerTabId = value.ownerTabId;
  let credentialKind: ProfileSummary["credentialKind"] = "unreadable";
  const credentialVersion = storedCredentialVersion(value);
  if (
    fields.baseUrl &&
    fields.keyEpoch === version.keyEpoch &&
    (value.scope === undefined ||
      value.scope === "persistent" ||
      value.scope === "session") &&
    (fields.scope !== "session" || fields.ownerTabId)
  ) {
    if (typeof value.apiKey === "string") credentialKind = "legacy-plaintext";
    else if (isEncryptedApiKey(value.apiKey))
      credentialKind =
        value.apiKey.scheme === "device" ? "legacy-device" : "legacy-password";
    else if (credentialVersion) {
      try {
        parsePasswordApiKeySecret(value.apiKey);
        credentialKind = "password";
      } catch {
        /* Keep malformed rows visible without interpreting them as usable credentials. */
      }
    }
  }
  return { ...fields, credentialVersion, credentialKind };
}

/** Summaries and write expectations read a missing or malformed version the same way. */
function storedCredentialVersion(
  value: Record<string, unknown>,
): string | null {
  return typeof value.credentialVersion === "string" && value.credentialVersion
    ? value.credentialVersion
    : null;
}

function storedProfile(raw: unknown, version: VaultVersion): StoredProfile {
  const summary = profileSummary(raw, version);
  if (summary.credentialKind === "unreadable") throw new VaultDataError();
  const { credentialKind: _kind, credentialVersion, ...fields } = summary;
  return {
    ...recordObject(raw),
    ...fields,
    ...(credentialVersion === null ? {} : { credentialVersion }),
  } as StoredProfile;
}

export async function listProfileSummaries(
  ownerTabId: string,
): Promise<ProfileList> {
  const db = await openHeadscaleDb();
  const tx = db.transaction([STORE_PROFILES, STORE_META], "readonly");
  const [records, rawVersion] = await Promise.all([
    tx.objectStore(STORE_PROFILES).getAll(),
    tx.objectStore(STORE_META).get(VAULT_STATE_KEY),
    tx.done,
  ]);
  const version = readVaultState(rawVersion);
  const profiles: ProfileSummary[] = [];
  let unreadableRecords = 0;
  for (const raw of records) {
    try {
      if (!visibleToOwner(recordObject(raw), ownerTabId)) continue;
      const summary = profileSummary(raw, version);
      profiles.push(summary);
      if (summary.credentialKind === "unreadable") unreadableRecords++;
    } catch {
      unreadableRecords++;
    }
  }
  return { profiles, version, unreadableRecords };
}

export async function readProfileForOwner(
  id: string,
  ownerTabId: string,
): Promise<{ profile: StoredProfile; version: VaultVersion } | null> {
  const db = await openHeadscaleDb();
  const tx = db.transaction([STORE_PROFILES, STORE_META], "readonly");
  const [raw, rawVersion] = await Promise.all([
    tx.objectStore(STORE_PROFILES).get(id),
    tx.objectStore(STORE_META).get(VAULT_STATE_KEY),
    tx.done,
  ]);
  if (raw === undefined || !visibleToOwner(recordObject(raw), ownerTabId))
    return null;
  const version = readVaultState(rawVersion);
  return { profile: storedProfile(raw, version), version };
}

function assertProfileExpectation(
  raw: unknown,
  id: string,
  expected: ProfileWriteExpected,
): void {
  if (expected.profile === null) {
    if (raw !== undefined) throw new VaultConflictError();
    return;
  }
  if (raw === undefined || expected.profile.id !== id)
    throw new VaultConflictError();
  const value = recordObject(raw);
  if (
    !visibleToOwner(value, expected.ownerTabId) ||
    storedCredentialVersion(value) !== expected.profile.credentialVersion
  )
    throw new VaultConflictError();
}

function canRetireLegacyRecords(
  records: unknown[],
  version: VaultVersion,
): boolean {
  return records.every((raw) => {
    try {
      return profileSummary(raw, version).credentialKind === "password";
    } catch {
      return false;
    }
  });
}

export async function commitProfile(
  expected: ProfileWriteExpected,
  next: PasswordStoredProfile,
  signal?: AbortSignal,
): Promise<StoredProfileCommit> {
  signal?.throwIfAborted();
  if (next.keyEpoch !== expected.version.keyEpoch)
    throw new VaultConflictError();
  const summary = profileSummary(next, expected.version);
  if (
    summary.credentialKind !== "password" ||
    !next.credentialVersion ||
    next.baseUrl !== normalizedBaseUrl(next.baseUrl)
  )
    throw new VaultDataError();
  return persistProfile(expected, next, signal);
}

async function persistProfile(
  expected: ProfileWriteExpected,
  next: StoredProfile,
  signal?: AbortSignal,
): Promise<StoredProfileCommit> {
  signal?.throwIfAborted();
  const db = await openHeadscaleDb();
  const tx = db.transaction(
    [STORE_PROFILES, STORE_META, STORE_KEYS],
    "readwrite",
  );
  const stopAbort = bindTransactionAbort(tx, signal);
  let version: VaultVersion;
  let saved: StoredProfile;
  try {
    const meta = tx.objectStore(STORE_META);
    const profiles = tx.objectStore(STORE_PROFILES);
    const current = readVaultState(await meta.get(VAULT_STATE_KEY));
    assertVaultVersion(current, expected.version);
    const previous = await profiles.get(next.id);
    assertProfileExpectation(previous, next.id, expected);
    saved = {
      ...(previous === undefined ? {} : recordObject(previous)),
      ...next,
    };
    if (saved.scope === "session") saved.ownerTabId = expected.ownerTabId;
    if ("corrupted" in saved) delete saved.corrupted;
    await profiles.put(saved);
    if (canRetireLegacyRecords(await profiles.getAll(), current)) {
      await tx.objectStore(STORE_KEYS).delete(DEVICE_KEY_ID);
      await meta.delete(CANARY_KEY_ID);
    }
    version = advanceVaultState(current);
    await meta.put(version, VAULT_STATE_KEY);
    await tx.done;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* The failed transaction may already be finished. */
    }
    await tx.done.catch(() => undefined);
    throw error;
  } finally {
    stopAbort();
  }
  notifyVaultChanged(version);
  return { profile: profileSummary(saved, version), version };
}

export async function migrateProfile(
  input: MigrateProfileInput,
  signal?: AbortSignal,
): Promise<StoredProfileCommit> {
  signal?.throwIfAborted();
  const reference = input.expected.profile;
  if (!reference) throw new VaultConflictError();
  const db = await openHeadscaleDb();
  const tx = db.transaction(
    [STORE_PROFILES, STORE_META, STORE_KEYS],
    "readonly",
  );
  const [raw, rawVersion, deviceKey, canary] = await Promise.all([
    tx.objectStore(STORE_PROFILES).get(reference.id),
    tx.objectStore(STORE_META).get(VAULT_STATE_KEY),
    tx.objectStore(STORE_KEYS).get(DEVICE_KEY_ID),
    tx.objectStore(STORE_META).get(CANARY_KEY_ID),
    tx.done,
  ]);
  const version = readVaultState(rawVersion);
  assertVaultVersion(version, input.expected.version);
  assertProfileExpectation(raw, reference.id, input.expected);
  const profile = storedProfile(raw, version);
  if (profileSummary(profile, version).credentialKind === "password")
    throw new VaultConflictError();
  const password = normalizeNewProfilePassword(input.password);
  const apiKey = await readLegacyProfileKey(
    {
      secret: profile.apiKey,
      deviceKey,
      canary,
      password: input.legacyPassword,
    },
    signal,
  );
  const credentialVersion = crypto.randomUUID();
  const baseUrl = canonicalBaseUrl(profile.baseUrl);
  const secret = await encryptProfileKey({
    profileId: profile.id,
    canonicalBaseUrl: baseUrl,
    credentialVersion,
    apiKey,
    password,
  });
  return commitProfile(
    input.expected,
    {
      ...profile,
      baseUrl,
      apiKey: secret,
      credentialVersion,
      updatedAt: new Date().toISOString(),
    },
    signal,
  );
}

const ACTIVE_PROFILE_META_KEY = "active-profile-id";
const ACTIVE_PROFILE_PREFIX = "active-profile:";
function recordObject(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new VaultDataError();
  return raw as Record<string, unknown>;
}
function activeRef(
  raw: unknown,
): { profileId: string; operationId: string } | null {
  if (raw === null || typeof raw !== "object") return null;
  const value = raw as { profileId?: unknown; operationId?: unknown };
  return typeof value.profileId === "string" &&
    typeof value.operationId === "string"
    ? { profileId: value.profileId, operationId: value.operationId }
    : null;
}
