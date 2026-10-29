import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { expect } from "vitest";
import { createSession } from "@/composables/session-context";
import { newProfileId } from "@/composables/useProfiles";
import { createSessionRestoration } from "@/composables/useSessionRestore";
import { createSessionHarness } from "@/test/session-host";
import { startSnapshotServer } from "@/test-utils/headscale.test";

export const defaultPolicy =
  '{"acls":[{"action":"accept","src":["*"],"dst":["*:*"]}]}';

export async function sessionPolicyFixture(
  cleanup: (() => void | Promise<void>)[],
  policyText = defaultPolicy,
) {
  const harness = await createSessionHarness();
  cleanup.push(() => harness.dispose());
  const session = createSession(await harness.openPage("policy-page"));
  cleanup.push(session.start());
  function server(policy: string) {
    const upstream = startSnapshotServer();
    cleanup.push(upstream.stop);
    upstream.snapshot.policy = { policy };
    let gate: {
      method: string;
      entered: ReturnType<typeof Promise.withResolvers<string>>;
      release: ReturnType<typeof Promise.withResolvers<Response | undefined>>;
    } | null = null;
    const writes: string[] = [];
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        let text = "";
        if (request.method === "PUT") {
          text = (await request.clone().json()).policy;
          writes.push(text);
        }
        const body = request.body ? await request.arrayBuffer() : undefined;
        const forward = () =>
          fetch(`${upstream.baseUrl}${path}`, {
            method: request.method,
            headers: request.headers,
            body,
          });
        if (
          path !== "/api/v1/policy" ||
          !gate ||
          gate.method !== request.method
        )
          return forward();
        const pending = gate;
        gate = null;
        const read = request.method === "GET" ? await forward() : null;
        pending.entered.resolve(text);
        const override = await pending.release.promise;
        return override ?? read ?? forward();
      },
    });
    cleanup.push(() => proxy.stop(true));
    return {
      ...upstream,
      baseUrl: proxy.url.origin,
      writes,
      holdNext(method: "GET" | "PUT") {
        const pending = {
          method,
          entered: Promise.withResolvers<string>(),
          release: Promise.withResolvers<Response | undefined>(),
        };
        gate = pending;
        cleanup.push(() => {
          pending.release.resolve(undefined);
        });
        return {
          entered: pending.entered.promise,
          release: (response?: Response) => pending.release.resolve(response),
        };
      },
    };
  }
  const first = server(policyText);
  const password = "policy-fixture-password";
  async function saveProfile(
    target: ReturnType<typeof server>,
    name: string,
    activate: boolean,
  ) {
    await session.profiles.loadProfile(newProfileId);
    session.profiles.setConnectionForm({
      profileName: name,
      baseUrl: target.baseUrl,
      apiKey: `fixture-${name}-key`,
      password,
      remember: true,
    });
    if (activate) await session.profiles.addProfile(true);
    else await session.profiles.persistConnection();
    const profile = session.profiles.selectedProfile;
    expect.assert(profile);
    return profile;
  }
  const profile = await saveProfile(first, "A", true);
  await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
  expect(session.snapshot.getSnapshot().isAuthorized).toBe(true);
  const root = createRootRoute();
  const routes = ["login", "secure", "secure-two", "public"].map((name) =>
    createRoute({
      getParentRoute: () => root,
      path: `/${name}`,
      component: () => null,
      staticData: { requiresAuth: name.startsWith("secure") },
    }),
  );
  const router = createRouter({
    isServer: false,
    origin: "http://localhost",
    history: createMemoryHistory({ initialEntries: ["/secure"] }),
    routeTree: root.addChildren(routes),
  });
  await router.load();
  const restoration = createSessionRestoration(session, router);
  cleanup.push(restoration.start());
  async function switchTo(policy: string) {
    const next = server(policy);
    const nextProfile = await saveProfile(next, "B", false);
    expect(await session.profiles.enterProfile(nextProfile, password)).toBe(
      true,
    );
    await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
    return { server: next, profile: nextProfile };
  }
  return {
    session,
    server: first,
    profile,
    password,
    router,
    restoration,
    switchTo,
  };
}
