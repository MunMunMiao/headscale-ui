import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
  createTagLifecycleFixture,
  type TagClient,
  type TagLifecycleFixture,
  type TagNode,
} from "../scripts/harness/tag-lifecycle";

let fixture: TagLifecycleFixture;
beforeAll(async () => {
  fixture = await createTagLifecycleFixture();
}, 60_000);
beforeEach(async () => {
  await fixture.reset();
  await fixture.policy({
    acls: allow,
    tagOwners: {
      "tag:original": [],
      "tag:override": [],
      "tag:extra": [],
      "tag:replacement": [],
    },
  });
}, 60_000);
afterAll(async () => {
  await fixture?.close();
}, 60_000);
const allow = [{ action: "accept", src: ["*"], dst: ["*:*"] }];

async function joined(name: string, tags: string[], reusable = false) {
  const key = await fixture.key(tags, {
    user: tags.length ? undefined : fixture.users.alice,
    reusable,
  });
  const client = await fixture.client(name);
  await fixture.register(client, key.key);
  const node = (await fixture.nodes()).find((node) => node.name === name);
  if (!node)
    throw new Error("The official client did not register its fixture node");
  return { client, key, node };
}
async function reregister(
  client: TagClient,
  key: string,
  result: true | RegExp,
) {
  const originalKey = fixture.registrationNodeKeys(client).at(-1);
  expect(originalKey).toBeDefined();
  const since = new Date().toISOString();
  fixture.reregister(client, key);
  // Noise registration reports authentication failure inside its HTTP 200 protocol response.
  await expect
    .poll(
      () =>
        fixture
          .events(since)
          .some(
            (event) =>
              event.path === "/machine/register" && event.status === 200,
          ),
      { timeout: 15_000 },
    )
    .toBe(true);
  if (result === true)
    await expect
      .poll(() => fixture.status(client).BackendState, { timeout: 15_000 })
      .toBe("Running");
  else
    await expect
      .poll(
        () =>
          fixture
            .status(client)
            .Health?.some((message) => result.test(message)),
        {
          timeout: 15_000,
        },
      )
      .toBe(true);
  const requests = fixture.registrationNodeKeys(client, since);
  expect(requests.length).toBeGreaterThan(0);
  // An expired-key response can make the official client rotate on its later automatic retry.
  expect(
    requests[0],
    "the first real request must preserve NodeKey, not merely the stored node",
  ).toBe(originalKey);
  return fixture.events(since);
}
function fastPath(events: Record<string, unknown>[], name: string) {
  return events.some(
    (event) =>
      event["node.name"] === name &&
      String(event.message).includes("skipping validation"),
  );
}

test("A22: same MachineKey + NodeKey + AuthKeyID preserves admin tags with a used, then expired one-use key", async () => {
  const { client, key, node } = await joined("same-key", ["tag:original"]);
  await fixture.ok("POST", `/api/v1/node/${node.id}/tags`, {
    tags: ["tag:override", "tag:extra"],
  });
  const before = await fixture.node(node.id);
  expect(fixture.durableNode(node.id).auth_key_id).toBe(Number(key.id));
  expect(
    (
      await fixture.ok<{ preAuthKeys: { id: string; used: boolean }[] }>(
        "GET",
        "/api/v1/preauthkey",
      )
    ).preAuthKeys.find((item) => item.id === key.id)?.used,
  ).toBe(true);
  for (const expired of [false, true]) {
    if (expired)
      await fixture.ok("POST", "/api/v1/preauthkey/expire", { id: key.id });
    const events = await reregister(client, key.key, true);
    expect(fastPath(events, client.name)).toBe(true);
    const after = await fixture.node(node.id);
    expect(after.machineKey).toBe(before.machineKey);
    expect(after.nodeKey).toBe(before.nodeKey);
    expect(after.tags).toEqual(["tag:extra", "tag:override"]);
    expect(fixture.durableNode(node.id).auth_key_id).toBe(Number(key.id));
  }
});

test("A22: a different valid tagged key reassigns the whole set and persists its ephemeral association without NodeKey rotation", async () => {
  const { client, node } = await joined(
    "different-tagged-key",
    ["tag:original", "tag:extra"],
    true,
  );
  const replacement = await fixture.key(["tag:replacement"], {
    reusable: true,
    ephemeral: true,
  });
  const events = await reregister(client, replacement.key, true);
  expect(fastPath(events, client.name)).toBe(false);
  const after = await fixture.node(node.id);
  expect(after.machineKey).toBe(node.machineKey);
  expect(after.nodeKey).toBe(node.nodeKey);
  expect(after.tags).toEqual(["tag:replacement"]);
  expect(fixture.durableNode(node.id).auth_key_id).toBe(Number(replacement.id));
  fixture.stop(client);
  await fixture.restart();
  expect((await fixture.node(node.id)).tags).toEqual(["tag:replacement"]);
  expect(fixture.durableNode(node.id).auth_key_id).toBe(Number(replacement.id));
});

test.each(["expired", "used"] as const)(
  "A22: a different %s tagged key cannot retag even with matching MachineKey and NodeKey",
  async (kind) => {
    const { client, node } = await joined(
      `different-${kind}-key`,
      ["tag:original"],
      true,
    );
    const replacement = await fixture.key(["tag:replacement"]);
    if (kind === "expired")
      await fixture.ok("POST", "/api/v1/preauthkey/expire", {
        id: replacement.id,
      });
    else {
      const other = await fixture.client("key-consumer");
      await fixture.register(other, replacement.key);
      fixture.stop(other);
    }
    const before = fixture.durableNode(node.id);
    const events = await reregister(
      client,
      replacement.key,
      kind === "expired" ? /authkey expired/ : /authkey already used/,
    );
    expect(fastPath(events, client.name)).toBe(false);
    fixture.stop(client);
    const after = await fixture.node(node.id);
    expect(after.machineKey).toBe(node.machineKey);
    expect(after.nodeKey).toBe(node.nodeKey);
    expect(after.tags).toEqual(["tag:original"]);
    expect(fixture.durableNode(node.id).auth_key_id).toBe(before.auth_key_id);
  },
);

test("A22: an untagged key does not restore personal ownership of an existing tagged machine", async () => {
  const { client, node } = await joined(
    "untagged-key",
    ["tag:original", "tag:extra"],
    true,
  );
  const untagged = await fixture.key([], {
    user: fixture.users.bob,
    ephemeral: true,
  });
  const events = await reregister(client, untagged.key, true);
  expect(fastPath(events, client.name)).toBe(true);
  expect((await fixture.node(node.id)).tags).toEqual([
    "tag:extra",
    "tag:original",
  ]);
  expect((await fixture.node(node.id)).user?.id ?? null).toBeNull();
  expect(fixture.durableNode(node.id).user_id).toBeNull();
  expect(fixture.durableNode(node.id).auth_key_id).toBe(Number(untagged.id));
});

test("A22: deleting the original key fails lookup rather than taking the used/expired fast path and does not delete the existing node", async () => {
  const { client, key, node } = await joined(
    "deleted-key",
    ["tag:original"],
    true,
  );
  await fixture.ok("DELETE", `/api/v1/preauthkey?id=${key.id}`);
  expect(fixture.durableNode(node.id).auth_key_id).toBeNull();
  const events = await reregister(client, key.key, /invalid pre auth key/);
  expect(fastPath(events, client.name)).toBe(false);
  fixture.stop(client);
  expect((await fixture.node(node.id)).nodeKey).toBe(node.nodeKey);
  expect((await fixture.node(node.id)).tags).toEqual(["tag:original"]);
  await fixture.restart();
  expect((await fixture.node(node.id)).machineKey).toBe(node.machineKey);
});

test("A22: force-reauth rotates NodeKey using a valid reusable key, but a spent key cannot authorize that rotation", async () => {
  const valid = await joined("valid-nodekey-rotation", ["tag:original"], true);
  await fixture.ok("POST", `/api/v1/node/${valid.node.id}/tags`, {
    tags: ["tag:override", "tag:extra"],
  });
  const validOriginalKey = fixture.registrationNodeKeys(valid.client).at(-1);
  expect(validOriginalKey).toBeDefined();
  const validSince = new Date().toISOString();
  await fixture.register(valid.client, valid.key.key, { rotate: true });
  const firstValidRequest = fixture.registrationNodeKeys(
    valid.client,
    validSince,
  )[0];
  expect(firstValidRequest).toBeDefined();
  expect(firstValidRequest).not.toBe(validOriginalKey);
  const rotated = await fixture.node(valid.node.id);
  expect(rotated.machineKey).toBe(valid.node.machineKey);
  expect(rotated.nodeKey).not.toBe(valid.node.nodeKey);
  expect(rotated.tags).toEqual(["tag:extra", "tag:override"]);
  const used = await joined("used-nodekey-rotation", ["tag:original"]);
  const originalKey = fixture.registrationNodeKeys(used.client).at(-1);
  expect(originalKey).toBeDefined();
  const since = new Date().toISOString();
  const rejected = await fixture.register(used.client, used.key.key, {
    rotate: true,
    succeeds: false,
  });
  expect(rejected.code).not.toBe(0);
  expect(
    fixture
      .events(since)
      .some(
        (event) => event.path === "/machine/register" && event.status === 200,
      ),
  ).toBe(true);
  expect(
    fixture
      .status(used.client)
      .Health?.some((message) => /authkey already used/.test(message)),
  ).toBe(true);
  const firstRejectedRequest = fixture.registrationNodeKeys(
    used.client,
    since,
  )[0];
  expect(firstRejectedRequest).toBeDefined();
  expect(
    firstRejectedRequest,
    "force-reauth must rotate before the first request",
  ).not.toBe(originalKey);
  expect(fastPath(fixture.events(since), used.client.name)).toBe(false);
  fixture.stop(used.client);
  expect((await fixture.node(used.node.id)).nodeKey).toBe(used.node.nodeKey);
  expect((await fixture.node(used.node.id)).tags).toEqual(["tag:original"]);
});

test("A22: expired personal nodes cannot use the unchanged-NodeKey fast path with a spent key", async () => {
  const { client, key, node } = await joined("expired-personal-node", []);
  await fixture.ok("POST", `/api/v1/node/${node.id}/expire`);
  expect(Date.parse((await fixture.node(node.id)).expiry)).toBeLessThanOrEqual(
    Date.now(),
  );
  const events = await reregister(client, key.key, /authkey already used/);
  expect(fastPath(events, client.name)).toBe(false);
  fixture.stop(client);
  expect((await fixture.node(node.id)).user?.name).toBe("alice");
  expect((await fixture.node(node.id)).nodeKey).toBe(node.nodeKey);
});

const ownerPolicies: {
  kind: string;
  owners: Record<string, string[]>;
  personalAllowed: boolean;
}[] = [
  {
    kind: "nested",
    owners: { "tag:outer": ["tag:base"], "tag:base": ["alice@"] },
    personalAllowed: true,
  },
  {
    kind: "cycle-with-owner",
    owners: { "tag:outer": ["tag:base"], "tag:base": ["tag:outer", "alice@"] },
    personalAllowed: true,
  },
  {
    kind: "pure-cycle",
    owners: { "tag:outer": ["tag:base"], "tag:base": ["tag:outer"] },
    personalAllowed: false,
  },
];
for (const { kind, owners, personalAllowed } of ownerPolicies) {
  test.each(["first", "personal", "tagged"] as const)(
    `A26: ${kind} owner paths for %s non-authkey registration`,
    async (path) => {
      const policy = { acls: allow, tagOwners: owners };
      expect(
        (
          await fixture.call("POST", "/api/v1/policy/check", {
            policy: JSON.stringify(policy),
          })
        ).status,
      ).toBe(200);
      await fixture.policy(policy);
      let client: TagClient;
      let before: TagNode | undefined;
      if (path === "first")
        client = await fixture.client(`owners-${kind}-${path}`);
      else {
        const joinedNode = await joined(
          `owners-${kind}-${path}`,
          path === "tagged" ? ["tag:base"] : [],
          true,
        );
        client = joinedNode.client;
        before = joinedNode.node;
      }
      const request = await fixture.login(client, ["tag:outer"]);
      try {
        const response = await fixture.call<{
          node?: TagNode;
          message?: string;
        }>("POST", "/api/v1/auth/register", {
          user: "alice",
          authId: request.authId,
        });
        const allowed = path === "personal" && personalAllowed;
        if (allowed) {
          expect(response.status).toBe(200);
          expect((await request.completion).code).toBe(0);
          expect(response.json?.node?.id).toBe(before?.id);
          expect(response.json?.node?.tags).toEqual(["tag:outer"]);
        } else {
          expect(response.status).toBeGreaterThanOrEqual(400);
          expect(response.json?.message).toMatch(/invalid or not permitted/);
          if (before)
            expect((await fixture.node(before.id)).tags).toEqual(before.tags);
          else
            expect(
              (await fixture.nodes()).some((node) => node.name === client.name),
            ).toBe(false);
        }
      } finally {
        request.cancel();
        await request.completion;
      }
    },
  );
}

test.each(["first", "personal", "tagged"] as const)(
  "A26: dangling owners are rejected before policy installation for the %s path",
  async (path) => {
    if (path !== "first")
      await joined(
        `dangling-${path}`,
        path === "tagged" ? ["tag:original"] : [],
        true,
      );
    const before = (
      await fixture.ok<{ policy: string }>("GET", "/api/v1/policy")
    ).policy;
    const dangling = JSON.stringify({
      acls: allow,
      tagOwners: { "tag:outer": ["tag:missing"] },
    });
    const check = await fixture.call("POST", "/api/v1/policy/check", {
      policy: dangling,
    });
    expect(check.status).toBe(400);
    expect(check.text).toMatch(
      /undefined tag|tag.*not defined|references.*undefined/i,
    );
    expect(
      (await fixture.call("PUT", "/api/v1/policy", { policy: dangling }))
        .status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await fixture.ok<{ policy: string }>("GET", "/api/v1/policy")).policy,
    ).toBe(before);
  },
);
