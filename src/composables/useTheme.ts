import {
  captureSettingsWriteEpoch,
  hydrateSettings,
  isSettingsHydrated,
  readSetting,
  subscribePreferenceChanges,
  writeSetting,
} from "@/lib/settings-storage";
import { createStore } from "@/lib/store";
import { useSession, useStore } from "./session-context";

export type ThemeMode = "light" | "dark" | "auto";

const THEME_SETTING_KEY = "theme";
export const themeModes: ThemeMode[] = ["light", "dark", "auto"];

function initialThemeMode(): ThemeMode {
  const saved = readSetting(THEME_SETTING_KEY);
  return isThemeMode(saved) ? saved : "auto";
}

function prefersDarkMode() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export function isThemeMode(value: string | null): value is ThemeMode {
  return value === "light" || value === "dark" || value === "auto";
}

function applyThemeMode(mode: ThemeMode) {
  if (typeof document !== "undefined") {
    const dark = mode === "dark" || (mode === "auto" && prefersDarkMode());
    // Both classes are set so the stylesheet can tell "explicit light" from "no choice yet".
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.classList.toggle("light", !dark);
  }
}

/** Applies the stored mode (or the OS preference) without reading unhydrated settings. */
export function applyStoredTheme(): void {
  const saved = isSettingsHydrated() ? readSetting(THEME_SETTING_KEY) : null;
  applyThemeMode(isThemeMode(saved) ? saved : "auto");
}

export function createThemeStore() {
  const state = createStore<{
    colorMode: ThemeMode;
    themeError: "not-saved" | null;
  }>({
    colorMode: initialThemeMode(),
    themeError: null,
  });
  let generation = 0;
  function applyTheme() {
    applyThemeMode(state.getSnapshot().colorMode);
  }
  function refreshFromSettings() {
    ++generation;
    state.setState({ colorMode: initialThemeMode(), themeError: null });
    applyTheme();
  }
  return {
    getSnapshot: state.getSnapshot,
    subscribe: state.subscribe,
    themeModes,
    applyTheme,
    refreshFromSettings,
    startPreferenceSync() {
      let active = true;
      const stop = subscribePreferenceChanges((key) => {
        if (key !== "theme") return;
        const request = generation;
        void hydrateSettings().then(
          () => {
            if (active && request === generation) refreshFromSettings();
          },
          () => {
            // Retain the current appearance when the preference cannot be read.
          },
        );
      });
      return () => {
        active = false;
        stop();
      };
    },
    async setTheme(colorMode: ThemeMode): Promise<void> {
      const request = ++generation;
      const epoch = captureSettingsWriteEpoch();
      state.setState({ colorMode, themeError: null });
      applyTheme();
      try {
        await writeSetting(THEME_SETTING_KEY, colorMode, epoch);
      } catch {
        if (request === generation) state.setState({ themeError: "not-saved" });
      }
    },
  };
}

export function useTheme() {
  return useStore(useSession().theme);
}
