import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { i18n, setLocale, t } from "@/i18n";
import { __resetForTest, openHeadscaleDb, STORE_PROFILES } from "@/lib/idb";
import { hydrateSettings, settingsStorageTestingHandle } from "@/lib/settings-storage";
import { createSessionHarness } from "@/test/session-host";
import { startSnapshotServer } from "@/test-utils/headscale.test";
import { createSession, useSession } from "./session-context";

const cleanup: (() => void | Promise<void>)[] = [];
beforeEach(async () => {
  __resetForTest();
  settingsStorageTestingHandle.reset();
  globalThis.indexedDB = new IDBFactory();
  await hydrateSettings();
});
afterEach(async () => {
  for (const stop of cleanup.reverse().splice(0)) await stop();
  vi.restoreAllMocks();
});
async function fixture() {
  const host = await createSessionHarness();
  cleanup.push(() => host.dispose());
  async function page(owner: string) {
    const session = createSession(await host.openPage(owner));
    cleanup.push(session.start());
    return session;
  }
  const first = await page("owner-a");
  const server = startSnapshotServer();
  cleanup.push(server.stop);
  first.profiles.setConnectionForm({
    profileName: "Shared server",
    baseUrl: server.baseUrl,
    apiKey: "projection-key",
    password: "projection-password",
    remember: false,
  });
  await first.profiles.addProfile(true);
  return { host, page, first, server };
}
test("the page adopts the shared authority even when another owner owns the active temporary profile", async () => {
  const { page, first, server } = await fixture();
  await expect.poll(() => first.snapshot.getSnapshot().snapshot.users.length).toBe(1);
  const second = await page("owner-b");
  expect(second.profiles.getSnapshot().profiles).toEqual([]);
  expect(second.snapshot.getSnapshot().isAuthorized).toBe(true);
  expect(second.client.getSnapshot().identity).toEqual(first.client.getSnapshot().identity);
  await expect.poll(() => second.snapshot.getSnapshot().snapshot.nodes.length).toBe(2);
  expect(second.client.getSnapshot().settings).toEqual({ baseUrl: server.baseUrl });
  expect("masterPassword" in second).toBe(false);
});
test("reconnecting clears the old gateway until the same Worker proves its current identity", async () => {
  const { first } = await fixture();
  await expect.poll(() => first.snapshot.isRefreshing).toBe(false);
  const identity = first.client.getSnapshot().identity;
  const reconnecting = first.auth.reconnect();
  expect(first.client.getSnapshot().identity).toBeNull();
  expect(first.snapshot.getSnapshot().isAuthorized).toBe(false);
  expect(first.snapshot.getSnapshot().isReady).toBe(false);
  expect((await reconnecting).ok).toBe(true);
  await expect.poll(() => first.snapshot.getSnapshot().isReady).toBe(true);
  expect(first.client.getSnapshot().identity).toEqual(identity);
  expect(first.client.getSnapshot().identity).not.toBe(identity);
});
test("a failed profile read after committed reset remains visible while the page stays locked", async () => {
  const { first } = await fixture();
  await expect.poll(() => first.snapshot.isRefreshing).toBe(false);
  let failReads = false;
  cleanup.push(
    first.auth.subscribeReset(() => {
      failReads = true;
    }),
  );
  const getAll = IDBObjectStore.prototype.getAll;
  let failures = 0;
  vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    if (failReads && this.name === STORE_PROFILES) {
      ++failures;
      throw new DOMException("reset projection read denied", "UnknownError");
    }
    return Reflect.apply(getAll, this, args);
  });
  expect((await first.profiles.resetLocalData()).committed).toBe(true);
  await expect.poll(() => first.feedback.getSnapshot().lastError).toBe(t("storageWrite"));
  expect(failures).toBeGreaterThan(0);
  expect(first.auth.getSnapshot().status).toBe("ready-locked");
  expect(first.profiles.getSnapshot().profiles).toEqual([]);
  expect(first.snapshot.getSnapshot().isAuthorized).toBe(false);
  failReads = false;
  expect(await (await openHeadscaleDb()).count(STORE_PROFILES)).toBe(0);
});
test("reset clears every page draft and preferences before reconnecting to the locked authority", async () => {
  const { first, page } = await fixture();
  const second = await page("owner-b");
  second.profiles.setConnectionForm({
    profileName: "Discard after reset",
    apiKey: "draft-secret",
    password: "draft-password",
  });
  second.profiles.setState({ connectionDialogOpen: true });
  await second.theme.setTheme("dark");
  await setLocale("ar");
  const reconnect = vi.spyOn(second.auth, "reconnect");
  await first.profiles.resetLocalData();
  await expect.poll(() => second.profiles.getSnapshot().connectionDialogOpen).toBe(false);
  expect(second.profiles.getSnapshot().connectionForm).toMatchObject({
    profileName: "",
    apiKey: "",
    password: "",
  });
  expect(second.theme.getSnapshot()).toMatchObject({ colorMode: "auto", themeError: null });
  await expect.poll(() => i18n.locale).toBe("en-US");
  await expect.poll(() => reconnect.mock.calls.length).toBe(1);
  await expect.poll(() => second.auth.getSnapshot().status).toBe("ready-locked");
  const profiles = await second.auth.listProfiles();
  expect(profiles).toMatchObject({ ok: true, value: { profiles: [], unreadableRecords: 0 } });
  expect(second.client.getSnapshot().identity).toBeNull();
});
test("a shared switch retains ordinary drafts behind a stale gate and clears generated secrets", async () => {
  const { first, server } = await fixture();
  await expect.poll(() => first.snapshot.isRefreshing).toBe(false);
  first.policy.setState({ policyDraft: "unfinished policy", teamDetailOpen: true });
  first.deviceSetup.setState({
    lastCreatedInvite: "one-time-result",
    open: true,
    pendingRegistrationForm: { user: "alice", key: "hskey-authreq-secret", kind: "ssh" },
    lastAuthDecision: "approved",
  });
  await first.profiles.loadProfile("__new__");
  first.profiles.setConnectionForm({
    profileName: "Second server",
    baseUrl: server.baseUrl,
    apiKey: "second-key",
    password: "second-password",
  });
  await first.profiles.addProfile(true);
  expect(first.policy.getSnapshot().policyDraft).toBe("unfinished policy");
  expect(first.policy.getSnapshot().teamDetailOpen).toBe(true);
  expect(first.deviceSetup.getSnapshot().lastCreatedInvite).toBe("");
  expect(first.deviceSetup.getSnapshot().pendingRegistrationForm).toEqual({
    user: "alice",
    key: "",
    kind: "ssh",
  });
  expect(first.deviceSetup.getSnapshot().lastAuthDecision).toBeNull();
  expect(first.drafts.getSnapshot().stale?.name).toBe("Shared server");
  expect(first.drafts.isCurrent()).toBe(false);
});
test("touch keeps page data and drafts; a shared lock clears connection data and one-time business credentials", async () => {
  const { page, first } = await fixture();
  const second = await page("owner-b");
  await expect.poll(() => first.snapshot.getSnapshot().snapshot.users.length).toBe(1);
  const adopted = first.client.getSnapshot().identity;
  const data = first.snapshot.getSnapshot().snapshot;
  first.policy.setState({ teamDetailOpen: true });
  first.deviceSetup.setState({
    lastCreatedInvite: "business-one-time-key",
    open: true,
    pendingRegistrationForm: { user: "alice", key: "hskey-authreq-secret", kind: "ssh" },
    lastAuthDecision: "rejected",
  });
  const identity = first.auth.getSessionSnapshot()?.identity;
  if (!identity) throw new Error("Expected shared identity");
  expect((await first.auth.touch(identity)).ok).toBe(true);
  expect(first.client.getSnapshot().identity).toBe(adopted);
  expect(first.snapshot.getSnapshot().snapshot).toBe(data);
  expect(first.policy.getSnapshot().teamDetailOpen).toBe(true);
  await second.profiles.logout();
  await expect.poll(() => first.snapshot.getSnapshot().isAuthorized).toBe(false);
  expect(first.snapshot.getSnapshot().snapshot.users).toEqual([]);
  expect(first.deviceSetup.getSnapshot().lastCreatedInvite).toBe("");
  expect(first.deviceSetup.getSnapshot().pendingRegistrationForm).toEqual({
    user: "",
    key: "",
    kind: "device",
  });
  expect(first.deviceSetup.getSnapshot().lastAuthDecision).toBeNull();
  expect(first.policy.getSnapshot().teamDetailOpen).toBe(false);
});
test("a same-server re-unlock keeps drafts and data, clears generated secrets and refreshes", async () => {
  const { first, server } = await fixture();
  await expect.poll(() => first.snapshot.getSnapshot().isReady).toBe(true);
  await expect.poll(() => first.snapshot.isRefreshing).toBe(false);
  const profile = first.profiles.getSnapshot().profiles[0];
  if (!profile) throw new Error("Expected the temporary profile");
  const editor = {};
  first.drafts.setActive(editor, true);
  first.policy.setState({ policyDraft: "unfinished policy" });
  first.deviceSetup.setState({
    lastCreatedInvite: "one-time-result",
    pendingRegistrationForm: { user: "alice", key: "hskey-authreq-secret", kind: "ssh" },
    lastAuthDecision: "approved",
  });
  const identity = first.client.getSnapshot().identity;
  const seen: { isReady: boolean; users: number }[] = [];
  cleanup.push(
    first.snapshot.subscribe(() => {
      const { isReady, snapshot } = first.snapshot.getSnapshot();
      seen.push({ isReady, users: snapshot.users.length });
    }),
  );
  const requests = server.requests.length;

  expect(await first.profiles.enterProfile(profile, "projection-password")).toBe(true);

  expect(first.client.getSnapshot().identity).not.toEqual(identity);

  expect(first.drafts.isCurrent()).toBe(true);
  expect(first.drafts.getSnapshot().stale).toBeNull();
  expect(first.policy.getSnapshot().policyDraft).toBe("unfinished policy");
  expect(first.deviceSetup.getSnapshot().lastCreatedInvite).toBe("");
  expect(first.deviceSetup.getSnapshot().pendingRegistrationForm).toEqual({
    user: "alice",
    key: "",
    kind: "ssh",
  });
  expect(first.deviceSetup.getSnapshot().lastAuthDecision).toBeNull();
  expect(first.snapshot.getSnapshot()).toMatchObject({ isAuthorized: true, isReady: true });
  expect(first.snapshot.getSnapshot().snapshot.users).toHaveLength(1);
  await expect.poll(() => server.requests.length).toBeGreaterThan(requests);
  await expect.poll(() => first.snapshot.isRefreshing).toBe(false);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((item) => item.isReady && item.users === 1)).toBe(true);
});

test("a reset delivered to a page that stopped in the same tick does not reconnect it", async () => {
  const { first, host } = await fixture();
  const second = createSession(await host.openPage("owner-b"));
  const stop = second.start();
  cleanup.push(stop);
  const reconnect = vi.spyOn(second.auth, "reconnect");
  // Listeners run in subscription order, so this stops the page right after its own listener.
  cleanup.push(second.auth.subscribeReset(stop));
  const projection = vi.spyOn(second.profiles, "resetProjection");
  await first.profiles.resetLocalData();
  await expect.poll(() => projection.mock.calls.length).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(reconnect).not.toHaveBeenCalled();
});

// Deterministic coverage of the post-reconnect guard: a failed reconnect must not reload profiles.
test("a reset whose reconnect fails leaves profiles unloaded", async () => {
  const { first, page } = await fixture();
  const second = await page("owner-b");
  const reconnect = vi
    .spyOn(second.auth, "reconnect")
    .mockResolvedValue({ ok: false, error: { kind: "unavailable" } });
  const reload = vi.spyOn(second.profiles, "reloadProfiles");
  await first.profiles.resetLocalData();
  await expect.poll(() => reconnect.mock.calls.length).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(reload).not.toHaveBeenCalled();
});

// A page created before another tab re-unlocks the same server only learns of it when it starts.
test("starting after a same-server re-unlock adopts the new identity and refreshes exactly once", async () => {
  const { first, host } = await fixture();
  await expect.poll(() => first.snapshot.getSnapshot().isReady).toBe(true);
  const profile = first.profiles.getSnapshot().profiles[0];
  if (!profile) throw new Error("Expected the temporary profile");
  const second = createSession(await host.openPage("owner-b"));
  const staleIdentity = second.client.getSnapshot().identity;
  expect(await first.profiles.enterProfile(profile, "projection-password")).toBe(true);
  const identity = first.client.getSnapshot().identity;
  expect(identity).not.toEqual(staleIdentity);
  await expect.poll(() => second.auth.getSessionSnapshot()?.identity).toEqual(identity);
  expect(second.client.getSnapshot().identity).toEqual(staleIdentity);
  const refresh = vi.spyOn(second.snapshot, "refreshSnapshot");
  cleanup.push(second.start());
  expect(second.client.getSnapshot().identity).toEqual(identity);
  expect(second.snapshot.getSnapshot().isAuthorized).toBe(true);
  expect(refresh).toHaveBeenCalledTimes(1);
  await expect.poll(() => second.snapshot.getSnapshot().isReady).toBe(true);
  expect(second.snapshot.getSnapshot().snapshot.users).toHaveLength(1);
  expect(refresh).toHaveBeenCalledTimes(1);
});

test("discarding drafts after the server data was cleared empties the policy draft", async () => {
  const { first, page } = await fixture();
  const second = await page("owner-b");
  await expect.poll(() => first.snapshot.getSnapshot().snapshot.policy).not.toBeNull();
  await second.profiles.logout();
  await expect.poll(() => first.snapshot.getSnapshot().isAuthorized).toBe(false);
  expect(first.snapshot.getSnapshot().snapshot.policy).toBeNull();
  first.policy.setState({ policyDraft: "unfinished policy" });
  first.discardDrafts();
  expect(first.policy.getSnapshot().policyDraft).toBe("");
  expect(first.drafts.isCurrent()).toBe(true);
});

// A reset continuation that fails after it stopped mattering must not surface a stale error.
test("a reconnect failing after the page stopped reports nothing", async () => {
  const { first, host } = await fixture();
  const second = createSession(await host.openPage("owner-b"));
  const stop = second.start();
  cleanup.push(stop);
  const gate = Promise.withResolvers<never>();
  const reconnect = vi.spyOn(second.auth, "reconnect").mockImplementation(() => gate.promise);
  await first.profiles.resetLocalData();
  await expect.poll(() => reconnect.mock.calls.length).toBe(1);
  stop();
  gate.reject(new Error("late reconnect failure"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(second.feedback.getSnapshot().lastError).toBe("");
});

test("a reconnect failing after a newer reset began reports nothing", async () => {
  const { first, host } = await fixture();
  const second = createSession(await host.openPage("owner-b"));
  cleanup.push(second.start());
  const gate = Promise.withResolvers<never>();
  const reconnect = vi.spyOn(second.auth, "reconnect").mockImplementationOnce(() => gate.promise);
  await first.profiles.resetLocalData();
  await expect.poll(() => reconnect.mock.calls.length).toBe(1);
  await first.profiles.resetLocalData();
  await expect.poll(() => reconnect.mock.calls.length).toBe(2);
  gate.reject(new Error("late reconnect failure"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(second.feedback.getSnapshot().lastError).toBe("");
});

test("a reconnect failing for the current reset is reported", async () => {
  const { first, host } = await fixture();
  const second = createSession(await host.openPage("owner-b"));
  cleanup.push(second.start());
  vi.spyOn(second.auth, "reconnect").mockRejectedValue(new Error("reconnect failure"));
  await first.profiles.resetLocalData();
  await expect.poll(() => second.feedback.getSnapshot().lastError).toBe("reconnect failure");
});

test("pages cannot read the session outside AppProviders", () => {
  const Probe = () => {
    useSession();
    return null;
  };
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(() => renderToString(createElement(Probe))).toThrow(
      "Application state requires AppProviders",
    );
  } finally {
    log.mockRestore();
  }
});
