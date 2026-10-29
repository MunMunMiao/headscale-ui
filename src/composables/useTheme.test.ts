import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { createElement, useState } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { __resetForTest } from "@/lib/idb";
import * as settings from "@/lib/settings-storage";
import {
  hydrateSettings,
  readSetting,
  settingsStorageTestingHandle,
  writeSetting,
} from "@/lib/settings-storage";
import { applyStoredTheme, createThemeStore, isThemeMode } from "./useTheme";

const documentDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "document",
);
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

function restoreGlobal(
  name: "document" | "window",
  descriptor?: PropertyDescriptor,
) {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
  } else {
    Reflect.deleteProperty(globalThis, name);
  }
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  __resetForTest();
  settingsStorageTestingHandle.reset();
  await hydrateSettings();
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreGlobal("document", documentDescriptor);
  restoreGlobal("window", windowDescriptor);
});

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
    const toggles: boolean[] = [];
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        documentElement: {
          classList: {
            toggle: (name: string, value: boolean) =>
              name === "dark" && toggles.push(value),
          },
        },
      },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { matchMedia: () => ({ matches: true }) },
    });
    expect(() => renderToString(createElement(DiscardedRender))).toThrow(
      "discarded render",
    );
    expect(toggles).toEqual([]);
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
    const toggles: boolean[] = [];
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        documentElement: {
          classList: {
            toggle: (name: string, enabled: boolean) => {
              if (name === "dark") toggles.push(enabled);
            },
          },
        },
      },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { matchMedia: () => ({ matches: true }) },
    });
    await writeSetting("theme", "dark", settings.captureSettingsWriteEpoch());

    const theme = createThemeStore();
    expect(theme.getSnapshot().colorMode).toBe("dark");
    expect(theme.themeModes).toEqual(["light", "dark", "auto"]);

    await theme.setTheme("auto");
    expect(toggles.at(-1)).toBe(true);
    await theme.setTheme("light");
    expect(toggles.at(-1)).toBe(false);
    expect(readSetting("theme")).toBe("light");
  });

  test("falls back to auto without browser globals for an invalid saved value", async () => {
    Reflect.deleteProperty(globalThis, "document");
    Reflect.deleteProperty(globalThis, "window");
    await writeSetting("theme", "sepia", settings.captureSettingsWriteEpoch());

    const theme = createThemeStore();

    expect(theme.getSnapshot().colorMode).toBe("auto");
    expect(readSetting("theme")).toBe("sepia");
  });

  describe("applyStoredTheme", () => {
    function stubDocument(prefersDark = false) {
      const classes = new Set<string>();
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: {
          documentElement: {
            classList: {
              toggle: (name: string, on: boolean) =>
                on ? classes.add(name) : classes.delete(name),
            },
          },
        },
      });
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { matchMedia: () => ({ matches: prefersDark }) },
      });
      return classes;
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
        const classes = stubDocument(osDark);
        applyStoredTheme();
        expect([...classes].sort()).toEqual(expected);
      },
    );

    test("an invalid stored value follows the OS", async () => {
      await writeSetting(
        "theme",
        "sepia",
        settings.captureSettingsWriteEpoch(),
      );
      const classes = stubDocument(true);
      applyStoredTheme();
      expect([...classes]).toEqual(["dark"]);
    });

    test("before hydration it follows the OS instead of throwing", () => {
      settingsStorageTestingHandle.reset();
      const classes = stubDocument(true);
      expect(() => applyStoredTheme()).not.toThrow();
      expect([...classes]).toEqual(["dark"]);
    });

    test("does nothing without a document", () => {
      Reflect.deleteProperty(globalThis, "document");
      Reflect.deleteProperty(globalThis, "window");
      expect(() => applyStoredTheme()).not.toThrow();
    });
  });
});
