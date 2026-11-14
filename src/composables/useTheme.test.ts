import { clearHeadscaleDatabase } from "@/test/clear-headscale-database";
import { createElement, useState } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { __resetForTest } from "@/lib/idb";
import { testDouble } from "@/test/dom";
import * as settings from "@/lib/settings-storage";
import {
  hydrateSettings,
  readSetting,
  settingsStorageTestingHandle,
  writeSetting,
} from "@/lib/settings-storage";
import { applyStoredTheme, createThemeStore, isThemeMode } from "./useTheme";

vi.mock("@/lib/settings-storage", { spy: true });

beforeEach(async () => {
  await clearHeadscaleDatabase();
  __resetForTest();
  settingsStorageTestingHandle.reset();
  await hydrateSettings();
});

afterEach(() => {
  vi.restoreAllMocks();
  // vi.mock spies are not restored by restoreAllMocks; an override would otherwise stick.
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.classList.remove("dark", "light");
});

const themeClasses = ["dark", "light"];
function prefersColorScheme(dark: boolean) {
  return testDouble<MediaQueryList>({ matches: dark });
}

function DiscardedRender(): never {
  useState(() => createThemeStore());
  throw new Error("discarded render");
}

describe("useTheme", () => {
  test("peer theme reads do not replay writes and ignore unrelated preference hints", async () => {
    let receive!: Parameters<typeof settings.subscribePreferenceChanges>[0];
    vi.spyOn(settings, "subscribePreferenceChanges").mockImplementation(
      (listener) => {
        receive = listener;
        return () => {};
      },
    );
    const theme = createThemeStore();
    const stop = theme.startPreferenceSync();
    await writeSetting("theme", "dark", settings.captureSettingsWriteEpoch());
    const write = vi.spyOn(settings, "writeSetting");
    write.mockClear();
    receive("locale");
    await Promise.resolve();
    expect(theme.getSnapshot().colorMode).toBe("auto");
    receive("theme");
    await vi.waitFor(() => expect(theme.getSnapshot().colorMode).toBe("dark"));
    expect(write).not.toHaveBeenCalled();
    stop();
  });

  test.each(["newer selection", "reset", "stopped"] as const)(
    "a delayed peer theme read cannot override a %s",
    async (boundary) => {
      let receive!: Parameters<typeof settings.subscribePreferenceChanges>[0];
      vi.spyOn(settings, "subscribePreferenceChanges").mockImplementation(
        (listener) => {
          receive = listener;
          return () => {};
        },
      );
      const theme = createThemeStore();
      const stop = theme.startPreferenceSync();
      await writeSetting("theme", "dark", settings.captureSettingsWriteEpoch());
      const delayed = Promise.withResolvers<void>();
      vi.spyOn(settings, "hydrateSettings").mockReturnValueOnce(
        delayed.promise,
      );
      receive("theme");
      if (boundary === "newer selection") await theme.setTheme("light");
      else if (boundary === "reset") {
        settings.clearSettingsProjection("new-epoch");
        theme.refreshFromSettings();
      } else stop();
      delayed.resolve();
      await delayed.promise;
      await Promise.resolve();
      expect(theme.getSnapshot().colorMode).toBe(
        boundary === "newer selection" ? "light" : "auto",
      );
      stop();
    },
  );

  test("an unreadable peer theme retains the current appearance and a later read can recover", async () => {
    let receive!: Parameters<typeof settings.subscribePreferenceChanges>[0];
    vi.spyOn(settings, "subscribePreferenceChanges").mockImplementation(
      (listener) => {
        receive = listener;
        return () => {};
      },
    );
    const theme = createThemeStore();
    const stop = theme.startPreferenceSync();
    await writeSetting("theme", "dark", settings.captureSettingsWriteEpoch());
    vi.spyOn(settings, "hydrateSettings").mockRejectedValueOnce(
      new Error("read unavailable"),
    );
    receive("theme");
    await Promise.resolve();
    expect(theme.getSnapshot().colorMode).toBe("auto");
    receive("theme");
    await vi.waitFor(() => expect(theme.getSnapshot().colorMode).toBe("dark"));
    stop();
  });
  test("keeps the chosen theme and reports that it was not saved when persistence fails", async () => {
    vi.spyOn(settings, "writeSetting").mockRejectedValue(
      new Error("storage unavailable"),
    );
    const theme = createThemeStore();
    await theme.setTheme("dark");
    expect(theme.getSnapshot().colorMode).toBe("dark");
    expect(theme.getSnapshot()).toMatchObject({ themeError: "not-saved" });
    expect(readSetting("theme")).toBeNull();
  });
  test("does not let an older failed write overwrite a newer saved theme", async () => {
    const old = Promise.withResolvers<void>();
    const write = vi
      .spyOn(settings, "writeSetting")
      .mockReturnValueOnce(old.promise);
    const theme = createThemeStore();
    const first = theme.setTheme("dark");
    await theme.setTheme("light");
    old.reject(new Error("old write failure"));
    await first;
    expect(theme.getSnapshot()).toMatchObject({
      colorMode: "light",
      themeError: null,
    });
    expect(write).toHaveBeenCalledWith(
      "theme",
      "dark",
      settings.captureSettingsWriteEpoch(),
    );
    expect(readSetting("theme")).toBe("light");
  });
  test("a discarded React render does not apply or persist its initial theme", () => {
    const toggle = vi.spyOn(document.documentElement.classList, "toggle");
    vi.spyOn(window, "matchMedia").mockReturnValue(prefersColorScheme(true));
    expect(() => renderToString(createElement(DiscardedRender))).toThrow(
      "discarded render",
    );
    expect(toggle).not.toHaveBeenCalled();
    expect(readSetting("theme")).toBeNull();
  });

  test("system theme updates only change the document, without persisting a preference", async () => {
    const theme = createThemeStore();
    theme.applyTheme();
    expect(readSetting("theme")).toBeNull();
    await theme.setTheme("dark");
    expect(readSetting("theme")).toBe("dark");
  });

  test("recognizes supported modes", () => {
    expect(isThemeMode("light")).toBe(true);
    expect(isThemeMode("dark")).toBe(true);
    expect(isThemeMode("auto")).toBe(true);
    expect(isThemeMode("sepia")).toBe(false);
    expect(isThemeMode(null)).toBe(false);
  });

  test("loads the saved mode and applies browser color-scheme changes", async () => {
    vi.spyOn(window, "matchMedia").mockReturnValue(prefersColorScheme(true));
    const dark = () => document.documentElement.classList.contains("dark");
    await writeSetting("theme", "dark", settings.captureSettingsWriteEpoch());

    const theme = createThemeStore();
    expect(theme.getSnapshot().colorMode).toBe("dark");

    await theme.setTheme("auto");
    expect(dark()).toBe(true);
    await theme.setTheme("light");
    expect(dark()).toBe(false);
    expect(readSetting("theme")).toBe("light");
  });

  test("falls back to auto for an invalid saved value", async () => {
    await writeSetting("theme", "sepia", settings.captureSettingsWriteEpoch());

    const theme = createThemeStore();

    expect(theme.getSnapshot().colorMode).toBe("auto");
    expect(readSetting("theme")).toBe("sepia");
  });

  describe("applyStoredTheme", () => {
    function stubOsTheme(prefersDark = false) {
      vi.spyOn(window, "matchMedia").mockReturnValue(
        prefersColorScheme(prefersDark),
      );
      return () =>
        themeClasses.filter((name) =>
          document.documentElement.classList.contains(name),
        );
    }

    test.each([
      ["dark", false, ["dark"]],
      ["light", true, ["light"]],
      ["auto", true, ["dark"]],
      ["auto", false, ["light"]],
    ] as const)(
      "applies the stored %s mode (OS dark: %s) with exclusive classes",
      async (mode, osDark, expected) => {
        await writeSetting("theme", mode, settings.captureSettingsWriteEpoch());
        const applied = stubOsTheme(osDark);
        applyStoredTheme();
        expect(applied().toSorted()).toEqual(expected);
      },
    );

    test("an invalid stored value follows the OS", async () => {
      await writeSetting(
        "theme",
        "sepia",
        settings.captureSettingsWriteEpoch(),
      );
      const applied = stubOsTheme(true);
      applyStoredTheme();
      expect(applied()).toEqual(["dark"]);
    });

    test("before hydration it follows the OS instead of throwing", () => {
      settingsStorageTestingHandle.reset();
      const applied = stubOsTheme(true);
      expect(() => applyStoredTheme()).not.toThrow();
      expect(applied()).toEqual(["dark"]);
    });
  });
});
