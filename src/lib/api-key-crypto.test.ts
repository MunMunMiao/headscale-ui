import { encryptLegacyKey, legacySalt, makeLegacyCanary } from "@/test-utils/legacy-vault";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  canaryKeyParameters,
  decryptProfileKey,
  deriveKeyFromPassword,
  encryptProfileKey,
  isEncryptedApiKey,
  ProfileUnlockError,
  parseCanaryRecord,
  parsePasswordApiKeySecret,
  verifyCanaryRecord,
} from "./api-key-crypto";
import { __resetForTest } from "./idb";
import { VaultDataError } from "./vault-state";

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  __resetForTest();
});

describe("isEncryptedApiKey", () => {
  test("rejects strings, null, undefined, primitives", () => {
    expect(isEncryptedApiKey("plaintext")).toBe(false);
    expect(isEncryptedApiKey(null)).toBe(false);
    expect(isEncryptedApiKey(undefined)).toBe(false);
    expect(isEncryptedApiKey(42)).toBe(false);
  });

  test("accepts well-formed device and password secrets", () => {
    expect(isEncryptedApiKey({ v: 1, scheme: "device", iv: "x", ct: "y" })).toBe(true);
    expect(isEncryptedApiKey({ v: 1, scheme: "password", iv: "x", ct: "y" })).toBe(true);
  });

  test("rejects malformed objects", () => {
    expect(isEncryptedApiKey({ scheme: "device", iv: "x", ct: "y" })).toBe(false);
    expect(isEncryptedApiKey({ v: 2, scheme: "device", iv: "x", ct: "y" })).toBe(false);
    expect(isEncryptedApiKey({ v: 1, scheme: "bogus", iv: "x", ct: "y" })).toBe(false);
    expect(isEncryptedApiKey({ v: 1, scheme: "device", iv: 1, ct: "y" })).toBe(false);
  });
});

describe("canary", () => {
  test("prepares and verifies a canary without publishing it", async () => {
    const salt = legacySalt();
    const key = await deriveKeyFromPassword("secret", salt, 10000);
    const record = await makeLegacyCanary(key, salt, 10000);
    expect(parseCanaryRecord(record)).toEqual(record);
    expect(await verifyCanaryRecord(record, key)).toBe(true);
    const parameters = canaryKeyParameters(record);
    expect(parameters.salt).toEqual(salt);
    expect(parameters.iterations).toBe(10000);
    const wrong = await deriveKeyFromPassword("wrong", salt, 10000);
    expect(await verifyCanaryRecord(record, wrong)).toBe(false);
    const encrypted = await encryptLegacyKey("other plaintext", key, "password");
    expect(await verifyCanaryRecord({ ...record, iv: encrypted.iv, ct: encrypted.ct }, key)).toBe(
      false,
    );
  });
  test("validates persisted metadata rather than treating malformed data as disabled", () => {
    expect(parseCanaryRecord(undefined)).toBeNull();
    expect(parseCanaryRecord(null)).toBeNull();
    for (const value of [
      true,
      {},
      { v: 1, salt: "x", iterations: 0, iv: "x", ct: "x" },
      { v: 2, salt: "x", iterations: 1, iv: "x", ct: "x" },
    ]) {
      expect(() => parseCanaryRecord(value)).toThrow();
    }
  });
  test("bounds the stored iteration count to what the legacy app could have written", () => {
    const base = { v: 1, salt: "x", iv: "x", ct: "x" };
    for (const iterations of [2_000_001, 9e15, Number.MAX_SAFE_INTEGER, "310000", Number.NaN])
      expect(() => parseCanaryRecord({ ...base, iterations })).toThrow(VaultDataError);
    for (const iterations of [1, 310_000, 2_000_000])
      expect(parseCanaryRecord({ ...base, iterations })?.iterations).toBe(iterations);
  });
});

const profileBinding = {
  profileId: "profile-a",
  canonicalBaseUrl: "https://headscale.example/api",
  credentialVersion: "credential-a",
};

function fixtureBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fixtureBytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function nativeProfileFixture(password: string) {
  const salt = new Uint8Array(32).fill(23);
  const iv = new Uint8Array(12).fill(47);
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", iterations: 600000, salt },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(
        JSON.stringify([
          "headscale-ui/profile",
          2,
          profileBinding.profileId,
          profileBinding.canonicalBaseUrl,
          profileBinding.credentialVersion,
        ]),
      ),
    },
    key,
    new TextEncoder().encode("fixture-api-key"),
  );
  return {
    v: 2 as const,
    scheme: "password" as const,
    algorithm: "AES-GCM-256" as const,
    kdf: {
      name: "PBKDF2" as const,
      hash: "SHA-256" as const,
      iterations: 600000,
      salt: fixtureBase64(salt),
    },
    iv: fixtureBase64(iv),
    ct: fixtureBase64(new Uint8Array(ciphertext)),
  };
}

describe("independent profile password envelopes", () => {
  test("uses independent salts and IVs and interoperates with native Web Crypto", async () => {
    const input = {
      ...profileBinding,
      apiKey: " fixture-api-key ",
      password: " profile password ",
    };
    const first = await encryptProfileKey(input);
    const second = await encryptProfileKey(input);
    expect(first.kdf).toMatchObject({ name: "PBKDF2", hash: "SHA-256", iterations: 600000 });
    expect(first.kdf.salt).not.toBe(second.kdf.salt);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ct).not.toBe(second.ct);
    expect(fixtureBytes(first.kdf.salt)).toHaveLength(32);
    expect(fixtureBytes(first.iv)).toHaveLength(12);
    for (const secret of [first, second]) {
      const material = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(input.password),
        "PBKDF2",
        false,
        ["deriveKey"],
      );
      const key = await crypto.subtle.deriveKey(
        {
          name: "PBKDF2",
          hash: "SHA-256",
          iterations: 600000,
          salt: fixtureBytes(secret.kdf.salt),
        },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["decrypt"],
      );
      const plain = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: fixtureBytes(secret.iv),
          additionalData: new TextEncoder().encode(
            JSON.stringify([
              "headscale-ui/profile",
              2,
              input.profileId,
              input.canonicalBaseUrl,
              input.credentialVersion,
            ]),
          ),
        },
        key,
        fixtureBytes(secret.ct),
      );
      expect(new TextDecoder().decode(plain)).toBe("fixture-api-key");
      expect(await decryptProfileKey({ ...profileBinding, secret, password: input.password })).toBe(
        "fixture-api-key",
      );
    }
  });

  test("rejects a wrong password without changing an independently encrypted record", async () => {
    const secret = await nativeProfileFixture(" password with spaces ");
    const original = JSON.stringify(secret);
    await expect(
      decryptProfileKey({ ...profileBinding, secret, password: "password with spaces" }),
    ).rejects.toBeInstanceOf(ProfileUnlockError);
    expect(JSON.stringify(secret)).toBe(original);
    expect(
      await decryptProfileKey({ ...profileBinding, secret, password: " password with spaces " }),
    ).toBe("fixture-api-key");
    expect(JSON.stringify(secret)).toBe(original);
  });

  test.each([
    { profileId: "profile-b" },
    { canonicalBaseUrl: "https://other.example/api" },
    { credentialVersion: "credential-b" },
  ])("rejects ciphertext rebound to another identity: %o", async (change) => {
    const secret = await nativeProfileFixture("password");
    await expect(
      decryptProfileKey({ ...profileBinding, ...change, secret, password: "password" }),
    ).rejects.toBeInstanceOf(ProfileUnlockError);
  });

  test("rejects malformed metadata before spending time deriving a password", async () => {
    const valid = await nativeProfileFixture("password");
    const derive = vi.spyOn(crypto.subtle, "deriveKey");
    const invalid = [
      null,
      [],
      {},
      { ...valid, v: 1 },
      { ...valid, scheme: "device" },
      { ...valid, algorithm: "AES-CBC" },
      { ...valid, kdf: null },
      { ...valid, kdf: { ...valid.kdf, name: "scrypt" } },
      { ...valid, kdf: { ...valid.kdf, hash: "SHA-1" } },
      ...[599999, 2000001, 600000.5, Infinity, "600000"].map((iterations) => ({
        ...valid,
        kdf: { ...valid.kdf, iterations },
      })),
      { ...valid, kdf: { ...valid.kdf, salt: "%%%" } },
      { ...valid, kdf: { ...valid.kdf, salt: "AA==" } },
      { ...valid, iv: "AA==" },
      { ...valid, iv: "not base64" },
      { ...valid, ct: "AA==" },
      { ...valid, ct: "%%%" },
      // Valid alphabet and padding, but the unused trailing bits are not zero.
      { ...valid, ct: `${"A".repeat(20)}AB==` },
    ];
    try {
      for (const secret of invalid) {
        await expect(
          decryptProfileKey({ ...profileBinding, secret, password: "password" }),
        ).rejects.toBeInstanceOf(VaultDataError);
      }
      expect(derive).not.toHaveBeenCalled();
      expect(parsePasswordApiKeySecret(valid)).toEqual(valid);
      expect(
        parsePasswordApiKeySecret({ ...valid, kdf: { ...valid.kdf, iterations: 2000000 } }),
      ).toMatchObject({ kdf: { iterations: 2000000 } });
    } finally {
      derive.mockRestore();
    }
  });

  test("refuses an empty unlock password before deriving a key", async () => {
    const secret = await nativeProfileFixture("password");
    const derive = vi.spyOn(crypto.subtle, "deriveKey");
    try {
      await expect(
        decryptProfileKey({ ...profileBinding, secret, password: "" }),
      ).rejects.toBeInstanceOf(ProfileUnlockError);
      expect(derive).not.toHaveBeenCalled();
    } finally {
      derive.mockRestore();
    }
  });

  test("refuses an empty password without persisting device material", async () => {
    const open = vi.spyOn(indexedDB, "open");
    try {
      await expect(
        encryptProfileKey({ ...profileBinding, apiKey: "fixture-api-key", password: "" }),
      ).rejects.toBeInstanceOf(ProfileUnlockError);
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });

  test("refuses an empty API key before deriving or publishing an envelope", async () => {
    const derive = vi.spyOn(crypto.subtle, "deriveKey");
    try {
      await expect(
        encryptProfileKey({ ...profileBinding, apiKey: " \t\n ", password: "password" }),
      ).rejects.toBeInstanceOf(VaultDataError);
      expect(derive).not.toHaveBeenCalled();
    } finally {
      derive.mockRestore();
    }
  });
});
