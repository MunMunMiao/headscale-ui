import { clearHeadscaleDatabase } from "@/test/clear-headscale-database";
import { requireValue } from "@/test/dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createThemeStore } from "@/composables/useTheme";
import { __resetForTest, STORE_META } from "@/lib/idb";
import { clearAllSecureData } from "@/lib/secure-storage";
import * as settings from "@/lib/settings-storage";
import { newVaultState, VAULT_STATE_KEY } from "@/lib/vault-state";
import { idbPut } from "@/test-utils/storage";
import { applyStoredLocale, setLocale } from "./index";
import * as runtime from "./runtime";

vi.mock("@/lib/settings-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof settings>();
  return {
    ...actual,
    writeSetting: vi.fn(actual.writeSetting),
  };
});
vi.mock("./runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof runtime>();
  return { ...actual, loadLocale: vi.fn(actual.loadLocale) };
});

beforeEach(async () => {
  await clearHeadscaleDatabase();
  __resetForTest();
  settings.settingsStorageTestingHandle.reset();
  await settings.hydrateSettings();
  runtime.i18n.activate("en-US");
});
afterEach(() => {
  vi.restoreAllMocks();
  // vi.mock spies are not restored by restoreAllMocks; an override would otherwise stick.
  vi.resetAllMocks();
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("keeps the active language and preference when its catalog fails", async () => {
  const write = vi.spyOn(settings, "writeSetting").mockResolvedValue();
  vi.spyOn(runtime, "loadLocale").mockRejectedValue(
    new Error("catalog unavailable"),
  );
  expect(await setLocale("ar")).toEqual({ status: "load-failed" });
  expect(runtime.i18n.locale).toBe("en-US");
  expect(write).not.toHaveBeenCalled();
});

test("lets the newest locale win when catalog responses finish out of order", async () => {
  const actualLoad = requireValue(
    vi.mocked(runtime.loadLocale).getMockImplementation(),
  );
  const slow = deferred();
  vi.spyOn(runtime, "loadLocale").mockImplementation(async (locale) => {
    if (locale === "ar") await slow.promise;
    await actualLoad(locale);
  });
  const write = vi.spyOn(settings, "writeSetting").mockResolvedValue();
  const first = setLocale("ar");
  expect(await setLocale("fr-FR")).toEqual({ status: "activated" });
  slow.resolve();
  expect(await first).toEqual({ status: "superseded" });
  expect(runtime.i18n.locale).toBe("fr-FR");
  expect(write).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledWith(
    "locale",
    "fr-FR",
    settings.captureSettingsWriteEpoch(),
  );
});

test("keeps the activated language when preference persistence fails", async () => {
  vi.spyOn(settings, "writeSetting").mockRejectedValue(
    new Error("storage unavailable"),
  );
  expect(await setLocale("ar")).toEqual({ status: "activated-not-persisted" });
  expect(runtime.i18n.locale).toBe("ar");
  expect(settings.readSetting("locale")).toBeNull();
});

test("restores legacy stored locale without writing it again", async () => {
  await settings.writeSetting(
    "locale",
    "fr",
    settings.captureSettingsWriteEpoch(),
  );
  const write = vi.spyOn(settings, "writeSetting");
  write.mockClear();
  await applyStoredLocale();
  expect(runtime.i18n.locale).toBe("fr-FR");
  expect(settings.readSetting("locale")).toBe("fr");
  expect(write).not.toHaveBeenCalled();
});

test("cancels a pending locale load when saved data is reset", async () => {
  const actualLoad = requireValue(
    vi.mocked(runtime.loadLocale).getMockImplementation(),
  );
  const slow = deferred();
  vi.spyOn(runtime, "loadLocale").mockImplementation(async (locale) => {
    await slow.promise;
    await actualLoad(locale);
  });
  const pending = setLocale("ar");
  await clearAllSecureData();
  slow.resolve();
  expect(await pending).toEqual({ status: "superseded" });
  expect(runtime.i18n.locale).toBe("en-US");
  expect(settings.readSetting("locale")).toBeNull();
});

test("does not overwrite the newest language when an older catalog rejects", async () => {
  const slow = deferred();
  const actualLoad = requireValue(
    vi.mocked(runtime.loadLocale).getMockImplementation(),
  );
  vi.spyOn(runtime, "loadLocale").mockImplementation((locale) =>
    locale === "ar" ? slow.promise : actualLoad(locale),
  );
  const first = setLocale("ar");
  expect(await setLocale("fr-FR")).toEqual({ status: "activated" });
  slow.reject(new Error("late load failure"));
  expect(await first).toEqual({ status: "superseded" });
  expect(runtime.i18n.locale).toBe("fr-FR");
  expect(settings.readSetting("locale")).toBe("fr-FR");
});

test.each([true, false])(
  "ignores an older persistence completion after a newer language (failure=%s)",
  async (fail) => {
    const slow = deferred();
    const write = requireValue(
      vi.mocked(settings.writeSetting).getMockImplementation(),
    );
    const started = deferred();
    vi.spyOn(settings, "writeSetting").mockImplementation(
      async (key, value, epoch) => {
        if (value === "ar") {
          started.resolve();
          await slow.promise;
          return;
        }
        return write(key, value, epoch);
      },
    );
    const first = setLocale("ar");
    await started.promise;
    expect(await setLocale("fr-FR")).toEqual({ status: "activated" });
    if (fail) slow.reject(new Error("late write failure"));
    else slow.resolve();
    expect(await first).toEqual({ status: "superseded" });
    expect(runtime.i18n.locale).toBe("fr-FR");
    expect(settings.readSetting("locale")).toBe("fr-FR");
  },
);

test("keeps startup usable in English if the saved catalog cannot load", async () => {
  await settings.writeSetting(
    "locale",
    "fr",
    settings.captureSettingsWriteEpoch(),
  );
  vi.spyOn(runtime, "loadLocale").mockRejectedValue(new Error("offline"));
  await expect(applyStoredLocale()).resolves.toBeUndefined();
  expect(runtime.i18n.locale).toBe("en-US");
  expect(settings.readSetting("locale")).toBe("fr");
});

test("keeps the request-start epoch when a reset notification is lost", async () => {
  const slow = deferred();
  const actualLoad = requireValue(
    vi.mocked(runtime.loadLocale).getMockImplementation(),
  );
  vi.spyOn(runtime, "loadLocale").mockImplementation(async (locale) => {
    await slow.promise;
    await actualLoad(locale);
  });
  const request = setLocale("ar");
  await idbPut(STORE_META, newVaultState(), VAULT_STATE_KEY);
  slow.resolve();
  expect(await request).toEqual({ status: "activated-not-persisted" });
  expect(settings.readSetting("locale")).toBeNull();
  await settings.hydrateSettings();
  expect(settings.readSetting("locale")).toBeNull();
});

test("persists concurrent theme and locale changes without replacing the other key", async () => {
  const theme = createThemeStore();
  await Promise.all([setLocale("ar"), theme.setTheme("dark")]);
  await settings.hydrateSettings();
  expect(settings.readSetting("locale")).toBe("ar");
  expect(settings.readSetting("theme")).toBe("dark");
});
