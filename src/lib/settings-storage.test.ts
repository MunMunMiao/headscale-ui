import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { idbGet, idbPut } from "@/test-utils/storage";
import { __resetForTest } from "./idb";
import { clearAllSecureData } from "./secure-storage";
import {
  captureSettingsWriteEpoch,
  hydrateSettings,
  isSettingsHydrated,
  readSetting,
  settingsStorageTestingHandle,
  subscribePreferenceChanges,
  writeSetting,
} from "./settings-storage";

beforeEach(() => {
  __resetForTest();
  globalThis.indexedDB = new IDBFactory();
  settingsStorageTestingHandle.reset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("preference hints contain only committed preference keys and ignore foreign session payloads", async () => {
  class Channel {
    static instances: Channel[] = [];
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    postMessage = vi.fn();
    close = vi.fn();
    constructor(readonly name: string) {
      Channel.instances.push(this);
    }
  }
  vi.stubGlobal("BroadcastChannel", Channel);
  await hydrateSettings();
  const received: string[] = [];
  const stop = subscribePreferenceChanges((key) => received.push(key));
  const second: string[] = [];
  const stopSecond = subscribePreferenceChanges((key) => second.push(key));
  const channel = Channel.instances[0];
  expect(channel.name).toBe("headscale-ui-preferences");
  await writeSetting("theme", "dark", captureSettingsWriteEpoch());
  await writeSetting("unrelated", "not-broadcast", captureSettingsWriteEpoch());
  expect(channel.postMessage.mock.calls).toEqual([["theme"]]);
  for (const data of [
    null,
    "profiles",
    { locale: "ar", sessionId: "foreign" },
    true,
  ])
    channel.onmessage?.({ data } as MessageEvent<unknown>);
  expect(received).toEqual([]);
  channel.onmessage?.({ data: "locale" } as MessageEvent<unknown>);
  channel.onmessage?.({ data: "theme" } as MessageEvent<unknown>);
  expect(received).toEqual(["locale", "theme"]);
  expect(second).toEqual(["locale", "theme"]);
  expect(readSetting("locale")).toBeNull();
  expect(readSetting("theme")).toBe("dark");
  stop();
  stop();
  channel.postMessage.mockImplementationOnce(() => {
    throw new Error("closed peer");
  });
  await expect(
    writeSetting("locale", "ar", captureSettingsWriteEpoch()),
  ).resolves.toBeUndefined();
  expect(readSetting("locale")).toBe("ar");
  stopSecond();
  expect(channel.close).toHaveBeenCalledOnce();
  await writeSetting("locale", "fr-FR", captureSettingsWriteEpoch());
  expect(Channel.instances[1].close).toHaveBeenCalledOnce();
});

test.each(["missing", "blocked"])(
  "a %s preference channel does not affect committed storage or the reset epoch",
  async (mode) => {
    vi.stubGlobal(
      "BroadcastChannel",
      mode === "missing"
        ? undefined
        : class {
            constructor() {
              throw new Error("channel unavailable");
            }
          },
    );
    await hydrateSettings();
    const stop = subscribePreferenceChanges(() => {});
    const epoch = captureSettingsWriteEpoch();
    await writeSetting("theme", "dark", epoch);
    expect(readSetting("theme")).toBe("dark");
    stop();
    await clearAllSecureData();
    await expect(writeSetting("locale", "ar", epoch)).rejects.toThrow(
      "changed",
    );
    expect(await idbGet("meta", "ui-settings")).toBeUndefined();
  },
);

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
  await Promise.all([
    writeSetting("locale", "fr-FR", epoch),
    writeSetting("theme", "dark", epoch),
  ]);
  await hydrateSettings();
  expect(readSetting("locale")).toBe("fr-FR");
  expect(readSetting("theme")).toBe("dark");
  expect(await idbGet("meta", "ui-settings")).toEqual({
    locale: "fr-FR",
    theme: "dark",
  });
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
  const interception = vi
    .spyOn(IDBObjectStore.prototype, "put")
    .mockImplementation(function (this: IDBObjectStore, ...args) {
      if (args[1] === "ui-settings")
        throw new DOMException("settings quota", "QuotaExceededError");
      return original.apply(this, args);
    });
  await expect(writeSetting("locale", "fr-FR", epoch)).rejects.toThrow(
    "settings quota",
  );
  interception.mockRestore();
  expect(readSetting("locale")).toBe("en-US");
  expect(await idbGet("meta", "ui-settings")).toEqual({ locale: "en-US" });
});
test("reset invalidates previously captured preference writes", async () => {
  await hydrateSettings();
  const oldEpoch = captureSettingsWriteEpoch();
  await clearAllSecureData();
  await expect(writeSetting("locale", "fr-FR", oldEpoch)).rejects.toThrow(
    "changed",
  );
  expect(await idbGet("meta", "ui-settings")).toBeUndefined();
  expect(readSetting("locale")).toBeNull();
});
test("unavailable IndexedDB is reported instead of treating an unsaved setting as saved", async () => {
  await hydrateSettings();
  const epoch = captureSettingsWriteEpoch();
  __resetForTest();
  vi.stubGlobal("indexedDB", undefined);
  try {
    await expect(writeSetting("theme", "dark", epoch)).rejects.toThrow(
      "not available",
    );
    await expect(hydrateSettings()).rejects.toThrow("not available");
    expect(readSetting("theme")).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});
