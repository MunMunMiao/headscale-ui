import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createSessionHost } from "@/session/host";
import { idbGet, idbGetAll, idbPut } from "@/test-utils/storage";
import { CANARY_KEY_ID, DEVICE_KEY_ID } from "./api-key-crypto";
import { __resetForTest } from "./idb";
import { VAULT_STATE_KEY, type VaultState } from "./vault-state";

const hosts: Awaited<ReturnType<typeof createSessionHost>>[] = [];
beforeEach(() => {
  __resetForTest();
  globalThis.indexedDB = new IDBFactory();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const host of hosts.splice(0)) await host.dispose();
});
async function start() {
  const host = await createSessionHost("legacy-demo-test");
  hosts.push(host);
  return host;
}
async function seed() {
  const rows = [
    { id: "demo", baseUrl: " http://127.0.0.1:8080/ ", mode: "mock" },
    {
      id: "owner-demo",
      baseUrl: "http://127.0.0.1:8080",
      mode: "mock",
      scope: "session",
      ownerTabId: "other-owner",
    },
    {
      id: "real",
      baseUrl: "http://127.0.0.1:8080",
      mode: "real",
      apiKey: "legacy-real-token",
      opaque: { preserved: true },
    },
    { id: "remote", baseUrl: "https://remote.test", mode: "mock", apiKey: { unsupported: true } },
    { id: "different-url", baseUrl: "http://127.0.0.1:8080//", mode: "mock" },
    {
      id: "foreign",
      baseUrl: "https://foreign.test",
      mode: "real",
      scope: "session",
      ownerTabId: "other-owner",
    },
    { id: 7, baseUrl: "http://127.0.0.1:8080", mode: "mock" },
    { id: "unknown-shape", baseUrl: 7, mode: "mock" },
  ];
  for (const row of rows) await idbPut("profiles", row);
  await idbPut("meta", { profileId: "demo", operationId: "demo-global" }, "active-profile-id");
  await idbPut(
    "meta",
    { profileId: "owner-demo", operationId: "demo-owner" },
    "active-profile:other-owner",
  );
  await idbPut(
    "meta",
    { profileId: "real", operationId: "real-owner" },
    "active-profile:real-owner",
  );
  await idbPut("meta", { profileId: "demo", unknown: true }, "active-profile:malformed");
  await idbPut("meta", { locale: "ar", theme: "dark" }, "ui-settings");
  await idbPut("meta", { preserved: "legacy-canary" }, CANARY_KEY_ID);
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  await idbPut("keys", key, DEVICE_KEY_ID);
  const version = await idbGet<VaultState>("meta", VAULT_STATE_KEY);
  expect.assert(version);
  return { rows, version };
}

test("Worker startup deletes only the exact retired local demos and their valid active references", async () => {
  const { rows, version } = await seed();
  await start();
  expect(await idbGetAll("profiles")).toEqual(expect.arrayContaining(rows.slice(2)));
  expect(await idbGetAll("profiles")).toHaveLength(rows.length - 2);
  expect(await idbGet("profiles", "demo")).toBeUndefined();
  expect(await idbGet("profiles", "owner-demo")).toBeUndefined();
  expect(await idbGet("meta", "active-profile-id")).toBeUndefined();
  expect(await idbGet("meta", "active-profile:other-owner")).toBeUndefined();
  expect(await idbGet("meta", "active-profile:real-owner")).toEqual({
    profileId: "real",
    operationId: "real-owner",
  });
  expect(await idbGet("meta", "active-profile:malformed")).toEqual({
    profileId: "demo",
    unknown: true,
  });
  expect(await idbGet("meta", "ui-settings")).toEqual({ locale: "ar", theme: "dark" });
  expect(await idbGet("meta", CANARY_KEY_ID)).toEqual({ preserved: "legacy-canary" });
  expect(await idbGetAll("keys")).toHaveLength(1);
  expect(await idbGet("meta", VAULT_STATE_KEY)).toEqual({
    ...version,
    profilesRevision: version.profilesRevision + 1,
  });
  await start();
  expect(await idbGet("meta", VAULT_STATE_KEY)).toEqual({
    ...version,
    profilesRevision: version.profilesRevision + 1,
  });
});

test("a successful delete request followed by abort preserves all legacy data and fails startup", async () => {
  const { rows, version } = await seed();
  const original = IDBObjectStore.prototype.delete;
  let injected = 0;
  vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function (
    this: IDBObjectStore,
    ...args: Parameters<IDBObjectStore["delete"]>
  ) {
    const request = original.apply(this, args);
    if (this.name === "profiles" && !injected) {
      injected++;
      request.addEventListener("success", () => this.transaction.abort(), { once: true });
    }
    return request;
  });
  await expect(start()).rejects.toThrow();
  expect(injected).toBe(1);
  expect(await idbGetAll("profiles")).toEqual(expect.arrayContaining(rows));
  expect(await idbGetAll("profiles")).toHaveLength(rows.length);
  expect(await idbGet("meta", VAULT_STATE_KEY)).toEqual(version);
  expect(await idbGet("meta", "active-profile-id")).toEqual({
    profileId: "demo",
    operationId: "demo-global",
  });
  expect(await idbGet("meta", CANARY_KEY_ID)).toEqual({ preserved: "legacy-canary" });
  expect(await idbGetAll("keys")).toHaveLength(1);
});

test("a competing writer makes startup cleanup reject its stale revision without deleting the new real profile", async () => {
  const { rows, version } = await seed();
  const original = IDBDatabase.prototype.transaction;
  let injected = 0;
  vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
    this: IDBDatabase,
    ...args: Parameters<IDBDatabase["transaction"]>
  ) {
    const names = typeof args[0] === "string" ? [args[0]] : [...args[0]];
    if (args[1] === "readwrite" && names.includes("profiles") && !injected) {
      injected++;
      const concurrent = original.call(this, ["profiles", "meta"], "readwrite");
      concurrent.objectStore("profiles").put({ ...rows[0], mode: "real" });
      concurrent
        .objectStore("meta")
        .put({ ...version, profilesRevision: version.profilesRevision + 1 }, VAULT_STATE_KEY);
    }
    return original.apply(this, args);
  });
  await expect(start()).rejects.toThrow("changed");
  expect(injected).toBe(1);
  expect(await idbGet("profiles", "demo")).toEqual({ ...rows[0], mode: "real" });
  expect(await idbGet("profiles", "owner-demo")).toEqual(rows[1]);
  expect(await idbGet("meta", "active-profile-id")).toEqual({
    profileId: "demo",
    operationId: "demo-global",
  });
});
