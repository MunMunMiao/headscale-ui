/**
 * Trim a base URL: removes outer whitespace and a single trailing slash.
 * `http://x.com/` → `http://x.com`
 */
export function normalizedBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/$/, "");
}

/**
 * Truncate long secrets for table display while keeping head + tail for recognition.
 * `<= 18` chars are returned as-is; longer values become `<first-12>...<last-4>`.
 * Returns `fallback` for empty input.
 */
export function shortSecret(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  if (value.length <= 18) return value;
  return `${value.slice(0, 12)}...${value.slice(-4)}`;
}

export function parseList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isHttpUrl(value: string): boolean {
  const url = value.trim();
  return /^https?:\/\//i.test(url) && URL.canParse(url);
}

export function tailscaleUpCommand(
  baseUrl: string,
  authKey: string,
  advertiseExitNode = false,
): string {
  const command = `tailscale up --login-server ${normalizedBaseUrl(baseUrl)} --authkey ${authKey}`;
  return advertiseExitNode ? `${command} --advertise-exit-node` : command;
}
