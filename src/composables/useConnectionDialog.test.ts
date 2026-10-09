import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { createRenderer, defineComponent } from "vue";
import { i18n } from "@/i18n";
import { __resetForTest } from "@/lib/idb";
import {
  type ConnectionProfile,
  hydrate,
  profileStorageTestingHandle,
} from "@/lib/profile-storage";
import { resetAllSingletons } from "./__testing";
import { useConnectionDialog } from "./useConnectionDialog";
import { masterPasswordTestingHandle } from "./useMasterPassword";
import { newProfileId, useProfiles } from "./useProfiles";

class TestElement {
  constructor(private readonly nested: boolean) {}

  closest() {
    return this.nested ? this : null;
  }
}

const htmlElementDescriptor = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");

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

function event(target: unknown, originalTarget?: unknown) {
  let prevented = false;
  return {
    target,
    detail:
      originalTarget === undefined ? undefined : { originalEvent: { target: originalTarget } },
    preventDefault() {
      prevented = true;
    },
    get defaultPrevented() {
      return prevented;
    },
  } as unknown as Event & { readonly defaultPrevented: boolean };
}

function unsavedProfile(): ConnectionProfile {
  return {
    id: "missing-profile",
    name: "Missing",
    baseUrl: "https://headscale.example",
    apiKey: { v: 1, scheme: "device", iv: "iv", ct: "ct" },
    updatedAt: "2026-01-01T00:00:00.000Z",
    scope: "persistent",
  };
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  __resetForTest();
  profileStorageTestingHandle.reset();
  masterPasswordTestingHandle.reset();
  resetAllSingletons();
  await hydrate();
  (i18n.global.locale as unknown as { value: string }).value = "en-US";
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: TestElement,
  });
});

afterEach(() => {
  if (htmlElementDescriptor) {
    Object.defineProperty(globalThis, "HTMLElement", htmlElementDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "HTMLElement");
  }
});

describe("useConnectionDialog", () => {
  test("tracks the form baseline and confirms dirty closes", async () => {
    const dialog = mountComposable(useConnectionDialog);
    const profiles = useProfiles();

    await dialog.openConnectionDialogWithBaseline(newProfileId);
    expect(profiles.connectionDialogOpen.value).toBe(true);
    profiles.connectionForm.profileName = "Changed";
    dialog.requestConnectionDialogClose();
    expect(profiles.connectionCloseConfirmOpen.value).toBe(true);

    dialog.handleConnectionCloseConfirmOpen(false);
    dialog.confirmConnectionDialogClose();
    expect(profiles.connectionDialogOpen.value).toBe(false);

    await dialog.editProfileWithBaseline(unsavedProfile());
    dialog.requestConnectionDialogClose();
    expect(profiles.connectionDialogOpen.value).toBe(false);

    dialog.handleConnectionDialogOpen(true);
    expect(profiles.connectionDialogOpen.value).toBe(true);
    dialog.syncConnectionFormBaseline();
    dialog.handleConnectionDialogOpen(false);
    expect(profiles.connectionDialogOpen.value).toBe(false);
  });

  test("keeps nested dialogs open and blocks genuine outside or escape closes", () => {
    const dialog = mountComposable(useConnectionDialog);
    const profiles = useProfiles();
    const nested = event(new TestElement(true));
    dialog.preventConnectionDialogOutsideClose(nested);
    expect(nested.defaultPrevented).toBe(false);

    const outside = event({}, new TestElement(false));
    dialog.preventConnectionDialogOutsideClose(outside);
    expect(outside.defaultPrevented).toBe(true);

    const unknownTarget = event({});
    dialog.preventConnectionDialogOutsideClose(unknownTarget);
    expect(unknownTarget.defaultPrevented).toBe(true);

    profiles.connectionDialogOpen.value = true;
    dialog.syncConnectionFormBaseline();
    const escapeEvent = event(new TestElement(false));
    dialog.handleConnectionDialogEscape(escapeEvent);
    expect(escapeEvent.defaultPrevented).toBe(true);
    expect(profiles.connectionDialogOpen.value).toBe(false);
  });
});
