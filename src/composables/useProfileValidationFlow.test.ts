import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { setLocale, t } from "@/i18n";
import { getProductCopy } from "@/i18n/product-copy";
import { __resetForTest } from "@/lib/idb";
import { hydrateSettings, settingsStorageTestingHandle } from "@/lib/settings-storage";
import { createSessionHarness } from "@/test/session-host";
import { startSnapshotServer } from "@/test-utils/headscale.test";
import { createSession, type Session } from "./session-context";
import { createProfileValidationFlow } from "./useProfileValidationFlow";

let session: Session;
let fixture: ReturnType<typeof startSnapshotServer>;
let harness: Awaited<ReturnType<typeof createSessionHarness>>;
beforeEach(async () => {
  __resetForTest();
  globalThis.indexedDB = new IDBFactory();
  settingsStorageTestingHandle.reset();
  await hydrateSettings();
  harness = await createSessionHarness();
  session = createSession(await harness.openPage());
  fixture = startSnapshotServer();
});
afterEach(async () => {
  vi.restoreAllMocks();
  fixture.stop();
  await harness.dispose();
});
function draft() {
  session.profiles.setConnectionForm({
    baseUrl: fixture.baseUrl,
    apiKey: "isolated-key",
    password: "server password",
    profileName: "Server Alpha",
  });
}

test("keeps invalid input editable without saving or clearing its dirty baseline", async () => {
  let syncs = 0;
  const flow = createProfileValidationFlow(session, () => void syncs++);
  session.profiles.setConnectionForm({ baseUrl: "", apiKey: "key", password: "password" });
  await flow.submitAddProfile();
  expect(syncs).toBe(0);
  expect(session.profiles.getSnapshot().profileValidationDialogOpen).toBe(false);
  expect(session.feedback.getSnapshot().lastError).not.toBe("");
  expect(session.profiles.getSnapshot().connectionForm).toMatchObject({
    apiKey: "key",
    password: "password",
  });
  expect(fixture.requests).toEqual([]);
});

test("returns failed validation to the connection form without restoring secrets", () => {
  const flow = createProfileValidationFlow(session, () => {});
  session.profiles.setState({
    profileValidationError: "Unauthorized",
    profileValidationDialogOpen: true,
  });
  flow.reviewProfileConnection();
  expect(session.feedback.getSnapshot().lastError).toBe("Unauthorized");
  expect(session.profiles.getSnapshot().profileValidationDialogOpen).toBe(false);
  expect(session.profiles.getSnapshot().connectionForm).toMatchObject({ apiKey: "", password: "" });
});

test("requires freshly entered secrets before skipping failed validation for an existing profile", async () => {
  draft();
  await session.profiles.persistConnection();
  const saved = session.profiles.getSnapshot().profiles[0];
  if (!saved) throw new Error("Missing saved profile");
  await session.profiles.openConnectionDialog(saved.id);
  session.profiles.setConnectionForm({ profileName: "Still unsaved edit" });
  session.profiles.setState({
    profileValidationError: "Unauthorized",
    profileValidationDialogOpen: true,
  });
  let syncs = 0;
  const flow = createProfileValidationFlow(session, () => void syncs++);
  await flow.continueAddingProfile();
  expect(session.profiles.getSnapshot().profiles[0]?.name).toBe("Server Alpha");
  expect(session.profiles.getSnapshot().profileValidationDialogOpen).toBe(true);
  expect(session.feedback.getSnapshot().lastError).toBe(t("sessionSecretRequired"));
  expect(syncs).toBe(0);
});

test("explicitly persists fresh secrets without network validation and clears validation feedback", async () => {
  let syncs = 0;
  const flow = createProfileValidationFlow(session, () => void syncs++);
  draft();
  session.profiles.setState({
    profileValidationDialogOpen: true,
    profileValidationError: "Offline",
  });
  session.feedback.setState({ lastError: "Offline" });
  await flow.continueAddingProfile();
  expect(syncs).toBe(1);
  expect(session.profiles.getSnapshot().profiles).toHaveLength(1);
  expect(session.profiles.getSnapshot().connectionForm).toMatchObject({ apiKey: "", password: "" });
  expect(session.profiles.getSnapshot().profileValidationDialogOpen).toBe(false);
  expect(session.feedback.getSnapshot().lastError).toBe("");
  expect(fixture.requests).toEqual([]);
});

test("syncs a successful save and supports the explicit save-and-unlock action", async () => {
  let syncs = 0;
  const flow = createProfileValidationFlow(session, () => void syncs++);
  draft();
  await flow.submitAddProfile(true);
  expect(syncs).toBe(1);
  expect(session.auth.getSessionSnapshot()?.status).toBe("unlocked");
  expect(session.profiles.getSnapshot().connectionForm).toMatchObject({ apiKey: "", password: "" });
});

test("a save completion keeps later form edits dirty and leaves their dialog open", async () => {
  let syncs = 0;
  const flow = createProfileValidationFlow(session, () => void syncs++);
  draft();
  session.profiles.setState({ connectionDialogOpen: true });
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "encrypt").mockImplementation(async (...args) => {
    started.resolve();
    await release.promise;
    return encrypt(...args);
  });
  const saving = flow.continueAddingProfile();
  await started.promise;
  session.profiles.setConnectionForm({ profileName: "New unsaved input" });
  release.resolve();
  await saving;
  expect(session.profiles.getSnapshot().connectionForm.profileName).toBe("New unsaved input");
  expect(session.profiles.getSnapshot().connectionDialogOpen).toBe(true);
  expect(syncs).toBe(0);
});

test("failed explicit persistence leaves the ordinary draft and exposes the storage error", async () => {
  let syncs = 0;
  const flow = createProfileValidationFlow(session, () => void syncs++);
  draft();
  session.profiles.setState({ profileValidationDialogOpen: true });
  vi.spyOn(crypto.subtle, "encrypt").mockRejectedValueOnce(new Error("encryption unavailable"));
  await flow.continueAddingProfile();
  expect(session.profiles.getSnapshot().profiles).toEqual([]);
  expect(session.profiles.getSnapshot().connectionForm.profileName).toBe("Server Alpha");
  expect(session.feedback.getSnapshot().lastError).toBe(t("storageWrite"));
  expect(session.profiles.getSnapshot().profileValidationDialogOpen).toBe(false);
  expect(syncs).toBe(0);
});

test("a persistence failure for an outdated draft does not report against the newer form", async () => {
  let syncs = 0;
  const flow = createProfileValidationFlow(session, () => void syncs++);
  draft();
  session.profiles.setState({ profileValidationDialogOpen: true });
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  vi.spyOn(crypto.subtle, "encrypt").mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
    throw new Error("encryption unavailable");
  });
  const saving = flow.continueAddingProfile();
  await started.promise;
  session.profiles.setConnectionForm({ profileName: "Newer draft" });
  release.resolve();
  await saving;
  expect(session.feedback.getSnapshot().lastError).toBe("");
  expect(session.profiles.getSnapshot().profileValidationDialogOpen).toBe(true);
  expect(session.profiles.getSnapshot().connectionForm.profileName).toBe("Newer draft");
  expect(syncs).toBe(0);
});

test("a rejected API key explains itself in the validation dialog", async () => {
  const rejecting = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("Unauthorized", { status: 401 }),
  });
  try {
    const flow = createProfileValidationFlow(session, () => {});
    for (const locale of ["en-US", "zh-Hans"] as const) {
      await setLocale(locale);
      session.profiles.setConnectionForm({
        baseUrl: rejecting.url.origin,
        apiKey: "rejected-key",
        password: "server password",
        profileName: "Rejected",
      });
      await flow.submitAddProfile();
      expect(session.profiles.getSnapshot().profileValidationDialogOpen).toBe(true);
      expect(session.profiles.getSnapshot().profileValidationError).toBe(
        getProductCopy(locale).errorRequestFailed,
      );
      expect(session.profiles.getSnapshot().profiles).toEqual([]);
      session.profiles.setState({ profileValidationDialogOpen: false, profileValidationError: "" });
    }
  } finally {
    rejecting.stop(true);
    await setLocale("en-US");
  }
});
