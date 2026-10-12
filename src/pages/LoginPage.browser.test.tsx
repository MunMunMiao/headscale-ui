import type { FetchHandle } from "@defjs/core";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { setLocale } from "@/i18n";
import * as localeRuntime from "@/i18n/runtime";
import { encryptProfileKey } from "@/lib/api-key-crypto";
import type { PasswordStoredProfile, ProfileSummary } from "@/lib/profile-storage";
import * as settings from "@/lib/settings-storage";
import { captureSettingsWriteEpoch, readSetting } from "@/lib/settings-storage";
import { notifyVaultChanged } from "@/lib/vault-state";
import { prepareTestSession, renderSessionPage } from "@/test/session";
import { snapshotFixture } from "@/test-utils/headscale.test";
import { idbGet, idbGetAll, idbPut } from "@/test-utils/storage";
import LoginPage from "./LoginPage";

vi.mock("@/i18n/runtime", { spy: true });
vi.mock("@/lib/settings-storage", { spy: true });

async function setup({ profiles = [] as ProfileSummary[], path = "/login" } = {}) {
  await page.viewport(1366, 768);
  let failure = "";
  const requests: string[] = [];
  const snapshot = snapshotFixture();
  const transport: FetchHandle = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    requests.push(url.pathname);
    if (failure) return Response.json({ message: failure }, { status: 500 });
    const responses: Record<string, unknown> = {
      "/api/v1/health": snapshot.health,
      "/version": snapshot.version,
      "/api/v1/user": { users: snapshot.users },
      "/api/v1/preauthkey": { preAuthKeys: snapshot.preAuthKeys },
      "/api/v1/node": { nodes: snapshot.nodes },
      "/api/v1/apikey": { apiKeys: snapshot.apiKeys },
      "/api/v1/policy": snapshot.policy,
    };
    return Response.json(responses[url.pathname]);
  };
  const session = await prepareTestSession(transport);
  await setLocale("en-US");
  const keyEpoch = session.profiles.getSnapshot().version?.keyEpoch;
  for (const profile of profiles) {
    const credentialVersion = profile.credentialVersion ?? "fixture-credential";
    const apiKey =
      profile.credentialKind === "unreadable"
        ? { v: 99 }
        : profile.credentialKind === "legacy-plaintext"
          ? "isolated-legacy-key"
          : await encryptProfileKey({
              profileId: profile.id,
              canonicalBaseUrl: profile.baseUrl,
              credentialVersion,
              apiKey: "isolated-key",
              password: "server password",
            });
    const { credentialKind: _kind, ...fields } = profile;
    await idbPut("profiles", { ...fields, keyEpoch, credentialVersion, apiKey });
  }
  await session.profiles.reloadProfiles();
  const rendered = await renderSessionPage(session, <LoginPage />, path);
  return {
    ...rendered,
    session,
    requests,
    fail: (value: string) => {
      failure = value;
    },
  };
}
async function fillConnection(name = "Alpha") {
  await page.getByTestId("connect-profile-name").fill(name);
  await page.getByTestId("connect-server-url").fill("https://fixture.invalid");
  await page.getByTestId("connect-api-key").fill("isolated-key");
  await page.getByTestId("connect-password").fill("server password");
  await page.getByTestId("connect-password-confirm").fill("server password");
}
function profile(overrides: Partial<ProfileSummary> = {}): ProfileSummary {
  return {
    id: "profile-1",
    name: "Alpha",
    baseUrl: "https://fixture.invalid",
    credentialKind: "password",
    credentialVersion: "fixture-credential",
    updatedAt: "2026-01-01T00:00:00Z",
    scope: "persistent",
    keyEpoch: "fixture-epoch",
    ...overrides,
  };
}
afterEach(() => vi.restoreAllMocks());
test("reports an activated language that was not saved and allows retry from the language menu", async () => {
  await setup();
  vi.mocked(settings.writeSetting).mockRejectedValueOnce(new Error("storage unavailable"));
  await page.getByTestId("locale-select").click();
  await page.getByTestId("locale-option-fr-FR").click();
  await expect.element(page.getByTestId("locale-error")).toMatchTextContent("La langue a changé");
  expect(document.documentElement.lang).toBe("fr-FR");
  await expect.poll(() => readSetting("locale")).toBe("en-US");
  await page.getByTestId("locale-select").click();
  await page.getByTestId("locale-option-fr-FR").click();
  await expect.poll(() => readSetting("locale")).toBe("fr-FR");
  await expect.element(page.getByTestId("locale-error")).not.toBeInTheDocument();
});

test("keeps a validated connection draft open when its local save fails", async () => {
  const ctx = await setup();
  await page.getByTestId("profile-option-new").click();
  await fillConnection("Unsaved server");
  const put = IDBObjectStore.prototype.put;
  const failure = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    if (this.name === "profiles") throw new DOMException("save quota", "QuotaExceededError");
    return put.apply(this, args);
  });
  await page.getByTestId("connect-submit").click();
  await expect.element(page.getByTestId("connect-error")).toMatchTextContent("could not save");
  await expect.element(page.getByTestId("connection-dialog")).toBeVisible();
  await expect.element(page.getByTestId("connect-profile-name")).toHaveValue("Unsaved server");
  await expect.element(page.getByTestId("connect-api-key")).toHaveValue("");
  await expect.element(page.getByTestId("profile-validation-dialog")).not.toBeInTheDocument();
  expect(ctx.session.profiles.getSnapshot().profiles).toEqual([]);
  failure.mockRestore();
  await fillConnection("Unsaved server");
  await page.getByTestId("connect-submit").click();
  await expect.element(page.getByTestId("profile-option-Unsaved server")).toBeVisible();
  expect(ctx.session.profiles.getSnapshot().profiles).toHaveLength(1);
});

test("keeps a failed profile deletion open and reports the storage error inside its dialog", async () => {
  const ctx = await setup({ profiles: [profile()] });
  await page.getByTestId("delete-profile-Alpha").click();
  const remove = IDBObjectStore.prototype.delete;
  const failure = vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    if (this.name === "profiles") throw new DOMException("delete quota", "QuotaExceededError");
    return remove.apply(this, args);
  });
  await page.getByTestId("confirm-delete-profile").click();
  await expect.element(page.getByTestId("delete-profile-dialog")).toBeVisible();
  await expect
    .element(page.getByTestId("delete-profile-error"))
    .toMatchTextContent("could not save");
  expect(ctx.session.profiles.getSnapshot().profiles).toHaveLength(1);
  failure.mockRestore();
  await page.getByTestId("confirm-delete-profile").click();
  await expect.element(page.getByTestId("delete-profile-dialog")).not.toBeInTheDocument();
  expect(ctx.session.profiles.getSnapshot().profiles).toHaveLength(0);
});
// Catches lost guide/links, clipboard feedback, and dirty-close/nested-cancel state.
test("guides API key setup and keeps a dirty connection editable through outside and nested closes", async () => {
  await setup();
  expect(document.querySelector('[data-testid="profile-picker"]')).not.toBeNull();
  await page.getByTestId("profile-option-new").click();
  await expect
    .element(page.getByTestId("api-key-guide"))
    .toMatchTextContent("headscale apikeys create --expiration 90d");
  expect(document.querySelector('a[data-testid="api-key-docs-link"]')?.getAttribute("href")).toBe(
    "https://docs.headscale.org/ref/remote-cli/",
  );
  const clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await page.getByTestId("api-key-command-copy").click();
  expect(clipboard).toHaveBeenCalledWith("headscale apikeys create --expiration 90d");
  await expect.element(page.getByTestId("api-key-command-copy")).toHaveTextContent("Copied");
  await page.getByTestId("connect-profile-name").fill("Draft");
  const overlay = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]');
  if (!overlay) throw new Error("Missing dialog overlay");
  await page.elementLocator(overlay).click({ position: { x: 1, y: 1 } });
  await expect.element(page.getByTestId("connection-dialog")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("discard-profile-changes-dialog")).toBeVisible();
  await page.getByTestId("keep-editing-profile").click();
  await expect.element(page.getByTestId("connection-dialog")).toBeVisible();
  await expect.element(page.getByTestId("connect-profile-name")).toHaveValue("Draft");
  await page.getByTestId("connect-close").click();
  await expect.element(page.getByTestId("discard-profile-changes-dialog")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("discard-profile-changes-dialog")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("connect-profile-name")).toHaveValue("Draft");
  await page.getByTestId("connect-close").click();
  await page.getByTestId("discard-profile-changes").click();
  await expect.element(page.getByTestId("connection-dialog")).not.toBeInTheDocument();
});
// Catches missing validated persistence, plaintext storage or manual-entry navigation.
test("creates an encrypted persistent profile, edits it and enters its dashboard", async () => {
  const ctx = await setup();
  expect(document.querySelector('[data-testid="profile-picker"]')).not.toBeNull();
  await page.getByTestId("profile-option-new").click();
  await fillConnection();
  await page.getByTestId("connect-submit").click();
  await expect.element(page.getByTestId("profile-option-Alpha")).toBeVisible();
  const saved = ctx.session.profiles.getSnapshot().profiles[0];
  if (!saved) throw new Error("Profile was not saved");
  const stored = await idbGet<PasswordStoredProfile>("profiles", saved.id);
  expect(stored?.apiKey.scheme).toBe("password");
  expect(stored?.apiKey.v).toBe(2);
  expect(stored?.apiKey.ct).not.toContain("isolated-key");
  expect(saved.scope).toBe("persistent");
  await page.getByTestId("edit-profile-Alpha").click();
  await expect.element(page.getByTestId("connect-api-key")).toHaveValue("");
  await page.getByTestId("connect-profile-name").fill("Renamed");
  await page.getByTestId("connect-submit").click();
  await expect.element(page.getByTestId("profile-option-Renamed")).toBeVisible();
  expect(ctx.session.profiles.getSnapshot().profiles).toHaveLength(1);
  expect((await idbGet<PasswordStoredProfile>("profiles", saved.id))?.apiKey).toEqual(
    stored?.apiKey,
  );
  await page.getByTestId("profile-option-Renamed").click();
  await page.getByTestId("unlock-passphrase").fill("server password");
  await page.getByTestId("unlock-submit").click();
  await expect.element(page.getByTestId("test-route")).toHaveTextContent("/");
  expect(ctx.session.snapshot.getSnapshot().isAuthorized).toBe(true);
});
test("reports a rejected clipboard write on the API key command copy button", async () => {
  await setup();
  await page.getByTestId("profile-option-new").click();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
  await page.getByTestId("api-key-command-copy").click();
  await expect.element(page.getByTestId("api-key-command-copy")).toMatchTextContent("Copy failed");
});
// Catches validation failure clearing a draft, broken save-anyway recovery or wrongly promoting session-only scope.
test("returns failed validation to editing and can save a session profile anyway", async () => {
  const ctx = await setup();
  expect(document.querySelector('[data-testid="profile-picker"]')).not.toBeNull();
  await page.getByTestId("profile-option-new").click();
  await fillConnection("Offline");
  await page.getByTestId("connect-remember").click();
  ctx.fail("Server unreachable");
  await page.getByTestId("connect-submit").click();
  await expect
    .element(page.getByTestId("profile-validation-error"))
    .toHaveTextContent("Server unreachable");
  expect(ctx.session.profiles.getSnapshot().profiles).toEqual([]);
  await page.getByTestId("review-profile-connection").click();
  await expect.element(page.getByTestId("connection-dialog")).toBeVisible();
  await expect.element(page.getByTestId("connect-api-key")).toHaveValue("");
  await expect.element(page.getByTestId("connect-error")).toHaveTextContent("Server unreachable");
  await fillConnection("Offline");
  await page.getByTestId("connect-submit").click();
  await expect.element(page.getByTestId("validation-password-confirm")).toBeVisible();
  await expect.element(page.getByTestId("continue-add-profile")).toBeDisabled();
  await page.getByTestId("validation-api-key").fill("isolated-key");
  await page.getByTestId("validation-password").fill("server password");
  await expect.element(page.getByTestId("continue-add-profile")).toBeDisabled();
  await page.getByTestId("validation-password-confirm").fill("different");
  await expect.element(page.getByTestId("continue-add-profile")).toBeDisabled();
  await expect
    .element(page.getByTestId("validation-password-confirm"))
    .toHaveAttribute("aria-invalid", "true");
  await expect.element(page.getByTestId("validation-password-mismatch")).toBeVisible();
  expect(ctx.session.profiles.getSnapshot().profiles).toEqual([]);
  expect(await idbGetAll("profiles")).toEqual([]);
  await page.getByTestId("validation-password-confirm").fill("server password");
  await expect.element(page.getByTestId("validation-password-mismatch")).not.toBeInTheDocument();
  await page.getByTestId("continue-add-profile").click();
  await expect.element(page.getByTestId("profile-badge-session-Offline")).toBeVisible();
  await expect.element(page.getByTestId("profile-validation-dialog")).not.toBeInTheDocument();
  expect(ctx.session.profiles.getSnapshot().profiles[0]?.scope).toBe("session");
  expect(ctx.session.profiles.getSnapshot().phase.kind).toBe("idle");
  expect(ctx.session.profiles.getSnapshot().profileValidationDialogOpen).toBe(false);
  expect(ctx.session.feedback.getSnapshot().lastError).toBe("");
  await page.getByTestId("profile-option-Offline").click();
  await page.getByTestId("unlock-passphrase").fill("server password");
  await page.getByTestId("unlock-submit").click();
  await expect.element(page.getByTestId("unlock-error")).toHaveTextContent("Server unreachable");
  expect(ctx.router.state.location.pathname).toBe("/login");
  expect(ctx.session.snapshot.getSnapshot().isAuthorized).toBe(false);
});
// Catches deleting without approval or a close/cancel failing to preserve the saved entry.
test("deletes profiles only after confirmation", async () => {
  const ctx = await setup();
  expect(document.querySelector('[data-testid="profile-picker"]')).not.toBeNull();
  await page.getByTestId("profile-option-new").click();
  await fillConnection();
  await page.getByTestId("connect-submit").click();
  await page.getByTestId("delete-profile-Alpha").click();
  await expect.element(page.getByTestId("delete-profile-dialog")).toMatchTextContent("Alpha");
  await page.getByTestId("cancel-delete-profile").click();
  await expect.element(page.getByTestId("profile-option-Alpha")).toBeVisible();
  await page.getByTestId("delete-profile-Alpha").click();
  await page.getByTestId("confirm-delete-profile").click();
  await expect.element(page.getByTestId("profile-option-Alpha")).not.toBeInTheDocument();
  expect(ctx.session.profiles.getSnapshot().profiles).toEqual([]);
  expect(ctx.session.profiles.getSnapshot().profiles).toEqual([]);
});
// Catches classification precedence, incorrect corrupted-profile entry or hidden recovery notice.
test("shows locked and corrupted profiles and opens corrupted credentials for repair", async () => {
  const ctx = await setup({
    profiles: [profile(), profile({ id: "bad", name: "Broken", credentialKind: "unreadable" })],
  });
  expect(document.querySelector('[data-testid="profile-picker"]')).not.toBeNull();
  await expect.element(page.getByTestId("profile-badge-locked-Alpha")).toBeVisible();
  await expect.element(page.getByTestId("profile-badge-corrupted-Broken")).toBeVisible();
  await page.getByTestId("profile-option-Broken").click();
  await expect.element(page.getByTestId("connection-dialog")).toBeVisible();
  await expect.element(page.getByTestId("connect-api-key")).toHaveValue("");
  expect(ctx.requests).toEqual([]);
  await page.getByTestId("connect-close").click();
});
// Catches dead menus, locale/theme choices not persisting or menu labels rendered outside an official group.
test("switches locale and theme before login and restores system choice", async () => {
  await setup();
  expect(document.querySelector('[data-testid="profile-picker"]')).not.toBeNull();
  expect(
    document.querySelector('a[data-testid="github-repository-link"]')?.getAttribute("href"),
  ).toBe("https://github.com/MunMunMiao/headscale-ui");
  await page.getByTestId("locale-select").click();
  await page.getByTestId("locale-option-zh-Hans").click();
  await expect.poll(() => readSetting("locale")).toBe("zh-Hans");
  await expect.element(page.getByTestId("profile-option-new")).toMatchTextContent("添加服务器");
  await page.getByTestId("theme-select").click();
  await page.getByTestId("theme-option-dark").click();
  await expect.poll(() => readSetting("theme")).toBe("dark");
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  await page.getByTestId("theme-select").click();
  await page.getByTestId("theme-option-light").click();
  expect(document.documentElement.classList.contains("dark")).toBe(false);
  await page.getByTestId("theme-select").click();
  await page.getByTestId("theme-option-auto").click();
  await expect.poll(() => readSetting("theme")).toBe("auto");
  await page.getByTestId("locale-select").click();
  await page.getByTestId("locale-option-en-US").click();
  await expect.poll(() => readSetting("locale")).toBe("en-US");
});
// Catches lost cleared-query notices.
test("shows the clearing notice without automatic login", async () => {
  await setup({ path: "/login?cleared=1" });
  expect(document.querySelector('[data-testid="profile-picker"]')).not.toBeNull();
  await expect.element(page.getByTestId("profiles-cleared-notice")).toBeVisible();
});
test("while a profile authenticates the picker stays and only that row is aria-busy", async () => {
  const ctx = await setup({ profiles: [profile(), profile({ id: "profile-2", name: "Beta" })] });
  ctx.session.profiles.setState({ phase: { kind: "authenticating", profileId: "profile-1" } });
  await expect
    .element(page.getByTestId("profile-option-Alpha"))
    .toHaveAttribute("aria-busy", "true");
  await expect
    .element(page.getByTestId("profile-option-Beta"))
    .toHaveAttribute("aria-busy", "false");
  expect(document.querySelector('[data-testid="session-restore"]')).toBeNull();
});

// Catches overflow or a hidden submit footer when the original two-column form stacks on mobile.
test("keeps connection inputs and footer usable on a short mobile viewport", async () => {
  await setup();
  await page.viewport(360, 568);
  await page.getByTestId("profile-option-new").click();
  await expect.element(page.getByTestId("connect-api-key")).toBeVisible();
  await expect.element(page.getByTestId("connect-submit")).toBeVisible();
  const box = (id: string) => {
    const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    if (!element) throw new Error(`Missing ${id}`);
    return element.getBoundingClientRect();
  };
  const dialog = box("connection-dialog"),
    key = box("connect-api-key"),
    footer = box("connect-footer"),
    submit = box("connect-submit");
  expect(dialog.top).toBeGreaterThanOrEqual(0);
  expect(dialog.bottom).toBeLessThanOrEqual(568);
  expect(key.bottom).toBeLessThanOrEqual(footer.top);
  expect(submit.bottom).toBeLessThanOrEqual(568);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(360);
});

test("new profiles require independent matching passwords and support save-and-unlock", async () => {
  const ctx = await setup();
  await page.getByTestId("profile-option-new").click();
  expect(document.querySelector('[data-testid="connect-password"]')).not.toBeNull();
  await fillConnection();
  await page.getByTestId("connect-password-confirm").fill("different password");
  await page.getByTestId("connect-submit").click();
  await expect.element(page.getByTestId("connect-error")).toMatchTextContent("do not match");
  expect(await idbGetAll("profiles")).toEqual([]);
  await page.getByTestId("connect-password-confirm").fill("server password");
  await page.getByTestId("connect-save-unlock").click();
  await expect.poll(() => ctx.router.state.location.pathname).toBe("/");
  expect(ctx.session.auth.getSessionSnapshot()?.status).toBe("unlocked");
  expect(ctx.session.profiles.getSnapshot().connectionForm).toMatchObject({
    apiKey: "",
    password: "",
  });
});

test("a rejected local save keeps every typed field and sends nothing", async () => {
  const ctx = await setup();
  await page.getByTestId("profile-option-new").click();
  await fillConnection("Typo");
  await page.getByTestId("connect-server-url").fill("not a url");
  await page.getByTestId("connect-submit").click();
  await expect.element(page.getByTestId("connect-error")).toBeVisible();
  await expect.element(page.getByTestId("connect-api-key")).toHaveValue("isolated-key");
  await expect.element(page.getByTestId("connect-password")).toHaveValue("server password");
  await expect.element(page.getByTestId("connect-password-confirm")).toHaveValue("server password");
  expect(ctx.requests).toEqual([]);
  expect(await idbGetAll("profiles")).toEqual([]);
  await page.getByTestId("connect-server-url").fill("https://fixture.invalid");
  await page.getByTestId("connect-submit").click();
  await expect.element(page.getByTestId("profile-option-Typo")).toBeVisible();
});

test("an empty new password asks for the server password", async () => {
  const ctx = await setup();
  await page.getByTestId("profile-option-new").click();
  await page.getByTestId("connect-server-url").fill("https://fixture.invalid");
  await page.getByTestId("connect-api-key").fill("isolated-key");
  await page.getByTestId("connect-submit").click();
  await expect
    .element(page.getByTestId("connect-error"))
    .toHaveTextContent("Enter the server password.");
  await expect.element(page.getByTestId("connect-api-key")).toHaveValue("isolated-key");
  expect(ctx.requests).toEqual([]);
  expect(await idbGetAll("profiles")).toEqual([]);
});

test("saving an already stored profile anyway needs only the key and its current password", async () => {
  const ctx = await setup({ profiles: [profile()] });
  await page.getByTestId("edit-profile-Alpha").click();
  await page.getByTestId("connect-api-key").fill("new-key");
  await page.getByTestId("connect-password").fill("server password");
  ctx.fail("Server unreachable");
  await page.getByTestId("connect-submit").click();
  await expect.element(page.getByTestId("profile-validation-dialog")).toBeVisible();
  expect(document.querySelector('[data-testid="validation-password-confirm"]')).toBeNull();
  await expect.element(page.getByTestId("continue-add-profile")).toBeDisabled();
  await page.getByTestId("validation-api-key").fill("new-key");
  await page.getByTestId("validation-password").fill("server password");
  await expect.element(page.getByTestId("continue-add-profile")).toBeEnabled();
  await page.getByTestId("continue-add-profile").click();
  await expect.element(page.getByTestId("profile-validation-dialog")).not.toBeInTheDocument();
});

test("exposes one banner and one main landmark outside the dialogs", async () => {
  await setup();
  expect(page.getByRole("banner").elements()).toHaveLength(1);
  expect(page.getByRole("main").elements()).toHaveLength(1);
  const main = page.getByRole("main").element();
  expect(main.contains(page.getByRole("banner").element())).toBe(false);
  expect(main.contains(document.querySelector('[data-testid="profile-picker"]'))).toBe(true);
});

test("names edit and delete buttons per profile and keeps server URL entry hints", async () => {
  await setup({ profiles: [profile(), profile({ id: "profile-2", name: "Beta" })] });
  const label = (id: string) =>
    document.querySelector(`[data-testid="${id}"]`)?.getAttribute("aria-label");
  expect([
    label("edit-profile-Alpha"),
    label("edit-profile-Beta"),
    label("delete-profile-Alpha"),
    label("delete-profile-Beta"),
  ]).toEqual([
    "Edit profile: Alpha",
    "Edit profile: Beta",
    "Delete profile: Alpha",
    "Delete profile: Beta",
  ]);
  await page.getByTestId("profile-option-new").click();
  const input = page.getByTestId("connect-server-url");
  await expect.element(input).toHaveAttribute("inputmode", "url");
  await expect.element(input).toHaveAttribute("autocapitalize", "none");
  await expect.element(input).toHaveAttribute("autocorrect", "off");
  await expect.element(input).toHaveAttribute("spellcheck", "false");
  await expect.element(input).not.toHaveAttribute("type", "url");
});

test("the validation dialog description includes the failure reason", async () => {
  const ctx = await setup();
  await page.getByTestId("profile-option-new").click();
  await fillConnection("Offline");
  ctx.fail("Server unreachable");
  await page.getByTestId("connect-submit").click();
  await expect
    .element(page.getByRole("alertdialog"))
    .toHaveAccessibleDescription(expect.stringContaining("Server unreachable"));
});

test("language and theme menus are radio groups with the current choice checked", async () => {
  await setup();
  await page.getByTestId("locale-select").click();
  await expect
    .element(page.getByTestId("locale-option-en-US"))
    .toHaveAttribute("role", "menuitemradio");
  await expect
    .element(page.getByTestId("locale-option-en-US"))
    .toHaveAttribute("aria-checked", "true");
  await expect
    .element(page.getByTestId("locale-option-fr-FR"))
    .toHaveAttribute("aria-checked", "false");
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("theme-select").click();
  await expect
    .element(page.getByTestId("theme-option-dark"))
    .toHaveAttribute("role", "menuitemradio");
  await page.getByTestId("theme-option-dark").click();
  await expect.element(page.getByTestId("theme-select")).toHaveAccessibleName("Theme: Dark");
});

test("reports a language catalog that failed to load and keeps the picker usable", async () => {
  await setup();
  vi.mocked(localeRuntime.loadLocale).mockRejectedValueOnce(new Error("catalog unavailable"));
  await page.getByTestId("locale-select").click();
  await page.getByTestId("locale-option-fr-FR").click();
  await expect.element(page.getByTestId("locale-error")).toMatchTextContent("could not be loaded");
  expect(document.documentElement.lang).toBe("en-US");
  await expect.element(page.getByTestId("profile-picker")).toBeVisible();
});

test("reports a theme that was applied but not saved until a later save succeeds", async () => {
  await setup();
  vi.mocked(settings.writeSetting).mockRejectedValueOnce(new Error("storage unavailable"));
  await page.getByTestId("theme-select").click();
  await page.getByTestId("theme-option-dark").click();
  await expect
    .element(page.getByTestId("theme-error"))
    .toMatchTextContent("The theme changed, but the preference could not be saved");
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  await page.getByTestId("theme-select").click();
  await page.getByTestId("theme-option-dark").click();
  await expect.element(page.getByTestId("theme-error")).not.toBeInTheDocument();
});

test("warns when preferences cannot be reloaded and clears it on the next successful read", async () => {
  await setup();
  const version = { keyEpoch: captureSettingsWriteEpoch(), profilesRevision: 0 };
  vi.mocked(settings.hydrateSettings).mockRejectedValueOnce(new Error("read unavailable"));
  notifyVaultChanged(version);
  await expect
    .element(page.getByTestId("settings-error"))
    .toMatchTextContent("could not reload your preferences");
  notifyVaultChanged(version);
  await expect.element(page.getByTestId("settings-error")).not.toBeInTheDocument();
});

test("a legacy credential is badged as needing migration and opens migration without a request", async () => {
  const ctx = await setup({ profiles: [profile({ credentialKind: "legacy-plaintext" })] });
  await expect
    .element(page.getByTestId("profile-badge-migration-Alpha"))
    .toMatchTextContent("Migration required");
  await page.getByTestId("profile-option-Alpha").click();
  await expect.element(page.getByTestId("unlock-dialog")).toBeVisible();
  expect(ctx.requests).toEqual([]);
});
