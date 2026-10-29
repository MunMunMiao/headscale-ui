export interface ConnectionSettings {
  baseUrl: string;
  apiKey: string;
}

function httpUrl(baseUrl: string): URL | null {
  const trimmed = baseUrl.trim();
  return /^https?:\/\//i.test(trimmed) && URL.canParse(trimmed)
    ? new URL(trimmed)
    : null;
}

export function connectionSettingsError(settings: ConnectionSettings) {
  const url = httpUrl(settings.baseUrl);
  if (!url) return "connectionInvalidUrl";
  // fetch refuses URLs with credentials, and requests drop the query and fragment.
  if (url.username || url.password || url.search || url.hash)
    return "connectionUrlParts";
  if (!settings.apiKey.trim()) return "connectionApiKeyRequired";
  return null;
}

/** The stored form of a server URL: its origin and path without trailing slashes. */
export function canonicalBaseUrl(baseUrl: string): string {
  const url = httpUrl(baseUrl);
  return (url ? url.origin + url.pathname : baseUrl.trim()).replace(/\/+$/, "");
}

/** Plain HTTP to another host sends the API key unencrypted over the network. */
export function sendsApiKeyInClear(baseUrl: string): boolean {
  const url = httpUrl(baseUrl);
  return (
    url?.protocol === "http:" &&
    !/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$|\.localhost$/.test(url.hostname)
  );
}
