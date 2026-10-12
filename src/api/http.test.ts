import { defineRequest, struct } from "@defjs/core";
import { expect, test, vi } from "vitest";
import { SessionFault } from "@/session/auth-session";
import { createWorkerHeadscaleHttp } from "./http";

test("Worker authentication replaces a builder header with the bound session credential", async () => {
  const seen: Headers[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      seen.push(request.headers);
      return Response.json({});
    },
  });
  try {
    const client = createWorkerHeadscaleHttp({
      signal: new AbortController().signal,
      requireCurrent: () => ({ baseUrl: server.url.origin, apiKey: "fixture-private-key" }),
    });
    const request = defineRequest({
      operation: "user.list",
      method: "GET",
      path: "/api/v1/user",
      builder: () => ({ headers: { Authorization: "Bearer untrusted-builder-key" } }),
    });
    expect((await client.execute(request()))[0]).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.get("authorization")).toBe("Bearer fixture-private-key");
    expect([...(seen[0]?.keys() ?? [])].some((name) => /session|worker/i.test(name))).toBe(false);
  } finally {
    server.stop(true);
  }
});

test.each(["expired", "stale"] as const)(
  "checks %s after the interceptor microtask and before native fetch",
  async (kind) => {
    let sent = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        sent++;
        return new Response(null, { status: 204 });
      },
    });
    let invalidated = false;
    let checks = 0;
    let nativeCalls = 0;
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      nativeCalls++;
      return nativeFetch(input, init);
    });
    try {
      const client = createWorkerHeadscaleHttp({
        signal: new AbortController().signal,
        requireCurrent() {
          if (invalidated) throw new SessionFault(kind);
          checks++;
          if (checks === 2)
            queueMicrotask(() => {
              invalidated = true;
            });
          return { baseUrl: server.url.origin, apiKey: "fixture-private-key" };
        },
      });
      const request = defineRequest({
        operation: "policy.set",
        method: "PUT",
        path: "/api/v1/policy",
        input: struct.string(),
        builder: (body) => ({ body }),
      });
      expect((await client.execute(request("payload")))[0]).not.toBeNull();
      expect(nativeCalls).toBe(0);
      expect(sent).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      server.stop(true);
    }
  },
);
