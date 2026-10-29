const SESSION_TAB_ID_KEY = "headscale-ui-tab-id";
let volatileOwner: string | null = null;

export function getOrCreateTabOwnerId(): string {
  if (typeof sessionStorage === "undefined") {
    volatileOwner ??= crypto.randomUUID();
    return volatileOwner;
  }
  const existing = sessionStorage.getItem(SESSION_TAB_ID_KEY);
  if (existing) return existing;
  const owner = crypto.randomUUID();
  sessionStorage.setItem(SESSION_TAB_ID_KEY, owner);
  return owner;
}
