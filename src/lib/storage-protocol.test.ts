import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { idbGet, idbPut } from "@/test-utils/storage";
import { encryptProfileKey } from "./api-key-crypto";
import { __resetForTest, DB_NAME, openHeadscaleDb, STORE_PROFILES } from "./idb";
import {
  commitProfile,
  listProfileSummaries,
  readProfileForOwner,
  updateProfileMetadata,
} from "./profile-storage";
import { clearAllSecureData } from "./secure-storage";
import {
  captureSettingsWriteEpoch,
  hydrateSettings,
  readSetting,
  settingsStorageTestingHandle,
  writeSetting,
} from "./settings-storage";

beforeEach(() => {
  __resetForTest();
  globalThis.indexedDB = new IDBFactory();
  settingsStorageTestingHandle.reset();
});
afterEach(() => vi.restoreAllMocks());
async function setupProfile(scope: "persistent" | "session" = "persistent") {
  const ownerTabId = "owner-a";
  const { version } = await listProfileSummaries(ownerTabId);
  const profile = {
    id: "profile",
    name: "Original",
    baseUrl: "https://headscale.example",
    keyEpoch: version.keyEpoch,
    credentialVersion: "credential-a",
    scope,
    ownerTabId,
    updatedAt: "2026-10-11T00:00:00Z",
    apiKey: await encryptProfileKey({
      profileId: "profile",
      canonicalBaseUrl: "https://headscale.example",
      credentialVersion: "credential-a",
      password: "password-a",
      apiKey: "key-a",
    }),
  };
  const committed = await commitProfile({ version, ownerTabId, profile: null }, profile);
  return {
    profile,
    expected: {
      ownerTabId,
      version: committed.version,
      profile: { id: profile.id, credentialVersion: profile.credentialVersion },
    },
  };
}

test("a profile save reports an abort after request success and preserves the old committed row", async () => {
  const { profile, expected } = await setupProfile();
  const original = IDBObjectStore.prototype.put;
  let injected = 0;
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    const request = original.apply(this, args);
    if (this.name === STORE_PROFILES)
      request.addEventListener(
        "success",
        () => {
          ++injected;
          this.transaction.abort();
        },
        { once: true },
      );
    return request;
  });
  await expect(
    updateProfileMetadata(expected, { name: "Changed", scope: "persistent" }),
  ).rejects.toThrow();
  expect(injected).toBe(1);
  expect((await readProfileForOwner(profile.id, "owner-a"))?.profile.name).toBe("Original");
  expect(await idbGet("profiles", profile.id)).toMatchObject({
    name: "Original",
    apiKey: profile.apiKey,
  });
});

test("another owner's read never removes an existing session profile", async () => {
  const { profile } = await setupProfile("session");
  expect((await listProfileSummaries("owner-b")).profiles).toEqual([]);
  expect(await idbGet("profiles", profile.id)).toMatchObject({
    ownerTabId: "owner-a",
    apiKey: profile.apiKey,
  });
});

test("a stale profile revision cannot overwrite a newer committed profile", async () => {
  const { profile, expected } = await setupProfile();
  await updateProfileMetadata(expected, { name: "Newer", scope: "persistent" });
  await expect(
    updateProfileMetadata(expected, { name: "Stale", scope: "persistent" }),
  ).rejects.toThrow("changed");
  expect(await idbGet("profiles", profile.id)).toMatchObject({
    name: "Newer",
    apiKey: profile.apiKey,
  });
});

test("reset fences old profile and preference writes with its committed new epoch", async () => {
  const { expected } = await setupProfile();
  await hydrateSettings();
  const oldEpoch = captureSettingsWriteEpoch();
  await writeSetting("locale", "fr-FR", oldEpoch);
  await clearAllSecureData();
  expect((await listProfileSummaries("owner-a")).profiles).toEqual([]);
  expect(readSetting("locale")).toBeNull();
  expect(captureSettingsWriteEpoch()).not.toBe(oldEpoch);
  await expect(
    updateProfileMetadata(expected, { name: "Stale", scope: "persistent" }),
  ).rejects.toThrow();
  await expect(writeSetting("locale", "fr-FR", oldEpoch)).rejects.toThrow();
});

test("an upgraded vault fences out old version-one writers while preserving their records", async () => {
  const old = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("profiles", { keyPath: "id" });
      request.result.createObjectStore("keys");
      request.result.createObjectStore("meta");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const write = old.transaction("profiles", "readwrite");
  write.objectStore("profiles").put({ id: "legacy", opaque: { keep: true } });
  await new Promise<void>((resolve, reject) => {
    write.oncomplete = () => resolve();
    write.onerror = () => reject(write.error);
  });
  old.close();
  await openHeadscaleDb();
  expect(await idbGet("profiles", "legacy")).toMatchObject({
    id: "legacy",
    opaque: { keep: true },
    keyEpoch: expect.any(String),
  });
  const result = await new Promise<string>((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onsuccess = () => {
      request.result.close();
      resolve("opened");
    };
    request.onerror = () => resolve(request.error?.name ?? "unknown");
  });
  expect(result).toBe("VersionError");
});

test("startup and read-only listing preserve missing legacy keys and unreadable records", async () => {
  const raw = {
    id: "legacy",
    name: "Legacy",
    baseUrl: "https://legacy.example",
    scope: "persistent",
    updatedAt: "old",
    apiKey: { v: 1, scheme: "device", iv: "", ct: "" },
  };
  await idbPut("profiles", raw);
  await listProfileSummaries("owner-a");
  expect(await idbGet("keys", "device-key")).toBeUndefined();
  expect(await idbGet("profiles", "legacy")).toEqual(raw);
});
