import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { __resetForTest } from "@/lib/idb";
import { createBrowserSessionBridge } from "./connect";
import { createSessionHost } from "./host";

beforeEach(() => {
  __resetForTest();
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("__HEADSCALE_UI_BUILD_ID__", "browser-build");
});
afterEach(() => vi.unstubAllGlobals());
test("the page opens the stable named module worker and exposes only its bridge", async () => {
  const host = await createSessionHost("browser-build");
  const calls: [URL, WorkerOptions | undefined][] = [];
  const ports: MessagePort[] = [];
  vi.stubGlobal(
    "SharedWorker",
    class {
      readonly port: MessagePort;
      constructor(url: URL, options?: WorkerOptions) {
        calls.push([url, options]);
        const channel = new MessageChannel();
        this.port = channel.port1;
        ports.push(channel.port2);
        host.connect(channel.port2);
      }
    },
  );
  const bridge = createBrowserSessionBridge();
  try {
    expect((await bridge.connect()).ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toEqual({
      type: "module",
      name: "headscale-ui-session",
    });
    expect(calls[0]?.[0].pathname).toMatch(/\/worker\.ts$/);
    expect(bridge.getSessionSnapshot()?.status).toBe("locked");
  } finally {
    bridge.dispose();
    for (const port of ports) port.close();
    await host.dispose();
  }
});
test("unsupported SharedWorker fails closed without creating a page client", async () => {
  vi.stubGlobal("SharedWorker", undefined);
  const bridge = createBrowserSessionBridge();
  try {
    expect(await bridge.connect()).toEqual({
      ok: false,
      error: { kind: "unavailable" },
    });
    expect(bridge.getSnapshot().status).toBe("unavailable");
  } finally {
    bridge.dispose();
  }
});
