import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isolateHttpConnections } from "@/test-utils/headscale.test";
import { RestHeadscaleClient } from "./headscale-client";

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
    return { version: "0.28.0" };
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

let restoreHttpAgent: () => void;
beforeEach(() => {
  restoreHttpAgent = isolateHttpConnections();
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

      return json(responseFor(url.pathname));
    },
  });
});

afterEach(() => {
  restoreHttpAgent();
  server.stop(true);
});

function client() {
  return new RestHeadscaleClient({
    baseUrl: `http://127.0.0.1:${server.port}`,
    apiKey: "test-token",
  });
}

function seen(path: string, method?: string) {
  return seenRequests.find(
    (request) => request.path === path && (!method || request.method === method),
  );
}

describe("RestHeadscaleClient", () => {
  test.each([
    "",
    "/api",
    "//127.0.0.1",
    "ftp://127.0.0.1",
    "http:",
    "https:headscale.test",
  ])("rejects an invalid server URL before sending credentials: %s", (baseUrl) => {
    expect(() => new RestHeadscaleClient({ baseUrl, apiKey: "secret" })).toThrow();
    expect(seenRequests).toEqual([]);
  });

  test("rejects blank API keys and trims accepted connection input", async () => {
    expect(() => new RestHeadscaleClient({ baseUrl: String(server.url), apiKey: "   " })).toThrow();
    const api = new RestHeadscaleClient({
      baseUrl: `  ${server.url}  `,
      apiKey: "  trimmed-key  ",
    });
    await api.health();
    expect(seenRequests[0].token).toBe("Bearer trimmed-key");
  });
  test("sends the expected Headscale REST calls for every client method", async () => {
    const api = client();

    const health = await api.health();
    const version = await api.version();
    const users = await api.listUsers({ id: "1", name: "alice", email: "alice@example.com" });
    await api.createUser({
      name: "dana",
      displayName: "Dana",
      email: "dana@example.test",
      pictureUrl: "https://example.test/dana.png",
    });
    await api.renameUser({ id: "1", newName: "alice-admin" });
    await api.deleteUser({ id: "3" });
    const preAuthKeys = await api.listPreAuthKeys();
    await api.createPreAuthKey({
      user: "1",
      reusable: true,
      ephemeral: false,
      expiration: "2026-12-31T23:59:00Z",
      aclTags: "tag:server,tag:router",
    });
    await api.expirePreAuthKey({ id: "1" });
    await api.deletePreAuthKey({ id: "2" });
    const nodes = await api.listNodes({ user: "alice" });
    const node = await api.getNode({ nodeId: "1" });
    await api.registerNode({ user: "alice", key: "nodekey:pending-demo" });
    await api.debugCreateNode({
      user: "alice",
      key: "nodekey:debug",
      name: "debug-router",
      routes: "10.10.0.0/16",
    });
    await api.renameNode({ nodeId: "1", newName: "alice-main" });
    await api.expireNode({
      nodeId: "2",
      expiry: "2026-05-04T00:00:00Z",
      disableExpiry: true,
    });
    await api.deleteNode({ nodeId: "3" });
    await api.setTags({ nodeId: "1", tags: "tag:server,tag:router" });
    await api.setApprovedRoutes({ nodeId: "2", routes: "10.42.0.0/16,0.0.0.0/0,::/0" });
    await api.backfillNodeIps({ confirmed: true });
    const apiKeys = await api.listApiKeys();
    await api.createApiKey({ expiration: "2026-12-31T23:59:00Z" });
    await api.expireApiKey({ prefix: "ak_live_demo", id: "1" });
    await api.expireApiKey({ id: "2" });
    await api.deleteApiKey({ prefix: "ak_old_demo", id: "2" });
    await expect(api.expireApiKey({})).rejects.toThrow("API key prefix or ID is required");
    await expect(api.deleteApiKey({ id: "2" })).rejects.toThrow("API key prefix is required");
    const policy = await api.getPolicy();
    await api.setPolicy({ policy: '{"acls":[]}' });

    expect(health.databaseConnectivity).toBe(true);
    expect(version.version).toBe("0.28.0");
    expect(users.users[0]?.name).toBe("alice");
    expect(preAuthKeys.preAuthKeys).toEqual([]);
    expect(nodes.nodes[0]?.name).toBe("alice-laptop");
    expect(node.node.id).toBe("1");
    expect(apiKeys.apiKeys[0]?.prefix).toBe("ak_live_demo");
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
      "GET /api/v1/apikey",
      "POST /api/v1/apikey",
      "POST /api/v1/apikey/expire",
      "POST /api/v1/apikey/expire",
      "DELETE /api/v1/apikey/ak_old_demo",
      "GET /api/v1/policy",
      "PUT /api/v1/policy",
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
  });
});
