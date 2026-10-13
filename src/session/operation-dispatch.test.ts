import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import type { FaultCode } from "@defjs/core";
import { expect, test, vi } from "vitest";
import { createFixtureHttp } from "@/test/dispatch-fixture";
import type { SessionExecutionContext } from "./auth-session";
import { SessionFault } from "./auth-session";
import { executeOperation } from "./operation-dispatch";

function context(baseUrl: string): SessionExecutionContext {
  return {
    signal: new AbortController().signal,
    requireCurrent: () => ({ baseUrl, apiKey: "fixture-connection-secret" }),
  };
}

test("dispatches contracts with base paths, parsed results and request bodies", async () => {
  const seen: { method: string; path: string; body: unknown; bearer: string | null }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body: unknown = request.method === "GET" ? null : await request.json();
      seen.push({
        method: request.method,
        path: url.pathname + url.search,
        body,
        bearer: request.headers.get("authorization"),
      });
      if (url.pathname.endsWith("/tags"))
        return Response.json({ node: { id: "1", name: "machine" } });
      if (url.pathname.endsWith("/policy")) return Response.json({ policy: "{}" });
      if (url.pathname.endsWith("/apikey")) return Response.json({ apiKey: "new-business-key" });
      return Response.json({ users: [{ id: "1", name: "ops" }] });
    },
  });
  try {
    const current = context(`${server.url.origin}/headscale`);
    expect(
      await executeOperation(
        { type: "api.read", endpoint: "listUsers", input: { name: "ops team" } },
        current,
      ),
    ).toEqual({
      ok: true,
      value: { users: [{ id: "1", name: "ops" }] },
    });
    expect(
      await executeOperation(
        { type: "api.write", endpoint: "setTags", input: { nodeId: "1", tags: ["tag:ops"] } },
        current,
      ),
    ).toMatchObject({ ok: true, value: { node: { id: "1" } } });
    expect(
      await executeOperation(
        { type: "api.write", endpoint: "setPolicy", input: { policy: "{}" } },
        current,
      ),
    ).toEqual({
      ok: true,
      value: { policy: "{}" },
    });
    expect(
      await executeOperation(
        {
          type: "api.write",
          endpoint: "createApiKey",
          input: { expiration: "2027-01-01T00:00:00Z" },
        },
        current,
      ),
    ).toEqual({
      ok: true,
      value: { apiKey: "new-business-key" },
    });
    expect(seen).toEqual([
      {
        method: "GET",
        path: "/headscale/api/v1/user?name=ops+team",
        body: null,
        bearer: "Bearer fixture-connection-secret",
      },
      {
        method: "POST",
        path: "/headscale/api/v1/node/1/tags",
        body: { tags: ["tag:ops"] },
        bearer: "Bearer fixture-connection-secret",
      },
      {
        method: "PUT",
        path: "/headscale/api/v1/policy",
        body: { policy: "{}" },
        bearer: "Bearer fixture-connection-secret",
      },
      {
        method: "POST",
        path: "/headscale/api/v1/apikey",
        body: { expiration: "2027-01-01T00:00:00Z" },
        bearer: "Bearer fixture-connection-secret",
      },
    ]);
  } finally {
    server.stop(true);
  }
});

test("preserves HTTP fault semantics without serializing request metadata", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ code: 13, message: "acl policy not found" }, { status: 500 }),
  });
  try {
    const result = await executeOperation(
      { type: "api.read", endpoint: "listUsers", input: {} },
      context(server.url.origin),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "api",
        code: "HTTP_STATUS",
        status: 500,
        data: { code: 13, message: "acl policy not found" },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/fixture-connection-secret|headers|request|cause/);
  } finally {
    server.stop(true);
  }
});

test("rejects unknown operations, invalid input and expired sessions without a network request", async () => {
  let count = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      count++;
      return Response.json({});
    },
  });
  try {
    expect(
      await executeOperation(
        { type: "api.write", endpoint: "toString" } as never,
        context(server.url.origin),
      ),
    ).toEqual({ ok: false, error: { kind: "invalid-request" } });
    expect(
      await executeOperation(
        { type: "api.write", endpoint: "setTags", input: { nodeId: "1", tags: 9 } } as never,
        context(server.url.origin),
      ),
    ).toMatchObject({ ok: false, error: { kind: "api", code: "REQ_INPUT_INVALID" } });
    expect(
      await executeOperation(
        { type: "api.read", endpoint: "listUsers", input: {} },
        {
          signal: new AbortController().signal,
          requireCurrent() {
            throw new SessionFault("expired");
          },
        },
      ),
    ).toEqual({ ok: false, error: { kind: "expired" } });
    expect(count).toBe(0);
  } finally {
    server.stop(true);
  }
});

test("an error cannot echo the connection key or serialize raw request metadata", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json(
        {
          code: 13,
          message: "Rejected fixture-connection-secret",
          details: [{ "@type": "detail", reason: "invalid", token: "private" }],
          request: { headers: { Authorization: "Bearer fixture-connection-secret" } },
        },
        { status: 403 },
      ),
  });
  try {
    const result = await executeOperation(
      { type: "api.read", endpoint: "listUsers", input: {} },
      context(server.url.origin),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "api",
        code: "HTTP_STATUS",
        status: 403,
        data: {
          code: 13,
          message: "Rejected [redacted]",
          details: [{ "@type": "detail", reason: "invalid", token: "[redacted]" }],
          request: "[redacted]",
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("fixture-connection-secret");
    expect(JSON.stringify(result)).not.toContain('"headers"');
  } finally {
    server.stop(true);
  }
});

// This layer reports a bare stale for a late reply; auth-session upgrades it to
// outcome "unknown" (see the composed test in auth-session.test.ts).
test.each([200, 503])(
  "rejects a late decoded %s reply after the request was already received by the server",
  async (status) => {
    const received = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let acceptedWrites = 0;
    let invalidated = false;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        await request.json();
        acceptedWrites++;
        received.resolve();
        return new Response(
          new ReadableStream({
            async start(controller) {
              await release.promise;
              controller.enqueue(
                new TextEncoder().encode(
                  JSON.stringify(
                    status === 200 ? { policy: "{}" } : { code: 13, message: "failed write" },
                  ),
                ),
              );
              controller.close();
            },
          }),
          { status, headers: { "content-type": "application/json" } },
        );
      },
    });
    try {
      const pending = executeOperation(
        { type: "api.write", endpoint: "setPolicy", input: { policy: "{}" } },
        {
          signal: new AbortController().signal,
          requireCurrent() {
            if (invalidated) throw new SessionFault("stale");
            return { baseUrl: server.url.origin, apiKey: "fixture-connection-secret" };
          },
        },
      );
      await received.promise;
      invalidated = true;
      release.resolve();
      expect(await pending).toEqual({ ok: false, error: { kind: "stale" } });
      expect(acceptedWrites).toBe(1);
    } finally {
      release.resolve();
      server.stop(true);
    }
  },
);

test("dispatches the auth request and policy check writes through the injected transport", async () => {
  const seen: { method: string; path: string; body: unknown }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      seen.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: await request.json(),
      });
      return Response.json({});
    },
  });
  try {
    const current = context(server.url.origin);
    const authId = "hskey-authreq-abcdefghijklmnopqrstuvwx";
    expect(
      await executeOperation(
        { type: "api.write", endpoint: "authApprove", input: { authId } },
        current,
      ),
    ).toEqual({
      ok: true,
      value: undefined,
    });
    expect(
      await executeOperation(
        { type: "api.write", endpoint: "checkPolicy", input: { policy: "{}" } },
        current,
      ),
    ).toEqual({
      ok: true,
      value: undefined,
    });
    expect(seen).toEqual([
      { method: "POST", path: "/api/v1/auth/approve", body: { authId } },
      { method: "POST", path: "/api/v1/policy/check", body: { policy: "{}" } },
    ]);
  } finally {
    server.stop(true);
  }
});

test("an unknown auth request fails with the server message and without the connection key", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json(
        { code: 5, message: "no pending auth session for fixture-connection-secret" },
        { status: 404 },
      ),
  });
  try {
    const result = await executeOperation(
      {
        type: "api.write",
        endpoint: "authApprove",
        input: { authId: "hskey-authreq-abcdefghijklmnopqrstuvwx" },
      },
      context(server.url.origin),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "api",
        code: "HTTP_STATUS",
        status: 404,
        data: { code: 5, message: "no pending auth session for [redacted]" },
      },
    });
    expect(JSON.stringify(result)).not.toContain("fixture-connection-secret");
  } finally {
    server.stop(true);
  }
});

test("an injected client faults keep redaction, the unavailable fallback and session fault kinds", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json({ code: 13, message: "failed for fixture-connection-secret" }, { status: 500 }),
  });
  try {
    // The context points nowhere: only the injected client may serve the request.
    const current = context("http://127.0.0.1:1");
    const http = createFixtureHttp({
      baseUrl: server.url.origin,
      apiKey: "fixture-connection-secret",
    });
    const result = await executeOperation(
      { type: "api.read", endpoint: "listUsers", input: {} },
      current,
      http,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "api", code: "HTTP_STATUS", status: 500 },
    });
    expect(JSON.stringify(result)).not.toContain("fixture-connection-secret");

    const execute = vi.spyOn(http, "execute").mockRejectedValueOnce(new Error("boom"));
    expect(
      await executeOperation({ type: "api.read", endpoint: "listUsers", input: {} }, current, http),
    ).toEqual({
      ok: false,
      error: { kind: "unavailable" },
    });
    execute.mockRejectedValueOnce(new SessionFault("expired"));
    expect(
      await executeOperation({ type: "api.read", endpoint: "listUsers", input: {} }, current, http),
    ).toEqual({
      ok: false,
      error: { kind: "expired" },
    });
    execute.mockClear();
    expect(
      await executeOperation({ type: "api.write", endpoint: "toString" } as never, current, http),
    ).toEqual({
      ok: false,
      error: { kind: "invalid-request" },
    });
    expect(execute).not.toHaveBeenCalled();
  } finally {
    server.stop(true);
  }
});

const writes = [
  [
    "createUser",
    () => ({ type: "api.write", endpoint: "createUser", input: { name: "ops" } }) as const,
  ],
  [
    "createPreAuthKey",
    () =>
      ({
        type: "api.write",
        endpoint: "createPreAuthKey",
        input: { user: "1", expiration: "2027-01-01T00:00:00Z" },
      }) as const,
  ],
  [
    "setPolicy",
    () => ({ type: "api.write", endpoint: "setPolicy", input: { policy: "{}" } }) as const,
  ],
  [
    "backfillNodeIps",
    () => ({ type: "api.write", endpoint: "backfillNodeIps", input: { confirmed: true } }) as const,
  ],
  [
    "deleteUser",
    () => ({ type: "api.write", endpoint: "deleteUser", input: { id: "1" } }) as const,
  ],
] as const;
// The page declares the kind; the dispatcher marks only declared writes.
const reads = [
  ["listUsers", () => ({ type: "api.read", endpoint: "listUsers", input: {} }) as const],
  ["getPolicy", () => ({ type: "api.read", endpoint: "getPolicy" }) as const],
] as const;
const wrongShape = { user: "x", preAuthKey: "x", policy: 1, changes: "x", users: "x" };

interface Upstream {
  server: { url: { origin: string }; stop(force?: boolean): unknown };
  seen: { requests: number };
}

/** Serves one scripted reply and counts the requests it received. */
async function scripted(respond: (received: () => void) => Response | Promise<Response>) {
  const seen = { requests: 0, received: Promise.withResolvers<void>() };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      await request.text();
      seen.requests++;
      return respond(() => seen.received.resolve());
    },
  });
  return { server, seen };
}

/** Promises 100 body bytes, sends 8 and resets the connection (Bun.serve repairs content-length). */
async function truncated() {
  const seen = { requests: 0, received: Promise.withResolvers<void>() };
  const server = createServer((socket) => {
    socket.once("data", () => {
      seen.requests++;
      socket.write(
        'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{"user":',
      );
      setTimeout(() => socket.destroy(), 10);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server: { url: { origin: `http://127.0.0.1:${port}` }, stop: () => server.close() },
    seen,
  };
}

test.each(writes)("%s: a write that may have been applied is marked unknown", async (_id, make) => {
  const uncertain: [string, FaultCode, () => Promise<Upstream>][] = [
    ["truncated body", "NET_BODY_INCOMPLETE", truncated],
    ["200 wrong shape", "RES_STRUCT_MISMATCH", () => scripted(() => Response.json(wrongShape))],
  ];
  for (const [name, code, respond] of uncertain) {
    // deleteUser has no output contract, so its success body is never read.
    if (make().endpoint === "deleteUser") continue;
    const { server, seen } = await respond();
    try {
      const result = await executeOperation(make(), context(server.url.origin));
      expect(result, name).toMatchObject({
        ok: false,
        error: { kind: "api", code, outcome: "unknown" },
      });
      expect(seen.requests, name).toBe(1);
    } finally {
      server.stop(true);
    }
  }
});

test.each([
  [
    "502 html",
    () =>
      new Response("<html>bad gateway</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    "RES_MEDIA_TYPE_INVALID",
  ],
  [
    "503 json",
    () => Response.json({ code: 14, message: "unavailable" }, { status: 503 }),
    "HTTP_STATUS",
  ],
  [
    "504 plain text",
    () =>
      new Response("upstream timed out", {
        status: 504,
        headers: { "content-type": "text/plain" },
      }),
    "RES_MEDIA_TYPE_INVALID",
  ],
])("a write answered by a gateway with %s may have been applied", async (name, respond, code) => {
  for (const [id, make] of writes) {
    const { server, seen } = await scripted(respond);
    try {
      expect(
        await executeOperation(make(), context(server.url.origin)),
        `${id} ${name}`,
      ).toMatchObject({ ok: false, error: { kind: "api", code, outcome: "unknown" } });
      expect(seen.requests, `${id} ${name}`).toBe(1);
    } finally {
      server.stop(true);
    }
  }
  for (const [id, make] of reads) {
    const { server } = await scripted(respond);
    try {
      expect(
        await executeOperation(make(), context(server.url.origin)),
        `${id} ${name}`,
      ).not.toHaveProperty("error.outcome");
    } finally {
      server.stop(true);
    }
  }
});

test.each(writes)("%s: an unreachable server is marked unknown", async (_id, make) => {
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const origin = closed.url.origin;
  closed.stop(true);
  expect(await executeOperation(make(), context(origin))).toMatchObject({
    ok: false,
    error: { kind: "api", code: "NET_UNREACHABLE", outcome: "unknown" },
  });
});

test.each(writes)(
  "%s: an abort after the server received the write is marked unknown",
  async (_id, make) => {
    const { server, seen } = await scripted((received) => {
      received();
      return new Promise<Response>(() => {});
    });
    try {
      const controller = new AbortController();
      const pending = executeOperation(make(), {
        signal: controller.signal,
        requireCurrent: () => ({ baseUrl: server.url.origin, apiKey: "fixture-connection-secret" }),
      });
      await seen.received.promise;
      controller.abort();
      expect(await pending).toMatchObject({
        ok: false,
        error: { kind: "api", code: "NET_ABORTED", outcome: "unknown" },
      });
      expect(seen.requests).toBe(1);
    } finally {
      server.stop(true);
    }
  },
);

test.each(writes)("%s: a timed out request is marked unknown", async (_id, make) => {
  const timeout = vi.fn(async () => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  });
  vi.stubGlobal("fetch", timeout);
  try {
    expect(await executeOperation(make(), context("http://127.0.0.1:1"))).toMatchObject({
      ok: false,
      error: { kind: "api", code: "NET_TIMEOUT", outcome: "unknown" },
    });
    expect(timeout).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});

test.each(reads)("%s: the same faults on a read never carry an outcome", async (_id, make) => {
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const origin = closed.url.origin;
  closed.stop(true);
  const outcomes = [await executeOperation(make(), context(origin))];
  for (const start of [truncated, () => scripted(() => Response.json(wrongShape))]) {
    const { server } = await start();
    try {
      outcomes.push(await executeOperation(make(), context(server.url.origin)));
    } finally {
      server.stop(true);
    }
  }
  vi.stubGlobal("fetch", async () => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  });
  try {
    outcomes.push(await executeOperation(make(), context(origin)));
  } finally {
    vi.unstubAllGlobals();
  }
  for (const result of outcomes)
    expect(result.ok ? result : result.error).not.toHaveProperty("outcome");
  expect(outcomes.filter((result) => !result.ok)).toHaveLength(4);
});

test.each([
  [
    "400 json",
    () => Response.json({ code: 3, message: "invalid" }, { status: 400 }),
    "HTTP_STATUS",
  ],
  [
    "500 json",
    () => Response.json({ code: 13, message: "failed" }, { status: 500 }),
    "HTTP_STATUS",
  ],
  [
    "404 json",
    () => Response.json({ code: 5, message: "not found" }, { status: 404 }),
    "HTTP_STATUS",
  ],
  [
    "401 plain text",
    () => new Response("Unauthorized", { status: 401, headers: { "content-type": "text/plain" } }),
    "RES_MEDIA_TYPE_INVALID",
  ],
  [
    "403 html",
    () =>
      new Response("<html>denied</html>", {
        status: 403,
        headers: { "content-type": "text/html" },
      }),
    "RES_MEDIA_TYPE_INVALID",
  ],
])("a write answered with %s is a definite failure", async (name, respond, code) => {
  for (const [id, make] of writes) {
    const { server, seen } = await scripted(respond);
    try {
      const result = await executeOperation(make(), context(server.url.origin));
      expect(result, `${id} ${name}`).toMatchObject({ ok: false, error: { kind: "api", code } });
      expect(result, `${id} ${name}`).not.toHaveProperty("error.outcome");
      expect(seen.requests, `${id} ${name}`).toBe(1);
    } finally {
      server.stop(true);
    }
  }
});
