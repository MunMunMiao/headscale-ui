import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createFixtureHttp, fixtureExecute } from "@/test/dispatch-fixture";
import { fetchSnapshot, readPolicy } from "./snapshot";

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

let policyErrorStatus = 500;
function policyError(message: string) {
  return Response.json({ code: 2, message, details: [] }, { status: policyErrorStatus });
}

beforeEach(() => {
  policyErrorMessage = "";
  policyErrorStatus = 500;
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
  return fixtureExecute(
    createFixtureHttp({
      baseUrl: `http://127.0.0.1:${server.port}`,
      apiKey: "test-token",
    }),
  );
}

describe("Headscale policy snapshot", () => {
  test("reads a configured policy and preserves its nullable timestamp and extensions", async () => {
    server.reload({
      fetch: () => Response.json({ policy: '{"acls":[]}', updatedAt: null, revision: "1" }),
    });
    expect(await readPolicy(client())).toEqual({
      policy: '{"acls":[]}',
      updatedAt: null,
      revision: "1",
    });
  });

  test("keeps snapshot loading when Headscale has no ACL policy yet", async () => {
    policyErrorMessage = "loading ACL from database: acl policy not found";

    const snapshot = await fetchSnapshot(client());

    expect(snapshot.policy).toEqual({ policy: "" });
    expect(snapshot.users).toHaveLength(1);
    expect(snapshot.nodes).toHaveLength(1);
    expect(policyRequested).toBe(true);
  });

  test("reports file mode without a policy path instead of failing the snapshot", async () => {
    policyErrorMessage = 'reading policy from path "": open : no such file or directory';

    const snapshot = await fetchSnapshot(client());

    expect(snapshot.policy).toEqual({ policy: "", fileModeWithoutPath: true });
    expect(snapshot.users).toHaveLength(1);
    expect(snapshot.nodes).toHaveLength(1);
  });

  test.each([
    [
      500,
      'reading policy from path "/etc/headscale/acl.hujson": open /etc/headscale/acl.hujson: no such file or directory',
    ],
    [500, "reading policy from file: unexpected EOF"],
    [403, 'reading policy from path "": open : no such file or directory'],
    [503, 'reading policy from path "": open : no such file or directory'],
  ])("keeps failing for status %i: %s", async (status, message) => {
    policyErrorStatus = status;
    policyErrorMessage = message;

    await expect(fetchSnapshot(client())).rejects.toMatchObject({
      code: "HTTP_STATUS",
      status,
      data: { message },
    });
  });

  test.each(["database connectivity failed", "policy not found"])(
    "propagates policy errors: %s",
    async (message) => {
      policyErrorMessage = message;

      await expect(fetchSnapshot(client())).rejects.toMatchObject({
        code: "HTTP_STATUS",
        status: 500,
        data: { message },
      });
    },
  );

  test("does not turn a denied policy request into an unconfigured policy", async () => {
    server.reload({
      fetch: () => Response.json({ code: 7, message: "acl policy not found" }, { status: 403 }),
    });
    await expect(readPolicy(client())).rejects.toMatchObject({
      code: "HTTP_STATUS",
      status: 403,
      data: { code: 7, message: "acl policy not found" },
    });
  });
});
