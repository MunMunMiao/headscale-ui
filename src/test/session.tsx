import type { FetchHandle } from "@defjs/core";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { afterEach, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import { SessionProviders as SessionTestProviders } from "@/AppProviders";
import { createSession, type Session } from "@/composables/session-context";
import { applyStoredLocale } from "@/i18n";
import { clearAllSecureData } from "@/lib/secure-storage";
import { hydrateSettings } from "@/lib/settings-storage";
import { parseSearch, stringifySearch } from "@/router/search";
import { createSessionHarness } from "./session-host";

export { SessionTestProviders };

const sessions: Awaited<ReturnType<typeof createSessionHarness>>[] = [];
afterEach(async () => {
  await cleanup();
  for (const harness of sessions.splice(0)) await harness.dispose();
});

/**
 * HTTP-boundary harness on an in-page session host. It validates UI handling and
 * contract validation only; it is NOT SharedWorker fault evidence (see dev.md).
 * Worker fault evidence lives in e2e/.
 */
export async function prepareTestSession(transport?: FetchHandle): Promise<Session> {
  if (transport)
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => transport(input, init));
  await clearAllSecureData();
  await hydrateSettings();
  await applyStoredLocale();
  const harness = await createSessionHarness();
  sessions.push(harness);
  return createSession(await harness.openPage());
}

export async function authenticateTestSession(
  session: Session,
  baseUrl = "https://fixture.invalid",
  apiKey = "isolated-test-key",
) {
  await session.profiles.loadProfile("__new__");
  session.profiles.setConnectionForm({
    profileName: "Test server",
    baseUrl,
    apiKey,
    password: "isolated-test-password",
  });
  await session.profiles.addProfile(true);
  if (session.auth.getSessionSnapshot()?.status !== "unlocked")
    throw new Error(session.feedback.getSnapshot().lastError || "Fixture authentication failed");
}

export async function renderSessionPage(session: Session, element: ReactNode, path = "/") {
  const root = createRootRoute({ component: Outlet });
  const pathname = new URL(path, "http://test.local").pathname;
  const paths = new Set([
    "/",
    "/home",
    "/devices",
    "/members",
    "/invites",
    "/routes",
    "/access",
    "/login",
    "/unlock",
    pathname,
  ]);
  const children = [...paths].map((routePath) =>
    createRoute({
      getParentRoute: () => root,
      path: routePath,
      component: () =>
        routePath === pathname ? element : <div data-testid="test-route">{routePath}</div>,
    }),
  );
  const router = createRouter({
    parseSearch,
    stringifySearch,
    routeTree: root.addChildren(children),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  const result = await render(
    <SessionTestProviders session={session}>
      <RouterProvider router={router} />
    </SessionTestProviders>,
  );
  return { ...result, router };
}
