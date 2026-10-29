import { expect, test } from "vitest";
import type { ProfileSummary } from "@/lib/profile-storage";
import type { PublicSessionSnapshot } from "@/session/types";
import { createProfileVisuals } from "./useProfileVisuals";

function profile(overrides: Partial<ProfileSummary> = {}): ProfileSummary {
  return {
    id: "profile-1",
    keyEpoch: "visual-fixture",
    name: "Alpha",
    baseUrl: "https://headscale.example",
    credentialVersion: "credential-1",
    credentialKind: "password",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scope: "persistent",
    ...overrides,
  };
}

test("shows legacy migration and unreadable data before temporary-profile styling", () => {
  const visuals = createProfileVisuals(() => null);
  expect(
    visuals.profileVisualState(
      profile({ credentialKind: "unreadable", scope: "session" }),
    ),
  ).toBe("corrupted");
  for (const credentialKind of [
    "legacy-device",
    "legacy-password",
    "legacy-plaintext",
  ] as const) {
    expect(
      visuals.profileVisualState(profile({ credentialKind, scope: "session" })),
    ).toBe("migration");
  }
  expect(visuals.profileVisualState(profile({ scope: "session" }))).toBe(
    "session",
  );
  expect(visuals.profileVisualState(profile())).toBe("locked");
});

test("only the currently unlocked server is shown as unlocked and reads fresh snapshots", () => {
  let snapshot: PublicSessionSnapshot | null = null;
  const visuals = createProfileVisuals(() => snapshot);
  expect(visuals.profileVisualState(profile())).toBe("locked");
  snapshot = {
    status: "unlocked",
    identity: { workerId: "w", sessionId: "s" },
    profile: {
      id: "profile-1",
      name: "Alpha",
      baseUrl: "https://headscale.example",
    },
    expiresAt: 1800000,
    pendingProfileId: null,
    reason: null,
    revision: 1,
    apiKeyPrefix: null,
  };
  expect(visuals.profileVisualState(profile())).toBe("password");
  expect(visuals.profileVisualState(profile({ id: "another" }))).toBe("locked");
  snapshot = {
    ...snapshot,
    status: "locked",
    identity: null,
    profile: null,
    expiresAt: null,
    reason: "expired",
    revision: 2,
    apiKeyPrefix: null,
  };
  expect(visuals.profileVisualState(profile())).toBe("locked");
});

test("builds avatar initials from name, URL or fallback without reading credentials", () => {
  const visuals = createProfileVisuals(() => null);
  expect(visuals.profileAvatarLabel(profile({ name: " ab " }))).toBe("AB");
  expect(
    visuals.profileAvatarLabel(
      profile({ name: "", baseUrl: "https://example" }),
    ),
  ).toBe("HT");
  expect(visuals.profileAvatarLabel(profile({ name: "  ", baseUrl: "" }))).toBe(
    "HS",
  );
});

test("avatar initials keep whole characters, including emoji and supplementary ideographs", () => {
  const visuals = createProfileVisuals(() => null);
  expect(visuals.profileAvatarLabel(profile({ name: "A🚀 prod" }))).toBe("A🚀");
  expect(visuals.profileAvatarLabel(profile({ name: "𠮷野家" }))).toBe("𠮷野");
  expect(visuals.profileAvatarLabel(profile({ name: "👩‍💻ops" }))).toBe("👩‍💻O");
});
