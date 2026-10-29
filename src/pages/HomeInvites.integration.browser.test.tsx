import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { PreAuthKey } from "@/api/contracts";
import { setLocale } from "@/i18n";
import { createApplicationRouter } from "@/router";
import {
  authenticateTestSession,
  prepareTestSession,
  SessionTestProviders,
} from "@/test/session";

afterEach(() => vi.restoreAllMocks());

async function setup(path = "/home", extraKeys: PreAuthKey[] = []) {
  const key = {
    key: "synthetic-prefix",
    reusable: false,
    ephemeral: false,
    used: false,
    aclTags: [],
  };
  const preAuthKeys: PreAuthKey[] = [
    { ...key, id: "1", expiration: "2099-01-01T00:00:00Z" },
    { ...key, id: "2", expiration: null },
    { ...key, id: "3", expiration: "2000-01-01T00:00:00Z" },
    { ...key, id: "4", used: true },
    { ...key, id: "5", used: true, reusable: true },
    ...extraKeys,
  ];
  const responses: Record<string, unknown> = {
    "/api/v1/health": { databaseConnectivity: true, serverReachable: true },
    "/version": { version: "0.29.4" },
    "/api/v1/user": { users: [{ id: "1", name: "alice" }] },
    "/api/v1/node": { nodes: [] },
    "/api/v1/preauthkey": { preAuthKeys },
    "/api/v1/apikey": { apiKeys: [] },
    "/api/v1/policy": { policy: '{"acls":[]}' },
  };
  const session = await prepareTestSession(async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method !== "GET" || !(path in responses)) {
      throw new Error(`Unexpected fixture request: ${request.method} ${path}`);
    }
    return Response.json(responses[path]);
  });
  await setLocale("en-US");
  await authenticateTestSession(session);
  const router = createApplicationRouter(
    session,
    createMemoryHistory({ initialEntries: [path] }),
  );
  await router.load();
  await render(
    <SessionTestProviders session={session}>
      <RouterProvider router={router} />
    </SessionTestProviders>,
  );
  await expect.poll(() => session.snapshot.getSnapshot().isReady).toBe(true);
  await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
  return router;
}

async function expectReadyRows() {
  await expect.element(page.getByTestId("invite-filter")).toHaveValue("ready");
  await expect.element(page.getByTestId("invite-1")).toBeVisible();
  await expect.element(page.getByTestId("invite-2")).toBeVisible();
  // This existing filter counts unused inventory, not every key capable of another registration.
  for (const id of ["3", "4", "5"]) {
    await expect
      .element(page.getByTestId(`invite-${id}`))
      .not.toBeInTheDocument();
  }
  await expect
    .element(page.getByTestId("invite-count"))
    .toMatchTextContent("2 / 5");
}

test("the overview auth-key count opens exactly the counted keys on the real destination page", async () => {
  const router = await setup();
  const card = page.getByTestId("overview-stat-invites");
  await expect
    .element(card)
    .toMatchTextContent(/^Unused, unexpired auth keys\s*2$/);
  await card.click();
  await expect.poll(() => router.state.location.pathname).toBe("/invites");
  await expectReadyRows();
});

test("an auth-key filter link survives entry and follows subsequent URL changes", async () => {
  const router = await setup("/invites?filter=ready&search=retained");
  await expectReadyRows();
  await page.getByTestId("invite-filter").selectOptions("used");
  await expect
    .poll(() => router.state.location.search)
    .toEqual({ filter: "used", search: "retained" });
  await expect.element(page.getByTestId("invite-4")).toBeVisible();
  await expect.element(page.getByTestId("invite-5")).toBeVisible();
  // Reusable remains available for registration even though it belongs to the used inventory.
  await expect
    .element(page.getByTestId("invite-registration-5"))
    .toHaveTextContent("Available for new registration");
  await expect
    .element(page.getByTestId("invite-status-5"))
    .toHaveTextContent("Ready");
  await expect
    .element(page.getByTestId("invite-registration-4"))
    .toHaveTextContent("Used one-time key; unavailable for new registration");
  await expect
    .element(page.getByTestId("invite-count"))
    .toMatchTextContent("2 / 5");
  await page.getByTestId("invite-filter").selectOptions("all");
  await expect
    .poll(() => router.state.location.search)
    .toEqual({ search: "retained" });
  await router.navigate({ to: "/invites", search: { filter: "ready" } });
  await expectReadyRows();
});

test("unknown and expired reusable keys do not enter unused inventory, while all keys retain their registration status", async () => {
  const extra = {
    key: "synthetic-extra",
    reusable: true,
    ephemeral: false,
    used: false,
    aclTags: [],
  };
  const router = await setup("/invites?filter=ready", [
    { ...extra, id: "6", expiration: "unreadable" },
    { ...extra, id: "7", used: true, expiration: "2000-01-01T00:00:00Z" },
  ]);
  await expect
    .element(page.getByTestId("invite-count"))
    .toMatchTextContent("2 / 7");
  for (const id of ["3", "4", "5", "6", "7"])
    await expect
      .element(page.getByTestId(`invite-${id}`))
      .not.toBeInTheDocument();
  await page.getByTestId("invite-filter").selectOptions("all");
  await expect
    .element(page.getByTestId("invite-registration-5"))
    .toHaveTextContent("Available for new registration");
  await expect
    .element(page.getByTestId("invite-status-6"))
    .toHaveTextContent("Unknown");
  await expect
    .element(page.getByTestId("invite-registration-6"))
    .toHaveTextContent("Unknown");
  await expect
    .element(page.getByTestId("invite-status-7"))
    .toHaveTextContent("Expired");
  await router.navigate({ to: "/home" });
  await expect
    .element(page.getByTestId("overview-stat-invites"))
    .toMatchTextContent(/^Unused, unexpired auth keys\s*2$/);
});

test.each([
  "/invites",
  "/invites?filter=unknown",
  "/invites?filter=ready&filter=used",
])("an absent or invalid auth-key filter shows all keys: %s", async (path) => {
  await setup(path);
  await expect.element(page.getByTestId("invite-filter")).toHaveValue("all");
  for (const id of ["1", "2", "3", "4", "5"]) {
    await expect.element(page.getByTestId(`invite-${id}`)).toBeVisible();
  }
  await expect
    .element(page.getByTestId("invite-count"))
    .toMatchTextContent("5 / 5");
  await expect
    .element(page.getByTestId("invite-registration-5"))
    .toHaveTextContent("Available for new registration");
});
