/**
 * Prefix `apikey list` prints for a full API key (Headscale v0.29.4 types/api_key.go Proto()):
 * new keys `hskey-api-<12>-***`, legacy keys `<7>***`. The 12-char part may itself contain
 * '-' and '_', so only fixed lengths are used. Returns null when the key has neither shape.
 */
export function listedApiKeyPrefix(apiKey: string): string | null {
  if (apiKey.startsWith("hskey-api-")) {
    const rest = apiKey.slice(10);
    return rest.length > 12 && rest[12] === "-" ? `hskey-api-${rest.slice(0, 12)}-***` : null;
  }
  return apiKey.indexOf(".") === 7 ? `${apiKey.slice(0, 7)}***` : null;
}
