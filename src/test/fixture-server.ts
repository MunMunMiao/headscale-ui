type Handler = (request: Request) => Response | Promise<Response>;

const served = new Map<string, Handler>();
let nextPort = 43_000;
const native = globalThis.fetch;
const network = native.bind(globalThis);

// A streamed request body must declare its duplex mode.
function streamable(init?: RequestInit): RequestInit & { duplex: "half" } {
  return { ...init, duplex: "half" };
}

function abortion(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

// A page cannot listen on a socket, so a served origin answers inside fetch and any other origin
// keeps the browser's own network path. Assigned directly so vi.unstubAllGlobals() cannot remove it.
const fetchDouble = (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, streamable(init));
  const handler = served.get(new URL(request.url).origin);
  if (!handler) return network(request);
  return Promise.race([
    Promise.resolve().then(() => handler(request)),
    abortion(request.signal),
  ]);
};
fetchDouble.preconnect = native.preconnect;
globalThis.fetch = fetchDouble;

/** Serves a test double at a loopback origin. A stopped origin is refused by the browser like a closed port. */
export function serveFixture(options: { fetch: Handler }) {
  const url = new URL(`http://127.0.0.1:${nextPort++}/`);
  served.set(url.origin, options.fetch);
  return {
    url,
    port: Number(url.port),
    reload(next: { fetch: Handler }) {
      served.set(url.origin, next.fetch);
    },
    stop(_force?: boolean) {
      served.delete(url.origin);
      return Promise.resolve();
    },
  };
}
