import { Agent } from "node:http";
import axios from "axios";
import type { HeadscaleSnapshot } from "@/api/types";

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
    version: { version: "0.28.0" },
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
    policy: { policy: '{"acls":[{"action":"accept","src":["*"],"dst":["*:*"]}]}' },
  };
}

// Fixed HTTP inputs exercise the real transport; this fixture has no business mutations.
export function isolateHttpConnections() {
  const previous = axios.defaults.httpAgent;
  const agent = new Agent({ keepAlive: false });
  // shortcut: disable test keep-alive on Bun 1.4.2 until sequential Axios requests stop resetting.
  axios.defaults.httpAgent = agent;
  return () => {
    axios.defaults.httpAgent = previous;
    agent.destroy();
  };
}

export function startSnapshotServer() {
  const restoreHttpAgent = isolateHttpConnections();
  const snapshot = snapshotFixture();
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
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
    baseUrl: server.url.origin,
    stop() {
      server.stop(true);
      restoreHttpAgent();
    },
  };
}
