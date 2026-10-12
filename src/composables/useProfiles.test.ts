import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { t } from "@/i18n";
import { __resetForTest, DB_VERSION } from "@/lib/idb";
import { createSessionBridge } from "@/session/bridge";
import { profilesFixture } from "@/test/profiles-fixture";
import { idbGetAll, idbPut } from "@/test-utils/storage";
import { createProfilesStore, newProfileId } from "./useProfiles";

const cleanup: (() => void | Promise<void>)[] = [];
beforeEach(() => {
  __resetForTest();
  globalThis.indexedDB = new IDBFactory();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const stop of cleanup.reverse().splice(0)) await stop();
});
const fixture = () => profilesFixture(cleanup);
test("saving clears secret inputs immediately and retains only password-encrypted profile summaries", async () => {
  const { profiles, feedback, server, form } = await fixture();
  expect(profiles.currentProfileLabel).toBe(t("profile"));
  profiles.setConnectionForm(form);
  const saving = profiles.addProfile();
  expect(profiles.getSnapshot().connectionForm).toMatchObject({
    apiKey: "",
    password: "",
    baseUrl: server.baseUrl,
    profileName: "My server",
  });
  await saving;
  expect(feedback.getSnapshot().lastError).toBe("");
  expect(server.requests).toHaveLength(7);
  expect(profiles.getSnapshot().profiles).toHaveLength(1);
  expect(profiles.selectedProfile?.name).toBe(form.profileName);
  expect(JSON.stringify(profiles.getSnapshot())).not.toContain("connection-test-key");
  expect(await idbGetAll("profiles")).toEqual([
    expect.objectContaining({ apiKey: expect.objectContaining({ v: 2, scheme: "password" }) }),
  ]);
});
test("missing the independent password sends no request and retains the ordinary draft", async () => {
  const { profiles, feedback, server, form } = await fixture();
  profiles.setConnectionForm({ ...form, password: "" });
  await profiles.addProfile();
  expect(feedback.getSnapshot().lastError).toBe(t("serverPasswordRequired"));
  expect(feedback.getSnapshot().lastError).not.toBe(t("encryptionUnlockFailed"));
  expect(server.requests).toEqual([]);
  expect(await idbGetAll("profiles")).toEqual([]);
  expect(profiles.getSnapshot().connectionForm).toMatchObject({
    profileName: "My server",
    apiKey: form.apiKey,
    password: "",
  });
});
test("a local validation failure keeps the typed secrets so a corrected URL saves without retyping", async () => {
  const { profiles, feedback, server, form } = await fixture();
  profiles.setConnectionForm({ ...form, baseUrl: "not a url" });
  await profiles.addProfile();
  expect(feedback.getSnapshot().lastError).toBe(t("connectionInvalidUrl"));
  expect(server.requests).toEqual([]);
  expect(await idbGetAll("profiles")).toEqual([]);
  expect(profiles.getSnapshot().connectionForm).toMatchObject({
    apiKey: form.apiKey,
    password: form.password,
  });
  profiles.setConnectionForm({ baseUrl: form.baseUrl });
  await profiles.addProfile();
  expect(feedback.getSnapshot().lastError).toBe("");
  expect(await idbGetAll("profiles")).toHaveLength(1);
  expect(profiles.getSnapshot().connectionForm).toMatchObject({ apiKey: "", password: "" });
});
test("an unready vault version or a missing skip secret keeps the typed secrets", async () => {
  const { profiles, server, form } = await fixture();
  profiles.setConnectionForm(form);
  profiles.setState({ version: null });
  await profiles.addProfile();
  expect(server.requests).toEqual([]);
  expect(profiles.getSnapshot().connectionForm).toMatchObject({
    apiKey: form.apiKey,
    password: form.password,
  });
  profiles.setConnectionForm({ password: "" });
  await expect(profiles.persistConnection()).rejects.toThrow(t("sessionSecretRequired"));
  expect(profiles.getSnapshot().connectionForm.apiKey).toBe(form.apiKey);
});
test("editing only metadata never decrypts or refills credentials", async () => {
  const { profiles, form, server } = await fixture();
  profiles.setConnectionForm(form);
  await profiles.addProfile();
  const profile = profiles.getSnapshot().profiles[0];
  if (!profile) throw new Error("Profile save failed");
  const stored = await idbGetAll("profiles");
  const calls = server.requests.length;
  await profiles.loadProfile(profile.id);
  expect(profiles.getSnapshot().connectionForm).toMatchObject({ apiKey: "", password: "" });
  profiles.setConnectionForm({ profileName: "Renamed" });
  await profiles.addProfile();
  expect(profiles.getSnapshot().profiles[0]?.name).toBe("Renamed");
  expect(server.requests).toHaveLength(calls);
  expect((await idbGetAll<{ apiKey: unknown }>("profiles"))[0]?.apiKey).toEqual(
    (stored[0] as { apiKey: unknown }).apiKey,
  );
});

test("selecting a profile only prompts; unlocking requires its password and never returns its connection key", async () => {
  const { profiles, bridge, form, server } = await fixture();
  profiles.setConnectionForm(form);
  await profiles.addProfile();
  const profile = profiles.getSnapshot().profiles[0];
  if (!profile) throw new Error("Profile save failed");
  const calls = server.requests.length;
  expect(await profiles.enterProfile(profile)).toBe(false);
  expect(profiles.getSnapshot().unlockProfile).toEqual(profile);
  expect(server.requests).toHaveLength(calls);
  expect(await profiles.enterProfile(profile, "wrong")).toBe(false);
  expect(server.requests).toHaveLength(calls);
  expect(await profiles.enterProfile(profile, form.password)).toBe(true);
  expect(bridge.getSessionSnapshot()?.status).toBe("unlocked");
  expect(profiles.currentProfileLabel).toBe(form.profileName);
  expect(profiles.getSnapshot().unlockProfile).toBeNull();
  expect(JSON.stringify(profiles.getSnapshot())).not.toContain(form.apiKey);
  await profiles.logout();
  expect(bridge.getSessionSnapshot()?.status).toBe("locked");
});

test("changing a per-server password or deleting the active profile locks the shared connection", async () => {
  const { profiles, bridge, form } = await fixture();
  profiles.setConnectionForm(form);
  await profiles.addProfile(true);
  let profile = profiles.getSnapshot().profiles[0];
  if (!profile) throw new Error("Profile save failed");
  expect(bridge.getSessionSnapshot()?.status).toBe("unlocked");
  expect(await profiles.changeProfilePassword(profile, "wrong", "replacement")).toBe(false);
  expect(bridge.getSessionSnapshot()?.status).toBe("unlocked");
  expect(await profiles.changeProfilePassword(profile, form.password, "replacement")).toBe(true);
  expect(bridge.getSessionSnapshot()?.status).toBe("locked");
  profile = profiles.getSnapshot().profiles[0];
  if (!profile) throw new Error("Profile disappeared");
  expect(await profiles.enterProfile(profile, form.password)).toBe(false);
  expect(await profiles.enterProfile(profile, "replacement")).toBe(true);
  profiles.deleteProfile(profile);
  await profiles.confirmDeleteProfile();
  expect(profiles.getSnapshot().profiles).toEqual([]);
  expect(bridge.getSessionSnapshot()?.status).toBe("locked");
});

test("a legacy profile is migrated explicitly before its new independent password unlocks it", async () => {
  const { profiles, bridge, server } = await fixture();
  await idbPut("profiles", {
    id: "legacy",
    name: "Legacy",
    baseUrl: server.baseUrl,
    scope: "persistent",
    updatedAt: "2026-10-11T00:00:00Z",
    apiKey: "legacy-connection-key",
    keyEpoch: profiles.getSnapshot().version?.keyEpoch,
  });
  await profiles.reloadProfiles();
  const profile = profiles.getSnapshot().profiles[0];
  if (!profile) throw new Error("Legacy profile missing");
  expect(profile.credentialKind).toBe("legacy-plaintext");
  expect(await profiles.migrateAndEnterProfile(profile, "new-password")).toBe(true);
  expect(bridge.getSessionSnapshot()?.status).toBe("unlocked");
  expect(profiles.getSnapshot().profiles[0]?.credentialKind).toBe("password");
  await profiles.resetLocalData();
  expect(bridge.getSessionSnapshot()?.status).toBe("locked");
  expect(await idbGetAll("profiles")).toEqual([]);
});

test("an old validation failure cannot overwrite a newer connection draft or its feedback", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = await profilesFixture(cleanup, async () => {
    entered.resolve();
    await release.promise;
    return Response.json({ message: "Old validation denied" }, { status: 503 });
  });
  f.profiles.setConnectionForm(f.form);
  f.profiles.setState({ connectionDialogOpen: true });
  const saving = f.profiles.addProfile();
  await entered.promise;
  f.profiles.setConnectionForm({
    profileName: "New draft",
    baseUrl: "https://new.test",
    apiKey: "new-input",
    password: "new-password",
  });
  f.feedback.setState({ lastError: "New draft feedback" });
  release.resolve();
  await saving;
  expect(f.feedback.getSnapshot().lastError).toBe("New draft feedback");
  expect(f.profiles.getSnapshot().connectionForm).toMatchObject({
    profileName: "New draft",
    apiKey: "new-input",
    password: "new-password",
  });
  expect(f.profiles.getSnapshot().profileValidationDialogOpen).toBe(false);
});

test("a committed save whose activation fails reports the saved locked result", async () => {
  let nodeReads = 0;
  const f = await profilesFixture(cleanup, (request, forward) => {
    // The node list is the required read; an optional health failure no longer fails activation.
    if (new URL(request.url).pathname === "/api/v1/node" && ++nodeReads > 1)
      return Response.json({ message: "Activation denied" }, { status: 503 });
    return forward();
  });
  f.profiles.setConnectionForm(f.form);
  await f.profiles.addProfile(true);
  expect(f.profiles.getSnapshot().profiles).toHaveLength(1);
  expect(await idbGetAll("profiles")).toHaveLength(1);
  expect(f.bridge.getSessionSnapshot()?.status).toBe("locked");
  expect(f.feedback.getSnapshot().lastError).toBe(t("sessionSavedLocked"));
});

test("reset projection immediately removes summaries, private inputs and every pending dialog", async () => {
  const f = await fixture();
  f.profiles.setConnectionForm(f.form);
  await f.profiles.addProfile();
  const profile = f.profiles.getSnapshot().profiles[0];
  expect.assert(profile);
  await f.profiles.editProfile(profile);
  await f.profiles.enterProfile(profile);
  f.profiles.deleteProfile(profile);
  f.profiles.setConnectionForm({ apiKey: "unsubmitted", password: "private" });
  f.profiles.setState({
    connectionCloseConfirmOpen: true,
    profileValidationDialogOpen: true,
    profileValidationError: "old",
  });
  const version = { keyEpoch: "reset-epoch", profilesRevision: 0 };
  const generation = f.profiles.connectionFormGeneration;
  f.profiles.resetProjection(version);
  expect(f.profiles.getSnapshot()).toMatchObject({
    profiles: [],
    version,
    connectionForm: { profileId: newProfileId, apiKey: "", password: "", profileName: "" },
    phase: { kind: "idle" },
    connectionDialogOpen: false,
    connectionCloseConfirmOpen: false,
    profileValidationDialogOpen: false,
    profileValidationError: "",
    pendingDeleteProfile: null,
    unlockProfile: null,
  });
  expect(f.profiles.getSnapshot()).not.toHaveProperty("isRestoringSession");
  expect(f.profiles.connectionFormGeneration).toBeGreaterThan(generation);
});

test("a failed validation can be explicitly skipped only after new secrets are supplied, without activating", async () => {
  let attempts = 0;
  const f = await profilesFixture(cleanup, () => {
    attempts++;
    return Response.json({ message: "Unavailable endpoint" }, { status: 503 });
  });
  await f.profiles.openConnectionDialog(newProfileId);
  f.profiles.setConnectionForm(f.form);
  await f.profiles.addProfile();
  expect(f.profiles.getSnapshot()).toMatchObject({
    profileValidationDialogOpen: true,
    connectionForm: { apiKey: "", password: "" },
  });
  await expect.poll(() => attempts).toBe(7);
  const count = attempts;
  await expect(f.profiles.persistConnection()).rejects.toThrow();
  expect(attempts).toBe(count);
  f.profiles.setConnectionForm({ apiKey: f.form.apiKey, password: f.form.password });
  await f.profiles.persistConnection();
  expect(f.profiles.getSnapshot().profiles).toHaveLength(1);
  expect(attempts).toBe(count);
  expect(f.bridge.getSessionSnapshot()?.status).toBe("locked");
});

test("logout during an actual pending password validation cancels the candidate and closes its prompt", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let hold = false;
  const f = await profilesFixture(cleanup, async (_request, forward) => {
    if (hold) {
      entered.resolve();
      await release.promise;
    }
    return forward();
  });
  f.profiles.setConnectionForm(f.form);
  await f.profiles.addProfile();
  const profile = f.profiles.getSnapshot().profiles[0];
  expect.assert(profile);
  await f.profiles.enterProfile(profile);
  hold = true;
  const entering = f.profiles.enterProfile(profile, f.form.password);
  await entered.promise;
  expect(f.profiles.isConnecting).toBe(true);
  expect(f.profiles.authenticatingProfileId).toBe(profile.id);
  await expect(f.profiles.persistConnection()).rejects.toMatchObject({ kind: "busy" });
  await f.profiles.addProfile();
  expect(await f.profiles.migrateAndEnterProfile(profile, "new-password")).toBe(false);
  expect(await f.profiles.enterProfile(profile, f.form.password)).toBe(false);
  await f.profiles.logout();
  release.resolve();
  expect(await entering).toBe(false);
  expect(f.profiles.getSnapshot()).toMatchObject({ unlockProfile: null, phase: { kind: "idle" } });
  expect(f.bridge.getSessionSnapshot()?.status).toBe("locked");
  expect(f.feedback.getSnapshot().lastError).toBe("");
});

test("resetLocalData applies its committed empty projection even without an external subscriber", async () => {
  const f = await fixture();
  f.profiles.setConnectionForm(f.form);
  await f.profiles.addProfile();
  const result = await f.profiles.resetLocalData();
  expect(result.committed).toBe(true);
  expect(f.profiles.getSnapshot()).toMatchObject({
    profiles: [],
    version: result.version,
    connectionForm: { profileId: newProfileId, apiKey: "", password: "" },
  });
});

test("closing while an edit opens cannot let its microtask reopen the dialog", async () => {
  const f = await fixture();
  const opening = f.profiles.openConnectionDialog(newProfileId);
  f.profiles.closeConnectionDialog();
  f.feedback.setState({ lastError: "New view" });
  await opening;
  expect(f.profiles.getSnapshot().connectionDialogOpen).toBe(false);
  expect(f.feedback.getSnapshot().lastError).toBe("New view");
});

test("skipping a failed replacement validation cannot silently turn into metadata-only success", async () => {
  let unavailable = false;
  const f = await profilesFixture(cleanup, (_request, forward) =>
    unavailable ? Response.json({ message: "Unavailable" }, { status: 503 }) : forward(),
  );
  f.profiles.setConnectionForm(f.form);
  await f.profiles.addProfile();
  const profile = f.profiles.getSnapshot().profiles[0];
  expect.assert(profile);
  await f.profiles.openConnectionDialog(profile.id);
  f.profiles.setConnectionForm({ apiKey: "replacement-key", password: f.form.password });
  unavailable = true;
  await f.profiles.addProfile();
  const before = await idbGetAll("profiles");
  expect(f.profiles.getSnapshot().profileValidationDialogOpen).toBe(true);
  await expect(f.profiles.persistConnection()).rejects.toThrow();
  expect(await idbGetAll("profiles")).toEqual(before);
  expect(f.profiles.getSnapshot().connectionDialogOpen).toBe(true);
});

test("a stale logout reply cannot overwrite feedback for a later opened form", async () => {
  const f = await fixture();
  f.profiles.setConnectionForm(f.form);
  await f.profiles.addProfile(true);
  const peer = await f.peer("owner-b");
  f.ports.pause();
  peer.profiles.setConnectionForm({ ...f.form, profileName: "Other server" });
  await peer.profiles.addProfile(true);
  const logout = f.profiles.logout();
  await f.profiles.openConnectionDialog(newProfileId);
  f.feedback.setState({ lastError: "New form feedback" });
  f.ports.resume();
  await logout;
  expect(f.feedback.getSnapshot().lastError).toBe("New form feedback");
});

test("closing the unlock dialog cancels a pending credential check while keeping an independent connection draft", async () => {
  let hold = false;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = await profilesFixture(cleanup, async (_request, forward) => {
    if (hold) {
      entered.resolve();
      await release.promise;
    }
    return forward();
  });
  f.profiles.setConnectionForm(f.form);
  await f.profiles.addProfile();
  const profile = f.profiles.getSnapshot().profiles[0];
  expect.assert(profile);
  await f.profiles.openConnectionDialog(newProfileId);
  f.profiles.setConnectionForm({ profileName: "Other draft", baseUrl: "https://draft.test" });
  await f.profiles.enterProfile(profile);
  hold = true;
  const unlocking = f.profiles.enterProfile(profile, f.form.password);
  await entered.promise;
  try {
    f.profiles.closeUnlockDialog();
    expect(f.profiles.isConnecting).toBe(false);
    release.resolve();
    expect(await unlocking).toBe(false);
    expect(f.bridge.getSessionSnapshot()?.status).toBe("locked");
    expect(f.profiles.getSnapshot()).toMatchObject({
      connectionDialogOpen: true,
      connectionForm: { profileName: "Other draft", baseUrl: "https://draft.test" },
      unlockProfile: null,
    });
    expect(f.feedback.getSnapshot().lastError).toBe("");
  } finally {
    release.resolve();
    await unlocking;
  }
});

test("a correct password followed by a server rejection reports the sanitized API failure and preserves the prior session", async () => {
  let failed = false;
  const f = await profilesFixture(cleanup, (_request, forward) =>
    failed
      ? Response.json(
          { message: "Server unreachable connection-test-key", code: 14 },
          { status: 503 },
        )
      : forward(),
  );
  f.profiles.setConnectionForm(f.form);
  await f.profiles.addProfile(true);
  const current = f.bridge.getSessionSnapshot()?.identity;
  await f.profiles.openConnectionDialog(newProfileId);
  f.profiles.setConnectionForm({ ...f.form, profileName: "Other server" });
  await f.profiles.persistConnection();
  const target = f.profiles.selectedProfile;
  expect.assert(target);
  failed = true;
  expect(await f.profiles.enterProfile(target, f.form.password)).toBe(false);
  expect(f.feedback.getSnapshot().lastError).toBe("Server unreachable [redacted]");
  expect(f.bridge.getSessionSnapshot()?.identity).toEqual(current);
  expect(f.bridge.getSessionSnapshot()?.status).toBe("unlocked");
});

test("missing repository metadata and invalid connection input fail locally without network requests", async () => {
  const f = await fixture();
  await f.profiles.addProfile();
  expect(f.feedback.getSnapshot().lastError).toBe(t("connectionInvalidUrl"));
  const unready = createProfilesStore(f.bridge, f.feedback, null);
  unready.setConnectionForm(f.form);
  await unready.addProfile();
  expect(f.feedback.getSnapshot().lastError).toBe(t("sessionUnavailable"));
  await expect(unready.resetLocalData()).rejects.toMatchObject({ kind: "unavailable" });
  expect(f.server.requests).toEqual([]);
  expect(await idbGetAll("profiles")).toEqual([]);
});

test("a disconnected worker reports logout and reset failure without pretending saved data was cleared", async () => {
  const f = await fixture();
  f.profiles.setConnectionForm(f.form);
  await f.profiles.addProfile();
  const generation = f.profiles.authorizationGeneration;
  f.bridge.dispose();
  await f.profiles.logout();
  expect(f.profiles.authorizationGeneration).toBeGreaterThan(generation);
  expect(f.feedback.getSnapshot().lastError).toBe(t("sessionUnavailable"));
  await expect(f.profiles.resetLocalData()).rejects.toMatchObject({ kind: "unavailable" });
  expect(f.profiles.getSnapshot().profiles).toHaveLength(1);
  expect(await idbGetAll("profiles")).toHaveLength(1);
  await f.profiles.confirmDeleteProfile();
});

test("a page disconnected during unlock publication cannot report authorization success", async () => {
  const f = await fixture();
  f.profiles.setConnectionForm(f.form);
  await f.profiles.addProfile();
  const profile = f.profiles.selectedProfile;
  expect.assert(profile);
  let disposed = false;
  const stop = f.bridge.subscribe(() => {
    if (!disposed && f.bridge.getSnapshot().status === "ready-unlocked") {
      disposed = true;
      f.bridge.dispose();
    }
  });
  try {
    expect(await f.profiles.enterProfile(profile, f.form.password)).toBe(false);
  } finally {
    stop();
  }
});

const unavailableReload = { ok: false, error: { kind: "unavailable" } } as const;
async function savedProfile() {
  const f = await fixture();
  f.profiles.setConnectionForm(f.form);
  await f.profiles.addProfile();
  const profile = f.profiles.getSnapshot().profiles[0];
  expect.assert(profile);
  return { ...f, profile };
}
async function seedLegacyProfile(f: Awaited<ReturnType<typeof fixture>>) {
  await idbPut("profiles", {
    id: "legacy",
    name: "Legacy",
    baseUrl: f.server.baseUrl,
    scope: "persistent",
    updatedAt: "2026-10-11T00:00:00Z",
    apiKey: "legacy-connection-key",
    keyEpoch: f.profiles.getSnapshot().version?.keyEpoch,
  });
  await f.profiles.reloadProfiles();
  const profile = f.profiles.getSnapshot().profiles[0];
  expect.assert(profile);
  return profile;
}

test("a store seeded before its Worker connected reports unavailable for saving and unlocking", async () => {
  const f = await savedProfile();
  const list = await f.bridge.listProfiles();
  expect.assert(list.ok);
  const offline = createSessionBridge({
    openPort() {
      throw new Error("no Worker");
    },
    ownerTabId: () => "owner-offline",
    buildId: "profiles-test",
    storageVersion: DB_VERSION,
  });
  cleanup.push(() => offline.dispose());
  const requests = f.server.requests.length;
  const store = createProfilesStore(offline, f.feedback, list.value);
  store.setConnectionForm({ ...f.form, profileName: "Offline server" });
  await store.addProfile();
  expect(f.feedback.getSnapshot().lastError).toBe(t("sessionUnavailable"));
  expect(store.getSnapshot()).toMatchObject({
    phase: { kind: "idle" },
    connectionForm: { apiKey: "", password: "" },
  });
  f.feedback.setState({ lastError: "" });
  expect(await store.enterProfile(f.profile, f.form.password)).toBe(false);
  expect(f.feedback.getSnapshot().lastError).toBe(t("sessionUnavailable"));
  expect(store.getSnapshot().phase).toEqual({ kind: "idle" });
  expect(f.server.requests).toHaveLength(requests);
  expect(await idbGetAll("profiles")).toHaveLength(1);
});

test("a legacy record without a credential version can never unlock through the password path", async () => {
  const f = await fixture();
  const profile = await seedLegacyProfile(f);
  expect(profile.credentialVersion).toBeNull();
  const before = await idbGetAll("profiles");
  expect(await f.profiles.enterProfile(profile, "any password")).toBe(false);
  expect(f.feedback.getSnapshot().lastError).not.toBe("");
  expect(f.bridge.getSessionSnapshot()?.status).toBe("locked");
  expect(f.server.requests).toEqual([]);
  expect(await idbGetAll("profiles")).toEqual(before);
});

test("a failed list read after a save stays silent when the form was edited meanwhile", async () => {
  const f = await fixture();
  vi.spyOn(f.bridge, "listProfiles").mockResolvedValue(unavailableReload);
  f.profiles.setConnectionForm(f.form);
  const saving = f.profiles.addProfile();
  f.profiles.setConnectionForm({ profileName: "Typing next" });
  await saving;
  expect(f.feedback.getSnapshot().lastError).toBe("");
  expect(f.profiles.getSnapshot().connectionForm.profileName).toBe("Typing next");
  expect(await idbGetAll("profiles")).toHaveLength(1);
});

test("a failed list read after a save is reported while the form is untouched", async () => {
  const f = await fixture();
  vi.spyOn(f.bridge, "listProfiles").mockResolvedValue(unavailableReload);
  f.profiles.setConnectionForm(f.form);
  await f.profiles.addProfile();
  expect(f.feedback.getSnapshot().lastError).toBe(t("sessionUnavailable"));
});

test("a failed list read after a password change stays silent when the form was edited meanwhile", async () => {
  const f = await savedProfile();
  vi.spyOn(f.bridge, "listProfiles").mockResolvedValue(unavailableReload);
  const changing = f.profiles.changeProfilePassword(f.profile, f.form.password, "new-password");
  f.profiles.setConnectionForm({ profileName: "Other draft" });
  expect(await changing).toBe(true);
  expect(f.feedback.getSnapshot().lastError).toBe("");
  expect(f.profiles.getSnapshot().connectionForm.profileName).toBe("Other draft");
});

test("a rejected password change stays silent when the form was edited meanwhile", async () => {
  const f = await savedProfile();
  const changing = f.profiles.changeProfilePassword(f.profile, "wrong password", "new-password");
  f.profiles.setConnectionForm({ profileName: "Other draft" });
  expect(await changing).toBe(false);
  expect(f.feedback.getSnapshot().lastError).toBe("");
  expect(f.profiles.getSnapshot().phase).toEqual({ kind: "idle" });
  expect(await f.profiles.changeProfilePassword(f.profile, "wrong password", "new-password")).toBe(
    false,
  );
  expect(f.feedback.getSnapshot().lastError).not.toBe("");
});

// Pins the SessionBridge contract the save flow relies on: an aborted request never resolves ok.
test("closing the dialog during a save settles it as cancelled and cannot end a newer operation", async () => {
  const requested = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let held = 0;
  const f = await profilesFixture(cleanup, async (_request, forward) => {
    const hold = ++held;
    if (hold === 1) requested.resolve();
    else second.resolve();
    await release.promise;
    return forward();
  });
  const saveResults: unknown[] = [];
  const originalSave = f.bridge.saveProfile.bind(f.bridge);
  vi.spyOn(f.bridge, "saveProfile").mockImplementation(async (...args) => {
    const result = await originalSave(...args);
    saveResults.push(result);
    return result;
  });
  f.profiles.setConnectionForm(f.form);
  const first = f.profiles.addProfile();
  await requested.promise;
  f.profiles.closeConnectionDialog();
  await f.profiles.loadProfile(newProfileId);
  f.profiles.setConnectionForm({ ...f.form, profileName: "Newer server" });
  const newer = f.profiles.addProfile();
  await second.promise;
  await first;
  expect(saveResults).toMatchObject([{ ok: false, error: { kind: "cancelled" } }]);
  expect(f.profiles.isConnecting).toBe(true);
  expect(f.profiles.getSnapshot().profiles).toEqual([]);
  release.resolve();
  await newer;
  expect(f.profiles.isConnecting).toBe(false);
  expect(f.profiles.authenticatingProfileId).toBeNull();
  expect(f.profiles.getSnapshot().profiles.map((profile) => profile.name)).toEqual([
    "Newer server",
  ]);
});

test("a server saved without remembering is stored as a session profile", async () => {
  const f = await fixture();
  f.profiles.setConnectionForm({ ...f.form, remember: false });
  await f.profiles.addProfile();
  expect(f.profiles.getSnapshot().profiles.map((profile) => profile.scope)).toEqual(["session"]);
});

test("a migration whose follow-up list read fails after the dialog closed reports nothing", async () => {
  const f = await fixture();
  const profile = await seedLegacyProfile(f);
  const read = Promise.withResolvers<typeof unavailableReload>();
  const reading = Promise.withResolvers<void>();
  vi.spyOn(f.bridge, "listProfiles").mockImplementation(() => {
    reading.resolve();
    return read.promise;
  });
  const migrating = f.profiles.migrateAndEnterProfile(profile, "new-password");
  await reading.promise;
  f.profiles.closeUnlockDialog();
  read.resolve(unavailableReload);
  expect(await migrating).toBe(false);
  expect(f.feedback.getSnapshot().lastError).toBe("");
  expect(f.profiles.getSnapshot().phase).toEqual({ kind: "idle" });
  expect(await idbGetAll("profiles")).toEqual([
    expect.objectContaining({ id: "legacy", apiKey: expect.objectContaining({ v: 2 }) }),
  ]);
});

test("a delete reply older than a synchronized newer vault version never moves the revision backwards", async () => {
  const f = await savedProfile();
  await f.profiles.loadProfile(newProfileId);
  f.profiles.setConnectionForm({ ...f.form, profileName: "Second" });
  await f.profiles.addProfile();
  expect(f.profiles.getSnapshot().profiles).toHaveLength(2);
  cleanup.push(f.profiles.startVaultSync());
  const [target, kept] = f.profiles.getSnapshot().profiles;
  expect.assert(target && kept);
  const revisions: number[] = [];
  cleanup.push(
    f.profiles.subscribe(() => {
      const revision = f.profiles.getSnapshot().version?.profilesRevision;
      if (revision !== undefined) revisions.push(revision);
    }),
  );
  const deleted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const originalDelete = f.bridge.deleteProfile.bind(f.bridge);
  vi.spyOn(f.bridge, "deleteProfile").mockImplementation(async (...args) => {
    const result = await originalDelete(...args);
    deleted.resolve();
    await release.promise;
    return result;
  });
  f.profiles.deleteProfile(target);
  const confirming = f.profiles.confirmDeleteProfile();
  await deleted.promise;
  const peer = await f.peer("owner-b");
  await peer.profiles.reloadProfiles();
  peer.profiles.setConnectionForm({ ...f.form, profileName: "Third" });
  await peer.profiles.addProfile();
  const newest = peer.profiles.getSnapshot().version?.profilesRevision;
  expect.assert(newest !== undefined);
  await expect.poll(() => f.profiles.getSnapshot().version?.profilesRevision).toBe(newest);
  release.resolve();
  await confirming;
  expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
  expect(f.profiles.getSnapshot().version?.profilesRevision).toBe(newest);
  expect(
    f.profiles
      .getSnapshot()
      .profiles.map((profile) => profile.name)
      .sort(),
  ).toEqual([kept.name, "Third"].sort());
  expect(f.profiles.getSnapshot().pendingDeleteProfile).toBeNull();
});

test("a failed list read after a delete stays silent once the confirmation was dismissed", async () => {
  const f = await savedProfile();
  f.profiles.deleteProfile(f.profile);
  vi.spyOn(f.bridge, "listProfiles").mockResolvedValue(unavailableReload);
  const deleting = f.profiles.confirmDeleteProfile();
  f.profiles.setState({ pendingDeleteProfile: null });
  await deleting;
  expect(f.feedback.getSnapshot().lastError).toBe("");
  expect(f.profiles.getSnapshot()).toMatchObject({
    profiles: [],
    pendingDeleteProfile: null,
    phase: { kind: "idle" },
  });
});

test("a completed delete does not clear a confirmation that already moved to another profile", async () => {
  const f = await savedProfile();
  await f.profiles.loadProfile(newProfileId);
  f.profiles.setConnectionForm({ ...f.form, profileName: "Second" });
  await f.profiles.addProfile();
  const { profiles, connectionForm } = f.profiles.getSnapshot();
  const target = profiles.find((profile) => profile.id !== connectionForm.profileId);
  const other = profiles.find((profile) => profile.id === connectionForm.profileId);
  expect.assert(target && other);
  f.profiles.deleteProfile(target);
  const deleting = f.profiles.confirmDeleteProfile();
  f.profiles.deleteProfile(other);
  await deleting;
  expect(f.profiles.getSnapshot().profiles).toEqual([other]);
  expect(f.profiles.getSnapshot().connectionForm.profileId).toBe(other.id);
  expect(f.profiles.getSnapshot().pendingDeleteProfile).toEqual(other);
  expect(f.profiles.getSnapshot().phase).toEqual({ kind: "idle" });
});
