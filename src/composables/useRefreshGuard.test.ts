import { describe, expect, test } from "vitest";
import { createFixtureHttp, fixtureClientStore } from "@/test/operation-gateway";
import { createActionFeedbackStore } from "./useActionFeedback";
import { createRefreshGuard } from "./useRefreshGuard";
import { createSnapshotStore } from "./useSnapshot";

const always = () => () => true;

describe("useRefreshGuard", () => {
  test("only applies the latest refresh epoch and cancel invalidates it", async () => {
    const guard = createRefreshGuard(async () => {}, always);
    const applied: string[] = [];
    const stale = guard.next();
    const current = guard.next();

    await guard.refresh(stale, () => applied.push("stale"));
    await guard.refresh(current, () => applied.push("current"));
    guard.cancel();
    await guard.refresh(current, () => applied.push("cancelled"));

    expect(applied).toEqual(["current"]);
  });

  function newStore() {
    // The guard never reads through this client: its refresh is a deferred supplied by the test.
    const http = createFixtureHttp({ baseUrl: "http://127.0.0.1:9", apiKey: "unused" });
    const store = createSnapshotStore(fixtureClientStore(http), createActionFeedbackStore());
    store.setAuthorized(true);
    return store;
  }

  test.each([
    ["a server switch", (store: ReturnType<typeof newStore>) => store.resetSnapshot()],
    ["a lock", (store: ReturnType<typeof newStore>) => store.setAuthorized(false)],
    ["a same-server rebind", (store: ReturnType<typeof newStore>) => store.rebindSession()],
  ])("does not apply a refresh that settles across %s", async (_name, change) => {
    const store = newStore();
    const reply = Promise.withResolvers<void>();
    const guard = createRefreshGuard(() => reply.promise, store.captureSession);
    const applied: string[] = [];
    const token = guard.next();
    const refreshing = guard.refresh(token, () => applied.push("applied"));
    change(store);
    reply.resolve();
    await refreshing;
    expect(applied).toEqual([]);
  });

  test("applies a refresh when the session did not change", async () => {
    const store = newStore();
    const reply = Promise.withResolvers<void>();
    const guard = createRefreshGuard(() => reply.promise, store.captureSession);
    const applied: string[] = [];
    const refreshing = guard.refresh(guard.next(), () => applied.push("applied"));
    reply.resolve();
    await refreshing;
    expect(applied).toEqual(["applied"]);
  });
});
