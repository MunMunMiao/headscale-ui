import type { FetchHandle } from "@defjs/core";
import { act } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { applyStoredLocale, setLocale, t } from "@/i18n";
import { createSession } from "@/composables/session-context";
import { clearAllSecureData } from "@/lib/secure-storage";
import { createSessionHarness } from "@/test/session-host";
import * as localeRuntime from "@/i18n/runtime";
import { encryptProfileKey } from "@/lib/api-key-crypto";
import type {
  PasswordStoredProfile,
  ProfileSummary,
} from "@/lib/profile-storage";
import * as settings from "@/lib/settings-storage";
import { captureSettingsWriteEpoch, readSetting } from "@/lib/settings-storage";
import { notifyVaultChanged } from "@/lib/vault-state";
import {
  authenticateTestSession,
  prepareTestSession,
  renderSessionPage,
} from "@/test/session";
import { snapshotFixture } from "@/test-utils/headscale.test";
import { idbGet, idbGetAll, idbPut } from "@/test-utils/storage";
import LoginPage from "./LoginPage";

vi.mock("@/i18n/runtime", { spy: true });
vi.mock("@/lib/settings-storage", { spy: true });

async function setup({
  profiles = [],
  path = "/login",
  reloadPage,
  waitForRequest,
}: {
  profiles?: ProfileSummary[];
  path?: string;
  reloadPage?: (href: string) => void;
  waitForRequest?: () => Promise<void>;
} = {}) {
  await page.viewport(1366, 768);
  let failure = "";
  const requests: string[] = [];
  const snapshot = snapshotFixture();
  const transport: FetchHandle = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    requests.push(url.pathname);
    await waitForRequest?.();
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
    await idbPut("profiles", {
      ...fields,
      keyEpoch,
      credentialVersion,
      apiKey,
    });
  }
  await session.profiles.reloadProfiles();
  const rendered = await renderSessionPage(
    session,
    <LoginPage reloadPage={reloadPage} />,
    path,
  );
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
test.each([false, true])(
  "G08: a verified empty picker ignores obsolete password notices (passwordChanged=%s)",
  async (passwordChanged) => {
    const ctx = await setup({ path: "/login?redirect=%2Fdevices" });
    await ctx.session.profiles.logout();
    expect(ctx.session.auth.getSessionSnapshot()?.reason).toBe("user");
    ctx.session.profiles.setState({ passwordChanged });
    await expect
      .element(page.getByTestId("login-notice"))
      .toHaveTextContent(t("loginNoticeFirstConnection"));
    await expect
      .element(page.getByTestId("login-notice"))
      .not.toMatchTextContent(/password/i);
    await expect.element(page.getByTestId("profile-option-new")).toBeVisible();
  },
);

test("G08: clearing all profiles in one page guides the other locked page to add a server", async () => {
  await clearAllSecureData();
  await settings.hydrateSettings();
  await applyStoredLocale();
  await setLocale("en-US");
  const fixture = snapshotFixture();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const values: Record<string, unknown> = {
      "/api/v1/health": fixture.health,
      "/version": fixture.version,
      "/api/v1/user": { users: fixture.users },
      "/api/v1/node": { nodes: fixture.nodes },
      "/api/v1/preauthkey": { preAuthKeys: fixture.preAuthKeys },
      "/api/v1/apikey": { apiKeys: fixture.apiKeys },
      "/api/v1/policy": fixture.policy,
    };
    return Response.json(values[new URL(request.url).pathname]);
  });
  const harness = await createSessionHarness();
  let firstView: Awaited<ReturnType<typeof renderSessionPage>> | undefined;
  let otherView: Awaited<ReturnType<typeof renderSessionPage>> | undefined;
  try {
    const first = createSession(await harness.openPage("clear-owner"));
    await authenticateTestSession(first);
    const other = createSession(await harness.openPage("other-page"));
    const reload = vi.fn();
    firstView = await renderSessionPage(
      first,
      <section aria-label="Clearing profile page">
        <LoginPage reloadPage={reload} />
      </section>,
      "/login",
    );
    otherView = await renderSessionPage(
      other,
      <section aria-label="Other profile page">
        <LoginPage reloadPage={() => {}} />
      </section>,
      "/login?redirect=%2Fdevices",
    );
    const firstPage = page.getByRole("region", {
      name: "Clearing profile page",
      exact: true,
    });
    const otherPage = page.getByRole("region", {
      name: "Other profile page",
      exact: true,
    });
    await first.profiles.logout();
    await expect
      .element(otherPage.getByTestId("login-notice"))
      .toHaveTextContent(t("loginNoticeLoggedOut"));
    await expect
      .element(otherPage.getByTestId("profile-option-Test server"))
      .toBeVisible();
    await firstPage.getByTestId("login-clear-all").click();
    await page.getByTestId("login-clear-all-confirm").click();
    await expect.poll(() => reload.mock.calls.length).toBe(1);
    await expect
      .poll(() => other.profiles.getSnapshot().profiles.length)
      .toBe(0);
    await expect
      .poll(() => other.auth.getSessionSnapshot()?.status)
      .toBe("locked");
    await expect
      .element(otherPage.getByTestId("login-notice"))
      .toHaveTextContent(t("loginNoticeFirstConnection"));
    await expect
      .element(otherPage.getByTestId("profile-option-new"))
      .toBeVisible();
    expect(await idbGetAll("profiles")).toEqual([]);
  } finally {
    await otherView?.unmount();
    await firstView?.unmount();
    await harness.dispose();
  }
});

test.each([
  "not-loaded",
  "busy",
  "read-failed",
  "hidden-unreadable",
  "unreadable-profile",
  "saved-profile",
] as const)("G08: %s is not a verified empty profile library", async (kind) => {
  const ctx = await setup({
    path: "/login?redirect=%2Fdevices",
    profiles:
      kind === "unreadable-profile"
        ? [profile({ credentialKind: "unreadable" })]
        : kind === "saved-profile"
          ? [profile()]
          : [],
  });
  if (kind === "not-loaded") ctx.session.profiles.setState({ version: null });
  else if (kind === "busy")
    ctx.session.profiles.setState({ phase: { kind: "adding" } });
  else if (kind === "read-failed")
    ctx.session.feedback.setState({
      lastError: "Saved profiles could not be read.",
    });
  else if (kind === "hidden-unreadable")
    ctx.session.profiles.setState({ unreadableRecords: 1 });
  await expect
    .element(page.getByTestId("login-notice"))
    .not.toHaveTextContent(t("loginNoticeFirstConnection"));
  if (kind === "read-failed")
    await expect
      .element(page.getByTestId("login-error"))
      .toHaveTextContent("Saved profiles could not be read.");
  if (kind === "hidden-unreadable")
    await expect
      .element(page.getByTestId("unreadable-records-notice"))
      .toBeVisible();
  if (kind === "saved-profile") {
    await page.getByTestId("profile-option-Alpha").click();
    await expect.element(page.getByTestId("unlock-passphrase")).toBeVisible();
    expect(ctx.session.auth.getSessionSnapshot()?.status).toBe("locked");
  }
});

test("reports an activated language that was not saved and allows retry from the language menu", async () => {
  await setup();
  vi.mocked(settings.writeSetting).mockRejectedValueOnce(
    new Error("storage unavailable"),
  );
  await page.getByTestId("locale-select").click();
  await page.getByTestId("locale-option-fr-FR").click();
  await expect.poll(() => document.documentElement.lang).toBe("fr-FR");
  await expect
    .element(
      page.getByRole("dialog", { name: t("languageNotSaved"), exact: true }),
    )
    .toBeVisible();
  await expect
    .element(page.getByTestId("locale-error"))
    .not.toBeInTheDocument();
  await expect.poll(() => readSetting("locale")).toBe("en-US");
  await page.getByTestId("locale-select").click();
  await page.getByTestId("locale-option-fr-FR").click();
  await expect.poll(() => readSetting("locale")).toBe("fr-FR");
  await expect
    .element(page.getByTestId("locale-error"))
    .not.toBeInTheDocument();
});

test("keeps a validated connection draft open when its local save fails", async () => {
  const ctx = await setup();
  await page.getByTestId("profile-option-new").click();
  await fillConnection("Unsaved server");
  const put = IDBObjectStore.prototype.put;
  const failure = vi
    .spyOn(IDBObjectStore.prototype, "put")
    .mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === "profiles")
        throw new DOMException("save quota", "QuotaExceededError");
      return put.apply(this, args);
    });
  await page.getByTestId("connect-submit").click();
  await expect
    .element(page.getByTestId("connect-error"))
    .toMatchTextContent("could not save");
  await expect.element(page.getByTestId("connection-dialog")).toBeVisible();
  await expect
    .element(page.getByTestId("connect-profile-name"))
    .toHaveValue("Unsaved server");
  await expect.element(page.getByTestId("connect-api-key")).toHaveValue("");
  await expect
    .element(page.getByTestId("profile-validation-dialog"))
    .not.toBeInTheDocument();
  expect(ctx.session.profiles.getSnapshot().profiles).toEqual([]);
  failure.mockRestore();
  await fillConnection("Unsaved server");
  await page.getByTestId("connect-submit").click();
  await expect
    .element(page.getByTestId("profile-option-Unsaved server"))
    .toBeVisible();
  expect(ctx.session.profiles.getSnapshot().profiles).toHaveLength(1);
});

test("keeps a failed profile deletion open and reports the storage error inside its dialog", async () => {
  const ctx = await setup({ profiles: [profile()] });
  await page.getByTestId("delete-profile-Alpha").click();
  const remove = IDBObjectStore.prototype.delete;
  const failure = vi
    .spyOn(IDBObjectStore.prototype, "delete")
    .mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === "profiles")
        throw new DOMException("delete quota", "QuotaExceededError");
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
  await expect
    .element(page.getByTestId("delete-profile-dialog"))
    .not.toBeInTheDocument();
  expect(ctx.session.profiles.getSnapshot().profiles).toHaveLength(0);
});
// Catches lost guide/links, clipboard feedback, and dirty-close/nested-cancel state.
test("guides API key setup and keeps a dirty connection editable through outside and nested closes", async () => {
  await setup();
  expect(
    document.querySelector('[data-testid="profile-picker"]'),
  ).not.toBeNull();
  await page.getByTestId("profile-option-new").click();
  await page
    .getByRole("button", { name: "How to get an API key", exact: true })
    .click();
  await expect
    .element(page.getByTestId("api-key-guide"))
    .toMatchTextContent("headscale apikeys create --expiration 90d");
  expect(
    document
      .querySelector('a[data-testid="api-key-docs-link"]')
      ?.getAttribute("href"),
  ).toBe("https://docs.headscale.org/ref/remote-cli/");
  const clipboard = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockResolvedValue();
  await page.getByTestId("api-key-command-copy").click();
  expect(clipboard).toHaveBeenCalledWith(
    "headscale apikeys create --expiration 90d",
  );
  await expect
    .element(page.getByTestId("api-key-command-copy"))
    .toHaveTextContent("Copied");
  await expect
    .element(page.getByTestId("api-key-command-copy"))
    .toHaveAccessibleName("Copied");
  await userEvent.keyboard("{Escape}");
  await expect
    .element(
      page.getByRole("button", { name: "How to get an API key", exact: true }),
    )
    .toHaveFocus();
  await page.getByTestId("connect-profile-name").fill("Draft");
  const overlay = document.querySelector<HTMLElement>(
    '[data-slot="dialog-overlay"]',
  );
  if (!overlay) throw new Error("Missing dialog overlay");
  await page.elementLocator(overlay).click({ position: { x: 1, y: 1 } });
  await expect.element(page.getByTestId("connection-dialog")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByTestId("discard-profile-changes-dialog"))
    .toBeVisible();
  await page.getByTestId("keep-editing-profile").click();
  await expect.element(page.getByTestId("connection-dialog")).toBeVisible();
  await expect
    .element(page.getByTestId("connect-profile-name"))
    .toHaveValue("Draft");
  await page.getByTestId("connect-close").click();
  // Escape goes to the dialog holding focus, and the discard dialog takes it a frame after it appears.
  await expect.element(page.getByTestId("keep-editing-profile")).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByTestId("discard-profile-changes-dialog"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("connect-profile-name"))
    .toHaveValue("Draft");
  await page.getByTestId("connect-close").click();
  await page.getByTestId("discard-profile-changes").click();
  await expect
    .element(page.getByTestId("connection-dialog"))
    .not.toBeInTheDocument();
});
// Catches missing validated persistence, plaintext storage or manual-entry navigation.
test("creates an encrypted persistent profile, edits it and enters its dashboard", async () => {
  const ctx = await setup();
  expect(
    document.querySelector('[data-testid="profile-picker"]'),
  ).not.toBeNull();
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
  await expect
    .element(page.getByTestId("profile-option-Renamed"))
    .toBeVisible();
  expect(ctx.session.profiles.getSnapshot().profiles).toHaveLength(1);
  expect(
    (await idbGet<PasswordStoredProfile>("profiles", saved.id))?.apiKey,
  ).toEqual(stored?.apiKey);
  await page.getByTestId("profile-option-Renamed").click();
  await page.getByTestId("unlock-passphrase").fill("server password");
  await page.getByTestId("unlock-submit").click();
  await expect.element(page.getByTestId("test-route")).toHaveTextContent("/");
  expect(ctx.session.snapshot.getSnapshot().isAuthorized).toBe(true);
});
test("reports a rejected clipboard write on the API key command copy button", async () => {
  await setup();
  await page.getByTestId("profile-option-new").click();
  await page
    .getByRole("button", { name: "How to get an API key", exact: true })
    .click();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
    new Error("denied"),
  );
  await page.getByTestId("api-key-command-copy").click();
  await expect
    .element(page.getByTestId("api-key-command-copy"))
    .toMatchTextContent("Copy failed");
  await expect
    .element(page.getByTestId("api-key-command-copy"))
    .toHaveAccessibleName("Copy failed. Select the text and copy it manually.");
});
test("a validation retry retains session-only scope and requires matching password confirmation", async () => {
  const ctx = await setup();
  await page.getByTestId("profile-option-new").click();
  await fillConnection("Retry server");
  await page.getByTestId("connect-remember").click();
  ctx.fail("Server unreachable");
  await page.getByTestId("connect-submit").click();
  await expect
    .element(page.getByTestId("connect-error"))
    .toHaveTextContent("Server unreachable");
  await expect.element(page.getByTestId("connect-remember")).not.toBeChecked();
  expect(ctx.session.profiles.getSnapshot().profiles).toEqual([]);
  const requests = ctx.requests.length;
  ctx.fail("");
  await page.getByTestId("connect-api-key").fill("isolated-key");
  await page.getByTestId("connect-password").fill("server password");
  await page.getByTestId("connect-password-confirm").fill("different");
  await expect.element(page.getByTestId("connect-submit")).toBeDisabled();
  const form = page.getByTestId("connect-form").element();
  expect.assert(form instanceof HTMLFormElement);
  form.requestSubmit();
  await expect
    .element(page.getByTestId("connect-password-mismatch"))
    .toBeVisible();
  expect(await idbGetAll("profiles")).toEqual([]);
  expect(ctx.requests).toHaveLength(requests);
  await page.getByTestId("connect-password-confirm").fill("server password");
  await page.getByTestId("connect-submit").click();
  await expect
    .element(page.getByTestId("profile-badge-session-Retry server"))
    .toBeVisible();
  expect(ctx.session.profiles.getSnapshot().profiles[0]?.scope).toBe("session");
  await expect
    .poll(() => ctx.session.profiles.getSnapshot().phase.kind)
    .toBe("idle");
  expect(ctx.session.feedback.getSnapshot().lastError).toBe("");
  expect(ctx.router.state.location.pathname).toBe("/login");
  expect(ctx.session.snapshot.getSnapshot().isAuthorized).toBe(false);
});
// Catches deleting without approval or a close/cancel failing to preserve the saved entry.
test("deletes profiles only after confirmation", async () => {
  const ctx = await setup();
  expect(
    document.querySelector('[data-testid="profile-picker"]'),
  ).not.toBeNull();
  await page.getByTestId("profile-option-new").click();
  await fillConnection();
  await page.getByTestId("connect-submit").click();
  await page.getByTestId("delete-profile-Alpha").click();
  await expect
    .element(page.getByTestId("delete-profile-dialog"))
    .toMatchTextContent("Alpha");
  await page.getByTestId("cancel-delete-profile").click();
  await expect.element(page.getByTestId("profile-option-Alpha")).toBeVisible();
  await page.getByTestId("delete-profile-Alpha").click();
  await page.getByTestId("confirm-delete-profile").click();
  await expect
    .element(page.getByTestId("profile-option-Alpha"))
    .not.toBeInTheDocument();
  expect(ctx.session.profiles.getSnapshot().profiles).toEqual([]);
  expect(ctx.session.profiles.getSnapshot().profiles).toEqual([]);
});
// Catches classification precedence, incorrect corrupted-profile entry or hidden recovery notice.
test("shows locked and corrupted profiles and opens corrupted credentials for repair", async () => {
  const ctx = await setup({
    profiles: [
      profile(),
      profile({ id: "bad", name: "Broken", credentialKind: "unreadable" }),
    ],
  });
  expect(
    document.querySelector('[data-testid="profile-picker"]'),
  ).not.toBeNull();
  await expect
    .element(page.getByTestId("profile-badge-locked-Alpha"))
    .toBeVisible();
  await expect
    .element(page.getByTestId("profile-badge-corrupted-Broken"))
    .toBeVisible();
  await page.getByTestId("profile-option-Broken").click();
  await expect.element(page.getByTestId("connection-dialog")).toBeVisible();
  await expect.element(page.getByTestId("connect-api-key")).toHaveValue("");
  expect(ctx.requests).toEqual([]);
  await page.getByTestId("connect-close").click();
});
// Catches dead menus, locale/theme choices not persisting or menu labels rendered outside an official group.
test("switches locale and theme before login and restores system choice", async () => {
  await setup();
  expect(
    document.querySelector('[data-testid="profile-picker"]'),
  ).not.toBeNull();
  expect(
    document
      .querySelector('a[data-testid="github-repository-link"]')
      ?.getAttribute("href"),
  ).toBe("https://github.com/MunMunMiao/headscale-ui");
  // The external repository is a link, not a button, for assistive technology.
  await expect
    .element(page.getByRole("link", { name: "GitHub" }))
    .toHaveAttribute("target", "_blank");
  await page.getByTestId("locale-select").click();
  await page.getByTestId("locale-option-zh-Hans").click();
  await expect.poll(() => readSetting("locale")).toBe("zh-Hans");
  await expect
    .element(page.getByTestId("profile-option-new"))
    .toMatchTextContent("添加服务器");
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
  expect(
    document.querySelector('[data-testid="profile-picker"]'),
  ).not.toBeNull();
  await expect
    .element(page.getByTestId("profiles-cleared-notice"))
    .toBeVisible();
});
test("clear-all from the profile picker requires confirmation and clears through the shared session", async () => {
  const reloadPage = vi.fn();
  const ctx = await setup({
    profiles: [profile(), profile({ id: "profile-2", name: "Beta" })],
    reloadPage,
  });
  const saved = ctx.session.profiles.getSnapshot().profiles[0];
  expect.assert(saved);
  await ctx.session.profiles.enterProfile(saved, "server password");
  expect(ctx.session.auth.getSessionSnapshot()?.status).toBe("unlocked");
  const before = await idbGetAll("profiles");
  ctx.router.update({ basepath: "/console" });
  await expect.element(page.getByTestId("login-clear-all")).toBeVisible();
  await page.getByTestId("login-clear-all").click();
  await expect
    .element(page.getByRole("alertdialog"))
    .toMatchTextContent("every saved server profile from this browser");
  await expect
    .element(page.getByRole("alertdialog"))
    .toMatchTextContent("locks the shared session");
  expect(await idbGetAll("profiles")).toEqual(before);
  await page.getByTestId("login-clear-all-cancel").click();
  await expect.element(page.getByTestId("login-clear-all")).toHaveFocus();
  expect(await idbGetAll("profiles")).toEqual(before);
  expect(ctx.session.auth.getSessionSnapshot()?.status).toBe("unlocked");
  expect(reloadPage).not.toHaveBeenCalled();
  await page.getByTestId("login-clear-all").click();
  await page.getByTestId("login-clear-all-confirm").click();
  await expect.poll(() => reloadPage.mock.calls.length).toBe(1);
  expect(reloadPage).toHaveBeenCalledWith("/console/login?cleared=1");
  expect(await idbGetAll("profiles")).toEqual([]);
  expect(ctx.session.auth.getSessionSnapshot()?.status).toBe("locked");
});

test("repeated clear-all confirmation starts one reset and disables the picker while pending", async () => {
  const reloadPage = vi.fn();
  const ctx = await setup({ profiles: [profile()], reloadPage });
  const before = await idbGetAll("profiles");
  const gate = Promise.withResolvers<void>();
  const reset = ctx.session.profiles.resetLocalData.bind(ctx.session.profiles);
  const resetting = vi
    .spyOn(ctx.session.profiles, "resetLocalData")
    .mockImplementation(async () => {
      await gate.promise;
      return reset();
    });
  await page.getByTestId("login-clear-all").click();
  await expect
    .element(page.getByTestId("login-clear-all-confirm"))
    .toBeVisible();
  const confirm = page.getByTestId("login-clear-all-confirm").element();
  expect.assert(confirm instanceof HTMLButtonElement);
  try {
    // 在 React 提交禁用状态前收到两次确认，仍只能重置一次。
    await act(async () => {
      confirm.click();
      confirm.click();
    });
    expect(resetting).toHaveBeenCalledTimes(1);
    for (const id of [
      "login-clear-all",
      "profile-option-Alpha",
      "edit-profile-Alpha",
      "delete-profile-Alpha",
      "profile-option-new",
    ]) {
      await expect.element(page.getByTestId(id)).toBeDisabled();
    }
    expect(await idbGetAll("profiles")).toEqual(before);
    expect(reloadPage).not.toHaveBeenCalled();
  } finally {
    gate.resolve();
  }
  await expect.poll(() => reloadPage.mock.calls.length).toBe(1);
  expect(await idbGetAll("profiles")).toEqual([]);
});

test("a native clear-all failure preserves every profile and allows another explicit confirmation", async () => {
  const reloadPage = vi.fn();
  const ctx = await setup({
    profiles: [profile(), profile({ id: "profile-2", name: "Beta" })],
    reloadPage,
  });
  const before = await idbGetAll("profiles");
  const clear = vi
    .spyOn(IDBObjectStore.prototype, "clear")
    .mockImplementationOnce(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
  await page.getByTestId("login-clear-all").click();
  await page.getByTestId("login-clear-all-confirm").click();
  await expect
    .element(page.getByTestId("login-error"))
    .toMatchTextContent("could not save");
  expect(await idbGetAll("profiles")).toEqual(before);
  expect(ctx.session.auth.getSessionSnapshot()?.status).toBe("locked");
  expect(reloadPage).not.toHaveBeenCalled();
  clear.mockRestore();
  await page.getByTestId("login-clear-all").click();
  await page.getByTestId("login-clear-all-confirm").click();
  await expect.poll(() => reloadPage.mock.calls.length).toBe(1);
  expect(await idbGetAll("profiles")).toEqual([]);
});

test.each(["zh-Hans", "ar"] as const)(
  "a partial clear-all keeps the %s warning on the profile picker and can be retried",
  async (locale) => {
    const reloadPage = vi.fn();
    const ctx = await setup({ profiles: [profile()], reloadPage });
    await setLocale(locale);
    sessionStorage.setItem("headscale-ui-tail", "tail");
    const remove = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(() => {
        throw new DOMException("denied", "SecurityError");
      });
    await page.getByTestId("login-clear-all").click();
    await page.getByTestId("login-clear-all-confirm").click();
    await expect
      .element(page.getByTestId("login-error"))
      .toMatchTextContent(
        locale === "ar" ? "تم مسح البيانات المحفوظة" : "已清除保存的数据",
      );
    expect(await idbGetAll("profiles")).toEqual([]);
    expect(ctx.session.auth.getSessionSnapshot()?.status).toBe("locked");
    expect(reloadPage).not.toHaveBeenCalled();
    remove.mockRestore();
    await page.getByTestId("login-clear-all").click();
    await page.getByTestId("login-clear-all-confirm").click();
    await expect.poll(() => reloadPage.mock.calls.length).toBe(1);
  },
);

test("while a profile authenticates the picker stays and only that row is aria-busy", async () => {
  const ctx = await setup({
    profiles: [profile(), profile({ id: "profile-2", name: "Beta" })],
  });
  ctx.session.profiles.setState({
    phase: { kind: "authenticating", profileId: "profile-1" },
  });
  await expect.element(page.getByTestId("login-clear-all")).toBeDisabled();
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
    const element = document.querySelector<HTMLElement>(
      `[data-testid="${id}"]`,
    );
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
  const ctx = await setup({ path: "/login?redirect=%2Fdevices%3Fnode%3D7" });
  await page.getByTestId("profile-option-new").click();
  expect(
    document.querySelector('[data-testid="connect-password"]'),
  ).not.toBeNull();
  await fillConnection();
  await page.getByTestId("connect-password-confirm").fill("different password");
  await page.getByTestId("connect-submit").click();
  const confirmation = page.getByTestId("connect-password-confirm");
  await expect.element(confirmation).toHaveAttribute("aria-invalid", "true");
  await expect.element(confirmation).toHaveFocus();
  await expect
    .element(confirmation)
    .toHaveAccessibleDescription("The passwords do not match.");
  await expect
    .element(page.getByTestId("connect-error"))
    .not.toBeInTheDocument();
  expect(await idbGetAll("profiles")).toEqual([]);
  await page.getByTestId("connect-password-confirm").fill("server password");
  await expect
    .element(page.getByTestId("connect-password-mismatch"))
    .not.toBeInTheDocument();
  // Save and unlock is the form's primary action, so Enter submits it.
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => ctx.router.state.location.pathname).toBe("/devices");
  expect(ctx.router.state.location.search).toEqual({ node: "7" });
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
  await expect
    .element(page.getByTestId("connect-server-url-error"))
    .toBeVisible();
  await expect
    .element(page.getByTestId("connect-api-key"))
    .toHaveValue("isolated-key");
  await expect
    .element(page.getByTestId("connect-password"))
    .toHaveValue("server password");
  await expect
    .element(page.getByTestId("connect-password-confirm"))
    .toHaveValue("server password");
  expect(ctx.requests).toEqual([]);
  expect(await idbGetAll("profiles")).toEqual([]);
  await page.getByTestId("connect-server-url").fill("https://fixture.invalid");
  await page.getByTestId("connect-submit").click();
  await expect.element(page.getByTestId("profile-option-Typo")).toBeVisible();
});

test("a new profile password needs at least 8 characters", async () => {
  const ctx = await setup();
  await page.getByTestId("profile-option-new").click();
  await fillConnection();
  const password = page.getByTestId("connect-password");
  await expect
    .element(password)
    .toHaveAccessibleDescription(expect.stringContaining("at least 8"));
  await password.fill("short");
  await page.getByTestId("connect-password-confirm").fill("short");
  await page.getByTestId("connect-save-unlock").click();
  await expect.element(password).toHaveAttribute("aria-invalid", "true");
  await expect.element(password).toHaveFocus();
  await expect
    .element(page.getByTestId("connect-password-mismatch"))
    .not.toBeInTheDocument();
  expect(ctx.requests).toEqual([]);
  expect(await idbGetAll("profiles")).toEqual([]);
});

test("explains the remember option in visible text tied to the checkbox", async () => {
  await setup();
  await page.getByTestId("profile-option-new").click();
  const remember = page.getByTestId("connect-remember");
  await expect
    .element(remember)
    .toHaveAccessibleDescription(
      expect.stringContaining("listed only in this tab"),
    );
  await expect
    .element(
      page.getByText("encrypted API key stays in this browser", {
        exact: false,
      }),
    )
    .toBeVisible();
  expect(
    document.querySelector('[data-testid="connection-dialog"] svg title'),
  ).toBeNull();
});

test("warns that plain HTTP to another host sends the API key unencrypted without blocking it", async () => {
  const ctx = await setup();
  await page.getByTestId("profile-option-new").click();
  await fillConnection("Plain");
  const url = page.getByTestId("connect-server-url");
  await url.fill("http://127.0.0.1:8080");
  await expect
    .element(page.getByTestId("connect-url-insecure"))
    .not.toBeInTheDocument();
  await url.fill("http://fixture.invalid");
  await expect
    .element(url)
    .toHaveAccessibleDescription(expect.stringContaining("plain HTTP"));
  await page.getByTestId("connect-submit").click();
  await expect.element(page.getByTestId("profile-option-Plain")).toBeVisible();
  expect(ctx.session.profiles.getSnapshot().profiles[0]?.baseUrl).toBe(
    "http://fixture.invalid",
  );
});

test("rejects a server URL with credentials or a query before anything is stored", async () => {
  const ctx = await setup();
  await page.getByTestId("profile-option-new").click();
  await fillConnection();
  await page
    .getByTestId("connect-server-url")
    .fill("https://admin:secret@fixture.invalid");
  await page.getByTestId("connect-submit").click();
  await expect
    .element(page.getByTestId("connect-server-url-error"))
    .toMatchTextContent("user name, password");
  expect(ctx.requests).toEqual([]);
  expect(await idbGetAll("profiles")).toEqual([]);
});

test("an empty new password asks for the server password", async () => {
  const ctx = await setup();
  await page.getByTestId("profile-option-new").click();
  await page.getByTestId("connect-server-url").fill("https://fixture.invalid");
  await page.getByTestId("connect-api-key").fill("isolated-key");
  await page.getByTestId("connect-submit").click();
  await expect
    .element(page.getByTestId("connect-password-error"))
    .toHaveTextContent("Enter the profile password.");
  await expect
    .element(page.getByTestId("connect-api-key"))
    .toHaveValue("isolated-key");
  expect(ctx.requests).toEqual([]);
  expect(await idbGetAll("profiles")).toEqual([]);
});

test("a rejected credential edit keeps the stored profile unchanged until a validated retry", async () => {
  const ctx = await setup({ profiles: [profile()] });
  const before = await idbGet<PasswordStoredProfile>("profiles", "profile-1");
  await page.getByTestId("edit-profile-Alpha").click();
  await page.getByTestId("connect-api-key").fill("new-key");
  await page.getByTestId("connect-password").fill("server password");
  ctx.fail("Server unreachable");
  await page.getByTestId("connect-submit").click();
  await expect
    .element(page.getByTestId("connect-error"))
    .toHaveTextContent("Server unreachable");
  await expect.element(page.getByTestId("connect-form")).toBeVisible();
  await expect
    .element(page.getByTestId("connect-password-confirm"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("profile-validation-dialog"))
    .not.toBeInTheDocument();
  expect(await idbGet("profiles", "profile-1")).toEqual(before);
  ctx.fail("");
  await page.getByTestId("connect-api-key").fill("new-key");
  await page.getByTestId("connect-password").fill("server password");
  await page.getByTestId("connect-submit").click();
  await expect
    .element(page.getByTestId("connection-dialog"))
    .not.toBeInTheDocument();
  expect(ctx.session.profiles.getSnapshot().profiles).toHaveLength(1);
  expect(
    (await idbGet<PasswordStoredProfile>("profiles", "profile-1"))?.apiKey,
  ).not.toEqual(before?.apiKey);
});

test("exposes one banner and one main landmark outside the dialogs", async () => {
  await setup();
  expect(page.getByRole("banner").elements()).toHaveLength(1);
  expect(page.getByRole("main").elements()).toHaveLength(1);
  const main = page.getByRole("main").element();
  expect(main.contains(page.getByRole("banner").element())).toBe(false);
  expect(
    main.contains(document.querySelector('[data-testid="profile-picker"]')),
  ).toBe(true);
});

test("names edit and delete buttons per profile and keeps server URL entry hints", async () => {
  await setup({
    profiles: [profile(), profile({ id: "profile-2", name: "Beta" })],
  });
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

test("the original connection form keeps a failed request visible", async () => {
  const ctx = await setup();
  await page.getByTestId("profile-option-new").click();
  await fillConnection("Offline");
  ctx.fail("Server unreachable");
  await page.getByTestId("connect-submit").click();
  await expect
    .element(page.getByTestId("connect-error"))
    .toHaveTextContent("Server unreachable");
  await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
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
  await expect
    .element(page.getByTestId("theme-select"))
    .toHaveAccessibleName("Theme: Dark");
});

test("reports a language catalog that failed to load and keeps the picker usable", async () => {
  await setup();
  vi.mocked(localeRuntime.loadLocale).mockRejectedValueOnce(
    new Error("catalog unavailable"),
  );
  await page.getByTestId("locale-select").click();
  await page.getByTestId("locale-option-fr-FR").click();
  await expect
    .element(
      page.getByRole("dialog", { name: t("languageLoadFailed"), exact: true }),
    )
    .toBeVisible();
  await expect
    .element(page.getByTestId("locale-error"))
    .not.toBeInTheDocument();
  expect(document.documentElement.lang).toBe("en-US");
  await expect.element(page.getByTestId("profile-picker")).toBeVisible();
});

test("reports a language failure recorded before the page renders", async () => {
  const session = await prepareTestSession();
  vi.mocked(localeRuntime.loadLocale).mockRejectedValueOnce(
    new Error("catalog unavailable"),
  );
  expect((await setLocale("it-IT")).status).toBe("load-failed");
  await renderSessionPage(session, <LoginPage />, "/login");
  await expect
    .element(
      page.getByRole("dialog", { name: t("languageLoadFailed"), exact: true }),
    )
    .toBeVisible();
  await expect
    .element(page.getByTestId("locale-error"))
    .not.toBeInTheDocument();
  expect(document.documentElement.lang).toBe("en-US");
});

test("reports a theme that was applied but not saved until a later save succeeds", async () => {
  await setup();
  vi.mocked(settings.writeSetting).mockRejectedValueOnce(
    new Error("storage unavailable"),
  );
  await page.getByTestId("theme-select").click();
  await page.getByTestId("theme-option-dark").click();
  await expect
    .element(
      page.getByRole("dialog", { name: t("themeNotSaved"), exact: true }),
    )
    .toBeVisible();
  await expect.element(page.getByTestId("theme-error")).not.toBeInTheDocument();
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  await expect.poll(() => readSetting("theme")).not.toBe("dark");
  await page.getByTestId("theme-select").click();
  await page.getByTestId("theme-option-dark").click();
  await expect.poll(() => readSetting("theme")).toBe("dark");
  await expect.element(page.getByTestId("theme-error")).not.toBeInTheDocument();
});

test("warns when preferences cannot be reloaded and clears it on the next successful read", async () => {
  await setup();
  const version = {
    keyEpoch: captureSettingsWriteEpoch(),
    profilesRevision: 0,
  };
  vi.mocked(settings.hydrateSettings).mockRejectedValueOnce(
    new Error("read unavailable"),
  );
  notifyVaultChanged(version);
  await expect
    .element(page.getByTestId("settings-error"))
    .toMatchTextContent("could not reload your preferences");
  notifyVaultChanged(version);
  await expect
    .element(page.getByTestId("settings-error"))
    .not.toBeInTheDocument();
});

test("a legacy credential is badged as needing migration and opens migration without a request", async () => {
  const ctx = await setup({
    profiles: [profile({ credentialKind: "legacy-plaintext" })],
  });
  await expect
    .element(page.getByTestId("profile-badge-migration-Alpha"))
    .toMatchTextContent("Migration required");
  await page.getByTestId("profile-option-Alpha").click();
  await expect.element(page.getByTestId("unlock-dialog")).toBeVisible();
  expect(ctx.requests).toEqual([]);
});

async function unlockAlpha(ctx: Awaited<ReturnType<typeof setup>>) {
  const saved = ctx.session.profiles.getSnapshot().profiles[0];
  expect.assert(saved);
  expect(
    await ctx.session.profiles.enterProfile(saved, "server password"),
  ).toBe(true);
  return saved;
}

test("a wrong unlock password is reported once, inside the unlock dialog", async () => {
  await setup({ profiles: [profile()] });
  await page.getByTestId("profile-option-Alpha").click();
  await page.getByTestId("unlock-passphrase").fill("wrong password");
  await page.getByTestId("unlock-submit").click();
  await expect
    .element(page.getByTestId("unlock-error"))
    .toHaveTextContent(
      "Could not unlock this profile with the supplied password.",
    );
  await expect.element(page.getByTestId("login-error")).not.toBeInTheDocument();
  await page.getByTestId("unlock-cancel").click();
  await expect
    .element(page.getByTestId("unlock-dialog"))
    .not.toBeInTheDocument();
  await expect.element(page.getByTestId("login-error")).not.toBeInTheDocument();
});

test.each([
  ["/login?redirect=%2Fdevices", "No other open tab kept the session unlocked"],
  ["/login", ""],
])(
  "explains why %s asks for the password after the session ended",
  async (path, notice) => {
    await setup({ profiles: [profile()], path });
    await expect
      .element(page.getByTestId("profile-option-Alpha"))
      .toBeVisible();
    if (notice)
      await expect
        .element(page.getByTestId("login-notice"))
        .toMatchTextContent(notice);
    else
      expect(document.querySelector('[data-testid="login-notice"]')).toBeNull();
  },
);

test("a logout, and this tab's own password change, are explained on the login page", async () => {
  const ctx = await setup({
    profiles: [profile()],
    path: "/login?redirect=%2Fdevices",
  });
  await unlockAlpha(ctx);
  await ctx.session.profiles.logout();
  await expect
    .element(page.getByTestId("login-notice"))
    .toMatchTextContent("You logged out");
  ctx.session.profiles.setState({ passwordChanged: true });
  await expect
    .element(page.getByTestId("login-notice"))
    .toHaveTextContent(
      "Password changed. Unlock the server with the new profile password.",
    );
  await ctx.router.navigate({ to: "/home" });
  await expect
    .poll(() => ctx.session.profiles.getSnapshot().passwordChanged)
    .toBe(false);
});

test("an unlocked server continues without a password, and discarded edits are explained first", async () => {
  const ctx = await setup({
    profiles: [profile()],
    path: "/login?redirect=%2Fdevices",
  });
  await unlockAlpha(ctx);
  ctx.session.profiles.setState({ discardedPolicyDraft: true });
  await expect
    .element(page.getByTestId("login-discarded-policy"))
    .toMatchTextContent("Unsaved access control changes were discarded");
  await expect
    .element(page.getByTestId("login-unlocked"))
    .toMatchTextContent("Alpha is already unlocked");
  await page.getByTestId("login-continue").click();
  await expect.poll(() => ctx.router.state.location.pathname).toBe("/devices");
  expect(ctx.session.profiles.getSnapshot().discardedPolicyDraft).toBe(false);
  await ctx.router.navigate({ to: "/login" });
  await page.getByTestId("profile-option-Alpha").click();
  await expect.poll(() => ctx.router.state.location.pathname).toBe("/");
  expect(document.querySelector('[data-testid="unlock-dialog"]')).toBeNull();
});

test("counts saved records that cannot be listed", async () => {
  const ctx = await setup({
    profiles: [
      profile(),
      profile({ id: "bad", name: "Broken", credentialKind: "unreadable" }),
    ],
  });
  await idbPut("profiles", { id: 42, name: "Hidden" });
  await ctx.session.profiles.reloadProfiles();
  await expect
    .element(page.getByTestId("unreadable-records-notice"))
    .toMatchTextContent("can’t be read and are not listed: 1");
});

test("an unreadable profile is replaced with new credentials from its repair dialog", async () => {
  await setup({
    profiles: [
      profile({ id: "bad", name: "Broken", credentialKind: "unreadable" }),
    ],
  });
  await page.getByTestId("profile-option-Broken").click();
  await expect
    .element(page.getByTestId("connect-profile-state"))
    .toMatchTextContent("This saved profile can’t be read");
  await expect
    .element(page.getByTestId("connect-password"))
    .toHaveAttribute("autocomplete", "new-password");
  await fillConnection("Repaired");
  await page.getByTestId("connect-submit").click();
  await expect
    .element(page.getByTestId("profile-badge-locked-Repaired"))
    .toBeVisible();
  expect(await idbGet<PasswordStoredProfile>("profiles", "bad")).toMatchObject({
    name: "Repaired",
    apiKey: { v: 2, scheme: "password" },
  });
});

test("a legacy profile can be renamed but must be migrated before its credentials change", async () => {
  const ctx = await setup({
    profiles: [profile({ credentialKind: "legacy-plaintext" })],
  });
  await page.getByTestId("edit-profile-Alpha").click();
  await expect
    .element(page.getByTestId("connect-profile-state"))
    .toMatchTextContent("older storage format");
  await page.getByTestId("connect-api-key").fill("replacement-key");
  await page.getByTestId("connect-password").fill("server password");
  await page.getByTestId("connect-submit").click();
  await expect
    .element(page.getByTestId("connect-error"))
    .toMatchTextContent("older storage format");
  expect(ctx.requests).toEqual([]);
  await page.getByTestId("connect-api-key").fill("");
  await page.getByTestId("connect-password").fill("");
  await page.getByTestId("connect-profile-name").fill("Legacy renamed");
  await page.getByTestId("connect-submit").click();
  await expect
    .element(page.getByTestId("profile-option-Legacy renamed"))
    .toBeVisible();
});

test("a running delete keeps its dialog until the failure is reported there", async () => {
  const ctx = await setup({ profiles: [profile()] });
  const gate = Promise.withResolvers<void>();
  vi.spyOn(ctx.session.auth, "deleteProfile").mockImplementation(async () => {
    await gate.promise;
    return { ok: false, error: { kind: "storage-conflict" } };
  });
  await page.getByTestId("delete-profile-Alpha").click();
  await page.getByTestId("confirm-delete-profile").click();
  await expect
    .element(page.getByTestId("confirm-delete-profile"))
    .toBeDisabled();
  await expect
    .element(page.getByTestId("cancel-delete-profile"))
    .toBeDisabled();
  await userEvent.keyboard("{Escape}");
  gate.resolve();
  await expect
    .element(page.getByTestId("delete-profile-error"))
    .toMatchTextContent("Saved connections changed");
  await expect.element(page.getByTestId("login-error")).not.toBeInTheDocument();
  await page.getByTestId("cancel-delete-profile").click();
  await expect
    .element(page.getByTestId("delete-profile-dialog"))
    .not.toBeInTheDocument();
});

test("centers a single profile card under the heading and keeps long names readable", async () => {
  const long =
    "Production headscale (eu-west) with a very long descriptive name";
  const ctx = await setup({ profiles: [profile({ name: long })] });
  const center = (element: Element) => {
    const box = element.getBoundingClientRect();
    return box.left + box.width / 2;
  };
  const picker = page.getByTestId("profile-picker").element();
  const cards = [...picker.children].map((child) =>
    child.getBoundingClientRect(),
  );
  const left = Math.min(...cards.map((box) => box.left));
  const right = Math.max(...cards.map((box) => box.right));
  expect(
    Math.abs(
      (left + right) / 2 -
        center(page.getByRole("heading", { level: 1 }).element()),
    ),
  ).toBeLessThan(2);
  expect(document.querySelector(`[title="${long}"]`)?.textContent).toBe(long);
  await page.getByTestId(`edit-profile-${long}`).click();
  await expect.element(page.getByRole("dialog")).toHaveAttribute("data-open");
  expect(document.querySelectorAll(`[title="${long}"]`)).toHaveLength(2);
  ctx.session.profiles.setState({ phase: { kind: "adding" } });
  await expect
    .element(page.getByTestId("connect-submit"))
    .toHaveTextContent("Saving");
  // A save in flight cannot be edited underneath it.
  await expect
    .element(page.getByTestId("connect-profile-name"))
    .toHaveAttribute("readonly");
});

test("Enter normalizes all connection values before dispatch without requiring a blur", async () => {
  const ctx = await setup();
  const submitted: unknown[] = [];
  const save = ctx.session.auth.saveProfile.bind(ctx.session.auth);
  vi.spyOn(ctx.session.auth, "saveProfile").mockImplementation(
    (input, options) => {
      submitted.push(structuredClone(input));
      return save(input, options);
    },
  );
  await page.getByTestId("profile-option-new").click();
  await page.getByTestId("connect-profile-name").fill("  Alpha  ");
  await page
    .getByTestId("connect-server-url")
    .fill("  https://fixture.invalid  ");
  await page.getByTestId("connect-api-key").fill("  isolated-key  ");
  await page.getByTestId("connect-password").fill("  server password  ");
  await page.getByTestId("connect-password-confirm").fill(" server password ");
  await userEvent.keyboard("{Enter}");
  await expect
    .poll(() => ctx.session.auth.getSessionSnapshot()?.status)
    .toBe("unlocked");
  expect(submitted).toEqual([
    expect.objectContaining({
      kind: "credentials",
      profile: expect.objectContaining({
        name: "Alpha",
        baseUrl: "https://fixture.invalid",
      }),
      apiKey: "isolated-key",
      password: "server password",
      activate: true,
    }),
  ]);
});

test("the URL validates on submit and rechecks changes without a special blur validator", async () => {
  const ctx = await setup();
  await page.getByTestId("profile-option-new").click();
  await fillConnection();
  const url = page.getByTestId("connect-server-url");
  await url.fill("bad url");
  await page.getByTestId("connect-profile-name").click();
  await expect.element(url).not.toHaveAttribute("aria-invalid", "true");
  expect(ctx.requests).toEqual([]);
  await page.getByTestId("connect-submit").click();
  await expect.element(url).toHaveAttribute("aria-invalid", "true");
  await expect.element(url).toHaveFocus();
  await url.fill("https://fixture.invalid");
  await expect.element(url).not.toHaveAttribute("aria-invalid", "true");
  expect(ctx.requests).toEqual([]);
});

test("a missing API key is reported on its field without dispatching or clearing the password", async () => {
  const ctx = await setup();
  await page.getByTestId("profile-option-new").click();
  await page.getByTestId("connect-profile-name").fill("Missing key");
  await page.getByTestId("connect-server-url").fill("https://fixture.invalid");
  await page.getByTestId("connect-password").fill("server password");
  await page.getByTestId("connect-password-confirm").fill("server password");
  await page.getByTestId("connect-save-unlock").click();
  await expect
    .element(page.getByTestId("connect-api-key"))
    .toHaveAttribute("aria-invalid", "true");
  await expect.element(page.getByTestId("connect-api-key")).toHaveFocus();
  await expect
    .element(page.getByTestId("connect-password"))
    .toHaveValue("server password");
  expect(ctx.requests).toEqual([]);
  expect(await idbGetAll("profiles")).toEqual([]);
});

test("a confirmation-only connection draft participates in close and beforeunload protection", async () => {
  await setup();
  await page.getByTestId("profile-option-new").click();
  await page
    .getByTestId("connect-password-confirm")
    .fill("unsubmitted confirmation");
  const unloading = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unloading);
  expect(unloading.defaultPrevented).toBe(true);
  await page.getByTestId("connect-close").click();
  await expect
    .element(page.getByTestId("discard-profile-changes-dialog"))
    .toBeVisible();
  await page.getByTestId("discard-profile-changes").click();
  await page.getByTestId("profile-option-new").click();
  await expect
    .element(page.getByTestId("connect-password-confirm"))
    .toHaveValue("");
});

test("pending validation clears every secret immediately and a late failure keeps newer draft inputs", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const ctx = await setup({
    waitForRequest: () => {
      started.resolve();
      return release.promise;
    },
  });
  ctx.fail("Old request rejected");
  await page.getByTestId("profile-option-new").click();
  await fillConnection();
  await page.getByTestId("connect-submit").click();
  await started.promise;
  try {
    for (const id of [
      "connect-api-key",
      "connect-password",
      "connect-password-confirm",
    ])
      await expect.element(page.getByTestId(id)).toHaveValue("");
    ctx.session.profiles.setConnectionForm({
      profileName: "New draft",
      apiKey: "new-key",
      password: "new password",
      passwordConfirmation: "new password",
    });
  } finally {
    release.resolve();
  }
  await expect.poll(() => ctx.session.profiles.isConnecting).toBe(false);
  await expect
    .element(page.getByTestId("connect-profile-name"))
    .toHaveValue("New draft");
  await expect
    .element(page.getByTestId("connect-api-key"))
    .toHaveValue("new-key");
  await expect
    .element(page.getByTestId("connect-password"))
    .toHaveValue("new password");
  await expect
    .element(page.getByTestId("connect-password-confirm"))
    .toHaveValue("new password");
  await expect
    .element(page.getByTestId("profile-validation-dialog"))
    .not.toBeInTheDocument();
  expect(ctx.session.feedback.getSnapshot().lastError).toBe("");
});

test.each(["connect-submit", "connect-save-unlock"])(
  "a failed %s stays in the original form and requires a validated explicit retry",
  async (button) => {
    const ctx = await setup();
    await page.getByTestId("profile-option-new").click();
    await fillConnection("Retry server");
    ctx.fail("Server unreachable");
    await page.getByTestId(button).click();
    await expect.poll(() => ctx.session.profiles.isConnecting).toBe(false);
    await expect.element(page.getByTestId("connect-form")).toBeVisible();
    await expect.element(page.getByTestId("connect-error")).toBeVisible();
    await expect
      .element(page.getByTestId("profile-validation-dialog"))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByTestId("connect-profile-name"))
      .toHaveValue("Retry server");
    await expect
      .element(page.getByTestId("connect-server-url"))
      .toHaveValue("https://fixture.invalid");
    for (const id of [
      "connect-api-key",
      "connect-password",
      "connect-password-confirm",
    ])
      await expect.element(page.getByTestId(id)).toHaveValue("");
    expect(await idbGetAll("profiles")).toEqual([]);
    expect(ctx.session.auth.getSessionSnapshot()?.status).not.toBe("unlocked");
    const requests = ctx.requests.length;

    ctx.fail("");
    await page.getByTestId("connect-api-key").fill(" isolated-key ");
    await page.getByTestId("connect-password").fill(" server password ");
    await page
      .getByTestId("connect-password-confirm")
      .fill(" server password ");
    expect(ctx.requests).toHaveLength(requests);
    await page.getByTestId(button).click();
    await expect
      .poll(() => ctx.session.profiles.getSnapshot().profiles.length)
      .toBe(1);
    await expect
      .element(page.getByTestId("connection-dialog"))
      .not.toBeInTheDocument();
    expect(ctx.requests.length).toBeGreaterThan(requests);
    if (button === "connect-save-unlock") {
      await expect
        .element(page.getByTestId("test-route"))
        .toHaveTextContent("/");
      expect(ctx.session.auth.getSessionSnapshot()?.status).toBe("unlocked");
    } else {
      await expect
        .element(page.getByTestId("profile-option-Retry server"))
        .toBeVisible();
      expect(ctx.session.auth.getSessionSnapshot()?.status).toBe("locked");
    }
  },
);

test.each(["x", " x ", "   "])(
  "editing credentials preserves the existing password %j without enforcing new-password rules",
  async (password) => {
    const ctx = await setup({ profiles: [profile()] });
    const stored = await idbGet<PasswordStoredProfile>("profiles", "profile-1");
    expect.assert(stored);
    await idbPut("profiles", {
      ...stored,
      apiKey: await encryptProfileKey({
        profileId: stored.id,
        canonicalBaseUrl: stored.baseUrl,
        credentialVersion: stored.credentialVersion,
        apiKey: "isolated-key",
        password,
      }),
    });
    const submitted: unknown[] = [];
    const save = ctx.session.auth.saveProfile.bind(ctx.session.auth);
    vi.spyOn(ctx.session.auth, "saveProfile").mockImplementation(
      (input, options) => {
        submitted.push(structuredClone(input));
        return save(input, options);
      },
    );
    await page.getByTestId("edit-profile-Alpha").click();
    await page.getByTestId("connect-api-key").fill(" replacement-key ");
    await page.getByTestId("connect-password").fill(password);
    await page.getByTestId("connect-profile-name").fill("Renamed");
    await expect
      .element(page.getByTestId("connect-password"))
      .toHaveValue(password);
    await expect
      .element(page.getByTestId("connect-password-confirm"))
      .not.toBeInTheDocument();
    await page.getByTestId("connect-submit").click();
    await expect
      .element(page.getByTestId("profile-option-Renamed"))
      .toBeVisible();
    expect(submitted).toEqual([
      expect.objectContaining({ password, apiKey: "replacement-key" }),
    ]);
  },
);

test("repeated native connection submits dispatch one save while clearing secrets", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const ctx = await setup({
    waitForRequest: () => {
      started.resolve();
      return release.promise;
    },
  });
  const save = vi.spyOn(ctx.session.auth, "saveProfile");
  await page.getByTestId("profile-option-new").click();
  await fillConnection();
  const form = page.getByTestId("connect-form").element();
  expect.assert(form instanceof HTMLFormElement);
  form.requestSubmit();
  form.requestSubmit();
  await started.promise;
  try {
    expect(save).toHaveBeenCalledTimes(1);
    for (const id of [
      "connect-api-key",
      "connect-password",
      "connect-password-confirm",
    ])
      await expect.element(page.getByTestId(id)).toHaveValue("");
  } finally {
    release.resolve();
  }
  await expect
    .poll(() => ctx.session.auth.getSessionSnapshot()?.status)
    .toBe("unlocked");
  expect(ctx.session.profiles.getSnapshot().profiles).toHaveLength(1);
  expect(save).toHaveBeenCalledTimes(1);
});

test("API key help and copying never submit a valid parent form or erase its draft", async () => {
  const ctx = await setup();
  await page.getByTestId("profile-option-new").click();
  await fillConnection("Draft");
  const before = { ...ctx.session.profiles.getSnapshot().connectionForm };
  vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const help = page.getByRole("button", {
    name: "How to get an API key",
    exact: true,
  });
  await help.click();
  const dialog = page.getByRole("dialog", {
    name: "How to get an API key",
    exact: true,
  });
  const bounds = dialog.element().getBoundingClientRect();
  expect(
    Math.abs(bounds.left + bounds.width / 2 - window.innerWidth / 2),
  ).toBeLessThan(2);
  expect(
    Math.abs(bounds.top + bounds.height / 2 - window.innerHeight / 2),
  ).toBeLessThan(2);
  await page.getByTestId("api-key-command-copy").click();
  await expect
    .element(page.getByTestId("api-key-command-copy"))
    .toHaveTextContent("Copied");
  await userEvent.keyboard("{Escape}");
  await expect.element(help).toHaveFocus();
  expect(ctx.session.profiles.getSnapshot().connectionForm).toEqual(before);
  expect(ctx.requests).toEqual([]);
  expect(await idbGetAll("profiles")).toEqual([]);
});

test("a saved connection whose activation fails has one global warning after its real dialog closes", async () => {
  const ctx = await setup();
  const saveProfile = ctx.session.auth.saveProfile.bind(ctx.session.auth);
  vi.spyOn(ctx.session.auth, "saveProfile").mockImplementation(
    async (input, options) => {
      if (input.kind !== "credentials") return saveProfile(input, options);
      // Exercise the UI's typed commit/activation boundary, with real encrypted persistence.
      const result = await saveProfile({ ...input, activate: false }, options);
      if (!result.ok) return result;
      return {
        ...result,
        value: {
          ...result.value,
          activation: { ok: false, error: { kind: "locked" } } as const,
        },
      };
    },
  );
  const add = vi.spyOn(ctx.session.feedback.toastManager, "add");
  await page.getByTestId("profile-option-new").click();
  await fillConnection("Saved but locked");
  await page.getByTestId("connect-save-unlock").click();
  await expect
    .element(page.getByTestId("connection-dialog"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("profile-option-Saved but locked"))
    .toBeVisible();
  const warning = page.getByText(t("sessionSavedLocked"), { exact: true });
  await expect.element(warning).toBeVisible();
  expect(warning.element().closest('[data-slot="toast"]')).not.toBeNull();
  await expect.element(page.getByTestId("login-error")).not.toBeInTheDocument();
  expect(add).toHaveBeenCalledTimes(1);
  expect(add).toHaveBeenCalledWith(
    expect.objectContaining({ priority: "low", data: { tone: "warning" } }),
  );
  expect(JSON.stringify(add.mock.calls)).not.toContain("isolated-key");
  expect(JSON.stringify(add.mock.calls)).not.toContain("server password");
  expect(ctx.session.auth.getSessionSnapshot()?.status).toBe("locked");
  const requests = ctx.requests.length;
  await page.getByRole("button", { name: t("close"), exact: true }).click();
  await expect.element(warning).not.toBeInTheDocument();
  expect(ctx.session.profiles.getSnapshot().profiles).toHaveLength(1);
  expect(ctx.requests).toHaveLength(requests);
});
