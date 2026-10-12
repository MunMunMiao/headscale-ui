/* Password-derived keys protect stored connection credentials. Unlocked sessions remain accessible to same-origin code; this is not XSS isolation. */
import { VaultDataError } from "./vault-state";

export const DEVICE_KEY_ID = "device-key";
export const CANARY_KEY_ID = "password-canary";

const CANARY_PLAINTEXT = "headscale-ui:canary:v1";
const PBKDF2_ITERATIONS = 310_000;
const PBKDF2_HASH = "SHA-256";
const AES_KEY_LENGTH = 256;

export type ApiKeySecret =
  | { v: 1; scheme: "device"; iv: string; ct: string }
  | { v: 1; scheme: "password"; iv: string; ct: string };

export interface PasswordApiKeySecretV2 {
  v: 2;
  scheme: "password";
  algorithm: "AES-GCM-256";
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  iv: string;
  ct: string;
}

export interface ProfileKeyBinding {
  profileId: string;
  canonicalBaseUrl: string;
  credentialVersion: string;
}

export interface EncryptProfileKeyInput extends ProfileKeyBinding {
  apiKey: string;
  password: string;
}

export interface DecryptProfileKeyInput extends ProfileKeyBinding {
  secret: unknown;
  password: string;
}

export class ProfileUnlockError extends Error {
  constructor() {
    super("The saved connection could not be unlocked with that password.");
    this.name = "ProfileUnlockError";
  }
}

export const PROFILE_PBKDF2_ITERATIONS = 600_000;
const MAX_PBKDF2_ITERATIONS = 2_000_000;

function profileBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw new VaultDataError();
  const bytes = base64ToBytes(value);
  if (bytesToBase64(bytes) !== value) throw new VaultDataError();
  return bytes;
}

export function parsePasswordApiKeySecret(value: unknown): PasswordApiKeySecretV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VaultDataError();
  const secret = value as Partial<PasswordApiKeySecretV2>;
  if (
    secret.v !== 2 ||
    secret.scheme !== "password" ||
    secret.algorithm !== "AES-GCM-256" ||
    !secret.kdf ||
    secret.kdf.name !== "PBKDF2" ||
    secret.kdf.hash !== "SHA-256" ||
    !Number.isSafeInteger(secret.kdf.iterations) ||
    secret.kdf.iterations < PROFILE_PBKDF2_ITERATIONS ||
    secret.kdf.iterations > MAX_PBKDF2_ITERATIONS ||
    profileBytes(secret.kdf.salt).length !== 32 ||
    profileBytes(secret.iv).length !== 12 ||
    profileBytes(secret.ct).length < 16
  )
    throw new VaultDataError();
  return secret as PasswordApiKeySecretV2;
}

function profileAdditionalData(binding: ProfileKeyBinding): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify([
      "headscale-ui/profile",
      2,
      binding.profileId,
      binding.canonicalBaseUrl,
      binding.credentialVersion,
    ]),
  );
}

export async function encryptProfileKey(
  input: EncryptProfileKeyInput,
): Promise<PasswordApiKeySecretV2> {
  if (!input.password) throw new ProfileUnlockError();
  if (!input.apiKey.trim()) throw new VaultDataError();
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = await deriveKeyFromPassword(input.password, salt, PROFILE_PBKDF2_ITERATIONS);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: profileAdditionalData(input) },
    key,
    new TextEncoder().encode(input.apiKey.trim()),
  );
  return {
    v: 2,
    scheme: "password",
    algorithm: "AES-GCM-256",
    kdf: {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: PROFILE_PBKDF2_ITERATIONS,
      salt: bytesToBase64(salt),
    },
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(encrypted)),
  };
}

export async function decryptProfileKey(input: DecryptProfileKeyInput): Promise<string> {
  const secret = parsePasswordApiKeySecret(input.secret);
  if (!input.password) throw new ProfileUnlockError();
  const key = await deriveKeyFromPassword(
    input.password,
    profileBytes(secret.kdf.salt),
    secret.kdf.iterations,
  );
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: profileBytes(secret.iv),
        additionalData: profileAdditionalData(input),
      },
      key,
      profileBytes(secret.ct),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new ProfileUnlockError();
  }
}

export function isEncryptedApiKey(value: unknown): value is ApiKeySecret {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === 1 &&
    (v.scheme === "device" || v.scheme === "password") &&
    typeof v.iv === "string" &&
    typeof v.ct === "string"
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(length));
  crypto.getRandomValues(out);
  return out;
}

export async function deriveKeyFromPassword(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: PBKDF2_HASH },
    baseKey,
    { name: "AES-GCM", length: AES_KEY_LENGTH },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function decryptApiKey(secret: ApiKeySecret, key: CryptoKey): Promise<string> {
  const iv = base64ToBytes(secret.iv);
  const ct = base64ToBytes(secret.ct);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(plain);
}

export type CanaryRecord = {
  v: 1;
  iv: string;
  ct: string;
  salt: string;
  iterations: number;
};

export async function verifyCanaryRecord(
  record: CanaryRecord,
  passwordKey: CryptoKey,
): Promise<boolean> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(record.iv) },
      passwordKey,
      base64ToBytes(record.ct),
    );
    return new TextDecoder().decode(plain) === CANARY_PLAINTEXT;
  } catch {
    return false;
  }
}

export function parseCanaryRecord(raw: unknown): CanaryRecord | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object") throw new VaultDataError();
  const value = raw as Partial<CanaryRecord>;
  if (
    value.v !== 1 ||
    typeof value.iv !== "string" ||
    typeof value.ct !== "string" ||
    typeof value.salt !== "string" ||
    typeof value.iterations !== "number" ||
    !Number.isSafeInteger(value.iterations) ||
    value.iterations < 1 ||
    value.iterations > MAX_PBKDF2_ITERATIONS
  ) {
    throw new VaultDataError();
  }
  return value as CanaryRecord;
}

export function canaryKeyParameters(record: CanaryRecord): {
  salt: Uint8Array<ArrayBuffer>;
  iterations: number;
} {
  return {
    salt: base64ToBytes(record.salt),
    iterations: record.iterations,
  };
}
