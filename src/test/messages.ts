import { commonDescriptors, type MessageKey } from "@/i18n/descriptors";
import type { Locale } from "@/i18n/locales";
import { getLocaleI18n } from "@/i18n/runtime";

// Test-only: reads a common message in any loaded locale without activating it.
export function getMessage(
  locale: Locale,
  key: MessageKey,
  named?: Record<string, string | number>,
): string {
  return getLocaleI18n(locale)._(commonDescriptors[key].id, {
    name: "{name}",
    count: "{count}",
    ...named,
  });
}
