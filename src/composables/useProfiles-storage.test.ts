import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { __resetForTest, STORE_PROFILES } from "@/lib/idb";
import { profilesFixture } from "@/test/profiles-fixture";
import { idbGet, idbGetAll } from "@/test-utils/storage";

const cleanup: (() => void | Promise<void>)[] = [];
beforeEach(() => {
  __resetForTest();
  globalThis.indexedDB = new IDBFactory();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const stop of cleanup.reverse().splice(0)) await stop();
});
async function saved() {
  const f = await profilesFixture(cleanup);
  f.profiles.setConnectionForm(f.form);
  await f.profiles.addProfile();
  const profile = f.profiles.getSnapshot().profiles[0];
  expect.assert(profile);
  return { ...f, profile };
}

test("a wrong independent password never marks a profile permanently corrupted", async () => {
  const f = await saved();
  const before = await idbGet(STORE_PROFILES, f.profile.id);
  expect(await f.profiles.enterProfile(f.profile, "wrong")).toBe(false);
  expect(await idbGet(STORE_PROFILES, f.profile.id)).toEqual(before);
  expect(f.profiles.getSnapshot().connectionForm).toMatchObject({ apiKey: "", password: "" });
  expect(f.feedback.getSnapshot().lastError).not.toBe("");
});

test("a committed save remains successful and visible when the subsequent list read fails", async () => {
  const f = await profilesFixture(cleanup);
  f.profiles.setConnectionForm(f.form);
  const originalPut = IDBObjectStore.prototype.put;
  const originalRead = IDBObjectStore.prototype.getAll;
  let committed = false;
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    if (this.name === STORE_PROFILES)
      this.transaction.addEventListener(
        "complete",
        () => {
          committed = true;
        },
        { once: true },
      );
    return originalPut.apply(this, args);
  });
  vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    if (this.name === STORE_PROFILES && committed)
      throw new DOMException("Read denied", "SecurityError");
    return originalRead.apply(this, args);
  });
  const saving = f.profiles.persistConnection();
  await expect(saving).resolves.toBeTypeOf("string");
  const id = await saving;
  expect(await idbGet(STORE_PROFILES, id)).toMatchObject({ id, name: f.form.profileName });
  expect(f.profiles.getSnapshot()).toMatchObject({
    profiles: [expect.objectContaining({ id })],
    connectionForm: { profileId: id, apiKey: "", password: "" },
    connectionDialogOpen: false,
  });
  expect(f.feedback.getSnapshot().lastError).not.toBe("");
});

test("a failed native deletion preserves the credential and its confirmation for explicit retry", async () => {
  const f = await saved();
  const before = await idbGet(STORE_PROFILES, f.profile.id);
  f.profiles.deleteProfile(f.profile);
  const original = IDBObjectStore.prototype.delete;
  const fault = vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    if (this.name === STORE_PROFILES) throw new DOMException("quota", "QuotaExceededError");
    return original.apply(this, args);
  });
  await f.profiles.confirmDeleteProfile();
  expect(await idbGet(STORE_PROFILES, f.profile.id)).toEqual(before);
  expect(f.profiles.getSnapshot().pendingDeleteProfile?.id).toBe(f.profile.id);
  expect(f.feedback.getSnapshot().lastError).not.toBe("");
  fault.mockRestore();
  await f.profiles.confirmDeleteProfile();
  expect(await idbGet(STORE_PROFILES, f.profile.id)).toBeUndefined();
});

test("a CAS conflict refreshes the revision, retains the ordinary draft, and requires secrets to be reentered for an explicit retry", async () => {
  const f = await profilesFixture(cleanup);
  const peer = await f.peer("owner-b");
  f.profiles.setConnectionForm(f.form);
  peer.profiles.setConnectionForm({ ...f.form, profileName: "Peer" });
  await peer.profiles.addProfile();
  await expect(f.profiles.persistConnection()).rejects.toMatchObject({ kind: "storage-conflict" });
  expect(f.profiles.getSnapshot().connectionForm).toMatchObject({
    profileName: "My server",
    apiKey: "",
    password: "",
  });
  expect(f.profiles.getSnapshot().version).toEqual(peer.profiles.getSnapshot().version);
  await expect(f.profiles.persistConnection()).rejects.toThrow();
  f.profiles.setConnectionForm({ apiKey: f.form.apiKey, password: f.form.password });
  const id = await f.profiles.persistConnection();
  expect(await idbGet(STORE_PROFILES, id)).toMatchObject({ name: "My server" });
  expect(await idbGetAll(STORE_PROFILES)).toHaveLength(2);
});

test("another page changing the password while encryption is pending prevents the stale replacement from committing", async () => {
  const f = await saved();
  const peer = await f.peer("owner-b");
  await f.profiles.openConnectionDialog(f.profile.id);
  f.profiles.setConnectionForm({ apiKey: "replacement-api-key", password: f.form.password });
  const encrypted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const nativeEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "encrypt").mockImplementationOnce(async (...args) => {
    const result = await nativeEncrypt(...args);
    encrypted.resolve();
    await release.promise;
    return result;
  });
  const saving = f.profiles.persistConnection().catch((error: unknown) => error);
  await encrypted.promise;
  try {
    expect(
      await peer.profiles.changeProfilePassword(f.profile, f.form.password, "peer-password"),
    ).toBe(true);
    release.resolve();
    expect(await saving).toMatchObject({ kind: "storage-conflict" });
    expect(f.profiles.getSnapshot().connectionForm).toMatchObject({
      profileName: "My server",
      apiKey: "",
      password: "",
    });
    expect(f.profiles.getSnapshot().connectionDialogOpen).toBe(true);
    const current = f.profiles.getSnapshot().profiles[0];
    expect.assert(current);
    expect(await f.profiles.enterProfile(current, "peer-password")).toBe(true);
    expect(await idbGetAll(STORE_PROFILES)).toHaveLength(1);
  } finally {
    release.resolve();
    await saving;
  }
});

test("request success followed by transaction abort leaves no saved profile or validation-bypass prompt", async () => {
  const f = await profilesFixture(cleanup);
  f.profiles.setConnectionForm(f.form);
  f.profiles.setState({ connectionDialogOpen: true });
  const original = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    const request = original.apply(this, args);
    if (this.name === STORE_PROFILES)
      request.addEventListener("success", () => this.transaction.abort(), { once: true });
    return request;
  });
  await f.profiles.addProfile();
  expect(f.server.requests).toHaveLength(7);
  expect(await idbGetAll(STORE_PROFILES)).toEqual([]);
  expect(f.profiles.getSnapshot()).toMatchObject({
    connectionDialogOpen: true,
    profileValidationDialogOpen: false,
    connectionForm: { profileName: "My server", apiKey: "", password: "" },
  });
  expect(f.feedback.getSnapshot().lastError).not.toBe("");
});

test("reset cancels a pending encrypted save and neither its reply nor ciphertext can refill the reset projection", async () => {
  const f = await profilesFixture(cleanup);
  const peer = await f.peer("owner-b");
  const stop = f.bridge.subscribeReset((version) => f.profiles.resetProjection(version));
  f.profiles.setConnectionForm(f.form);
  const encrypted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const nativeEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "encrypt").mockImplementationOnce(async (...args) => {
    const result = await nativeEncrypt(...args);
    encrypted.resolve();
    await release.promise;
    return result;
  });
  const saving = f.profiles.addProfile();
  await encrypted.promise;
  try {
    const result = await peer.profiles.resetLocalData();
    expect(result.committed).toBe(true);
    await saving;
    release.resolve();
    expect(f.profiles.getSnapshot()).toMatchObject({
      profiles: [],
      phase: { kind: "idle" },
      connectionForm: { apiKey: "", password: "", profileName: "" },
    });
    expect(f.feedback.getSnapshot().lastError).toBe("");
    expect(await idbGetAll(STORE_PROFILES)).toEqual([]);
  } finally {
    stop();
    release.resolve();
    await saving;
  }
});

test("closing during legacy encryption cancels migration and cannot log in after the close", async () => {
  const f = await profilesFixture(cleanup);
  const { idbPut } = await import("@/test-utils/storage");
  const legacy = {
    id: "legacy",
    name: "Legacy",
    baseUrl: f.form.baseUrl,
    scope: "persistent",
    updatedAt: "2026-10-11",
    apiKey: "legacy-key",
    keyEpoch: f.profiles.getSnapshot().version?.keyEpoch,
  };
  await idbPut(STORE_PROFILES, legacy);
  await f.profiles.reloadProfiles();
  const profile = f.profiles.getSnapshot().profiles[0];
  expect.assert(profile);
  const encrypted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const nativeEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "encrypt").mockImplementationOnce(async (...args) => {
    const result = await nativeEncrypt(...args);
    encrypted.resolve();
    await release.promise;
    return result;
  });
  const migrating = f.profiles.migrateAndEnterProfile(profile, "new-password");
  await encrypted.promise;
  try {
    f.profiles.closeConnectionDialog();
    release.resolve();
    expect(await migrating).toBe(false);
    expect(f.bridge.getSessionSnapshot()?.status).toBe("locked");
    expect(f.server.requests).toEqual([]);
    expect(await idbGet(STORE_PROFILES, profile.id)).toEqual(legacy);
  } finally {
    release.resolve();
    await migrating;
  }
});

test("disposing list synchronization prevents a queued read failure from changing a newer page's feedback", async () => {
  const f = await saved();
  const stop = f.profiles.startVaultSync();
  const original = IDBObjectStore.prototype.getAll;
  vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    if (this.name === STORE_PROFILES) {
      f.ports.pause();
      throw new DOMException("Read denied", "SecurityError");
    }
    return original.apply(this, args);
  });
  f.ports.worker.postMessage({ type: "profiles-changed" });
  await expect.poll(() => f.ports.queued()).toBeGreaterThan(0);
  stop();
  f.feedback.setState({ lastError: "New page feedback" });
  f.ports.resume();
  await f.bridge.check();
  expect(f.feedback.getSnapshot().lastError).toBe("New page feedback");
});

test("password changes are single-flight and closing cancels encryption without publishing a late error", async () => {
  const f = await saved();
  const before = await idbGet(STORE_PROFILES, f.profile.id);
  const encrypted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const nativeEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "encrypt").mockImplementationOnce(async (...args) => {
    const result = await nativeEncrypt(...args);
    encrypted.resolve();
    await release.promise;
    return result;
  });
  const changing = f.profiles.changeProfilePassword(f.profile, f.form.password, "replacement");
  await encrypted.promise;
  try {
    expect(await f.profiles.changeProfilePassword(f.profile, f.form.password, "second")).toBe(
      false,
    );
    f.profiles.closeConnectionDialog();
    f.feedback.setState({ lastError: "New form" });
    release.resolve();
    expect(await changing).toBe(false);
    expect(await idbGet(STORE_PROFILES, f.profile.id)).toEqual(before);
    expect(f.feedback.getSnapshot().lastError).toBe("New form");
  } finally {
    release.resolve();
    await changing;
  }
});

test("repeated delete confirmation sends one storage operation and does not turn success into a conflict", async () => {
  const f = await saved();
  f.profiles.deleteProfile(f.profile);
  let deletes = 0;
  f.ports.worker.addEventListener("message", (event: MessageEvent) => {
    if (event.data?.type === "request" && event.data.command?.type === "profiles.delete") deletes++;
  });
  await Promise.all([f.profiles.confirmDeleteProfile(), f.profiles.confirmDeleteProfile()]);
  expect(await idbGet(STORE_PROFILES, f.profile.id)).toBeUndefined();
  expect(f.feedback.getSnapshot().lastError).toBe("");
  expect(deletes).toBe(1);
});

test("an old delete failure cannot overwrite a newer confirmation or its feedback", async () => {
  const f = await saved();
  f.profiles.deleteProfile(f.profile);
  const original = IDBObjectStore.prototype.delete;
  vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    if (this.name === STORE_PROFILES) {
      f.ports.pause();
      throw new DOMException("quota", "QuotaExceededError");
    }
    return original.apply(this, args);
  });
  const deleting = f.profiles.confirmDeleteProfile();
  await expect.poll(() => f.ports.queued()).toBeGreaterThan(0);
  const newer = { ...f.profile, id: "another-profile" };
  f.profiles.deleteProfile(newer);
  f.feedback.setState({ lastError: "Another confirmation" });
  f.ports.resume();
  await deleting;
  expect(f.profiles.getSnapshot().pendingDeleteProfile).toBe(newer);
  expect(f.feedback.getSnapshot().lastError).toBe("Another confirmation");
});

function failProfileReadsAfterWrite(operation: "put" | "delete") {
  let committed = false;
  const nativeWrite = IDBObjectStore.prototype[operation];
  const nativeRead = IDBObjectStore.prototype.getAll;
  if (operation === "put") {
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      ...args
    ) {
      if (this.name === STORE_PROFILES)
        this.transaction.addEventListener(
          "complete",
          () => {
            committed = true;
          },
          { once: true },
        );
      return (nativeWrite as IDBObjectStore["put"]).apply(this, args);
    });
  } else {
    vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function (
      this: IDBObjectStore,
      ...args
    ) {
      if (this.name === STORE_PROFILES)
        this.transaction.addEventListener(
          "complete",
          () => {
            committed = true;
          },
          { once: true },
        );
      return (nativeWrite as IDBObjectStore["delete"]).apply(this, args);
    });
  }
  vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    if (this.name === STORE_PROFILES && committed)
      throw new DOMException("Read denied", "SecurityError");
    return nativeRead.apply(this, args);
  });
}

test("a committed password change remains successful when listing fails, preserving the new credential version", async () => {
  const f = await saved();
  failProfileReadsAfterWrite("put");
  expect(await f.profiles.changeProfilePassword(f.profile, f.form.password, "replacement")).toBe(
    true,
  );
  const current = f.profiles.getSnapshot().profiles[0];
  expect.assert(current);
  expect(current.credentialVersion).not.toBe(f.profile.credentialVersion);
  expect(f.feedback.getSnapshot().lastError).not.toBe("");
  expect(await f.profiles.enterProfile(current, "replacement")).toBe(true);
});

test("a committed deletion removes the confirmation and summary even if listing fails", async () => {
  const f = await saved();
  failProfileReadsAfterWrite("delete");
  f.profiles.deleteProfile(f.profile);
  await f.profiles.confirmDeleteProfile();
  expect(await idbGet(STORE_PROFILES, f.profile.id)).toBeUndefined();
  expect(f.profiles.getSnapshot()).toMatchObject({ profiles: [], pendingDeleteProfile: null });
  expect(f.feedback.getSnapshot().lastError).not.toBe("");
});

test.each(["save", "password", "delete"] as const)(
  "%s conflict remains the primary error when its recovery read also fails",
  async (operation) => {
    const f = await saved();
    const peer = await f.peer("owner-b");
    await peer.profiles.loadProfile(f.profile.id);
    peer.profiles.setConnectionForm({ profileName: "Peer rename" });
    await peer.profiles.addProfile();
    const nativeRead = IDBObjectStore.prototype.getAll;
    vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (
      this: IDBObjectStore,
      ...args
    ) {
      if (this.name === STORE_PROFILES) throw new DOMException("Read denied", "SecurityError");
      return nativeRead.apply(this, args);
    });
    if (operation === "save") {
      await f.profiles.loadProfile(f.profile.id);
      f.profiles.setConnectionForm({ profileName: "Old rename" });
      await f.profiles.addProfile();
    } else if (operation === "password") {
      expect(
        await f.profiles.changeProfilePassword(f.profile, f.form.password, "replacement"),
      ).toBe(false);
    } else {
      f.profiles.deleteProfile(f.profile);
      await f.profiles.confirmDeleteProfile();
    }
    expect(f.feedback.getSnapshot().lastError).toBe(t("vaultConflict"));
    expect(await idbGet(STORE_PROFILES, f.profile.id)).toMatchObject({ name: "Peer rename" });
  },
);

test("an active list subscription reports an unreadable repository without deleting existing summaries", async () => {
  const f = await saved();
  const stop = f.profiles.startVaultSync();
  cleanup.push(stop);
  const nativeRead = IDBObjectStore.prototype.getAll;
  vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    if (this.name === STORE_PROFILES) throw new DOMException("Read denied", "SecurityError");
    return nativeRead.apply(this, args);
  });
  f.ports.worker.postMessage({ type: "profiles-changed" });
  await expect.poll(() => f.feedback.getSnapshot().lastError).not.toBe("");
  expect(f.profiles.getSnapshot().profiles).toEqual([f.profile]);
});

test("a migrated record stays visible as password encrypted when the following list read fails", async () => {
  const f = await profilesFixture(cleanup);
  const { idbPut } = await import("@/test-utils/storage");
  await idbPut(STORE_PROFILES, {
    id: "legacy",
    name: "Legacy",
    baseUrl: f.form.baseUrl,
    scope: "persistent",
    updatedAt: "2026-10-11",
    apiKey: "legacy-key",
    keyEpoch: f.profiles.getSnapshot().version?.keyEpoch,
  });
  await f.profiles.reloadProfiles();
  const profile = f.profiles.getSnapshot().profiles[0];
  expect.assert(profile);
  failProfileReadsAfterWrite("put");
  expect(await f.profiles.migrateAndEnterProfile(profile, "new-password")).toBe(false);
  expect(await idbGet(STORE_PROFILES, profile.id)).toMatchObject({ apiKey: { v: 2 } });
  expect(f.profiles.getSnapshot().profiles[0]?.credentialKind).toBe("password");
  expect(f.feedback.getSnapshot().lastError).toBe(t("sessionSavedLocked"));
  expect(f.bridge.getSessionSnapshot()?.status).toBe("locked");
});

import { t } from "@/i18n";
import type { PublicSessionSnapshot, WorkerMessage } from "@/session/types";

test("a successful unlock reply delayed behind a peer switch cannot report the old identity as current", async () => {
  const f = await saved();
  const peer = await f.peer("owner-b");
  const send = f.ports.worker.postMessage.bind(f.ports.worker);
  const held = Promise.withResolvers<WorkerMessage>();
  vi.spyOn(f.ports.worker, "postMessage").mockImplementation((value: unknown) => {
    const message = value as WorkerMessage;
    if (
      message.type === "reply" &&
      message.result.ok &&
      (message.result.value as PublicSessionSnapshot)?.status === "unlocked"
    )
      held.resolve(message);
    else send(value);
  });
  const unlocking = f.profiles.enterProfile(f.profile, f.form.password);
  const oldReply = await held.promise;
  await expect.poll(() => peer.bridge.getSessionSnapshot()?.status).toBe("unlocked");
  expect(await peer.profiles.enterProfile(f.profile, f.form.password)).toBe(true);
  await expect
    .poll(() => f.bridge.getSessionSnapshot()?.identity)
    .toEqual(peer.bridge.getSessionSnapshot()?.identity);
  send(oldReply);
  expect(await unlocking).toBe(false);
  expect(f.feedback.getSnapshot().lastError).toBe("");
});

async function legacyProfile(f: Awaited<ReturnType<typeof profilesFixture>>) {
  const { idbPut } = await import("@/test-utils/storage");
  await idbPut(STORE_PROFILES, {
    id: "legacy",
    name: "Legacy",
    baseUrl: f.form.baseUrl,
    scope: "persistent",
    updatedAt: "2026-10-11",
    apiKey: "legacy-key",
    keyEpoch: f.profiles.getSnapshot().version?.keyEpoch,
  });
  await f.profiles.reloadProfiles();
  const profile = f.profiles.getSnapshot().profiles.find((item) => item.id === "legacy");
  expect.assert(profile);
  return profile;
}

test("migration failure leaves the legacy row retryable and publishes its actual failure", async () => {
  const f = await profilesFixture(cleanup);
  const profile = await legacyProfile(f);
  const before = await idbGet(STORE_PROFILES, profile.id);
  expect(await f.profiles.migrateAndEnterProfile(profile, "")).toBe(false);
  expect(f.feedback.getSnapshot().lastError).not.toBe("");
  expect(f.profiles.isConnecting).toBe(false);
  expect(await idbGet(STORE_PROFILES, profile.id)).toEqual(before);
});

test("a peer switching identity during migration keeps its connection while the migrated profile stays saved and locked", async () => {
  const f = await saved();
  expect(await f.profiles.enterProfile(f.profile, f.form.password)).toBe(true);
  const legacy = await legacyProfile(f);
  const peer = await f.peer("owner-b");
  const encrypted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const nativeEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "encrypt").mockImplementationOnce(async (...args) => {
    const result = await nativeEncrypt(...args);
    encrypted.resolve();
    await release.promise;
    return result;
  });
  const migrating = f.profiles.migrateAndEnterProfile(legacy, "new-password");
  await encrypted.promise;
  try {
    expect(await peer.profiles.enterProfile(f.profile, f.form.password)).toBe(true);
    const current = peer.bridge.getSessionSnapshot()?.identity;
    release.resolve();
    expect(await migrating).toBe(false);
    expect(f.bridge.getSessionSnapshot()?.identity).toEqual(current);
    expect(f.feedback.getSnapshot().lastError).toBe(t("sessionSavedLocked"));
    expect(await idbGet(STORE_PROFILES, legacy.id)).toMatchObject({ apiKey: { v: 2 } });
  } finally {
    release.resolve();
    await migrating;
  }
});

test.each(["migration", "delete"] as const)(
  "closing during the post-commit %s list read cannot publish stale UI",
  async (operation) => {
    const f = await saved();
    const profile = operation === "migration" ? await legacyProfile(f) : f.profile;
    const originalPut = IDBObjectStore.prototype.put;
    const originalDelete = IDBObjectStore.prototype.delete;
    const originalRead = IDBObjectStore.prototype.getAll;
    let committed = false;
    const reading = Promise.withResolvers<void>();
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      ...args
    ) {
      if (this.name === STORE_PROFILES)
        this.transaction.addEventListener(
          "complete",
          () => {
            committed = true;
          },
          { once: true },
        );
      return originalPut.apply(this, args);
    });
    vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function (
      this: IDBObjectStore,
      ...args
    ) {
      if (this.name === STORE_PROFILES)
        this.transaction.addEventListener(
          "complete",
          () => {
            committed = true;
          },
          { once: true },
        );
      return originalDelete.apply(this, args);
    });
    vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (
      this: IDBObjectStore,
      ...args
    ) {
      if (this.name === STORE_PROFILES && committed) {
        f.ports.pause();
        reading.resolve();
      }
      return originalRead.apply(this, args);
    });
    f.profiles.deleteProfile(profile);
    const operationPromise =
      operation === "migration"
        ? f.profiles.migrateAndEnterProfile(profile, "new-password")
        : f.profiles.confirmDeleteProfile();
    await reading.promise;
    f.profiles.closeUnlockDialog();
    f.feedback.setState({ lastError: "New screen" });
    f.ports.resume();
    await operationPromise;
    expect(f.feedback.getSnapshot().lastError).toBe("New screen");
    expect(f.profiles.isConnecting).toBe(false);
  },
);

test("a cancelled deletion may already be committed but its old reply cannot clear a newer draft", async () => {
  const f = await saved();
  f.profiles.deleteProfile(f.profile);
  f.ports.pause();
  const deleting = f.profiles.confirmDeleteProfile();
  await expect.poll(() => idbGet(STORE_PROFILES, f.profile.id)).toBeUndefined();
  f.profiles.closeConnectionDialog();
  f.profiles.setConnectionForm({ profileName: "New draft" });
  f.ports.resume();
  await deleting;
  expect(f.profiles.getSnapshot().connectionForm.profileName).toBe("New draft");
  expect(f.feedback.getSnapshot().lastError).toBe("");
});

test("an older commit receipt cannot overwrite a newer verified repository projection", async () => {
  const f = await profilesFixture(cleanup);
  const peer = await f.peer("owner-b");
  f.profiles.setConnectionForm(f.form);
  f.ports.pause();
  const saving = f.profiles.persistConnection();
  await expect.poll(() => idbGetAll(STORE_PROFILES)).toHaveLength(1);
  await peer.profiles.reloadProfiles();
  peer.profiles.setConnectionForm({ ...f.form, profileName: "Peer server" });
  await peer.profiles.persistConnection();
  const current = peer.profiles.getSnapshot();
  f.profiles.setState({ profiles: current.profiles, version: current.version });
  const nativeRead = IDBObjectStore.prototype.getAll;
  vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    if (this.name === STORE_PROFILES) throw new DOMException("Read denied", "SecurityError");
    return nativeRead.apply(this, args);
  });
  f.ports.resume();
  await saving;
  expect(f.profiles.getSnapshot().version).toEqual(current.version);
  expect(f.profiles.getSnapshot().profiles).toEqual(current.profiles);
});
