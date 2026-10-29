import { type I18n, type Messages, setupI18n } from "@lingui/core";
import { DEFAULT_LOCALE, type Locale } from "./locales";
import { messages as englishMessages } from "./locales/en-US/messages";

const loaders = {
  "zh-Hans": () => import("./locales/zh-Hans/messages"),
  "zh-Hant-TW": () => import("./locales/zh-Hant-TW/messages"),
  "zh-Hant-HK": () => import("./locales/zh-Hant-HK/messages"),
  "ja-JP": () => import("./locales/ja-JP/messages"),
  "ko-KR": () => import("./locales/ko-KR/messages"),
  "fr-FR": () => import("./locales/fr-FR/messages"),
  "ru-RU": () => import("./locales/ru-RU/messages"),
  "es-ES": () => import("./locales/es-ES/messages"),
  "it-IT": () => import("./locales/it-IT/messages"),
  ar: () => import("./locales/ar/messages"),
};
const catalogs = new Map<Locale, Messages>([[DEFAULT_LOCALE, englishMessages]]);
const pendingLoads = new Map<Locale, Promise<void>>();
function missing(_locale: string, id: string): string {
  return id.startsWith("common.") ? id.slice("common.".length) : id;
}
export const i18n = setupI18n({
  locale: DEFAULT_LOCALE,
  messages: { [DEFAULT_LOCALE]: englishMessages },
  missing,
});
const localeInstances = new Map<Locale, I18n>();

export function loadLocale(locale: Locale): Promise<void> {
  if (catalogs.has(locale)) return Promise.resolve();
  let pending = pendingLoads.get(locale);
  if (!pending) {
    pending = loaders[locale as keyof typeof loaders]()
      .then(({ messages }) => {
        catalogs.set(locale, messages);
        i18n.load(locale, messages);
      })
      .finally(() => pendingLoads.delete(locale));
    pendingLoads.set(locale, pending);
  }
  return pending;
}

export function getLocaleI18n(locale: Locale): I18n {
  const messages = catalogs.get(locale);
  if (!messages) throw new Error(`Catalog ${locale} has not been loaded`);
  let instance = localeInstances.get(locale);
  if (!instance) {
    instance = setupI18n({ locale, messages: { [locale]: messages }, missing });
    localeInstances.set(locale, instance);
  }
  return instance;
}
