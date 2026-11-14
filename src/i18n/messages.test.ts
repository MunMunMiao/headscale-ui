import { describe, expect, test } from "vitest";
import { getMessage } from "@/test/messages";
import { SUPPORTED_LOCALES } from "./locales";
import { getProductCopy } from "./product-copy";
import { loadLocale } from "./runtime";

describe("localized messages", () => {
  test.each(SUPPORTED_LOCALES)(
    "keeps named placeholders interpolated in %s",
    async (locale) => {
      await loadLocale(locale);
      const unexpected = getMessage(locale, "requestUnexpectedResponse", {
        status: 502,
      });
      expect(unexpected).toContain("502");
      expect(unexpected).not.toContain("{status}");
      for (const key of [
        "unsupportedServerVersion",
        "serverVersionUnreadable",
      ] as const) {
        const text = getMessage(locale, key, { version: "0.28.1" });
        expect(text).toContain("0.28.1");
        expect(text).not.toContain("{version}");
      }
    },
  );

  test("preserves apostrophes and product placeholders for callers to interpolate", async () => {
    await loadLocale("fr-FR");
    expect(getProductCopy("fr-FR").renameMachineTitle).toBe(
      "Renommer l'appareil",
    );
    expect(getProductCopy("en-US").policyIdentityRemovalImpact).toBe(
      "Affected rules: {rules}. Affected policy tests: {tests}.",
    );
    expect(getProductCopy("en-US").orphanReferenceTooltip).toContain(
      "We couldn't find",
    );
    expect(
      getMessage("en-US", "profileUnlockTitle", { name: "Alpha's {lab}" }),
    ).toBe("Unlock Alpha's {lab}");
  });
});
