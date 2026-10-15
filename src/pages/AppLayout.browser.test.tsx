import type { FetchHandle } from "@defjs/core";
import { createBrowserHistory } from "@tanstack/react-router";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { HeadscaleSnapshot } from "@/api/contracts";
import { setLocale } from "@/i18n";
import * as localeRuntime from "@/i18n/runtime";
import * as settings from "@/lib/settings-storage";
import { captureSettingsWriteEpoch } from "@/lib/settings-storage";
import { notifyVaultChanged } from "@/lib/vault-state";
import { authenticateTestSession, prepareTestSession, renderSessionPage } from "@/test/session";
import AppLayout from "./AppLayout";

vi.mock("@/i18n/runtime", { spy: true });
vi.mock("@/lib/settings-storage", { spy: true });

const id = (name: string) => page.getByTestId(name);
afterEach(() => vi.restoreAllMocks());
interface SetupOptions {
  apiKeys?: HeadscaleSnapshot["apiKeys"];
  apiKey?: string;
  version?: string;
  failures?: Record<string, string>;
  waitReady?: boolean;
  backfillResponse?: unknown;
}
async function setup(authorized = true, options: SetupOptions = {}) {
  const snapshot: HeadscaleSnapshot = {
    health: { databaseConnectivity: true, serverReachable: true },
    version: { version: options.version ?? "0.29.4" },
    users: [],
    nodes: [],
    preAuthKeys: [],
    policy: { policy: '{"acls":[]}' },
    apiKeys: options.apiKeys ?? [{ id: "1", prefix: "server-key" }],
  };
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let error = "";
  let hold: Promise<void> | undefined;
  const refreshFailures = new Map<string, string>();
  const transport: FetchHandle = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const path = new URL(req.url).pathname;
    const raw = req.method === "GET" || req.method === "DELETE" ? "" : await req.text();
    calls.push({ method: req.method, path, body: raw ? JSON.parse(raw) : null });
    if (req.method !== "GET") {
      if (hold) await hold;
      if (error) return Response.json({ message: error }, { status: 500 });
      if (path === "/api/v1/apikey") return Response.json({ apiKey: "new-secret" });
      if (path.endsWith("backfillips"))
        return Response.json(options.backfillResponse ?? { changes: ["node 1 updated"] });
      return Response.json({});
    }
    const refreshError = refreshFailures.get(path);
    if (refreshError) return Response.json({ message: refreshError }, { status: 500 });
    const values: Record<string, unknown> = {
      "/api/v1/health": snapshot.health,
      "/version": snapshot.version,
      "/api/v1/user": { users: [] },
      "/api/v1/node": { nodes: [] },
      "/api/v1/preauthkey": { preAuthKeys: [] },
      "/api/v1/policy": snapshot.policy,
      "/api/v1/apikey": { apiKeys: snapshot.apiKeys },
    };
    return Response.json(values[path]);
  };
  const session = await prepareTestSession(transport);
  await setLocale("en-US");
  if (authorized) await authenticateTestSession(session, undefined, options.apiKey);
  // Signing in reads the server, so faults start once the session exists.
  for (const [path, message] of Object.entries(options.failures ?? {}))
    refreshFailures.set(path, message);
  const screen = await renderSessionPage(session, <AppLayout />, "/home");
  if (authorized && options.waitReady !== false) {
    await expect
      .poll(() => session.snapshot.getSnapshot().snapshot.health?.serverReachable)
      .toBe(true);
    await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
  }
  calls.length = 0;
  return {
    ...screen,
    session,
    calls,
    refreshFailures,
    fail: (message: string) => {
      error = message;
    },
    hold: (promise: Promise<void> | undefined) => {
      hold = promise;
    },
  };
}
function expirationOf(call: { body: unknown } | undefined) {
  const body = call?.body;
  expect.assert(typeof body === "object" && body !== null && "expiration" in body);
  return String(body.expiration);
}
function expectAboutDaysFromNow(value: unknown, days: number, toleranceMinutes = 2) {
  const delta = Date.parse(String(value)) - (Date.now() + days * 86_400_000);
  expect(Math.abs(delta)).toBeLessThanOrEqual(toleranceMinutes * 60_000);
}
async function pickCalendarDay(year: number, day: string) {
  await id("api-key-expiration").click();
  await page.getByRole("combobox", { name: "Choose the Year" }).selectOptions(String(year));
  const cell = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-slot="calendar-cell-trigger"]'),
  ).find((el) => el.textContent?.trim() === day && !el.closest('[data-outside="true"]'));
  if (!cell) throw new Error(`Day ${day} is missing`);
  cell.click();
  await userEvent.keyboard("{Escape}");
}
async function apiKeyPosts(screen: Awaited<ReturnType<typeof setup>>) {
  return screen.calls.filter((call) => call.method === "POST" && call.path === "/api/v1/apikey");
}
async function openSettings() {
  await id("profile-menu-trigger").click();
  await id("open-server-settings").click();
}

test("switching the shared session holds old server drafts and discards their generated credentials", async () => {
  const { session, router } = await setup();
  await openSettings();
  await id("create-api-key-confirm").click();
  await expect.element(id("created-api-key")).toMatchTextContent("new-secret");
  await authenticateTestSession(session, "https://second-fixture.invalid");
  await expect.element(id("created-api-key")).not.toBeInTheDocument();
  await expect.element(id("stale-session-draft-dialog")).toBeVisible();
  // The fixture uses memory history; exercise its registered blocker with the browser adapter.
  const blocker = router.history._getBlockers()[0];
  expect.assert(blocker);
  const browserHistory = createBrowserHistory();
  const stopBlocker = browserHistory.block(blocker);
  try {
    const heldExit = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(heldExit);
    expect(heldExit.defaultPrevented).toBe(true);
    await id("discard-stale-session-draft").click();
    await expect.element(id("server-settings-dialog")).not.toBeInTheDocument();
    const releasedExit = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(releasedExit);
    expect(releasedExit.defaultPrevented).toBe(false);
  } finally {
    stopBlocker();
    browserHistory.destroy();
  }
  await openSettings();
  await expect.element(id("created-api-key")).not.toBeInTheDocument();
});

test("hides authenticated content until restoration completes", async () => {
  const { session } = await setup(false);
  await expect.element(id("session-loading")).toBeVisible();
  await expect.element(id("app-header")).not.toBeInTheDocument();
  await authenticateTestSession(session);
  await expect.element(id("app-header")).toBeVisible();
});

test("shows refresh segment errors in a fixed order and keeps action errors separate", async () => {
  const { session, refreshFailures } = await setup();
  session.feedback.setState({ lastError: "Action failure" });
  refreshFailures.set("/api/v1/node", "Fabric refresh failure");
  refreshFailures.set("/api/v1/user", "Identity refresh failure");
  refreshFailures.set("/api/v1/policy", "Policy refresh failure");
  await session.snapshot.refreshSegments(["policy", "identity", "fabric"]);
  await expect.element(id("refresh-error-fabric")).toHaveTextContent("Fabric refresh failure");
  expect(
    Array.from(document.querySelectorAll('[data-testid^="refresh-error-"]')).map((element) =>
      element.getAttribute("data-testid"),
    ),
  ).toEqual(["refresh-error-fabric", "refresh-error-identity", "refresh-error-policy"]);
  await expect.element(id("action-error")).toHaveTextContent("Action failure");
  refreshFailures.delete("/api/v1/user");
  await session.snapshot.refreshSegments(["identity"]);
  await expect.element(id("refresh-error-identity")).not.toBeInTheDocument();
  await expect.element(id("refresh-error-fabric")).toBeVisible();
  await expect.element(id("refresh-error-policy")).toBeVisible();
  await expect.element(id("action-error")).toHaveTextContent("Action failure");
});

test("shows language loading failures and theme persistence failures without hiding the page", async () => {
  await setup();
  let rejectLoad!: (error: Error) => void;
  vi.mocked(localeRuntime.loadLocale).mockImplementationOnce(
    () =>
      new Promise<void>((_, reject) => {
        rejectLoad = reject;
      }),
  );
  await id("profile-menu-trigger").click();
  await id("language-menu-trigger").hover();
  await id("locale-option-ar").click();
  try {
    await expect.element(id("locale-pending")).toMatchTextContent("Changing language");
  } finally {
    rejectLoad(new Error("catalog unavailable"));
  }
  await expect.element(id("locale-error")).toMatchTextContent("The language could not be loaded");
  await expect.element(id("app-header")).toBeVisible();
  expect(document.documentElement.lang).toBe("en-US");
  vi.mocked(settings.writeSetting).mockRejectedValueOnce(new Error("storage unavailable"));
  await id("profile-menu-trigger").click();
  await id("theme-menu-trigger").hover();
  await id("theme-option-dark").click();
  await expect.element(id("theme-error")).toMatchTextContent("The theme changed");
  expect(document.documentElement.classList.contains("dark")).toBe(true);
});
test("navigates sections and supports theme, language, and logout menu actions", async () => {
  const { router, session } = await setup();
  await id("profile-menu-trigger").click();
  await id("theme-menu-trigger").hover();
  await id("theme-option-dark").click();
  expect(session.theme.getSnapshot().colorMode).toBe("dark");
  await id("profile-menu-trigger").click();
  await id("language-menu-trigger").hover();
  await id("locale-option-ar").click();
  await expect.poll(() => document.documentElement.dir).toBe("rtl");
  await expect.element(id("header-navigation")).toHaveAttribute("dir", "rtl");
  await id("section-devices").click();
  expect(router.state.location.pathname).toBe("/devices");
});
test("creates, copies, expires and deletes API keys with visible retryable errors", async () => {
  const screen = await setup();
  const clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await openSettings();
  screen.fail("write rejected");
  await id("create-api-key-confirm").click();
  await expect.element(id("api-key-create-error")).toHaveTextContent("write rejected");
  screen.fail("");
  await id("create-api-key-confirm").click();
  await expect.element(id("created-api-key")).toMatchTextContent("new-secret");
  await id("copy-created-api-key").click();
  expect(clipboard).toHaveBeenCalledWith("new-secret");
  expectAboutDaysFromNow(expirationOf((await apiKeyPosts(screen))[0]), 90);
  for (const action of ["expire", "delete"]) {
    await id("api-key-actions-trigger-server-key").click();
    await id(`${action}-api-key-server-key`).click();
    await id("confirm-api-key-action").click();
    await expect.element(id(`${action}-api-key-dialog`)).not.toBeInTheDocument();
  }
  expect(screen.calls.some((call) => call.method === "DELETE")).toBe(true);
});
test("an API key the server listed without a prefix cannot be expired or deleted", async () => {
  const screen = await setup(true, { apiKeys: [{ id: "7", prefix: "" }] });
  await openSettings();
  for (const action of ["expire", "delete"]) {
    await id("api-key-actions-trigger-").click();
    await id(`${action}-api-key-`).click();
    await expect.element(id("confirm-api-key-action")).toBeDisabled();
    await id("cancel-api-key-action").click();
    await expect.element(id(`${action}-api-key-dialog`)).not.toBeInTheDocument();
  }
  expect(screen.calls.filter((call) => call.method !== "GET")).toEqual([]);
});
test("requires explicit maintenance confirmation and keeps failed maintenance retryable", async () => {
  const screen = await setup();
  await openSettings();
  await id("server-tab-maintenance").click();
  await id("open-backfill-node-ips").click();
  await expect.element(id("confirm-backfill-node-ips")).toBeDisabled();
  await id("backfill-node-ips-confirmed").click();
  screen.fail("maintenance failed");
  await id("confirm-backfill-node-ips").click();
  await expect.element(id("backfill-node-ips-error")).toHaveTextContent("maintenance failed");
  screen.fail("");
  await id("confirm-backfill-node-ips").click();
  await expect.element(id("backfill-node-ips-dialog")).not.toBeInTheDocument();
  await expect.element(id("backfill-node-ips-result")).toMatchTextContent("node 1 updated");
});

test("opens submenus by click and logs out the active session", async () => {
  const { router, session } = await setup();
  await id("profile-menu-trigger").click();
  await id("theme-menu-trigger").click();
  await id("theme-option-light").click();
  expect(session.theme.getSnapshot().colorMode).toBe("light");
  await id("profile-menu-trigger").click();
  await id("language-menu-trigger").click();
  await id("locale-option-en-US").click();
  await id("profile-menu-trigger").click();
  await id("logout").click();
  await expect.poll(() => router.state.location.pathname).toBe("/login");
  // The lock is confirmed through the Worker and can land after the navigation.
  await expect.poll(() => session.snapshot.getSnapshot().isAuthorized).toBe(false);
});

test("keyboard users can close a submenu and continue through the parent menu", async () => {
  await setup();
  await id("profile-menu-trigger").click();
  await expect.element(id("profile-menu")).toBeVisible();
  await expect.element(id("profile-menu")).toHaveFocus();
  await userEvent.keyboard("{Home}");
  await expect.element(id("language-menu-trigger")).toHaveFocus();
  await userEvent.keyboard("{ArrowRight}");
  // Keys go to the menu holding focus, and a submenu takes it a frame after it appears.
  await expect.element(id("locale-option-en-US")).toHaveFocus();
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(id("locale-option-en-US")).not.toBeInTheDocument();
  await expect.element(id("profile-menu")).toBeVisible();
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(id("theme-menu-trigger")).toHaveFocus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(id("theme-option-dark")).toBeVisible();
});

test.each([
  { menu: "theme", viewportName: "mobile", width: 360, height: 568, direction: "ltr" },
  { menu: "language", viewportName: "mobile", width: 360, height: 568, direction: "ltr" },
  { menu: "theme", viewportName: "desktop", width: 1366, height: 768, direction: "ltr" },
  { menu: "language", viewportName: "desktop", width: 1366, height: 768, direction: "ltr" },
  { menu: "theme", viewportName: "mobile", width: 360, height: 568, direction: "rtl" },
  { menu: "language", viewportName: "mobile", width: 360, height: 568, direction: "rtl" },
  { menu: "theme", viewportName: "desktop", width: 1366, height: 768, direction: "rtl" },
  { menu: "language", viewportName: "desktop", width: 1366, height: 768, direction: "rtl" },
])(
  "keeps the $menu submenu beside its parent on a tall $direction $viewportName page",
  async ({ menu, width, height, viewportName, direction }) => {
    await page.viewport(width, height);
    const content = document.createElement("div");
    content.style.height = "1200px";
    try {
      await setup();
      await setLocale(direction === "rtl" ? "ar" : "en-US");
      document.body.append(content);
      window.scrollTo(0, 0);
      await id("profile-menu-trigger").click();
      await expect.element(id("profile-menu")).toHaveFocus();
      expect(window.scrollY).toBe(0);
      await id(`${menu}-menu-trigger`).click();
      const option = id(menu === "theme" ? "theme-option-light" : "locale-option-en-US");
      await expect.element(option).toBeVisible();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      await Promise.all(
        document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
      );
      expect(window.scrollY).toBe(0);
      await expect.element(option).toBeVisible();
      const trigger = document.querySelector<HTMLElement>(`[data-testid="${menu}-menu-trigger"]`);
      const popup = document.querySelector<HTMLElement>(
        '[data-slot="dropdown-menu-sub-content"][data-open]',
      );
      if (!trigger || !popup) throw new Error("Submenu must remain mounted and open");
      const parentBounds = trigger.getBoundingClientRect();
      const popupBounds = popup.getBoundingClientRect();
      expect(Math.abs(popupBounds.top - parentBounds.top)).toBeLessThanOrEqual(1);
      expect(popupBounds.left).toBeGreaterThanOrEqual(0);
      expect(popupBounds.right).toBeLessThanOrEqual(width);
      if (viewportName === "mobile") {
        expect(
          direction === "rtl" ? width - popupBounds.right : popupBounds.left,
        ).toBeLessThanOrEqual(1);
      } else {
        // The submenu sits beside the profile menu instead of covering its edge.
        const menu = document
          .querySelector('[data-testid="profile-menu"]')
          ?.getBoundingClientRect();
        expect.assert(menu);
        if (direction === "rtl") expect(popupBounds.left).toBeGreaterThanOrEqual(menu.right);
        else expect(popupBounds.right).toBeLessThanOrEqual(menu.left);
      }
      await option.click();
      await expect.element(id("profile-menu")).not.toBeInTheDocument();
    } finally {
      content.remove();
      window.scrollTo(0, 0);
      await page.viewport(1280, 720);
    }
  },
);

test("keeps pending server writes open and clears secret results when the settings close", async () => {
  const screen = await setup();
  await openSettings();
  await id("api-key-expiration").click();
  await id("api-key-expiration-minute").selectOptions("58");
  await userEvent.keyboard("{Escape}");
  const create = Promise.withResolvers<void>();
  screen.hold(create.promise);
  await id("create-api-key-confirm").click();
  await userEvent.keyboard("{Escape}");
  await expect.element(id("server-settings-dialog")).toBeVisible();
  await expect.element(id("create-api-key-confirm")).toBeDisabled();
  create.resolve();
  await expect.element(id("created-api-key")).toMatchTextContent("new-secret");
  const expiration = expirationOf(screen.calls.find((call) => call.method === "POST"));
  expect(new Date(expiration).getMinutes()).toBe(58);
  expectAboutDaysFromNow(expiration, 90, 1440);
  await id("server-settings-dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect.element(id("server-settings-dialog")).not.toBeInTheDocument();
  await openSettings();
  await expect.element(id("created-api-key")).not.toBeInTheDocument();
  await id("api-key-actions-trigger-server-key").click();
  await id("delete-api-key-server-key").click();
  await id("cancel-api-key-action").click();
  expect(screen.calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
  await id("api-key-actions-trigger-server-key").click();
  await id("delete-api-key-server-key").click();
  const remove = Promise.withResolvers<void>();
  screen.hold(remove.promise);
  await id("confirm-api-key-action").click();
  await userEvent.keyboard("{Escape}");
  await expect.element(id("delete-api-key-dialog")).toBeVisible();
  remove.resolve();
  await expect.element(id("delete-api-key-dialog")).not.toBeInTheDocument();
  await id("server-tab-security").click();
  await expect.element(id("security-change-passphrase")).toBeVisible();
});

test("cancels maintenance without a write and prevents dismissal while maintenance is pending", async () => {
  const screen = await setup();
  await openSettings();
  await id("server-tab-maintenance").click();
  await id("open-backfill-node-ips").click();
  await id("cancel-backfill-node-ips").click();
  expect(screen.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  await id("open-backfill-node-ips").click();
  await id("backfill-node-ips-confirmed").click();
  const write = Promise.withResolvers<void>();
  screen.hold(write.promise);
  await id("confirm-backfill-node-ips").click();
  await userEvent.keyboard("{Escape}");
  await expect.element(id("backfill-node-ips-dialog")).toBeVisible();
  write.resolve();
  await expect.element(id("backfill-node-ips-dialog")).not.toBeInTheDocument();
  await expect.element(id("backfill-node-ips-result")).toMatchTextContent("node 1 updated");
});

// Catches a past expiration reaching the server and the 90-day default being remembered.
test("rejects a past API key expiration without a request and recomputes the default on reopen", async () => {
  const screen = await setup();
  await openSettings();
  await pickCalendarDay(new Date().getFullYear() - 1, "1");
  await id("create-api-key-confirm").click();
  await expect
    .element(id("api-key-expiration-error"))
    .toHaveTextContent("Choose an expiration in the future.");
  await expect.element(id("api-key-expiration")).toHaveAttribute("aria-invalid", "true");
  await expect
    .element(id("api-key-expiration"))
    .toHaveAttribute("aria-describedby", "api-key-expiration-value api-key-expiration-error");
  expect(await apiKeyPosts(screen)).toHaveLength(0);

  await pickCalendarDay(new Date().getFullYear() + 1, "15");
  await expect.element(id("api-key-expiration-error")).not.toBeInTheDocument();
  await id("create-api-key-confirm").click();
  await expect.element(id("created-api-key")).toMatchTextContent("new-secret");
  const [posted] = await apiKeyPosts(screen);
  expect(new Date(expirationOf(posted)).getFullYear()).toBe(new Date().getFullYear() + 1);

  await id("server-settings-dialog").getByRole("button", { name: "Close", exact: true }).click();
  await openSettings();
  await id("create-api-key-confirm").click();
  await expect.element(id("created-api-key")).toMatchTextContent("new-secret");
  const posts = await apiKeyPosts(screen);
  expect(posts).toHaveLength(2);
  expectAboutDaysFromNow(expirationOf(posts[1]), 90);
});

const CURRENT_KEY = `hskey-api-AAAAAAAAAAAA-${"s".repeat(64)}`;
const CURRENT_PREFIX = "hskey-api-AAAAAAAAAAAA-***";
const writes = (screen: Awaited<ReturnType<typeof setup>>) =>
  screen.calls.filter((call) => call.method !== "GET");

test("the initial snapshot gate can log out instead of retrying", async () => {
  const screen = await setup(true, {
    failures: { "/api/v1/node": "Node list unavailable" },
    waitReady: false,
  });
  await expect.element(id("initial-snapshot-error")).toHaveTextContent("Node list unavailable");
  await expect.element(id("retry-initial-snapshot")).toBeVisible();
  await expect.element(id("app-header")).not.toBeInTheDocument();
  await id("retry-initial-snapshot").click();
  await expect.element(id("initial-snapshot-error")).toHaveTextContent("Node list unavailable");
  await id("initial-snapshot-logout").click();
  await expect.poll(() => screen.router.state.location.pathname).toBe("/login");
  await expect.poll(() => screen.session.snapshot.getSnapshot().isAuthorized).toBe(false);
  screen.calls.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(screen.calls).toHaveLength(0);
  await expect.element(id("app-header")).not.toBeInTheDocument();
});

test("API key rows show an Active or Expired status badge", async () => {
  await setup(true, {
    apiKeys: [
      { id: "1", prefix: "old-key", expiration: "2000-01-01T00:00:00Z" },
      { id: "2", prefix: "new-key", expiration: "2999-01-01T00:00:00Z" },
    ],
  });
  await openSettings();
  await expect.element(id("api-key-status-old-key")).toHaveTextContent("Expired");
  await expect.element(id("api-key-status-old-key")).toHaveClass("text-rose-700");
  await expect.element(id("api-key-status-new-key")).toHaveTextContent("Active");
  await expect.element(id("api-key-status-new-key")).toHaveClass("text-emerald-700");
  await expect.element(page.getByRole("table", { name: "API keys" })).toBeInTheDocument();
});

test.each([
  { kind: "expire", method: "POST", apiKey: CURRENT_KEY, prefix: CURRENT_PREFIX },
  { kind: "delete", method: "DELETE", apiKey: CURRENT_KEY, prefix: CURRENT_PREFIX },
  { kind: "expire", method: "POST", apiKey: `legacy1.${"x".repeat(40)}`, prefix: "legacy1***" },
  { kind: "delete", method: "DELETE", apiKey: `legacy1.${"x".repeat(40)}`, prefix: "legacy1***" },
])(
  "the key used by this session needs an acknowledgement before $kind ($prefix)",
  async ({ kind, method, apiKey, prefix }) => {
    const screen = await setup(true, {
      apiKey,
      apiKeys: [
        { id: "1", prefix },
        { id: "2", prefix: "server-key" },
      ],
    });
    await openSettings();
    await expect.element(id(`api-key-current-${prefix}`)).toHaveTextContent("Used by this session");
    await expect.element(id("api-key-current-server-key")).not.toBeInTheDocument();
    await id(`api-key-actions-trigger-${prefix}`).click();
    await id(`${kind}-api-key-${prefix}`).click();
    await expect.element(id("api-key-current-warning")).toBeVisible();
    await expect.element(id("api-key-current-warning")).toHaveAttribute("role", "note");
    await expect.element(id("confirm-api-key-action")).toBeDisabled();
    expect(writes(screen)).toHaveLength(0);
    await id("api-key-current-ack").click();
    await expect.element(id("confirm-api-key-action")).toBeEnabled();
    // Cancelling forgets the acknowledgement.
    await id("cancel-api-key-action").click();
    await id(`api-key-actions-trigger-${prefix}`).click();
    await id(`${kind}-api-key-${prefix}`).click();
    await expect.element(id("api-key-current-ack")).toHaveAttribute("aria-checked", "false");
    await expect.element(id("confirm-api-key-action")).toBeDisabled();
    await id("api-key-current-ack").click();
    await id("confirm-api-key-action").click();
    await expect.element(id(`${kind}-api-key-dialog`)).not.toBeInTheDocument();
    expect(writes(screen).map((call) => call.method)).toEqual([method]);
  },
);

test("keys other than the current one and unparseable session keys are not protected", async () => {
  const screen = await setup(true, {
    apiKey: "not-a-listed-key-format",
    apiKeys: [{ id: "1", prefix: "server-key" }],
  });
  await openSettings();
  await expect.element(id("api-key-row-server-key")).toBeVisible();
  await expect.element(id("api-key-current-server-key")).not.toBeInTheDocument();
  await id("api-key-actions-trigger-server-key").click();
  await id("expire-api-key-server-key").click();
  await expect.element(id("api-key-current-warning")).not.toBeInTheDocument();
  await expect.element(id("api-key-current-ack")).not.toBeInTheDocument();
  await expect.element(id("confirm-api-key-action")).toBeEnabled();
  await id("confirm-api-key-action").click();
  await expect.element(id("expire-api-key-dialog")).not.toBeInTheDocument();
  expect(writes(screen)).toHaveLength(1);
});

test("the current-key protection renders in a right-to-left locale", async () => {
  await setup(true, {
    apiKey: CURRENT_KEY,
    apiKeys: [{ id: "1", prefix: CURRENT_PREFIX }],
  });
  await setLocale("ar");
  await openSettings();
  await expect.element(id(`api-key-current-${CURRENT_PREFIX}`)).toBeVisible();
  await id(`api-key-actions-trigger-${CURRENT_PREFIX}`).click();
  await id(`delete-api-key-${CURRENT_PREFIX}`).click();
  await expect.element(id("api-key-current-warning")).toBeVisible();
  await expect.element(id("confirm-api-key-action")).toBeDisabled();
});

test("a failed action error is cleared when the route changes, not on the first mount or a search change", async () => {
  const { session, router } = await setup();
  session.feedback.setState({ lastError: "Old failure" });
  await expect.element(id("action-error")).toHaveTextContent("Old failure");
  await router.navigate({ to: "/home", search: { q: "1" } as never });
  await expect.element(id("action-error")).toHaveTextContent("Old failure");
  await id("section-invites").click();
  await expect.poll(() => router.state.location.pathname).toBe("/invites");
  await expect.element(id("action-error")).not.toBeInTheDocument();
});

test("a failing API key action leaves no error behind after cancelling", async () => {
  const screen = await setup();
  await openSettings();
  await id("api-key-actions-trigger-server-key").click();
  await id("delete-api-key-server-key").click();
  screen.fail("delete rejected");
  await id("confirm-api-key-action").click();
  await expect.element(id("api-key-action-error")).toHaveTextContent("delete rejected");
  await id("cancel-api-key-action").click();
  await expect.element(id("action-error")).not.toBeInTheDocument();
});

test("a rejected clipboard write on the created API key says Copy failed", async () => {
  await setup();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
  await openSettings();
  await id("create-api-key-confirm").click();
  await expect.element(id("created-api-key")).toMatchTextContent("new-secret");
  await id("copy-created-api-key").click();
  await expect.element(id("copy-created-api-key")).toMatchTextContent("Copy failed");
});

test("the created API key block takes focus and is a labelled group", async () => {
  await setup();
  await openSettings();
  await id("create-api-key-confirm").click();
  await expect
    .element(page.getByRole("group", { name: "Created API key" }))
    .toHaveAttribute("data-testid", "created-api-key");
  await expect.element(id("created-api-key")).toHaveFocus();
  const group = document.querySelector<HTMLElement>('[data-testid="created-api-key"]');
  expect(document.getElementById(group?.getAttribute("aria-labelledby") ?? "")).not.toBeNull();
  expect(document.getElementById(group?.getAttribute("aria-describedby") ?? "")).not.toBeNull();
});

test("the backfill result takes focus when its dialog closes", async () => {
  await setup();
  await openSettings();
  await id("server-tab-maintenance").click();
  await id("open-backfill-node-ips").click();
  await id("backfill-node-ips-confirmed").click();
  await id("confirm-backfill-node-ips").click();
  await expect.element(id("backfill-node-ips-dialog")).not.toBeInTheDocument();
  await expect.element(id("backfill-node-ips-result")).toHaveFocus();
});

test.each([
  { version: "0.28.5", shown: true },
  { version: "v0.30.0", shown: true },
  { version: "0.29.4", shown: false },
  { version: "dev", shown: false },
])(
  "the unsupported-server-version notice for $version shows: $shown",
  async ({ version, shown }) => {
    await setup(true, { version });
    if (shown) {
      await expect.element(id("server-version-warning")).toHaveAttribute("role", "status");
      await expect.element(id("server-version-warning")).toMatchTextContent(version);
    } else {
      await expect.element(id("server-version-warning")).not.toBeInTheDocument();
    }
  },
);

test("there is no version notice when the server version cannot be read", async () => {
  await setup(true, { failures: { "/version": "version unavailable" } });
  await expect.element(id("page-body")).toBeVisible();
  await expect.element(id("server-version-warning")).not.toBeInTheDocument();
});

test("the unsupported-server-version notice also shows on the loading screen", async () => {
  await setup(true, {
    version: "0.28.5",
    failures: { "/api/v1/policy": "Policy unavailable" },
    waitReady: false,
  });
  await expect.element(id("session-loading")).toBeVisible();
  await expect.element(id("initial-snapshot-error")).toBeVisible();
  await expect.element(id("server-version-warning")).toMatchTextContent("0.28.5");
});

test("the page has one banner, one main, and a named navigation of links", async () => {
  const { router } = await setup();
  expect(page.getByRole("banner").elements()).toHaveLength(1);
  expect(page.getByRole("main").elements()).toHaveLength(1);
  expect(document.querySelectorAll("main")).toHaveLength(1);
  expect(document.querySelector("main header")).toBeNull();
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await expect.element(nav).toHaveAttribute("data-testid", "header-navigation");
  expect(nav.getByRole("link").elements()).toHaveLength(6);
  expect(document.querySelectorAll('[data-testid="app-header"] [role="tab"]')).toHaveLength(0);
  await expect.element(id("section-home")).toHaveAttribute("aria-current", "page");
  await expect.element(id("section-devices")).not.toHaveAttribute("aria-current");
  await id("section-devices").click();
  await expect.poll(() => router.state.location.pathname).toBe("/devices");
});

test("the loading screen is the single main landmark", async () => {
  await setup(false);
  expect(page.getByRole("main").elements()).toHaveLength(1);
  await expect.element(id("session-loading")).toHaveAttribute("data-testid", "session-loading");
  expect(document.querySelector("main")?.getAttribute("data-testid")).toBe("session-loading");
});

test("a navigation link click is still held by the stale-draft blocker", async () => {
  const { session, router } = await setup();
  await openSettings();
  await authenticateTestSession(session, "https://second-fixture.invalid");
  await expect.element(id("stale-session-draft-dialog")).toBeVisible();
  document.querySelector<HTMLElement>('[data-testid="section-invites"]')?.click();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(router.state.location.pathname).toBe("/home");
});

test("theme and language are radio items with exactly one checked entry that moves", async () => {
  await setup();
  const checked = (menu: string) =>
    Array.from(
      document.querySelectorAll(
        `[data-testid^="${menu}-option-"][role="menuitemradio"][aria-checked="true"]`,
      ),
    ).map((element) => element.getAttribute("data-testid"));
  await id("profile-menu-trigger").click();
  await id("theme-menu-trigger").click();
  await expect.element(id("theme-option-auto")).toBeVisible();
  expect(checked("theme")).toEqual(["theme-option-auto"]);
  await id("theme-option-dark").click();
  await expect.element(id("profile-menu")).not.toBeInTheDocument();
  await id("profile-menu-trigger").click();
  await id("theme-menu-trigger").click();
  await expect.element(id("theme-option-dark")).toBeVisible();
  expect(checked("theme")).toEqual(["theme-option-dark"]);
  await userEvent.keyboard("{Escape}");
  await id("language-menu-trigger").click();
  await expect.element(id("locale-option-en-US")).toBeVisible();
  expect(checked("locale")).toEqual(["locale-option-en-US"]);
});

test.for([
  ["an omitted changes list", {}],
  ["an empty changes list", { changes: [] }],
])("a maintenance run with %s reports that nothing changed", async ([, backfillResponse]) => {
  await setup(true, { backfillResponse });
  await openSettings();
  await id("server-tab-maintenance").click();
  await id("open-backfill-node-ips").click();
  await id("backfill-node-ips-confirmed").click();
  await id("confirm-backfill-node-ips").click();
  await expect.element(id("backfill-node-ips-dialog")).not.toBeInTheDocument();
  await expect.element(id("backfill-node-ips-result")).toMatchTextContent("No changes were needed");
});

test("reports an activated language that could not be saved", async () => {
  await setup();
  vi.mocked(settings.writeSetting).mockRejectedValueOnce(new Error("storage unavailable"));
  await id("profile-menu-trigger").click();
  await id("language-menu-trigger").hover();
  await id("locale-option-fr-FR").click();
  await expect.element(id("locale-error")).toMatchTextContent("La langue a changé");
  await expect.element(id("app-header")).toBeVisible();
  expect(document.documentElement.lang).toBe("fr-FR");
});

test("shows a banner when preferences cannot be reloaded and clears it on the next successful read", async () => {
  await setup();
  const version = { keyEpoch: captureSettingsWriteEpoch(), profilesRevision: 0 };
  vi.mocked(settings.hydrateSettings).mockRejectedValueOnce(new Error("read unavailable"));
  notifyVaultChanged(version);
  await expect
    .element(id("settings-error"))
    .toMatchTextContent("could not reload your preferences");
  await expect.element(id("app-header")).toBeVisible();
  notifyVaultChanged(version);
  await expect.element(id("settings-error")).not.toBeInTheDocument();
});
