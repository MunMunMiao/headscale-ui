import { defineConfig } from "@lingui/conf";
import { formatter } from "@lingui/format-po";
import { SUPPORTED_LOCALES } from "./src/i18n/locales";

export default defineConfig({
  locales: [...SUPPORTED_LOCALES],
  sourceLocale: "en-US",
  fallbackLocales: false,
  catalogs: [{ path: "src/i18n/locales/{locale}/messages", include: ["src/i18n/descriptors.ts"] }],
  format: formatter({ lineNumbers: false, explicitIdAsDefault: true }),
  compileNamespace: "ts",
});
