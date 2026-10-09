import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { createRenderer, defineComponent } from "vue";
import { RestHeadscaleClient } from "@/api/headscale-client";
import { i18n } from "@/i18n";
import { __resetForTest } from "@/lib/idb";
import { hydrate, profileStorageTestingHandle } from "@/lib/profile-storage";
import { startSnapshotServer } from "@/test-utils/headscale.test";
import { resetAllSingletons } from "./__testing";
import { useActionFeedback } from "./useActionFeedback";
import { useHeadscaleClient } from "./useHeadscaleClient";
import { masterPasswordTestingHandle, useMasterPassword } from "./useMasterPassword";
import { useProfiles } from "./useProfiles";
import { useProfileValidationFlow } from "./useProfileValidationFlow";

function mountComposable<T>(setup: () => T): T {
  let result: T | undefined;
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
  const app = renderer.createApp(
    defineComponent({
      setup() {
        result = setup();
        return () => null;
      },
    }),
  );
  app.use(i18n);
  app.mount({});
  if (result === undefined) throw new Error("Composable setup did not run");
  return result;
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  __resetForTest();
  profileStorageTestingHandle.reset();
  masterPasswordTestingHandle.reset();
  resetAllSingletons();
  const masterPassword = useMasterPassword();
  await masterPassword.initialize();
  await hydrate({ encryptLegacy: masterPassword.encryptWithDeviceKey });
  (i18n.global.locale as unknown as { value: string }).value = "en-US";
});

let fixture: ReturnType<typeof startSnapshotServer>;
beforeEach(() => {
  fixture = startSnapshotServer();
  useHeadscaleClient().setSettings({ baseUrl: fixture.baseUrl, apiKey: "test-key" });
});
afterEach(() => {
  mock.restore();
  fixture.stop();
});

describe("useProfileValidationFlow", () => {
  test("keeps invalid input editable without saving or clearing its dirty baseline", async () => {
    let syncs = 0;
    const flow = mountComposable(() => useProfileValidationFlow(() => void syncs++));
    const profiles = useProfiles();
    Object.assign(profiles.connectionForm, { baseUrl: "", apiKey: "key" });
    await flow.submitAddProfile();
    expect(syncs).toBe(0);
    expect(profiles.profileValidationDialogOpen.value).toBe(false);
    expect(useActionFeedback().lastError.value).not.toBe("");

    profiles.profileValidationDialogOpen.value = true;
    await flow.continueAddingProfile();
    expect(syncs).toBe(0);
    expect(profiles.profiles.value).toEqual([]);
    expect(profiles.profileValidationDialogOpen.value).toBe(false);
    expect(useActionFeedback().lastError.value).not.toBe("");
    expect(fixture.requests).toEqual([]);
  });
  test("returns a failed validation to the connection form", () => {
    const flow = mountComposable(() => useProfileValidationFlow(() => {}));
    const profiles = useProfiles();
    Object.assign(profiles.connectionForm, { baseUrl: fixture.baseUrl, apiKey: "test-key" });
    const feedback = useActionFeedback();
    profiles.profileValidationError.value = "Unauthorized";
    profiles.profileValidationDialogOpen.value = true;

    flow.reviewProfileConnection();

    expect(feedback.lastError.value).toBe("Unauthorized");
    expect(profiles.profileValidationDialogOpen.value).toBe(false);
  });

  test("persists anyway, syncs the baseline, and clears validation feedback", async () => {
    let syncs = 0;
    const flow = mountComposable(() => useProfileValidationFlow(() => void syncs++));
    const profiles = useProfiles();
    Object.assign(profiles.connectionForm, { baseUrl: fixture.baseUrl, apiKey: "test-key" });
    const feedback = useActionFeedback();
    profiles.profileValidationDialogOpen.value = true;
    profiles.profileValidationError.value = "Offline";
    feedback.lastError.value = "Offline";

    await flow.continueAddingProfile();

    expect(syncs).toBe(1);
    expect(profiles.profiles.value).toHaveLength(1);
    expect(profiles.profileValidationDialogOpen.value).toBe(false);
    expect(profiles.profileValidationError.value).toBe("");
    expect(feedback.lastError.value).toBe("");
  });

  test("syncs a successful add but keeps a failed add in validation", async () => {
    let syncs = 0;
    const flow = mountComposable(() => useProfileValidationFlow(() => void syncs++));
    const profiles = useProfiles();
    Object.assign(profiles.connectionForm, { baseUrl: fixture.baseUrl, apiKey: "test-key" });

    await flow.submitAddProfile();
    expect(syncs).toBe(1);
    expect(profiles.profileValidationDialogOpen.value).toBe(false);

    spyOn(RestHeadscaleClient.prototype, "health").mockImplementation(async () => {
      throw new Error("server unavailable");
    });
    await flow.submitAddProfile();
    expect(syncs).toBe(1);
    expect(profiles.profileValidationDialogOpen.value).toBe(true);
    expect(profiles.profileValidationError.value).toBe("server unavailable");
  });
});
