// Existing shared links use URL strings, including numeric user and node IDs.
export function parseSearch(search: string): Record<string, string | string[]> {
  const params = new URLSearchParams(search);
  const result: Record<string, string | string[]> = Object.create(null);
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    result[key] = values.length === 1 ? values[0] : values;
  }
  return result;
}

const loginPaths = new Set(["/login", "/unlock"]);
export function isLoginPath(pathname: string): boolean {
  return loginPaths.has(pathname.replace(/\/+$/, "").toLowerCase());
}

/** Where a page continues once `profileId` is unlocked: its `redirect`, never a login screen. */
export function redirectTarget(redirect: unknown, profileId: string) {
  const target = new URL(typeof redirect === "string" ? redirect : "/", "http://headscale.local");
  const pinned = target.searchParams.get("profile");
  // A redirect pinned to a different or stale profile would bounce back to /login via guardRoute,
  // and its ids and hash belong to another server.
  const foreign = pinned !== null && pinned !== profileId;
  if (isLoginPath(target.pathname)) return { to: "/", search: {}, hash: "", replace: true };
  return {
    to: target.pathname,
    search: foreign ? {} : parseSearch(target.search),
    hash: foreign ? "" : target.hash.slice(1),
    replace: true,
  };
}

export function stringifySearch(search: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      params.append(key, item == null ? "" : String(item));
    }
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}
