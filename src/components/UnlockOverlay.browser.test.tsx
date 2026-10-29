import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { Session } from "@/composables/session-context";
import { SAVED_LOCKED_ERROR } from "@/composables/useProfiles";
import { setLocale, t } from "@/i18n";
import {
  CANARY_KEY_ID,
  deriveKeyFromPassword,
  encryptProfileKey,
} from "@/lib/api-key-crypto";
import type { PasswordStoredProfile } from "@/lib/profile-storage";
import LoginPage from "@/pages/LoginPage";
import { guardRoute } from "@/router";
import { parseSearch, stringifySearch } from "@/router/search";
import {
  prepareTestSession,
  renderSessionPage,
  SessionTestProviders,
} from "@/test/session";
import { snapshotFixture } from "@/test-utils/headscale.test";
import {
  encryptLegacyKey,
  legacySalt,
  makeLegacyCanary,
  seedLegacyDeviceKey,
} from "@/test-utils/legacy-vault";
import { idbGet, idbPut } from "@/test-utils/storage";
import UnlockOverlay from "./UnlockOverlay";

let serverDown = false;
afterEach(() => {
  serverDown = false;
  vi.restoreAllMocks();
});
async function setup(legacy?: "device" | "password" | "plaintext") {
  const requests: string[] = [];
  const snapshot = snapshotFixture();
  const session = await prepareTestSession(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    requests.push(path);
    if (serverDown)
      return Response.json({ message: "Server unreachable" }, { status: 503 });
    const response: Record<string, unknown> = {
      "/api/v1/health": snapshot.health,
      "/version": snapshot.version,
      "/api/v1/user": { users: snapshot.users },
      "/api/v1/node": { nodes: snapshot.nodes },
      "/api/v1/preauthkey": { preAuthKeys: snapshot.preAuthKeys },
      "/api/v1/apikey": { apiKeys: snapshot.apiKeys },
      "/api/v1/policy": snapshot.policy,
    };
    return Response.json(response[path]);
  });
  await setLocale("en-US");
  if (legacy) {
    let apiKey: unknown = "isolated-legacy-key";
    if (legacy === "device")
      apiKey = await encryptLegacyKey(
        "isolated-legacy-key",
        await seedLegacyDeviceKey(),
        "device",
      );
    if (legacy === "password") {
      const salt = legacySalt();
      const key = await deriveKeyFromPassword("previous shared password", salt);
      await idbPut(
        "meta",
        await makeLegacyCanary(key, salt, 310000),
        CANARY_KEY_ID,
      );
      apiKey = await encryptLegacyKey("isolated-legacy-key", key, "password");
    }
    await idbPut("profiles", {
      id: "legacy-profile",
      name: "Saved server",
      baseUrl: "https://fixture.invalid",
      scope: "persistent",
      keyEpoch: session.profiles.getSnapshot().version?.keyEpoch,
      updatedAt: "2026-10-11T00:00:00Z",
      apiKey,
    });
    await session.profiles.reloadProfiles();
  } else {
    session.profiles.setConnectionForm({
      profileName: "Saved server",
      baseUrl: "https://fixture.invalid",
      apiKey: "isolated-key",
      password: "server password",
    });
    await session.profiles.persistConnection();
  }
  const profile = session.profiles.getSnapshot().profiles[0];
  if (!profile) throw new Error("Missing profile");
  await session.profiles.enterProfile(profile);
  return { session, profile, requests };
}

async function renderGuarded(session: Session, path: string) {
  const root = createRootRoute({
    component: Outlet,
    beforeLoad: ({ location }) => guardRoute(session, location),
  });
  const router = createRouter({
    parseSearch,
    stringifySearch,
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/login",
        component: UnlockOverlay,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/devices",
        component: () => <div data-testid="devices-route">devices</div>,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  await render(
    <SessionTestProviders session={session}>
      <RouterProvider router={router} />
    </SessionTestProviders>,
  );
  return router;
}

test("a redirect pinned to another profile lands on its path without that server's query or hash", async () => {
  const { session } = await setup();
  const target = "/devices?profile=other&node=7#d";
  const router = await renderGuarded(
    session,
    `/login?redirect=${encodeURIComponent(target)}`,
  );
  await page.getByTestId("unlock-passphrase").fill("server password");
  await page.getByTestId("unlock-submit").click();
  await expect.element(page.getByTestId("devices-route")).toBeVisible();
  expect(router.state.location.pathname).toBe("/devices");
  expect(router.state.location.search).toEqual({});
  expect(router.state.location.hash).toBe("");
  expect(session.auth.getSessionSnapshot()?.status).toBe("unlocked");
});

test("a redirect pinned to the unlocked profile keeps its query and hash", async () => {
  const { session, profile } = await setup();
  const target = `/devices?profile=${profile.id}&node=7#d`;
  const router = await renderGuarded(
    session,
    `/login?redirect=${encodeURIComponent(target)}`,
  );
  await page.getByTestId("unlock-passphrase").fill("server password");
  await page.getByTestId("unlock-submit").click();
  await expect.element(page.getByTestId("devices-route")).toBeVisible();
  expect(router.state.location.search).toMatchObject({
    profile: profile.id,
    node: "7",
  });
  expect(router.state.location.hash).toBe("d");
});

test("a per-server unlock clears wrong passwords without HTTP and preserves redirect query and hash", async () => {
  const { session, profile, requests } = await setup();
  const before = await idbGet("profiles", profile.id);
  const target = "/devices?node=123&search=a%2Bb#details";
  const { router } = await renderSessionPage(
    session,
    <UnlockOverlay />,
    `/login?redirect=${encodeURIComponent(target)}`,
  );
  expect(
    document.querySelector('[data-testid="unlock-dialog"]'),
  ).not.toBeNull();
  await page.getByTestId("unlock-passphrase").fill("wrong password");
  await page.getByTestId("unlock-submit").click();
  await expect.element(page.getByTestId("unlock-error")).toBeVisible();
  const field = page.getByTestId("unlock-passphrase");
  await expect.element(field).toHaveValue("");
  await expect.element(field).toHaveFocus();
  await expect.element(field).toHaveAttribute("aria-invalid", "true");
  await expect
    .element(field)
    .toHaveAccessibleDescription(
      "Could not unlock this profile with the supplied password.",
    );
  expect(requests).toEqual([]);
  expect(await idbGet("profiles", profile.id)).toEqual(before);
  await page.getByTestId("unlock-passphrase").fill("server password");
  await page.getByTestId("unlock-submit").click();
  await expect.poll(() => router.state.location.pathname).toBe("/devices");
  expect(router.state.location.search).toMatchObject({
    node: "123",
    search: "a+b",
  });
  expect(router.state.location.hash).toBe("details");
  expect(session.auth.getSessionSnapshot()?.profile?.id).toBe(profile.id);
});

test.each(["device", "password", "plaintext"] as const)(
  "migrates only the selected legacy-%s row after fresh password entry",
  async (kind) => {
    const { session, profile, requests } = await setup(kind);
    const before = await idbGet("profiles", profile.id);
    await renderSessionPage(session, <UnlockOverlay />, "/login");
    await expect
      .element(page.getByTestId("migration-new-password"))
      .toHaveValue("");
    expect(requests).toEqual([]);
    expect(await idbGet("profiles", profile.id)).toEqual(before);
    await page
      .getByTestId("migration-new-password")
      .fill("new server password");
    await page
      .getByTestId("migration-confirm-password")
      .fill("new server password");
    if (kind === "password") {
      await page
        .getByTestId("migration-current-password")
        .fill("wrong shared password");
      await page.getByTestId("migration-submit").click();
      await expect.element(page.getByTestId("unlock-error")).toBeVisible();
      expect(await idbGet("profiles", profile.id)).toEqual(before);
      expect(requests).toEqual([]);
      await page
        .getByTestId("migration-current-password")
        .fill("previous shared password");
      await page
        .getByTestId("migration-new-password")
        .fill("new server password");
      await page
        .getByTestId("migration-confirm-password")
        .fill("new server password");
    }
    await page.getByTestId("migration-submit").click();
    await expect
      .poll(() => session.auth.getSessionSnapshot()?.status)
      .toBe("unlocked");
    expect(await idbGet("profiles", profile.id)).toMatchObject({
      id: profile.id,
      apiKey: { v: 2, scheme: "password" },
    });
  },
);

test("a failed migration write clears new secrets, associates its error and requires an explicit retry", async () => {
  const { session, profile, requests } = await setup("device");
  const before = await idbGet("profiles", profile.id);
  await renderSessionPage(session, <UnlockOverlay />, "/login");
  const nativePut = IDBObjectStore.prototype.put;
  let rejectedWrites = 0;
  const put = vi
    .spyOn(IDBObjectStore.prototype, "put")
    .mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === "profiles") {
        ++rejectedWrites;
        throw new DOMException("quota", "QuotaExceededError");
      }
      return nativePut.apply(this, args);
    });
  await page.getByTestId("migration-new-password").fill("new server password");
  await page
    .getByTestId("migration-confirm-password")
    .fill("new server password");
  await page.getByTestId("migration-submit").click();
  const field = page.getByTestId("migration-new-password");
  await expect
    .element(page.getByTestId("unlock-error"))
    .toMatchTextContent("could not save");
  await expect.element(field).toHaveValue("");
  await expect.element(field).toHaveFocus();
  await expect.element(field).toHaveAttribute("aria-invalid", "true");
  await expect
    .element(field)
    .toHaveAccessibleDescription(expect.stringContaining("could not save"));
  await expect
    .element(page.getByTestId("migration-confirm-password"))
    .toHaveValue("");
  await expect.element(page.getByTestId("migration-submit")).toBeDisabled();
  expect(rejectedWrites).toBe(1);
  expect(requests).toEqual([]);
  expect(await idbGet("profiles", profile.id)).toEqual(before);
  expect(session.auth.getSessionSnapshot()?.status).toBe("locked");
  put.mockRestore();
  await field.fill("new server password");
  await page
    .getByTestId("migration-confirm-password")
    .fill("new server password");
  await expect.element(field).not.toHaveAttribute("aria-invalid", "true");
  await page.getByTestId("migration-submit").click();
  await expect
    .poll(() => session.auth.getSessionSnapshot()?.status)
    .toBe("unlocked");
  expect(await idbGet("profiles", profile.id)).toMatchObject({
    id: profile.id,
    apiKey: { v: 2, scheme: "password" },
  });
});

test("a migration whose unlock fails reopens as an unlock and retries without a storage conflict", async () => {
  const { session, profile } = await setup("device");
  await renderSessionPage(session, <UnlockOverlay />, "/login");
  serverDown = true;
  await page.getByTestId("migration-new-password").fill("new server password");
  await page
    .getByTestId("migration-confirm-password")
    .fill("new server password");
  await page.getByTestId("migration-submit").click();
  await expect.element(page.getByTestId("unlock-passphrase")).toBeVisible();
  await expect.element(page.getByTestId("unlock-error")).toBeVisible();
  expect(
    document.querySelector('[data-testid="migration-new-password"]'),
  ).toBeNull();
  expect(await idbGet("profiles", profile.id)).toMatchObject({
    apiKey: { v: 2 },
  });
  serverDown = false;
  await page.getByTestId("unlock-passphrase").fill("new server password");
  await page.getByTestId("unlock-submit").click();
  await expect
    .poll(() => session.auth.getSessionSnapshot()?.status)
    .toBe("unlocked");
  expect(session.feedback.getSnapshot().lastError).toBe("");
});

test("a saved-but-locked result is shown in the current language", async () => {
  const { session } = await setup();
  session.feedback.setState({ lastError: SAVED_LOCKED_ERROR });
  await renderSessionPage(session, <UnlockOverlay />, "/login");
  await expect
    .element(page.getByTestId("unlock-error"))
    .toHaveTextContent(t("sessionSavedLocked"));
});

test("a new migration password needs at least 8 characters before anything is stored", async () => {
  const { session, profile, requests } = await setup("device");
  const before = await idbGet("profiles", profile.id);
  await renderSessionPage(session, <UnlockOverlay />, "/login");
  await page.getByTestId("migration-new-password").fill("short");
  await page.getByTestId("migration-confirm-password").fill("short");
  await page.getByTestId("migration-submit").click();
  const field = page.getByTestId("migration-new-password");
  await expect
    .element(page.getByTestId("migration-new-password-error"))
    .toMatchTextContent("at least 8");
  await expect.element(field).toHaveAttribute("aria-invalid", "true");
  await expect.element(field).toHaveFocus();
  await expect.element(field).toHaveValue("short");
  expect(requests).toEqual([]);
  expect(await idbGet("profiles", profile.id)).toEqual(before);
});

test("a redirect back to a login screen continues to the console instead", async () => {
  const { session } = await setup();
  const { router } = await renderSessionPage(
    session,
    <UnlockOverlay />,
    `/login?redirect=${encodeURIComponent("/login?redirect=%2Fdevices")}`,
  );
  await page.getByTestId("unlock-passphrase").fill("server password");
  await page.getByTestId("unlock-submit").click();
  await expect.poll(() => router.state.location.pathname).toBe("/");
});

test("closing a pending unlock cancels its candidate without discarding an unrelated ordinary draft", async () => {
  const { session } = await setup();
  session.profiles.setConnectionForm({ profileName: "Unsaved ordinary draft" });
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = crypto.subtle.decrypt.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "decrypt").mockImplementation(async (...args) => {
    started.resolve();
    await release.promise;
    return original(...args);
  });
  await renderSessionPage(session, <UnlockOverlay />, "/login");
  await page.getByTestId("unlock-passphrase").fill("server password");
  await page.getByTestId("unlock-submit").click();
  await started.promise;
  await page.getByTestId("unlock-cancel").click();
  release.resolve();
  await expect
    .poll(() => session.profiles.getSnapshot().unlockProfile)
    .toBeNull();
  expect(session.profiles.getSnapshot().connectionForm.profileName).toBe(
    "Unsaved ordinary draft",
  );
  expect(session.auth.getSessionSnapshot()?.status).toBe("locked");
});

test.each(["zh-Hans", "ar"] as const)(
  "failed unlock is localized and retryable in %s",
  async (locale) => {
    const { session } = await setup();
    await setLocale(locale);
    await renderSessionPage(session, <UnlockOverlay />, "/login");
    await page.getByTestId("unlock-passphrase").fill("incorrect");
    await page.getByTestId("unlock-submit").click();
    await expect.element(page.getByTestId("unlock-error")).toBeVisible();
    await expect
      .element(page.getByTestId("unlock-error"))
      .not.toMatchTextContent("Session request failed");
    await expect.element(page.getByTestId("unlock-passphrase")).toHaveValue("");
    await expect.element(page.getByTestId("unlock-submit")).toBeDisabled();
  },
);

test.each([undefined, "device", "password", "plaintext"] as const)(
  "per-profile unlock and migration dialogs never offer global clear-all (%s)",
  async (legacy) => {
    const { session, profile } = await setup(legacy);
    const before = await idbGet("profiles", profile.id);
    await renderSessionPage(session, <UnlockOverlay />, "/login");
    await expect.element(page.getByTestId("unlock-dialog")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Clear all saved profiles" }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByTestId("unlock-dialog"))
      .toMatchTextContent("remove only this profile");
    expect(await idbGet("profiles", profile.id)).toEqual(before);
  },
);

function heldUnlock(session: Session) {
  const gate = Promise.withResolvers<boolean>();
  const unlock = vi
    .spyOn(session.profiles, "enterProfile")
    .mockImplementation(() => gate.promise);
  const form = () => {
    const element = document.querySelector(
      '[data-testid="unlock-dialog"] form',
    );
    if (!(element instanceof HTMLFormElement))
      throw new Error("Missing unlock form");
    return element;
  };
  return { gate, unlock, form };
}

test("a second submit while the first unlock is still running is ignored", async () => {
  const { session } = await setup();
  const { gate, unlock, form } = heldUnlock(session);
  await renderSessionPage(session, <UnlockOverlay />, "/login");
  await page.getByTestId("unlock-passphrase").fill("server password");
  form().requestSubmit();
  form().requestSubmit();
  await expect.poll(() => unlock.mock.calls.length).toBe(1);
  gate.resolve(false);
  await expect.element(page.getByTestId("unlock-submit")).toBeDisabled();
  expect(unlock).toHaveBeenCalledTimes(1);
});

test("submitting the form without a password shows the required message and never reaches the Worker", async () => {
  const { session } = await setup();
  const { unlock, form } = heldUnlock(session);
  await renderSessionPage(session, <UnlockOverlay />, "/login");
  await expect.element(page.getByTestId("unlock-submit")).toBeDisabled();
  form().requestSubmit();
  await expect
    .element(page.getByTestId("unlock-passphrase-error"))
    .toHaveTextContent(t("sessionSecretRequired"));
  expect(unlock).not.toHaveBeenCalled();
  expect(session.auth.getSessionSnapshot()?.status).toBe("locked");
});

test("migration requires matching fresh passwords before touching the legacy record", async () => {
  const { session, profile, requests } = await setup("device");
  const before = await idbGet("profiles", profile.id);
  await renderSessionPage(session, <UnlockOverlay />, "/login");
  await page.getByTestId("migration-new-password").fill("new password");
  await page
    .getByTestId("migration-confirm-password")
    .fill("different password");
  await page.getByTestId("migration-submit").click();
  await expect
    .element(page.getByTestId("migration-confirm-password-error"))
    .toMatchTextContent("do not match");
  await expect
    .element(page.getByTestId("migration-confirm-password"))
    .toHaveAttribute("aria-invalid", "true");
  expect(requests).toEqual([]);
  expect(await idbGet("profiles", profile.id)).toEqual(before);
});

test("Escape closes the per-server dialog and clears its candidate", async () => {
  const { session, profile, requests } = await setup();
  await renderSessionPage(session, <UnlockOverlay />, "/login");
  await page.getByTestId("unlock-passphrase").fill("unfinished password");
  await userEvent.keyboard("{Escape}");
  await expect
    .poll(() => session.profiles.getSnapshot().unlockProfile)
    .toBeNull();
  expect(session.auth.getSessionSnapshot()?.status).toBe("locked");
  expect(requests).toEqual([]);
  await session.profiles.enterProfile(profile);
  await expect.element(page.getByTestId("unlock-passphrase")).toHaveValue("");
});

test("navigation failure remains visible after a successful unlock closes its dialog", async () => {
  const { session, profile } = await setup();
  const { router } = await renderSessionPage(session, <LoginPage />, "/login");
  vi.spyOn(router, "navigate").mockRejectedValueOnce(
    new Error("Navigation failed after unlocking"),
  );
  await page.getByTestId("unlock-passphrase").fill("server password");
  await page.getByTestId("unlock-submit").click();
  await expect
    .poll(() => session.auth.getSessionSnapshot()?.profile?.id)
    .toBe(profile.id);
  await expect
    .element(page.getByTestId("login-error"))
    .toMatchTextContent("Navigation failed after unlocking");
  expect(session.profiles.getSnapshot().unlockProfile).toBeNull();
});

test.each(["x", " x ", "   "])(
  "an existing password %j survives blur and unlocks without rewriting its ciphertext",
  async (password) => {
    const { session, profile } = await setup();
    const stored = await idbGet<PasswordStoredProfile>("profiles", profile.id);
    expect.assert(stored);
    const original = {
      ...stored,
      apiKey: await encryptProfileKey({
        profileId: stored.id,
        canonicalBaseUrl: stored.baseUrl,
        credentialVersion: stored.credentialVersion,
        apiKey: "isolated-key",
        password,
      }),
    };
    await idbPut("profiles", original);
    await renderSessionPage(session, <UnlockOverlay />, "/login");
    const field = page.getByTestId("unlock-passphrase");
    await field.fill(password);
    await page
      .getByTestId("unlock-dialog")
      .click({ position: { x: 10, y: 10 } });
    await expect.element(field).toHaveValue(password);
    await page.getByTestId("unlock-submit").click();
    await expect
      .poll(() => session.auth.getSessionSnapshot()?.status)
      .toBe("unlocked");
    expect(await idbGet("profiles", profile.id)).toEqual(original);
  },
);

test("legacy migration preserves its raw short old password and trims both new password inputs", async () => {
  const { session, profile } = await setup("password");
  const salt = legacySalt();
  const key = await deriveKeyFromPassword(" x ", salt);
  await idbPut(
    "meta",
    await makeLegacyCanary(key, salt, 310000),
    CANARY_KEY_ID,
  );
  const original = await idbGet<Record<string, unknown>>(
    "profiles",
    profile.id,
  );
  await idbPut("profiles", {
    ...original,
    apiKey: await encryptLegacyKey("isolated-legacy-key", key, "password"),
  });
  const sent: unknown[] = [];
  const migrate = session.auth.migrateProfile.bind(session.auth);
  vi.spyOn(session.auth, "migrateProfile").mockImplementation(
    (input, options) => {
      sent.push(structuredClone(input));
      return migrate(input, options);
    },
  );
  await renderSessionPage(session, <UnlockOverlay />, "/login");
  await page.getByTestId("migration-current-password").fill(" x ");
  await page
    .getByTestId("migration-new-password")
    .fill(" new server password ");
  await page
    .getByTestId("migration-confirm-password")
    .fill("  new server password  ");
  await expect
    .element(page.getByTestId("migration-current-password"))
    .toHaveValue(" x ");
  await expect
    .element(page.getByTestId("migration-new-password"))
    .toHaveValue("new server password");
  page
    .getByTestId("migration-confirm-password")
    .element()
    .closest("form")
    ?.requestSubmit();
  await expect
    .poll(() => session.auth.getSessionSnapshot()?.status)
    .toBe("unlocked");
  expect(sent).toEqual([
    expect.objectContaining({
      password: "new server password",
      legacyPassword: " x ",
    }),
  ]);
});

test("migration checks the trimmed new password length before consuming the old credential", async () => {
  const { session, profile, requests } = await setup("device");
  const before = await idbGet("profiles", profile.id);
  await renderSessionPage(session, <UnlockOverlay />, "/login");
  await page.getByTestId("migration-new-password").fill("  short  ");
  await page.getByTestId("migration-confirm-password").fill("  short  ");
  page
    .getByTestId("migration-confirm-password")
    .element()
    .closest("form")
    ?.requestSubmit();
  await expect
    .element(page.getByTestId("migration-new-password-error"))
    .toMatchTextContent("at least 8");
  await expect
    .element(page.getByTestId("migration-new-password"))
    .toHaveFocus();
  expect(requests).toEqual([]);
  expect(await idbGet("profiles", profile.id)).toEqual(before);
});
