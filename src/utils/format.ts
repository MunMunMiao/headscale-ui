export const DATE_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  dateStyle: "medium",
  timeStyle: "short",
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(locale: string) {
  let formatter = formatters.get(locale);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, DATE_TIME_FORMAT);
    formatters.set(locale, formatter);
  }
  return formatter;
}

/**
 * Format an ISO date string for table cells. Returns `fallback` for empty input,
 * the raw value when un-parseable, otherwise a locale-aware date+time that includes the year.
 */
export function formatDate(
  value: string | null | undefined,
  locale: string,
  fallback: string,
): string {
  if (!value) return fallback;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value;
  return dateFormatter(locale).format(new Date(time));
}
