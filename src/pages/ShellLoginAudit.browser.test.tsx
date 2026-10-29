import {
  createBrowserHistory,
  createMemoryHistory,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { createPolicySave } from "@/composables/usePolicySave";
import { setLocale } from "@/i18n";
import { createApplicationRouter } from "@/router";
import {
  authenticateTestSession,
  prepareTestSession,
  SessionTestProviders,
} from "@/test/session";

const id = (name: string) => page.getByTestId(name);
const firstKey = `hskey-api-AAAAAAAAAAAA-${"a".repeat(64)}`;
const nextKey = `hskey-api-BBBBBBBBBBBB-${"b".repeat(64)}`;

afterEach(async () => {
  vi.restoreAllMocks();
  await page.viewport(1280, 720);
});

async function setup(path = "/home", authorized = true) {
  let failCreate = false;
  let rejectedHost = "";
  let created = false;
  let policy = '{"acls":[]}';
  const writes: string[] = [];
  const session = await prepareTestSession(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.host === rejectedHost)
      return Response.json({ message: "candidate refused" }, { status: 403 });
    if (request.method !== "GET")
      writes.push(`${request.method} ${url.pathname}`);
    if (request.method === "POST" && url.pathname === "/api/v1/apikey") {
      if (failCreate)
        return Response.json({ message: "write rejected" }, { status: 400 });
      const apiKey = created ? nextKey : firstKey;
      created = true;
      return Response.json({ apiKey });
    }
    if (request.method === "PUT" && url.pathname === "/api/v1/policy") {
      policy = ((await request.json()) as { policy: string }).policy;
      return Response.json({ policy });
    }
    const responses: Record<string, unknown> = {
      "/api/v1/health": { databaseConnectivity: true, serverReachable: true },
      "/version": { version: "0.29.4" },
      "/api/v1/user": { users: [] },
      "/api/v1/node": { nodes: [] },
      "/api/v1/preauthkey": { preAuthKeys: [] },
      "/api/v1/policy": { policy },
      "/api/v1/apikey": { apiKeys: [] },
      "/api/v1/node/backfillips": { changes: [] },
    };
    return Response.json(responses[url.pathname]);
  });
  await setLocale("en-US");
  if (authorized) await authenticateTestSession(session);
  const router = createApplicationRouter(
    session,
    createMemoryHistory({ initialEntries: [path] }),
  );
  await router.load();
  const screen = await render(
    <SessionTestProviders session={session}>
      <RouterProvider router={router} />
    </SessionTestProviders>,
  );
  await expect
    .element(
      id(
        authorized && !path.startsWith("/login")
          ? "app-header"
          : "profile-picker",
      ),
    )
    .toBeVisible();
  await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
  return {
    ...screen,
    session,
    router,
    writes,
    failCreate: (fail: boolean) => {
      failCreate = fail;
    },
    rejectHost: (host: string) => {
      rejectedHost = host;
    },
  };
}

function unloadIsPrevented() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

async function openSettings() {
  await id("profile-menu-trigger").click();
  await id("open-server-settings").click();
  await expect.element(id("server-settings-dialog")).toBeVisible();
}

// Removing the dirty check must lose real document-unload cancellation, not merely a mock call.
test("F10 connection drafts protect document unload until discarded or saved", async () => {
  const { session } = await setup("/login", false);
  expect(unloadIsPrevented()).toBe(false);
  await id("profile-option-new").click();
  expect(unloadIsPrevented()).toBe(false);
  await id("connect-profile-name").fill("Draft");
  expect(unloadIsPrevented()).toBe(true);
  await id("connect-close").click();
  await id("keep-editing-profile").click();
  expect(unloadIsPrevented()).toBe(true);
  await expect.element(id("connect-profile-name")).toHaveValue("Draft");
  await id("connect-close").click();
  await id("discard-profile-changes").click();
  expect(unloadIsPrevented()).toBe(false);

  await id("profile-option-new").click();
  await id("connect-password").fill("server password");
  expect(unloadIsPrevented()).toBe(true);
  await id("connect-password").fill("");
  expect(unloadIsPrevented()).toBe(false);
  await id("connect-api-key").fill("isolated-key");
  expect(unloadIsPrevented()).toBe(true);
  await id("connect-profile-name").fill("Saved server");
  await id("connect-server-url").fill("https://fixture.invalid");
  await id("connect-password").fill("server password");
  await id("connect-password-confirm").fill("server password");
  await id("connect-save-unlock").click();
  await expect.element(id("app-header")).toBeVisible();
  expect(session.auth.getSessionSnapshot()?.status).toBe("unlocked");
  expect(unloadIsPrevented()).toBe(false);
});

test("F10 ordinary dirty policy protects unload without blocking SPA navigation and releases after save or discard", async () => {
  const { session, router } = await setup("/access");
  const blocker = router.history._getBlockers()[0];
  expect.assert(blocker);
  // Use the actual browser-history beforeunload implementation, not memory history's no-op.
  const browserHistory = createBrowserHistory();
  const stop = browserHistory.block(blocker);
  try {
    expect(unloadIsPrevented()).toBe(false);
    session.policy.commitState({
      ...session.policy.policyDesignerState,
      groups: [{ id: "ops", name: "group:ops", members: [] }],
    });
    expect(session.policy.isPolicyDirty).toBe(true);
    expect(session.drafts.isCurrent()).toBe(true);
    expect(unloadIsPrevented()).toBe(true);
    await id("section-devices").click();
    await expect.poll(() => router.state.location.pathname).toBe("/devices");
    expect(session.policy.isPolicyDirty).toBe(true);
    expect(unloadIsPrevented()).toBe(true);
    const saved = await createPolicySave(session).savePolicy(
      "save-policy",
      session.policy.policyDesignerState,
    );
    expect(saved.ok).toBe(true);
    expect(unloadIsPrevented()).toBe(false);
    session.policy.commitState({
      ...session.policy.policyDesignerState,
      groups: [],
    });
    expect(unloadIsPrevented()).toBe(true);
    session.discardDrafts();
    expect(unloadIsPrevented()).toBe(false);
  } finally {
    stop();
    browserHistory.destroy();
  }
});

test("F10 a policy draft kept while choosing another profile still protects document unload", async () => {
  const { session, router } = await setup("/access");
  session.policy.commitState({
    ...session.policy.policyDesignerState,
    groups: [{ id: "ops", name: "group:ops", members: [] }],
  });
  await router.navigate({
    to: "/login",
    search: { redirect: router.state.location.href },
  });
  await expect.element(id("profile-picker")).toBeVisible();
  expect(session.policy.isPolicyDirty).toBe(true);
  const browserHistory = createBrowserHistory();
  const stops = router.history
    ._getBlockers()
    .map((blocker) => browserHistory.block(blocker));
  try {
    expect(unloadIsPrevented()).toBe(true);
    session.discardDrafts();
    expect(unloadIsPrevented()).toBe(false);
    await id("login-continue").click();
    await expect.element(id("app-header")).toBeVisible();
  } finally {
    for (const stop of stops) stop();
    browserHistory.destroy();
  }
});

test.each(["/devices", "/login", "/"])(
  "F16 a first visit to %s guides connection setup instead of claiming an old session locked",
  async (path) => {
    await setup(path, false);
    await expect.element(id("login-notice")).toMatchTextContent("API key");
    await expect
      .element(id("login-notice"))
      .not.toMatchTextContent(/locked|reloading|password/i);
    await expect.element(id("profile-option-new")).toBeVisible();
  },
);

test.each([
  ["zh-Hans", "删除此连接配置？"],
  ["zh-Hant-HK", "刪除此連線設定？"],
  ["zh-Hant-TW", "刪除此連線設定？"],
] as const)(
  "F25 %s deletion names only the local connection profile",
  async (locale, title) => {
    await setup("/login");
    await setLocale(locale);
    await id("delete-profile-Test server").click();
    await expect
      .element(id("delete-profile-dialog").getByRole("heading"))
      .toHaveTextContent(title);
    await expect
      .element(id("delete-profile-dialog"))
      .toMatchTextContent("https://fixture.invalid");
    await expect
      .element(id("delete-profile-dialog"))
      .toMatchTextContent(/浏览器|瀏覽器/);
  },
);

test("F26 changing direction keeps the active narrow-screen navigation item geometrically visible", async () => {
  await page.viewport(375, 812);
  await setup("/home");
  await id("section-access").click();
  const inScrollport = () => {
    const nav = id("header-navigation").element().getBoundingClientRect();
    const active = id("section-access").element().getBoundingClientRect();
    return active.left >= nav.left - 1 && active.right <= nav.right + 1;
  };
  await expect.poll(inScrollport).toBe(true);
  await setLocale("ar");
  await expect.element(id("header-navigation")).toHaveAttribute("dir", "rtl");
  await expect.poll(inScrollport).toBe(true);
  await setLocale("en-US");
  await expect.poll(inScrollport).toBe(true);
});

test("F28 a rejected second API key creation keeps the first full key copyable until a new success", async () => {
  const ctx = await setup();
  await openSettings();
  await id("create-api-key-confirm").click();
  await expect.element(id("created-api-key")).toMatchTextContent(firstKey);
  ctx.failCreate(true);
  await id("create-api-key-confirm").click();
  await expect
    .element(id("api-key-create-error"))
    .toMatchTextContent("write rejected");
  await expect.element(id("created-api-key")).toMatchTextContent(firstKey);
  const clipboard = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockResolvedValue();
  await id("copy-created-api-key").click();
  expect(clipboard).toHaveBeenCalledWith(firstKey);
  ctx.failCreate(false);
  await id("create-api-key-confirm").click();
  await expect.element(id("created-api-key")).toMatchTextContent(nextKey);
  await expect.element(id("created-api-key")).not.toMatchTextContent(firstKey);
  await ctx.session.profiles.logout();
  await expect.element(id("profile-picker")).toBeVisible();
  expect(document.body.textContent).not.toContain(nextKey);
});

test.each([1280, 375])(
  "the header identifies the active profile without connection secrets or a switch shortcut at %ipx",
  async (width) => {
    await page.viewport(width, 812);
    const { session } = await setup();
    await expect
      .element(id("header-primary-row"))
      .toMatchTextContent("Test server");
    await expect
      .element(id("header-primary-row"))
      .not.toMatchTextContent("fixture.invalid");
    await id("profile-menu-trigger").click();
    await expect.element(id("profile-menu")).toMatchTextContent("Test server");
    await expect.element(id("switch-profile")).not.toBeInTheDocument();
    await expect.element(id("open-server-settings")).toBeVisible();
    await expect.element(id("logout")).toBeVisible();
    expect(session.auth.getSessionSnapshot()?.status).toBe("unlocked");
  },
);

test.each([
  [1280, 900],
  [375, 500],
])(
  "server settings stays centered across tabs at %ix%i",
  async (width, height) => {
    await page.viewport(width, height);
    await setup();
    await openSettings();
    for (const tab of [
      "server-tab-api-keys",
      "server-tab-maintenance",
      "server-tab-security",
    ]) {
      await id(tab).click();
      await Promise.all(
        document.getAnimations().map((animation) => animation.finished),
      );
      const dialog = id("server-settings-dialog").element();
      const rect = dialog.getBoundingClientRect();
      expect(
        Math.abs(rect.left + rect.width / 2 - width / 2),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(rect.top + rect.height / 2 - height / 2),
      ).toBeLessThanOrEqual(1);
      expect(rect.top).toBeGreaterThanOrEqual(16);
      expect(rect.bottom).toBeLessThanOrEqual(height - 16);
      expect(getComputedStyle(dialog).overflowY).toBe("auto");
    }
  },
);

test("a failed candidate on the login page leaves the original connection available", async () => {
  const ctx = await setup();
  const original = ctx.session.auth.getSessionSnapshot();
  await ctx.router.navigate({
    to: "/login",
    search: { redirect: ctx.router.state.location.href },
  });
  await id("profile-option-new").click();
  await id("connect-profile-name").fill("Candidate");
  await id("connect-server-url").fill("https://candidate.invalid");
  await id("connect-api-key").fill("isolated-candidate-key");
  await id("connect-password").fill("server password");
  await id("connect-password-confirm").fill("server password");
  await id("connect-submit").click();
  await expect.element(id("profile-option-Candidate")).toBeVisible();
  ctx.rejectHost("candidate.invalid");
  await id("profile-option-Candidate").click();
  await id("unlock-passphrase").fill("server password");
  await id("unlock-submit").click();
  await expect
    .element(id("unlock-error"))
    .toHaveTextContent("candidate refused");
  expect(ctx.session.auth.getSessionSnapshot()?.identity).toEqual(
    original?.identity,
  );
  expect(ctx.session.auth.getSessionSnapshot()?.profile).toEqual(
    original?.profile,
  );
  await id("unlock-cancel").click();
  await id("login-continue").click();
  await expect.element(id("app-header")).toBeVisible();
  await id("profile-menu-trigger").click();
  await expect.element(id("profile-menu")).toMatchTextContent("Test server");
});

test("the narrow header keeps its logo and controls visible without overlap", async () => {
  await page.viewport(375, 812);
  await setup();
  const logo = id("app-logo").element().getBoundingClientRect();
  const github = id("github-repository-link").element().getBoundingClientRect();
  const profile = id("profile-menu-trigger").element().getBoundingClientRect();
  expect(logo.left).toBeGreaterThanOrEqual(0);
  expect(logo.right).toBeLessThanOrEqual(github.left);
  expect(github.right).toBeLessThanOrEqual(profile.left);
  expect(profile.right).toBeLessThanOrEqual(375);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
  await expect.element(id("profile-menu-trigger")).toBeVisible();
  await id("profile-menu-trigger").click();
  await expect.element(id("open-server-settings")).toBeVisible();
  await expect.element(id("logout")).toBeVisible();
});

test("F26 an initially loaded narrow Access page scrolls its active link into view", async () => {
  await page.viewport(375, 812);
  await setup("/access");
  await expect
    .poll(() => {
      const nav = id("header-navigation").element().getBoundingClientRect();
      const active = id("section-access").element().getBoundingClientRect();
      return active.left >= nav.left - 1 && active.right <= nav.right + 1;
    })
    .toBe(true);
});

test("document titles follow page, language and profile without stealing focus for a search-only change", async () => {
  const { router } = await setup("/devices");
  await expect
    .poll(() => document.title)
    .toBe("Machines · Test server · Headscale UI");
  await id("section-members").click();
  await expect
    .poll(() => document.title)
    .toBe("Users · Test server · Headscale UI");
  await setLocale("zh-Hans");
  await expect
    .poll(() => document.title)
    .toBe("用户 · Test server · Headscale UI");
  const trigger = id("profile-menu-trigger").element() as HTMLElement;
  trigger.focus();
  await router.navigate({ to: "/members", search: { search: "alice" } });
  expect(document.activeElement).toBe(trigger);
  await router.navigate({ to: "/login" });
  await expect.poll(() => document.title).toBe("选择服务器配置 · Headscale UI");
  await id("edit-profile-Test server").click();
  await id("connect-profile-name").fill("Renamed network");
  await id("connect-submit").click();
  await expect.element(id("profile-option-Renamed network")).toBeVisible();
  await id("login-continue").click();
  await expect
    .poll(() => document.title)
    .toBe("概览 · Renamed network · Headscale UI");
});

test("connection guidance links CORS and mixed-content help and distinguishes editing from adding", async () => {
  await setup("/login");
  await id("profile-option-new").click();
  await expect.element(id("connection-dialog")).toMatchTextContent("API key");
  await expect
    .element(id("connection-troubleshooting-link"))
    .toHaveAttribute(
      "href",
      "https://github.com/MunMunMiao/headscale-ui#connecting-to-headscale-cors",
    );
  await expect
    .element(id("connect-api-key"))
    .toHaveAttribute(
      "placeholder",
      "API key created by headscale apikeys create",
    );
  await expect
    .element(id("connection-description"))
    .toMatchTextContent("API key");
  await expect
    .element(id("connection-troubleshooting-link"))
    .toMatchTextContent(/CORS.*mixed content/i);
});

test("editing a saved connection explains metadata-only edits instead of asking to add credentials", async () => {
  await setup("/login");
  await id("edit-profile-Test server").click();
  await expect
    .element(id("connection-description"))
    .toMatchTextContent("Leave the API key and password empty");
});

test("the backfill card explains its all-node IP changes before the confirmation and still requires acknowledgement", async () => {
  const { writes } = await setup();
  await openSettings();
  await id("server-tab-maintenance").click();
  await expect
    .element(id("server-maintenance-settings"))
    .toMatchTextContent("adds or removes IP addresses on every node");
  await id("open-backfill-node-ips").click();
  await expect.element(id("confirm-backfill-node-ips")).toBeDisabled();
  expect(writes).not.toContain("POST /api/v1/node/backfillips");
  await id("backfill-node-ips-confirmed").click();
  await expect.element(id("confirm-backfill-node-ips")).toBeEnabled();
});
