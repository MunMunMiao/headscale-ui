import { beforeEach, describe, expect, test } from "bun:test";
import { createInitialSnapshot, MockHeadscaleClient } from "@/api/mock-headscale-client";
import type { HeadscaleSnapshot, HealthResponse } from "@/api/types";
import { actionFeedbackTestingHandle, useActionFeedback } from "./useActionFeedback";
import { headscaleClientTestingHandle, useHeadscaleClient } from "./useHeadscaleClient";
import { fetchSegments, fetchSnapshot, snapshotTestingHandle, useSnapshot } from "./useSnapshot";

beforeEach(() => {
  actionFeedbackTestingHandle.reset();
  headscaleClientTestingHandle.reset();
  snapshotTestingHandle.reset();
});

describe("snapshot fetchers", () => {
  test("fetches selected segments and assembles a complete snapshot", async () => {
    const client = new MockHeadscaleClient();

    const identity = await fetchSegments(client, ["identity"]);
    expect(identity.users).toHaveLength(3);
    expect(identity.preAuthKeys).toHaveLength(2);
    expect(identity.apiKeys).toHaveLength(2);
    expect(identity.nodes).toBeUndefined();

    const fabricAndPolicy = await fetchSegments(client, ["fabric", "policy"]);
    expect(fabricAndPolicy.health?.serverReachable).toBe(true);
    expect(fabricAndPolicy.version).toEqual({ version: "0.28.0" });
    expect(fabricAndPolicy.nodes).toHaveLength(3);
    expect(fabricAndPolicy.policy?.policy).toContain('"acls"');

    const snapshot = await fetchSnapshot(client);
    expect(Object.keys(snapshot).sort()).toEqual([
      "apiKeys",
      "health",
      "nodes",
      "policy",
      "preAuthKeys",
      "users",
      "version",
    ]);
  });
});

describe("useSnapshot", () => {
  test("derives views, rebuilds rename drafts, and notifies only the current hook", () => {
    const api = useSnapshot();
    expect(useSnapshot()).toBe(api);

    const next = createInitialSnapshot();
    next.nodes = [
      {
        ...next.nodes[0],
        id: "online-route",
        name: "fallback-name",
        givenName: "",
        online: true,
        availableRoutes: ["10.0.0.0/8"],
      },
      {
        ...next.nodes[1],
        id: "offline-node",
        name: "machine-name",
        givenName: "display-name",
        online: false,
        availableRoutes: [],
        approvedRoutes: [],
      },
    ];
    next.preAuthKeys = [
      { ...next.preAuthKeys[0], id: "open", used: false, expiration: "2999-01-01T00:00:00Z" },
      { ...next.preAuthKeys[0], id: "used", used: true, expiration: "2999-01-01T00:00:00Z" },
      { ...next.preAuthKeys[0], id: "expired", used: false, expiration: "2000-01-01T00:00:00Z" },
    ];

    const applied: HeadscaleSnapshot[] = [];
    api.renameDrafts.stale = "remove-me";
    api.setOnApplySnapshot((snapshot) => applied.push(snapshot));
    api.applySnapshot(next);

    expect(api.onlineNodes.value.map((node) => node.id)).toEqual(["online-route"]);
    expect(api.openInvites.value.map((key) => key.id)).toEqual(["open"]);
    expect(api.routeNodes.value.map((node) => node.id)).toEqual(["online-route"]);
    expect(api.renameDrafts).toEqual({
      "online-route": "fallback-name",
      "offline-node": "display-name",
    });
    expect(api.nodeById("online-route")?.name).toBe("fallback-name");
    expect(api.nodeById("missing")).toBeUndefined();
    expect(api.userById(next.users[0].id)).toEqual(next.users[0]);
    expect(api.userById("missing")).toBeUndefined();

    api.applyPatch({ users: [] });
    expect(api.renameDrafts["online-route"]).toBe("fallback-name");
    expect(applied).toHaveLength(2);

    api.setOnApplySnapshot(null);
    api.applyOfflineHealth();
    expect(api.snapshot.value.health).toMatchObject({
      databaseConnectivity: false,
      serverReachable: false,
    });
    expect(Number.isNaN(Date.parse(api.snapshot.value.health?.checkedAt ?? ""))).toBe(false);
  });

  test("skips unauthorized refreshes and clears stale errors after successful refreshes", async () => {
    const api = useSnapshot();
    const feedback = useActionFeedback();
    feedback.lastError.value = "stale";

    await api.refreshSegments(["identity"]);
    expect(feedback.lastError.value).toBe("stale");
    expect(api.refreshSnapshotInFlight.value).toBe(0);

    api.isAuthorized.value = true;
    await api.refreshSegments(["identity"]);
    expect(api.snapshot.value.users).toHaveLength(3);
    expect(feedback.lastError.value).toBe("");

    await api.refreshSnapshot();
    expect(api.snapshot.value.version).toEqual({ version: "0.28.0" });
    expect(api.refreshSnapshotInFlight.value).toBe(0);
    expect(api.isRefreshing.value).toBe(false);
  });

  test("marks the server offline and surfaces Error and non-Error refresh failures", async () => {
    const client = useHeadscaleClient().mockClient;
    const api = useSnapshot();
    const feedback = useActionFeedback();
    api.isAuthorized.value = true;
    client.health = async () => {
      throw new Error("health failed");
    };

    await api.refreshSegments(["fabric"]);
    expect(feedback.lastError.value).toBe("health failed");
    expect(api.snapshot.value.health?.serverReachable).toBe(false);

    client.health = async () => {
      throw "string failure";
    };
    await api.refreshSegments(["fabric"]);
    expect(feedback.lastError.value).toBe("string failure");
    expect(api.refreshSnapshotInFlight.value).toBe(0);
  });

  test("tracks concurrent refreshes until the final request settles", async () => {
    const client = useHeadscaleClient().mockClient;
    const api = useSnapshot();
    api.isAuthorized.value = true;
    const resolvers: Array<(health: HealthResponse) => void> = [];
    client.health = () =>
      new Promise<HealthResponse>((resolve) => {
        resolvers.push(resolve);
      });

    const first = api.refreshSegments(["fabric"]);
    const second = api.refreshSegments(["fabric"]);
    await Promise.resolve();

    expect(api.refreshSnapshotInFlight.value).toBe(2);
    expect(api.isRefreshing.value).toBe(true);

    resolvers[0]({ databaseConnectivity: true, serverReachable: true });
    await first;
    expect(api.refreshSnapshotInFlight.value).toBe(1);

    resolvers[1]({ databaseConnectivity: true, serverReachable: true });
    await second;
    expect(api.refreshSnapshotInFlight.value).toBe(0);
    expect(api.isRefreshing.value).toBe(false);
  });

  test("does not apply a previous session's refresh failure to the current session", async () => {
    const client = useHeadscaleClient().mockClient;
    const api = useSnapshot();
    const feedback = useActionFeedback();
    api.isAuthorized.value = true;
    const response = Promise.withResolvers<HealthResponse>();
    client.health = () => response.promise;
    const refreshing = api.refreshSegments(["fabric"]);

    api.isAuthorized.value = false;
    api.isAuthorized.value = true;
    api.applySnapshot(createInitialSnapshot());
    feedback.lastError.value = "current session feedback";
    response.reject(new Error("previous session failed"));
    await refreshing;

    expect(feedback.lastError.value).toBe("current session feedback");
    expect(api.snapshot.value.health?.serverReachable).toBe(true);
    expect(api.isRefreshing.value).toBe(false);
  });
});
