import { useSearch } from "@tanstack/react-router";

/** Routes that participate in the cross-page `from`/`popup` protocol. */
type PageName = "home" | "devices" | "members" | "invites" | "routes" | "access";

/** Which detail dialog the destination page should auto-open on mount. */
type PopupKind = "user" | "node";

const PAGE_NAMES = new Set<PageName>(["home", "devices", "members", "invites", "routes", "access"]);
const POPUP_KINDS = new Set<PopupKind>(["user", "node"]);

/**
 * Narrow `unknown` (router query value) into a typed non-empty string. When
 * `allowed` is given the value must also be in that whitelist — the runtime
 * check doubles as the type predicate.
 */
function narrow<T extends string>(value: unknown, allowed?: ReadonlySet<T>): T | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (allowed && !allowed.has(value as T)) return null;
  return value as T;
}

interface RouteIntent {
  /** Source page the user navigated from; close-the-detail-dialog returns there. */
  from: PageName | null;
  /** Which detail dialog (if any) the page should auto-open. */
  popup: PopupKind | null;
  userId: string | null;
  nodeId: string | null;
  search: string | null;
  profileId: string | null;
}

/**
 * Type-safe accessor for the cross-page query protocol
 * (`?from=…&popup=…&user=…&node=…&search=…&profile=…`).
 */
export function useRouteIntent(): RouteIntent {
  const query = useSearch({ strict: false }) as Record<string, unknown>;
  return {
    from: narrow(query.from, PAGE_NAMES),
    popup: narrow(query.popup, POPUP_KINDS),
    userId: narrow(query.user),
    nodeId: narrow(query.node),
    search: narrow(query.search),
    profileId: narrow(query.profile),
  };
}
