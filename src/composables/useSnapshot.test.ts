import { createClient, withEndpoint, withHTTPHandle } from "@defjs/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { HeadscaleSnapshot, HealthResponse } from "@/api/contracts";
import * as headscale from "@/api/snapshot";
import { fetchSegment, fetchSnapshot } from "@/api/snapshot";
import { registrationKeyStatus } from "@/domain/tag-lifecycle";
import { i18n } from "@/i18n";
import { productDescriptors } from "@/i18n/descriptors";
import { getProductCopy } from "@/i18n/product-copy";
import {
  createFixtureHttp,
  fixtureExecute,
  fixtureSession,
} from "@/test/dispatch-fixture";
import {
  snapshotFixture,
  startSnapshotServer,
} from "@/test-utils/headscale.test";
import { createActionFeedbackStore } from "./useActionFeedback";
import type { createHeadscaleClientStore } from "./useHeadscaleClient";
import { createSnapshotStore } from "./useSnapshot";

let feedbackStore: ReturnType<typeof createActionFeedbackStore>;
let auth: ReturnType<typeof fixtureSession>["auth"];
let clientStore: ReturnType<typeof createHeadscaleClientStore>;
let snapshotStore: ReturnType<typeof createSnapshotStore>;
beforeEach(() => {
  feedbackStore = createActionFeedbackStore();
  fixture = startSnapshotServer();
  ({ auth, client: clientStore } = fixtureSession(
    createFixtureHttp({ baseUrl: fixture.baseUrl, apiKey: "test-key" }),
    fixture.baseUrl,
  ));
  snapshotStore = createSnapshotStore(auth, clientStore, feedbackStore);
});

let fixture: ReturnType<typeof startSnapshotServer>;
afterEach(() => {
  vi.restoreAllMocks();
  fixture.stop();
});

describe("snapshot fetchers", () => {
  test("preserves validated nullable metadata without replacing server extensions", async () => {
    fixture.snapshot.users = [
      {
        id: "1",
        name: "alice",
        createdAt: null,
        displayName: null,
        avatar: null,
      },
    ];
    fixture.snapshot.apiKeys = [
      {
        id: "1",
        prefix: "api-key",
        expiration: null,
        createdAt: null,
        lastSeen: null,
        provider: null,
      },
    ];
    const client = fixtureExecute(
      createFixtureHttp({ baseUrl: fixture.baseUrl, apiKey: "test-key" }),
    );
    const snapshot = await fetchSnapshot(client);
    expect(snapshot.users).toEqual([
      {
        id: "1",
        name: "alice",
        createdAt: null,
        displayName: null,
        avatar: null,
      },
    ]);
    expect(snapshot.apiKeys).toEqual([
      {
        id: "1",
        prefix: "api-key",
        expiration: null,
        createdAt: null,
        lastSeen: null,
        provider: null,
      },
    ]);
  });

  test("fetches selected segments and assembles a complete snapshot", async () => {
    const client = fixtureExecute(
      createFixtureHttp({ baseUrl: fixture.baseUrl, apiKey: "test-key" }),
    );

    const identity = await fetchSegment(client, "identity");
    expect(identity.users).toHaveLength(1);
    expect(identity.preAuthKeys).toHaveLength(1);
    expect(identity.apiKeys).toHaveLength(1);
    expect(identity.nodes).toBeUndefined();

    const fabric = await fetchSegment(client, "fabric");
    expect(fabric.health?.serverReachable).toBe(true);
    expect(fabric.version).toEqual({ version: "v0.29.4" });
    expect(fabric.nodes).toHaveLength(2);
    expect((await fetchSegment(client, "policy")).policy?.policy).toContain(
      '"acls"',
    );

    const snapshot = await fetchSnapshot(client);
    expect(Object.keys(snapshot).sort()).toEqual([
      "apiKeys",
      "health",
      "nodes",
      "policy",
      "preAuthKeys",
      "users",
      "version",
    ]);
  });
});

function useTransport(
  handle: (path: string, signal: AbortSignal | null) => Promise<Response>,
) {
  const http = createClient(
    withEndpoint("https://headscale.example.test"),
    withHTTPHandle((input, init) => {
      const request = new Request(input, init);
      return handle(new URL(request.url).pathname, request.signal);
    }),
  );
  const execute = fixtureExecute(http);
  vi.spyOn(auth, "read").mockImplementation((_expected, command, options) =>
    execute(command, options),
  );
  snapshotStore.setAuthorized(true);
  snapshotStore.applyPatch(snapshotFixture());
}

describe("useSnapshot", () => {
  test("the first snapshot becomes ready only after all segments load and a session change resets readiness", async () => {
    snapshotStore.setAuthorized(true);
    expect(snapshotStore.getSnapshot()).toMatchObject({ isReady: false });
    await snapshotStore.refreshSegments(["identity", "fabric"]);
    expect(snapshotStore.getSnapshot()).toMatchObject({ isReady: false });
    await snapshotStore.refreshSegments(["policy"]);
    expect(snapshotStore.getSnapshot()).toMatchObject({ isReady: true });
    snapshotStore.setAuthorized(false);
    expect(snapshotStore.getSnapshot()).toMatchObject({ isReady: false });
  });

  function responseFor(path: string) {
    const data = snapshotFixture();
    const responses: Record<string, unknown> = {
      "/api/v1/health": data.health,
      "/version": data.version,
      "/api/v1/user": { users: data.users },
      "/api/v1/preauthkey": { preAuthKeys: data.preAuthKeys },
      "/api/v1/apikey": { apiKeys: data.apiKeys },
      "/api/v1/node": { nodes: data.nodes },
      "/api/v1/policy": data.policy,
    };
    return Response.json(responses[path]);
  }

  test("segment evidence is per read, retaining data but not verified version after a failed optional request", async () => {
    let failVersion = false;
    let failPolicy = false;
    useTransport(async (path) => {
      if (
        (path === "/version" && failVersion) ||
        (path === "/api/v1/policy" && failPolicy)
      )
        return Response.json({ message: "read unavailable" }, { status: 503 });
      return responseFor(path);
    });
    expect(await snapshotStore.refreshSegments(["fabric", "policy"])).toBe(
      true,
    );
    expect(snapshotStore.getSnapshot()).toMatchObject({
      segmentStatus: { fabric: "ready", policy: "ready", identity: "unknown" },
      versionFresh: true,
    });
    const lastVersion = snapshotStore.getSnapshot().snapshot.version;
    failVersion = true;
    failPolicy = true;
    expect(await snapshotStore.refreshSegments(["fabric", "policy"])).toBe(
      false,
    );
    expect(snapshotStore.getSnapshot()).toMatchObject({
      segmentStatus: { fabric: "ready", policy: "error" },
      versionFresh: false,
    });
    expect(snapshotStore.getSnapshot().snapshot.version).toEqual(lastVersion);
    snapshotStore.rebindSession();
    expect(snapshotStore.getSnapshot()).toMatchObject({
      segmentStatus: {
        fabric: "unknown",
        policy: "unknown",
        identity: "unknown",
      },
      versionFresh: false,
    });
  });

  test("pending, failed and superseded segment reads never report fresh data for an operation", async () => {
    const response = Promise.withResolvers<Response>();
    useTransport(async (path) =>
      path === "/api/v1/policy" ? response.promise : responseFor(path),
    );
    const reading = snapshotStore.refreshSegments(["policy"]);
    expect(snapshotStore.getSnapshot().segmentStatus.policy).toBe("loading");
    snapshotStore.invalidatePolicyRefreshes();
    response.resolve(
      Response.json({ policy: '{"tagOwners":{"tag:stale":[]}}' }),
    );
    expect(await reading).toBe(false);
    expect(snapshotStore.getSnapshot().segmentStatus.policy).toBe("unknown");
    expect(snapshotStore.getSnapshot().snapshot.policy?.policy).not.toContain(
      "tag:stale",
    );
  });

  test("refresh results distinguish an applied fabric read from failures without rejecting", async () => {
    let failNodes = false;
    useTransport(async (path) => {
      if (
        path === "/api/v1/policy" ||
        path === "/api/v1/health" ||
        (failNodes && path === "/api/v1/node")
      )
        return Response.json({ message: "read unavailable" }, { status: 503 });
      return responseFor(path);
    });
    expect(await snapshotStore.refreshSegments(["fabric"])).toBe(true);
    expect(snapshotStore.getSnapshot().snapshot.nodes).toHaveLength(2);
    expect(await snapshotStore.refreshSegments(["fabric", "policy"])).toBe(
      false,
    );
    failNodes = true;
    expect(await snapshotStore.refreshSegments(["fabric"])).toBe(false);
    expect(snapshotStore.getSnapshot().snapshot.nodes).toHaveLength(2);
    // Post-write refreshes keep the existing non-throwing Promise<void> contract.
    expect(await snapshotStore.refreshSnapshot()).toBeUndefined();
    failNodes = false;
    expect(await snapshotStore.refreshSegments(["fabric"])).toBe(true);
    expect(snapshotStore.getSnapshot().refreshErrors.fabric).toBeUndefined();
    snapshotStore.setAuthorized(false);
    expect(await snapshotStore.refreshSegments(["fabric"])).toBe(false);
  });

  test("an authorized store without an adopted session reports locked and publishes nothing", async () => {
    const execute = vi.spyOn(auth, "read");
    clientStore.clear();
    snapshotStore.setAuthorized(true);
    await snapshotStore.refreshSegments(["identity"]);
    expect(execute).not.toHaveBeenCalled();
    expect(snapshotStore.getSnapshot().refreshErrors.identity).toBeTruthy();
  });

  test("a later identity response wins even when the superseded transport finishes last", async () => {
    const responses = [
      Promise.withResolvers<Response>(),
      Promise.withResolvers<Response>(),
    ];
    const signals: Array<AbortSignal | null> = [];
    useTransport(async (path, signal) => {
      if (path !== "/api/v1/user") return responseFor(path);
      signals.push(signal);
      return responses[signals.length - 1].promise;
    });
    const first = snapshotStore.refreshSegments(["identity"]);
    await expect.poll(() => signals.length).toBe(1);
    const second = snapshotStore.refreshSegments(["identity"]);
    await expect.poll(() => signals.length).toBe(2);
    expect(signals[1]?.aborted).toBe(false);
    responses[1].resolve(
      Response.json({ users: [{ id: "2", name: "newer" }] }),
    );
    expect(await second).toBe(true);
    responses[0].resolve(
      Response.json({ users: [{ id: "1", name: "older" }] }),
    );
    expect(await first).toBe(false);
    expect(snapshotStore.getSnapshot().snapshot.users).toEqual([
      { id: "2", name: "newer" },
    ]);
    expect(signals[0]?.aborted).toBe(true);
    expect(snapshotStore.getSnapshot().refreshErrors).toEqual({});
  });

  test("an unset file-mode policy path still gives a ready snapshot without refresh errors", async () => {
    fixture.policyFailure = {
      status: 500,
      message: 'reading policy from path "": open : no such file or directory',
    };
    snapshotStore.setAuthorized(true);
    await snapshotStore.refreshSnapshot();
    expect(snapshotStore.getSnapshot()).toMatchObject({
      isReady: true,
      refreshErrors: {},
    });
    expect(snapshotStore.getSnapshot().snapshot.policy).toEqual({
      policy: "",
      fileModeWithoutPath: true,
    });
  });

  test("deduplicates repeated segments within one refresh call", async () => {
    let requests = 0;
    useTransport(async (path) => {
      if (path === "/api/v1/user") requests++;
      return responseFor(path);
    });
    await snapshotStore.refreshSegments(["identity", "identity"]);
    expect(requests).toBe(1);
  });

  test.each(["fabric", "policy"] as const)(
    "a later %s response wins over an older request in the same session",
    async (segment) => {
      const replies = [
        Promise.withResolvers<Response>(),
        Promise.withResolvers<Response>(),
      ];
      let calls = 0;
      const pathToHold =
        segment === "fabric" ? "/api/v1/node" : "/api/v1/policy";
      useTransport(async (path) =>
        path === pathToHold ? replies[calls++].promise : responseFor(path),
      );
      const older = snapshotStore.refreshSegments([segment]);
      await expect.poll(() => calls).toBe(1);
      const newer = snapshotStore.refreshSegments([segment]);
      await expect.poll(() => calls).toBe(2);
      const payload = (name: string) =>
        segment === "fabric"
          ? { nodes: [{ id: "1", name, givenName: name }] }
          : {
              policy: JSON.stringify({
                acls: [],
                groups: { [`group:${name}`]: [] },
              }),
            };
      replies[1].resolve(Response.json(payload("newer")));
      await newer;
      replies[0].resolve(Response.json(payload("older")));
      await older;
      const snapshot = snapshotStore.getSnapshot().snapshot;
      if (segment === "fabric")
        expect(snapshot.nodes[0].givenName).toBe("newer");
      else
        expect(snapshot.policy?.policy).toBe(
          JSON.stringify({ acls: [], groups: { "group:newer": [] } }),
        );
    },
  );

  test("an older failure cannot report an error after the newer segment succeeded", async () => {
    const reply = Promise.withResolvers<Response>();
    let calls = 0;
    useTransport(async (path) =>
      path === "/api/v1/user" && ++calls === 1
        ? reply.promise
        : responseFor(path),
    );
    const older = snapshotStore.refreshSegments(["identity"]);
    await expect.poll(() => calls).toBe(1);
    await snapshotStore.refreshSegments(["identity"]);
    reply.resolve(Response.json({ message: "old failure" }, { status: 403 }));
    await older;
    expect(snapshotStore.getSnapshot().snapshot.users).toEqual(
      snapshotFixture().users,
    );
    expect(snapshotStore.getSnapshot().refreshErrors).toEqual({});
    expect(feedbackStore.getSnapshot().lastError).toBe("");
  });

  test("overlapping batches retain identity from A and fabric from B", async () => {
    const firstNodes = Promise.withResolvers<Response>();
    const identity = Promise.withResolvers<Response>();
    let nodeRequests = 0;
    useTransport(async (path) => {
      if (path === "/api/v1/user") return identity.promise;
      if (path === "/api/v1/node" && ++nodeRequests === 1)
        return firstNodes.promise;
      return responseFor(path);
    });
    const first = snapshotStore.refreshSegments(["identity", "fabric"]);
    await expect.poll(() => nodeRequests).toBe(1);
    const second = snapshotStore.refreshSegments(["fabric"]);
    await second;
    identity.resolve(
      Response.json({ users: [{ id: "3", name: "identity-A" }] }),
    );
    firstNodes.resolve(Response.json({ nodes: [] }));
    await first;
    expect(snapshotStore.getSnapshot().snapshot.users[0].name).toBe(
      "identity-A",
    );
    expect(snapshotStore.getSnapshot().snapshot.nodes).toHaveLength(2);
  });

  test("a failed segment preserves its data while other segments commit without clearing action errors", async () => {
    useTransport(async (path) =>
      path === "/api/v1/user"
        ? Response.json({ message: "identity denied" }, { status: 403 })
        : path === "/api/v1/node"
          ? Response.json({ nodes: [] })
          : responseFor(path),
    );
    feedbackStore.setState({ lastError: "action denied" });
    await snapshotStore.refreshSegments(["identity", "fabric"]);
    expect(snapshotStore.getSnapshot().snapshot.users).toHaveLength(1);
    expect(snapshotStore.getSnapshot().snapshot.nodes).toEqual([]);
    expect(snapshotStore.getSnapshot().snapshot.health?.serverReachable).toBe(
      true,
    );
    expect(snapshotStore.getSnapshot().refreshErrors).toEqual({
      identity: "identity denied",
    });
    expect(feedbackStore.getSnapshot().lastError).toBe("action denied");
  });

  test("a rejected API key reports localized guidance instead of the media-type fault", async () => {
    useTransport(async (path) =>
      path === "/api/v1/user"
        ? new Response("Unauthorized", { status: 401 })
        : responseFor(path),
    );
    await snapshotStore.refreshSegments(["identity"]);
    expect(snapshotStore.getSnapshot().refreshErrors).toEqual({
      identity: getProductCopy("en-US").errorRequestFailed,
    });
  });

  test("stale success cannot clear a later segment failure", async () => {
    const firstResponse = Promise.withResolvers<Response>();
    let calls = 0;
    useTransport(async (path) => {
      if (path !== "/api/v1/user") return responseFor(path);
      if (++calls === 1) return firstResponse.promise;
      return Response.json({ message: "current failure" }, { status: 403 });
    });
    const first = snapshotStore.refreshSegments(["identity"]);
    await expect.poll(() => calls).toBe(1);
    await snapshotStore.refreshSegments(["identity"]);
    firstResponse.resolve(Response.json({ users: [] }));
    await first;
    expect(snapshotStore.getSnapshot().refreshErrors).toEqual({
      identity: "current failure",
    });
    await snapshotStore.refreshSegments(["fabric"]);
    expect(snapshotStore.getSnapshot().refreshErrors).toEqual({
      identity: "current failure",
    });
  });

  test.each([
    { kind: "network", offline: true },
    { kind: "status", offline: false },
    { kind: "contract", offline: false },
  ])(
    "only connectivity faults on the device list mark fabric offline: $kind",
    async ({ kind, offline }) => {
      useTransport(async (path) => {
        if (path !== "/api/v1/node") return responseFor(path);
        if (kind === "network") throw new TypeError("Connection refused");
        return kind === "status"
          ? Response.json({ message: "server rejected nodes" }, { status: 500 })
          : Response.json({ nodes: "invalid" });
      });
      await snapshotStore.refreshSegments(["fabric"]);
      expect(snapshotStore.getSnapshot().snapshot.health?.serverReachable).toBe(
        !offline,
      );
      expect(snapshotStore.getSnapshot().refreshErrors.fabric).toBeTruthy();
      expect(feedbackStore.getSnapshot().lastError).toBe("");
    },
  );

  test("optional version and health failures keep the device list and the snapshot ready", async () => {
    useTransport(async (path) =>
      path === "/version"
        ? new Response("<html>missing</html>", { status: 404 })
        : responseFor(path),
    );
    snapshotStore.applyPatch({ version: { version: "v0.29.1" } });
    await snapshotStore.refreshSnapshot();
    expect(snapshotStore.getSnapshot()).toMatchObject({
      isReady: true,
      refreshErrors: {},
    });
    expect(snapshotStore.getSnapshot().snapshot.version).toEqual({
      version: "v0.29.1",
    });
    expect(snapshotStore.getSnapshot().snapshot.nodes).toHaveLength(2);
    expect(snapshotStore.getSnapshot().snapshot.health?.serverReachable).toBe(
      true,
    );
    snapshotStore.setAuthorized(false);
    useTransport(async (path) =>
      path === "/api/v1/health"
        ? Response.json({ message: "no db" }, { status: 500 })
        : responseFor(path),
    );
    await snapshotStore.refreshSnapshot();
    expect(snapshotStore.getSnapshot()).toMatchObject({
      isReady: true,
      refreshErrors: {},
    });
    expect(snapshotStore.getSnapshot().snapshot.health).toBeNull();
    expect(snapshotStore.getSnapshot().snapshot.nodes).toHaveLength(2);
  });

  test("an unreadable device list on an unsupported server reports the isolated version", async () => {
    useTransport(async (path) =>
      path === "/api/v1/node"
        ? Response.json({ nodes: "invalid" })
        : path === "/version"
          ? Response.json({ version: "0.28.0" })
          : responseFor(path),
    );
    await snapshotStore.refreshSegments(["fabric"]);
    const message = snapshotStore.getSnapshot().refreshErrors.fabric;
    expect(message).toContain("\u20680.28.0\u2069");
    expect(message).not.toContain("{version}");
    expect(snapshotStore.getSnapshot().snapshot.health?.serverReachable).toBe(
      true,
    );
  });

  test("policy invalidation and logout abort old GETs without reporting failures", async () => {
    const reply = Promise.withResolvers<Response>();
    const signals: AbortSignal[] = [];
    useTransport(async (path, requestSignal) => {
      if (path !== "/api/v1/policy") return responseFor(path);
      if (requestSignal) signals.push(requestSignal);
      return reply.promise;
    });
    const refreshing = snapshotStore.refreshSegments(["policy"]);
    await expect.poll(() => signals.length).toBe(1);
    snapshotStore.invalidatePolicyRefreshes();
    expect(signals[0]?.aborted).toBe(true);
    snapshotStore.applyPatch({
      policy: { policy: '{"acls":[],"groups":{"group:new":["alice@"]}}' },
    });
    reply.resolve(Response.json({ policy: '{"acls":[]}' }));
    await refreshing;
    expect(snapshotStore.getSnapshot().snapshot.policy?.policy).toContain(
      "group:new",
    );
    snapshotStore.setAuthorized(false);
    expect(snapshotStore.getSnapshot().refreshErrors).toEqual({});
    expect(snapshotStore.isRefreshing).toBe(false);
  });

  test("a successful segment clears only its own refresh error", async () => {
    let fail = true;
    useTransport(async (path) =>
      fail && ["/api/v1/user", "/api/v1/policy"].includes(path)
        ? Response.json({ message: "denied" }, { status: 403 })
        : responseFor(path),
    );
    await snapshotStore.refreshSegments(["identity", "policy"]);
    fail = false;
    await snapshotStore.refreshSegments(["identity"]);
    expect(snapshotStore.getSnapshot().refreshErrors).toEqual({
      policy: "denied",
    });
  });

  test("a session switch resets refresh ownership and an old completion cannot decrement the new count", async () => {
    const pending = [
      Promise.withResolvers<Response>(),
      Promise.withResolvers<Response>(),
    ];
    const signals: Array<AbortSignal | null> = [];
    useTransport(async (path, signal) => {
      if (path !== "/api/v1/policy") return responseFor(path);
      signals.push(signal);
      return pending[signals.length - 1].promise;
    });
    const old = snapshotStore.refreshSegments(["policy"]);
    await expect.poll(() => signals.length).toBe(1);
    snapshotStore.setAuthorized(false);
    snapshotStore.setAuthorized(true);
    snapshotStore.applyPatch(snapshotFixture());
    expect(snapshotStore.getSnapshot().refreshSnapshotInFlight).toBe(0);
    const current = snapshotStore.refreshSegments(["policy"]);
    await expect.poll(() => signals.length).toBe(2);
    pending[0].resolve(Response.json({ policy: '{"acls":[]}' }));
    await old;
    expect(snapshotStore.getSnapshot().refreshSnapshotInFlight).toBe(1);
    expect(signals[0]?.aborted).toBe(true);
    pending[1].resolve(responseFor("/api/v1/policy"));
    await current;
    expect(snapshotStore.isRefreshing).toBe(false);
  });

  test("has no users, devices, keys, policy or health before connecting", () => {
    expect(snapshotStore.getSnapshot().snapshot).toEqual({
      health: null,
      version: null,
      users: [],
      nodes: [],
      preAuthKeys: [],
      apiKeys: [],
      policy: null,
    });
  });
  test("open invitations count unused keys, not every key still available for registration", () => {
    const key = snapshotFixture().preAuthKeys[0];
    const usedReusable = {
      ...key,
      id: "used-reusable",
      reusable: true,
      used: true,
      expiration: null,
    };
    expect(registrationKeyStatus(usedReusable).registration).toBe("available");
    snapshotStore.applyPatch({
      preAuthKeys: [
        {
          ...key,
          id: "unused",
          used: false,
          expiration: "2999-01-01T00:00:00Z",
        },
        {
          ...key,
          id: "unused-reusable",
          reusable: true,
          used: false,
          expiration: null,
        },
        usedReusable,
        { ...key, id: "exhausted", reusable: false, used: true },
        {
          ...key,
          id: "expired",
          reusable: true,
          used: false,
          expiration: "2000-01-01T00:00:00Z",
        },
        { ...key, id: "unknown", used: false, expiration: "unreadable" },
      ],
    });
    expect(snapshotStore.openInvites.map((entry) => entry.id)).toEqual([
      "unused",
      "unused-reusable",
    ]);
  });

  test("derives views and notifies only the current hook", () => {
    const api = snapshotStore;

    const next = snapshotFixture();
    next.nodes = [
      {
        ...next.nodes[0],
        id: "online-route",
        name: "fallback-name",
        givenName: "",
        online: true,
        availableRoutes: ["10.0.0.0/8"],
      },
      {
        ...next.nodes[1],
        id: "offline-node",
        name: "machine-name",
        givenName: "display-name",
        online: false,
        availableRoutes: [],
        approvedRoutes: [],
      },
    ];
    next.preAuthKeys = [
      {
        ...next.preAuthKeys[0],
        id: "open",
        used: false,
        expiration: "2999-01-01T00:00:00Z",
      },
      {
        ...next.preAuthKeys[0],
        id: "used",
        used: true,
        expiration: "2999-01-01T00:00:00Z",
      },
      {
        ...next.preAuthKeys[0],
        id: "expired",
        used: false,
        expiration: "2000-01-01T00:00:00Z",
      },
    ];

    const applied: HeadscaleSnapshot[] = [];
    api.setOnApplySnapshot((snapshot) => applied.push(snapshot));
    api.setAuthorized(true);
    api.applyPatch(next);

    expect(api.onlineNodes.map((node) => node.id)).toEqual(["online-route"]);
    expect(api.openInvites.map((key) => key.id)).toEqual(["open"]);
    expect(api.routeNodes.map((node) => node.id)).toEqual(["online-route"]);
    expect(api.nodeById("online-route")?.name).toBe("fallback-name");
    expect(api.nodeById("missing")).toBeUndefined();
    expect(api.userById(next.users[0].id)).toEqual(next.users[0]);
    expect(api.userById("missing")).toBeUndefined();

    api.applyPatch({ users: [] });
    expect(applied).toHaveLength(2);

    api.setOnApplySnapshot(null);
    api.applyOfflineHealth();
    expect(api.getSnapshot().snapshot.health).toMatchObject({
      databaseConnectivity: false,
      serverReachable: false,
    });
    expect(
      Number.isNaN(
        Date.parse(api.getSnapshot().snapshot.health?.checkedAt ?? ""),
      ),
    ).toBe(false);
  });

  test("skips unauthorized refreshes and clears stale errors after successful refreshes", async () => {
    const api = snapshotStore;
    const feedback = feedbackStore;
    feedback.setState({ lastError: "stale" });

    await api.refreshSegments(["identity"]);
    expect(feedback.getSnapshot().lastError).toBe("stale");
    expect(api.getSnapshot().refreshSnapshotInFlight).toBe(0);

    api.setAuthorized(true);
    await api.refreshSegments(["identity"]);
    expect(api.getSnapshot().snapshot.users).toHaveLength(1);
    expect(feedback.getSnapshot().lastError).toBe("");

    await api.refreshSnapshot();
    expect(api.getSnapshot().snapshot.version).toEqual({ version: "v0.29.4" });
    expect(api.getSnapshot().refreshSnapshotInFlight).toBe(0);
    expect(api.isRefreshing).toBe(false);
  });

  test("surfaces unexpected refresh failures without treating them as lost connectivity", async () => {
    const client = headscale;
    const api = snapshotStore;
    api.setAuthorized(true);
    api.applyPatch(snapshotFixture());
    const previous = api.getSnapshot().snapshot;
    vi.spyOn(client, "fetchSegment").mockImplementation(async () => {
      throw new Error("health failed");
    });

    await api.refreshSegments(["fabric"]);
    expect(api.getSnapshot().refreshErrors.fabric).toBe("health failed");
    expect(api.getSnapshot().snapshot.health?.serverReachable).toBe(true);
    expect(api.getSnapshot().snapshot.users).toBe(previous.users);
    expect(api.getSnapshot().snapshot.nodes).toBe(previous.nodes);
    expect(api.getSnapshot().snapshot.policy).toBe(previous.policy);
    expect(api.getSnapshot().snapshot.version).toBe(previous.version);

    vi.spyOn(client, "fetchSegment").mockImplementation(async () => {
      throw "string failure";
    });
    await api.refreshSegments(["fabric"]);
    expect(api.getSnapshot().refreshErrors.fabric).toBe("string failure");
    expect(api.getSnapshot().refreshSnapshotInFlight).toBe(0);
  });

  test("tracks concurrent refreshes until the final request settles", async () => {
    const client = headscale;
    const api = snapshotStore;
    api.setAuthorized(true);
    const resolvers: Array<(health: HealthResponse) => void> = [];
    vi.spyOn(client, "fetchSegment").mockImplementation(
      () =>
        new Promise<Partial<HeadscaleSnapshot>>((resolve) => {
          resolvers.push((health) => resolve({ health }));
        }),
    );

    const first = api.refreshSegments(["fabric"]);
    const second = api.refreshSegments(["fabric"]);
    await Promise.resolve();

    expect(api.getSnapshot().refreshSnapshotInFlight).toBe(2);
    expect(api.isRefreshing).toBe(true);

    resolvers[0]({ databaseConnectivity: true, serverReachable: true });
    await first;
    expect(api.getSnapshot().refreshSnapshotInFlight).toBe(1);

    resolvers[1]({ databaseConnectivity: true, serverReachable: true });
    await second;
    expect(api.getSnapshot().refreshSnapshotInFlight).toBe(0);
    expect(api.isRefreshing).toBe(false);
  });

  test("rebindSession supersedes in-flight reads while keeping data and readiness", async () => {
    let hold = false;
    const pending = Promise.withResolvers<Response>();
    const signals: AbortSignal[] = [];
    useTransport(async (path, signal) => {
      if (path !== "/api/v1/policy" || !hold) return responseFor(path);
      if (signal) signals.push(signal);
      return pending.promise;
    });
    await snapshotStore.refreshSnapshot();
    expect(snapshotStore.getSnapshot().isReady).toBe(true);
    const before = snapshotStore.getSnapshot().snapshot;
    const stillCurrent = snapshotStore.captureSession();
    hold = true;
    const old = snapshotStore.refreshSegments(["policy"]);
    await expect.poll(() => signals.length).toBe(1);
    expect(snapshotStore.getSnapshot().refreshSnapshotInFlight).toBe(1);

    snapshotStore.rebindSession();
    expect(signals[0]?.aborted).toBe(true);
    expect(stillCurrent()).toBe(false);
    expect(snapshotStore.captureSession()()).toBe(true);
    expect(snapshotStore.getSnapshot()).toMatchObject({
      isReady: true,
      isAuthorized: true,
      refreshSnapshotInFlight: 0,
    });
    expect(snapshotStore.getSnapshot().snapshot).toBe(before);

    pending.resolve(
      Response.json({ policy: '{"acls":[],"groups":{"group:late":[]}}' }),
    );
    expect(await old).toBe(false);
    expect(snapshotStore.getSnapshot().snapshot.policy).toBe(before.policy);
    expect(snapshotStore.getSnapshot().refreshSnapshotInFlight).toBe(0);
    expect(snapshotStore.getSnapshot().refreshErrors).toEqual({});

    hold = false;
    const readiness: boolean[] = [];
    const stop = snapshotStore.subscribe(() =>
      readiness.push(snapshotStore.getSnapshot().isReady),
    );
    await snapshotStore.refreshSegments(["identity"]);
    stop();
    expect(readiness).not.toContain(false);
    expect(snapshotStore.getSnapshot().isReady).toBe(true);
  });

  test("does not apply a previous session's refresh failure to the current session", async () => {
    const client = headscale;
    const api = snapshotStore;
    const feedback = feedbackStore;
    api.setAuthorized(true);
    const response = Promise.withResolvers<HealthResponse>();
    vi.spyOn(client, "fetchSegment").mockImplementation(() =>
      response.promise.then((health) => ({ health })),
    );
    const refreshing = api.refreshSegments(["fabric"]);

    api.setAuthorized(false);
    api.setAuthorized(true);
    api.applyPatch(snapshotFixture());
    feedback.setState({ lastError: "current session feedback" });
    response.reject(new Error("previous session failed"));
    await refreshing;

    expect(feedback.getSnapshot().lastError).toBe("current session feedback");
    expect(api.getSnapshot().snapshot.health?.serverReachable).toBe(true);
    expect(api.isRefreshing).toBe(false);
  });

  test("a refresh the user asked for announces only its own success in the current session", async () => {
    const failing = new Set<string>();
    let held: ReturnType<typeof Promise.withResolvers<Response>> | null = null;
    useTransport(async (path) => {
      if (held && path === "/api/v1/user") return held.promise;
      return failing.has(path)
        ? Response.json({ message: "denied" }, { status: 403 })
        : responseFor(path);
    });
    const notice = () => snapshotStore.getSnapshot().refreshNotice;
    expect(notice()).toBe(false);
    await snapshotStore.refreshByUser(["identity"]);
    expect(notice()).toBe(true);
    snapshotStore.clearRefreshNotice();
    expect(notice()).toBe(false);

    failing.add("/api/v1/node");
    await snapshotStore.refreshByUser(["identity"]);
    expect(notice()).toBe(true);
    // Starting another refresh withdraws the previous notice; a failed segment reports its error.
    await snapshotStore.refreshByUser();
    expect(notice()).toBe(false);
    expect(snapshotStore.getSnapshot().refreshErrors.fabric).toBe("denied");

    failing.clear();
    held = Promise.withResolvers<Response>();
    const replaced = snapshotStore.refreshByUser(["identity"]);
    snapshotStore.setAuthorized(false);
    snapshotStore.setAuthorized(true);
    held.resolve(responseFor("/api/v1/user"));
    await replaced;
    expect(notice()).toBe(false);

    held = null;
    snapshotStore.setAuthorized(false);
    await snapshotStore.refreshByUser(["identity"]);
    expect(notice()).toBe(false);
  });

  test("only explicit user refreshes publish completion, and separate attempts may use the same message", async () => {
    useTransport(async (path) =>
      path === "/api/v1/node"
        ? Response.json(
            { message: "background fabric failure" },
            { status: 503 },
          )
        : responseFor(path),
    );
    const add = vi.spyOn(feedbackStore.toastManager, "add");
    await snapshotStore.refreshSnapshot();
    await snapshotStore.refreshSegments(["identity", "policy"]);
    expect(snapshotStore.getSnapshot().refreshErrors.fabric).toBe(
      "background fabric failure",
    );
    expect(add).not.toHaveBeenCalled();

    const begin = vi.spyOn(feedbackStore, "beginNotification");
    await snapshotStore.refreshByUser(["identity"]);
    const first = begin.mock.results[0];
    expect.assert(first?.type === "return");
    const firstId = first.value.id;
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: firstId,
        title: i18n._(productDescriptors.dataRefreshed),
        priority: "low",
        data: { tone: "success", refreshGroup: firstId },
      }),
    );
    await snapshotStore.refreshByUser(["identity"]);
    const second = begin.mock.results[1];
    expect.assert(second?.type === "return");
    expect(add).toHaveBeenCalledTimes(2);
    expect(add.mock.calls[1]?.[0].id).not.toBe(firstId);
    expect(add).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: second.value.id,
        title: i18n._(productDescriptors.dataRefreshed),
        priority: "low",
        data: { tone: "success", refreshGroup: firstId },
      }),
    );
    snapshotStore.setAuthorized(false);
    await snapshotStore.refreshByUser(["identity"]);
    expect(add).toHaveBeenCalledTimes(2);
  });

  test("a separate failed user read reports once without raw diagnostics or clearing the unresolved write", async () => {
    const raw = "read-response-secret-canary";
    useTransport(async () => Response.json({ message: raw }, { status: 503 }));
    const add = vi.spyOn(feedbackStore.toastManager, "add");
    await snapshotStore.refreshSegments(["fabric", "identity", "policy"]);
    expect(add).not.toHaveBeenCalled();
    const outcome = {
      status: "unknown",
      refresh: "failed",
      recordId: "retained-write",
    } as const;
    feedbackStore.setActionOutcome("rename-node", outcome);
    const write = feedbackStore.beginNotification({
      isCurrent: snapshotStore.captureSession(),
    });
    expect(write.publishMutation(outcome)).toBe(true);
    const before = feedbackStore.getSnapshot();

    await snapshotStore.refreshByUser();
    expect(add).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: i18n._(productDescriptors.feedbackRefreshFailed),
        priority: "low",
        data: { tone: "error" },
      }),
    );
    expect(add.mock.calls[1]?.[0].id).not.toBe(write.id);
    expect(JSON.stringify(add.mock.calls)).not.toContain(raw);
    expect(feedbackStore.getSnapshot()).toBe(before);
    expect(feedbackStore.actionOutcome("rename-node")).toEqual(outcome);
  });

  test("a superseded user read cannot announce the newer read's failure as its own result", async () => {
    const first = Promise.withResolvers<Response>();
    let reads = 0;
    useTransport(async (path) => {
      if (path !== "/api/v1/policy") return responseFor(path);
      reads += 1;
      return reads === 1
        ? first.promise
        : Response.json({ message: "latest read failed" }, { status: 503 });
    });
    const add = vi.spyOn(feedbackStore.toastManager, "add");
    const old = snapshotStore.refreshByUser(["policy"]);
    await expect.poll(() => reads).toBe(1);
    await snapshotStore.refreshByUser(["policy"]);
    first.resolve(responseFor("/api/v1/policy"));
    await old;
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        title: i18n._(productDescriptors.feedbackRefreshFailed),
      }),
    );
  });

  test("a non-user refresh that replaces a user read suppresses the user's notification", async () => {
    const first = Promise.withResolvers<Response>();
    let reads = 0;
    useTransport(async (path) => {
      if (path !== "/api/v1/policy") return responseFor(path);
      reads += 1;
      return reads === 1 ? first.promise : responseFor("/api/v1/policy");
    });
    const add = vi.spyOn(feedbackStore.toastManager, "add");
    const user = snapshotStore.refreshByUser(["policy"]);
    await expect.poll(() => reads).toBe(1);
    await snapshotStore.refreshSegments(["policy"]);
    first.resolve(responseFor("/api/v1/policy"));
    await user;
    expect(add).not.toHaveBeenCalled();
    expect(snapshotStore.getSnapshot().refreshNotice).toBe(false);
  });

  test("a failed replacement read is not reported as the user's own refresh result", async () => {
    const held = Promise.withResolvers<Response>();
    let mode: "existing" | "held" | "replacement" = "existing";
    useTransport(async (path) => {
      if (path !== "/api/v1/policy") return responseFor(path);
      if (mode === "existing")
        return Response.json({ message: "existing failure" }, { status: 503 });
      if (mode === "held") {
        mode = "replacement";
        return held.promise;
      }
      return Response.json(
        { message: "replacement read failed" },
        { status: 503 },
      );
    });
    const add = vi.spyOn(feedbackStore.toastManager, "add");
    expect(await snapshotStore.refreshSegments(["policy"])).toBe(false);
    mode = "held";
    const user = snapshotStore.refreshByUser(["policy"]);
    await expect.poll(() => mode).toBe("replacement");
    await snapshotStore.refreshSegments(["policy"]);
    held.resolve(responseFor("/api/v1/policy"));
    await user;
    expect(add).not.toHaveBeenCalled();
    expect(snapshotStore.getSnapshot().refreshNotice).toBe(false);
  });

  test.each([false, true])(
    "an old session's user refresh cannot notify after a newer session succeeds (reject=%s)",
    async (reject) => {
      const first = Promise.withResolvers<Response>();
      let started = false;
      useTransport(async (path) => {
        if (path !== "/api/v1/policy") return responseFor(path);
        started = true;
        return first.promise;
      });
      const add = vi.spyOn(feedbackStore.toastManager, "add");
      const begin = vi.spyOn(feedbackStore, "beginNotification");
      const old = snapshotStore.refreshByUser(["policy"]);
      await expect.poll(() => started).toBe(true);
      snapshotStore.setAuthorized(false);
      snapshotStore.setAuthorized(true);
      await snapshotStore.refreshByUser(["identity"]);
      const retired = begin.mock.results[0];
      const current = begin.mock.results[1];
      expect.assert(retired?.type === "return");
      expect.assert(current?.type === "return");
      expect(current.value.id).not.toBe(retired.value.id);
      if (reject) first.reject(new Error("retired-read-secret-canary"));
      else first.resolve(responseFor("/api/v1/policy"));
      await old;
      expect(add).toHaveBeenCalledTimes(1);
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({
          id: current.value.id,
          title: i18n._(productDescriptors.dataRefreshed),
          priority: "low",
          data: { tone: "success", refreshGroup: current.value.id },
        }),
      );
      expect(JSON.stringify(add.mock.calls)).not.toContain(
        "retired-read-secret-canary",
      );
    },
  );
});
