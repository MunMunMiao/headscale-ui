import {
  type NetworkOperationCall,
  networkOperation,
  readOperationPayload,
} from "../../e2e/network-observations";

export interface NetworkGateOptions {
  method: string;
  pathPattern: string;
  /**
   * A string answers 503 without reaching upstream. The objects act after the real upstream
   * response is captured: replace its body (optionally its status), or break the client read.
   */
  failure?:
    | string
    | { responseBody: unknown; status?: number }
    | { rawBody: string; status?: number }
    | { drop: true };
}

export interface NetworkObservation {
  requestId: number;
  gateId: number | null;
  timestamp: number;
  method: string;
  path: string;
  upstreamRequests: number;
  status?: number;
  mimeType?: string;
  aborted: boolean;
  errorText?: string;
}

export interface NetworkGateState {
  id: number;
  hits: number;
  upstreamRequests: number;
  captured: boolean;
  released: boolean;
  finished: boolean;
}

function responseHeaders(original?: HeadersInit) {
  const headers = new Headers(original);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET,POST,PUT,DELETE,HEAD,OPTIONS");
  headers.set("access-control-allow-headers", "Authorization,Content-Type");
  headers.set("cache-control", "no-store");
  return headers;
}

export function createSessionNetwork(options: { upstream: string }) {
  const upstream = new URL(options.upstream);
  type Gate = {
    options: NetworkGateOptions;
    pattern: RegExp;
    state: NetworkGateState;
    done: ReturnType<typeof Promise.withResolvers<void>>;
    release: ReturnType<typeof Promise.withResolvers<void>>;
  };
  const gates = new Set<Gate>();
  const requests = new Set<Promise<void>>();
  let observations: NetworkObservation[] = [];
  const operationCalls: NetworkOperationCall[] = [];
  let requestSequence = 0;
  let gateSequence = 0;
  let closed = false;
  let lifetime = new AbortController();
  function finish(gate: Gate) {
    gate.state.finished = true;
    gate.done.resolve();
  }
  async function clearRequests() {
    lifetime.abort();
    const pending = [...gates];
    gates.clear();
    for (const gate of pending) {
      gate.state.released = true;
      gate.release.resolve();
      if (!gate.state.hits) finish(gate);
    }
    await Promise.all([...requests]);
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers: responseHeaders() });
      const done = Promise.withResolvers<void>();
      requests.add(done.promise);
      const incoming = new URL(request.url);
      const operation = networkOperation(request.method, incoming.pathname);
      if (operation) operationCalls.push(operation);
      const gate = [...gates].find(
        (item) =>
          item.state.hits === 0 &&
          item.options.method === request.method &&
          item.pattern.test(incoming.pathname),
      );
      const observed: NetworkObservation = {
        requestId: ++requestSequence,
        gateId: gate?.state.id ?? null,
        timestamp: Date.now(),
        method: request.method,
        path: incoming.pathname,
        upstreamRequests: 0,
        aborted: false,
      };
      observations.push(observed);
      const signal = AbortSignal.any([request.signal, lifetime.signal]);
      const onAbort = () => {
        observed.aborted = true;
        gate?.release.resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        signal.throwIfAborted();
        if (gate) gate.state.hits++;
        if (operation) {
          const payload = await readOperationPayload(request, operation.id);
          if (payload) operation.payload = payload;
        }
        if (gate) {
          if (typeof gate.options.failure === "string") {
            gate.state.captured = true;
            observed.status = 503;
            observed.mimeType = "application/json";
            return Response.json(
              { code: 14, message: gate.options.failure },
              { status: 503, headers: responseHeaders() },
            );
          }
          gate.state.upstreamRequests++;
        }
        const target = new URL(upstream);
        target.pathname = upstream.pathname.replace(/\/$/, "") + incoming.pathname;
        target.search = incoming.search;
        const forwardHeaders = new Headers(request.headers);
        forwardHeaders.delete("host");
        observed.upstreamRequests++;
        const response = await fetch(target, {
          proxy: false,
          method: request.method,
          headers: forwardHeaders,
          body: request.body,
          signal,
          redirect: "manual",
        });
        observed.status = response.status;
        observed.mimeType = response.headers.get("content-type") ?? undefined;
        let body: BodyInit = await response.arrayBuffer();
        let status = response.status;
        const headers = responseHeaders(response.headers);
        if (gate) {
          gate.state.captured = true;
          await gate.release.promise;
          signal.throwIfAborted();
          const failure = gate.options.failure;
          if (typeof failure === "object" && "drop" in failure) {
            // The upstream write committed; the client read breaks inside the body. Breaking before
            // the first byte would let Chromium silently resend the request on a reused connection.
            observed.errorText = "RESPONSE_DROPPED";
            const partial = new Uint8Array(body as ArrayBuffer).subarray(0, 1);
            return new Response(
              new ReadableStream({
                async start(controller) {
                  controller.enqueue(partial);
                  await Bun.sleep(50);
                  controller.error(new Error("fixture dropped the response"));
                },
              }),
              { status, headers },
            );
          }
          if (typeof failure === "object") {
            body =
              "responseBody" in failure ? JSON.stringify(failure.responseBody) : failure.rawBody;
            status = failure.status ?? status;
            headers.set("content-type", "application/json");
          }
        }
        return new Response(body, { status, headers });
      } catch {
        observed.aborted = signal.aborted;
        observed.errorText = observed.aborted ? "ERR_ABORTED" : "UPSTREAM_FAILED";
        return Response.json(
          { code: 14, message: "Test upstream unavailable" },
          { status: 502, headers: responseHeaders() },
        );
      } finally {
        signal.removeEventListener("abort", onAbort);
        if (gate) finish(gate);
        requests.delete(done.promise);
        done.resolve();
      }
    },
  });
  return {
    url: server.url.origin,
    getOperationCalls: () => structuredClone(operationCalls),
    clearOperationCalls() {
      operationCalls.length = 0;
    },
    getObservations: () => observations.map((entry) => ({ ...entry })),
    clearObservations() {
      observations = [];
    },
    async reset() {
      await clearRequests();
      observations = [];
      operationCalls.length = 0;
      if (!closed) lifetime = new AbortController();
    },
    intercept(options: NetworkGateOptions) {
      if (closed) throw new Error("Session network fixture is closed");
      const gate: Gate = {
        options,
        pattern: new RegExp(options.pathPattern),
        state: {
          id: ++gateSequence,
          hits: 0,
          upstreamRequests: 0,
          captured: false,
          released: false,
          finished: false,
        },
        done: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      gates.add(gate);
      return {
        getSnapshot: () => ({ ...gate.state }),
        async release() {
          gates.delete(gate);
          gate.state.released = true;
          gate.release.resolve();
          if (!gate.state.hits) finish(gate);
          await gate.done.promise;
        },
      };
    },
    async close() {
      closed = true;
      await clearRequests();
      await server.stop(true);
    },
  };
}
