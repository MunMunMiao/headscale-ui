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

type NavigationProfile = { id: string; baseUrl: string };

/** Continue on the chosen server, retaining ordinary filters but not foreign entity intent. */
export function redirectTarget(
  redirect: unknown,
  profile: string | NavigationProfile | null | undefined,
  previousProfile?: NavigationProfile | null,
) {
  const target = URL.parse(
    typeof redirect === "string" ? redirect : "/",
    "http://headscale.local",
  );
  if (!target || !profile || isLoginPath(target.pathname))
    return { to: "/", search: {}, hash: "", replace: true };
  const profileId = typeof profile === "string" ? profile : profile.id;
  const pinned = target.searchParams.get("profile");
  const foreignPin = pinned !== null && pinned !== profileId;
  const changed =
    previousProfile &&
    typeof profile !== "string" &&
    (previousProfile.id === profile.id
      ? previousProfile.baseUrl !== profile.baseUrl
      : pinned === null);
  let hash = target.hash.slice(1);
  if (foreignPin || changed) {
    if (
      foreignPin ||
      [
        "user",
        "node",
        "popup",
        "from",
        "returnSearch",
        "migrateFrom",
        "migrateTo",
        "maintenance",
      ].some((key) => target.searchParams.has(key))
    )
      hash = "";
    for (const key of [
      "profile",
      "user",
      "node",
      "popup",
      "from",
      "returnSearch",
      "migrateFrom",
      "migrateTo",
      "maintenance",
    ])
      target.searchParams.delete(key);
  }
  return {
    to: target.pathname,
    search: parseSearch(target.search),
    hash,
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
