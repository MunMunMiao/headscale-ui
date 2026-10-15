import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { SessionProviders } from "@/AppProviders";
import { setLocale } from "@/i18n";
import { decryptProfileKey } from "@/lib/api-key-crypto";
import type { PasswordStoredProfile } from "@/lib/profile-storage";
import { createApplicationRouter } from "@/router";
import { authenticateTestSession, prepareTestSession, renderSessionPage } from "@/test/session";
import { snapshotFixture } from "@/test-utils/headscale.test";
import { idbGet, idbGetAll } from "@/test-utils/storage";
import SecuritySettings from "./SecuritySettings";

afterEach(() => vi.restoreAllMocks());

test("an aborted reset stays visible after the router locks and unmounts server settings", async () => {
  const snapshot = snapshotFixture();
  const session = await prepareTestSession(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const responses: Record<string, unknown> = {
      "/api/v1/health": snapshot.health,
      "/version": snapshot.version,
      "/api/v1/user": { users: snapshot.users },
      "/api/v1/node": { nodes: snapshot.nodes },
      "/api/v1/preauthkey": { preAuthKeys: snapshot.preAuthKeys },
      "/api/v1/apikey": { apiKeys: snapshot.apiKeys },
      "/api/v1/policy": snapshot.policy,
    };
    return Response.json(responses[new URL(request.url).pathname]);
  });
  await setLocale("en-US");
  await authenticateTestSession(session);
  const before = await idbGetAll("profiles");
  const history = createMemoryHistory({ initialEntries: ["/home"] });
  const router = createApplicationRouter(session, history);
  await render(
    <SessionProviders session={session}>
      <RouterProvider router={router} />
    </SessionProviders>,
  );
  await page.getByTestId("profile-menu-trigger").click();
  await page.getByTestId("open-server-settings").click();
  await page.getByTestId("server-tab-security").click();
  const original = IDBObjectStore.prototype.clear;
  let injected = 0;
  vi.spyOn(IDBObjectStore.prototype, "clear").mockImplementationOnce(function (
    this: IDBObjectStore,
  ) {
    const request = original.call(this);
    request.addEventListener(
      "success",
      () => {
        ++injected;
        request.transaction?.abort();
      },
      { once: true },
    );
    return request;
  });
  const timeOrigin = performance.timeOrigin;
  await page.getByTestId("security-clear-all").click();
  await page.getByTestId("security-clear-all-confirm").click();
  await expect.element(page.getByTestId("profile-option-new")).toBeVisible();
  await expect.poll(() => injected).toBe(1);
  expect(session.auth.getSessionSnapshot()?.status).toBe("locked");
  expect(await idbGetAll("profiles")).toEqual(before);
  expect(performance.timeOrigin).toBe(timeOrigin);
  expect(document.querySelector('[data-testid="security-settings"]')).toBeNull();
  await expect.element(page.getByTestId("login-error")).toMatchTextContent("could not save");
});
async function setup() {
  const session = await prepareTestSession();
  await setLocale("en-US");
  await session.profiles.loadProfile("__new__");
  session.profiles.setConnectionForm({
    profileName: "Saved server",
    baseUrl: "https://fixture.invalid",
    apiKey: "isolated-api-key",
    password: "first password",
  });
  await session.profiles.persistConnection();
  const profile = session.profiles.getSnapshot().profiles[0];
  if (!profile) throw new Error("Missing saved profile");
  return { session, profile };
}
async function fillChange(current = "first password", next = "second password", confirm = next) {
  await page.getByTestId("security-current-passphrase").fill(current);
  await page.getByTestId("security-change-new-passphrase").fill(next);
  await page.getByTestId("security-change-confirm-passphrase").fill(confirm);
}
async function decrypt(row: PasswordStoredProfile, password: string) {
  return decryptProfileKey({
    profileId: row.id,
    canonicalBaseUrl: row.baseUrl,
    credentialVersion: row.credentialVersion,
    secret: row.apiKey,
    password,
  });
}

test("per-server settings offer change and reset without global enable or disable", async () => {
  const { session, profile } = await setup();
  await renderSessionPage(session, <SecuritySettings profile={profile} />, "/settings");
  expect(document.querySelector('[data-testid="security-change-passphrase"]')).not.toBeNull();
  expect(document.querySelector('[data-testid="security-enable-passphrase"]')).toBeNull();
  expect(document.querySelector('[data-testid="security-disable-passphrase"]')).toBeNull();
  await expect
    .element(page.getByText("Change the password for Saved server.", { exact: false }))
    .toBeVisible();
});

test("native crypto rejects a wrong current password once, keeps the new password and only changes this server", async () => {
  const { session, profile } = await setup();
  await session.profiles.loadProfile("__new__");
  session.profiles.setConnectionForm({
    profileName: "Other server",
    baseUrl: "https://other.invalid",
    apiKey: "other-isolated-key",
    password: "other password",
  });
  await session.profiles.persistConnection();
  const other = session.profiles
    .getSnapshot()
    .profiles.find((item) => item.name === "Other server");
  if (!other) throw new Error("Missing second saved profile");
  const before = await idbGet<PasswordStoredProfile>("profiles", profile.id);
  const otherBefore = await idbGet("profiles", other.id);
  await renderSessionPage(session, <SecuritySettings profile={profile} />, "/settings");
  await page.getByTestId("security-change-passphrase").click();
  await fillChange("wrong password");
  await page.getByTestId("security-change-submit").click();
  await expect.element(page.getByTestId("security-error")).toMatchTextContent("Incorrect");
  const current = page.getByTestId("security-current-passphrase");
  await expect.element(current).toHaveValue("");
  await expect.element(current).toHaveFocus();
  await expect.element(current).toHaveAttribute("aria-invalid", "true");
  await expect.element(current).toHaveAccessibleDescription(expect.stringContaining("Incorrect"));
  await expect
    .element(page.getByTestId("security-change-new-passphrase"))
    .toHaveValue("second password");
  await expect
    .element(page.getByTestId("security-change-confirm-passphrase"))
    .toHaveValue("second password");
  // The dialog shows the failure, so the page-level banner does not repeat it.
  expect(session.feedback.getSnapshot().lastError).toBe("");
  expect(await idbGet("profiles", profile.id)).toEqual(before);
  await fillChange();
  await page.getByTestId("security-change-submit").click();
  await expect
    .element(page.getByTestId("security-success"))
    .toMatchTextContent("password was changed");
  const changed = await idbGet<PasswordStoredProfile>("profiles", profile.id);
  if (!changed) throw new Error("Saved profile was removed");
  await expect(decrypt(changed, "first password")).rejects.toThrow();
  expect(await decrypt(changed, "second password")).toBe("isolated-api-key");
  expect(await idbGet("profiles", other.id)).toEqual(otherBefore);
});

test("matching passwords are required and cancel clears the local form", async () => {
  const { session, profile } = await setup();
  const before = await idbGet("profiles", profile.id);
  await renderSessionPage(session, <SecuritySettings profile={profile} />, "/settings");
  await page.getByTestId("security-change-passphrase").click();
  await fillChange("first password", "next password", "different");
  await page.getByTestId("security-change-submit").click();
  await expect.element(page.getByTestId("security-error")).toMatchTextContent("do not match");
  await expect
    .element(page.getByTestId("security-change-confirm-passphrase"))
    .toHaveAttribute("aria-invalid", "true");
  await expect.element(page.getByTestId("security-change-confirm-passphrase")).toHaveFocus();
  await fillChange("first password", "short", "short");
  await page.getByTestId("security-change-submit").click();
  await expect.element(page.getByTestId("security-error")).toMatchTextContent("at least 8");
  await expect
    .element(page.getByTestId("security-change-new-passphrase"))
    .toHaveAttribute("aria-invalid", "true");
  await expect
    .element(page.getByTestId("security-change-confirm-passphrase"))
    .toHaveAttribute("aria-invalid", "false");
  await page.getByTestId("security-current-passphrase").fill("");
  document.querySelector("form")?.requestSubmit();
  await expect
    .element(page.getByTestId("security-error"))
    .toHaveTextContent("Enter the profile password.");
  await expect.element(page.getByTestId("security-current-passphrase")).toHaveFocus();
  expect(await idbGet("profiles", profile.id)).toEqual(before);
  await page.getByTestId("security-change-cancel").click();
  await page.getByTestId("security-change-passphrase").click();
  await expect.element(page.getByTestId("security-current-passphrase")).toHaveValue("");
});

test("a password change that fails after settings closed leaves its error for the remaining page", async () => {
  const { session, profile } = await setup();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "decrypt").mockImplementation(async (...args) => {
    started.resolve();
    await release.promise;
    return decrypt(...args);
  });
  const screen = await renderSessionPage(
    session,
    <SecuritySettings profile={profile} />,
    "/settings",
  );
  await page.getByTestId("security-change-passphrase").click();
  await fillChange("wrong password");
  await page.getByTestId("security-change-submit").click();
  await started.promise;
  await screen.unmount();
  release.resolve();
  await expect.poll(() => session.feedback.getSnapshot().lastError).toContain("Incorrect");
});

test("no visible current profile exposes only shared-session information and reset", async () => {
  const { session } = await setup();
  await renderSessionPage(session, <SecuritySettings />, "/settings");
  expect(document.querySelector('[data-testid="security-change-passphrase"]')).toBeNull();
  await expect.element(page.getByTestId("security-clear-all")).toBeVisible();
  await expect
    .element(page.getByText("Tabs in this browser share", { exact: false }))
    .toBeVisible();
});

test("confirmed clear removes native records through the shared session and reloads login", async () => {
  const { session, profile } = await setup();
  const reloadPage = vi.fn();
  await renderSessionPage(
    session,
    <SecuritySettings profile={profile} reloadPage={reloadPage} />,
    "/settings",
  );
  await expect
    .element(page.getByText("To remove only one, log out", { exact: false }))
    .toBeVisible();
  await page.getByTestId("security-clear-all").click();
  expect(document.querySelector("[data-slot=alert-dialog-title]")?.textContent).toBe(
    "Clear all encrypted data?",
  );
  expect(document.querySelector("[data-slot=alert-dialog-description]")?.textContent).toContain(
    "locks the shared session",
  );
  await page.getByTestId("security-clear-all-cancel").click();
  expect(await idbGet("profiles", profile.id)).toBeDefined();
  await page.getByTestId("security-clear-all").click();
  await page.getByTestId("security-clear-all-confirm").click();
  await expect.poll(() => reloadPage.mock.calls.length).toBe(1);
  await expect.poll(() => session.auth.getSessionSnapshot()?.status).toBe("locked");
  expect(await idbGetAll("profiles")).toEqual([]);
  expect(reloadPage).toHaveBeenCalledWith("/login");
});

test("a failed clear preserves stored rows and permits an explicitly confirmed retry", async () => {
  const { session, profile } = await setup();
  const before = await idbGet("profiles", profile.id);
  const reloadPage = vi.fn();
  await renderSessionPage(
    session,
    <SecuritySettings profile={profile} reloadPage={reloadPage} />,
    "/settings",
  );
  const clear = vi.spyOn(IDBObjectStore.prototype, "clear").mockImplementationOnce(() => {
    throw new DOMException("quota", "QuotaExceededError");
  });
  await page.getByTestId("security-clear-all").click();
  await page.getByTestId("security-clear-all-confirm").click();
  await expect.element(page.getByTestId("security-error")).toMatchTextContent("could not save");
  expect(await idbGet("profiles", profile.id)).toEqual(before);
  expect(session.auth.getSessionSnapshot()?.status).toBe("locked");
  expect(reloadPage).not.toHaveBeenCalled();
  clear.mockRestore();
  await page.getByTestId("security-clear-all").click();
  await page.getByTestId("security-clear-all-confirm").click();
  await expect.poll(() => reloadPage.mock.calls.length).toBe(1);
});

test.each(["zh-Hans", "ar"] as const)(
  "partial reset in %s reports committed data removal without reload",
  async (locale) => {
    const { session, profile } = await setup();
    await setLocale(locale);
    sessionStorage.setItem("headscale-ui-tail", "tail");
    const reloadPage = vi.fn();
    await renderSessionPage(
      session,
      <SecuritySettings profile={profile} reloadPage={reloadPage} />,
      "/settings",
    );
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    await page.getByTestId("security-clear-all").click();
    await page.getByTestId("security-clear-all-confirm").click();
    await expect
      .element(page.getByTestId("security-error"))
      .toMatchTextContent(locale === "ar" ? "تم مسح البيانات المحفوظة" : "已清除保存的数据");
    expect(await idbGetAll("profiles")).toEqual([]);
    expect(reloadPage).not.toHaveBeenCalled();
  },
);

test("duplicate native submissions keep one password change in flight and clear secrets before encryption finishes", async () => {
  const { session, profile } = await setup();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  let encryptions = 0;
  vi.spyOn(crypto.subtle, "encrypt").mockImplementation(async (...args) => {
    ++encryptions;
    started.resolve();
    await release.promise;
    return encrypt(...args);
  });
  await renderSessionPage(session, <SecuritySettings profile={profile} />, "/settings");
  await page.getByTestId("security-change-passphrase").click();
  await fillChange();
  const form = document
    .querySelector<HTMLFormElement>('[data-testid="security-current-passphrase"]')
    ?.closest("form");
  if (!form) throw new Error("Missing change-password form");
  form.requestSubmit();
  form.requestSubmit();
  await started.promise;
  await expect.element(page.getByTestId("security-current-passphrase")).toHaveValue("");
  await expect.element(page.getByTestId("security-change-submit")).toBeDisabled();
  await expect.element(page.getByTestId("security-clear-all")).toBeDisabled();
  release.resolve();
  await expect.element(page.getByTestId("security-success")).toBeVisible();
  expect(encryptions).toBe(1);
});

test("focus follows the change-password form: field on open, trigger on cancel and success", async () => {
  const { session, profile } = await setup();
  await renderSessionPage(session, <SecuritySettings profile={profile} />, "/settings");
  await page.getByTestId("security-change-passphrase").click();
  await expect.element(page.getByTestId("security-current-passphrase")).toHaveFocus();
  await page.getByTestId("security-change-cancel").click();
  await expect.element(page.getByTestId("security-change-passphrase")).toHaveFocus();
  await page.getByTestId("security-change-passphrase").click();
  await fillChange("wrong password");
  await page.getByTestId("security-change-submit").click();
  await expect.element(page.getByTestId("security-error")).toBeVisible();
  // A failed change keeps the form mounted and does not hand focus to the (absent) trigger.
  expect(document.querySelector("form")).not.toBeNull();
  expect(document.querySelector('[data-testid="security-change-passphrase"]')).toBeNull();
  await fillChange();
  await page.getByTestId("security-change-submit").click();
  await expect.element(page.getByTestId("security-success")).toBeVisible();
  await expect.element(page.getByTestId("security-change-passphrase")).toHaveFocus();
});
