import { pluralDescriptors } from "./descriptors";
import type { Locale } from "./locales";
import { getLocaleI18n } from "./runtime";

export type CountMessage = keyof typeof pluralDescriptors;

export function formatCount(
  locale: Locale,
  key: CountMessage,
  count: number,
): string {
  // Preserve legacy ASCII digits and ungrouped counts while ICU chooses the grammatical form.
  return getLocaleI18n(locale)._(pluralDescriptors[key].id, {
    count,
    formattedCount: String(count),
  });
}
