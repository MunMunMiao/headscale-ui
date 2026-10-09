import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { createRenderer } from "vue";
import { RestHeadscaleClient } from "@/api/headscale-client";
import type { HeadscaleSnapshot, HealthResponse } from "@/api/types";
import { i18n } from "@/i18n";
import { __resetForTest } from "@/lib/idb";
import {
  type ConnectionProfile,
  hydrate,
  profileStorage,
  profileStorageTestingHandle,
} from "@/lib/profile-storage";
import { startSnapshotServer } from "@/test-utils/headscale.test";
import { actionFeedbackTestingHandle, useActionFeedback } from "./useActionFeedback";
import { headscaleClientTestingHandle, useHeadscaleClient } from "./useHeadscaleClient";
import { masterPasswordTestingHandle, useMasterPassword } from "./useMasterPassword";
import { newProfileId, profilesTestingHandle, useProfiles } from "./useProfiles";

const timerDelays: number[] = [];

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
  profilesTestingHandle.reset();
  timerDelays.length = 0;
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
      setTimeout(callback: () => void, delay: number) {
        timerDelays.push(delay);
        queueMicrotask(callback);
        return timerDelays.length;
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

function createProfilesApi() {
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
  let api: ReturnType<typeof useProfiles> | undefined;
  const app = renderer.createApp({
    setup() {
      api = useProfiles();
      return () => null;
    },
  });
  app.use(i18n);
  app.mount({});
  return api as ReturnType<typeof useProfiles>;
}

async function saveProfile(
  overrides: Partial<ConnectionProfile> = {},
  scope: "persistent" | "session" = "persistent",
) {
  const masterPassword = useMasterPassword();
  const profile: ConnectionProfile = {
    id: crypto.randomUUID(),
    name: "Profile",
    baseUrl: fixture.baseUrl,
    apiKey: await masterPassword.encryptApiKey("profile-key"),
    updatedAt: new Date().toISOString(),
    scope,
    ...overrides,
  };
  profileStorage.saveProfile(profile, scope);
  await new Promise((resolve) => setTimeout(resolve, 5));
  return profile;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not reached");
}

let fixture: ReturnType<typeof startSnapshotServer>;
beforeEach(() => {
  fixture = startSnapshotServer();
  useHeadscaleClient().setSettings({ baseUrl: fixture.baseUrl, apiKey: "test-key" });
});
afterEach(() => {
  mock.restore();
  fixture.stop();
});

describe("useProfiles forms and persistence", () => {
  test("starts with empty user-supplied connection fields", async () => {
    await prepareStorage();
    const api = createProfilesApi();
    expect(api.connectionForm).toMatchObject({ profileName: "", baseUrl: "", apiKey: "" });
  });

  test.each([
    { baseUrl: "", apiKey: "key" },
    { baseUrl: "/api", apiKey: "key" },
    { baseUrl: "ftp://headscale.test", apiKey: "key" },
    { baseUrl: "https://headscale.test", apiKey: "   " },
  ])("blocks invalid connection input before validation or persistence: %j", async (input) => {
    await prepareStorage();
    const api = createProfilesApi();
    Object.assign(api.connectionForm, input);
    await api.addProfile();
    expect(api.profileValidationDialogOpen.value).toBe(false);
    expect(useActionFeedback().lastError.value).not.toBe("");
    expect(api.profiles.value).toEqual([]);
    await expect(api.persistConnection()).rejects.toThrow();
    expect(profileStorage.loadProfiles()).toEqual([]);
    expect(fixture.requests).toEqual([]);
  });
  test("normalizes stored records and drives the connection dialog from decrypted profiles", async () => {
    await prepareStorage();
    const session = await saveProfile(
      {
        id: "session-profile",
        name: "",
        baseUrl: " https://remote.example.test ",
        updatedAt: "",
      },
      "session",
    );
    await saveProfile({ id: "corrupted", corrupted: true });
    const validSecret = await useMasterPassword().encryptApiKey("invalid-record-key");
    for (const invalid of [
      { id: "", baseUrl: fixture.baseUrl, apiKey: validSecret },
      { id: "no-base", baseUrl: "", apiKey: validSecret },
      { id: "bad-key", baseUrl: fixture.baseUrl, apiKey: {} },
    ]) {
      profileStorage.saveProfile(invalid as ConnectionProfile, "persistent");
    }

    const api = createProfilesApi();
    const feedback = useActionFeedback();

    expect(useProfiles()).toBe(api);
    expect(api.profiles.value.map((profile) => profile.id)).toEqual([
      "session-profile",
      "corrupted",
    ]);
    expect(api.profiles.value[0]).toMatchObject({
      name: "https://remote.example.test",
      baseUrl: "https://remote.example.test",
      scope: "session",
      ownerTabId: profileStorage.currentTabId(),
    });
    expect(api.profiles.value[0].updatedAt).not.toBe("");
    expect(api.profiles.value[1].corrupted).toBe(true);
    expect(useHeadscaleClient().settings).toMatchObject({
      baseUrl: "",
    });
    expect(api.currentProfileLabel.value).not.toBe("");
    expect(api.selectedProfile.value).toBeUndefined();

    await api.loadProfile("missing");
    expect(api.connectionForm.profileId).toBe("missing");
    await api.loadProfile(session.id);
    expect(api.connectionForm).toMatchObject({
      profileId: session.id,
      profileName: "https://remote.example.test",
      apiKey: "profile-key",
      remember: false,
    });
    expect(api.selectedProfile.value?.id).toBe(session.id);
    expect(api.currentProfileLabel.value).not.toBe("");

    feedback.lastError.value = "stale";
    await api.editProfile(session);
    expect(api.connectionDialogOpen.value).toBe(true);
    expect(feedback.lastError.value).toBe("");
    api.connectionCloseConfirmOpen.value = true;
    api.profileValidationDialogOpen.value = true;
    api.profileValidationError.value = "invalid";
    api.closeConnectionDialog();
    expect(api.connectionDialogOpen.value).toBe(false);
    expect(api.connectionCloseConfirmOpen.value).toBe(false);
    expect(api.profileValidationDialogOpen.value).toBe(false);
    expect(api.profileValidationError.value).toBe("");

    await api.loadProfile(newProfileId);
    expect(api.connectionForm).toMatchObject({
      profileId: newProfileId,
      profileName: "",
      baseUrl: "",
      remember: true,
    });
  });

  test("adds a validated session profile and updates the same record persistently", async () => {
    await prepareStorage();
    const api = createProfilesApi();
    Object.assign(api.connectionForm, {
      profileName: "   ",
      baseUrl: ` ${fixture.baseUrl}/ `,
      apiKey: "  saved-key  ",
      remember: false,
    });

    await api.addProfile();

    expect(api.phase.value).toEqual({ kind: "idle" });
    expect(api.profiles.value).toHaveLength(1);
    const id = api.profiles.value[0].id;
    expect(api.profiles.value[0]).toMatchObject({
      name: `${fixture.baseUrl}/`,
      baseUrl: `${fixture.baseUrl}/`,
      scope: "session",
    });
    expect(profileStorage.getProfileScope(id)).toBe("session");
    expect(api.connectionDialogOpen.value).toBe(false);

    Object.assign(api.connectionForm, {
      profileName: "Updated",
      apiKey: "updated-key",
      remember: true,
    });
    expect(await api.persistConnection()).toBe(id);
    expect(api.profiles.value).toHaveLength(1);
    expect(api.profiles.value[0]).toMatchObject({ id, name: "Updated", scope: "persistent" });
    expect(profileStorage.getProfileScope(id)).toBe("persistent");
  });

  test("surfaces validation failures and ignores a superseded add attempt", async () => {
    await prepareStorage();
    const api = createProfilesApi();
    Object.assign(api.connectionForm, { baseUrl: fixture.baseUrl, apiKey: "test-key" });
    const client = RestHeadscaleClient.prototype;
    spyOn(client, "health").mockImplementation(async () => {
      throw "validation failed";
    });

    await api.addProfile();
    expect(api.profileValidationDialogOpen.value).toBe(true);
    expect(api.profileValidationError.value).toBe("validation failed");
    expect(api.profiles.value).toHaveLength(0);

    api.profileValidationDialogOpen.value = false;
    const firstHealth = deferred<HealthResponse>();
    let healthCalls = 0;
    spyOn(client, "health").mockImplementation(() => {
      healthCalls += 1;
      return healthCalls === 1
        ? firstHealth.promise
        : Promise.resolve({ databaseConnectivity: true, serverReachable: true });
    });

    const stale = api.addProfile();
    await waitFor(() => healthCalls === 1);
    const current = api.addProfile();
    await current;
    firstHealth.resolve({ databaseConnectivity: true, serverReachable: true });
    await stale;

    expect(api.profiles.value).toHaveLength(1);
    expect(api.phase.value).toEqual({ kind: "idle" });
  });

  test("deletes only confirmed real profiles and selects the next available record", async () => {
    await prepareStorage();
    const first = await saveProfile({ id: "first" });
    const second = await saveProfile({ id: "second" });
    const api = createProfilesApi();
    await api.loadProfile(first.id);

    api.confirmDeleteProfile();
    expect(api.profiles.value).toHaveLength(2);
    api.deleteProfile({ ...first, id: newProfileId });
    api.confirmDeleteProfile();
    expect(api.profiles.value).toHaveLength(2);

    api.deleteProfile(first);
    expect(api.pendingDeleteProfile.value?.id).toBe(first.id);
    api.confirmDeleteProfile();
    await waitFor(
      () => api.connectionForm.profileId === second.id && api.connectionForm.apiKey !== "",
    );
    expect(api.profiles.value.map((profile) => profile.id)).toEqual([second.id]);

    api.deleteProfile(second);
    api.confirmDeleteProfile();
    await waitFor(() => api.connectionForm.profileId === newProfileId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(api.profiles.value).toEqual([]);
  });
});

describe("useProfiles authentication", () => {
  test("publishes an authenticated snapshot and keeps the phase busy until completion", async () => {
    await prepareStorage();
    const profile = await saveProfile({ id: "login-profile" });
    const api = createProfilesApi();
    const client = RestHeadscaleClient.prototype;
    const health = deferred<HealthResponse>();
    spyOn(client, "health").mockImplementation(() => health.promise);
    let authenticated: HeadscaleSnapshot | null = null;
    api.setOnAuthenticated((snapshot) => {
      authenticated = snapshot;
    });

    const login = api.enterProfile(api.profiles.value[0]);
    await waitFor(() => api.phase.value.kind === "authenticating");
    expect(api.isConnecting.value).toBe(true);
    expect(api.authenticatingProfileId.value).toBe(profile.id);
    health.resolve({ databaseConnectivity: true, serverReachable: true });

    expect(await login).toBe(true);
    expect(api.phase.value).toEqual({ kind: "idle" });
    expect(api.isConnecting.value).toBe(false);
    expect(api.authenticatingProfileId.value).toBeNull();
    expect(authenticated?.users).toHaveLength(1);
    expect(profileStorage.readActiveProfile()).toBe(profile.id);
    expect(useHeadscaleClient().settings.apiKey).toBe("profile-key");
    expect(timerDelays[0]).toBeGreaterThan(0);

    api.setOnAuthenticated(null);
    expect(await api.enterProfile(api.profiles.value[0], "restoring")).toBe(true);
  });

  test("rejects corrupted and undecryptable profiles without contacting Headscale", async () => {
    const masterPassword = await prepareStorage();
    await saveProfile({ id: "known-corrupt", corrupted: true });
    const api = createProfilesApi();
    const client = RestHeadscaleClient.prototype;
    let healthCalls = 0;
    spyOn(client, "health").mockImplementation(async () => {
      healthCalls += 1;
      return { databaseConnectivity: true };
    });

    expect(await api.enterProfile(api.profiles.value[0])).toBe(false);
    expect(useActionFeedback().lastError.value).not.toBe("");
    expect(healthCalls).toBe(0);

    profilesTestingHandle.reset();
    await masterPassword.enablePassword("vault-password");
    const locked = await saveProfile({ id: "locked-profile" });
    masterPassword.lock();
    const lockedApi = createProfilesApi();
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args) => void errors.push(args);
    try {
      expect(
        await lockedApi.enterProfile(
          lockedApi.profiles.value.find((profile) => profile.id === locked.id) as ConnectionProfile,
        ),
      ).toBe(false);
    } finally {
      console.error = originalError;
    }
    expect(
      profileStorage.loadProfiles().find((profile) => profile.id === locked.id)?.corrupted,
    ).toBe(true);
    expect(errors).toHaveLength(2);
  });

  test("clears the active profile on an authorization failure", async () => {
    await prepareStorage();
    await saveProfile({ id: "failing-profile" });
    profileStorage.setActiveProfile("failing-profile", "persistent");
    const api = createProfilesApi();
    spyOn(RestHeadscaleClient.prototype, "health").mockImplementation(async () => {
      throw new Error("server unavailable");
    });

    expect(await api.enterProfile(api.profiles.value[0])).toBe(false);
    expect(useActionFeedback().lastError.value).toBe("server unavailable");
    expect(profileStorage.readActiveProfile()).toBeNull();
    expect(api.phase.value).toEqual({ kind: "idle" });
  });

  test("logout invalidates an in-flight login and cannot be undone by its late response", async () => {
    await prepareStorage();
    const profile = await saveProfile({ id: "late-profile" });
    const api = createProfilesApi();
    const health = deferred<HealthResponse>();
    spyOn(RestHeadscaleClient.prototype, "health").mockImplementation(() => health.promise);
    let authenticated = 0;
    let loggedOut = 0;
    api.setOnAuthenticated(() => {
      authenticated += 1;
    });
    api.setOnLogout(() => {
      loggedOut += 1;
    });

    const login = api.enterProfile(api.profiles.value[0]);
    await waitFor(() => api.phase.value.kind === "authenticating");
    api.connectionDialogOpen.value = true;
    useActionFeedback().lastError.value = "stale";
    api.logout();

    expect(api.phase.value).toEqual({ kind: "idle" });
    expect(api.connectionDialogOpen.value).toBe(false);
    expect(api.connectionForm).toMatchObject({
      profileId: profile.id,
      profileName: profile.name,
      remember: false,
    });
    expect(useActionFeedback().lastError.value).toBe("");
    expect(loggedOut).toBe(1);

    health.resolve({ databaseConnectivity: true, serverReachable: true });
    expect(await login).toBe(false);
    expect(authenticated).toBe(0);
    expect(profileStorage.readActiveProfile()).toBeNull();

    api.setOnLogout(null);
    api.logout();
  });
});
