import { afterEach, expect, test } from "vitest";
import { OPERATION_IDS } from "../../src/domain/headscale-operations";
import { createSessionNetwork } from "./session-network";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function directFetch(url: string | URL, init?: RequestInit) {
  return fetch(url, { ...init, proxy: false });
}

function upstream(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
  cleanup.push(() => server.stop(true));
  return server;
}
function fixture(url: string) {
  const network = createSessionNetwork({ upstream: url });
  cleanup.push(() => network.close());
  return network;
}

test("forwards the original method, base path, query and body to the upstream once", async () => {
  const received: unknown[] = [];
  const backend = upstream(async (request) => {
    received.push({
      method: request.method,
      path: new URL(request.url).pathname,
      query: new URL(request.url).search,
      authorization: request.headers.get("authorization"),
      body: await request.json(),
    });
    return Response.json(
      { policy: "accepted" },
      { status: 202, headers: { "x-upstream": "upstream" } },
    );
  });
  const network = fixture(`${backend.url.origin}/headscale`);
  const response = await directFetch(`${network.url}/api/v1/policy?client=one`, {
    method: "PUT",
    headers: { authorization: "Bearer fixture-placeholder", "content-type": "application/json" },
    body: JSON.stringify({ policy: "draft" }),
  });
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ policy: "accepted" });
  expect(response.headers.get("x-upstream")).toBe("upstream");
  expect(received).toEqual([
    {
      method: "PUT",
      path: "/headscale/api/v1/policy",
      query: "?client=one",
      authorization: "Bearer fixture-placeholder",
      body: { policy: "draft" },
    },
  ]);
});

test("a one-shot 503 gate matches method and path without sending the failed request upstream", async () => {
  const received: string[] = [];
  const backend = upstream((request) => {
    received.push(`${request.method} ${new URL(request.url).pathname}`);
    return Response.json({ users: [] });
  });
  const network = fixture(backend.url.origin);
  const gate = network.intercept({
    method: "GET",
    pathPattern: "^/api/v1/user$",
    failure: "fixture unavailable",
  });
  expect((await directFetch(`${network.url}/api/v1/node`)).status).toBe(200);
  expect((await directFetch(`${network.url}/api/v1/user`, { method: "POST" })).status).toBe(200);
  expect(gate.getSnapshot().hits).toBe(0);
  const response = await directFetch(`${network.url}/api/v1/user`);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ code: 14, message: "fixture unavailable" });
  expect((await directFetch(`${network.url}/api/v1/user`)).status).toBe(200);
  expect(received).toEqual(["GET /api/v1/node", "POST /api/v1/user", "GET /api/v1/user"]);
  expect(gate.getSnapshot()).toMatchObject({
    hits: 1,
    upstreamRequests: 0,
    captured: true,
    finished: true,
  });
  await gate.release();
  expect(gate.getSnapshot().released).toBe(true);
});

test("holds a captured response while the next request returns newer upstream data", async () => {
  let value = "old";
  let calls = 0;
  const backend = upstream(() => {
    calls++;
    return Response.json({ value });
  });
  const network = fixture(backend.url.origin);
  const gate = network.intercept({ method: "GET", pathPattern: "^/api/v1/user$" });
  let firstDelivered = false;
  const first = directFetch(`${network.url}/api/v1/user`)
    .then((response) => response.json())
    .then((body) => {
      firstDelivered = true;
      return body;
    });
  try {
    await expect.poll(() => gate.getSnapshot().captured).toBe(true);
    value = "new";
    const second = await directFetch(`${network.url}/api/v1/user`);
    expect(await second.json()).toEqual({ value: "new" });
    expect(calls).toBe(2);
    expect(firstDelivered).toBe(false);
    expect(gate.getSnapshot()).toMatchObject({ hits: 1, upstreamRequests: 1, finished: false });
    await gate.release();
    expect(await first).toEqual({ value: "old" });
    expect(gate.getSnapshot()).toMatchObject({ captured: true, released: true, finished: true });
  } finally {
    await gate.release();
    await first;
  }
});

test("a dropped response commits upstream once, breaks the body after the headers and leaves the next request ungated", async () => {
  let calls = 0;
  const backend = upstream(() => {
    calls++;
    return Response.json({ apiKey: "created" });
  });
  const network = fixture(backend.url.origin);
  const gate = network.intercept({
    method: "POST",
    pathPattern: "^/api/v1/apikey$",
    failure: { drop: true },
  });
  const pending = directFetch(`${network.url}/api/v1/apikey`, { method: "POST" }).then(
    async (response) => ({
      status: response.status,
      body: await response.text().catch((error: unknown) => error),
    }),
    (error: unknown) => error,
  );
  try {
    await expect.poll(() => gate.getSnapshot().captured).toBe(true);
    expect(calls).toBe(1);
    await gate.release();
    // Chromium silently resends a request whose reused connection resets before any response
    // byte, so the drop must happen after the headers: the client sees 200 and a broken body.
    const outcome = await pending;
    expect(outcome).not.toBeInstanceOf(Error);
    const result = outcome as { status: number; body: unknown };
    expect(result.status).toBe(200);
    expect(result.body).toBeInstanceOf(Error);
    expect(gate.getSnapshot()).toMatchObject({ hits: 1, upstreamRequests: 1 });
    const next = await directFetch(`${network.url}/api/v1/apikey`, { method: "POST" });
    expect(await next.json()).toEqual({ apiKey: "created" });
    expect(calls).toBe(2);
  } finally {
    await gate.release();
    await pending;
  }
});

test("identifies all 30 Headscale operations from actual HTTP methods and paths", async () => {
  let upstreamCalls = 0;
  const backend = upstream(() => {
    upstreamCalls++;
    return Response.json({ ok: true });
  });
  const network = fixture(backend.url.origin);
  const cases = [
    ["health.check", "GET", "/api/v1/health"],
    ["version.get", "GET", "/version"],
    ["user.list", "GET", "/api/v1/user"],
    ["user.create", "POST", "/api/v1/user"],
    ["user.rename", "POST", "/api/v1/user/1/rename/alice-main"],
    ["user.delete", "DELETE", "/api/v1/user/1"],
    ["preauthkey.list", "GET", "/api/v1/preauthkey"],
    ["preauthkey.create", "POST", "/api/v1/preauthkey"],
    ["preauthkey.expire", "POST", "/api/v1/preauthkey/expire"],
    ["preauthkey.delete", "DELETE", "/api/v1/preauthkey"],
    ["node.list", "GET", "/api/v1/node"],
    ["node.get", "GET", "/api/v1/node/2"],
    ["node.register", "POST", "/api/v1/node/register"],
    ["node.debugCreate", "POST", "/api/v1/debug/node"],
    ["node.rename", "POST", "/api/v1/node/2/rename/router"],
    ["node.expire", "POST", "/api/v1/node/2/expire"],
    ["node.delete", "DELETE", "/api/v1/node/2"],
    ["node.setTags", "POST", "/api/v1/node/2/tags"],
    ["node.setApprovedRoutes", "POST", "/api/v1/node/2/approve_routes"],
    ["node.backfillIps", "POST", "/api/v1/node/backfillips"],
    ["auth.register", "POST", "/api/v1/auth/register"],
    ["auth.approve", "POST", "/api/v1/auth/approve"],
    ["auth.reject", "POST", "/api/v1/auth/reject"],
    ["apikey.list", "GET", "/api/v1/apikey"],
    ["apikey.create", "POST", "/api/v1/apikey"],
    ["apikey.expire", "POST", "/api/v1/apikey/expire"],
    ["apikey.delete", "DELETE", "/api/v1/apikey/public-prefix"],
    ["policy.get", "GET", "/api/v1/policy"],
    ["policy.set", "PUT", "/api/v1/policy"],
    ["policy.check", "POST", "/api/v1/policy/check"],
  ] as const;
  // The observation table must never lag the operation registry.
  expect(cases.map(([id]) => id)).toEqual([...OPERATION_IDS]);
  for (const [, method, path] of cases)
    expect((await directFetch(`${network.url}${path}`, { method })).status).toBe(200);
  expect((await directFetch(`${network.url}/api/v1/unknown`)).status).toBe(200);
  expect((await directFetch(`${network.url}/api/v1/policy`, { method: "DELETE" })).status).toBe(
    200,
  );
  expect(network.getOperationCalls()).toEqual(
    cases.map(([id, method, url]) => ({
      id,
      method,
      url,
      ...(id === "node.backfillIps" ? { payload: { confirmed: false } } : {}),
    })),
  );
  expect(upstreamCalls).toBe(32);
});
