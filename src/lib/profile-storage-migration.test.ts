import { clearHeadscaleDatabase } from "@/test/clear-headscale-database";
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

beforeEach(async () => {
  __resetForTest();
  await clearHeadscaleDatabase();
});

test.each([
  ["device", undefined],
  ["password", "legacy-version"],
] as const)(
  "reads a legacy encrypted %s credential",
  async (scheme, credentialVersion) => {
    const version = readVaultState(await idbGet("meta", VAULT_STATE_KEY));
    const secret = { v: 1, scheme, iv: "old-iv", ct: "old-cipher" };
    await idbPut("profiles", {
      id: `legacy-${scheme}`,
      name: "Legacy encrypted",
      baseUrl: `https://${scheme}.example`,
      apiKey: secret,
      keyEpoch: version.keyEpoch,
      scope: "persistent",
      updatedAt: "old",
      ...(credentialVersion === undefined ? {} : { credentialVersion }),
    });
    const saved = await readProfileForOwner(`legacy-${scheme}`, "owner-a");
    expect(saved?.profile.apiKey).toEqual(secret);
    expect(saved?.profile.credentialVersion).toBe(credentialVersion);
  },
);

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
