import { expect, test } from "vitest";
import { SUPPORTED_LOCALES } from "./locales";
import { getLocaleI18n, i18n, loadLocale } from "./runtime";

// A Vue composer or an unactivated Lingui runtime cannot serve the React bootstrap.
test("starts with an active English Lingui catalog before React renders", () => {
  expect(i18n.locale).toBe("en-US");
  expect(i18n._("common.appTitle")).toBe("Headscale UI");
});

test("does not expose an unloaded non-English translator during English startup", () => {
  expect(() => getLocaleI18n("ar")).toThrow("Catalog ar has not been loaded");
});

test("deduplicates pending catalogs and loads every supported translator without activation", async () => {
  const first = loadLocale("ar");
  expect(loadLocale("ar")).toBe(first);
  await first;
  await loadLocale("ar");
  await Promise.all(SUPPORTED_LOCALES.map(loadLocale));
  expect(i18n.locale).toBe("en-US");
  expect(getLocaleI18n("ar")._("common.light")).toBe("فاتح");
  expect(getLocaleI18n("ar")).toBe(getLocaleI18n("ar"));
  expect(getLocaleI18n("ar")._("common.missing-test")).toBe("missing-test");
  expect(getLocaleI18n("ar")._("product.missing-test")).toBe(
    "product.missing-test",
  );
});
