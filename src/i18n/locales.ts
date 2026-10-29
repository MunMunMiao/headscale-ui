export const DEFAULT_LOCALE = "en-US";

export const SUPPORTED_LOCALES = [
  "en-US",
  "zh-Hans",
  "zh-Hant-TW",
  "zh-Hant-HK",
  "ja-JP",
  "ko-KR",
  "fr-FR",
  "ru-RU",
  "es-ES",
  "it-IT",
  "ar",
] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export interface LocaleMeta {
  code: Locale;
  label: string;
  nativeLabel: string;
  dir: "ltr" | "rtl";
}

export const LOCALE_META: Record<Locale, LocaleMeta> = {
  "en-US": {
    code: "en-US",
    label: "English",
    nativeLabel: "English",
    dir: "ltr",
  },
  "zh-Hans": {
    code: "zh-Hans",
    label: "Simplified Chinese",
    nativeLabel: "简体中文",
    dir: "ltr",
  },
  "zh-Hant-TW": {
    code: "zh-Hant-TW",
    label: "Traditional Chinese (Taiwan)",
    nativeLabel: "繁體中文（台灣）",
    dir: "ltr",
  },
  "zh-Hant-HK": {
    code: "zh-Hant-HK",
    label: "Traditional Chinese (Hong Kong)",
    nativeLabel: "繁體中文（香港）",
    dir: "ltr",
  },
  "ja-JP": {
    code: "ja-JP",
    label: "Japanese",
    nativeLabel: "日本語",
    dir: "ltr",
  },
  "ko-KR": {
    code: "ko-KR",
    label: "Korean",
    nativeLabel: "한국어",
    dir: "ltr",
  },
  "fr-FR": {
    code: "fr-FR",
    label: "French",
    nativeLabel: "Français",
    dir: "ltr",
  },
  "ru-RU": {
    code: "ru-RU",
    label: "Russian",
    nativeLabel: "Русский",
    dir: "ltr",
  },
  "es-ES": {
    code: "es-ES",
    label: "Spanish",
    nativeLabel: "Español",
    dir: "ltr",
  },
  "it-IT": {
    code: "it-IT",
    label: "Italian",
    nativeLabel: "Italiano",
    dir: "ltr",
  },
  ar: { code: "ar", label: "Arabic", nativeLabel: "العربية", dir: "rtl" },
};

const LEGACY_LOCALES: Record<string, Locale> = {
  en: "en-US",
  zh: "zh-Hans",
  "zh-Hant": "zh-Hant-TW",
  fr: "fr-FR",
  ru: "ru-RU",
  es: "es-ES",
  "es-001": "es-ES",
  "ar-001": "ar",
};

export function normalizeLocale(value: string): string {
  return LEGACY_LOCALES[value] ?? value;
}

export function isLocale(value: string): value is Locale {
  return SUPPORTED_LOCALES.includes(value as Locale);
}

export function resolveLocale(value: string | null | undefined): Locale {
  const normalized = normalizeLocale(value ?? "");
  return isLocale(normalized) ? normalized : DEFAULT_LOCALE;
}
