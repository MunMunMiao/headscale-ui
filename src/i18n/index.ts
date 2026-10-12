import { useLingui } from "@lingui/react";
import { useSyncExternalStore } from "react";
import {
  captureSettingsWriteEpoch,
  hydrateSettings,
  readSetting,
  writeSetting,
} from "@/lib/settings-storage";
import { createStore } from "@/lib/store";
import { subscribeVaultChanges } from "@/lib/vault-state";
import { commonDescriptors, type MessageKey } from "./descriptors";
import { DEFAULT_LOCALE, LOCALE_META, type Locale, resolveLocale } from "./locales";
import { i18n, loadLocale } from "./runtime";

const LOCALE_SETTING_KEY = "locale";
export type LocaleChangeResult = {
  status: "activated" | "activated-not-persisted" | "superseded" | "load-failed";
};
const localeChanges = createStore<{
  pendingLocale: Locale | null;
  localeError: "load-failed" | "not-saved" | null;
  settingsError: "reload-failed" | null;
}>({ pendingLocale: null, localeError: null, settingsError: null });
let localeGeneration = 0;
let settingsRefreshGeneration = 0;
subscribeVaultChanges((change) => {
  if (change.reset) {
    ++localeGeneration;
    localeChanges.setState({ pendingLocale: null, localeError: null });
  }
  const refresh = ++settingsRefreshGeneration;
  void hydrateSettings().then(
    () => {
      if (refresh === settingsRefreshGeneration) localeChanges.setState({ settingsError: null });
    },
    () => {
      if (refresh === settingsRefreshGeneration)
        localeChanges.setState({ settingsError: "reload-failed" });
    },
  );
});

function activateLocale(locale: Locale): void {
  i18n.activate(locale);
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
    document.documentElement.dir = LOCALE_META[locale].dir;
  }
}

async function changeLocale(locale: Locale, persist: boolean): Promise<LocaleChangeResult> {
  const generation = ++localeGeneration;
  const epoch = persist ? captureSettingsWriteEpoch() : undefined;
  localeChanges.setState({ pendingLocale: locale, localeError: null });
  try {
    await loadLocale(locale);
  } catch {
    if (generation !== localeGeneration) return { status: "superseded" };
    localeChanges.setState({ pendingLocale: null, localeError: "load-failed" });
    return { status: "load-failed" };
  }
  if (generation !== localeGeneration) return { status: "superseded" };
  activateLocale(locale);
  if (epoch !== undefined) {
    try {
      await writeSetting(LOCALE_SETTING_KEY, locale, epoch);
    } catch {
      if (generation !== localeGeneration) return { status: "superseded" };
      localeChanges.setState({ pendingLocale: null, localeError: "not-saved" });
      return { status: "activated-not-persisted" };
    }
  }
  if (generation !== localeGeneration) return { status: "superseded" };
  localeChanges.setState({ pendingLocale: null, localeError: null });
  return { status: "activated" };
}

export function setLocale(locale: Locale): Promise<LocaleChangeResult> {
  return changeLocale(locale, true);
}

export async function applyStoredLocale(): Promise<void> {
  activateLocale(DEFAULT_LOCALE);
  await changeLocale(resolveLocale(readSetting(LOCALE_SETTING_KEY)), false);
}

export function t(key: MessageKey, named?: Record<string, string | number>): string {
  return i18n._(commonDescriptors[key].id, named);
}
export function useHeadscaleI18n() {
  useLingui();
  const changes = useSyncExternalStore(localeChanges.subscribe, localeChanges.getSnapshot);
  const locale = i18n.locale as Locale;
  return { locale, meta: LOCALE_META[locale], setLocale, t, ...changes };
}

export { LOCALE_META, SUPPORTED_LOCALES } from "./locales";
export type { Locale };
export { i18n };
