import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { createSessionNetwork } from "../scripts/harness/session-network";
import {
  createTagLifecycleFixture,
  type TagLifecycleFixture,
} from "../scripts/harness/tag-lifecycle";

let fixture: TagLifecycleFixture;
beforeAll(async () => {
  fixture = await createTagLifecycleFixture();
}, 60_000);
beforeEach(async () => {
  await fixture.reset();
}, 60_000);
afterAll(async () => {
  await fixture?.close();
}, 60_000);
const allow = [{ action: "accept", src: ["*"], dst: ["*:*"] }];
async function nodeFixture(
  name: string,
  options: { tags?: string[]; routes?: string[]; online?: boolean } = {},
) {
  const key = await fixture.key(options.tags ?? [], {
    user: options.tags?.length ? undefined : fixture.users.alice,
    reusable: true,
  });
  const client = await fixture.client(name);
  await fixture.register(client, key.key, { routes: options.routes });
  const node = (await fixture.nodes()).find((item) => item.name === name);
  if (!node)
    throw new Error("The official client did not register its fixture node");
  if (!options.online) fixture.stop(client);
  return { client, key, node };
}
function persistedPolicy() {
  return fixture.sql<{ data: string }>(
    "SELECT data FROM policies ORDER BY id DESC LIMIT 1",
  )[0].data;
}

test("A24/node persistence: a real SQLite abort returns 400 after memory changes; SQL and restart retain the old personal identity", async () => {
  await fixture.policy({ acls: allow, tagOwners: { "tag:node-fault": [] } });
  const { node } = await nodeFixture("node-late-failure");
  const before = fixture.durableNode(node.id);
  fixture.sql(
    `CREATE TRIGGER tag_lifecycle_node_persist BEFORE UPDATE OF tags ON nodes WHEN NEW.id=${Number(node.id)} AND NEW.tags IS NOT OLD.tags BEGIN SELECT RAISE(ABORT,'TAG_LIFECYCLE_NODE_PERSIST'); END`,
  );
  const result = await fixture.call("POST", `/api/v1/node/${node.id}/tags`, {
    tags: ["tag:node-fault"],
  });
  expect(result.status).toBe(400);
  expect(result.text).toContain("TAG_LIFECYCLE_NODE_PERSIST");
  expect((await fixture.node(node.id)).tags).toEqual(["tag:node-fault"]);
  expect((await fixture.node(node.id)).user?.id ?? null).toBeNull();
  expect(fixture.durableNode(node.id)).toEqual(before);
  await fixture.restart(true);
  expect((await fixture.node(node.id)).tags).toEqual([]);
  expect((await fixture.node(node.id)).user?.name).toBe("alice");
  expect(fixture.durableNode(node.id)).toEqual(before);
});

test("A24/policy persistence: policy runtime advances before a rejected INSERT; GET and SQL remain old and restart restores old runtime", async () => {
  const { node } = await nodeFixture("policy-persistence-node");
  const before = persistedPolicy();
  fixture.sql(
    "CREATE TRIGGER tag_lifecycle_policy_persist BEFORE INSERT ON policies BEGIN SELECT RAISE(ABORT,'TAG_LIFECYCLE_POLICY_PERSIST'); END",
  );
  const target = { acls: allow, tagOwners: { "tag:runtime-only": [] } };
  const result = await fixture.call("PUT", "/api/v1/policy", {
    policy: JSON.stringify(target),
  });
  expect(result.status).toBe(500);
  expect(result.text).toContain("TAG_LIFECYCLE_POLICY_PERSIST");
  expect(
    (await fixture.ok<{ policy: string }>("GET", "/api/v1/policy")).policy,
  ).toBe(before);
  expect(persistedPolicy()).toBe(before);
  // This separate runtime operation proves acceptance by PolicyManager, not by policy GET.
  expect(
    (
      await fixture.call("POST", `/api/v1/node/${node.id}/tags`, {
        tags: ["tag:runtime-only"],
      })
    ).status,
  ).toBe(200);
  await fixture.restart(true);
  expect(
    (
      await fixture.call("POST", `/api/v1/node/${node.id}/tags`, {
        tags: ["tag:runtime-only"],
      })
    ).status,
  ).toBe(400);
  expect((await fixture.node(node.id)).tags).toEqual(["tag:runtime-only"]);
});

test("A24/policy reload: a real route persistence failure occurs after policy commit and route memory mutation; matching GET does not prove completed reload", async () => {
  const route = "10.77.0.0/24";
  const { node } = await nodeFixture("policy-reload-node", { routes: [route] });
  expect(node.availableRoutes).toContain(route);
  expect(node.approvedRoutes).toEqual([]);
  const before = fixture.durableNode(node.id).approved_routes;
  fixture.sql(
    `CREATE TRIGGER tag_lifecycle_policy_reload BEFORE UPDATE OF approved_routes ON nodes WHEN NEW.id=${Number(node.id)} AND NEW.approved_routes IS NOT OLD.approved_routes BEGIN SELECT RAISE(ABORT,'TAG_LIFECYCLE_POLICY_RELOAD'); END`,
  );
  const target = {
    acls: allow,
    tagOwners: { "tag:reload-committed": [] },
    autoApprovers: { routes: { [route]: ["alice@"] } },
  };
  const result = await fixture.call("PUT", "/api/v1/policy", {
    policy: JSON.stringify(target),
  });
  expect(result.status).toBe(500);
  expect(result.text).toMatch(/reloading policy.*TAG_LIFECYCLE_POLICY_RELOAD/);
  expect(
    JSON.parse(
      (await fixture.ok<{ policy: string }>("GET", "/api/v1/policy")).policy,
    ),
  ).toEqual(target);
  expect(JSON.parse(persistedPolicy())).toEqual(target);
  expect((await fixture.node(node.id)).approvedRoutes).toEqual([route]);
  expect(fixture.durableNode(node.id).approved_routes).toBe(before);
  await fixture.restart(true);
  expect(JSON.parse(persistedPolicy())).toEqual(target);
  expect((await fixture.node(node.id)).approvedRoutes).toEqual([]);
  expect(fixture.durableNode(node.id).approved_routes).toBe(before);
  expect(
    (
      await fixture.call("POST", `/api/v1/node/${node.id}/tags`, {
        tags: ["tag:reload-committed"],
      })
    ).status,
  ).toBe(200);
});

test("A30/AuthRegister: route persistence fails after user conversion and Auth ID consumption; identity survives restart but old request is not reusable", async () => {
  const route = "10.78.0.0/24";
  await fixture.policy({
    acls: allow,
    tagOwners: { "tag:auth-late": [] },
    autoApprovers: { routes: { [route]: ["alice@"] } },
  });
  const { client, node } = await nodeFixture("auth-post-consumption", {
    tags: ["tag:auth-late"],
    routes: [route],
    online: true,
  });
  expect(fixture.durableNode(node.id).auth_key_id).not.toBeNull();
  const beforeRoutes = fixture.durableNode(node.id).approved_routes;
  fixture.sql(
    `CREATE TRIGGER tag_lifecycle_auth_consumed BEFORE UPDATE OF approved_routes ON nodes WHEN NEW.id=${Number(node.id)} AND NEW.approved_routes IS NOT OLD.approved_routes BEGIN SELECT RAISE(ABORT,'TAG_LIFECYCLE_AUTH_CONSUMED'); END`,
  );
  const request = await fixture.login(client, [], [route]);
  try {
    const result = await fixture.call("POST", "/api/v1/auth/register", {
      user: "alice",
      authId: request.authId,
    });
    expect(result.status).toBe(500);
    expect(result.text).toMatch(
      /auto approving routes.*TAG_LIFECYCLE_AUTH_CONSUMED/,
    );
    expect((await request.completion).code).toBe(0);
    fixture.stop(client);
    const live = await fixture.node(node.id);
    expect(live.machineKey).toBe(node.machineKey);
    expect(live.tags).toEqual([]);
    expect(live.user?.name).toBe("alice");
    expect(live.approvedRoutes).toEqual([route]);
    const durable = fixture.durableNode(node.id);
    expect(durable.user_id).toBe(Number(fixture.users.alice));
    expect(durable.auth_key_id).toBeNull();
    expect(durable.approved_routes).toBe(beforeRoutes);
    // Deliberate backend characterization, not an application retry: no pending-request query exists.
    const consumed = await fixture.call("POST", "/api/v1/auth/register", {
      user: "alice",
      authId: request.authId,
    });
    expect(consumed.status).toBeGreaterThanOrEqual(400);
    expect(consumed.text).toMatch(/registration cache/);
    await fixture.restart(true);
    expect((await fixture.node(node.id)).tags).toEqual([]);
    expect((await fixture.node(node.id)).user?.name).toBe("alice");
    expect(fixture.durableNode(node.id).auth_key_id).toBeNull();
    expect((await fixture.node(node.id)).approvedRoutes).toEqual([]);
  } finally {
    request.cancel();
    await request.completion;
  }
});

test("A11/transport: not sent is upstreamRequests=0; lost reply is one committed request; 2xx then failed GET is still one confirmed write", async () => {
  await fixture.policy({
    acls: allow,
    tagOwners: { "tag:transport": [], "tag:confirmed": [] },
  });
  const { node } = await nodeFixture("transport-node");
  const network = createSessionNetwork({ upstream: fixture.baseUrl });
  try {
    const never = network.intercept({
      method: "POST",
      pathPattern: `/node/${node.id}/tags$`,
      failure: "not forwarded",
    });
    expect(
      (
        await fixture.call(
          "POST",
          `/api/v1/node/${node.id}/tags`,
          { tags: ["tag:transport"] },
          network.url,
        )
      ).status,
    ).toBe(503);
    expect(never.getSnapshot()).toMatchObject({ hits: 1, upstreamRequests: 0 });
    expect((await fixture.node(node.id)).tags).toEqual([]);
    await never.release();
    const lost = network.intercept({
      method: "POST",
      pathPattern: `/node/${node.id}/tags$`,
      failure: { drop: true },
    });
    const pending = fixture
      .call(
        "POST",
        `/api/v1/node/${node.id}/tags`,
        { tags: ["tag:transport"] },
        network.url,
      )
      .then(
        () => "delivered",
        () => "response-unknown",
      );
    await expect
      .poll(() => lost.getSnapshot().captured, { timeout: 10_000 })
      .toBe(true);
    expect(lost.getSnapshot()).toMatchObject({ hits: 1, upstreamRequests: 1 });
    await lost.release();
    expect(await pending).toBe("response-unknown");
    expect((await fixture.node(node.id)).tags).toEqual(["tag:transport"]);
    expect(JSON.parse(fixture.durableNode(node.id).tags ?? "null")).toEqual([
      "tag:transport",
    ]);
    await fixture.restart(true);
    expect((await fixture.node(node.id)).tags).toEqual(["tag:transport"]);
    network.clearObservations();
    const confirmed = await fixture.call(
      "POST",
      `/api/v1/node/${node.id}/tags`,
      { tags: ["tag:confirmed"] },
      network.url,
    );
    expect(confirmed.status).toBe(200);
    const read = network.intercept({
      method: "GET",
      pathPattern: "/node$",
      failure: "refresh unavailable",
    });
    expect(
      (await fixture.call("GET", "/api/v1/node", undefined, network.url))
        .status,
    ).toBe(503);
    expect(
      network
        .getObservations()
        .filter((item) => item.method === "POST")
        .map((item) => item.upstreamRequests),
    ).toEqual([1]);
    expect(read.getSnapshot().upstreamRequests).toBe(0);
    expect((await fixture.node(node.id)).tags).toEqual(["tag:confirmed"]);
    await read.release();
  } finally {
    await network.close();
  }
});

test("A33/transport: lost create reply and concurrent identical parameters produce distinct keys, not a safely attributable retry target", async () => {
  const network = createSessionNetwork({ upstream: fixture.baseUrl });
  try {
    const body = {
      aclTags: ["tag:concurrent"],
      reusable: true,
      expiration: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const lost = network.intercept({
      method: "POST",
      pathPattern: "^/api/v1/preauthkey$",
      failure: { drop: true },
    });
    const pending = fixture
      .call("POST", "/api/v1/preauthkey", body, network.url)
      .then(
        () => "delivered",
        () => "response-unknown",
      );
    await expect
      .poll(() => lost.getSnapshot().captured, { timeout: 10_000 })
      .toBe(true);
    const concurrent = await fixture.call<{ preAuthKey: { id: string } }>(
      "POST",
      "/api/v1/preauthkey",
      body,
    );
    expect(concurrent.status).toBe(200);
    await lost.release();
    expect(await pending).toBe("response-unknown");
    const keys = (
      await fixture.ok<{ preAuthKeys: { id: string; aclTags: string[] }[] }>(
        "GET",
        "/api/v1/preauthkey",
      )
    ).preAuthKeys;
    expect(keys).toHaveLength(2);
    expect(new Set(keys.map((key) => key.id)).size).toBe(2);
    expect(keys.every((key) => key.aclTags.join() === "tag:concurrent")).toBe(
      true,
    );
    expect(lost.getSnapshot()).toMatchObject({ hits: 1, upstreamRequests: 1 });
    expect(network.getOperationCalls().map((call) => call.id)).toEqual([
      "preauthkey.create",
    ]);
    expect(keys.some((key) => key.id === concurrent.json?.preAuthKey.id)).toBe(
      true,
    );
  } finally {
    await network.close();
  }
});
