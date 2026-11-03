import { createSessionHost } from "./host";

let host: ReturnType<typeof createSessionHost> | undefined;
self.addEventListener("connect", (event: Event) => {
  host ??= createSessionHost(__HEADSCALE_UI_BUILD_ID__);
  const initializing = host;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- ConnectEvent.ports is a MessagePort array
  const ports: readonly MessagePort[] = Reflect.get(event, "ports");
  for (const port of ports) {
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
