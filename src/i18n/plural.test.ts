import { describe, expect, test } from "vitest";
import baseline from "./__fixtures__/translation-corpus.json";
import { SUPPORTED_LOCALES } from "./locales";
import { type CountMessage, formatCount } from "./plural";
import { loadLocale } from "./runtime";

// Counts use ASCII digits without grouping while ICU selects the grammatical form.
describe("formatCount", () => {
  test.each(SUPPORTED_LOCALES)(
    "preserves all plural forms and numeric text for %s",
    async (locale) => {
      await loadLocale(locale);
      for (const [key, cases] of Object.entries(baseline[locale].plurals)) {
        for (const [count, expected] of cases) {
          expect(formatCount(locale, key as CountMessage, count as number)).toBe(expected);
        }
      }
    },
  );
  test("uses Arabic zero, one, two, few, many and other without grouping", async () => {
    await loadLocale("ar");
    expect(formatCount("ar", "orphanReferences", 0)).toBe("لا توجد مراجع غير صالحة");
    expect(formatCount("ar", "orphanReferences", 1)).toBe("مرجع واحد غير صالح");
    expect(formatCount("ar", "orphanReferences", 2)).toBe("مرجعان غير صالحين");
    expect(formatCount("ar", "orphanReferences", 3)).toBe("3 مراجع غير صالحة");
    expect(formatCount("ar", "orphanReferences", 11)).toBe("11 مرجعًا غير صالح");
    expect(formatCount("ar", "orphanReferences", 1000)).toBe("1000 مرجع غير صالح");
  });
});
