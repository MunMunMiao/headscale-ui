import { describe, expect, test, vi } from "vitest";
import { ProfileUnlockError } from "./api-key-crypto";
import { readLegacyProfileKey } from "./legacy-profile-crypto";
import { VaultDataError } from "./vault-state";

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

async function encryptLegacy(
  plain: string,
  key: CryptoKey,
  scheme: "device" | "password",
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plain),
  );
  return {
    v: 1 as const,
    scheme,
    iv: base64(iv),
    ct: base64(new Uint8Array(ciphertext)),
  };
}

async function passwordFixture(
  password = " old password ",
  canaryPlaintext = "headscale-ui:canary:v1",
) {
  const salt = new Uint8Array(32).fill(19);
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", iterations: 310000, salt },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const canarySecret = await encryptLegacy(canaryPlaintext, key, "password");
  return {
    secret: await encryptLegacy("legacy-password-token", key, "password"),
    canary: {
      v: 1,
      iv: canarySecret.iv,
      ct: canarySecret.ct,
      salt: base64(salt),
      iterations: 310000,
    },
  };
}

describe("legacy profile migration reader", () => {
  test("reads historical plaintext without creating or rewriting a device key", async () => {
    const generate = vi.spyOn(crypto.subtle, "generateKey");
    try {
      await expect(
        readLegacyProfileKey({ secret: "historical-plaintext-token" }),
      ).resolves.toBe("historical-plaintext-token");
      expect(generate).not.toHaveBeenCalled();
    } finally {
      generate.mockRestore();
    }
  });

  test("reads a device-encrypted record using only its supplied persisted key", async () => {
    const deviceKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const secret = await encryptLegacy(
      "legacy-device-token",
      deviceKey,
      "device",
    );
    await expect(readLegacyProfileKey({ secret, deviceKey })).resolves.toBe(
      "legacy-device-token",
    );
    await expect(readLegacyProfileKey({ secret })).rejects.toBeInstanceOf(
      VaultDataError,
    );
    const wrongKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    await expect(
      readLegacyProfileKey({ secret, deviceKey: wrongKey }),
    ).rejects.toBeInstanceOf(ProfileUnlockError);
  });

  test("uses the recorded 310000 derivation cost and preserves password whitespace", async () => {
    const fixture = await passwordFixture();
    const original = JSON.stringify(fixture);
    await expect(
      readLegacyProfileKey({ ...fixture, password: "old password" }),
    ).rejects.toBeInstanceOf(ProfileUnlockError);
    await expect(
      readLegacyProfileKey({ ...fixture, password: " old password " }),
    ).resolves.toBe("legacy-password-token");
    expect(JSON.stringify(fixture)).toBe(original);
  });

  test("tries the trimmed legacy password only after the raw candidate fails", async () => {
    const fixture = await passwordFixture("old password");
    const original = structuredClone(fixture);
    const derive = vi.spyOn(crypto.subtle, "deriveKey");
    try {
      await expect(
        readLegacyProfileKey({ ...fixture, password: " \told password\n " }),
      ).resolves.toBe("legacy-password-token");
      expect(derive).toHaveBeenCalledTimes(2);
      expect(fixture).toEqual(original);
    } finally {
      derive.mockRestore();
    }
  });

  test.each(["short", "        "])(
    "keeps the exact historical password %j usable",
    async (password) => {
      const fixture = await passwordFixture(password);
      const derive = vi.spyOn(crypto.subtle, "deriveKey");
      try {
        await expect(
          readLegacyProfileKey({ ...fixture, password }),
        ).resolves.toBe("legacy-password-token");
        expect(derive).toHaveBeenCalledTimes(1);
      } finally {
        derive.mockRestore();
      }
    },
  );

  test.each([
    [1, "NotSupportedError"],
    [2, "InvalidAccessError"],
  ] as const)(
    "propagates non-authentication canary failure at candidate %i (%s)",
    async (boundary, name) => {
      const fixture = await passwordFixture("old password");
      const before = structuredClone(fixture);
      const failure = new DOMException("Canary decryption unavailable", name);
      const nativeDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
      let attempts = 0;
      const derive = vi.spyOn(crypto.subtle, "deriveKey");
      const decrypt = vi
        .spyOn(crypto.subtle, "decrypt")
        .mockImplementation((...args) => {
          if (++attempts >= boundary) return Promise.reject(failure);
          return nativeDecrypt(...args);
        });
      try {
        await expect(
          readLegacyProfileKey({ ...fixture, password: " old password " }),
        ).rejects.toBe(failure);
        expect(derive).toHaveBeenCalledTimes(boundary);
        expect(fixture).toEqual(before);
      } finally {
        decrypt.mockRestore();
        derive.mockRestore();
      }
    },
  );

  test("an authenticated unexpected canary plaintext does not start a normalized candidate", async () => {
    const fixture = await passwordFixture(
      " old password ",
      "not the legacy canary",
    );
    const derive = vi.spyOn(crypto.subtle, "deriveKey");
    try {
      await expect(
        readLegacyProfileKey({ ...fixture, password: " old password " }),
      ).rejects.toBeInstanceOf(ProfileUnlockError);
      expect(derive).toHaveBeenCalledTimes(1);
    } finally {
      derive.mockRestore();
    }
  });

  test("cancellation after a failed legacy candidate prevents the normalized attempt", async () => {
    const fixture = await passwordFixture("old password");
    const controller = new AbortController();
    const nativeDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    const derive = vi.spyOn(crypto.subtle, "deriveKey");
    const decrypt = vi
      .spyOn(crypto.subtle, "decrypt")
      .mockImplementationOnce(async (...args) => {
        try {
          return await nativeDecrypt(...args);
        } finally {
          controller.abort();
        }
      });
    try {
      await expect(
        readLegacyProfileKey(
          { ...fixture, password: " old password " },
          controller.signal,
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(derive).toHaveBeenCalledTimes(1);
    } finally {
      decrypt.mockRestore();
      derive.mockRestore();
    }
  });

  test.each([
    ["an iv of the wrong length", 8, 16],
    ["a ciphertext shorter than the authentication tag", 12, 8],
  ])(
    "refuses %s before attempting to decrypt",
    async (_name, ivLength, ctLength) => {
      const deviceKey = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
      const secret = {
        v: 1 as const,
        scheme: "device" as const,
        iv: base64(new Uint8Array(ivLength)),
        ct: base64(new Uint8Array(ctLength)),
      };
      await expect(
        readLegacyProfileKey({ secret, deviceKey }),
      ).rejects.toBeInstanceOf(VaultDataError);
    },
  );

  test("reports missing or malformed legacy materials without inventing replacements", async () => {
    const fixture = await passwordFixture();
    for (const secret of [
      null,
      {},
      { v: 2, scheme: "password" },
      { v: 1, scheme: "device", iv: "%%%", ct: "AA==" },
    ]) {
      await expect(readLegacyProfileKey({ secret })).rejects.toBeInstanceOf(
        VaultDataError,
      );
    }
    await expect(
      readLegacyProfileKey({
        secret: fixture.secret,
        password: " old password ",
      }),
    ).rejects.toBeInstanceOf(VaultDataError);
    await expect(readLegacyProfileKey({ ...fixture })).rejects.toBeInstanceOf(
      ProfileUnlockError,
    );
    await expect(
      readLegacyProfileKey({
        ...fixture,
        canary: { ...fixture.canary, iterations: 0 },
        password: " old password ",
      }),
    ).rejects.toBeInstanceOf(VaultDataError);
    const derive = vi
      .spyOn(crypto.subtle, "deriveKey")
      .mockRejectedValue(new Error("must not run"));
    try {
      await expect(
        readLegacyProfileKey({
          ...fixture,
          canary: { ...fixture.canary, iterations: 9e15 },
          password: " old password ",
        }),
      ).rejects.toBeInstanceOf(VaultDataError);
      expect(derive).not.toHaveBeenCalled();
    } finally {
      derive.mockRestore();
    }
    for (const salt of ["", "%%%"])
      await expect(
        readLegacyProfileKey({
          ...fixture,
          canary: { ...fixture.canary, salt },
          password: " old password ",
        }),
      ).rejects.toBeInstanceOf(VaultDataError);
  });
});
