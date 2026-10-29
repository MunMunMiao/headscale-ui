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
import {
  hydrateSettings,
  settingsStorageTestingHandle,
} from "@/lib/settings-storage";
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
  const session = createSession({
    bridge: host.bridge,
    profiles: initial.value,
  });
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
  vi.spyOn(f.ports.worker, "postMessage").mockImplementation(
    (value: unknown) => {
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
    },
  );
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
  expect(
    await peer.profiles.changeProfilePassword(
      profile,
      f.form.password,
      "new-password",
    ),
  ).toBe(true);
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
  await expect
    .poll(() => "profile" in f.router.state.location.search)
    .toBe(false);
  expect(f.router.state.location.pathname).toBe("/secure");
  expect(f.router.state.location.search).toEqual({ filter: "open" });
  // As with login redirects, a foreign pin's hash is not reused on another server.
  expect(f.router.state.location.hash).toBe("");
  expect(f.session.auth.getSessionSnapshot()?.profile?.name).toBe(
    "Peer server",
  );
});

test.each([false, true])(
  "a peer switch removes the previous server's entity intent (pinned: %s)",
  async (pinned) => {
    const f = await fixture();
    const original = f.session.auth.getSessionSnapshot()?.profile;
    expect.assert(original);
    await f.router.navigate({
      to: "/secure",
      search: {
        ...(pinned ? { profile: original.id } : {}),
        node: "7",
        user: "1",
        popup: "node",
        from: "members",
        filter: "online",
      },
      hash: "details",
    });
    cleanup.push(f.restoration.start());
    const peer = await f.peer("switch-peer");
    peer.profiles.setConnectionForm({ ...f.form, profileName: "B" });
    await peer.profiles.addProfile(true);
    await expect
      .poll(() => f.router.state.location.search, { timeout: 1000 })
      .toEqual({ filter: "online" });
    expect(f.router.state.location.hash).toBe("");
  },
);

test("a same-server re-unlock preserves a pinned entity route", async () => {
  const f = await fixture();
  const profile = f.session.profiles.getSnapshot().profiles[0];
  expect.assert(profile);
  const search = {
    profile: profile.id,
    node: "7",
    popup: "node",
    filter: "online",
  };
  await f.router.navigate({ to: "/secure", search, hash: "details" });
  cleanup.push(f.restoration.start());
  const peer = await f.peer("same-server-peer");
  expect(await peer.profiles.enterProfile(profile, f.form.password)).toBe(true);
  await f.restoration.restore();
  expect(f.router.state.location.search).toEqual(search);
  expect(f.router.state.location.hash).toBe("details");
});

test("logout followed by a peer unlocking another server strips unpinned entity intent", async () => {
  const f = await lockedOnLogin();
  const peer = await f.peer("different-server-peer");
  peer.profiles.setConnectionForm({ ...f.form, profileName: "B" });
  await peer.profiles.addProfile(true);
  await expect.poll(() => f.router.state.location.pathname).toBe("/secure");
  expect(f.router.state.location.search).toEqual({});
  expect(f.router.state.location.hash).toBe("");
});

test("a lock that arrives while the page is already leaving for login keeps the page it left", async () => {
  const f = await fixture();
  const held = Promise.withResolvers<void>();
  const root = createRootRoute();
  const router = createRouter({
    isServer: false,
    origin: "http://localhost",
    history: createMemoryHistory({ initialEntries: ["/secure"] }),
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/secure",
        staticData: { requiresAuth: true },
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/login",
        beforeLoad: () => held.promise,
      }),
    ]),
  });
  await router.load();
  cleanup.push(createSessionRestoration(f.session, router).start());
  const leaving = router.navigate({
    to: "/login",
    search: { redirect: "/secure" },
  });
  await f.session.profiles.logout();
  held.resolve();
  await leaving;
  await expect.poll(() => router.state.status).toBe("idle");
  expect(router.state.location.pathname).toBe("/login");
  expect(router.state.location.search).toEqual({ redirect: "/secure" });
});

async function lockedOnLogin() {
  const f = await fixture();
  const profile = f.session.profiles.getSnapshot().profiles[0];
  expect.assert(profile);
  // The fixture router keeps TanStack's JSON search format, so a number stays unquoted.
  await f.router.navigate({ to: "/secure", search: { node: 7 }, hash: "d" });
  cleanup.push(f.restoration.start());
  await f.session.profiles.logout();
  await expect.poll(() => f.router.state.location.pathname).toBe("/login");
  const peer = await f.peer("owner-b");
  return {
    ...f,
    profile,
    unlockPeer: () => peer.profiles.enterProfile(profile, f.form.password),
  };
}

test("a login page continues to its redirect target when another tab unlocks", async () => {
  const f = await lockedOnLogin();
  await f.session.profiles.enterProfile(f.profile);
  expect(f.session.profiles.getSnapshot().unlockProfile?.id).toBe(f.profile.id);
  expect(await f.unlockPeer()).toBe(true);
  await expect.poll(() => f.router.state.location.pathname).toBe("/secure");
  expect(f.router.state.location.search).toEqual({ node: "7" });
  expect(f.router.state.location.hash).toBe("d");
  expect(f.session.profiles.getSnapshot().unlockProfile).toBeNull();
});

test.each(["connection dialog", "discarded edits"] as const)(
  "a login page with a %s waits for the user when another tab unlocks",
  async (reason) => {
    const f = await lockedOnLogin();
    f.session.profiles.setState(
      reason === "connection dialog"
        ? { connectionDialogOpen: true }
        : { discardedPolicyDraft: true },
    );
    expect(await f.unlockPeer()).toBe(true);
    await expect
      .poll(() => f.session.snapshot.getSnapshot().isAuthorized)
      .toBe(true);
    expect(f.router.state.location.pathname).toBe("/login");
  },
);

test("peer follow falls back safely for a malformed redirect", async () => {
  const f = await lockedOnLogin();
  await f.router.navigate({ to: "/login", search: { redirect: "http://[" } });
  expect(await f.unlockPeer()).toBe(true);
  await expect
    .poll(() => f.router.state.location.pathname, { timeout: 1000 })
    .toBe("/");
  expect(f.router.state.location.search).toEqual({});
});

test("this tab's own unlock leaves navigation to the page that started it", async () => {
  const f = await lockedOnLogin();
  expect(
    await f.session.profiles.enterProfile(f.profile, f.form.password),
  ).toBe(true);
  expect(f.router.state.location.pathname).toBe("/login");
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
