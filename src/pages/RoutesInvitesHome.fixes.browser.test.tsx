import "fake-indexeddb/auto";
import type { FetchHandle } from "@defjs/core";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { HeadscaleSnapshot } from "@/api/contracts";
import { setLocale } from "@/i18n";
import { SUPPORTED_LOCALES } from "@/i18n/locales";
import { getProductCopy } from "@/i18n/product-copy";
import { loadLocale } from "@/i18n/runtime";
import { hydrateSettings } from "@/lib/settings-storage";
import {
  authenticateTestSession,
  prepareTestSession,
  renderSessionPage,
} from "@/test/session";

import HomePage from "./HomePage";
import InvitesPage from "./InvitesPage";
import RoutesPage from "./RoutesPage";

beforeEach(async () => {
  await hydrateSettings();
  setLocale("en-US");
});
afterEach(() => vi.restoreAllMocks());

const copy = getProductCopy("en-US");
const alice = {
  id: "1",
  name: "alice",
  displayName: "Alice Ops",
  email: "alice@example.com",
};
const bob = { id: "2", name: "bob" };
// Headscale returns the full secret only from create; listings carry `hskey-auth-<12>-***`.
const SECRET = "hskey-auth-Ab3_dEf-9hIj-0123456789abcdef0123456789abcdef";
const LISTED = "hskey-auth-Ab3_dEf-9hIj-***";

function node(
  id: string,
  routes: Partial<HeadscaleSnapshot["nodes"][number]> = {},
) {
  return {
    id,
    name: `node-${id}`,
    user: alice,
    online: true,
    ipAddresses: [`100.64.0.${id}`],
    approvedRoutes: [],
    availableRoutes: [],
    subnetRoutes: [],
    tags: [],
    ...routes,
  };
}
function fixture(): HeadscaleSnapshot {
  return {
    health: { databaseConnectivity: true, serverReachable: true },
    version: { version: "0.29.4" },
    users: [alice, bob],
    apiKeys: [],
    policy: { policy: '{"acls":[]}' },
    nodes: [
      {
        ...node("1", {
          approvedRoutes: ["10.42.0.0/16"],
          availableRoutes: [
            "10.42.0.0/16",
            "172.16.0.0/12",
            "0.0.0.0/0",
            "::/0",
          ],
        }),
        givenName: "edge-router",
      },
    ],
    preAuthKeys: [
      {
        id: "1",
        key: "hskey-auth-readyprefix1-***",
        user: alice,
        reusable: false,
        ephemeral: false,
        used: false,
        expiration: "2099-01-01T00:00:00Z",
        aclTags: [],
      },
      {
        id: "2",
        key: "hskey-auth-usedprefix02-***",
        user: bob,
        reusable: false,
        ephemeral: false,
        used: true,
        expiration: "2099-01-01T00:00:00Z",
        aclTags: [],
      },
      {
        id: "3",
        key: "hskey-auth-expiredpref3-***",
        user: alice,
        reusable: false,
        ephemeral: false,
        used: false,
        expiration: "2000-01-01T00:00:00Z",
        aclTags: [],
      },
    ],
  };
}

type Call = {
  method: string;
  path: string;
  body: Record<string, unknown> & { routes: string[] };
};
async function setup(
  path: string,
  element: ReactNode,
  tweak?: (b: HeadscaleSnapshot) => void,
) {
  const backend = fixture();
  tweak?.(backend);
  const calls: Call[] = [];
  let failure = "";
  const transport: FetchHandle = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const body =
      request.method === "GET" || request.method === "DELETE"
        ? {}
        : await request.json();
    calls.push({ method: request.method, path: url.pathname, body });
    if (failure && request.method !== "GET")
      return Response.json({ message: failure }, { status: 500 });
    const approval = /^\/api\/v1\/node\/(\d+)\/approve_routes$/.exec(
      url.pathname,
    );
    if (approval) {
      const target = backend.nodes.find(
        (candidate) => candidate.id === approval[1],
      );
      if (!target) throw new Error("Unknown fixture node");
      // Headscale re-adds both exit prefixes whenever either one is submitted.
      const exit = body.routes.some(
        (route: string) => route === "0.0.0.0/0" || route === "::/0",
      )
        ? ["0.0.0.0/0", "::/0"]
        : [];
      target.approvedRoutes = Array.from(new Set([...body.routes, ...exit]));
      return Response.json({ node: target });
    }
    if (request.method === "POST" && url.pathname === "/api/v1/preauthkey") {
      const user = backend.users.find(
        (candidate) => candidate.id === body.user,
      );
      const created = { id: "4", key: SECRET, ...body, user, used: false };
      backend.preAuthKeys.push({ ...created, key: LISTED } as never);
      return Response.json({ preAuthKey: created });
    }
    if (url.pathname === "/api/v1/preauthkey/expire") {
      const key = backend.preAuthKeys.find(
        (candidate) => candidate.id === body.id,
      );
      if (key) key.expiration = "2000-01-01T00:00:00Z";
      return Response.json({});
    }
    if (request.method === "DELETE") {
      backend.preAuthKeys = backend.preAuthKeys.filter(
        (key) => key.id !== url.searchParams.get("id"),
      );
      return Response.json({});
    }
    const reads: Record<string, unknown> = {
      "/api/v1/health": backend.health,
      "/version": backend.version,
      "/api/v1/user": { users: backend.users },
      "/api/v1/node": { nodes: backend.nodes },
      "/api/v1/preauthkey": { preAuthKeys: backend.preAuthKeys },
      "/api/v1/apikey": { apiKeys: [] },
      "/api/v1/policy": backend.policy,
    };
    return Response.json(reads[url.pathname]);
  };
  const session = await prepareTestSession(transport);
  setLocale("en-US");
  await authenticateTestSession(session);
  const { router } = await renderSessionPage(session, element, path);
  await expect
    .poll(() => session.snapshot.getSnapshot().snapshot.health?.serverReachable)
    .toBe(true);
  await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
  calls.length = 0;
  return {
    backend,
    calls,
    session,
    router,
    fail: (message: string) => {
      failure = message;
    },
  };
}
const posts = (calls: Call[]) => calls.filter((call) => call.method === "POST");
const texts = (selector: string) =>
  Array.from(document.querySelectorAll(selector), (element) =>
    element.textContent?.trim(),
  );
function inViewport(element: Element) {
  const rect = element.getBoundingClientRect();
  return rect.top >= 0 && rect.bottom <= window.innerHeight + 1;
}
function manyNodes(backend: HeadscaleSnapshot) {
  for (let id = 10; id < 30; id++)
    backend.nodes.push(
      node(String(id), { availableRoutes: [`10.${id}.0.0/16`] }),
    );
}
function manyKeys(backend: HeadscaleSnapshot) {
  for (let id = 10; id < 45; id++)
    backend.preAuthKeys.push({
      id: String(id),
      key: `hskey-auth-filler${id}abcd-***`,
      user: alice,
      reusable: false,
      ephemeral: false,
      used: false,
      expiration: "2099-01-01T00:00:00Z",
      aclTags: [],
    });
}

// ---------------------------------------------------------------- Routes

// Catches the full advertised list being labelled as pending (zh "待批准路由") and the home stat
// sharing one wording with that list.
test("the full route list is labelled as advertised routes, never as pending, in every locale", async () => {
  for (const locale of SUPPORTED_LOCALES) {
    await loadLocale(locale);
    const localized = getProductCopy(locale);
    expect(localized.advertisedRoutes, locale).not.toBe(
      localized.pendingRoutes,
    );
  }
  await setup("/routes", <RoutesPage />);
  await expect
    .element(page.getByTestId("route-advertised-label-1"))
    .toHaveTextContent(copy.advertisedRoutes);
  expect(texts('[data-testid^="route-available-1-"]')).toEqual([
    "10.42.0.0/16",
    "172.16.0.0/12",
    "0.0.0.0/0",
    "::/0",
  ]);
  // Only unapproved routes are offered for approval.
  expect(texts('[data-testid^="pending-route-value-1-"]')).toEqual([
    "172.16.0.0/12",
    "0.0.0.0/0",
    "::/0",
  ]);
});

// Catches an exit route offered as two separately approvable rows while Headscale approves the pair.
test("a pending exit pair is one exit node with one approve control naming both routes", async () => {
  const ctx = await setup("/routes", <RoutesPage />);
  expect(texts('[data-testid^="approve-route-1-"]')).toEqual([
    copy.approveRoute,
    copy.approveExitNode,
  ]);
  await expect
    .element(page.getByTestId("pending-route-1-1"))
    .toMatchTextContent(copy.exitNode);
  await page.getByTestId("approve-route-1-1").click();
  const dialog = page.getByTestId("approve-route-dialog");
  await expect.element(dialog).toMatchTextContent(copy.approveExitNode);
  await expect
    .element(dialog)
    .toMatchTextContent(copy.approveExitRouteDescription);
  await expect
    .element(page.getByTestId("approve-route-target"))
    .toHaveTextContent("0.0.0.0/0");
  await expect
    .element(page.getByTestId("approve-route-paired"))
    .toHaveTextContent("::/0");
  await expect
    .element(page.getByTestId("approve-route-confirm"))
    .toHaveTextContent(copy.approveExitNode);
  await page.getByTestId("approve-route-confirm").click();
  await expect.element(dialog).not.toBeInTheDocument();
  // Headscale adds the paired prefix itself; the write names the route the dialog was opened for.
  expect(posts(ctx.calls).map((call) => call.body.routes)).toEqual([
    ["10.42.0.0/16", "0.0.0.0/0"],
  ]);
  expect(ctx.backend.nodes[0]?.approvedRoutes.toSorted()).toEqual([
    "0.0.0.0/0",
    "10.42.0.0/16",
    "::/0",
  ]);
  expect(texts('[data-testid^="pending-route-value-1-"]')).toEqual([
    "172.16.0.0/12",
  ]);
});

test("a subnet route keeps the single-route approval wording", async () => {
  await setup("/routes", <RoutesPage />);
  await page.getByTestId("approve-route-1-0").click();
  await expect
    .element(page.getByTestId("approve-route-dialog"))
    .toMatchTextContent(copy.approveRouteDescription);
  await expect
    .element(page.getByTestId("approve-route-target"))
    .toHaveTextContent("172.16.0.0/12");
  await expect
    .element(page.getByTestId("approve-route-paired"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("approve-route-confirm"))
    .toHaveTextContent(copy.approveRoute);
});

test("an exit row holding only the IPv6 route names IPv4 as its pair", async () => {
  await setup("/routes", <RoutesPage />, (backend) => {
    const target = backend.nodes[0];
    if (target) target.approvedRoutes = ["0.0.0.0/0"];
  });
  await page.getByTestId("approve-route-1-2").click();
  await expect
    .element(page.getByTestId("approve-route-target"))
    .toHaveTextContent("::/0");
  await expect
    .element(page.getByTestId("approve-route-paired"))
    .toHaveTextContent("0.0.0.0/0");
});

// Catches a singular "Revoke route" on a control that removes both exit routes.
test("revoking an exit route is labelled as revoking the exit node", async () => {
  await setup("/routes", <RoutesPage />, (backend) => {
    const target = backend.nodes[0];
    if (target) target.approvedRoutes = ["10.42.0.0/16", "0.0.0.0/0", "::/0"];
  });
  await expect
    .element(page.getByTestId("revoke-route-1-0"))
    .toHaveAttribute(
      "aria-label",
      `${copy.revokeRoute}: 10.42.0.0/16, edge-router`,
    );
  await expect
    .element(page.getByTestId("revoke-route-1-1"))
    .toHaveAttribute(
      "aria-label",
      `${copy.revokeExitNode}: 0.0.0.0/0, ::/0, edge-router`,
    );
  const paired = page.getByTestId("revoke-route-1-2");
  const label = `${copy.revokeExitNode}: 0.0.0.0/0, ::/0, edge-router`;
  for (
    let step = 0;
    step < 30 && document.activeElement !== paired.element();
    ++step
  )
    await userEvent.tab();
  await expect.element(paired).toHaveFocus();
  await expect.element(page.getByText(label, { exact: true })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByText(label, { exact: true }))
    .not.toBeInTheDocument();
  await expect.element(paired).toHaveFocus();
  await page.getByTestId("revoke-route-1-2").click();
  await expect
    .element(page.getByTestId("revoke-route-dialog"))
    .toMatchTextContent(copy.revokeExitNode);
  await expect
    .element(page.getByTestId("revoke-route-confirm"))
    .toHaveTextContent(copy.revokeExitNode);
  await page.getByTestId("revoke-route-cancel").click();
  await page.getByTestId("revoke-route-1-0").click();
  await expect
    .element(page.getByTestId("revoke-route-confirm"))
    .toHaveTextContent(copy.revokeRoute);
});

// Catches the devices link `/routes?node=<id>` landing at the top of a long list with no cue.
test("?node= scrolls to, highlights and focuses that node's card", async () => {
  await page.viewport(1024, 600);
  await setup("/routes?node=29", <RoutesPage />, manyNodes);
  const heading = page.getByTestId("route-node-heading-29");
  await expect.element(heading).toHaveFocus();
  await expect.poll(() => inViewport(heading.element())).toBe(true);
  await expect
    .element(page.getByTestId("route-node-29"))
    .toHaveAttribute("data-highlighted", "true");
  await expect
    .element(page.getByTestId("route-node-10"))
    .not.toHaveAttribute("data-highlighted");
});

test("?node= also works when arriving from another page", async () => {
  await page.viewport(1024, 600);
  const ctx = await setup("/routes", <RoutesPage />, manyNodes);
  await ctx.router.navigate({ to: "/home" });
  await expect.element(page.getByTestId("test-route")).toBeInTheDocument();
  await ctx.router.navigate({ to: "/routes", search: { node: "28" } });
  const heading = page.getByTestId("route-node-heading-28");
  await expect.element(heading).toHaveFocus();
  await expect.poll(() => inViewport(heading.element())).toBe(true);
});

test("an unknown ?node= id is ignored", async () => {
  await setup("/routes?node=404", <RoutesPage />);
  await expect.element(page.getByTestId("route-node-1")).toBeVisible();
  expect(document.querySelector("[data-highlighted]")).toBeNull();
  expect(document.activeElement).toBe(document.body);
});

// ---------------------------------------------------------------- Auth keys

// Catches a revoked one-time secret staying on screen with "copy it now" affordances.
test.each([
  ["expire", "expire-invite-dialog"],
  ["delete", "delete-invite-dialog"],
] as const)(
  "%s of the key shown once clears the created-key block",
  async (action, dialog) => {
    await setup("/invites", <InvitesPage />);
    await page.getByTestId("open-create-invite").click();
    await page.getByTestId("create-invite").click();
    await expect
      .element(page.getByTestId("created-invite"))
      .toMatchTextContent(SECRET);
    // Acting on another key leaves the secret alone.
    await page.getByTestId("invite-actions-trigger-1").click();
    await page.getByTestId(`${action}-invite-1`).click();
    await page.getByTestId("confirm-invite-action").click();
    await expect.element(page.getByTestId(dialog)).not.toBeInTheDocument();
    await expect.element(page.getByTestId("created-invite")).toBeVisible();
    await page.getByTestId("invite-actions-trigger-4").click();
    await page.getByTestId(`${action}-invite-4`).click();
    await page.getByTestId("confirm-invite-action").click();
    await expect.element(page.getByTestId(dialog)).not.toBeInTheDocument();
    await expect
      .element(page.getByTestId("created-invite"))
      .not.toBeInTheDocument();
  },
);

test("a legacy key listed in full is matched exactly", async () => {
  const ctx = await setup("/invites", <InvitesPage />, (backend) => {
    const key = backend.preAuthKeys[0];
    if (key) key.key = "0123456789abcdef0123456789abcdef0123456789abcdef";
  });
  ctx.session.deviceSetup.setState({
    lastCreatedInvite: "0123456789abcdef0123456789abcdef0123456789abcdef",
  });
  await page.getByTestId("invite-actions-trigger-1").click();
  await page.getByTestId("delete-invite-1").click();
  await page.getByTestId("confirm-invite-action").click();
  await expect
    .element(page.getByTestId("created-invite"))
    .not.toBeInTheDocument();
});

// Catches the only copy of a one-time secret being dropped when the next creation fails.
test("a failed creation keeps the previous secret", async () => {
  const ctx = await setup("/invites", <InvitesPage />);
  ctx.session.deviceSetup.setState({ lastCreatedInvite: "previous-secret" });
  await page.getByTestId("open-create-invite").click();
  ctx.fail("Create rejected");
  await page.getByTestId("create-invite").click();
  await expect.element(page.getByTestId("create-invite-error")).toBeVisible();
  await expect
    .element(page.getByTestId("created-invite"))
    .toMatchTextContent("previous-secret");
});

// 登录控制端点可能与 API 反向代理不同，切到认证密钥页不能把用户的选择换回 API 地址。
test("auth-key commands keep the login server selected in the device wizard", async () => {
  const ctx = await setup("/invites", <InvitesPage />);
  ctx.session.deviceSetup.setState({
    lastCreatedInvite: SECRET,
    loginServer: "https://control.example.test/",
  });
  await expect
    .element(page.getByTestId("created-invite"))
    .toMatchTextContent(
      `tailscale up --login-server 'https://control.example.test' --authkey '${SECRET}'`,
    );
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await page.getByTestId("copy-created-install-command").click();
  expect(write).toHaveBeenCalledWith(
    `tailscale up --login-server 'https://control.example.test' --authkey '${SECRET}'`,
  );
});

test("auth-key commands can edit their login server and hide invalid commands", async () => {
  const ctx = await setup("/invites", <InvitesPage />);
  ctx.session.deviceSetup.setState({ lastCreatedInvite: SECRET });
  const field = page.getByTestId("invite-login-server");
  await expect.element(field).toHaveValue("https://fixture.invalid");
  await field.fill("http://127.0.0.1:18080/");
  expect(ctx.session.deviceSetup.getSnapshot().loginServer).toBe(
    "http://127.0.0.1:18080/",
  );
  await expect
    .element(page.getByTestId("created-invite"))
    .toMatchTextContent(
      `tailscale up --login-server 'http://127.0.0.1:18080' --authkey '${SECRET}'`,
    );
  for (const invalid of ["", "ftp://control.example.test", "https://"]) {
    await field.fill(invalid);
    await expect.element(field).toHaveAttribute("aria-invalid", "true");
    await expect
      .element(page.getByTestId("invite-login-server-error"))
      .toBeVisible();
    await expect
      .element(page.getByTestId("copy-created-install-command"))
      .not.toBeInTheDocument();
    await expect.element(page.getByTestId("copy-created-invite")).toBeVisible();
  }
  await field.fill("https://control.example.test");
  await expect
    .element(page.getByTestId("invite-login-server-error"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("copy-created-install-command"))
    .toBeVisible();
});

// Catches the key created from the members page rendering below the fold with no focus.
test("arriving with a key to reveal scrolls to and focuses the created-key block", async () => {
  await page.viewport(1024, 600);
  const ctx = await setup("/invites", <InvitesPage />, manyKeys);
  await ctx.router.navigate({ to: "/home" });
  await expect.element(page.getByTestId("test-route")).toBeInTheDocument();
  ctx.session.deviceSetup.setState({
    lastCreatedInvite: SECRET,
    revealCreatedInvite: true,
  });
  await ctx.router.navigate({ to: "/invites" });
  const card = page.getByTestId("created-invite");
  await expect.element(card).toHaveFocus();
  await expect.poll(() => inViewport(card.element())).toBe(true);
  expect(ctx.session.deviceSetup.getSnapshot().revealCreatedInvite).toBe(false);
});

// Catches the generic create dialog issuing reusable keys by default.
test("the create dialog defaults to a one-time key", async () => {
  const ctx = await setup("/invites", <InvitesPage />);
  await page.getByTestId("open-create-invite").click();
  await expect.element(page.getByTestId("invite-reusable")).not.toBeChecked();
  await page.getByTestId("create-invite").click();
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  expect(posts(ctx.calls)[0]?.body.reusable).toBe(false);
});

test("owner options show the display name with the username", async () => {
  await setup("/invites", <InvitesPage />);
  await page.getByTestId("open-create-invite").click();
  expect(texts('[data-testid="invite-user"] option')).toEqual([
    "Alice Ops (alice)",
    "bob",
    copy.inviteNoOwner,
  ]);
});

// Catches the next open switching a tag-only key to the first user while keeping its tags.
test("the no-owner choice is remembered after a tag-only key is created", async () => {
  await setup("/invites", <InvitesPage />);
  await page.getByTestId("open-create-invite").click();
  await page.getByTestId("invite-user").selectOptions("");
  await page.getByTestId("invite-tags-search").fill("tag:server");
  await page.getByTestId("invite-tags-add").click();
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("invite-create-dialog"))
    .not.toBeInTheDocument();
  await page.getByTestId("open-create-invite").click();
  await expect.element(page.getByTestId("invite-user")).toHaveValue("");
  await expect
    .element(page.getByTestId("invite-tags-selected"))
    .toMatchTextContent("tag:server");
});

// Catches "Expire" offered on keys that can no longer be used.
test("expire is offered only for ready keys", async () => {
  await setup("/invites", <InvitesPage />);
  for (const [id, offered] of [
    ["1", true],
    ["2", false],
    ["3", false],
  ] as const) {
    await page.getByTestId(`invite-actions-trigger-${id}`).click();
    await expect.element(page.getByTestId(`delete-invite-${id}`)).toBeVisible();
    expect(
      document.querySelector(`[data-testid="expire-invite-${id}"]`) !== null,
    ).toBe(offered);
    await page.getByTestId(`delete-invite-${id}`).click();
    await page.getByTestId("cancel-invite-action").click();
    await expect
      .element(page.getByTestId("delete-invite-dialog"))
      .not.toBeInTheDocument();
  }
});

// Catches a confirmation naming the key as "hskey-auth-r...-***" with no owner.
test("expire and delete confirmations name the listed key and its owner", async () => {
  await setup("/invites", <InvitesPage />);
  await page.getByTestId("invite-actions-trigger-1").click();
  await page.getByTestId("expire-invite-1").click();
  await expect
    .element(page.getByTestId("invite-action-key"))
    .toHaveTextContent("hskey-auth-readyprefix1-***");
  await expect
    .element(page.getByTestId("invite-action-owner"))
    .toHaveTextContent(`${copy.inviteOwner}: Alice Ops`);
});

test("the all-keys filter option has its own wording", async () => {
  await setup("/invites", <InvitesPage />);
  expect(texts('[data-testid="invite-filter"] option')[0]).toBe(
    copy.allAuthKeys,
  );
  expect(copy.allAuthKeys).not.toBe(copy.invitesTitle);
});

// Catches an empty server telling the admin that filters hide its keys.
test("with no keys at all the empty state points to creating one", async () => {
  await setup("/invites", <InvitesPage />, (backend) => {
    backend.preAuthKeys = [];
  });
  await expect
    .element(page.getByTestId("invite-table"))
    .toMatchTextContent(copy.noAuthKeysYet);
  expect(page.getByTestId("invite-table").element().textContent).not.toContain(
    copy.noAuthKeys,
  );
  await page.getByTestId("empty-create-invite").click();
  await expect.element(page.getByTestId("invite-create-dialog")).toBeVisible();
});

// ---------------------------------------------------------------- Overview

// Catches a pending-only count labelled as every advertised route (review #13/#75).
test("the overview route stat is labelled as pending routes", async () => {
  await setup("/home", <HomePage />);
  await expect
    .element(page.getByTestId("overview-stat-routes"))
    .toMatchTextContent(copy.pendingRoutes);
  await expect
    .element(page.getByTestId("overview-stat-routes"))
    .toMatchTextContent("3");
});

test.each([
  ["overview-stat-online", "/devices"],
  ["overview-stat-total", "/devices"],
  ["overview-stat-users", "/members"],
  ["overview-stat-invites", "/invites"],
  ["overview-stat-routes", "/routes"],
] as const)("the %s card links to %s", async (testId, pathname) => {
  const ctx = await setup("/home", <HomePage />);
  await page.getByTestId(testId).click();
  await expect.poll(() => ctx.router.state.location.pathname).toBe(pathname);
});

test("a recent device card opens the devices page searched for that device", async () => {
  const ctx = await setup("/home", <HomePage />);
  await page.getByTestId("recent-device-1").click();
  await expect.poll(() => ctx.router.state.location.pathname).toBe("/devices");
  expect(ctx.router.state.location.search).toEqual({ search: "edge-router" });
});

// Catches a 63-character host name pushing the card and its status badge off a phone screen.
test("long device and owner names are truncated inside the card", async () => {
  await page.viewport(375, 700);
  const long = "a".repeat(63);
  await setup("/home", <HomePage />, (backend) => {
    const target = backend.nodes[0];
    if (target) {
      target.givenName = long;
      target.user = { id: "1", name: `${long}@example.com` };
    }
  });
  const card = page.getByTestId("recent-device-1");
  await expect.element(card).toMatchTextContent(long);
  expect(card.element().getBoundingClientRect().right).toBeLessThanOrEqual(
    window.innerWidth,
  );
  const badge = page
    .getByTestId("recent-device-status-1")
    .element()
    .getBoundingClientRect();
  expect(badge.right).toBeLessThanOrEqual(
    card.element().getBoundingClientRect().right,
  );
});
