import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fetchSnapshot } from "@/composables/useSnapshot";
import { RestHeadscaleClient } from "./headscale-client";

let server: ReturnType<typeof Bun.serve>;
let policyErrorMessage = "";
let policyRequested = false;

const user = { id: "1", name: "alice", email: "alice@example.com" };
const node = {
  id: "1",
  name: "alice-laptop",
  ipAddresses: ["100.64.0.1"],
  user,
  online: true,
  approvedRoutes: [],
  availableRoutes: [],
  subnetRoutes: [],
  tags: [],
};

function responseFor(path: string) {
  if (path === "/api/v1/health") return { databaseConnectivity: true };
  if (path === "/version") return { version: "0.29.2" };
  if (path === "/api/v1/user") return { users: [user] };
  if (path === "/api/v1/node") return { nodes: [node] };
  if (path === "/api/v1/preauthkey") return { preAuthKeys: [] };
  if (path === "/api/v1/apikey") return { apiKeys: [] };
  return {};
}

function policyError(message: string) {
  return Response.json({ code: 2, message, details: [] }, { status: 500 });
}

beforeEach(() => {
  policyErrorMessage = "";
  policyRequested = false;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;

      if (path === "/api/v1/policy") {
        policyRequested = true;
        if (policyErrorMessage) return policyError(policyErrorMessage);
        return Response.json({ policy: '{"acls":[]}' });
      }

      return Response.json(responseFor(path));
    },
  });
});

afterEach(() => {
  server.stop(true);
});

function client() {
  return new RestHeadscaleClient({
    mode: "real",
    baseUrl: `http://127.0.0.1:${server.port}`,
    apiKey: "test-token",
  });
}

describe("Headscale policy snapshot", () => {
  test("keeps snapshot loading when Headscale has no ACL policy yet", async () => {
    policyErrorMessage = "loading ACL from database: acl policy not found";

    const snapshot = await fetchSnapshot(client());

    expect(snapshot.policy).toEqual({ policy: "" });
    expect(snapshot.users).toHaveLength(1);
    expect(snapshot.nodes).toHaveLength(1);
    expect(policyRequested).toBe(true);
  });

  test.each([
    "database connectivity failed",
    "policy not found",
  ])("propagates policy errors: %s", async (message) => {
    policyErrorMessage = message;

    await expect(fetchSnapshot(client())).rejects.toThrow(message);
  });
});
