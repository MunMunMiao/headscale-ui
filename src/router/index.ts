import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  type RouterHistory,
  redirect,
} from "@tanstack/react-router";
import { createElement } from "react";
import ErrorScreen from "@/components/ErrorScreen";
import type { Session } from "@/composables/session-context";
import { useSessionRestore } from "@/composables/useSessionRestore";
import { parseSearch, stringifySearch } from "./search";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    requiresAuth?: boolean;
  }
}

const protectedPaths = new Set([
  "/",
  "/home",
  "/devices",
  "/members",
  "/invites",
  "/routes",
  "/access",
]);
interface Location {
  pathname: string;
  href: string;
  search: Record<string, unknown>;
}
export function guardRoute(
  session: Pick<Session, "auth">,
  location: Location,
): void {
  const pathname = location.pathname.replace(/\/+$/, "").toLowerCase() || "/";
  const requested =
    typeof location.search.profile === "string"
      ? location.search.profile
      : null;
  const current = session.auth.getSessionSnapshot();
  if (
    pathname === "/unlock" ||
    (protectedPaths.has(pathname) &&
      (session.auth.getSnapshot().status !== "ready-unlocked" ||
        current?.status !== "unlocked" ||
        (requested && current.profile?.id !== requested)))
  )
    throw redirect({
      to: "/login",
      search: {
        ...(requested ? { profile: requested } : {}),
        ...(pathname === "/unlock"
          ? location.search
          : { redirect: location.href }),
      },
      replace: true,
    });
}

function ApplicationRoot() {
  useSessionRestore();
  return createElement(Outlet);
}

export function createApplicationRouter(
  session: Session,
  history?: RouterHistory,
) {
  const root = createRootRouteWithContext<{ session: Session }>()({
    component: ApplicationRoot,
    validateSearch: (search: Record<string, unknown>) => search,
    beforeLoad: ({ context, location }) =>
      guardRoute(context.session, location),
  });
  const login = createRoute({
    getParentRoute: () => root,
    path: "/login",
    component: lazyRouteComponent(() => import("@/pages/LoginPage")),
  });
  const unlock = createRoute({
    getParentRoute: () => root,
    path: "/unlock",
  });
  const layout = createRoute({
    getParentRoute: () => root,
    id: "authenticated",
    staticData: { requiresAuth: true },
    component: lazyRouteComponent(() => import("@/pages/AppLayout")),
  });
  const index = createRoute({
    getParentRoute: () => layout,
    path: "/",
    beforeLoad: () => {
      throw redirect({ to: "/home", search: true, hash: true, replace: true });
    },
  });
  const pages = [
    createRoute({
      getParentRoute: () => layout,
      path: "/home",
      component: lazyRouteComponent(() => import("@/pages/HomePage")),
    }),
    createRoute({
      getParentRoute: () => layout,
      path: "/devices",
      component: lazyRouteComponent(() => import("@/pages/DevicesPage")),
    }),
    createRoute({
      getParentRoute: () => layout,
      path: "/members",
      component: lazyRouteComponent(() => import("@/pages/MembersPage")),
    }),
    createRoute({
      getParentRoute: () => layout,
      path: "/invites",
      component: lazyRouteComponent(() => import("@/pages/InvitesPage")),
    }),
    createRoute({
      getParentRoute: () => layout,
      path: "/routes",
      component: lazyRouteComponent(() => import("@/pages/RoutesPage")),
    }),
    createRoute({
      getParentRoute: () => layout,
      path: "/access",
      component: lazyRouteComponent(() => import("@/pages/AccessPage")),
    }),
  ];
  const legacy = createRoute({
    getParentRoute: () => root,
    path: "/$profileId",
    beforeLoad: ({ params }) => {
      throw redirect({
        to: "/home",
        search: { profile: params.profileId },
        replace: true,
      });
    },
  });
  const legacyGroup = createRoute({
    getParentRoute: () => root,
    path: "/$profileId/$group",
    beforeLoad: ({ params }) => {
      const target = `/${params.group}`;
      throw redirect({
        to: protectedPaths.has(target) ? target : "/login",
        search: protectedPaths.has(target) ? { profile: params.profileId } : {},
        replace: true,
      });
    },
  });
  const unknown = createRoute({
    getParentRoute: () => root,
    path: "/$",
    beforeLoad: () => {
      throw redirect({ to: "/login", replace: true });
    },
  });
  return createRouter({
    routeTree: root.addChildren([
      login,
      unlock,
      layout.addChildren([index, ...pages]),
      legacy,
      legacyGroup,
      unknown,
    ]),
    context: { session },
    defaultErrorComponent: ErrorScreen,
    history,
    basepath: import.meta.env.BASE_URL,
    parseSearch,
    stringifySearch,
  });
}
