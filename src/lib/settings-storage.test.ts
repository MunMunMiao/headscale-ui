import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test, vi } from "vitest";
import { idbGet, idbPut } from "@/test-utils/storage";
import { __resetForTest } from "./idb";
import { clearAllSecureData } from "./secure-storage";
import {
  captureSettingsWriteEpoch,
  hydrateSettings,
  isSettingsHydrated,
  readSetting,
  settingsStorageTestingHandle,
  writeSetting,
} from "./settings-storage";

beforeEach(() => {
  __resetForTest();
  globalThis.indexedDB = new IDBFactory();
  settingsStorageTestingHandle.reset();
});
test("reports hydration without throwing and forgets it after the testing reset", async () => {
  expect(isSettingsHydrated()).toBe(false);
  await hydrateSettings();
  expect(isSettingsHydrated()).toBe(true);
  settingsStorageTestingHandle.reset();
  expect(isSettingsHydrated()).toBe(false);
});
test("requires hydration before reads, epoch capture or writes", async () => {
  expect(() => readSetting("locale")).toThrow("before hydrateSettings");
  expect(captureSettingsWriteEpoch).toThrow("before hydrateSettings");
  await expect(writeSetting("locale", "en-US", "unknown")).rejects.toThrow(
    "before hydrateSettings",
  );
});
test("hydrates only strings, merges independent writes and publishes committed values", async () => {
  await idbPut("meta", { locale: "en-US", invalid: 3 }, "ui-settings");
  await hydrateSettings();
  expect(readSetting("invalid")).toBeNull();
  const epoch = captureSettingsWriteEpoch();
  await Promise.all([writeSetting("locale", "fr-FR", epoch), writeSetting("theme", "dark", epoch)]);
  await hydrateSettings();
  expect(readSetting("locale")).toBe("fr-FR");
  expect(readSetting("theme")).toBe("dark");
  expect(await idbGet("meta", "ui-settings")).toEqual({ locale: "fr-FR", theme: "dark" });
});
test("ignores malformed preference containers without inventing values", async () => {
  for (const raw of [undefined, null, true, 5]) {
    await idbPut("meta", raw, "ui-settings");
    await hydrateSettings();
    expect(readSetting("locale")).toBeNull();
  }
});
test("failed writes preserve both old disk state and the old projection", async () => {
  await hydrateSettings();
  const epoch = captureSettingsWriteEpoch();
  await writeSetting("locale", "en-US", epoch);
  const original = IDBObjectStore.prototype.put;
  const interception = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    if (args[1] === "ui-settings") throw new DOMException("settings quota", "QuotaExceededError");
    return original.apply(this, args);
  });
  await expect(writeSetting("locale", "fr-FR", epoch)).rejects.toThrow("settings quota");
  interception.mockRestore();
  expect(readSetting("locale")).toBe("en-US");
  expect(await idbGet("meta", "ui-settings")).toEqual({ locale: "en-US" });
});
test("reset invalidates previously captured preference writes", async () => {
  await hydrateSettings();
  const oldEpoch = captureSettingsWriteEpoch();
  await clearAllSecureData();
  await expect(writeSetting("locale", "fr-FR", oldEpoch)).rejects.toThrow("changed");
  expect(await idbGet("meta", "ui-settings")).toBeUndefined();
  expect(readSetting("locale")).toBeNull();
});
test("unavailable IndexedDB is reported instead of treating an unsaved setting as saved", async () => {
  await hydrateSettings();
  const epoch = captureSettingsWriteEpoch();
  __resetForTest();
  vi.stubGlobal("indexedDB", undefined);
  try {
    await expect(writeSetting("theme", "dark", epoch)).rejects.toThrow("not available");
    await expect(hydrateSettings()).rejects.toThrow("not available");
    expect(readSetting("theme")).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});
