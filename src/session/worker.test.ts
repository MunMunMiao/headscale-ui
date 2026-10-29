import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DB_VERSION } from "@/lib/idb";
import { createSessionBridge } from "./bridge";

const cleanup: (() => void)[] = [];
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("self", new EventTarget());
  vi.stubGlobal("__HEADSCALE_UI_BUILD_ID__", "worker-test-build");
});
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop();
  vi.unstubAllGlobals();
});
function bridge() {
  const page = createSessionBridge({
    openPort() {
      const channel = new MessageChannel();
      self.dispatchEvent(
        new MessageEvent("connect", { ports: [channel.port2] }),
      );
      cleanup.push(() => {
        channel.port1.close();
        channel.port2.close();
      });
      return channel.port1;
    },
    ownerTabId: () => crypto.randomUUID(),
    buildId: "worker-test-build",
    storageVersion: DB_VERSION,
  });
  cleanup.push(() => page.dispose());
  return page;
}
test("the module entry shares one host across simultaneously connecting ports", async () => {
  await import("./worker");
  const first = bridge();
  const second = bridge();
  expect(
    (await Promise.all([first.connect(), second.connect()])).map(
      (result) => result.ok,
    ),
  ).toEqual([true, true]);
  expect(first.getSnapshot().workerId).toBe(second.getSnapshot().workerId);
  expect(first.getSessionSnapshot()?.status).toBe("locked");
});
test("database initialization failure is returned as unavailable without an unhandled rejection", async () => {
  vi.stubGlobal("indexedDB", undefined);
  await import("./worker");
  expect(await bridge().connect()).toEqual({
    ok: false,
    error: { kind: "unavailable" },
  });
});
test("explicit reconnection retries a failed initialization and shares one recovered host", async () => {
  vi.stubGlobal("indexedDB", undefined);
  await import("./worker");
  const first = bridge();
  expect(await first.connect()).toEqual({
    ok: false,
    error: { kind: "unavailable" },
  });
  const database = new IDBFactory();
  vi.stubGlobal("indexedDB", database);
  const opens = vi.spyOn(database, "open");
  const second = bridge();
  const recovered = await Promise.all([first.reconnect(), second.connect()]);
  expect(recovered).toEqual([
    { ok: true, value: expect.objectContaining({ status: "locked" }) },
    { ok: true, value: expect.objectContaining({ status: "locked" }) },
  ]);
  expect(opens).toHaveBeenCalledTimes(1);
  expect(first.getSnapshot().workerId).toBe(second.getSnapshot().workerId);
});
test("ports sharing one failed initialization never discard a host created while they were refused", async () => {
  vi.stubGlobal("indexedDB", undefined);
  await import("./worker");
  const database = new IDBFactory();
  const opens = vi.spyOn(database, "open");
  const first = new MessageChannel();
  const second = new MessageChannel();
  cleanup.push(() => {
    first.port1.close();
    second.port1.close();
  });
  let recovered: ReturnType<ReturnType<typeof bridge>["connect"]> | undefined;
  let healthy: ReturnType<typeof bridge> | undefined;
  // Refusing the first port is what lets a new page connect and start a fresh host.
  first.port2.postMessage = () => {
    vi.stubGlobal("indexedDB", database);
    healthy = bridge();
    recovered = healthy.connect();
  };
  self.dispatchEvent(
    new MessageEvent("connect", { ports: [first.port2, second.port2] }),
  );
  await expect.poll(() => recovered).toBeDefined();
  expect(await recovered).toMatchObject({
    ok: true,
    value: { status: "locked" },
  });
  const later = bridge();
  expect(await later.connect()).toMatchObject({
    ok: true,
    value: { status: "locked" },
  });
  expect(later.getSnapshot().workerId).toBe(healthy?.getSnapshot().workerId);
  expect(opens).toHaveBeenCalledTimes(1);
});
