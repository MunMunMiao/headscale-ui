import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { prepareApplication, resetUnreadableVault } from "./bootstrap";
import * as theme from "./composables/useTheme";
import * as runtime from "./i18n/runtime";
import { __resetForTest, DB_VERSION } from "./lib/idb";
import * as settings from "./lib/settings-storage";
import {
  readSetting,
  settingsStorageTestingHandle,
} from "./lib/settings-storage";
import {
  newVaultState,
  VAULT_STATE_KEY,
  VaultDataError,
} from "./lib/vault-state";
import { createSessionBridge } from "./session/bridge";
import * as connector from "./session/connect";
import { createSessionHost } from "./session/host";
import { startSnapshotServer } from "./test-utils/headscale.test";
import { idbDelete, idbGet, idbGetAll, idbPut } from "./test-utils/storage";

const cleanup: (() => void | Promise<void>)[] = [];
beforeEach(() => {
  __resetForTest();
  runtime.i18n.activate("en-US");
  settingsStorageTestingHandle.reset();
  globalThis.indexedDB = new IDBFactory();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const stop of cleanup.reverse().splice(0)) await stop();
  vi.restoreAllMocks();
});
async function installHost(storageVersion = DB_VERSION) {
  const host = await createSessionHost("bootstrap-test");
  cleanup.push(() => host.dispose());
  function page(owner: string) {
    const bridge = createSessionBridge({
      openPort() {
        const channel = new MessageChannel();
        host.connect(channel.port2);
        cleanup.push(() => {
          channel.port1.close();
          channel.port2.close();
        });
        return channel.port1;
      },
      ownerTabId: () => owner,
      buildId: "bootstrap-test",
      storageVersion,
    });
    cleanup.push(() => bridge.dispose());
    return bridge;
  }
  return page;
}
async function installBridge(storageVersion = DB_VERSION) {
  const bridge = (await installHost(storageVersion))("owner-a");
  vi.spyOn(connector, "createBrowserSessionBridge").mockReturnValue(bridge);
  return bridge;
}
test("bootstrap never creates a decrypting key or rewrites legacy credentials", async () => {
  const bridge = await installBridge();
  const legacy = {
    id: "legacy",
    name: "Legacy",
    baseUrl: "https://example.test",
    apiKey: "legacy-key",
    scope: "persistent",
    updatedAt: "2026-10-11T00:00:00Z",
  };
  await idbPut("profiles", legacy);
  await prepareApplication();
  expect(await idbGetAll("keys")).toEqual([]);
  expect(await idbGetAll("profiles")).toEqual([legacy]);
  expect(bridge.getSnapshot().status).toBe("ready-locked");
});
test("bootstrap waits for the Worker hello and returns only the summary view", async () => {
  const bridge = await installBridge();
  const ready = await prepareApplication();
  expect(ready).toEqual({
    bridge,
    profiles: expect.objectContaining({ profiles: [], unreadableRecords: 0 }),
  });
  expect(JSON.stringify(ready)).not.toContain("deviceKey");
});

test("bootstrap rejects an incompatible Worker handshake instead of mounting an empty application", async () => {
  const bridge = await installBridge(DB_VERSION - 1);
  const dispose = vi.spyOn(bridge, "dispose");
  await expect(prepareApplication()).rejects.toMatchObject({
    name: "ApiError",
    kind: "reload-required",
  });
  expect(dispose).toHaveBeenCalledTimes(1);
});

test("bootstrap rejects a failed Worker profile read instead of presenting an empty profile list", async () => {
  const bridge = await installBridge();
  const dispose = vi.spyOn(bridge, "dispose");
  const nativeRead = IDBObjectStore.prototype.getAll;
  vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (
    this: IDBObjectStore,
    ...args: Parameters<IDBObjectStore["getAll"]>
  ) {
    if (this.name === "profiles")
      throw new DOMException("profile read failed", "UnknownError");
    return nativeRead.apply(this, args);
  });
  await expect(prepareApplication()).rejects.toMatchObject({
    name: "ApiError",
    kind: "storage-failed",
  });
  expect(dispose).toHaveBeenCalledTimes(1);
});

test("waits for the persisted language before completing bootstrap without rewriting preferences", async () => {
  await installBridge();
  await idbPut("meta", { locale: "ar" }, "ui-settings");
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const load = runtime.loadLocale;
  vi.spyOn(runtime, "loadLocale").mockImplementation(async (locale) => {
    started.resolve();
    await release.promise;
    await load(locale);
  });
  const write = vi.spyOn(settings, "writeSetting");
  let finished = false;
  const ready = prepareApplication().then((value) => {
    finished = true;
    return value;
  });
  await started.promise;
  expect(finished).toBe(false);
  release.resolve();
  await ready;
  expect(runtime.i18n.locale).toBe("ar");
  expect(readSetting("locale")).toBe("ar");
  expect(write).not.toHaveBeenCalled();
});

test("still prepares a usable English application when a persisted language catalog fails", async () => {
  await installBridge();
  await idbPut("meta", { locale: "ar" }, "ui-settings");
  vi.spyOn(runtime, "loadLocale").mockRejectedValue(
    new Error("catalog unavailable"),
  );
  const ready = await prepareApplication();
  expect(ready.bridge.getSnapshot().status).toBe("ready-locked");
  expect(runtime.i18n.locale).toBe("en-US");
  expect(readSetting("locale")).toBe("ar");
});

test("reads the latest Worker profile summaries after a delayed locale load", async () => {
  await installBridge();
  await idbPut("meta", { locale: "ar" }, "ui-settings");
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const load = runtime.loadLocale;
  vi.spyOn(runtime, "loadLocale").mockImplementation(async (locale) => {
    started.resolve();
    await release.promise;
    await load(locale);
  });
  const preparing = prepareApplication();
  await started.promise;
  const remoteVersion = newVaultState();
  await idbPut("meta", remoteVersion, VAULT_STATE_KEY);
  await idbPut("profiles", {
    id: "remote",
    name: "Added during startup",
    baseUrl: "https://remote.test",
    apiKey: "legacy",
    scope: "persistent",
    updatedAt: "2026-10-11T00:00:00Z",
  });
  release.resolve();
  const ready = await preparing;
  expect(ready.profiles?.version).toEqual(remoteVersion);
  expect(ready.profiles?.profiles.map((profile) => profile.name)).toEqual([
    "Added during startup",
  ]);
  expect(ready.bridge.getSnapshot().status).toBe("ready-locked");
});

test("bootstrap applies the stored theme right after hydration and before the Worker connects", async () => {
  const bridge = await installBridge();
  const order: string[] = [];
  const hydrate = settings.hydrateSettings;
  vi.spyOn(settings, "hydrateSettings").mockImplementation(async () => {
    await hydrate();
    order.push("hydrate");
  });
  vi.spyOn(theme, "applyStoredTheme").mockImplementation(
    () => void order.push("theme"),
  );
  const connect = bridge.connect.bind(bridge);
  vi.spyOn(bridge, "connect").mockImplementation(async (...args) => {
    order.push("connect");
    return connect(...args);
  });
  await prepareApplication();
  expect(order).toEqual(["hydrate", "theme", "connect"]);
});

async function unreadableVaultFixture() {
  const page = await installHost();
  const observer = page("owner-observer");
  expect((await observer.connect()).ok).toBe(true);
  const server = startSnapshotServer();
  cleanup.push(server.stop);
  const list = await observer.listProfiles();
  if (!list.ok) throw new Error("profile list failed");
  const saved = await observer.saveProfile({
    kind: "credentials",
    expected: {
      version: list.value.version,
      ownerTabId: "owner-observer",
      profile: null,
    },
    profile: {
      id: "server-a",
      name: "Server A",
      baseUrl: server.baseUrl,
      scope: "persistent",
    },
    apiKey: "only-worker-connection-key",
    password: "server-a-password",
    validation: "required",
    activate: true,
    expectedWorkerId: observer.getSnapshot().workerId ?? "",
    expectedIdentity: null,
  });
  expect(saved).toMatchObject({
    ok: true,
    value: { activation: { ok: true } },
  });
  expect(observer.getSessionSnapshot()?.status).toBe("unlocked");
  await idbDelete("meta", VAULT_STATE_KEY);
  return { page, observer };
}

test("an unreadable vault-state stops bootstrap, then resets through the shared Worker and locks the session", async () => {
  const { page, observer } = await unreadableVaultFixture();
  vi.spyOn(connector, "createBrowserSessionBridge").mockImplementation(() =>
    page("owner-reset"),
  );
  await expect(prepareApplication()).rejects.toBeInstanceOf(VaultDataError);
  vi.stubGlobal("sessionStorage", {
    length: 0,
    key: () => null,
    removeItem: () => {},
  });
  expect(await resetUnreadableVault()).toBe(true);
  expect(await idbGetAll("profiles")).toEqual([]);
  expect(await idbGetAll("keys")).toEqual([]);
  expect(await idbGet("meta", VAULT_STATE_KEY)).toEqual(
    expect.objectContaining({ keyEpoch: expect.any(String) }),
  );
  await expect.poll(() => observer.getSessionSnapshot()?.status).toBe("locked");
  settingsStorageTestingHandle.reset();
  await expect(prepareApplication()).resolves.toMatchObject({
    profiles: expect.objectContaining({ profiles: [] }),
  });
});

test("resetUnreadableVault reports a failed Worker connect and disposes the bridge", async () => {
  const bridge = await installBridge(DB_VERSION - 1);
  const dispose = vi.spyOn(bridge, "dispose");
  await expect(resetUnreadableVault()).rejects.toMatchObject({
    name: "ApiError",
    kind: "reload-required",
  });
  expect(dispose).toHaveBeenCalledTimes(1);
});

test("resetUnreadableVault refuses a readable vault and disposes the bridge", async () => {
  const bridge = await installBridge();
  const dispose = vi.spyOn(bridge, "dispose");
  await expect(resetUnreadableVault()).rejects.toMatchObject({
    name: "ApiError",
    kind: "storage-conflict",
  });
  expect(dispose).toHaveBeenCalledTimes(1);
});

test("resetUnreadableVault returns false when the committed reset could not clear session metadata", async () => {
  const { page } = await unreadableVaultFixture();
  vi.spyOn(connector, "createBrowserSessionBridge").mockImplementation(() =>
    page("owner-reset"),
  );
  expect(typeof sessionStorage).toBe("undefined");
  expect(await resetUnreadableVault()).toBe(false);
});

test("a fresh Worker connects and resets even though the vault-state record is already gone", async () => {
  await idbPut("meta", { locale: "en-US" }, "ui-settings");
  await idbDelete("meta", VAULT_STATE_KEY);
  await installBridge();
  vi.stubGlobal("sessionStorage", {
    length: 0,
    key: () => null,
    removeItem: () => {},
  });
  expect(await resetUnreadableVault()).toBe(true);
  expect(await idbGet("meta", "ui-settings")).toBeUndefined();
  expect(await idbGet("meta", VAULT_STATE_KEY)).toBeDefined();
});
