import type { FetchHandle } from "@defjs/core";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { ApiKey } from "@/api/contracts";
import { setLocale } from "@/i18n";
import { authenticateTestSession, prepareTestSession, renderSessionPage } from "@/test/session";
import AppLayout from "./AppLayout";

const id = (name: string) => page.getByTestId(name);
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
afterEach(async () => {
  vi.restoreAllMocks();
  await page.viewport(1280, 720);
});

const CREATED_KEY = `hskey-api-BBBBBBBBBBBB-${"c".repeat(64)}`;
const CREATED_PREFIX = "hskey-api-BBBBBBBBBBBB-***";

/** A Headscale fixture whose API key list follows create, expire and delete. */
async function setup(options: { apiKeys?: ApiKey[]; backfillChanges?: string[] } = {}) {
  let apiKeys: ApiKey[] = options.apiKeys ?? [{ id: "1", prefix: "server-key" }];
  const calls: Array<{ method: string; path: string }> = [];
  const failures = new Map<string, string>();
  const transport: FetchHandle = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = decodeURIComponent(new URL(request.url).pathname);
    calls.push({ method: request.method, path });
    const failure = failures.get(`${request.method} ${path}`);
    if (failure) return Response.json({ code: 3, message: failure }, { status: 400 });
    if (request.method === "POST" && path === "/api/v1/apikey") {
      apiKeys = [...apiKeys, { id: "created", prefix: CREATED_PREFIX }];
      return Response.json({ apiKey: CREATED_KEY });
    }
    if (request.method === "POST" && path === "/api/v1/apikey/expire") {
      const { prefix } = (await request.json()) as { prefix: string };
      apiKeys = apiKeys.map((key) =>
        key.prefix === prefix ? { ...key, expiration: "2000-01-01T00:00:00Z" } : key,
      );
      return Response.json({});
    }
    if (request.method === "DELETE") {
      apiKeys = apiKeys.filter((key) => `/api/v1/apikey/${key.prefix}` !== path);
      return Response.json({});
    }
    if (path === "/api/v1/node/backfillips")
      return Response.json({ changes: options.backfillChanges ?? [] });
    const values: Record<string, unknown> = {
      "/api/v1/health": { databaseConnectivity: true, serverReachable: true },
      "/version": { version: "0.29.4" },
      "/api/v1/user": { users: [] },
      "/api/v1/node": { nodes: [] },
      "/api/v1/preauthkey": { preAuthKeys: [] },
      "/api/v1/policy": { policy: '{"acls":[]}' },
      "/api/v1/apikey": { apiKeys },
    };
    return Response.json(values[path]);
  };
  const session = await prepareTestSession(transport);
  await setLocale("en-US");
  await authenticateTestSession(session);
  const screen = await renderSessionPage(session, <AppLayout />, "/home");
  await expect.element(id("app-header")).toBeVisible();
  await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
  calls.length = 0;
  return {
    ...screen,
    session,
    calls,
    fail: (request: string, message: string) => failures.set(request, message),
    pass: (request: string) => failures.delete(request),
  };
}

async function openSettings() {
  await id("profile-menu-trigger").click();
  await id("open-server-settings").click();
  await expect.element(id("server-settings-dialog")).toBeVisible();
}

async function finishAnimations() {
  await Promise.all(
    document.getAnimations().map((animation) => animation.finished.catch(() => {})),
  );
}

/** Captures the 30 s snapshot poll so a test can run one tick without waiting for it. */
function capturePolls() {
  const polls: Array<{ tick: () => void; timer: unknown }> = [];
  const realSetInterval = globalThis.setInterval;
  vi.spyOn(globalThis, "setInterval").mockImplementation(((
    handler: () => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    const timer = realSetInterval(handler, ms, ...args);
    if (ms === 30_000) polls.push({ tick: handler, timer });
    return timer;
  }) as typeof setInterval);
  return polls;
}

const nodeReads = (calls: Array<{ path: string }>) =>
  calls.filter((call) => call.path === "/api/v1/node").length;

test("polls the server every 30 seconds without renewing the session and stops when it locks", async () => {
  const polls = capturePolls();
  const cleared = vi.spyOn(globalThis, "clearInterval");
  const screen = await setup();
  const touch = vi.spyOn(screen.session.auth, "touch");
  const [poll] = polls.slice(-1);
  expect.assert(poll);
  poll.tick();
  await expect.poll(() => nodeReads(screen.calls)).toBe(1);
  await expect.poll(() => screen.session.snapshot.isRefreshing).toBe(false);
  // README: network polling is not user activity, so it never extends the session.
  expect(touch).not.toHaveBeenCalled();
  await id("profile-menu-trigger").click();
  await id("logout").click();
  await expect.poll(() => screen.session.snapshot.getSnapshot().isAuthorized).toBe(false);
  expect(cleared).toHaveBeenCalledWith(poll.timer);
});

test("a hidden page is not polled and refreshes once when it becomes visible again", async () => {
  const polls = capturePolls();
  const screen = await setup();
  const [poll] = polls.slice(-1);
  expect.assert(poll);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  poll.tick();
  document.dispatchEvent(new Event("visibilitychange"));
  await settle();
  expect(nodeReads(screen.calls)).toBe(0);
  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  await expect.poll(() => nodeReads(screen.calls)).toBe(1);
});

test("polling waits while a dialog or draft is open, a draft is held, or a refresh is running", async () => {
  const polls = capturePolls();
  const screen = await setup();
  const [poll] = polls.slice(-1);
  expect.assert(poll);
  await openSettings();
  poll.tick();
  await settle();
  expect(nodeReads(screen.calls)).toBe(0);
  await userEvent.keyboard("{Escape}");
  await expect.element(id("server-settings-dialog")).not.toBeInTheDocument();

  const refreshing = vi.spyOn(screen.session.snapshot, "isRefreshing", "get").mockReturnValue(true);
  poll.tick();
  await settle();
  expect(nodeReads(screen.calls)).toBe(0);
  refreshing.mockRestore();

  screen.session.drafts.hold({ id: "other", name: "Other server" }, true);
  await expect.element(id("stale-session-draft-dialog")).toBeVisible();
  poll.tick();
  await settle();
  expect(nodeReads(screen.calls)).toBe(0);
});

test("a requested refresh announces Data updated briefly, and a failed one shows only its error", async () => {
  const screen = await setup();
  await expect.element(id("refresh-status")).toHaveAttribute("role", "status");
  await expect.element(id("refresh-status")).toBeEmptyDOMElement();
  const timers: Array<{ handler: () => void; ms?: number }> = [];
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    handler: () => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    timers.push({ handler, ms });
    return realSetTimeout(handler, ms, ...args);
  }) as typeof setTimeout);
  await openSettings();
  await id("refresh-api-keys").click();
  await expect.element(id("refresh-status")).toHaveTextContent("Data updated");
  const clear = timers.find((timer) => timer.ms === 4000);
  expect.assert(clear);
  clear.handler();
  await expect.element(id("refresh-status")).toBeEmptyDOMElement();

  screen.fail("GET /api/v1/apikey", "list denied");
  await id("refresh-api-keys").click();
  await expect.element(id("refresh-error-identity")).toHaveTextContent("list denied");
  await expect.element(id("refresh-status")).toBeEmptyDOMElement();
});

test("a failed API key creation is reported once, inside the settings dialog", async () => {
  const screen = await setup();
  await openSettings();
  screen.fail("POST /api/v1/apikey", "write rejected");
  await id("create-api-key-confirm").click();
  await expect.element(id("api-key-create-error")).toHaveTextContent("write rejected");
  await expect.element(id("action-error")).not.toBeInTheDocument();
});

test.each(["expire", "delete"] as const)(
  "after the new key is %sd its one-time secret is no longer shown, but not after another key",
  async (action) => {
    await setup();
    await openSettings();
    await id("create-api-key-confirm").click();
    await expect.element(id("created-api-key")).toMatchTextContent(CREATED_KEY);
    await id("api-key-actions-trigger-server-key").click();
    await id(`${action}-api-key-server-key`).click();
    await id("confirm-api-key-action").click();
    await expect.element(id(`${action}-api-key-dialog`)).not.toBeInTheDocument();
    await expect.element(id("created-api-key")).toMatchTextContent(CREATED_KEY);
    await id(`api-key-actions-trigger-${CREATED_PREFIX}`).click();
    await id(`${action}-api-key-${CREATED_PREFIX}`).click();
    await id("confirm-api-key-action").click();
    await expect.element(id(`${action}-api-key-dialog`)).not.toBeInTheDocument();
    await expect.element(id("created-api-key")).not.toBeInTheDocument();
  },
);

test("an expired key offers only deletion and each confirmation states its consequence", async () => {
  await setup({
    apiKeys: [
      { id: "1", prefix: "old-key", expiration: "2000-01-01T00:00:00Z" },
      { id: "2", prefix: "live-key" },
    ],
  });
  await openSettings();
  await id("api-key-actions-trigger-old-key").click();
  await expect.element(id("delete-api-key-old-key")).toBeVisible();
  await expect.element(id("expire-api-key-old-key")).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");

  await id("api-key-actions-trigger-live-key").click();
  await id("expire-api-key-live-key").click();
  const expire = id("expire-api-key-dialog");
  await expect.element(expire).toMatchTextContent("lose access to the server immediately");
  await expect.element(expire).toMatchTextContent("cannot be renewed");
  await expect.element(expire).toMatchTextContent("live-key");
  await expect.element(expire).not.toMatchTextContent("only shown once");
  await id("cancel-api-key-action").click();

  await id("api-key-actions-trigger-live-key").click();
  await id("delete-api-key-live-key").click();
  const remove = id("delete-api-key-dialog");
  await expect.element(remove).toMatchTextContent("permanently removed");
  await expect.element(remove).toMatchTextContent("cannot be undone");
  await expect.element(remove).toMatchTextContent("live-key");
});

test("the API key table names creation and last use, and is a focusable scroll region", async () => {
  await setup({
    apiKeys: [
      { id: "1", prefix: "quiet-key", createdAt: "2026-01-02T03:04:05Z", lastSeen: null },
      {
        id: "2",
        prefix: "used-key",
        createdAt: "2026-01-02T03:04:05Z",
        lastSeen: "2026-02-03T04:05:06Z",
      },
    ],
  });
  await openSettings();
  const headers = Array.from(
    document.querySelectorAll('[data-testid="api-key-table"] th'),
    (cell) => cell.textContent,
  );
  expect(headers).toEqual(["Prefix", "Status", "Created", "Expires", "Last used", "Actions"]);
  await expect.element(id("api-key-last-used-quiet-key")).toHaveTextContent("Not reported");
  await expect.element(id("api-key-last-used-used-key")).toMatchTextContent("2026");
  const region = page.getByRole("region", { name: "API keys" });
  await expect.element(region).toHaveAttribute("tabindex", "0");
});

test("an empty API key list says so", async () => {
  await setup({ apiKeys: [] });
  await openSettings();
  await expect.element(id("api-key-empty")).toHaveTextContent("No API keys to show.");
});

test("backfill confirms the concrete action and reports when nothing changed", async () => {
  await setup();
  await openSettings();
  await id("server-tab-maintenance").click();
  await id("open-backfill-node-ips").click();
  await expect
    .element(page.getByRole("checkbox", { name: /adds or removes IP addresses on every node/ }))
    .toBeVisible();
  await id("backfill-node-ips-confirmed").click();
  await id("confirm-backfill-node-ips").click();
  await expect.element(id("backfill-node-ips-result")).toMatchTextContent("No changes were needed");
  await expect.element(id("backfill-node-ips-result")).not.toMatchTextContent("Ready to save");
});

test("switching server settings tabs keeps the tab bar where it was", async () => {
  await setup();
  await openSettings();
  await finishAnimations();
  const tabTop = () =>
    document.querySelector('[data-testid="server-tab-api-keys"]')?.getBoundingClientRect().top;
  const before = tabTop();
  await id("server-tab-maintenance").click();
  await expect.element(id("server-maintenance-settings")).toBeVisible();
  await finishAnimations();
  expect(tabTop()).toBeCloseTo(before ?? Number.NaN, 0);
  await id("server-tab-security").click();
  await finishAnimations();
  expect(tabTop()).toBeCloseTo(before ?? Number.NaN, 0);
});

test("a mouse click or Enter opens a profile submenu without waiting for hover", async () => {
  await setup();
  await id("profile-menu-trigger").click();
  await expect.element(id("profile-menu")).toHaveFocus();
  const trigger = document.querySelector<HTMLElement>('[data-testid="language-menu-trigger"]');
  expect.assert(trigger);
  // A real mouse press with no pointer movement first: Base UI alone would wait for a hover.
  const press = { bubbles: true, cancelable: true, button: 0, detail: 1, pointerType: "mouse" };
  const pointer = { ...press, width: 8, height: 8, pressure: 0.5 };
  trigger.dispatchEvent(new PointerEvent("pointerdown", pointer));
  trigger.dispatchEvent(new MouseEvent("mousedown", press));
  trigger.dispatchEvent(new PointerEvent("pointerup", pointer));
  trigger.dispatchEvent(new MouseEvent("mouseup", press));
  trigger.dispatchEvent(new PointerEvent("click", pointer));
  await expect.element(id("locale-option-en-US")).toBeVisible();
  // A second click keeps it open.
  trigger.dispatchEvent(new PointerEvent("click", pointer));
  await settle();
  await expect.element(id("locale-option-en-US")).toBeVisible();
  await userEvent.keyboard("{Escape}{Escape}");
  await expect.element(id("profile-menu")).not.toBeInTheDocument();

  // Closing the profile menu forgets the open submenu; Enter opens one from the keyboard.
  await id("profile-menu-trigger").click();
  await expect.element(id("profile-menu")).toHaveFocus();
  await expect.element(id("locale-option-en-US")).not.toBeInTheDocument();
  await userEvent.keyboard("{Home}");
  await expect.element(id("language-menu-trigger")).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(id("theme-menu-trigger")).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(id("theme-option-dark")).toBeVisible();
  await id("theme-option-dark").click();
  await expect.element(id("profile-menu")).not.toBeInTheDocument();
  await id("profile-menu-trigger").click();
  await expect.element(id("profile-menu")).toBeVisible();
  await expect.element(id("theme-option-dark")).not.toBeInTheDocument();
});

test("native language names carry their own language and direction", async () => {
  await setup();
  await id("profile-menu-trigger").click();
  await id("language-menu-trigger").click();
  await expect.element(id("locale-option-ar")).toBeVisible();
  const arabic = document.querySelector('[data-testid="locale-option-ar"] [lang="ar"]');
  expect(arabic?.getAttribute("dir")).toBe("rtl");
  expect(arabic?.textContent).toBe("العربية");
  const chinese = document.querySelector('[data-testid="locale-option-zh-Hans"] [lang="zh-Hans"]');
  expect(chinese?.getAttribute("dir")).toBe("ltr");
});

test("the GitHub repository is an external link, not a button", async () => {
  await setup();
  const link = page.getByRole("link", { name: "GitHub" });
  await expect.element(link).toHaveAttribute("href", "https://github.com/MunMunMiao/headscale-ui");
  await expect.element(link).toHaveAttribute("target", "_blank");
  await expect.element(link).not.toHaveAttribute("role");
  expect(page.getByRole("button", { name: "GitHub" }).elements()).toHaveLength(0);
});

test("a failed first load stops showing progress until the user retries", async () => {
  let failNodes = false;
  let heldNodes: Promise<unknown> = Promise.resolve();
  const session = await prepareTestSession(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/api/v1/node" && failNodes) {
      await heldNodes;
      return Response.json({ message: "nodes unavailable" }, { status: 500 });
    }
    const values: Record<string, unknown> = {
      "/api/v1/health": { databaseConnectivity: true, serverReachable: true },
      "/version": { version: "0.29.4" },
      "/api/v1/user": { users: [] },
      "/api/v1/node": { nodes: [] },
      "/api/v1/preauthkey": { preAuthKeys: [] },
      "/api/v1/policy": { policy: '{"acls":[]}' },
      "/api/v1/apikey": { apiKeys: [] },
    };
    return Response.json(values[path]);
  });
  await setLocale("en-US");
  await authenticateTestSession(session);
  failNodes = true;
  await renderSessionPage(session, <AppLayout />, "/home");
  await expect.element(id("initial-snapshot-error")).toHaveTextContent("nodes unavailable");
  await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
  await expect.element(id("session-loading-progress")).not.toBeInTheDocument();
  expect(document.querySelector(".animate-spin")).toBeNull();
  const retry = Promise.withResolvers<void>();
  heldNodes = retry.promise;
  await id("retry-initial-snapshot").click();
  await expect.element(id("session-loading-progress")).toHaveTextContent("Checking credentials");
  retry.resolve();
  await expect.element(id("session-loading-progress")).not.toBeInTheDocument();
  await expect.element(id("initial-snapshot-error")).toHaveTextContent("nodes unavailable");
});
