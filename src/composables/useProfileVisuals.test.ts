import { beforeEach, describe, expect, test } from "bun:test";
import { createRenderer, defineComponent } from "vue";
import { i18n } from "@/i18n";
import type { ConnectionProfile } from "@/lib/profile-storage";
import { masterPasswordTestingHandle, useMasterPassword } from "./useMasterPassword";
import { useProfileVisuals } from "./useProfileVisuals";

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

function profile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: "profile-1",
    name: "Alpha",
    baseUrl: "https://headscale.example",
    apiKey: { v: 1, scheme: "device", iv: "iv", ct: "ct" },
    updatedAt: "2026-01-01T00:00:00.000Z",
    scope: "persistent",
    ...overrides,
  };
}

beforeEach(() => {
  masterPasswordTestingHandle.reset();
  (i18n.global.locale as unknown as { value: string }).value = "en-US";
});

describe("useProfileVisuals", () => {
  test("classifies profile encryption state in priority order", () => {
    const visuals = mountComposable(useProfileVisuals);
    const passwordProfile = profile({
      apiKey: { v: 1, scheme: "password", iv: "iv", ct: "ct" },
    });

    expect(visuals.profileVisualState(profile({ corrupted: true, scope: "session" }))).toBe(
      "corrupted",
    );
    expect(visuals.profileVisualState(profile({ scope: "session" }))).toBe("session");
    expect(visuals.profileVisualState(passwordProfile)).toBe("locked");
    useMasterPassword().isUnlocked.value = true;
    expect(visuals.profileVisualState(passwordProfile)).toBe("password");
    expect(visuals.profileVisualState(profile())).toBe("device");
  });

  test("builds avatar initials from the name or server URL", () => {
    const visuals = mountComposable(useProfileVisuals);

    expect(visuals.profileAvatarLabel(profile({ name: " ab " }))).toBe("AB");
    expect(visuals.profileAvatarLabel(profile({ name: "", baseUrl: "https://example" }))).toBe(
      "HT",
    );
    expect(visuals.profileAvatarLabel(profile({ name: "  ", baseUrl: "" }))).toBe("HS");
  });
});
