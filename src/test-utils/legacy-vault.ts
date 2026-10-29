import type { ApiKeySecret, CanaryRecord } from "@/lib/api-key-crypto";
import { openHeadscaleDb } from "@/lib/idb";

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
export const legacySalt = () => crypto.getRandomValues(new Uint8Array(32));

export async function seedLegacyDeviceKey(): Promise<CryptoKey> {
  const db = await openHeadscaleDb();
  const existing = await db.get("keys", "device-key");
  if (existing) return existing;
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  await db.put("keys", key, "device-key");
  return key;
}

export async function encryptLegacyKey(
  plain: string,
  key: CryptoKey,
  scheme: "device" | "password",
): Promise<ApiKeySecret> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plain),
  );
  return {
    v: 1,
    scheme,
    iv: base64(iv),
    ct: base64(new Uint8Array(ciphertext)),
  };
}

export async function makeLegacyCanary(
  key: CryptoKey,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CanaryRecord> {
  const secret = await encryptLegacyKey(
    "headscale-ui:canary:v1",
    key,
    "password",
  );
  return { v: 1, iv: secret.iv, ct: secret.ct, salt: base64(salt), iterations };
}
