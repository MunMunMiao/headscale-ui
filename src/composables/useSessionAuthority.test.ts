import "fake-indexeddb/auto";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { __resetForTest } from "@/lib/idb";
import { hydrateSettings, settingsStorageTestingHandle } from "@/lib/settings-storage";
import { createSessionHarness } from "@/test/session-host";
import { startSnapshotServer } from "@/test-utils/headscale.test";
import { createSession } from "./session-context";
import { createSessionRestoration } from "./useSessionRestore";

const cleanup: (() => void | Promise<void>)[] = [];
beforeEach(async () => {
  __resetForTest();
  globalThis.indexedDB = new IDBFactory();
  settingsStorageTestingHandle.reset();
  await hydrateSettings();
});
afterEach(async () => {
  for (const stop of cleanup.reverse().splice(0)) await stop();
  vi.restoreAllMocks();
});
async function fixture(path = "/secure") {
  const harness = await createSessionHarness();
  cleanup.push(() => harness.dispose());
  const session = createSession(await harness.openPage());
  cleanup.push(session.start());
  const root = createRootRoute();
  const children = ["/login", "/secure", "/secure-two", "/public"].map((path) =>
    createRoute({
      getParentRoute: () => root,
      path,
      component: () => null,
      staticData: { requiresAuth: path.startsWith("/secure") },
    }),
  );
  const router = createRouter({
    isServer: false,
    origin: "http://localhost",
    history: createMemoryHistory({ initialEntries: [path] }),
    routeTree: root.addChildren(children),
  });
  await router.load();
  const server = startSnapshotServer();
  cleanup.push(server.stop);
  async function save(activate = false) {
    session.profiles.setConnectionForm({
      profileName: "A",
      baseUrl: server.baseUrl,
      apiKey: "authority-key",
      password: "authority-password",
    });
    await session.profiles.addProfile(activate);
  }
  return { session, router, server, save };
}
test("restoration only checks shared authority and never unlocks a stored profile or URL request", async () => {
  const { session, router, server, save } = await fixture("/secure?profile=a");
  await save();
  const calls = server.requests.length;
  await createSessionRestoration(session, router).restore();
  expect(router.state.location.pathname).toBe("/login");
  expect(session.auth.getSessionSnapshot()?.status).toBe("locked");
  expect(server.requests).toHaveLength(calls);
});
test("route refresh and a remote shared lock are wired without losing the destination", async () => {
  const { session, router, server, save } = await fixture();
  await save(true);
  await expect.poll(() => session.snapshot.getSnapshot().snapshot.users.length).toBe(1);
  const restoration = createSessionRestoration(session, router);
  cleanup.push(restoration.start());
  const calls = server.requests.length;
  await router.navigate({ to: "/secure-two" });
  await expect.poll(() => server.requests.length).toBe(calls + 7);
  await session.auth.lock(session.auth.getSessionSnapshot()?.identity ?? null);
  await expect.poll(() => router.state.location.pathname).toBe("/login");
  expect(router.state.location.search).toMatchObject({ redirect: "/secure-two" });
});
test("a delayed check from a locked page cannot redirect a later unlocked session", async () => {
  const { session, router, save } = await fixture();
  const check = session.auth.check;
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  vi.spyOn(session.auth, "check").mockImplementationOnce(async () => {
    const result = await check();
    started.resolve();
    await release.promise;
    return result;
  });
  const restoration = createSessionRestoration(session, router);
  const restoring = restoration.restore();
  await started.promise;
  await save(true);
  release.resolve();
  await restoring;
  expect(router.state.location.pathname).toBe("/secure");
});
