import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, test } from "vitest";
import { __resetForTest } from "@/lib/idb";
import { createSessionHarness } from "@/test/session-host";
import { startSnapshotServer } from "@/test-utils/headscale.test";
import { idbPut } from "@/test-utils/storage";
import { guardRoute } from "./index";

let harness: Awaited<ReturnType<typeof createSessionHarness>>;
let page: Awaited<ReturnType<typeof harness.openPage>>;
let server: ReturnType<typeof startSnapshotServer>;
beforeEach(async () => {
  __resetForTest();
  globalThis.indexedDB = new IDBFactory();
  harness = await createSessionHarness();
  page = await harness.openPage("owner-a");
  server = startSnapshotServer();
});
afterEach(async () => {
  await harness.dispose();
  server.stop();
});
function decision(path: string, search: Record<string, unknown> = {}) {
  try {
    guardRoute({ auth: page.bridge }, { pathname: path, href: path, search });
    return null;
  } catch (redirect) {
    return (redirect as { options: object }).options;
  }
}
async function unlock() {
  const result = await page.bridge.saveProfile({
    kind: "credentials",
    expected: { version: page.profiles.version, ownerTabId: "", profile: null },
    profile: { id: "a", name: "A", baseUrl: server.baseUrl, scope: "session" },
    apiKey: "route-key",
    password: "route-password",
    validation: "required",
    activate: true,
    expectedWorkerId: page.bridge.getSnapshot().workerId ?? "",
    expectedIdentity: null,
  });
  expect(result.ok).toBe(true);
}
test("persistent active references and URL profile parameters cannot authorize a locked page", async () => {
  await idbPut(
    "meta",
    { profileId: "a", operationId: "old" },
    "active-profile-id",
  );
  expect(decision("/devices", { profile: "a" })).toMatchObject({
    to: "/login",
    search: { profile: "a" },
  });
  expect(decision("/login")).toBeNull();
});
test("the shared temporary session authorizes a foreign owner's page without exposing its list", async () => {
  await unlock();
  page = await harness.openPage("owner-b");
  expect(page.profiles.profiles).toEqual([]);
  expect(decision("/home")).toBeNull();
  expect(decision("/home", { profile: "a" })).toBeNull();
  const identity = page.bridge.getSessionSnapshot()?.identity;
  expect(decision("/devices", { profile: "b" })).toMatchObject({
    to: "/login",
    search: { profile: "b" },
  });
  expect(page.bridge.getSessionSnapshot()?.identity).toEqual(identity);
});
test("legacy unlock routes lead to per-server login and public routes stay available", () => {
  expect(decision("/unlock", { redirect: "/devices" })).toMatchObject({
    to: "/login",
  });
  expect(decision("/public")).toBeNull();
});
