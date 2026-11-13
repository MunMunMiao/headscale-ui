import { describe, expect, test } from "vitest";
import { normalizeLocale, resolveLocale } from "./locales";

describe("locale registry", () => {
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
