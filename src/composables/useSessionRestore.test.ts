import "fake-indexeddb/auto";
import { beforeEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { createRenderer, nextTick } from "vue";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import type { PolicyResponse } from "@/api/types";
import { i18n } from "@/i18n";
import { __resetForTest } from "@/lib/idb";
import {
  type ConnectionProfile,
  hydrate,
  profileStorage,
  profileStorageTestingHandle,
} from "@/lib/profile-storage";
import { actionFeedbackTestingHandle, useActionFeedback } from "./useActionFeedback";
import { headscaleClientTestingHandle, useHeadscaleClient } from "./useHeadscaleClient";
import { masterPasswordTestingHandle, useMasterPassword } from "./useMasterPassword";
import { useMutation } from "./useMutation";
import { policyDesignerTestingHandle, usePolicyDesigner } from "./usePolicyDesigner";
import { profilesTestingHandle, useProfiles } from "./useProfiles";
import { useSessionRestore } from "./useSessionRestore";
import { snapshotTestingHandle, useSnapshot } from "./useSnapshot";

const memoryStore = (): Storage => {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => Array.from(data.keys())[index] ?? null,
    removeItem: (key) => data.delete(key),
    setItem: (key, value) => data.set(key, String(value)),
  };
};

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  __resetForTest();
  profileStorageTestingHandle.reset();
  masterPasswordTestingHandle.reset();
  actionFeedbackTestingHandle.reset();
  headscaleClientTestingHandle.reset();
  policyDesignerTestingHandle.reset();
  profilesTestingHandle.reset();
  snapshotTestingHandle.reset();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: memoryStore(),
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: memoryStore(),
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout(callback: () => void) {
        queueMicrotask(callback);
        return 1;
      },
    },
  });
});

async function prepareStorage() {
  const masterPassword = useMasterPassword();
  await masterPassword.initialize();
  await hydrate({ encryptLegacy: (plain) => masterPassword.encryptWithDeviceKey(plain) });
  return masterPassword;
}

async function saveProfile(id: string) {
  const profile: ConnectionProfile = {
    id,
    name: `Profile ${id}`,
    mode: "mock",
    baseUrl: "http://127.0.0.1:8080",
    apiKey: await useMasterPassword().encryptApiKey(`${id}-key`),
    updatedAt: new Date().toISOString(),
    scope: "persistent",
  };
  profileStorage.saveProfile(profile, "persistent");
  await new Promise((resolve) => setTimeout(resolve, 5));
  return profile;
}

async function createTestRouter(initial: string) {
  const component = { render: () => null };
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/login", name: "login", component, meta: { requiresAuth: false } },
      { path: "/public", name: "public", component, meta: { requiresAuth: false } },
      { path: "/secure", name: "secure", component, meta: { requiresAuth: true } },
      { path: "/secure-two", name: "secure-two", component, meta: { requiresAuth: true } },
    ],
  });
  await router.push(initial);
  await router.isReady();
  return router;
}

function mountSessionRestore(router: Router) {
  const renderer = createRenderer({
    patchProp() {},
    insert() {},
    remove() {},
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    setText() {},
    setElementText() {},
    parentNode: () => null,
    nextSibling: () => null,
  });
  const app = renderer.createApp({
    setup() {
      useSessionRestore();
      return () => null;
    },
  });
  app.use(i18n);
  app.use(router);
  app.mount({});
  return app;
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not reached");
}

async function restorePolicySession(
  policyText = '{"acls":[{"action":"accept","src":["*"],"dst":["*:*"]}]}',
) {
  await prepareStorage();
  const profile = await saveProfile("policy-session");
  profileStorage.setActiveProfile(profile.id, "persistent");
  const client = useHeadscaleClient().mockClient;
  client.snapshot.policy = { policy: policyText };
  const router = await createTestRouter("/secure");
  const app = mountSessionRestore(router);
  const snapshot = useSnapshot();
  await waitFor(() => snapshot.isAuthorized.value);
  return { app, client, profile, router, snapshot, policy: usePolicyDesigner() };
}

describe("useSessionRestore", () => {
  test("keeps edits made while a route refresh is pending and saves the edited payload", async () => {
    const { app, client, router, snapshot, policy } = await restorePolicySession();
    const originalDraft = policy.policyDraft.value;
    const response = Promise.withResolvers<PolicyResponse>();
    client.getPolicy = () => response.promise;

    await router.push({ name: "secure-two" });
    await nextTick();
    expect(snapshot.isRefreshing.value).toBe(true);
    policy.removeRule(policy.policyRules.value[0].id);
    response.resolve({ policy: originalDraft });
    await waitFor(() => !snapshot.isRefreshing.value);

    expect(policy.policyRules.value).toEqual([]);
    expect(policy.policyDraft.value).toBe(originalDraft);
    expect(policy.isPolicyDirty.value).toBe(true);
    const saved = await client.setPolicy({ policy: JSON.stringify(policy.policyPayload.value) });
    expect(JSON.parse(saved.policy).acls).toEqual([]);
    app.unmount();
  });

  test("ignores policy reads begun before saving even when they finish after the draft is clean", async () => {
    const { app, client, snapshot, policy } = await restorePolicySession();
    const originalDraft = policy.policyDraft.value;
    const response = Promise.withResolvers<PolicyResponse>();
    client.getPolicy = () => response.promise;
    const refreshing = snapshot.refreshSnapshot();
    policy.removeRule(policy.policyRules.value[0].id);
    const saved = await client.setPolicy({ policy: JSON.stringify(policy.policyPayload.value) });
    policy.policyDraft.value = saved.policy;

    response.resolve({ policy: originalDraft });
    await refreshing;
    snapshot.applyPatch({ users: [] });

    expect(policy.policyRules.value).toEqual([]);
    expect(policy.policyDraft.value).toBe(saved.policy);
    expect(policy.isPolicyDirty.value).toBe(false);
    expect(snapshot.snapshot.value.users).toEqual([]);
    app.unmount();
  });

  test("refreshes clean drafts but preserves edits made to an initially empty policy", async () => {
    const { app, snapshot, policy } = await restorePolicySession("");
    expect(policy.policyDraft.value).toBe("");
    expect(policy.policyRules.value).toHaveLength(1);
    snapshot.applyPatch({ policy: { policy: '{"acls":[],"groups":{"group:remote":[]}}' } });
    expect(policy.policyGroups.value[0]?.name).toBe("group:remote");
    snapshot.applyPatch({ policy: null });
    expect(policy.policyGroups.value).toEqual([]);

    policy.addPolicyGroup();
    snapshot.applyPatch({ policy: null });
    expect(policy.policyGroups.value).toHaveLength(1);
    expect(policy.policyDraft.value).toBe("");
    expect(policy.isPolicyDirty.value).toBe(true);
    app.unmount();
  });

  test("preserves uncommitted dialog inputs when a different remote policy arrives", async () => {
    const { app, client, snapshot, policy } = await restorePolicySession();
    const baseline = policy.policyDraft.value;
    const rules = policy.policyRules.value;
    const response = Promise.withResolvers<PolicyResponse>();
    client.getPolicy = () => response.promise;
    const refreshing = snapshot.refreshSegments(["policy"]);
    policy.tagDetailOpen.value = true;
    expect(policy.isPolicyDirty.value).toBe(false);
    response.resolve({ policy: '{"acls":[]}' });
    await refreshing;

    expect(policy.policyRules.value).toBe(rules);
    expect(policy.policyDraft.value).toBe(baseline);
    policy.tagDetailOpen.value = false;
    await snapshot.refreshSegments(["policy"]);
    expect(policy.policyRules.value).toEqual([]);
    app.unmount();
  });

  test("preserves an inline rule editor until its changes are committed or cancelled", async () => {
    const { app, snapshot, policy } = await restorePolicySession();
    const rules = policy.policyRules.value;
    policy.editingIpRuleId.value = rules[0].id;
    expect(policy.isPolicyDirty.value).toBe(false);
    snapshot.applyPatch({ policy: { policy: '{"acls":[]}' } });

    expect(policy.policyRules.value).toBe(rules);
    expect(policy.editingIpRuleId.value).toBe(rules[0].id);
    policy.closeAccessEditors();
    snapshot.applyPatch({ policy: { policy: '{"acls":[]}' } });
    expect(policy.policyRules.value).toEqual([]);
    app.unmount();
  });

  for (const editor of ["assignMembershipsOpen", "assignTagOwnershipsOpen"] as const) {
    test(`preserves ${editor} selections across policy refresh and clears them on authentication`, async () => {
      const { app, profile, snapshot, policy } = await restorePolicySession(
        '{"acls":[],"groups":{"group:ops":["alice@"]},"tagOwners":{"tag:server":["alice@"]}}',
      );
      expect(policy[editor]).toBeDefined();
      policy[editor].value = true;
      policy.closeAccessEditors();
      expect(policy[editor].value).toBe(true);
      const groups = policy.policyGroups.value;
      const tagOwners = policy.policyTagOwners.value;

      snapshot.applyPatch({ policy: { policy: '{"acls":[]}' } });
      expect(policy.policyGroups.value).toBe(groups);
      expect(policy.policyTagOwners.value).toBe(tagOwners);
      expect(policy.isPolicyEditing.value).toBe(true);
      expect(policy.isPolicyDirty.value).toBe(false);

      await useProfiles().enterProfile(profile);
      expect(policy[editor].value).toBe(false);
      expect(policy.isPolicyEditing.value).toBe(false);
      expect(policy.isPolicyDirty.value).toBe(false);
      app.unmount();
    });
  }

  test.each([
    true,
    false,
  ])("keeps newer edits while a save settles (accepted: %s)", async (accepted) => {
    const { app, client, snapshot, policy } = await restorePolicySession();
    const originalDraft = policy.policyDraft.value;
    policy.removeRule(policy.policyRules.value[0].id);
    const submitted = JSON.stringify(policy.policyPayload.value);
    const response = Promise.withResolvers<PolicyResponse>();
    const saving = useMutation({ skipRefresh: true }).mutateWith(
      "save-policy",
      () => response.promise,
    );
    policy.addPolicyGroup();

    if (accepted) response.resolve(await client.setPolicy({ policy: submitted }));
    else response.reject(new Error("policy rejected"));
    const saved = await saving;
    if (saved.ok) policy.policyDraft.value = saved.result.policy;
    await snapshot.refreshSegments(["policy"]);

    expect(policy.policyDraft.value).toBe(accepted ? submitted : originalDraft);
    expect(policy.policyRules.value).toEqual([]);
    expect(policy.policyGroups.value).toHaveLength(1);
    expect(policy.isPolicyDirty.value).toBe(true);
    expect(useActionFeedback().actionError("save-policy")).toBe(accepted ? "" : "policy rejected");
    app.unmount();
  });

  test("replaces unsaved drafts on profile switch and ignores the previous session's late refresh", async () => {
    const { app, client, snapshot, policy } = await restorePolicySession();
    const oldPolicy = policy.policyDraft.value;
    const response = Promise.withResolvers<PolicyResponse>();
    client.getPolicy = () => response.promise;
    const refreshing = snapshot.refreshSnapshot();
    policy.removeRule(policy.policyRules.value[0].id);
    policy.editingIpRuleId.value = "previous-rule";
    policy.teamDetailOpen.value = true;
    policy.teamDetailCurrent.value = "group:previous";
    policy.pendingHighRiskAction.value = () => policy.addPolicyRule();
    const nextProfile = await saveProfile("next-session");
    const nextPolicy = '{"acls":[],"groups":{"group:next":[]}}';
    client.getPolicy = async () => ({ policy: nextPolicy });
    await useProfiles().enterProfile(nextProfile);
    response.resolve({ policy: oldPolicy });
    await refreshing;

    expect(policy.policyDraft.value).toBe(nextPolicy);
    expect(policy.policyGroups.value[0]?.name).toBe("group:next");
    expect(policy.policyRules.value).toEqual([]);
    expect(policy.isPolicyDirty.value).toBe(false);
    expect(policy.isPolicyEditing.value).toBe(false);
    expect(policy.editingIpRuleId.value).toBeNull();
    expect(policy.teamDetailCurrent.value).toBe("");
    expect(policy.pendingHighRiskAction.value).toBeNull();
    app.unmount();
  });

  test("clears unsaved drafts on logout and reloads the same profile without stale writes", async () => {
    const { app, client, profile, snapshot, policy } = await restorePolicySession();
    const response = Promise.withResolvers<PolicyResponse>();
    client.getPolicy = () => response.promise;
    const refreshing = snapshot.refreshSnapshot();
    policy.removeRule(policy.policyRules.value[0].id);
    useProfiles().logout();

    expect(policy.policyDraft.value).toBe("");
    expect(policy.policyGroups.value).toEqual([]);
    client.getPolicy = async () => ({ policy: '{"acls":[]}' });
    await useProfiles().enterProfile(profile);
    response.resolve({ policy: '{"acls":[],"groups":{"group:stale":[]}}' });
    await refreshing;

    expect(policy.policyDraft.value).toBe('{"acls":[]}');
    expect(policy.policyGroups.value).toEqual([]);
    expect(policy.isPolicyDirty.value).toBe(false);
    app.unmount();
  });

  test.each([
    true,
    false,
  ])("ignores a previous profile's late save result and error (accepted: %s)", async (accepted) => {
    const { app, client, snapshot, policy } = await restorePolicySession();
    policy.removeRule(policy.policyRules.value[0].id);
    const submitted = JSON.stringify(policy.policyPayload.value);
    const response = Promise.withResolvers<PolicyResponse>();
    const saving = useMutation().mutateWith("save-policy", () => response.promise);
    const nextProfile = await saveProfile("next-save-session");
    const nextPolicy = '{"acls":[],"groups":{"group:next":[]}}';
    client.getPolicy = async () => ({ policy: nextPolicy });
    await useProfiles().enterProfile(nextProfile);
    const feedback = useActionFeedback();
    feedback.lastError.value = "new session feedback";
    const currentSnapshot = snapshot.snapshot.value;

    if (accepted) response.resolve(await client.setPolicy({ policy: submitted }));
    else response.reject(new Error("previous profile rejected policy"));
    const saved = await saving;
    if (saved.ok) policy.policyDraft.value = saved.result.policy;

    expect(policy.policyDraft.value).toBe(nextPolicy);
    expect(policy.isPolicyDirty.value).toBe(false);
    expect(feedback.lastError.value).toBe("new session feedback");
    expect(feedback.actionError("save-policy")).toBe("");
    expect(snapshot.snapshot.value).toBe(currentSnapshot);
    if (accepted) expect(client.snapshot.policy?.policy).toBe(submitted);
    app.unmount();
  });

  test("a previous login's save cannot release a new login's pending save", async () => {
    const { app, client, profile, policy } = await restorePolicySession();
    const mutation = useMutation({ skipRefresh: true });
    const previousResponse = Promise.withResolvers<PolicyResponse>();
    const previousSave = mutation.mutateWith("save-policy", () => previousResponse.promise);
    useProfiles().logout();
    client.getPolicy = async () => ({ policy: '{"acls":[]}' });
    await useProfiles().enterProfile(profile);
    const currentResponse = Promise.withResolvers<PolicyResponse>();
    const currentSave = mutation.mutateWith("save-policy", () => currentResponse.promise);

    previousResponse.resolve({ policy: '{"acls":[],"groups":{"group:old":[]}}' });
    const previousResult = await previousSave;
    if (previousResult.ok) policy.policyDraft.value = previousResult.result.policy;

    expect(useActionFeedback().isActionPending("save-policy")).toBe(true);
    expect(policy.policyDraft.value).toBe('{"acls":[]}');
    currentResponse.resolve({ policy: '{"acls":[]}' });
    expect(await currentSave).toEqual({ ok: true, result: { policy: '{"acls":[]}' } });
    expect(useActionFeedback().isActionPending("save-policy")).toBe(false);
    app.unmount();
  });

  test("restores a profile and wires policy, errors, route refresh, and logout", async () => {
    await prepareStorage();
    const profile = await saveProfile("active");
    profileStorage.setActiveProfile(profile.id, "persistent");
    const router = await createTestRouter("/secure");
    const app = mountSessionRestore(router);

    const snapshot = useSnapshot();
    const profiles = useProfiles();
    const policy = usePolicyDesigner();
    const feedback = useActionFeedback();
    await waitFor(() => snapshot.isAuthorized.value && !profiles.isRestoringSession.value);

    expect(profileStorage.readActiveProfile()).toBe(profile.id);
    expect(snapshot.snapshot.value.users).toHaveLength(3);
    expect(policy.policyDraft.value).toContain('"acls"');

    snapshot.applyPatch({ policy: null });
    expect(policy.policyDraft.value).toBe("");
    const failed = await feedback.runAction("save-policy", async () => {
      throw new Error("Node not found");
    });
    expect(failed).toEqual({ ok: false });
    expect(feedback.lastError.value).not.toBe("");

    let refreshes = 0;
    const refreshSnapshot = snapshot.refreshSnapshot;
    snapshot.refreshSnapshot = async () => {
      refreshes += 1;
      await refreshSnapshot();
    };
    await router.push({ name: "secure-two" });
    await nextTick();
    await waitFor(() => refreshes === 1);
    await router.push({ name: "public" });
    await nextTick();
    expect(refreshes).toBe(1);

    profiles.logout();
    await waitFor(() => router.currentRoute.value.name === "login");
    expect(snapshot.isAuthorized.value).toBe(false);
    expect(snapshot.snapshot.value.health?.serverReachable).toBe(false);
    app.unmount();
  });

  test("finishes restoration without navigation when no profile was requested or active", async () => {
    await prepareStorage();
    const router = await createTestRouter("/public");
    const app = mountSessionRestore(router);
    const profiles = useProfiles();

    await waitFor(() => !profiles.isRestoringSession.value);

    expect(router.currentRoute.value.name).toBe("public");
    expect(useSnapshot().isAuthorized.value).toBe(false);
    app.unmount();
  });

  test("does not start a second restoration when authorization already exists", async () => {
    await prepareStorage();
    const router = await createTestRouter("/secure");
    useSnapshot().isAuthorized.value = true;
    const app = mountSessionRestore(router);
    const profiles = useProfiles();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(profiles.isRestoringSession.value).toBe(true);
    expect(router.currentRoute.value.name).toBe("secure");
    app.unmount();
  });

  test("ignores a stale active ID on a public route", async () => {
    await prepareStorage();
    profileStorage.setActiveProfile("missing", "persistent");
    const router = await createTestRouter("/public");
    const app = mountSessionRestore(router);

    await waitFor(() => !useProfiles().isRestoringSession.value);

    expect(router.currentRoute.value.name).toBe("public");
    expect(useSnapshot().isAuthorized.value).toBe(false);
    app.unmount();
  });

  test("redirects when a URL-requested profile does not exist", async () => {
    await prepareStorage();
    const router = await createTestRouter("/public?profile=missing-from-url");
    const app = mountSessionRestore(router);

    await waitFor(() => router.currentRoute.value.name === "login");

    expect(useProfiles().isRestoringSession.value).toBe(false);
    expect(useSnapshot().isAuthorized.value).toBe(false);
    app.unmount();
  });

  test("redirects an authenticated route when restoring its profile fails", async () => {
    await prepareStorage();
    const profile = await saveProfile("failing");
    profileStorage.setActiveProfile(profile.id, "persistent");
    useHeadscaleClient().mockClient.health = async () => {
      throw "restore failed";
    };
    const router = await createTestRouter("/secure");
    const app = mountSessionRestore(router);

    await waitFor(() => router.currentRoute.value.name === "login");

    expect(useProfiles().isRestoringSession.value).toBe(false);
    expect(useActionFeedback().lastError.value).toBe("restore failed");
    expect(useSnapshot().isAuthorized.value).toBe(false);
    app.unmount();
  });
});
