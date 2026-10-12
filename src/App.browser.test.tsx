/// <reference types="@vitest/browser-playwright" />
import type { FetchHandle } from "@defjs/core";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { authenticateTestSession, prepareTestSession } from "@/test/session";
import App from "./App";
import { SessionProviders } from "./AppProviders";
import ErrorScreen from "./components/ErrorScreen";
import type { Session } from "./composables/session-context";
import { setLocale } from "./i18n";
import { getProductCopy } from "./i18n/product-copy";
import { createApplicationRouter } from "./router";

afterEach(() => vi.restoreAllMocks());
const transport: FetchHandle = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  expect(request.headers.get("Authorization")).toBe("Bearer isolated-test-key");
  const responses: Record<string, unknown> = {
    "/api/v1/health": { databaseConnectivity: true },
    "/version": { version: "0.29.4" },
    "/api/v1/user": { users: [] },
    "/api/v1/node": { nodes: [] },
    "/api/v1/preauthkey": { preAuthKeys: [] },
    "/api/v1/apikey": { apiKeys: [] },
    "/api/v1/policy": { policy: '{"acls":[]}' },
  };
  return Response.json(responses[new URL(request.url).pathname]);
};

test.each(["/", "/home", "/unlock", "/devices/", "/DEVICES", "/unknown/path/extra"])(
  "routes unauthenticated entry %s to the login screen",
  async (path) => {
    const session = await prepareTestSession();
    const profiles = await session.auth.listProfiles();
    if (!profiles.ok) throw new Error("Fixture profile list failed");
    const history = createMemoryHistory({ initialEntries: [path] });
    await render(
      <App initialState={{ bridge: session.auth, profiles: profiles.value }} history={history} />,
    );
    await expect.element(page.getByTestId("profile-option-new")).toBeVisible();
    expect(history.location.pathname).toBe("/login");
  },
);

test.each([
  ["/", "/home", "overview-stats"],
  ["/?profile=requested&filter=false#details", "/login", "profile-option-new"],
  ["/devices?node=123&filter=false#details", "/devices", "machines-empty"],
  ["/devices/?node=123&filter=false#details", "/devices", "machines-empty"],
  ["/DEVICES?node=123&filter=false#details", "/DEVICES", "machines-empty"],
  ["/members", "/members", "refresh-users"],
  ["/invites", "/invites", "refresh-auth-keys"],
  ["/routes", "/routes", "refresh-routes"],
  ["/access", "/access", "resource-access-empty"],
  ["/saved", "/home", "overview-stats"],
  ["/saved/devices", "/devices", "machines-empty"],
  ["/saved/unknown", "/login", "profile-option-new"],
])("uses the shared authority for application route %s", async (path, expectedPath, landmark) => {
  const session = await prepareTestSession(transport);
  await setLocale("en-US");
  await authenticateTestSession(session);
  const active = session.auth.getSessionSnapshot();
  if (!active?.profile) throw new Error("Fixture profile is not authorized");
  const history = createMemoryHistory({
    initialEntries: [path.replace(/^\/saved/, `/${active.profile.id}`)],
  });
  const router = createApplicationRouter(session, history);
  await render(
    <SessionProviders session={session}>
      <RouterProvider router={router} />
    </SessionProviders>,
  );
  await expect.element(page.getByTestId(landmark)).toBeVisible();
  expect(history.location.pathname).toBe(expectedPath);
  if (expectedPath.toLowerCase() === "/devices")
    await expect
      .element(page.getByTestId("section-devices"))
      .toHaveAttribute("aria-current", "page");
  if (path.includes("?node")) {
    expect(router.state.location.search).toEqual({ node: "123", filter: "false" });
    expect(router.state.location.hash).toBe("details");
  }
  if (path === "/saved" || path === "/saved/devices")
    expect(router.state.location.search.profile).toBe(active.profile.id);
  if (path.startsWith("/?profile")) {
    expect(router.state.location.search).toMatchObject({ profile: "requested", redirect: path });
    expect(session.auth.getSessionSnapshot()?.identity).toEqual(active.identity);
  }
});

test("a locked saved profile cannot restore authorization from the protected route", async () => {
  const session = await prepareTestSession(transport);
  await authenticateTestSession(session);
  await session.profiles.logout();
  const execute = vi.spyOn(session.auth, "execute");
  const history = createMemoryHistory({ initialEntries: ["/devices?node=123#details"] });
  const router = createApplicationRouter(session, history);
  await render(
    <SessionProviders session={session}>
      <RouterProvider router={router} />
    </SessionProviders>,
  );
  await expect.element(page.getByTestId("profile-option-Test server")).toBeVisible();
  expect(history.location.pathname).toBe("/login");
  expect(router.state.location.search.redirect).toBe("/devices?node=123#details");
  expect(execute).not.toHaveBeenCalled();
});

test("cold shared-session restore keeps the policy editor unmounted until the first full snapshot arrives", async () => {
  const captured = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let holdPolicy = false;
  const session = await prepareTestSession(async (input, init) => {
    const request = new Request(input, init);
    if (holdPolicy && new URL(request.url).pathname === "/api/v1/policy") {
      captured.resolve();
      await released.promise;
    }
    return transport(input, init);
  });
  await authenticateTestSession(session);
  holdPolicy = true;
  const router = createApplicationRouter(
    session,
    createMemoryHistory({ initialEntries: ["/access"] }),
  );
  await render(
    <SessionProviders session={session}>
      <RouterProvider router={router} />
    </SessionProviders>,
  );
  await captured.promise;
  try {
    await expect.element(page.getByTestId("session-loading")).toBeVisible();
    await expect.element(page.getByTestId("app-header")).not.toBeInTheDocument();
    await expect.element(page.getByTestId("save-policy")).not.toBeInTheDocument();
  } finally {
    released.resolve();
  }
  await expect.element(page.getByTestId("app-header")).toBeVisible();
  expect(session.policy.getSnapshot().policyDraft).toBe('{"acls":[]}');
});

test("an initial snapshot failure offers retry without mounting a blank policy editor", async () => {
  let failPolicy = false;
  const session = await prepareTestSession(async (input, init) => {
    const request = new Request(input, init);
    if (failPolicy && new URL(request.url).pathname === "/api/v1/policy")
      return Response.json({ message: "Initial policy unavailable" }, { status: 503 });
    return transport(input, init);
  });
  await authenticateTestSession(session);
  failPolicy = true;
  const router = createApplicationRouter(
    session,
    createMemoryHistory({ initialEntries: ["/access"] }),
  );
  await render(
    <SessionProviders session={session}>
      <RouterProvider router={router} />
    </SessionProviders>,
  );
  await expect
    .element(page.getByTestId("initial-snapshot-error"))
    .toHaveTextContent("Initial policy unavailable");
  await expect.element(page.getByTestId("save-policy")).not.toBeInTheDocument();
  failPolicy = false;
  await page.getByTestId("retry-initial-snapshot").click();
  await expect.element(page.getByTestId("app-header")).toBeVisible();
  expect(session.policy.getSnapshot().policyDraft).toBe('{"acls":[]}');
});

test("a policy.mode: file server without a policy path loads the console with a read-only Access notice", async () => {
  const writes: string[] = [];
  const session = await prepareTestSession(async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname === "/api/v1/policy") {
      if (request.method !== "GET") writes.push(request.method);
      return Response.json(
        { code: 2, message: 'reading policy from path "": open : no such file or directory' },
        { status: 500 },
      );
    }
    return transport(input, init);
  });
  await setLocale("en-US");
  await authenticateTestSession(session);
  const router = createApplicationRouter(
    session,
    createMemoryHistory({ initialEntries: ["/access"] }),
  );
  await render(
    <SessionProviders session={session}>
      <RouterProvider router={router} />
    </SessionProviders>,
  );
  await expect.element(page.getByTestId("app-header")).toBeVisible();
  await expect.element(page.getByTestId("session-loading")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("initial-snapshot-error")).not.toBeInTheDocument();
  const notice = page.getByTestId("policy-read-only-notice");
  await expect.element(notice).toHaveAttribute("role", "status");
  await expect
    .poll(() => notice.element().textContent?.trim())
    .toBe(getProductCopy("en-US").policyFileModeNoPath);
  await expect.element(page.getByTestId("save-policy")).toBeDisabled();
  expect(writes).toEqual([]);
});

test("a policy.mode: file server without a policy path explains the read-only state on Members and disables policy assignments", async () => {
  const session = await prepareTestSession(async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/api/v1/policy")
      return Response.json(
        { code: 2, message: 'reading policy from path "": open : no such file or directory' },
        { status: 500 },
      );
    if (path === "/api/v1/user")
      return Response.json({
        users: [{ id: "1", name: "alice", displayName: "Alice", email: "alice@example.com" }],
      });
    return transport(input, init);
  });
  await page.viewport(1366, 768);
  await setLocale("en-US");
  await authenticateTestSession(session);
  const router = createApplicationRouter(
    session,
    createMemoryHistory({ initialEntries: ["/members"] }),
  );
  await render(
    <SessionProviders session={session}>
      <RouterProvider router={router} />
    </SessionProviders>,
  );
  await expect.element(page.getByTestId("app-header")).toBeVisible();
  const expected = getProductCopy("en-US").policyFileModeNoPath;
  const notice = page.getByTestId("members-policy-read-only");
  await expect.poll(() => notice.element().textContent?.trim()).toBe(expected);
  await page.getByTestId("member-actions-trigger-alice").click();
  await expect
    .element(page.getByTestId("assign-member-groups-alice"))
    .toHaveAttribute("aria-disabled", "true");
  await expect
    .element(page.getByTestId("assign-member-tags-alice"))
    .toHaveAttribute("aria-disabled", "true");
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("member-actions-trigger-alice").click();
  await page.getByTestId("delete-member-alice").click();
  const impact = page.getByTestId("delete-member-policy-impact");
  await expect.poll(() => impact.element().textContent).toContain(expected);
  await expect.element(page.getByTestId("confirm-delete-member")).toBeDisabled();
  await page.getByTestId("delete-member-cleanup-policy").click();
  await expect.element(page.getByTestId("confirm-delete-member")).toBeEnabled();
});

test.each(["en-US", "zh-Hans"] as const)(
  "a rejected API key shows one localized initial-snapshot error and recovers on retry in %s",
  async (locale) => {
    let failAll = false;
    const session = await prepareTestSession(async (input, init) => {
      if (failAll && new URL(new Request(input, init).url).pathname.startsWith("/api/v1/"))
        return new Response("Unauthorized", { status: 401 });
      return transport(input, init);
    });
    await setLocale(locale);
    await authenticateTestSession(session);
    failAll = true;
    const router = createApplicationRouter(
      session,
      createMemoryHistory({ initialEntries: ["/access"] }),
    );
    await render(
      <SessionProviders session={session}>
        <RouterProvider router={router} />
      </SessionProviders>,
    );
    const expected = getProductCopy(locale).errorRequestFailed;
    const error = page.getByTestId("initial-snapshot-error");
    await expect.element(error).toBeVisible();
    await expect.poll(() => error.element().textContent?.trim()).toBe(expected);
    expect(error.element().textContent).not.toMatch(/media type/i);
    await expect.element(page.getByTestId("retry-initial-snapshot")).toBeEnabled();
    failAll = false;
    await page.getByTestId("retry-initial-snapshot").click();
    await expect.element(page.getByTestId("app-header")).toBeVisible();
    await setLocale("en-US");
  },
);

test("keeps a committed reset metadata warning visible when the real router returns to login", async () => {
  const session = await prepareTestSession(transport);
  await setLocale("en-US");
  await authenticateTestSession(session);
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
  sessionStorage.setItem("headscale-ui-denied-tail", "tail");
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new DOMException("session cleanup denied", "SecurityError");
  });
  await page.getByTestId("security-clear-all").click();
  await page.getByTestId("security-clear-all-confirm").click();
  await expect.element(page.getByTestId("profile-option-new")).toBeVisible();
  await expect.element(page.getByTestId("login-error")).toMatchTextContent("Close this tab");
  expect(session.profiles.getSnapshot().profiles).toEqual([]);
});

test("a route render error shows the localized recovery screen instead of TanStack's default", async () => {
  const session = await prepareTestSession(transport);
  await setLocale("zh-Hans");
  await authenticateTestSession(session);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const router = createApplicationRouter(
    session,
    createMemoryHistory({ initialEntries: ["/home"] }),
  );
  await render(
    <SessionProviders session={session}>
      <RouterProvider router={router} />
    </SessionProviders>,
  );
  await expect.element(page.getByTestId("overview-stats")).toBeVisible();
  vi.spyOn(session.snapshot, "getSnapshot").mockImplementation(() => {
    throw new Error("route exploded");
  });
  session.snapshot.applyPatch({});
  await expect.element(page.getByTestId("error-screen")).toBeVisible();
  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toHaveTextContent("Headscale UI 遇到了问题");
  await expect.element(page.getByTestId("error-screen")).toMatchTextContent("route exploded");
  await expect.element(page.getByTestId("error-reset")).not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain("Something went wrong");
  await setLocale("en-US");
});

test("an error thrown above the router is caught by the root boundary and logged once", async () => {
  const session = await prepareTestSession(transport);
  await setLocale("en-US");
  const profiles = await session.auth.listProfiles();
  if (!profiles.ok) throw new Error("Fixture profile list failed");
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(session.auth, "getSnapshot").mockImplementation(() => {
    throw new Error("provider exploded");
  });
  await render(<App initialState={{ bridge: session.auth, profiles: profiles.value }} />);
  await expect.element(page.getByTestId("error-screen")).toBeVisible();
  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toHaveTextContent("Headscale UI ran into a problem");
  await expect.element(page.getByTestId("error-screen")).toMatchTextContent("provider exploded");
  expect(document.body.textContent).not.toContain("Something went wrong");
  expect(logged).toHaveBeenCalledWith("[headscale-ui] render failed", expect.any(Error));
});

test("the application router uses the shared recovery screen for every route error", () => {
  const router = createApplicationRouter(
    // Only the options object is inspected, so no session behaviour is needed.
    {} as Session,
    createMemoryHistory({ initialEntries: ["/login"] }),
  );
  expect(router.options.defaultErrorComponent).toBe(ErrorScreen);
});

describe("theme before JavaScript chooses a class", () => {
  const LIGHT_BACKGROUND = "oklch(1 0 0)";
  const DARK_BACKGROUND = "oklch(0.145 0 0)";
  const root = document.documentElement;
  afterEach(async () => {
    root.classList.remove("dark", "light");
    await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  });
  const emulate = (scheme: "dark" | "light") =>
    cdp().send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: scheme }],
    });
  const body = () => getComputedStyle(document.body);

  test("an explicit class sets the native color scheme and wins over the OS", async () => {
    await emulate("light");
    root.classList.add("dark");
    expect(getComputedStyle(root).colorScheme).toBe("dark");
    root.classList.replace("dark", "light");
    await emulate("dark");
    expect(getComputedStyle(root).colorScheme).toBe("light");
    expect(body().backgroundColor).toBe(LIGHT_BACKGROUND);
  });

  test("without a class the OS preference darkens the page", async () => {
    await emulate("dark");
    expect(getComputedStyle(root).colorScheme).toBe("dark");
    expect(body().backgroundColor).toBe(DARK_BACKGROUND);
    await emulate("light");
    expect(body().backgroundColor).toBe(LIGHT_BACKGROUND);
  });

  test("anchored scrolling keeps clear of the sticky header", () => {
    expect(getComputedStyle(root).scrollPaddingTop).toBe("96px");
  });
});
