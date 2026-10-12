import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_LOCALE,
  LOCALE_META,
  normalizeLocale,
  resolveLocale,
  SUPPORTED_LOCALES,
} from "./locales";

test("the static document language matches the default locale", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  expect(/<html[^>]*\slang="([^"]+)"/.exec(html)?.[1]).toBe(DEFAULT_LOCALE);
});

describe("locale registry", () => {
  test("uses the canonical BCP47 locale list and default", () => {
    expect(SUPPORTED_LOCALES).toEqual([
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
    ]);
    expect(DEFAULT_LOCALE).toBe("en-US");
  });

  test("keeps native labels and text directions aligned with each locale", () => {
    const metadata = Object.fromEntries(
      SUPPORTED_LOCALES.map((locale) => [
        locale,
        LOCALE_META[locale] && {
          code: LOCALE_META[locale].code,
          nativeLabel: LOCALE_META[locale].nativeLabel,
          dir: LOCALE_META[locale].dir,
        },
      ]),
    );

    expect(metadata).toEqual({
      "en-US": { code: "en-US", nativeLabel: "English", dir: "ltr" },
      "zh-Hans": { code: "zh-Hans", nativeLabel: "简体中文", dir: "ltr" },
      "zh-Hant-TW": { code: "zh-Hant-TW", nativeLabel: "繁體中文（台灣）", dir: "ltr" },
      "zh-Hant-HK": { code: "zh-Hant-HK", nativeLabel: "繁體中文（香港）", dir: "ltr" },
      "ja-JP": { code: "ja-JP", nativeLabel: "日本語", dir: "ltr" },
      "ko-KR": { code: "ko-KR", nativeLabel: "한국어", dir: "ltr" },
      "fr-FR": { code: "fr-FR", nativeLabel: "Français", dir: "ltr" },
      "ru-RU": { code: "ru-RU", nativeLabel: "Русский", dir: "ltr" },
      "es-ES": { code: "es-ES", nativeLabel: "Español", dir: "ltr" },
      "it-IT": { code: "it-IT", nativeLabel: "Italiano", dir: "ltr" },
      ar: { code: "ar", nativeLabel: "العربية", dir: "rtl" },
    });
  });

  test("normalizes legacy locale tags", () => {
    expect(normalizeLocale("en")).toBe("en-US");
    expect(normalizeLocale("zh")).toBe("zh-Hans");
    expect(normalizeLocale("zh-Hant")).toBe("zh-Hant-TW");
    expect(normalizeLocale("fr")).toBe("fr-FR");
    expect(normalizeLocale("ru")).toBe("ru-RU");
    expect(normalizeLocale("es")).toBe("es-ES");
    expect(normalizeLocale("es-001")).toBe("es-ES");
    expect(normalizeLocale("ar-001")).toBe("ar");
    expect(normalizeLocale("ar")).toBe("ar");
    expect(normalizeLocale("zh-Hant-HK")).toBe("zh-Hant-HK");
  });

  test("resolves unsupported or absent locales to the default", () => {
    expect(resolveLocale("de-DE")).toBe("en-US");
    expect(resolveLocale(null)).toBe("en-US");
    expect(resolveLocale(undefined)).toBe("en-US");
    expect(resolveLocale("it-IT")).toBe("it-IT");
  });
});
