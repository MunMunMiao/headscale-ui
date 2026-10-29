import { createSessionHost } from "./host";

let host: ReturnType<typeof createSessionHost> | undefined;
self.addEventListener("connect", (event: Event) => {
  host ??= createSessionHost(__HEADSCALE_UI_BUILD_ID__);
  const initializing = host;
  for (const port of (event as MessageEvent).ports) {
    void initializing.then(
      (session) => session.connect(port),
      () => {
        if (host === initializing) host = undefined;
        port.postMessage({ type: "error", error: { kind: "unavailable" } });
        port.close();
      },
    );
  }
});
