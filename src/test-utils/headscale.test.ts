import type { HeadscaleSnapshot } from "@/api/contracts";

export function snapshotFixture(): HeadscaleSnapshot {
  const user = { id: "1", name: "test-user" };
  const node = {
    id: "1",
    name: "test-device",
    user,
    ipAddresses: ["100.64.0.1"],
    online: true,
    approvedRoutes: [],
    availableRoutes: [],
    subnetRoutes: [],
    tags: [],
  };
  return {
    health: { databaseConnectivity: true, serverReachable: true },
    version: { version: "v0.29.4" },
    users: [user],
    nodes: [node, { ...node, id: "2", name: "second-device" }],
    preAuthKeys: [
      {
        id: "1",
        key: "test-auth-key",
        user,
        reusable: false,
        ephemeral: false,
        used: false,
        aclTags: [],
      },
    ],
    apiKeys: [{ id: "1", prefix: "test-api-key" }],
    policy: {
      policy: '{"acls":[{"action":"accept","src":["*"],"dst":["*:*"]}]}',
    },
  };
}

export function startSnapshotServer() {
  const snapshot = snapshotFixture();
  const requests: string[] = [];
  const control = {
    policyFailure: null as { status: number; message: string } | null,
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
      if (path === "/api/v1/policy" && request.method === "PUT") {
        const body = await request.json();
        snapshot.policy = { policy: body.policy };
        return Response.json(snapshot.policy);
      }
      if (path === "/api/v1/policy" && control.policyFailure) {
        const { status, message } = control.policyFailure;
        return Response.json({ code: 2, message, details: [] }, { status });
      }
      const responses: Record<string, unknown> = {
        "/api/v1/health": snapshot.health,
        "/version": snapshot.version,
        "/api/v1/user": { users: snapshot.users },
        "/api/v1/node": { nodes: snapshot.nodes },
        "/api/v1/preauthkey": { preAuthKeys: snapshot.preAuthKeys },
        "/api/v1/apikey": { apiKeys: snapshot.apiKeys },
        "/api/v1/policy": snapshot.policy,
      };
      return Response.json(responses[path]);
    },
  });
  return {
    snapshot,
    requests,
    get policyFailure() {
      return control.policyFailure;
    },
    set policyFailure(value) {
      control.policyFailure = value;
    },
    baseUrl: server.url.origin,
    stop() {
      server.stop(true);
    },
  };
}
