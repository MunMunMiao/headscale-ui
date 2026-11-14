import { serveFixture } from "@/test/fixture-server";
import { defineRequest, struct } from "@defjs/core";
import { expect, test, vi } from "vitest";
import { createWorkerHeadscaleHttp } from "./http";

test("Worker authentication replaces a builder header with the bound session credential", async () => {
  const seen: Headers[] = [];
  const server = serveFixture({
    fetch(request) {
      seen.push(request.headers);
      return Response.json({});
    },
  });
  try {
    const client = createWorkerHeadscaleHttp(server.url.origin, () => ({
      baseUrl: server.url.origin,
      apiKey: "fixture-private-key",
    }));
    const request = defineRequest({
      meta: { operation: "user.list" },
      method: "GET",
      path: "/api/v1/user",
      builder: () => ({
        headers: { Authorization: "Bearer untrusted-builder-key" },
      }),
    });
    expect((await request(client))[0]).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.get("authorization")).toBe("Bearer fixture-private-key");
    expect(
      [...(seen[0]?.keys() ?? [])].some((name) => /session|worker/i.test(name)),
    ).toBe(false);
  } finally {
    void server.stop(true);
  }
});

test("an abort during the interceptor chain prevents the native fetch", async () => {
  let sent = 0;
  const server = serveFixture({
    fetch() {
      sent++;
      return new Response(null, { status: 204 });
    },
  });
  const controller = new AbortController();
  let nativeCalls = 0;
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    nativeCalls++;
    return nativeFetch(input, init);
  });
  try {
    const client = createWorkerHeadscaleHttp(server.url.origin, () => {
      // The session invalidates after the interceptor reads the credential; production aborts
      // the same signal from invalidate().
      queueMicrotask(() => controller.abort());
      return { baseUrl: server.url.origin, apiKey: "fixture-private-key" };
    });
    const request = defineRequest({
      meta: { operation: "policy.set" },
      method: "PUT",
      path: "/api/v1/policy",
      input: struct.string(),
      builder: (body) => ({ body }),
    });
    expect(
      (await request(client({ signal: controller.signal }), "payload"))[0],
    ).not.toBeNull();
    expect(nativeCalls).toBe(0);
    expect(sent).toBe(0);
  } finally {
    vi.unstubAllGlobals();
    void server.stop(true);
  }
});
