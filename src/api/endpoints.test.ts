import type { AnyStruct, HttpCommand } from "@defjs/core";
import { createClient, createHttpInterceptor, withEndpoint, withInterceptors } from "@defjs/core";
import { afterEach, beforeEach, describe, expect, expectTypeOf, test, vi } from "vitest";
import { fixtureGateway } from "@/test/operation-gateway";
import { normalizeHeadscaleNode, normalizePreAuthKey } from "./contracts";
import * as endpoints from "./requests";
import { readHealth as readGatewayHealth } from "./snapshot";

const readHealth = (http: HeadscaleHttp) => readGatewayHealth(fixtureGateway(http));

import { createFixtureHttp } from "@/test/operation-gateway";
import type { HeadscaleHttp } from "./http";

type SeenRequest = {
  body: unknown;
  method: string;
  path: string;
  query: Record<string, string>;
  token: string | null;
};

let server: ReturnType<typeof Bun.serve>;
let seenRequests: SeenRequest[] = [];

function json(data: unknown, init: ResponseInit = {}) {
  return Response.json(data, init);
}

async function requestBody(request: Request) {
  if (request.method === "GET" || request.method === "DELETE") {
    return null;
  }

  const text = await request.text();
  return text ? JSON.parse(text) : null;
}

function snapshotPayload() {
  const user = {
    id: "1",
    name: "alice",
    displayName: "Alice Ops",
    email: "alice@example.com",
    provider: "cli",
    createdAt: "2026-05-04T00:00:00Z",
  };
  const node = {
    id: "1",
    name: "alice-laptop",
    ipAddresses: ["100.64.0.1"],
    user,
    online: true,
    approvedRoutes: [],
    availableRoutes: ["10.42.0.0/16"],
    subnetRoutes: ["10.42.0.0/16"],
    tags: ["tag:workstation"],
  };

  return { node, user };
}

function responseFor(path: string) {
  const { node, user } = snapshotPayload();

  if (path === "/api/v1/health") {
    return { databaseConnectivity: true };
  }
  if (path === "/version") {
    return { version: "0.29.4" };
  }
  if (path === "/api/v1/user") {
    return { users: [user], user };
  }
  if (path.includes("/api/v1/user/")) {
    return { user: { ...user, name: "alice-admin" } };
  }
  if (path === "/api/v1/preauthkey") {
    return {
      preAuthKeys: [],
      preAuthKey: {
        id: "1",
        key: "preauthkey-demo",
        reusable: true,
        ephemeral: false,
        used: false,
        expiration: "2026-12-31T23:59:00Z",
        aclTags: ["tag:server"],
      },
    };
  }
  if (path === "/api/v1/node" || path.startsWith("/api/v1/node/")) {
    return { nodes: [node], node, changes: ["100.64.0.88 reserved"] };
  }
  if (path === "/api/v1/auth/register") {
    return { node };
  }
  if (path === "/api/v1/debug/node") {
    return { node: { ...node, id: "2", name: "debug-router" } };
  }
  if (path === "/api/v1/apikey") {
    return { apiKeys: [{ id: "1", prefix: "ak_live_demo" }], apiKey: "ak_live_demo.secret" };
  }
  if (path.startsWith("/api/v1/apikey/")) {
    return {};
  }
  if (path === "/api/v1/policy") {
    return { policy: '{"acls":[]}', updatedAt: "2026-05-04T00:00:00Z" };
  }

  return {};
}

beforeEach(() => {
  seenRequests = [];
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      seenRequests.push({
        body: await requestBody(request),
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        token: request.headers.get("authorization"),
      });

      return json(responseFor(url.pathname.replace(/^\/(?:headscale|shared)/, "")));
    },
  });
});

afterEach(() => {
  server.stop(true);
});

function client() {
  return createFixtureHttp({
    baseUrl: `http://127.0.0.1:${server.port}`,
    apiKey: "test-token",
  });
}

async function execute<
  I extends AnyStruct | undefined,
  O extends AnyStruct | undefined,
  E extends AnyStruct | undefined,
>(command: HttpCommand<I, O, E>, http: HeadscaleHttp = client()) {
  const [error, data] = await http.execute(command);
  if (error) throw error;
  return data;
}

function seen(path: string, method?: string) {
  return seenRequests.find(
    (request) => request.path === path && (!method || request.method === method),
  );
}

describe("Headscale endpoint contracts", () => {
  test("uses the injected transport for business requests", async () => {
    const http = createFixtureHttp({
      baseUrl: `${server.url.origin}/shared`,
      apiKey: "shared-token",
    });
    await readHealth(http);
    expect(seenRequests[0]?.path).toBe("/shared/api/v1/health");
    expect(seenRequests[0]?.token).toBe("Bearer shared-token");
  });

  test("rejects a fault from the shared transport interceptor", async () => {
    const settings = { baseUrl: server.url.origin, apiKey: "test-token" };
    const http = createClient(
      withEndpoint(settings.baseUrl),
      withInterceptors(
        createHttpInterceptor(async () => {
          throw new Error("interceptor refused the request");
        }),
      ),
    );
    await expect(readHealth(http)).rejects.toThrow("interceptor refused the request");
    expect(seenRequests).toEqual([]);
  });

  test("propagates exceptions thrown by transport callbacks", async () => {
    const settings = { baseUrl: server.url.origin, apiKey: "test-token" };
    const http = createFixtureHttp(settings);
    const failure = new Error("transport callback failed");
    // Defjs normally returns faults; injected callback rejections must still propagate.
    const executeSpy = vi.spyOn(http, "execute").mockRejectedValueOnce(failure);
    try {
      await expect(execute(endpoints.version(), http)).rejects.toBe(failure);
      expect(seenRequests).toEqual([]);
    } finally {
      executeSpy.mockRestore();
    }
  });

  test("preserves base path and encoded parameters", async () => {
    const api = createFixtureHttp({
      baseUrl: ` ${server.url.origin}/headscale/// `,
      apiKey: "test-token",
    });
    await execute(endpoints.renameUser({ id: "7", newName: "Ops / 亚洲?#" }), api);
    await execute(endpoints.deleteApiKey({ prefix: "prefix/part?x#y" }), api);
    await execute(endpoints.listUsers({ name: "Ops & 亚洲", email: "alice+ops@example.com" }), api);
    expect(seenRequests.map(({ path }) => path)).toEqual([
      "/headscale/api/v1/user/7/rename/Ops%20%2F%20%E4%BA%9A%E6%B4%B2%3F%23",
      "/headscale/api/v1/apikey/prefix%2Fpart%3Fx%23y",
      "/headscale/api/v1/user",
    ]);
    expect(seenRequests[2]?.query).toEqual({
      name: "Ops & 亚洲",
      email: "alice+ops@example.com",
    });
  });

  test("preserves server error messages", async () => {
    server.reload({
      fetch: () => Response.json({ message: "invalid policy: missing src" }, { status: 400 }),
    });
    await expect(execute(endpoints.setPolicy({ policy: "{}" }))).rejects.toMatchObject({
      code: "HTTP_STATUS",
      status: 400,
      data: { message: "invalid policy: missing src" },
    });
  });

  test("reports the HTTP status when an error body violates the JSON contract", async () => {
    server.reload({ fetch: () => new Response("Forbidden", { status: 403 }) });
    await expect(execute(endpoints.version())).rejects.toMatchObject({
      code: "RES_MEDIA_TYPE_INVALID",
      status: 403,
    });
  });

  test.each([200, 204])("preserves empty responses with status %s", async (status) => {
    server.reload({ fetch: () => new Response(null, { status }) });
    expect(await execute(endpoints.deleteNode({ nodeId: "7" }))).toBeUndefined();
  });

  test("infers command inputs and decoded response values from the contract", async () => {
    expectTypeOf<Parameters<typeof endpoints.createUser>[0]>().toEqualTypeOf<{
      name: string;
      displayName?: string;
      email?: string;
      pictureUrl?: string;
    }>();
    expectTypeOf<Parameters<typeof endpoints.setTags>[0]>().toEqualTypeOf<{
      nodeId: string;
      tags: string[];
    }>();
    const [error, data] = await client().execute(
      endpoints.createApiKey({ expiration: "2027-01-01T00:00:00Z" }),
    );
    if (error) throw error;
    expectTypeOf(data.apiKey).toEqualTypeOf<string>();
    expect(data.apiKey).toBe("ak_live_demo.secret");
  });

  test("rejects empty API key identities before a write", async () => {
    await expect(execute(endpoints.expireApiKey({ prefix: "" }))).rejects.toMatchObject({
      code: "REQ_BUILD_FAILED",
    });
    await expect(execute(endpoints.deleteApiKey({ prefix: "" }))).rejects.toMatchObject({
      code: "REQ_BUILD_FAILED",
    });
    expect(seenRequests).toEqual([]);
  });

  test("does not read a successful body when the endpoint declares no output", async () => {
    server.reload({ fetch: () => new Response("", { headers: { "content-type": "text/plain" } }) });
    expect(await execute(endpoints.deleteNode({ nodeId: "7" }))).toBeUndefined();
  });

  test("keeps validated response extensions", async () => {
    server.reload({
      fetch: () =>
        Response.json({ nodes: [], nextPage: "cursor", experimental: { enabled: true } }),
    });
    expect(await execute(endpoints.listNodes({}))).toEqual({
      nodes: [],
      nextPage: "cursor",
      experimental: { enabled: true },
    });
  });

  test("rejects non-JSON success responses", async () => {
    server.reload({ fetch: () => new Response("headscale") });
    await expect(execute(endpoints.version())).rejects.toMatchObject({
      code: "RES_MEDIA_TYPE_INVALID",
    });
  });

  test.each([{ version: 29 }, { unexpected: "not a version response" }, null, []])(
    "rejects an invalid version response: %j",
    async (body) => {
      server.reload({ fetch: () => Response.json(body) });
      await expect(execute(endpoints.version())).rejects.toMatchObject({
        code: "RES_STRUCT_MISMATCH",
      });
    },
  );

  test("rejects malformed JSON instead of returning the response text", async () => {
    server.reload({
      fetch: () => new Response('{"version":', { headers: { "content-type": "application/json" } }),
    });
    await expect(execute(endpoints.version())).rejects.toMatchObject({ code: "RES_DECODE_FAILED" });
  });

  test.each([
    { message: { html: "server failure" } },
    { code: "permission denied", message: "forbidden" },
    { message: "forbidden", details: ["invalid rpc detail"] },
    { message: "forbidden", details: [{ "@type": false }] },
  ])("rejects an invalid RPC error body: %j", async (body) => {
    server.reload({ fetch: () => Response.json(body, { status: 403 }) });
    await expect(execute(endpoints.version())).rejects.toMatchObject({
      code: "RES_STRUCT_MISMATCH",
      status: 403,
    });
  });

  test.each([
    { nodes: "not an array" },
    { nodes: [{ id: 1, name: "node", online: false }] },
    { nodes: [{ id: "1", name: "node", ipAddresses: [1] }] },
    { nodes: [{ id: "1", name: "node", user: { id: "1", name: false } }] },
    { nodes: [{ id: "1", name: "node", online: "false" }] },
  ])("rejects invalid nested node data: %j", async (body) => {
    server.reload({ fetch: () => Response.json(body) });
    await expect(execute(endpoints.listNodes({}))).rejects.toMatchObject({
      code: "RES_STRUCT_MISMATCH",
    });
  });

  test("normalizes protobuf collections while retaining nullable metadata after validation", async () => {
    server.reload({
      fetch: () =>
        Response.json({
          nodes: [
            { id: "1", name: "node", user: null, preAuthKey: null, lastSeen: null, tags: null },
          ],
        }),
    });
    expect((await execute(endpoints.listNodes({}))).nodes?.map(normalizeHeadscaleNode)).toEqual([
      {
        id: "1",
        name: "node",
        user: null,
        ipAddresses: [],
        approvedRoutes: [],
        availableRoutes: [],
        subnetRoutes: [],
        tags: [],
        online: false,
      },
    ]);
  });

  test("normalizes nested credentials without losing nullable metadata or extensions", async () => {
    const wireKey = {
      id: "2",
      key: "test-preauth-secret",
      user: { id: "1", name: "alice", email: null },
      reusable: true,
      ephemeral: null,
      aclTags: null,
      expiration: null,
      customScope: { project: "development" },
    };
    server.reload({
      fetch: () =>
        Response.json({
          node: { id: "1", name: "node", preAuthKey: wireKey },
          preAuthKey: wireKey,
          apiKeys: [{ id: "3", prefix: "api-prefix", createdAt: null, provider: null }],
        }),
    });
    const result = await execute(endpoints.getNode({ nodeId: "1" }));
    const key = normalizeHeadscaleNode(result.node).preAuthKey;
    expect(key).toEqual({
      id: "2",
      key: "test-preauth-secret",
      user: { id: "1", name: "alice", email: null },
      reusable: true,
      ephemeral: false,
      used: false,
      aclTags: [],
      customScope: { project: "development" },
    });
    const created = await execute(
      endpoints.createPreAuthKey({ user: "1", expiration: "2027-01-01T00:00:00Z" }),
    );
    expect(normalizePreAuthKey(created.preAuthKey)).toEqual(key);
    const apiKeys = await execute(endpoints.listApiKeys());
    expect(apiKeys.apiKeys).toEqual([
      { id: "3", prefix: "api-prefix", createdAt: null, provider: null },
    ]);
  });

  test("maps Headscale's zero time to no date for expiry, lastSeen and expiration", () => {
    const zero = "0001-01-01T00:00:00Z";
    const node = normalizeHeadscaleNode({
      id: "1",
      name: "node",
      expiry: zero,
      lastSeen: "0001-01-01T00:00:00.000Z",
      preAuthKey: { id: "2", key: "k", expiration: zero },
    });
    expect(node.expiry).toBeUndefined();
    expect(node.lastSeen).toBeUndefined();
    expect(node.preAuthKey?.expiration).toBeUndefined();
    expect(normalizePreAuthKey({ id: "2", key: "k", expiration: zero }).expiration).toBeUndefined();
  });

  test("keeps dates, absent and empty values as specified and passes garbage through", () => {
    const timestamp = "2027-01-01T00:00:00Z";
    expect(
      normalizeHeadscaleNode({ id: "1", name: "n", expiry: timestamp, lastSeen: timestamp }),
    ).toMatchObject({
      expiry: timestamp,
      lastSeen: timestamp,
    });
    const absent = normalizeHeadscaleNode({ id: "1", name: "n" });
    expect(absent.expiry).toBeUndefined();
    expect(absent.lastSeen).toBeUndefined();
    expect(
      normalizeHeadscaleNode({ id: "1", name: "n", expiry: "", lastSeen: null }).expiry,
    ).toBeUndefined();
    expect(normalizeHeadscaleNode({ id: "1", name: "n", lastSeen: null }).lastSeen).toBeUndefined();
    expect(normalizePreAuthKey({ id: "2", key: "k", expiration: "" }).expiration).toBeUndefined();
    expect(normalizePreAuthKey({ id: "2", key: "k", expiration: "soon" }).expiration).toBe("soon");
  });

  test("keeps unknown nested response data while validating declared fields", async () => {
    server.reload({
      fetch: () =>
        Response.json({
          nodes: [
            {
              ...snapshotPayload().node,
              experimental: { enabled: true },
              user: { ...snapshotPayload().user, department: "operations", avatar: null },
            },
          ],
        }),
    });
    expect((await execute(endpoints.listNodes({}))).nodes?.[0]).toMatchObject({
      experimental: { enabled: true },
      user: { department: "operations", avatar: null },
    });
  });

  test.each([
    ["createUser", { name: false }],
    ["createPreAuthKey", { user: "1", aclTags: "tag:server", expiration: "2027-01-01T00:00:00Z" }],
    ["createPreAuthKey", { user: "1" }],
    ["createApiKey", {}],
    ["getNode", { nodeId: 1 }],
    ["setTags", { nodeId: "1", tags: "tag:server" }],
    ["setApprovedRoutes", { nodeId: "1", routes: [false] }],
    ["backfillNodeIps", { confirmed: "true" }],
    ["setPolicy", { policy: { acls: [] } }],
  ])("rejects invalid %s input without sending a request", async (method, payload) => {
    const api = client();
    const endpoint = Reflect.get(endpoints, method);
    await expect(execute(endpoint(payload), api)).rejects.toMatchObject({
      code: "REQ_INPUT_INVALID",
    });
    expect(seenRequests).toEqual([]);
  });

  test("requires an expiration for new keys and leaves the pre-auth key owner optional", async () => {
    expectTypeOf<Parameters<typeof endpoints.createApiKey>[0]>().toEqualTypeOf<{
      expiration: string;
    }>();
    expectTypeOf<
      Parameters<typeof endpoints.createPreAuthKey>[0]["expiration"]
    >().toEqualTypeOf<string>();
    expectTypeOf<Parameters<typeof endpoints.createPreAuthKey>[0]["user"]>().toEqualTypeOf<
      string | undefined
    >();
    // @ts-expect-error The contract requires an expiration.
    endpoints.createApiKey({});
    // @ts-expect-error The contract requires an expiration.
    endpoints.createPreAuthKey({ user: "1" });
    const api = client();
    await execute(
      endpoints.createPreAuthKey({ aclTags: ["tag:server"], expiration: "2027-01-01T00:00:00Z" }),
      api,
    );
    expect(seenRequests.map(({ body }) => body)).toEqual([
      { aclTags: ["tag:server"], expiration: "2027-01-01T00:00:00Z" },
    ]);
    expect(seenRequests[0]?.body).not.toHaveProperty("user");
  });

  test("does not retry a write after the 15000ms timeout", async () => {
    let writes = 0;
    server.reload({
      fetch: () => {
        writes++;
        return new Promise<Response>(() => {});
      },
    });
    const startedAt = performance.now();
    await expect(execute(endpoints.createUser({ name: "alice" }))).rejects.toThrow(
      /timeout|timed out/i,
    );
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(14_500);
    expect(performance.now() - startedAt).toBeLessThan(17_000);
    expect(writes).toBe(1);
  }, 18_000);

  test.each(["", "/api", "//127.0.0.1", "ftp://127.0.0.1", "http:", "https:headscale.test"])(
    "rejects an invalid server URL before sending credentials: %s",
    (baseUrl) => {
      expect(() => createFixtureHttp({ baseUrl, apiKey: "secret" })).toThrow();
      expect(seenRequests).toEqual([]);
    },
  );

  test("rejects blank API keys and trims accepted connection input", async () => {
    expect(() => createFixtureHttp({ baseUrl: String(server.url), apiKey: "   " })).toThrow();
    const api = createFixtureHttp({
      baseUrl: `  ${server.url}  `,
      apiKey: "  trimmed-key  ",
    });
    await execute(endpoints.health(), api);
    expect(seenRequests[0].token).toBe("Bearer trimmed-key");
  });
  test("sends the expected Headscale REST calls for every client method", async () => {
    const api = client();

    const health = await execute(endpoints.health(), api);
    const version = await execute(endpoints.version(), api);
    const users = await execute(
      endpoints.listUsers({ id: "1", name: "alice", email: "alice@example.com" }),
      api,
    );
    await execute(
      endpoints.createUser({
        name: "dana",
        displayName: "Dana",
        email: "dana@example.test",
        pictureUrl: "https://example.test/dana.png",
      }),
      api,
    );
    await execute(endpoints.renameUser({ id: "1", newName: "alice-admin" }), api);
    await execute(endpoints.deleteUser({ id: "3" }), api);
    const preAuthKeys = await execute(endpoints.listPreAuthKeys(), api);
    await execute(
      endpoints.createPreAuthKey({
        user: "1",
        reusable: true,
        ephemeral: false,
        expiration: "2026-12-31T23:59:00Z",
        aclTags: ["tag:server", "tag:router"],
      }),
      api,
    );
    await execute(endpoints.expirePreAuthKey({ id: "1" }), api);
    await execute(endpoints.deletePreAuthKey({ id: "2" }), api);
    const nodes = await execute(endpoints.listNodes({ user: "alice" }), api);
    const node = await execute(endpoints.getNode({ nodeId: "1" }), api);
    await execute(endpoints.registerNode({ user: "alice", key: "nodekey:pending-demo" }), api);
    await execute(
      endpoints.debugCreateNode({
        user: "alice",
        key: "nodekey:debug",
        name: "debug-router",
        routes: ["10.10.0.0/16"],
      }),
      api,
    );
    await execute(endpoints.renameNode({ nodeId: "1", newName: "alice-main" }), api);
    await execute(
      endpoints.expireNode({
        nodeId: "2",
        expiry: "2026-05-04T00:00:00Z",
        disableExpiry: true,
      }),
      api,
    );
    await execute(endpoints.deleteNode({ nodeId: "3" }), api);
    await execute(endpoints.setTags({ nodeId: "1", tags: ["tag:server", "tag:router"] }), api);
    await execute(
      endpoints.setApprovedRoutes({ nodeId: "2", routes: ["10.42.0.0/16", "0.0.0.0/0", "::/0"] }),
      api,
    );
    await execute(endpoints.backfillNodeIps({ confirmed: true }), api);
    const registered = await execute(
      endpoints.authRegister({ user: "alice", authId: "hskey-authreq-register" }),
      api,
    );
    const approved = await execute(endpoints.authApprove({ authId: "hskey-authreq-approve" }), api);
    const rejected = await execute(endpoints.authReject({ authId: "hskey-authreq-reject" }), api);
    const apiKeys = await execute(endpoints.listApiKeys(), api);
    await execute(endpoints.createApiKey({ expiration: "2026-12-31T23:59:00Z" }), api);
    await execute(endpoints.expireApiKey({ prefix: "ak_live_demo", id: "1" }), api);
    await execute(endpoints.expireApiKey({ id: "2" }), api);
    await execute(endpoints.deleteApiKey({ prefix: "ak_old_demo" }), api);
    await expect(execute(endpoints.expireApiKey(JSON.parse("{}")), api)).rejects.toMatchObject({
      code: "REQ_INPUT_INVALID",
    });
    await expect(
      execute(endpoints.deleteApiKey(JSON.parse('{"id":"2"}')), api),
    ).rejects.toMatchObject({ code: "REQ_INPUT_INVALID" });
    const policy = await execute(endpoints.getPolicy(), api);
    await execute(endpoints.setPolicy({ policy: '{"acls":[]}' }), api);
    const checked = await execute(endpoints.checkPolicy({ policy: '{"acls":[]}' }), api);

    expect(registered.node.name).toBe("alice-laptop");
    expect(approved).toBeUndefined();
    expect(rejected).toBeUndefined();
    expect(checked).toBeUndefined();
    expect(health.databaseConnectivity).toBe(true);
    expect(version.version).toBe("0.29.4");
    expect(users.users?.[0]?.name).toBe("alice");
    expect(preAuthKeys.preAuthKeys).toEqual([]);
    expect(nodes.nodes?.[0]?.name).toBe("alice-laptop");
    expect(node.node.id).toBe("1");
    expect(apiKeys.apiKeys?.[0]?.prefix).toBe("ak_live_demo");
    expect(policy.policy).toBe('{"acls":[]}');
    expect(seenRequests.every((request) => request.token === "Bearer test-token")).toBe(true);
    expect(seenRequests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /api/v1/health",
      "GET /version",
      "GET /api/v1/user",
      "POST /api/v1/user",
      "POST /api/v1/user/1/rename/alice-admin",
      "DELETE /api/v1/user/3",
      "GET /api/v1/preauthkey",
      "POST /api/v1/preauthkey",
      "POST /api/v1/preauthkey/expire",
      "DELETE /api/v1/preauthkey",
      "GET /api/v1/node",
      "GET /api/v1/node/1",
      "POST /api/v1/node/register",
      "POST /api/v1/debug/node",
      "POST /api/v1/node/1/rename/alice-main",
      "POST /api/v1/node/2/expire",
      "DELETE /api/v1/node/3",
      "POST /api/v1/node/1/tags",
      "POST /api/v1/node/2/approve_routes",
      "POST /api/v1/node/backfillips",
      "POST /api/v1/auth/register",
      "POST /api/v1/auth/approve",
      "POST /api/v1/auth/reject",
      "GET /api/v1/apikey",
      "POST /api/v1/apikey",
      "POST /api/v1/apikey/expire",
      "POST /api/v1/apikey/expire",
      "DELETE /api/v1/apikey/ak_old_demo",
      "GET /api/v1/policy",
      "PUT /api/v1/policy",
      "POST /api/v1/policy/check",
    ]);
    expect(seen("/api/v1/health", "GET")).toBeTruthy();
    expect(seen("/version", "GET")).toBeTruthy();
    expect(seen("/api/v1/user", "GET")?.query).toEqual({
      email: "alice@example.com",
      id: "1",
      name: "alice",
    });
    expect(seen("/api/v1/user", "POST")?.body).toEqual({
      displayName: "Dana",
      email: "dana@example.test",
      name: "dana",
      pictureUrl: "https://example.test/dana.png",
    });
    expect(seen("/api/v1/user/1/rename/alice-admin", "POST")).toBeTruthy();
    expect(seen("/api/v1/user/3", "DELETE")).toBeTruthy();
    expect(seen("/api/v1/preauthkey", "GET")?.query).toEqual({});
    expect(seen("/api/v1/preauthkey", "POST")?.body).toEqual({
      aclTags: ["tag:server", "tag:router"],
      ephemeral: false,
      expiration: "2026-12-31T23:59:00Z",
      reusable: true,
      user: "1",
    });
    expect(seen("/api/v1/preauthkey/expire", "POST")?.body).toEqual({ id: "1" });
    expect(seen("/api/v1/preauthkey", "DELETE")?.query).toEqual({ id: "2" });
    expect(seen("/api/v1/node", "GET")?.query).toEqual({ user: "alice" });
    expect(seen("/api/v1/node/1", "GET")?.query).toEqual({});
    expect(seen("/api/v1/node/register", "POST")?.query).toEqual({
      key: "nodekey:pending-demo",
      user: "alice",
    });
    expect(seen("/api/v1/debug/node", "POST")?.body).toEqual({
      key: "nodekey:debug",
      name: "debug-router",
      routes: ["10.10.0.0/16"],
      user: "alice",
    });
    expect(seen("/api/v1/node/1/rename/alice-main", "POST")).toBeTruthy();
    expect(seen("/api/v1/node/2/expire", "POST")?.query).toEqual({
      disableExpiry: "true",
      expiry: "2026-05-04T00:00:00Z",
    });
    expect(seen("/api/v1/node/3", "DELETE")).toBeTruthy();
    expect(seen("/api/v1/node/1/tags", "POST")?.body).toEqual({
      tags: ["tag:server", "tag:router"],
    });
    expect(seen("/api/v1/node/2/approve_routes", "POST")?.body).toEqual({
      routes: ["10.42.0.0/16", "0.0.0.0/0", "::/0"],
    });
    expect(seen("/api/v1/node/backfillips", "POST")?.query).toEqual({ confirmed: "true" });
    expect(seen("/api/v1/auth/register", "POST")).toMatchObject({
      body: { user: "alice", authId: "hskey-authreq-register" },
      query: {},
    });
    expect(seen("/api/v1/auth/approve", "POST")?.body).toEqual({ authId: "hskey-authreq-approve" });
    expect(seen("/api/v1/auth/reject", "POST")?.body).toEqual({ authId: "hskey-authreq-reject" });
    expect(seen("/api/v1/apikey", "GET")?.query).toEqual({});
    expect(seen("/api/v1/apikey", "POST")?.body).toEqual({
      expiration: "2026-12-31T23:59:00Z",
    });
    expect(
      seenRequests
        .filter((request) => request.path === "/api/v1/apikey/expire")
        .map((request) => request.body),
    ).toEqual([{ prefix: "ak_live_demo" }, { id: "2" }]);
    expect(seen("/api/v1/apikey/ak_old_demo", "DELETE")?.query).toEqual({});
    expect(seen("/api/v1/policy", "GET")?.query).toEqual({});
    expect(seen("/api/v1/policy", "PUT")?.body).toEqual({ policy: '{"acls":[]}' });
    expect(seen("/api/v1/policy/check", "POST")?.body).toEqual({ policy: '{"acls":[]}' });
  });

  test("auth.register rejects a success response without a node", async () => {
    server.reload({ fetch: () => Response.json({}) });
    await expect(
      execute(endpoints.authRegister({ user: "alice", authId: "hskey-authreq-x" })),
    ).rejects.toMatchObject({ code: "RES_STRUCT_MISMATCH" });
  });

  test.each([
    [
      "authApprove",
      { authId: "hskey-authreq-x" },
      404,
      { code: 5, message: "no pending auth session for auth_id hskey-authreq-x" },
    ],
    [
      "authReject",
      { authId: "hskey-authreq-x" },
      400,
      { code: 3, message: "invalid auth_id: expected prefix" },
    ],
    [
      "checkPolicy",
      { policy: "{}" },
      400,
      { code: 3, message: "test(s) failed: alice@ cannot reach bob@" },
    ],
    [
      "authRegister",
      { user: "alice", authId: "hskey-authreq-x" },
      500,
      { code: 2, message: "node not found in registration cache" },
    ],
  ])("%s keeps the server status and message", async (method, payload, status, body) => {
    server.reload({ fetch: () => Response.json(body, { status }) });
    const endpoint = Reflect.get(endpoints, method);
    await expect(execute(endpoint(payload))).rejects.toMatchObject({
      code: "HTTP_STATUS",
      status,
      data: body,
    });
  });

  test.each([
    ["authRegister", { user: "alice" }],
    ["authApprove", { authId: 1 }],
    ["authReject", {}],
    ["checkPolicy", { policy: {} }],
  ])("rejects invalid %s input without sending a request", async (method, payload) => {
    const endpoint = Reflect.get(endpoints, method);
    await expect(execute(endpoint(payload))).rejects.toMatchObject({ code: "REQ_INPUT_INVALID" });
    expect(seenRequests).toEqual([]);
  });
});
