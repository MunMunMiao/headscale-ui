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
import type { PublicSessionSnapshot, WorkerMessage } from "@/session/types";
import { profilesFixture } from "@/test/profiles-fixture";
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
  vi.restoreAllMocks();
  for (const stop of cleanup.reverse().splice(0)) await stop();
});
async function fixture(activate = true) {
  const host = await profilesFixture(cleanup);
  const initial = await host.bridge.listProfiles();
  expect.assert(initial.ok);
  const session = createSession({ bridge: host.bridge, profiles: initial.value });
  cleanup.push(session.start());
  const root = createRootRoute();
  const children = ["login", "secure", "secure-two", "public"].map((name) =>
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
    routeTree: root.addChildren(children),
  });
  await router.load();
  async function login() {
    session.profiles.setConnectionForm(host.form);
    await session.profiles.addProfile(true);
    await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
    expect(session.snapshot.getSnapshot().isAuthorized).toBe(true);
  }
  if (activate) await login();
  return {
    ...host,
    session,
    router,
    login,
    restoration: createSessionRestoration(session, router),
  };
}

test("a delayed locked authority reply cannot redirect a newer authenticated session", async () => {
  const f = await fixture(false);
  const send = f.ports.worker.postMessage.bind(f.ports.worker);
  const held = Promise.withResolvers<WorkerMessage>();
  let hold = true;
  vi.spyOn(f.ports.worker, "postMessage").mockImplementation((value: unknown) => {
    const message = value as WorkerMessage;
    if (
      hold &&
      message.type === "reply" &&
      message.result.ok &&
      (message.result.value as PublicSessionSnapshot)?.status === "locked"
    ) {
      hold = false;
      held.resolve(message);
    } else send(value);
  });
  const restoring = f.restoration.restore();
  const oldReply = await held.promise;
  await f.login();
  send(oldReply);
  await restoring;
  expect(f.router.state.location.pathname).toBe("/secure");
  expect(f.session.auth.getSessionSnapshot()?.status).toBe("unlocked");
});

test("a remote per-server password change locks the shared session and retains the protected redirect", async () => {
  const f = await fixture();
  const stop = f.restoration.start();
  cleanup.push(stop);
  const profile = f.session.profiles.selectedProfile;
  expect.assert(profile);
  const peer = await f.peer("owner-b");
  expect(await peer.profiles.changeProfilePassword(profile, f.form.password, "new-password")).toBe(
    true,
  );
  await expect.poll(() => f.router.state.location.pathname).toBe("/login");
  expect(f.router.state.location.search).toMatchObject({ redirect: "/secure" });
  expect(f.session.snapshot.getSnapshot().isAuthorized).toBe(false);
});

test("a peer server switch drops the obsolete profile route hint while preserving the current view", async () => {
  const f = await fixture();
  const original = f.session.auth.getSessionSnapshot()?.profile;
  expect.assert(original);
  await f.router.navigate({
    to: "/secure",
    search: { profile: original.id, filter: "open" },
    hash: "details",
  });
  cleanup.push(f.restoration.start());
  await f.restoration.restore();
  const peer = await f.peer("owner-b");
  peer.profiles.setConnectionForm({ ...f.form, profileName: "Peer server" });
  await peer.profiles.addProfile(true);
  expect(peer.feedback.getSnapshot().lastError).toBe("");
  await expect.poll(() => "profile" in f.router.state.location.search).toBe(false);
  expect(f.router.state.location.pathname).toBe("/secure");
  expect(f.router.state.location.search).toEqual({ filter: "open" });
  expect(f.router.state.location.hash).toBe("details");
  expect(f.session.auth.getSessionSnapshot()?.profile?.name).toBe("Peer server");
});

test("setup cleanup setup checks the authority without re-unlocking and cleanup releases route and lock listeners", async () => {
  const f = await fixture();
  const before = f.server.requests.length;
  f.restoration.start()();
  const stop = f.restoration.start();
  await f.restoration.restore();
  expect(f.server.requests).toHaveLength(before);
  await f.router.navigate({ to: "/secure-two" });
  await expect.poll(() => f.server.requests.length).toBe(before + 7);
  await expect.poll(() => f.session.snapshot.isRefreshing).toBe(false);
  stop();
  await f.session.profiles.logout();
  expect(f.router.state.location.pathname).toBe("/secure-two");
  await f.router.navigate({ to: "/public" });
  expect(f.server.requests).toHaveLength(before + 7);
});
