import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test } from "vitest";
import { idbGet, idbPut } from "@/test-utils/storage";
import { decryptProfileKey, encryptProfileKey } from "./api-key-crypto";
import { __resetForTest } from "./idb";
import {
  migrateProfile,
  type PasswordStoredProfile,
  readProfileForOwner,
  VaultConflictError,
} from "./profile-storage";
import { readVaultState, VAULT_STATE_KEY } from "./vault-state";

beforeEach(() => {
  __resetForTest();
  globalThis.indexedDB = new IDBFactory();
});

test.each([
  ["https://headscale.example//", "https://headscale.example"],
  ["https://headscale.example///", "https://headscale.example"],
  [
    " HTTPS://HS.Example.com:443/headscale/// ",
    "https://hs.example.com/headscale",
  ],
])(
  "migration binds historical URL %j to its canonical form",
  async (baseUrl, canonicalUrl) => {
    const version = readVaultState(await idbGet("meta", VAULT_STATE_KEY));
    await idbPut("profiles", {
      id: "legacy",
      name: "Historical server",
      baseUrl,
      apiKey: "historical-fixture-key",
      keyEpoch: version.keyEpoch,
      scope: "persistent",
      updatedAt: "old",
    });

    const result = await migrateProfile({
      expected: {
        version,
        ownerTabId: "owner-a",
        profile: { id: "legacy", credentialVersion: null },
      },
      password: "migration password",
    });
    expect(result.profile.baseUrl).toBe(canonicalUrl);
    expect(result.profile.credentialKind).toBe("password");
    expect(result.profile).not.toHaveProperty("apiKey");
    const saved = await readProfileForOwner("legacy", "owner-a");
    expect.assert(saved?.profile.credentialVersion);
    expect(saved.profile.baseUrl).toBe(canonicalUrl);
    const apiKey = await decryptProfileKey({
      profileId: saved.profile.id,
      canonicalBaseUrl: canonicalUrl,
      credentialVersion: saved.profile.credentialVersion,
      secret: saved.profile.apiKey,
      password: "migration password",
    });
    expect(apiKey === "historical-fixture-key").toBe(true);
  },
);

test("migration never rewrites an existing v2 ciphertext's URL binding", async () => {
  const version = readVaultState(await idbGet("meta", VAULT_STATE_KEY));
  const baseUrl = "HTTPS://Headscale.Example:443/headscale//";
  const profile: PasswordStoredProfile = {
    id: "existing-v2",
    name: "Existing password profile",
    baseUrl,
    keyEpoch: version.keyEpoch,
    scope: "persistent",
    updatedAt: "old",
    credentialVersion: "existing-credential",
    apiKey: await encryptProfileKey({
      profileId: "existing-v2",
      canonicalBaseUrl: baseUrl,
      credentialVersion: "existing-credential",
      apiKey: "existing-fixture-key",
      password: "existing password",
    }),
  };
  await idbPut("profiles", profile);

  await expect(
    migrateProfile({
      expected: {
        version,
        ownerTabId: "owner-a",
        profile: {
          id: profile.id,
          credentialVersion: profile.credentialVersion,
        },
      },
      password: "migration password",
    }),
  ).rejects.toBeInstanceOf(VaultConflictError);
  const saved = await readProfileForOwner(profile.id, "owner-a");
  expect(saved?.profile).toEqual(profile);
  const apiKey = await decryptProfileKey({
    profileId: profile.id,
    canonicalBaseUrl: baseUrl,
    credentialVersion: profile.credentialVersion,
    secret: saved?.profile.apiKey,
    password: "existing password",
  });
  expect(apiKey === "existing-fixture-key").toBe(true);
  expect(readVaultState(await idbGet("meta", VAULT_STATE_KEY))).toEqual(
    version,
  );
});
