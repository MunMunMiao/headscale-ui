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
import { afterEach, expect, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { HeadscaleSnapshot } from "@/api/contracts";
import { createMutation } from "@/composables/useMutation";
import { i18n, setLocale } from "@/i18n";
import { commonDescriptors, productDescriptors } from "@/i18n/descriptors";
import { parseSearch, stringifySearch } from "@/router/search";
import {
  authenticateTestSession,
  prepareTestSession,
  renderSessionPage,
  SessionTestProviders,
} from "@/test/session";
import DevicesPage from "@/pages/DevicesPage";

export { authenticateTestSession, createMutation };

export const alice = { id: "1", name: "alice", displayName: "Alice" };
export const bob = { id: "2", name: "bob", displayName: "Bob" };
export const AUTH_ID = "hskey-authreq-abcdefghijklmnopqrstuvwx";
interface Call {
  method: string;
  path: string;
  body: Record<string, unknown>;
}
export function fixture(): HeadscaleSnapshot {
  return {
    health: { databaseConnectivity: true, serverReachable: true },
    version: { version: "0.29.4" },
    users: [{ ...alice }, { ...bob }],
    apiKeys: [],
    preAuthKeys: [],
    policy: {
      policy: JSON.stringify({
        tagOwners: { "tag:prod": [], "tag:extra": [], "tag:Web1": [] },
      }),
    },
    nodes: [
      {
        id: "1",
        name: "edge",
        machineKey: "mkey:original",
        nodeKey: "nodekey:original",
        tags: ["tag:legacy", "tag:extra"],
        ipAddresses: ["100.64.0.1"],
        approvedRoutes: [],
        availableRoutes: [],
        subnetRoutes: [],
        online: true,
      },
      {
        id: "2",
        name: "laptop",
        machineKey: "mkey:personal",
        user: { ...alice },
        tags: [],
        ipAddresses: ["100.64.0.2"],
        approvedRoutes: [],
        availableRoutes: [],
        subnetRoutes: [],
        online: true,
      },
    ],
  };
}
export async function setup(
  patch: (backend: HeadscaleSnapshot) => void = () => {},
  accessLoad?: Promise<void>,
) {
  await page.viewport(1366, 900);
  const backend = fixture();
  patch(backend);
  const calls: Call[] = [];
  let readFailure = "";
  let writeFailure = "";
  let applyBeforeFailure = false;
  let failAfterWrite = false;
  let lostResponse = false;
  let foreignRegistration = false;
  let readHold: Promise<void> | undefined;
  let writeHold: Promise<void> | undefined;
  let policyResponseHold: Promise<void> | undefined;
  const transport: FetchHandle = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const raw = await request.clone().text();
    const body = raw ? JSON.parse(raw) : Object.fromEntries(url.searchParams);
    calls.push({ method: request.method, path: url.pathname, body });
    if (request.method === "GET") {
      if (readHold && url.origin === "https://fixture.invalid") await readHold;
      if (url.pathname === readFailure)
        return Response.json({ message: "read unavailable" }, { status: 503 });
      const responses: Record<string, unknown> = {
        "/api/v1/health": backend.health,
        "/version": backend.version,
        "/api/v1/user": { users: backend.users },
        "/api/v1/node": { nodes: backend.nodes },
        "/api/v1/preauthkey": { preAuthKeys: backend.preAuthKeys },
        "/api/v1/apikey": { apiKeys: [] },
        "/api/v1/policy": backend.policy,
      };
      return Response.json(responses[url.pathname]);
    }
    if (writeHold) await writeHold;
    if (writeFailure && !applyBeforeFailure)
      return Response.json({ message: writeFailure }, { status: 400 });
    if (url.pathname === "/api/v1/policy") {
      backend.policy = { policy: body.policy as string };
      if (policyResponseHold) await policyResponseHold;
      if (writeFailure)
        return Response.json({ message: writeFailure }, { status: 400 });
      if (lostResponse) throw new TypeError("Failed to fetch");
      return Response.json(backend.policy);
    }
    if (url.pathname.endsWith("/tags")) {
      const node = backend.nodes.find(
        (candidate) => candidate.id === url.pathname.split("/")[4],
      );
      if (!node)
        return Response.json({ message: "node not found" }, { status: 404 });
      const tags = body.tags as string[];
      const declarations =
        JSON.parse(backend.policy?.policy || "{}").tagOwners ?? {};
      if (
        !tags.length ||
        tags.some((tag) => !(tag in declarations) || tag !== tag.toLowerCase())
      ) {
        return Response.json(
          { message: "tag is not defined or invalid" },
          { status: 400 },
        );
      }
      node.tags = tags;
      delete node.user;
      if (failAfterWrite) readFailure = "/api/v1/node";
      if (writeFailure)
        return Response.json({ message: writeFailure }, { status: 400 });
      return Response.json({ node });
    }
    if (url.pathname === "/api/v1/auth/register") {
      const original = backend.nodes[0];
      if (!original) throw new Error("Missing fixture node");
      const node = foreignRegistration
        ? { ...original, id: "3", machineKey: "mkey:other-device" }
        : original;
      if (foreignRegistration) backend.nodes.push(node);
      node.tags = [];
      node.user = backend.users.find(
        (candidate) => candidate.name === body.user,
      );
      delete node.preAuthKey;
      if (failAfterWrite) readFailure = "/api/v1/node";
      if (writeFailure)
        return Response.json({ message: writeFailure }, { status: 400 });
      if (lostResponse) throw new TypeError("Failed to fetch");
      return Response.json({ node });
    }
    if (url.pathname === "/api/v1/preauthkey") {
      const preAuthKey = {
        id: "9",
        key: "fixture-one-time-secret",
        ...body,
        user: backend.users.find((user) => user.id === body.user),
        used: false,
      };
      backend.preAuthKeys.push({ ...preAuthKey, key: "masked" });
      if (lostResponse) throw new TypeError("Failed to fetch");
      return Response.json({ preAuthKey });
    }
    throw new Error(`Unexpected write ${request.method} ${url.pathname}`);
  };
  const session = await prepareTestSession(transport);
  await setLocale("en-US");
  await authenticateTestSession(session);
  // Catalog extraction has a separate owner; exercise fixed-key notifications with fixture copy.
  i18n.load("en-US", {
    [commonDescriptors.notifications.id]: "Notifications",
    [productDescriptors.feedbackRequestConfirmed.id]: "Request confirmed",
    [productDescriptors.feedbackRequestNotSent.id]: "Request not sent",
    [productDescriptors.feedbackRequestRejected.id]: "Request rejected",
    [productDescriptors.feedbackRefreshFailed.id]: "Could not refresh data",
    [productDescriptors.feedbackPossiblyApplied.id]:
      "The change may have been applied",
  });
  const rendered = accessLoad
    ? await (async () => {
        const root = createRootRoute({ component: Outlet });
        const routes = [
          createRoute({
            getParentRoute: () => root,
            path: "/devices",
            component: DevicesPage,
          }),
          createRoute({
            getParentRoute: () => root,
            path: "/access",
            component: lazyRouteComponent(async () => {
              await accessLoad;
              return {
                default: () => <div data-testid="test-route">/access</div>,
              };
            }),
          }),
        ];
        const router = createRouter({
          routeTree: root.addChildren(routes),
          parseSearch,
          stringifySearch,
          history: createMemoryHistory({ initialEntries: ["/devices"] }),
        });
        await router.load();
        const result = await render(
          <SessionTestProviders session={session}>
            <RouterProvider router={router} />
          </SessionTestProviders>,
        );
        return { ...result, router };
      })()
    : await renderSessionPage(session, <DevicesPage />, "/devices");
  await expect.poll(() => session.snapshot.getSnapshot().isReady).toBe(true);
  await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
  calls.length = 0;
  return {
    backend,
    calls,
    session,
    ...rendered,
    writes: () => calls.filter((call) => call.method !== "GET"),
    failRead: (path: string) => {
      readFailure = path;
    },
    failWrite: (message: string, applied = false) => {
      writeFailure = message;
      applyBeforeFailure = applied;
    },
    failRefresh: () => {
      failAfterWrite = true;
    },
    loseWriteResponse: () => {
      lostResponse = true;
    },
    foreignRegistration: () => {
      foreignRegistration = true;
    },
    holdPolicyResponse: () => {
      let release!: () => void;
      policyResponseHold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        policyResponseHold = undefined;
        release();
      };
    },
    holdWrites: () => {
      let release!: () => void;
      writeHold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        writeHold = undefined;
        release();
      };
    },
    holdReads: () => {
      let release!: () => void;
      readHold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        readHold = undefined;
        release();
      };
    },
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.dir = "ltr";
});
export async function openTags(id = "1") {
  await page.getByTestId(`machine-actions-trigger-${id}`).click();
  await page.getByTestId(`edit-node-tags-action-${id}`).click();
  await expect.element(page.getByTestId("node-tags-dialog")).toBeVisible();
}
export function submitTags() {
  (
    page.getByTestId("node-tags-form").element() as HTMLFormElement
  ).requestSubmit();
}
export function fixtureNode(backend: HeadscaleSnapshot, id = "1") {
  const node = backend.nodes.find((item) => item.id === id);
  expect.assert(node);
  return node;
}

export function currentToasts() {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-slot="toast"]:not([data-ending-style])',
    ),
  );
}

export async function openRestore(ctx: Awaited<ReturnType<typeof setup>>) {
  await page.getByTestId("machine-actions-trigger-1").click();
  await page.getByTestId("restore-personal-action-1").click();
  await page.getByTestId("restore-user").selectOptions("2");
  await page.getByTestId("restore-login-server").fill("https://public.example");
  await page.getByTestId("restore-server-confirm").click();
  await page.getByTestId("restore-backup-confirm").click();
  await page
    .getByTestId("restore-auth-id")
    .fill(`https://public.example/register/${AUTH_ID}`);
  expect(ctx.writes()).toHaveLength(0);
}
