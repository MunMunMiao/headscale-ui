import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { __resetForTest, DB_VERSION } from "@/lib/idb";
import type { ProfileSummary } from "@/lib/profile-storage";
import {
  hydrateSettings,
  settingsStorageTestingHandle,
} from "@/lib/settings-storage";
import { createSessionBridge } from "@/session/bridge";
import { createSessionHost } from "@/session/host";
import { createSession, type Session } from "./session-context";
import { createConnectionDialog } from "./useConnectionDialog";
import { newProfileId } from "./useProfiles";

let session: Session;
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const stop of cleanup.splice(0).reverse()) await stop();
});
beforeEach(async () => {
  __resetForTest();
  globalThis.indexedDB = new IDBFactory();
  settingsStorageTestingHandle.reset();
  await hydrateSettings();
  const host = await createSessionHost("connection-dialog-test");
  cleanup.push(() => host.dispose());
  const channel = new MessageChannel();
  host.connect(channel.port2);
  const bridge = createSessionBridge({
    openPort: () => channel.port1,
    ownerTabId: () => "dialog-owner",
    buildId: "connection-dialog-test",
    storageVersion: DB_VERSION,
  });
  cleanup.push(() => {
    bridge.dispose();
    channel.port1.close();
    channel.port2.close();
  });
  expect((await bridge.connect()).ok).toBe(true);
  const profiles = await bridge.listProfiles();
  if (!profiles.ok) throw new Error("Profile list failed");
  session = createSession({ bridge, profiles: profiles.value });
});
const missing: ProfileSummary = {
  id: "missing-profile",
  name: "Missing",
  baseUrl: "https://headscale.example",
  keyEpoch: "fixture-epoch",
  credentialVersion: "credential-version",
  credentialKind: "password",
  updatedAt: "2026-01-01T00:00:00.000Z",
  scope: "persistent",
};
// Catches lost dirty-close confirmation and discard/clean close behavior.
test("tracks the form baseline and confirms dirty closes", async () => {
  const dialog = createConnectionDialog(session.profiles);
  await dialog.openConnectionDialogWithBaseline(newProfileId);
  expect(session.profiles.getSnapshot().connectionDialogOpen).toBe(true);
  session.profiles.setConnectionForm({ profileName: "Changed" });
  dialog.requestConnectionDialogClose();
  expect(session.profiles.getSnapshot().connectionCloseConfirmOpen).toBe(true);
  dialog.handleConnectionCloseConfirmOpen(false);
  dialog.confirmConnectionDialogClose();
  expect(session.profiles.getSnapshot().connectionDialogOpen).toBe(false);
  await dialog.editProfileWithBaseline(missing);
  dialog.requestConnectionDialogClose();
  expect(session.profiles.getSnapshot().connectionDialogOpen).toBe(false);
  dialog.handleConnectionDialogOpen(true);
  expect(session.profiles.getSnapshot().connectionDialogOpen).toBe(true);
  dialog.syncConnectionFormBaseline();
  dialog.handleConnectionDialogOpen(false);
  expect(session.profiles.getSnapshot().connectionDialogOpen).toBe(false);
});
// Uses standard Base UI reasons instead of removed Reka custom events; nested Escape is tested with the page.
test("blocks outside dismissal and routes Escape through dirty confirmation", async () => {
  const dialog = createConnectionDialog(session.profiles);
  await dialog.openConnectionDialogWithBaseline(newProfileId);
  let canceled = false;
  dialog.handleConnectionDialogOpen(false, {
    reason: "outside-press",
    cancel() {
      canceled = true;
    },
  });
  expect(canceled).toBe(true);
  expect(session.profiles.getSnapshot().connectionDialogOpen).toBe(true);
  dialog.handleConnectionDialogOpen(false, {
    reason: "escape-key",
    cancel() {},
  });
  expect(session.profiles.getSnapshot().connectionDialogOpen).toBe(false);
  await dialog.openConnectionDialogWithBaseline(newProfileId);
  session.profiles.setConnectionForm({ apiKey: "edited" });
  dialog.handleConnectionDialogOpen(false, {
    reason: "escape-key",
    cancel() {},
  });
  expect(session.profiles.getSnapshot().connectionDialogOpen).toBe(true);
  expect(session.profiles.getSnapshot().connectionCloseConfirmOpen).toBe(true);
});

test("opening an existing profile does not mark later user input as clean", async () => {
  const dialog = createConnectionDialog(session.profiles);
  session.profiles.setState({ profiles: [missing] });
  const opening = dialog.openConnectionDialogWithBaseline(missing.id);
  session.profiles.setConnectionForm({ profileName: "Unsaved later input" });
  await opening;
  dialog.requestConnectionDialogClose();
  expect(session.profiles.getSnapshot().connectionCloseConfirmOpen).toBe(true);
});

test("password-only input is dirty and confirming discard clears both secret fields", async () => {
  const dialog = createConnectionDialog(session.profiles);
  await dialog.openConnectionDialogWithBaseline(newProfileId);
  session.profiles.setConnectionForm({ password: "unsaved server password" });
  dialog.requestConnectionDialogClose();
  expect(session.profiles.getSnapshot().connectionCloseConfirmOpen).toBe(true);
  expect(session.profiles.getSnapshot().connectionDialogOpen).toBe(true);
  dialog.confirmConnectionDialogClose();
  expect(session.profiles.getSnapshot().connectionForm).toMatchObject({
    apiKey: "",
    password: "",
  });
  expect(session.profiles.getSnapshot().connectionDialogOpen).toBe(false);
});

test("a confirmation-only draft is dirty and discarding clears its secret", async () => {
  const dialog = createConnectionDialog(session.profiles);
  await dialog.openConnectionDialogWithBaseline(newProfileId);
  session.profiles.setConnectionForm({
    passwordConfirmation: "confirmation only",
  });
  expect(dialog.isConnectionFormDirty()).toBe(true);
  dialog.requestConnectionDialogClose();
  expect(session.profiles.getSnapshot().connectionCloseConfirmOpen).toBe(true);
  dialog.confirmConnectionDialogClose();
  expect(
    session.profiles.getSnapshot().connectionForm.passwordConfirmation,
  ).toBe("");
});

test("synchronizing the ordinary draft never treats entered secrets as clean saved data", async () => {
  const dialog = createConnectionDialog(session.profiles);
  await dialog.openConnectionDialogWithBaseline(newProfileId);
  session.profiles.setConnectionForm({
    apiKey: "pending credential",
    password: "pending password",
  });
  dialog.syncConnectionFormBaseline();
  dialog.requestConnectionDialogClose();
  expect(session.profiles.getSnapshot().connectionCloseConfirmOpen).toBe(true);
});
