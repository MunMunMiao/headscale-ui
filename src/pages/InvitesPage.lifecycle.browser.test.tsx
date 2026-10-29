import "fake-indexeddb/auto";
import type { FetchHandle } from "@defjs/core";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { type ReactNode, Suspense, useLayoutEffect, useRef } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { type HeadscaleSnapshot, normalizePreAuthKey } from "@/api/contracts";
import { useInviteTagReturn } from "@/composables/useCreatePreAuthKey";
import { i18n, setLocale } from "@/i18n";
import { parseSearch, stringifySearch } from "@/router/search";
import {
  authenticateTestSession,
  prepareTestSession,
  SessionTestProviders,
} from "@/test/session";
import AccessPage from "./AccessPage";
import InvitesPage from "./InvitesPage";
import MembersPage from "./MembersPage";

const NOW = Date.parse("2027-03-01T12:00:00Z");
const EXPIRATION = new Date(2027, 2, 8, 4, 5).toISOString();
const PRIOR_SECRET = "hskey-auth-prior-lifecycle-one-time-secret";
const alice = { id: "1", name: "alice" };
const bob = { id: "2", name: "bob" };

function InviteReturnProbe({
  restored,
  capture,
  onMount,
}: {
  restored: Parameters<typeof useInviteTagReturn>[1];
  capture?: (adapter: ReturnType<typeof useInviteTagReturn>) => void;
  onMount?: () => void;
}) {
  const context = useRef(0);
  const adapter = useInviteTagReturn("invite", restored, context);
  capture?.(adapter);
  useLayoutEffect(() => onMount?.(), [onMount]);
  return <div data-testid="return-probe" />;
}

function ReturningSource({
  restored,
  suspended,
  rendering,
}: {
  restored: Parameters<typeof useInviteTagReturn>[1];
  suspended: () => boolean;
  rendering: Promise<void>;
}) {
  const context = useRef(0);
  useInviteTagReturn("invite", restored, context);
  if (suspended()) throw rendering;
  return <div data-testid="return-source-ready">Ready</div>;
}

async function setup(
  source: "invites" | "members" = "invites",
  probe?: ReactNode,
  accessLoad?: Promise<void>,
) {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const backend: HeadscaleSnapshot = {
    health: { databaseConnectivity: true, serverReachable: true },
    version: { version: "0.29.4" },
    users: [alice, bob],
    nodes: [],
    apiKeys: [],
    policy: { policy: '{"tagOwners":{"tag:known":[]},"acls":[]}' },
    preAuthKeys: [
      normalizePreAuthKey({
        id: "7",
        key: PRIOR_SECRET,
        user: alice,
        reusable: true,
        used: false,
        ephemeral: false,
        expiration: "2099-01-01T00:00:00Z",
        aclTags: ["tag:old"],
      }),
    ],
  };
  const writes: Array<{
    method: string;
    path: string;
    body: Record<string, unknown>;
  }> = [];
  const reads: string[] = [];
  let createMode: "success" | "drop" | "reject" = "success";
  let stopMode: "success" | "drop" = "success";
  let failPolicyWrite = false;
  let failedRead = "";
  let failAfterCreate = "";
  let heldRead: Promise<void> | undefined;
  let heldPolicy: Promise<void> | undefined;
  let heldWrite: Promise<void> | undefined;
  const transport: FetchHandle = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method !== "GET") {
      const body =
        request.method === "DELETE"
          ? {}
          : ((await request.json()) as Record<string, unknown>);
      writes.push({ method: request.method, path, body });
      if (heldWrite) await heldWrite;
      if (path === "/api/v1/policy" && request.method === "PUT") {
        if (failPolicyWrite)
          return Response.json(
            { code: 3, message: "policy is read-only in file mode" },
            { status: 400 },
          );
        backend.policy = { policy: String(body.policy) };
        return Response.json(backend.policy);
      }
      if (path === "/api/v1/policy/check") return Response.json({});
      if (
        (request.method === "POST" && path === "/api/v1/preauthkey/expire") ||
        (request.method === "DELETE" && path === "/api/v1/preauthkey")
      ) {
        const id =
          request.method === "DELETE"
            ? new URL(request.url).searchParams.get("id")
            : body.id;
        const key = backend.preAuthKeys.find(
          (candidate) => candidate.id === id,
        );
        if (!key) throw new Error("Unknown fixture key");
        if (request.method === "DELETE")
          backend.preAuthKeys = backend.preAuthKeys.filter(
            (candidate) => candidate.id !== id,
          );
        else key.expiration = "2000-01-01T00:00:00Z";
        if (stopMode === "drop")
          throw new TypeError("Response lost after key stop");
        return Response.json({});
      }
      if (path === "/api/v1/preauthkey") {
        if (createMode === "reject")
          return Response.json(
            { code: 3, message: "invalid tag" },
            { status: 400 },
          );
        const created = normalizePreAuthKey({
          ...body,
          id: String(backend.preAuthKeys.length + 7),
          key: "hskey-auth-new-synthetic-one-time-secret",
          user: backend.users.find((user) => user.id === body.user),
          used: false,
        });
        backend.preAuthKeys.push(created);
        if (failAfterCreate) failedRead = failAfterCreate;
        if (createMode === "drop") {
          backend.preAuthKeys.push({
            ...created,
            id: "concurrent-same-options",
            key: "hskey-auth-other-synthetic-secret",
          });
          throw new TypeError("Response lost after upstream creation");
        }
        return Response.json({ preAuthKey: created });
      }
      throw new Error(`Unexpected write ${request.method} ${path}`);
    }
    reads.push(path);
    if (heldRead && path === "/api/v1/preauthkey") await heldRead;
    if (heldPolicy && path === "/api/v1/policy") await heldPolicy;
    if (path === failedRead)
      return Response.json({ message: "Read unavailable" }, { status: 503 });
    const values: Record<string, unknown> = {
      "/api/v1/health": backend.health,
      "/version": backend.version,
      "/api/v1/user": { users: backend.users },
      "/api/v1/node": { nodes: backend.nodes },
      "/api/v1/apikey": { apiKeys: [] },
      "/api/v1/preauthkey": { preAuthKeys: backend.preAuthKeys },
      "/api/v1/policy": backend.policy,
    };
    if (!(path in values)) throw new Error(`Unexpected GET ${path}`);
    return Response.json(values[path]);
  };
  const session = await prepareTestSession(transport);
  await setLocale("en-US");
  // The notification region name is a shared label that is not in the compiled catalog yet.
  i18n.load("en-US", { "common.notifications": "Notifications" });
  await authenticateTestSession(session);
  const root = createRootRoute({ component: Outlet });
  const routes = [
    createRoute({
      getParentRoute: () => root,
      path: "/invites",
      component: InvitesPage,
    }),
    createRoute({
      getParentRoute: () => root,
      path: "/members",
      component: MembersPage,
    }),
    createRoute({
      getParentRoute: () => root,
      path: "/access",
      component: accessLoad
        ? lazyRouteComponent(async () => {
            await accessLoad;
            return { default: AccessPage };
          })
        : AccessPage,
    }),
    createRoute({
      getParentRoute: () => root,
      path: "/probe",
      component: () => probe ?? null,
    }),
    createRoute({
      getParentRoute: () => root,
      path: "/devices",
      component: () => <div data-testid="device-destination">Devices</div>,
    }),
  ];
  const router = createRouter({
    routeTree: root.addChildren(routes),
    parseSearch,
    stringifySearch,
    history: createMemoryHistory({ initialEntries: [`/${source}`] }),
  });
  await router.load();
  await render(
    <SessionTestProviders session={session}>
      <RouterProvider router={router} />
    </SessionTestProviders>,
  );
  await expect.poll(() => session.snapshot.getSnapshot().isReady).toBe(true);
  await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
  session.deviceSetup.setState({ lastCreatedInvite: PRIOR_SECRET });
  return {
    backend,
    session,
    router,
    writes,
    reads,
    createMode: (mode: typeof createMode) => {
      createMode = mode;
    },
    stopMode: (mode: typeof stopMode) => {
      stopMode = mode;
    },
    failPolicyWrite: () => {
      failPolicyWrite = true;
    },
    failRead: (path: string) => {
      failedRead = path;
    },
    failAfterCreate: (path: string) => {
      failAfterCreate = path;
    },
    holdRead: (promise: Promise<void> | undefined) => {
      heldRead = promise;
    },
    holdWrite: (promise: Promise<void> | undefined) => {
      heldWrite = promise;
    },
    holdPolicy: (promise: Promise<void> | undefined) => {
      heldPolicy = promise;
    },
  };
}

function notifications() {
  return page.getByRole("region", { name: "Notifications", exact: true });
}

async function open(source: "invites" | "members") {
  if (source === "invites")
    await page.getByTestId("open-create-invite").click();
  else {
    await page.getByTestId("member-actions-trigger-bob").click();
    await page.getByTestId("create-invite-for-member-bob").click();
  }
  await expect.element(page.getByTestId("invite-create-dialog")).toBeVisible();
}
async function addTag(tag: string) {
  await page.getByTestId("invite-tags-search").fill(tag);
  await page.getByTestId("invite-tags-add").click();
}
async function submitKeyStop(action: "expire" | "delete", id = "7") {
  await page.getByTestId(`invite-actions-trigger-${id}`).click();
  await page.getByTestId(`${action}-invite-${id}`).click();
  await page.getByTestId("confirm-invite-action").click();
}
async function editInvitation() {
  await page.getByTestId("invite-user").selectOptions("1");
  await page.getByTestId("invite-reusable").click();
  await page.getByTestId("invite-ephemeral").click();
  await addTag("tag:roundtrip");
  await addTag("tag:1abc");
  await page.getByTestId("invite-expiration").click();
  await page.getByTestId("invite-expiration-hour").selectOptions("04");
  await page.getByTestId("invite-expiration-minute").selectOptions("05");
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("invite-tags-search").fill("tag:uncommitted");
}

async function closeAccessDetail() {
  if (document.querySelector('[data-testid="tag-detail-dialog"]')) {
    await page.getByTestId("tag-detail-close").click();
    await expect
      .element(page.getByTestId("tag-detail-dialog"))
      .not.toBeInTheDocument();
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await page.viewport(1280, 720);
});

test("same-origin history does not consume a departure still awaiting navigation approval", async () => {
  const loading = Promise.withResolvers<void>();
  const approval = Promise.withResolvers<boolean>();
  const ctx = await setup("invites", undefined, loading.promise);
  const unblock = ctx.router.history.block({
    blockerFn: ({ nextLocation }) =>
      nextLocation.pathname === "/access" ? approval.promise : false,
  });
  await open("invites");
  await addTag("tag:roundtrip");
  try {
    await page.getByTestId("invite-tags-define-tag:roundtrip").click();
    await expect
      .element(page.getByTestId("invite-create-dialog"))
      .not.toBeInTheDocument();
    ctx.router.history.replace(ctx.router.history.location.href);
    await expect.poll(() => ctx.router.state.isLoading).toBe(false);
    await expect
      .element(page.getByTestId("invite-create-dialog"))
      .not.toBeInTheDocument();
    expect(ctx.session.tagLifecycle.getSnapshot().returnTo?.status).toBe(
      "managing",
    );
    approval.resolve(false);
    await expect.poll(() => ctx.router.state.location.pathname).toBe("/access");
    ctx.router.history.back();
    await expect
      .element(page.getByTestId("invite-create-dialog"))
      .toBeVisible();
    await expect
      .poll(() => ctx.session.tagLifecycle.getSnapshot().returnTo)
      .toBeNull();
    expect(ctx.writes).toEqual([]);
  } finally {
    approval.resolve(false);
    loading.resolve();
    unblock();
  }
});

test.each(["invites", "members"] as const)(
  "%s restores the newer departure after repeated same-URL management while Access is still lazy-loading",
  async (source) => {
    const loading = Promise.withResolvers<void>();
    const ctx = await setup(source, undefined, loading.promise);
    try {
      await open(source);
      await addTag("tag:roundtrip");
      await page.getByTestId("invite-tags-define-tag:roundtrip").click();
      await expect
        .element(page.getByTestId("invite-create-dialog"))
        .not.toBeInTheDocument();
      const first = ctx.session.tagLifecycle.getSnapshot().returnTo?.id;
      await open(source);
      await addTag("tag:roundtrip");
      await page.getByTestId("invite-ephemeral").click();
      await page.getByTestId("invite-tags-define-tag:roundtrip").click();
      await expect
        .element(page.getByTestId("invite-create-dialog"))
        .not.toBeInTheDocument();
      const newer = ctx.session.tagLifecycle.getSnapshot().returnTo;
      expect(newer?.id).not.toBe(first);
      expect(newer).toMatchObject({ form: { ephemeral: true } });
      ctx.router.history.back();
      await expect
        .element(page.getByTestId("invite-create-dialog"))
        .toBeVisible();
      await expect.element(page.getByTestId("invite-ephemeral")).toBeChecked();
      await expect
        .poll(() => ctx.session.tagLifecycle.getSnapshot().returnTo)
        .toBeNull();
      expect(ctx.writes).toEqual([]);
    } finally {
      loading.resolve();
    }
  },
);

for (const source of ["invites", "members"] as const) {
  test(`${source} restores a second same-URL handoff after Back and Forward while Access is still lazy-loading`, async () => {
    const loading = Promise.withResolvers<void>();
    const policy = Promise.withResolvers<void>();
    const ctx = await setup(source, undefined, loading.promise);
    try {
      await open(source);
      await editInvitation();
      await page.getByTestId("invite-tags-manage").click();
      await expect
        .element(page.getByTestId("invite-create-dialog"))
        .not.toBeInTheDocument();
      const firstId = ctx.session.tagLifecycle.getSnapshot().returnTo?.id;
      const destination = ctx.router.history.location.href;
      const reads = ctx.reads.filter(
        (path) => path === "/api/v1/policy",
      ).length;
      ctx.holdPolicy(policy.promise);
      ctx.router.history.back();
      await expect
        .poll(() => ctx.session.snapshot.getSnapshot().segmentStatus)
        .toMatchObject({ identity: "ready", policy: "loading" });
      await expect
        .poll(
          () => ctx.reads.filter((path) => path === "/api/v1/policy").length,
        )
        .toBe(reads + 1);
      ctx.router.history.forward();
      await expect
        .poll(() => ctx.router.state.location.pathname)
        .toBe("/access");
      ctx.holdPolicy(undefined);
      policy.resolve();
      await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
      await expect
        .element(page.getByTestId("invite-create-dialog"))
        .not.toBeInTheDocument();
      expect(ctx.session.tagLifecycle.getSnapshot().returnTo?.id).toBe(firstId);
      expect(ctx.router.state.location.pathname).toBe("/access");
      await open(source);
      await page.getByTestId("invite-user").selectOptions("2");
      await addTag("tag:replacement");
      await page
        .getByTestId("invite-tags-search")
        .fill("tag:second-unblurred-input");
      await page.getByTestId("invite-tags-manage").click();
      await expect
        .element(page.getByTestId("invite-create-dialog"))
        .not.toBeInTheDocument();
      const second = ctx.session.tagLifecycle.getSnapshot().returnTo;
      expect(second?.id).not.toBe(firstId);
      expect(second).toMatchObject({
        form: {
          userId: "2",
          tags: ["tag:replacement"],
          tagInput: "tag:second-unblurred-input",
          reusable: false,
          ephemeral: false,
        },
      });
      expect(ctx.router.history.location.href).toBe(destination);
      await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
      expect(ctx.session.tagLifecycle.getSnapshot().returnTo?.id).toBe(
        second?.id,
      );
      expect(ctx.router.state.location.pathname).toBe("/access");
      await expect
        .element(page.getByTestId("invite-create-dialog"))
        .not.toBeInTheDocument();
      ctx.router.history.back();
      await expect
        .element(page.getByTestId("invite-create-dialog"))
        .toBeVisible();
      await expect.element(page.getByTestId("invite-user")).toHaveValue("2");
      await expect
        .element(page.getByTestId("invite-tags-search"))
        .toHaveValue("tag:second-unblurred-input");
      await expect
        .element(page.getByTestId("invite-tags-selected"))
        .toMatchTextContent("tag:replacement");
      await expect
        .element(page.getByTestId("invite-reusable"))
        .not.toBeChecked();
      await expect
        .element(page.getByTestId("invite-ephemeral"))
        .not.toBeChecked();
      await expect
        .poll(() => ctx.session.tagLifecycle.getSnapshot().returnTo)
        .toBeNull();
      expect(ctx.writes).toEqual([]);
    } finally {
      ctx.holdPolicy(undefined);
      policy.resolve();
      loading.resolve();
    }
  });

  test(`${source} cannot restore a pending return read after Forward leaves the source while Access is lazy-loading`, async () => {
    const loading = Promise.withResolvers<void>();
    const policy = Promise.withResolvers<void>();
    const ctx = await setup(source, undefined, loading.promise);
    try {
      await open(source);
      await editInvitation();
      await page.getByTestId("invite-tags-define-tag:roundtrip").click();
      await expect
        .element(page.getByTestId("invite-create-dialog"))
        .not.toBeInTheDocument();
      const returning = ctx.session.tagLifecycle.getSnapshot().returnTo;
      ctx.holdPolicy(policy.promise);
      ctx.router.history.back();
      await expect
        .poll(() => ctx.session.snapshot.getSnapshot().segmentStatus)
        .toMatchObject({
          identity: "ready",
          policy: "loading",
        });
      ctx.router.history.forward();
      await expect
        .poll(() => ctx.router.state.location.pathname)
        .toBe("/access");
      ctx.holdPolicy(undefined);
      policy.resolve();
      await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
      await expect
        .element(page.getByTestId("invite-create-dialog"))
        .not.toBeInTheDocument();
      expect(ctx.router.state.location.pathname).toBe("/access");
      expect(ctx.session.tagLifecycle.getSnapshot().returnTo?.id).toBe(
        returning?.id,
      );
      expect(ctx.writes).toEqual([]);
      ctx.router.history.back();
      await expect
        .element(page.getByTestId("invite-create-dialog"))
        .toBeVisible();
      await expect
        .element(page.getByTestId("invite-tags-search"))
        .toHaveValue("tag:uncommitted");
      await expect
        .poll(() => ctx.session.tagLifecycle.getSnapshot().returnTo)
        .toBeNull();
      expect(ctx.writes).toEqual([]);
    } finally {
      ctx.holdPolicy(undefined);
      policy.resolve();
      loading.resolve();
    }
  });

  test.each([false, true])(
    `${source} keeps the first edit baseline across same-turn Forward and Back with newer input=%s`,
    async (newer) => {
      const loading = Promise.withResolvers<void>();
      const firstPolicy = Promise.withResolvers<void>();
      const nextPolicy = Promise.withResolvers<void>();
      const ctx = await setup(source, undefined, loading.promise);
      try {
        await open(source);
        await editInvitation();
        await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
        await page.getByTestId("invite-tags-define-tag:roundtrip").click();
        await expect
          .element(page.getByTestId("invite-create-dialog"))
          .not.toBeInTheDocument();
        const id = ctx.session.tagLifecycle.getSnapshot().returnTo?.id;
        const readsBeforeReturn = ctx.reads.filter(
          (path) => path === "/api/v1/policy",
        ).length;
        ctx.holdPolicy(firstPolicy.promise);
        ctx.router.history.back();
        await expect
          .poll(() => ctx.session.snapshot.getSnapshot().segmentStatus)
          .toMatchObject({
            identity: "ready",
            policy: "loading",
          });
        await expect
          .poll(
            () => ctx.reads.filter((path) => path === "/api/v1/policy").length,
          )
          .toBe(readsBeforeReturn + 1);
        const reads = readsBeforeReturn + 1;
        const search = page
          .getByTestId(source === "invites" ? "invite-search" : "user-search")
          .element() as HTMLInputElement;
        ctx.holdPolicy(nextPolicy.promise);
        if (newer) {
          const setValue = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
          )?.set;
          expect.assert(setValue);
          setValue.call(search, "newer input across history ABA");
          search.dispatchEvent(new Event("input", { bubbles: true }));
        }
        ctx.router.history.forward();
        ctx.router.history.back();
        if (newer) {
          await expect
            .element(page.getByTestId("invite-return-newer"))
            .toBeVisible();
          expect(search.value).toBe("newer input across history ABA");
          expect(
            ctx.reads.filter((path) => path === "/api/v1/policy"),
          ).toHaveLength(reads);
          await page.getByTestId("invite-return-retry").click();
        }
        await expect
          .poll(
            () => ctx.reads.filter((path) => path === "/api/v1/policy").length,
          )
          .toBe(reads + 1);
        // A newer segment read aborts the first request; its completion must not clear this one.
        await expect
          .poll(
            () => ctx.session.snapshot.getSnapshot().refreshSnapshotInFlight,
          )
          .toBe(1);
        firstPolicy.resolve();
        await expect
          .poll(
            () => ctx.session.snapshot.getSnapshot().refreshSnapshotInFlight,
          )
          .toBe(1);
        await expect
          .element(page.getByTestId("invite-create-dialog"))
          .not.toBeInTheDocument();
        await expect
          .element(page.getByTestId("invite-return-error"))
          .not.toBeInTheDocument();
        expect(ctx.session.tagLifecycle.getSnapshot().returnTo?.id).toBe(id);
        ctx.holdPolicy(undefined);
        nextPolicy.resolve();
        await expect
          .element(page.getByTestId("invite-create-dialog"))
          .toBeVisible();
        await expect
          .element(page.getByTestId("invite-tags-search"))
          .toHaveValue("tag:uncommitted");
        await expect
          .poll(() => ctx.session.tagLifecycle.getSnapshot().returnTo)
          .toBeNull();
        expect(ctx.router.state.location.pathname).toBe(`/${source}`);
        expect(ctx.writes).toEqual([]);
      } finally {
        ctx.holdPolicy(undefined);
        firstPolicy.resolve();
        nextPolicy.resolve();
        loading.resolve();
      }
    },
  );

  test.each([false, true])(
    `${source} handles same-turn Back without losing history events or newer input=%s`,
    async (newer) => {
      const loading = Promise.withResolvers<void>();
      const ctx = await setup(source, undefined, loading.promise);
      await open(source);
      await editInvitation();
      const manage = page
        .getByTestId("invite-tags-define-tag:roundtrip")
        .element() as HTMLButtonElement;
      const search = page
        .getByTestId(source === "invites" ? "invite-search" : "user-search")
        .element() as HTMLInputElement;
      try {
        // Queue both native interactions before React can commit the intermediate destination URL.
        manage.click();
        if (newer) {
          const setValue = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
          )?.set;
          expect.assert(setValue);
          setValue.call(search, "same-turn newer input");
          search.dispatchEvent(new Event("input", { bubbles: true }));
        }
        ctx.router.history.back();
        await expect
          .poll(() => ctx.router.state.location.pathname)
          .toBe(`/${source}`);
        if (newer) {
          await expect
            .element(page.getByTestId("invite-return-newer"))
            .toBeVisible();
          await expect
            .element(page.getByTestId("invite-create-dialog"))
            .not.toBeInTheDocument();
          expect(search.value).toBe("same-turn newer input");
          expect(
            ctx.session.tagLifecycle.getSnapshot().returnTo,
          ).not.toBeNull();
          await page.getByTestId("invite-return-retry").click();
        }
        await expect
          .poll(() => ctx.session.tagLifecycle.getSnapshot().returnTo)
          .toBeNull();
        await expect
          .element(page.getByTestId("invite-create-dialog"))
          .toBeVisible();
        await expect
          .element(page.getByTestId("invite-tags-search"))
          .toHaveValue("tag:uncommitted");
        expect(ctx.writes).toEqual([]);
      } finally {
        loading.resolve();
      }
      await expect.poll(() => ctx.router.state.isLoading).toBe(false);
      expect(ctx.router.state.location.pathname).toBe(`/${source}`);
    },
  );

  test.each(["unchanged", "newer-filter"] as const)(
    `${source} handles Back before the Access importer resolves with %s source input`,
    async (change) => {
      const loading = Promise.withResolvers<void>();
      const ctx = await setup(source, undefined, loading.promise);
      await open(source);
      await editInvitation();
      try {
        await page.getByTestId("invite-tags-define-tag:roundtrip").click();
        await expect
          .element(page.getByTestId("invite-create-dialog"))
          .not.toBeInTheDocument();
        const search = page.getByTestId(
          source === "invites" ? "invite-search" : "user-search",
        );
        await expect.element(search).toBeVisible();
        if (change === "newer-filter") await search.fill("newer source input");
        ctx.router.history.back();
        await expect
          .poll(() => ctx.router.state.location.pathname)
          .toBe(`/${source}`);
        if (change === "newer-filter") {
          await expect
            .element(page.getByTestId("invite-return-newer"))
            .toBeVisible();
          await expect
            .element(page.getByTestId("invite-create-dialog"))
            .not.toBeInTheDocument();
          await expect.element(search).toHaveValue("newer source input");
          expect(
            ctx.session.tagLifecycle.getSnapshot().returnTo,
          ).not.toBeNull();
          await page.getByTestId("invite-return-retry").click();
        }
        await expect
          .element(page.getByTestId("invite-create-dialog"))
          .toBeVisible();
        await expect.element(page.getByTestId("invite-user")).toHaveValue("1");
        await expect.element(page.getByTestId("invite-reusable")).toBeChecked();
        await expect
          .element(page.getByTestId("invite-ephemeral"))
          .toBeChecked();
        await expect
          .element(page.getByTestId("invite-tags-search"))
          .toHaveValue("tag:uncommitted");
        expect(ctx.session.tagLifecycle.getSnapshot().returnTo).toBeNull();
        expect(ctx.writes).toEqual([]);
      } finally {
        loading.resolve();
      }
      await expect.poll(() => ctx.router.state.isLoading).toBe(false);
      expect(ctx.router.state.location.pathname).toBe(`/${source}`);
      await expect
        .element(page.getByTestId("invite-create-dialog"))
        .toBeVisible();
      expect(ctx.writes).toEqual([]);
    },
  );

  test(`${source} leaves its draft managing while Access lazy-loads and restores only after Back`, async () => {
    const loading = Promise.withResolvers<void>();
    const ctx = await setup(source, undefined, loading.promise);
    await open(source);
    await editInvitation();
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
    let outgoing: ReturnType<
      typeof ctx.session.tagLifecycle.getSnapshot
    >["returnTo"] = null;
    try {
      await page.getByTestId("invite-tags-define-tag:roundtrip").click();
      // Only the destination module is delayed; normal identity/policy reads may complete.
      await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
      await expect
        .element(page.getByTestId("invite-create-dialog"))
        .not.toBeInTheDocument();
      outgoing = ctx.session.tagLifecycle.getSnapshot().returnTo;
      expect(outgoing).toMatchObject({
        source: source === "invites" ? "invite" : "member-invite",
        status: "managing",
        form: {
          userId: "1",
          userName: "alice",
          tags: ["tag:roundtrip", "tag:1abc"],
          reusable: true,
          ephemeral: true,
          expiration: EXPIRATION,
          tagInput: "tag:uncommitted",
        },
      });
      expect(ctx.router.state.location.pathname).toBe("/access");
      await expect
        .element(
          page.getByTestId(
            source === "invites" ? "invite-search" : "user-search",
          ),
        )
        .toBeVisible();
      await expect
        .element(page.getByTestId("tag-management-return"))
        .not.toBeInTheDocument();
      expect(ctx.writes).toEqual([]);
      expect(JSON.stringify(outgoing)).not.toContain(PRIOR_SECRET);
    } finally {
      loading.resolve();
    }
    await expect
      .element(page.getByTestId("tag-management-return"))
      .toBeVisible();
    expect(ctx.session.tagLifecycle.getSnapshot().returnTo).toEqual(outgoing);
    await closeAccessDetail();
    ctx.router.history.back();
    await expect
      .element(page.getByTestId("invite-create-dialog"))
      .toBeVisible();
    expect(ctx.router.state.location.pathname).toBe(`/${source}`);
    await expect.element(page.getByTestId("invite-user")).toHaveValue("1");
    await expect.element(page.getByTestId("invite-reusable")).toBeChecked();
    await expect.element(page.getByTestId("invite-ephemeral")).toBeChecked();
    await expect
      .element(page.getByTestId("invite-tags-search"))
      .toHaveValue("tag:uncommitted");
    await expect
      .element(page.getByTestId("invite-tags-selected"))
      .toMatchTextContent("tag:1abc");
    expect(ctx.session.tagLifecycle.getSnapshot().returnTo).toBeNull();
    await page.getByTestId("cancel-create-invite").click();
    await ctx.router.navigate({ to: "/access" });
    ctx.router.history.back();
    await expect
      .poll(() => ctx.router.state.location.pathname)
      .toBe(`/${source}`);
    await expect
      .element(page.getByTestId("invite-create-dialog"))
      .not.toBeInTheDocument();
    expect(ctx.writes).toEqual([]);
  });

  test.each(["back", "cancel", "save", "failed-save"] as const)(
    `${source} host restores all nonsecret fields after Access %s and never auto-creates`,
    async (ending) => {
      const ctx = await setup(source);
      if (source === "invites") {
        await ctx.router.navigate({
          to: "/invites",
          search: { filter: "ready", tag: "tag:old" },
        });
        await page.getByTestId("invite-search").fill("alice");
      } else await page.getByTestId("user-search").fill("bob");
      await open(source);
      await editInvitation();
      await page.getByTestId("invite-tags-define-tag:roundtrip").click();
      await expect
        .poll(() => ctx.router.state.location.pathname)
        .toBe("/access");
      const saved = ctx.session.tagLifecycle.getSnapshot().returnTo;
      expect(saved).toMatchObject({
        source: source === "members" ? "member-invite" : "invite",
        form: {
          userId: "1",
          userName: "alice",
          tags: ["tag:roundtrip", "tag:1abc"],
          reusable: true,
          ephemeral: true,
          expiration: EXPIRATION,
          tagInput: "tag:uncommitted",
        },
      });
      if (source === "members")
        expect(saved).toMatchObject({ memberId: "2", filter: "bob" });
      else
        expect(Object.fromEntries(new URLSearchParams(saved?.filter))).toEqual({
          filter: "ready",
          tag: "tag:old",
          q: "alice",
        });
      expect(JSON.stringify(saved)).not.toContain(PRIOR_SECRET);
      expect(ctx.router.state.location.href).not.toContain(PRIOR_SECRET);
      if (ending === "save" || ending === "failed-save") {
        if (!document.querySelector('[data-testid="tag-detail-dialog"]'))
          await page.getByTestId("tag-open-tag:roundtrip").click();
        await page.getByTestId("tag-declare").click();
        await closeAccessDetail();
        if (ending === "failed-save") ctx.failPolicyWrite();
        await page.getByTestId("save-policy").click();
        await page.getByTestId("policy-publication-confirm").click();
        await expect
          .poll(
            () => ctx.writes.filter((write) => write.method === "PUT").length,
          )
          .toBe(1);
        await expect.poll(() => ctx.session.policy.isPolicySaving).toBe(false);
      } else await closeAccessDetail();
      expect(
        ctx.writes.filter((write) => write.path === "/api/v1/preauthkey"),
      ).toHaveLength(0);
      const gate = Promise.withResolvers<void>();
      ctx.holdRead(gate.promise);
      if (ending === "back") ctx.router.history.back();
      else await page.getByTestId("tag-management-return").click();
      await expect
        .poll(() => ctx.router.state.location.pathname)
        .toBe(`/${source}`);
      await expect
        .element(page.getByTestId("invite-create-dialog"))
        .not.toBeInTheDocument();
      expect(ctx.session.tagLifecycle.getSnapshot().returnTo).not.toBeNull();
      ctx.holdRead(undefined);
      gate.resolve();
      await expect
        .element(page.getByTestId("invite-create-dialog"))
        .toBeVisible();
      await expect.element(page.getByTestId("invite-user")).toHaveValue("1");
      await expect.element(page.getByTestId("invite-reusable")).toBeChecked();
      await expect.element(page.getByTestId("invite-ephemeral")).toBeChecked();
      await expect
        .element(page.getByTestId("invite-tags-search"))
        .toHaveValue("tag:uncommitted");
      await expect
        .element(page.getByTestId("invite-tags-selected"))
        .toMatchTextContent("tag:1abc");
      expect(ctx.session.tagLifecycle.getSnapshot().returnTo).toBeNull();
      await expect
        .element(
          page.getByTestId(
            source === "invites" ? "invite-search" : "user-search",
          ),
        )
        .toHaveValue(source === "invites" ? "alice" : "bob");
      if (source === "invites")
        expect(ctx.router.state.location.search).toMatchObject({
          filter: "ready",
          tag: "tag:old",
        });
      expect(
        ctx.writes.filter((write) => write.path === "/api/v1/preauthkey"),
      ).toHaveLength(0);
      await page.getByTestId("create-invite").click();
      await expect
        .poll(
          () =>
            ctx.writes.filter((write) => write.path === "/api/v1/preauthkey")
              .length,
        )
        .toBe(1);
      expect(
        ctx.writes.find((write) => write.path === "/api/v1/preauthkey")?.body,
      ).toEqual({
        user: "1",
        reusable: true,
        ephemeral: true,
        expiration: EXPIRATION,
        aclTags: ["tag:roundtrip", "tag:1abc"],
      });
      await expect
        .element(page.getByTestId("invite-create-dialog"))
        .not.toBeInTheDocument();
      await ctx.router.navigate({ to: "/access" });
      ctx.router.history.back();
      await expect
        .poll(() => ctx.router.state.location.pathname)
        .toBe("/invites");
      await expect
        .element(page.getByTestId("invite-create-dialog"))
        .not.toBeInTheDocument();
    },
  );
}

test("failed return reads retain the original expiry and user rather than substituting or extending them", async () => {
  const ctx = await setup("members");
  await open("members");
  await editInvitation();
  await page.getByTestId("invite-expiration").click();
  const day = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[role="gridcell"] button'),
  ).find(
    (button) =>
      button.textContent?.trim() === "1" &&
      !button.closest('[data-outside="true"]'),
  );
  expect.assert(day);
  day.click();
  const expires = new Date(NOW + 5 * 60_000);
  await page
    .getByTestId("invite-expiration-hour")
    .selectOptions(String(expires.getHours()).padStart(2, "0"));
  await page
    .getByTestId("invite-expiration-minute")
    .selectOptions(String(expires.getMinutes()).padStart(2, "0"));
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("invite-tags-define-tag:roundtrip").click();
  await closeAccessDetail();
  const original = ctx.session.tagLifecycle.getSnapshot().returnTo;
  expect(original && "form" in original ? original.form.expiration : null).toBe(
    "2027-03-01T12:05:00.000Z",
  );
  ctx.backend.users = [bob];
  ctx.failRead("/api/v1/preauthkey");
  vi.mocked(Date.now).mockReturnValue(NOW + 10 * 60_000);
  await page.getByTestId("tag-management-return").click();
  await expect.element(page.getByTestId("invite-return-error")).toBeVisible();
  await expect
    .element(page.getByTestId("invite-create-dialog"))
    .not.toBeInTheDocument();
  expect(ctx.session.tagLifecycle.getSnapshot().returnTo?.source).toBe(
    "member-invite",
  );
  ctx.failRead("");
  await page.getByTestId("invite-return-retry").click();
  await expect.element(page.getByTestId("invite-user")).toHaveValue("1");
  await page.getByTestId("create-invite").click();
  await expect.element(page.getByTestId("invite-user-error")).toBeVisible();
  await expect
    .element(page.getByTestId("invite-expiration-error"))
    .toBeVisible();
  expect(ctx.writes).toEqual([]);
});

test.each(["expire", "delete"] as const)(
  "%s key-stop uncertainty leaves actions enabled and only asks for a manual key-list check",
  async (action) => {
    const ctx = await setup();
    ctx.backend.preAuthKeys.push({
      ...ctx.backend.preAuthKeys[0],
      id: "8",
      key: "hskey-auth-unrelated-same-options",
    });
    await ctx.session.snapshot.refreshSegments(["identity"]);
    ctx.stopMode("drop");
    await submitKeyStop(action);
    await expect
      .poll(() => ctx.session.feedback.isActionPending("invite-action"))
      .toBe(false);
    await expect
      .element(page.getByTestId("confirm-invite-action"))
      .toBeEnabled();
    const notice = page.getByTestId("invite-stop-notice");
    await expect.element(notice).toMatchTextContent(/Auth keys list/i);
    expect(notice.element().textContent).not.toContain(PRIOR_SECRET);
    expect(ctx.session.feedback.actionOutcome("invite-action")?.status).toBe(
      "unknown",
    );
    await page.getByTestId("cancel-invite-action").click();
    await expect
      .element(page.getByTestId(`${action}-invite-dialog`))
      .not.toBeInTheDocument();
    await ctx.router.navigate({ to: "/members" });
    await ctx.router.navigate({
      to: "/invites",
      search: { filter: "ready", tag: "tag:unrelated" },
    });
    await expect.element(notice).toBeVisible();
    await expect
      .element(page.getByTestId("invite-stop-review"))
      .not.toBeInTheDocument();
    expect(
      JSON.stringify(ctx.session.tagLifecycle.getSnapshot()),
    ).not.toContain("hskey-auth-");
    expect(ctx.writes).toHaveLength(1);
    await ctx.router.navigate({ to: "/invites" });
    ctx.stopMode("success");
    await submitKeyStop("delete", action === "expire" ? "7" : "8");
    await expect
      .element(page.getByTestId("delete-invite-dialog"))
      .not.toBeInTheDocument();
    expect(ctx.backend.preAuthKeys.map((key) => key.id)).toEqual(
      action === "expire" ? ["8"] : [],
    );
    expect(ctx.writes).toHaveLength(2);
  },
);

test("a key-stop success completed after leaving cannot clear a newer one-time secret", async () => {
  const ctx = await setup();
  const gate = Promise.withResolvers<void>();
  ctx.holdWrite(gate.promise);
  await submitKeyStop("expire");
  try {
    await expect.poll(() => ctx.writes.length).toBe(1);
    await ctx.router.navigate({ to: "/members" });
    ctx.session.deviceSetup.setState({
      lastCreatedInvite: "newer-secret-from-another-host",
    });
  } finally {
    gate.resolve();
  }
  await expect
    .poll(() => ctx.session.feedback.isActionPending("invite-action"))
    .toBe(false);
  expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe(
    "newer-secret-from-another-host",
  );
  expect(ctx.router.state.location.pathname).toBe("/members");
  expect(ctx.writes).toHaveLength(1);
});

test("a key-stop success cannot clear a newer shared secret even while its own page stays mounted", async () => {
  const ctx = await setup();
  const gate = Promise.withResolvers<void>();
  ctx.holdWrite(gate.promise);
  await submitKeyStop("expire");
  try {
    await expect.poll(() => ctx.writes.length).toBe(1);
    ctx.session.deviceSetup.setState({
      lastCreatedInvite: "newer-secret-on-the-same-page",
    });
  } finally {
    gate.resolve();
  }
  await expect
    .element(page.getByTestId("expire-invite-dialog"))
    .not.toBeInTheDocument();
  expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe(
    "newer-secret-on-the-same-page",
  );
  expect(ctx.writes).toHaveLength(1);
});

test("unknown creation leaves a plain notice across navigation and allows only explicit new submissions", async () => {
  const ctx = await setup();
  ctx.createMode("drop");
  await open("invites");
  await addTag("tag:roundtrip");
  await page.getByTestId("create-invite").click();
  await expect.element(page.getByTestId("invite-create-unknown")).toBeVisible();
  await expect.element(page.getByTestId("create-invite")).toBeEnabled();
  await expect
    .element(page.getByTestId("invite-create-new-operation"))
    .not.toBeInTheDocument();
  expect(
    ctx.session.deviceSetup.getSnapshot().lastCreatedInvite === PRIOR_SECRET,
  ).toBe(true);
  expect(
    JSON.stringify(ctx.session.tagLifecycle.getSnapshot()).includes(
      "hskey-auth-",
    ),
  ).toBe(false);
  expect(ctx.writes).toHaveLength(1);
  await page.getByTestId("invite-create-verify").click();
  await expect
    .poll(
      () =>
        document.querySelector('[data-testid="invite-create-dialog"]') === null,
    )
    .toBe(true);
  await expect.element(page.getByTestId("invite-table-shell")).toBeVisible();
  await ctx.router.navigate({ to: "/members" });
  await ctx.router.navigate({ to: "/invites" });
  await expect.element(page.getByTestId("invite-create-unknown")).toBeVisible();
  await expect
    .element(page.getByTestId("invite-create-verify"))
    .toHaveAttribute("href", "/invites");
  expect(ctx.writes).toHaveLength(1);
  ctx.createMode("success");
  await open("invites");
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("invite-create-dialog"))
    .not.toBeInTheDocument();
  expect(ctx.writes).toHaveLength(2);
  expect(
    ctx.writes.every(
      (write) => write.method === "POST" && write.path === "/api/v1/preauthkey",
    ),
  ).toBe(true);
});

test.each([
  ["/api/v1/node", "fabric"],
  ["/api/v1/policy", "policy"],
] as const)(
  "confirmed creation reports %s refresh failure without calling the key inventory stale",
  async (path, segment) => {
    const ctx = await setup();
    ctx.failAfterCreate(path);
    await open("invites");
    await page.getByTestId("create-invite").click();
    await expect
      .element(page.getByTestId("invite-create-dialog"))
      .not.toBeInTheDocument();
    expect(ctx.session.snapshot.getSnapshot().refreshErrors).toEqual({
      [segment]: "Read unavailable",
    });
    expect(ctx.session.snapshot.getSnapshot().segmentStatus.identity).toBe(
      "ready",
    );
    await expect
      .element(page.getByTestId("invite-created-refresh-failed"))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByTestId("created-invite-status"))
      .not.toBeInTheDocument();
    await expect.element(page.getByTestId("copy-created-invite")).toBeEnabled();
    expect(
      ctx.session.deviceSetup
        .getSnapshot()
        .lastCreatedInvite.startsWith("hskey-auth-new-"),
    ).toBe(true);
    expect(ctx.writes).toHaveLength(1);
  },
);

test("G27: a successful creation followed by a slow inventory read is unverified, not failed", async () => {
  const ctx = await setup();
  await open("invites");
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("invite-create-dialog"))
    .not.toBeInTheDocument();
  expect(ctx.session.feedback.actionOutcome("create-invite")).toMatchObject({
    status: "confirmed",
    refresh: "succeeded",
  });
  const secret = ctx.session.deviceSetup.getSnapshot().lastCreatedInvite;
  const copied = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const read = Promise.withResolvers<void>();
  ctx.holdRead(read.promise);
  try {
    await page.getByTestId("refresh-auth-keys").click();
    await expect
      .poll(() => ctx.session.snapshot.getSnapshot().segmentStatus.identity)
      .toBe("loading");
    expect(
      ctx.session.snapshot.getSnapshot().refreshErrors.identity,
    ).toBeUndefined();
    await expect
      .element(page.getByTestId("created-invite-status"))
      .toMatchTextContent("not verified");
    await expect.element(page.getByTestId("refresh-auth-keys")).toBeDisabled();
    await expect.element(page.getByTestId("copy-created-invite")).toBeEnabled();
    await page.getByTestId("copy-created-invite").click();
    expect(copied.mock.calls.some(([value]) => value === secret)).toBe(true);
    expect(
      ctx.session.deviceSetup.getSnapshot().lastCreatedInvite === secret,
    ).toBe(true);
    expect(ctx.writes).toHaveLength(1);
    await expect
      .element(page.getByTestId("invite-created-refresh-failed"))
      .not.toBeInTheDocument();
  } finally {
    ctx.holdRead(undefined);
    read.resolve();
  }
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  await expect
    .element(page.getByTestId("created-invite-status"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("invite-created-refresh-failed"))
    .not.toBeInTheDocument();
  expect(ctx.writes).toHaveLength(1);
  expect(
    ctx.session.deviceSetup.getSnapshot().lastCreatedInvite === secret,
  ).toBe(true);
});

test("G27: retrying a failed inventory read retains its known warning until a successful read", async () => {
  const ctx = await setup();
  ctx.failAfterCreate("/api/v1/preauthkey");
  await open("invites");
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("invite-created-refresh-failed"))
    .toBeVisible();
  const secret = ctx.session.deviceSetup.getSnapshot().lastCreatedInvite;
  ctx.failRead("");
  const read = Promise.withResolvers<void>();
  ctx.holdRead(read.promise);
  try {
    await page.getByTestId("invite-refresh-devices").click();
    await expect
      .poll(() => ctx.session.snapshot.getSnapshot().segmentStatus.identity)
      .toBe("loading");
    expect(
      ctx.session.snapshot.getSnapshot().refreshErrors.identity,
    ).toBeTruthy();
    await expect
      .element(page.getByTestId("invite-created-refresh-failed"))
      .toBeVisible();
    await expect.element(page.getByTestId("copy-created-invite")).toBeEnabled();
    expect(ctx.writes).toHaveLength(1);
  } finally {
    ctx.holdRead(undefined);
    read.resolve();
  }
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  expect(
    ctx.session.snapshot.getSnapshot().refreshErrors.identity,
  ).toBeUndefined();
  await expect
    .element(page.getByTestId("invite-created-refresh-failed"))
    .not.toBeInTheDocument();
  expect(
    ctx.session.deviceSetup.getSnapshot().lastCreatedInvite === secret,
  ).toBe(true);
  expect(ctx.writes).toHaveLength(1);
});

test("confirmed creation with a failed refresh keeps the secret and explains that no device has joined", async () => {
  const ctx = await setup();
  ctx.failAfterCreate("/api/v1/preauthkey");
  await open("invites");
  await addTag("tag:1abc");
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("invite-create-dialog"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("invite-created-refresh-failed"))
    .toBeVisible();
  await expect
    .element(page.getByTestId("invite-created-not-joined"))
    .toBeVisible();
  expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe(
    "hskey-auth-new-synthetic-one-time-secret",
  );
  expect(ctx.session.feedback.actionOutcome("create-invite")).toMatchObject({
    status: "confirmed",
    refresh: "failed",
  });
  const copied = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await page.getByTestId("copy-created-install-command").click();
  expect(copied).toHaveBeenCalledWith(
    "tailscale up --login-server 'https://fixture.invalid' --authkey 'hskey-auth-new-synthetic-one-time-secret'",
  );
  expect(ctx.writes).toHaveLength(1);
  ctx.failRead("");
  await page.getByTestId("invite-refresh-devices").click();
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  expect(ctx.writes).toHaveLength(1);
  await page.getByTestId("invite-view-devices").click();
  await expect.element(page.getByTestId("device-destination")).toBeVisible();
});

test("a failed creation pre-read preserves the prior secret and does not block an explicit submission after recovery", async () => {
  const ctx = await setup();
  ctx.createMode("drop");
  await open("invites");
  await page.getByTestId("create-invite").click();
  await expect.element(page.getByTestId("invite-create-unknown")).toBeVisible();
  ctx.failRead("/api/v1/preauthkey");
  await page.getByTestId("create-invite").click();
  await expect.element(page.getByTestId("create-invite-error")).toBeVisible();
  await expect.element(page.getByTestId("create-invite")).toBeEnabled();
  expect(ctx.writes).toHaveLength(1);
  expect(
    ctx.session.deviceSetup.getSnapshot().lastCreatedInvite === PRIOR_SECRET,
  ).toBe(true);
  ctx.failRead("");
  ctx.createMode("success");
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("invite-create-dialog"))
    .not.toBeInTheDocument();
  expect(ctx.writes).toHaveLength(2);
});

for (const source of ["invites", "members"] as const) {
  test.each(["filter", "open-close", "version-after-edit"] as const)(
    `${source} return cannot replace a newer %s after identity completed but policy is still reading`,
    async (change) => {
      const ctx = await setup(source);
      const searchId = source === "invites" ? "invite-search" : "user-search";
      await page
        .getByTestId(searchId)
        .fill(source === "invites" ? "alice" : "bob");
      await open(source);
      await addTag("tag:roundtrip");
      await page.getByTestId("invite-tags-define-tag:roundtrip").click();
      await closeAccessDetail();
      const savedId = ctx.session.tagLifecycle.getSnapshot().returnTo?.id;
      const gate = Promise.withResolvers<void>();
      ctx.holdPolicy(gate.promise);
      await page.getByTestId("tag-management-return").click();
      try {
        await expect
          .poll(() => ctx.router.state.location.pathname)
          .toBe(`/${source}`);
        await expect
          .poll(() => ctx.session.snapshot.getSnapshot().segmentStatus.identity)
          .toBe("ready");
        await expect
          .poll(() => ctx.session.snapshot.getSnapshot().segmentStatus.policy)
          .toBe("loading");
        if (change !== "open-close") {
          await page.getByTestId(searchId).fill("b");
          if (change === "version-after-edit") {
            ctx.backend.version = { version: "0.29.5" };
            await ctx.session.snapshot.refreshSegments(["fabric"]);
            await expect
              .element(page.getByTestId("invite-return-newer"))
              .toBeVisible();
          }
        } else {
          await open(source);
          await addTag("tag:newer-input");
          await page.getByTestId("cancel-create-invite").click();
          await expect
            .poll(
              () => ctx.session.snapshot.getSnapshot().segmentStatus.identity,
            )
            .toBe("ready");
        }
      } finally {
        ctx.holdPolicy(undefined);
        gate.resolve();
      }
      await expect
        .poll(
          () =>
            Boolean(
              document.querySelector('[data-testid="invite-return-newer"]'),
            ) ||
            Boolean(
              document.querySelector('[data-testid="invite-create-dialog"]'),
            ),
        )
        .toBe(true);
      await expect
        .element(page.getByTestId("invite-create-dialog"))
        .not.toBeInTheDocument();
      if (change !== "open-close")
        await expect.element(page.getByTestId(searchId)).toHaveValue("b");
      expect(ctx.session.tagLifecycle.getSnapshot().returnTo?.id).toBe(savedId);
      expect(ctx.router.state.location.pathname).toBe(`/${source}`);
      expect(ctx.writes).toEqual([]);
      await expect
        .element(page.getByTestId("invite-return-newer"))
        .toBeVisible();
      if (change !== "open-close") {
        await page.getByTestId("invite-return-retry").click();
        await expect
          .element(page.getByTestId("invite-create-dialog"))
          .toBeVisible();
        await expect
          .element(page.getByTestId("invite-tags-selected"))
          .toMatchTextContent("tag:roundtrip");
      } else await page.getByTestId("invite-return-discard").click();
      expect(ctx.session.tagLifecycle.getSnapshot().returnTo).toBeNull();
      expect(ctx.writes).toEqual([]);
    },
  );
}

test("a same-route URL view change cannot be overwritten by an older invitation return", async () => {
  const ctx = await setup();
  await open("invites");
  await addTag("tag:roundtrip");
  await page.getByTestId("invite-tags-define-tag:roundtrip").click();
  await closeAccessDetail();
  const savedId = ctx.session.tagLifecycle.getSnapshot().returnTo?.id;
  const gate = Promise.withResolvers<void>();
  ctx.holdPolicy(gate.promise);
  await page.getByTestId("tag-management-return").click();
  try {
    await expect
      .poll(() => ctx.router.state.location.pathname)
      .toBe("/invites");
    await expect
      .poll(() => ctx.session.snapshot.getSnapshot().segmentStatus.identity)
      .toBe("ready");
    await expect
      .poll(() => ctx.session.snapshot.getSnapshot().segmentStatus.policy)
      .toBe("loading");
    // A history/URL navigation does not go through the select or clear-tag handlers.
    await ctx.router.navigate({
      to: "/invites",
      search: { filter: "tagged", tag: "tag:new-view" },
    });
    await expect
      .element(page.getByTestId("invite-filter"))
      .toHaveValue("tagged");
  } finally {
    ctx.holdPolicy(undefined);
    gate.resolve();
  }
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  await expect
    .element(page.getByTestId("invite-create-dialog"))
    .not.toBeInTheDocument();
  await expect.element(page.getByTestId("invite-filter")).toHaveValue("tagged");
  await expect
    .element(page.getByTestId("invite-exact-tag"))
    .toMatchTextContent("tag:new-view");
  await expect.element(page.getByTestId("invite-return-newer")).toBeVisible();
  expect(ctx.session.tagLifecycle.getSnapshot().returnTo?.id).toBe(savedId);
  expect(ctx.writes).toEqual([]);
});

test.each(["invites", "members"] as const)(
  "%s retries tag definitions without resetting inputs and preserves a generic management return after a failed read",
  async (source) => {
    const ctx = await setup(source);
    ctx.failRead("/api/v1/policy");
    await ctx.session.snapshot.refreshSegments(["policy"]);
    await open(source);
    await addTag("tag:1abc");
    await expect.element(page.getByTestId("invite-tags-error")).toBeVisible();
    ctx.failRead("");
    await page.getByTestId("invite-tags-retry").click();
    await expect
      .element(page.getByTestId("invite-tags-error"))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByTestId("invite-tags-selected"))
      .toMatchTextContent("tag:1abc");
    await page.getByTestId("invite-tags-manage").click();
    await expect.poll(() => ctx.router.state.location.pathname).toBe("/access");
    expect(ctx.router.state.location.search).not.toHaveProperty("tag");
    const saved = ctx.session.tagLifecycle.getSnapshot().returnTo;
    expect.assert(
      saved?.source === "invite" || saved?.source === "member-invite",
    );
    expect(saved.form).toMatchObject({ tags: ["tag:1abc"] });
    ctx.failRead("/api/v1/preauthkey");
    await page.getByTestId("tag-management-return").click();
    await expect.element(page.getByTestId("invite-return-error")).toBeVisible();
    await expect
      .element(page.getByTestId("invite-create-dialog"))
      .not.toBeInTheDocument();
    expect(ctx.session.tagLifecycle.getSnapshot().returnTo).not.toBeNull();
    expect(ctx.writes).toEqual([]);
    ctx.failRead("");
    await page.getByTestId("invite-return-retry").click();
    await expect
      .element(page.getByTestId("invite-create-dialog"))
      .toBeVisible();
    await expect
      .element(page.getByTestId("invite-tags-selected"))
      .toMatchTextContent("tag:1abc");
    expect(ctx.session.tagLifecycle.getSnapshot().returnTo).toBeNull();
    expect(ctx.writes).toEqual([]);
  },
);

test.each(["empty", "unattributed"] as const)(
  "unknown creation with %s inventory shows a plain notice without claiming a key",
  async (inventory) => {
    const ctx = await setup();
    ctx.backend.preAuthKeys =
      inventory === "empty"
        ? []
        : [
            normalizePreAuthKey({
              id: "anonymous-key",
              key: "hskey-auth-omitted-anonymous-secret",
              user: { id: "9", name: "" },
              reusable: false,
              ephemeral: true,
              used: true,
              aclTags: [],
              createdAt: "2026-10-01T01:02:03Z",
              expiration: "2099-01-01T00:00:00Z",
            }),
            normalizePreAuthKey({
              id: "tag-only-key",
              key: "hskey-auth-omitted-tag-only-secret",
              user: undefined,
              reusable: true,
              ephemeral: false,
              used: false,
              aclTags: ["tag:orphan"],
              expiration: "2099-01-01T00:00:00Z",
            }),
          ];
    await ctx.session.snapshot.refreshSegments(["identity"]);
    ctx.createMode("reject");
    await open("invites");
    await page.getByTestId("create-invite").click();
    await expect
      .element(page.getByTestId("invite-create-unknown"))
      .toBeVisible();
    const notice =
      page.getByTestId("invite-create-unknown").element().textContent ?? "";
    expect(notice.includes("hskey-auth-")).toBe(false);
    await expect
      .element(page.getByTestId("invite-create-verify"))
      .toHaveAttribute("href", "/invites");
    expect(ctx.session.feedback.actionOutcome("create-invite")?.status).toBe(
      "possibly-applied",
    );
    await expect.element(page.getByTestId("create-invite")).toBeEnabled();
    expect(ctx.writes).toHaveLength(1);
  },
);

test.each(["version", "unmount"] as const)(
  "a manual key inventory read completed after %s cannot revive a stale host or confirmation",
  async (change) => {
    const ctx = await setup();
    ctx.createMode("drop");
    await open("invites");
    await page.getByTestId("create-invite").click();
    await expect
      .element(page.getByTestId("invite-create-unknown"))
      .toBeVisible();
    await page.getByTestId("cancel-create-invite").click();
    await expect
      .element(page.getByTestId("invite-create-dialog"))
      .not.toBeInTheDocument();
    const original = structuredClone(
      ctx.session.feedback.actionOutcome("create-invite"),
    );
    const gate = Promise.withResolvers<void>();
    ctx.holdRead(gate.promise);
    await page.getByTestId("refresh-auth-keys").click();
    try {
      await expect
        .element(page.getByTestId("refresh-auth-keys"))
        .toBeDisabled();
      if (change === "version") {
        ctx.backend.version = { version: "0.29.5" };
        await ctx.session.snapshot.refreshSegments(["fabric"]);
      } else await ctx.router.navigate({ to: "/members" });
    } finally {
      ctx.holdRead(undefined);
      gate.resolve();
    }
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
    if (change === "version")
      expect(ctx.session.feedback.actionOutcome("create-invite")).toEqual(
        original,
      );
    else {
      expect(ctx.router.state.location.pathname).toBe("/members");
      await expect
        .element(page.getByTestId("invite-create-dialog"))
        .not.toBeInTheDocument();
    }
    expect(ctx.writes).toHaveLength(1);
  },
);

test("the invitation return adapter safely ignores retry and discard when no return exists", async () => {
  let adapter: ReturnType<typeof useInviteTagReturn> | undefined;
  const restored = vi.fn();
  const ctx = await setup(
    "invites",
    <InviteReturnProbe
      restored={restored}
      capture={(value) => {
        adapter = value;
      }}
    />,
  );
  await ctx.router.navigate({ to: "/probe" });
  expect.assert(adapter);
  const reads = [...ctx.reads];
  adapter.retryRestore();
  adapter.discardReturn();
  expect(ctx.session.tagLifecycle.getSnapshot().returnTo).toBeNull();
  expect(restored).not.toHaveBeenCalled();
  expect(ctx.reads).toEqual(reads);
  expect(ctx.router.state.location.pathname).toBe("/probe");
  expect(ctx.writes).toEqual([]);
});

test("a return cancelled during source mounting is never requested or restored", async () => {
  const restored = vi.fn();
  const ctx = await setup(
    "invites",
    <InviteReturnProbe
      restored={restored}
      onMount={() => {
        ctx.session.tagLifecycle.cancelReturn();
      }}
    />,
  );
  await ctx.router.navigate({ to: "/access" });
  expect(
    ctx.session.tagLifecycle.saveReturn({
      source: "invite",
      managedTag: "tag:known",
      editVersion: 1,
      form: {
        userId: "1",
        userName: "alice",
        tags: ["tag:known"],
        tagInput: "",
        reusable: false,
        ephemeral: false,
        expiration: EXPIRATION,
        expirationMode: "custom",
        expiryDays: "7",
      },
    }),
  ).not.toBeNull();
  const reads = [...ctx.reads];
  await ctx.router.navigate({ to: "/probe" });
  await expect
    .poll(() => ctx.session.tagLifecycle.getSnapshot().returnTo)
    .toBeNull();
  expect(restored).not.toHaveBeenCalled();
  expect(ctx.reads).toEqual(reads);
  expect(ctx.writes).toEqual([]);
});

test("a return cancelled by a snapshot observer at read completion is not restored", async () => {
  const restored = vi.fn();
  const ctx = await setup("invites", <InviteReturnProbe restored={restored} />);
  await open("invites");
  await addTag("tag:roundtrip");
  await page.getByTestId("invite-tags-define-tag:roundtrip").click();
  await closeAccessDetail();
  const id = ctx.session.tagLifecycle.getSnapshot().returnTo?.id;
  expect.assert(id);
  const gate = Promise.withResolvers<void>();
  ctx.holdPolicy(gate.promise);
  await ctx.router.navigate({ to: "/probe" });
  await expect
    .poll(() => ctx.session.snapshot.getSnapshot().segmentStatus.policy)
    .toBe("loading");
  const unsubscribe = ctx.session.snapshot.subscribe(() => {
    const status = ctx.session.snapshot.getSnapshot().segmentStatus;
    if (status.identity === "ready" && status.policy === "ready")
      ctx.session.tagLifecycle.cancelReturn(id);
  });
  try {
    ctx.holdPolicy(undefined);
    gate.resolve();
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
    expect(ctx.session.tagLifecycle.getSnapshot().returnTo).toBeNull();
    expect(restored).not.toHaveBeenCalled();
    expect(ctx.router.state.location.pathname).toBe("/probe");
    expect(ctx.writes).toEqual([]);
  } finally {
    unsubscribe();
  }
});

test("a cancelled return cannot be consumed while React is suspending the source update", async () => {
  const restored = vi.fn();
  const rendering = Promise.withResolvers<void>();
  let suspend = false;
  const ctx = await setup(
    "invites",
    <Suspense fallback={<p data-testid="return-source-suspended">Loading</p>}>
      <ReturningSource
        restored={restored}
        suspended={() => suspend}
        rendering={rendering.promise}
      />
    </Suspense>,
  );
  await open("invites");
  await addTag("tag:roundtrip");
  await page.getByTestId("invite-tags-define-tag:roundtrip").click();
  await closeAccessDetail();
  const reading = Promise.withResolvers<void>();
  ctx.holdPolicy(reading.promise);
  await ctx.router.navigate({ to: "/probe" });
  try {
    await expect
      .poll(() => ctx.session.snapshot.getSnapshot().segmentStatus.identity)
      .toBe("ready");
    await expect
      .poll(() => ctx.session.snapshot.getSnapshot().segmentStatus.policy)
      .toBe("loading");
    suspend = true;
    ctx.session.tagLifecycle.cancelReturn();
    await expect
      .element(page.getByTestId("return-source-suspended"))
      .toBeVisible();
    ctx.holdPolicy(undefined);
    reading.resolve();
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
    expect(ctx.session.tagLifecycle.getSnapshot().returnTo).toBeNull();
    expect(restored).not.toHaveBeenCalled();
    expect(ctx.router.state.location.pathname).toBe("/probe");
    expect(ctx.writes).toEqual([]);
  } finally {
    ctx.holdPolicy(undefined);
    reading.resolve();
    suspend = false;
    rendering.resolve();
  }
  await expect.element(page.getByTestId("return-source-ready")).toBeVisible();
});

test.each(["invites", "members"] as const)(
  "%s refuses management navigation when the lifecycle scope is already unavailable",
  async (source) => {
    const ctx = await setup(source);
    await open(source);
    await addTag("tag:roundtrip");
    ctx.session.tagLifecycle.bind(null);
    await page.getByTestId("invite-tags-manage").click();
    await expect
      .element(page.getByTestId("invite-create-dialog"))
      .toBeVisible();
    expect(ctx.router.state.location.pathname).toBe(`/${source}`);
    expect(ctx.session.tagLifecycle.getSnapshot().returnTo).toBeNull();
    expect(ctx.writes).toEqual([]);
  },
);

test.each(["invites", "members"] as const)(
  "%s restores a minimal valid return record without optional source-view fields",
  async (source) => {
    const ctx = await setup(source);
    await ctx.router.navigate({ to: "/access" });
    const record = ctx.session.tagLifecycle.saveReturn({
      source: source === "invites" ? "invite" : "member-invite",
      managedTag: "tag:known",
      editVersion: 1,
      form: {
        userId: "1",
        userName: "alice",
        tags: ["tag:known"],
        tagInput: "",
        reusable: false,
        ephemeral: false,
        expiration: EXPIRATION,
        expirationMode: "custom",
        expiryDays: "7",
      },
    });
    expect(record).not.toBeNull();
    await ctx.router.navigate({
      to: source === "invites" ? "/invites" : "/members",
    });
    await expect
      .element(page.getByTestId("invite-create-dialog"))
      .toBeVisible();
    await expect.element(page.getByTestId("invite-user")).toHaveValue("1");
    await expect
      .element(page.getByTestId("invite-tags-selected"))
      .toMatchTextContent("tag:known");
    expect(ctx.session.tagLifecycle.getSnapshot().returnTo).toBeNull();
    await page.getByTestId("cancel-create-invite").click();
    await expect
      .element(page.getByTestId("invite-create-dialog"))
      .not.toBeInTheDocument();
    await expect
      .element(
        page.getByTestId(
          source === "invites" ? "invite-search" : "user-search",
        ),
      )
      .toHaveValue("");
    if (source === "invites") {
      await page.getByTestId("invite-filter").selectOptions("ready");
      await page.getByTestId("invite-filter").selectOptions("all");
      expect(ctx.router.state.location.search).not.toHaveProperty("filter");
    }
    expect(ctx.writes).toEqual([]);
  },
);

test("leaving during the return read cannot reopen or navigate until the source is deliberately revisited", async () => {
  const ctx = await setup();
  await open("invites");
  await addTag("tag:roundtrip");
  await page.getByTestId("invite-tags-define-tag:roundtrip").click();
  await closeAccessDetail();
  const gate = Promise.withResolvers<void>();
  ctx.holdRead(gate.promise);
  await page.getByTestId("tag-management-return").click();
  try {
    await expect
      .poll(() => ctx.router.state.location.pathname)
      .toBe("/invites");
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(true);
    await ctx.router.navigate({ to: "/members" });
  } finally {
    ctx.holdRead(undefined);
    gate.resolve();
  }
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  expect(ctx.router.state.location.pathname).toBe("/members");
  await expect
    .element(page.getByTestId("invite-create-dialog"))
    .not.toBeInTheDocument();
  expect(ctx.session.tagLifecycle.getSnapshot().returnTo).not.toBeNull();
  expect(ctx.writes).toEqual([]);
  await ctx.router.navigate({ to: "/invites" });
  await expect.element(page.getByTestId("invite-create-dialog")).toBeVisible();
  expect(ctx.session.tagLifecycle.getSnapshot().returnTo).toBeNull();
  expect(ctx.writes).toEqual([]);
});

test.each(["lock", "reunlock", "server-aba"] as const)(
  "%s invalidates the pending invitation return even when the original server is active again",
  async (transition) => {
    const ctx = await setup();
    const originalProfile = ctx.session.profiles
      .getSnapshot()
      .profiles.find(
        (profile) => profile.baseUrl === "https://fixture.invalid",
      );
    expect.assert(originalProfile);
    await open("invites");
    await addTag("tag:roundtrip");
    await page.getByTestId("invite-tags-define-tag:roundtrip").click();
    await closeAccessDetail();
    expect(ctx.session.tagLifecycle.getSnapshot().returnTo).not.toBeNull();
    if (transition === "lock") await ctx.session.profiles.logout();
    if (transition === "server-aba")
      await authenticateTestSession(
        ctx.session,
        "https://other-fixture.invalid",
      );
    expect(
      await ctx.session.profiles.enterProfile(
        originalProfile,
        "isolated-test-password",
      ),
    ).toBe(true);
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
    expect(ctx.session.tagLifecycle.getSnapshot().returnTo).toBeNull();
    await ctx.router.navigate({ to: "/invites" });
    await expect
      .element(page.getByTestId("invite-create-dialog"))
      .not.toBeInTheDocument();
    expect(ctx.writes).toEqual([]);
  },
);

test("the real invitation host keeps a narrow RTL dialog operable with nested Escape", async () => {
  await setup();
  await setLocale("ar");
  await page.viewport(320, 640);
  await open("invites");
  await addTag("tag:long-invitation-name-for-wrapping");
  await page.getByTestId("invite-expiration").click();
  await expect
    .element(page.getByTestId("invite-expiration-hour"))
    .toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("invite-create-dialog")).toBeVisible();
  await expect
    .element(page.getByTestId("invite-expiration-hour"))
    .not.toBeInTheDocument();
  const rect = page
    .getByTestId("invite-create-dialog")
    .element()
    .getBoundingClientRect();
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
    window.innerWidth,
  );
  await page.getByTestId("cancel-create-invite").click();
  await expect
    .element(page.getByTestId("invite-create-dialog"))
    .not.toBeInTheDocument();
});

test("a member creation completed after leaving cannot navigate away from the new page", async () => {
  const ctx = await setup("members");
  await open("members");
  const gate = Promise.withResolvers<void>();
  ctx.holdWrite(gate.promise);
  await page.getByTestId("create-invite").click();
  try {
    await expect.poll(() => ctx.writes.length).toBe(1);
    await ctx.router.navigate({ to: "/access" });
  } finally {
    gate.resolve();
  }
  await expect
    .poll(() => ctx.session.feedback.isActionPending("create-invite"))
    .toBe(false);
  expect(ctx.router.state.location.pathname).toBe("/access");
  await expect
    .element(page.getByTestId("invite-create-dialog"))
    .not.toBeInTheDocument();
});

test.each(["invites", "members"] as const)(
  "%s reports explicit list-read failures after an unknown creation without replaying or losing the previous secret",
  async (source) => {
    const ctx = await setup(source);
    ctx.createMode("drop");
    await open(source);
    await page.getByTestId("create-invite").click();
    await expect
      .element(page.getByTestId("invite-create-unknown"))
      .toBeVisible();
    expect(document.querySelectorAll('[data-slot="toast"]')).toHaveLength(0);
    const original = structuredClone(
      ctx.session.feedback.actionOutcome("create-invite"),
    );
    await page.getByTestId("cancel-create-invite").click();
    await expect
      .element(page.getByTestId("invite-create-dialog"))
      .not.toBeInTheDocument();
    ctx.failRead("/api/v1/preauthkey");
    for (let attempt = 0; attempt < 2; attempt++) {
      await page
        .getByTestId(
          source === "invites" ? "refresh-auth-keys" : "refresh-users",
        )
        .click();
      await expect
        .element(notifications().getByRole("dialog"))
        .toMatchTextContent("Could not refresh data");
      expect(notifications().getByRole("dialog").elements()).toHaveLength(1);
      expect(
        notifications()
          .getByRole("dialog")
          .element()
          .textContent?.includes(PRIOR_SECRET),
      ).toBe(false);
      expect(ctx.session.feedback.actionOutcome("create-invite")).toEqual(
        original,
      );
      expect(
        ctx.session.deviceSetup.getSnapshot().lastCreatedInvite ===
          PRIOR_SECRET,
      ).toBe(true);
      expect(ctx.writes).toHaveLength(1);
      await notifications()
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await expect
        .element(notifications().getByRole("dialog"))
        .not.toBeInTheDocument();
    }
  },
);

test.each(["invites", "members"] as const)(
  "%s publishes a new identity preflight failure after an unknown creation without another write",
  async (source) => {
    const ctx = await setup(source);
    ctx.createMode("drop");
    await open(source);
    await page.getByTestId("create-invite").click();
    await expect
      .element(page.getByTestId("invite-create-unknown"))
      .toBeVisible();
    expect(document.querySelectorAll('[data-slot="toast"]')).toHaveLength(0);
    ctx.failRead("/api/v1/preauthkey");
    await page.getByTestId("create-invite").click();
    await expect.element(page.getByTestId("create-invite-error")).toBeVisible();
    await expect
      .element(notifications().getByRole("dialog"))
      .toMatchTextContent("No creation request was sent.");
    expect(notifications().getByRole("dialog").elements()).toHaveLength(1);
    expect(
      notifications().getByRole("dialog").element().textContent ?? "",
    ).not.toContain(PRIOR_SECRET);
    expect(
      notifications().getByRole("dialog").element().textContent ?? "",
    ).not.toContain("hskey-auth");
    expect(ctx.writes).toHaveLength(1);
    expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe(
      PRIOR_SECRET,
    );
    expect(ctx.session.feedback.actionOutcome("create-invite")?.status).toBe(
      "not-dispatched",
    );
    await notifications()
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect
      .element(notifications().getByRole("dialog"))
      .not.toBeInTheDocument();
    await expect.element(page.getByTestId("create-invite")).toBeEnabled();
    await expect.element(page.getByTestId("create-invite-error")).toBeVisible();
    expect(ctx.writes).toHaveLength(1);
  },
);

test("a confirmed key creation with a failed inventory refresh notifies once and keeps the explanation", async () => {
  const ctx = await setup();
  ctx.failAfterCreate("/api/v1/preauthkey");
  await open("invites");
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("invite-create-dialog"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("invite-created-refresh-failed"))
    .toBeVisible();
  await expect
    .element(notifications().getByRole("dialog"))
    .toMatchTextContent("Do not create another key just to refresh the list.");
  expect(notifications().getByRole("dialog").elements()).toHaveLength(1);
  expect(
    notifications().getByRole("dialog").element().textContent ?? "",
  ).not.toContain("hskey-auth-new-synthetic-one-time-secret");
  expect(ctx.session.feedback.actionOutcome("create-invite")).toMatchObject({
    status: "confirmed",
    refresh: "failed",
  });
  await notifications()
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect
    .element(notifications().getByRole("dialog"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("invite-created-refresh-failed"))
    .toBeVisible();
  expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe(
    "hskey-auth-new-synthetic-one-time-secret",
  );
  expect(ctx.writes).toHaveLength(1);
});
