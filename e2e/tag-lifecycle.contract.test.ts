import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import {
  createTagLifecycleFixture,
  type TagClient,
  type TagLifecycleFixture,
  type TagNode,
} from "../scripts/harness/tag-lifecycle";
import {
  ensureTagDefinition,
  parsePolicy,
  serializePolicy,
} from "../src/domain/policy-designer";
import { removePolicyTag } from "../src/domain/policy-references";

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

async function joined(
  name: string,
  tags: string[] = [],
  options: { ephemeral?: boolean; reusable?: boolean; routes?: string[] } = {},
) {
  const key = await fixture.key(tags, {
    user: tags.length ? undefined : fixture.users.alice,
    ephemeral: options.ephemeral,
    reusable: options.reusable,
  });
  const client = await fixture.client(name);
  await fixture.register(client, key.key, { routes: options.routes });
  const node = (await fixture.nodes()).find((node) => node.name === name);
  expect(node, "the official client must register a node").toBeDefined();
  return { client, key, node: node as TagNode };
}
async function authenticate(
  client: TagClient,
  tags: string[],
  user = "alice",
  routes: string[] = [],
) {
  const request = await fixture.login(client, tags, routes);
  try {
    const response = await fixture.call<{ node: TagNode; message?: string }>(
      "POST",
      "/api/v1/auth/register",
      { user, authId: request.authId },
    );
    if (response.status === 200)
      expect((await request.completion).code).toBe(0);
    else request.cancel();
    return response;
  } finally {
    request.cancel();
    await request.completion;
  }
}

test("A01/A09/A10: empty owners permit full SetTags replacement and clear personal ownership; empty and undefined collections reject before mutation", async () => {
  await fixture.policy({
    acls: allow,
    tagOwners: { "tag:empty": [], "tag:extra": [] },
  });
  const { client, node } = await joined("admin-assignment");
  fixture.stop(client);
  expect(node.user?.name).toBe("alice");
  expect(
    (await fixture.call("POST", `/api/v1/node/${node.id}/tags`, { tags: [] }))
      .status,
  ).toBe(400);
  expect(
    (
      await fixture.call("POST", `/api/v1/node/${node.id}/tags`, {
        tags: ["tag:undeclared"],
      })
    ).status,
  ).toBe(400);
  expect((await fixture.node(node.id)).user?.name).toBe("alice");
  await fixture.ok("POST", `/api/v1/node/${node.id}/tags`, {
    tags: ["tag:empty", "tag:extra", "tag:empty"],
  });
  const tagged = await fixture.node(node.id);
  expect(tagged.tags).toEqual(["tag:empty", "tag:extra"]);
  expect(tagged.user?.id ?? null).toBeNull();
  expect(fixture.durableNode(node.id).user_id).toBeNull();
  await fixture.ok("POST", `/api/v1/node/${node.id}/tags`, {
    tags: ["tag:extra"],
  });
  expect((await fixture.node(node.id)).tags).toEqual(["tag:extra"]);
  await fixture.restart();
  expect((await fixture.node(node.id)).tags).toEqual(["tag:extra"]);
  expect((await fixture.node(node.id)).user?.id ?? null).toBeNull();
});

test("A02: undeclared key tags join on first registration while SetTags and non-authkey owner requests reject", async () => {
  const { client, node } = await joined("undeclared-key", ["tag:undeclared"]);
  fixture.stop(client);
  expect(node.tags).toEqual(["tag:undeclared"]);
  expect(
    (
      await fixture.call("POST", `/api/v1/node/${node.id}/tags`, {
        tags: ["tag:undeclared"],
      })
    ).status,
  ).toBe(400);
  const claimant = await fixture.client("undeclared-client");
  const denied = await authenticate(claimant, ["tag:undeclared"]);
  expect(denied.status).toBeGreaterThanOrEqual(400);
  expect(denied.json?.message).toMatch(/invalid or not permitted/);
  expect(
    (await fixture.nodes()).some((item) => item.name === claimant.name),
  ).toBe(false);
  const taggedKey = await fixture.key(["tag:undeclared"]);
  const advertised = await fixture.client("first-key-request-tags");
  const registration = await fixture.register(advertised, taggedKey.key, {
    tags: ["tag:undeclared"],
    succeeds: false,
  });
  expect(registration.code).not.toBe(0);
  expect(
    registration.rejectedTags,
    "the registration must reach Headscale's tag rejection",
  ).toBe(true);
  expect(
    (await fixture.nodes()).some((item) => item.name === advertised.name),
  ).toBe(false);
});

test.each([
  { tag: "tag:Web1", policyStatus: 200, keyStatus: 400 },
  { tag: "tag:1abc", policyStatus: 400, keyStatus: 200 },
])(
  "A13/A23: $tag keeps policy and management entry contracts distinct",
  async ({ tag, policyStatus, keyStatus }) => {
    const checked = await fixture.call("POST", "/api/v1/policy/check", {
      policy: JSON.stringify({ acls: allow, tagOwners: { [tag]: [] } }),
    });
    expect(checked.status).toBe(policyStatus);
    if (policyStatus === 200)
      await fixture.policy({ acls: allow, tagOwners: { [tag]: [] } });
    const { client, node } = await joined("format-personal");
    fixture.stop(client);
    expect(
      (
        await fixture.call("POST", `/api/v1/node/${node.id}/tags`, {
          tags: [tag],
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    const created = await fixture.call<{
      preAuthKey?: { id: string; key: string; aclTags: string[] };
    }>("POST", "/api/v1/preauthkey", {
      aclTags: [tag],
      expiration: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(created.status).toBe(keyStatus);
    if (created.status === 200) {
      const key = created.json?.preAuthKey?.key;
      if (!key)
        throw new Error("Successful key creation must return its one-time key");
      const keyed = await fixture.client("numeric-key-first");
      await fixture.register(keyed, key);
      expect(
        (await fixture.nodes()).find((item) => item.name === keyed.name)?.tags,
      ).toEqual([tag]);
    }
  },
);

test("A14: a direct owner can be removed while the group's client authorization remains; existing tagged nodes and keys are unchanged", async () => {
  const policy = {
    acls: allow,
    groups: { "group:ops": ["alice@"] },
    tagOwners: { "tag:owner": ["alice@", "group:ops"] },
  };
  await fixture.policy(policy);
  const first = await fixture.client("direct-owner-first");
  expect((await authenticate(first, ["tag:owner"])).status).toBe(200);
  fixture.stop(first);
  const existing = (await fixture.nodes())[0];
  const key = await fixture.key(["tag:owner"], { reusable: true });
  policy.tagOwners["tag:owner"] = ["group:ops"];
  await fixture.policy(policy);
  const after = await fixture.client("group-owner-first");
  expect((await authenticate(after, ["tag:owner"])).status).toBe(200);
  expect((await fixture.node(existing.id)).tags).toEqual(["tag:owner"]);
  expect(
    (
      await fixture.ok<{ preAuthKeys: { id: string; aclTags: string[] }[] }>(
        "GET",
        "/api/v1/preauthkey",
      )
    ).preAuthKeys.find((item) => item.id === key.id)?.aclTags,
  ).toEqual(["tag:owner"]);
  policy.tagOwners["tag:owner"] = [];
  await fixture.policy(policy);
  const unowned = await fixture.client("empty-owner-client");
  expect(
    (await authenticate(unowned, ["tag:owner"])).status,
  ).toBeGreaterThanOrEqual(400);
  expect((await fixture.node(existing.id)).tags).toEqual(["tag:owner"]);
});

test("A15/A28: policy rename/removal never cascades to nodes or issued key tags; explicit migration preserves extra tags", async () => {
  await fixture.policy({
    acls: allow,
    tagOwners: { "tag:old": [], "tag:target": ["bob@"], "tag:extra": [] },
  });
  const { client, key, node } = await joined(
    "migration-node",
    ["tag:old", "tag:target", "tag:extra"],
    { reusable: true },
  );
  fixture.stop(client);
  const renamedPolicy = {
    acls: allow,
    tagOwners: { "tag:renamed": [], "tag:target": ["bob@"], "tag:extra": [] },
  };
  await fixture.policy(renamedPolicy);
  expect((await fixture.node(node.id)).tags.toSorted()).toEqual([
    "tag:extra",
    "tag:old",
    "tag:target",
  ]);
  expect(
    (
      await fixture.ok<{ preAuthKeys: { id: string; aclTags: string[] }[] }>(
        "GET",
        "/api/v1/preauthkey",
      )
    ).preAuthKeys
      .find((item) => item.id === key.id)
      ?.aclTags.toSorted(),
  ).toEqual(["tag:extra", "tag:old", "tag:target"]);
  await fixture.ok("POST", `/api/v1/node/${node.id}/tags`, {
    tags: ["tag:target", "tag:extra"],
  });
  expect((await fixture.node(node.id)).tags).toEqual([
    "tag:extra",
    "tag:target",
  ]);
  await fixture.policy({
    acls: allow,
    tagOwners: { "tag:target": ["bob@"], "tag:extra": [] },
  });
  expect((await fixture.node(node.id)).tags).toEqual([
    "tag:extra",
    "tag:target",
  ]);
  const read = await fixture.ok<{ policy: string }>("GET", "/api/v1/policy");
  expect(JSON.parse(read.policy).tagOwners["tag:target"]).toEqual(["bob@"]);
  expect(
    (
      await fixture.ok<{ preAuthKeys: { id: string; aclTags: string[] }[] }>(
        "GET",
        "/api/v1/preauthkey",
      )
    ).preAuthKeys.find((item) => item.id === key.id)?.aclTags,
  ).toContain("tag:old");
});

async function accessCheck(
  policy: Record<string, unknown>,
  allowed: boolean,
  destination = "198.51.100.20:80",
) {
  const tests = [
    {
      src: "192.0.2.10",
      proto: "tcp",
      [allowed ? "accept" : "deny"]: [destination],
    },
  ];
  const result = await fixture.call("POST", "/api/v1/policy/check", {
    policy: JSON.stringify({ ...policy, tests }),
  });
  expect(result.status, result.text).toBe(200);
  const inverse = [
    {
      src: "192.0.2.10",
      proto: "tcp",
      [allowed ? "deny" : "accept"]: [destination],
    },
  ];
  const control = await fixture.call("POST", "/api/v1/policy/check", {
    policy: JSON.stringify({ ...policy, tests: inverse }),
  });
  expect(control.status).toBe(400);
  expect(control.text).toMatch(/test\(s\) failed/);
  expect(control.text).toMatch(
    /expected (?:ALLOWED, got DENIED|DENIED, got ALLOWED)/,
  );
}

test.each([
  { baseline: {}, allowed: true, label: "implicit allow" },
  { baseline: { acls: [] }, allowed: false, label: "explicit empty ACL" },
  { baseline: { grants: [] }, allowed: false, label: "explicit empty grants" },
])(
  "A29: a definition-only draft preserves $label under the real 0.29.4 evaluator",
  async ({ baseline, allowed }) => {
    await accessCheck(baseline, allowed);
    const after = serializePolicy(
      ensureTagDefinition(
        parsePolicy(JSON.stringify(baseline)),
        "tag:definition-only",
      ),
    );
    expect(after.tagOwners).toEqual({ "tag:definition-only": [] });
    await accessCheck(after, allowed);
  },
);

test.each(["acl", "grant"] as const)(
  "A29: removing the last tag-dependent %s keeps explicit deny instead of restoring default allow",
  async (kind) => {
    const { client, node } = await joined(`last-${kind}`, ["tag:retired"]);
    fixture.stop(client);
    const before = {
      tagOwners: { "tag:retired": [] },
      ...(kind === "acl"
        ? {
            acls: [
              {
                action: "accept",
                src: ["192.0.2.10"],
                dst: ["tag:retired:80"],
              },
            ],
          }
        : {
            grants: [
              { src: ["192.0.2.10"], dst: ["tag:retired"], ip: ["tcp:80"] },
            ],
          }),
    };
    const destination = `${node.ipAddresses.find((ip) => !ip.includes(":"))}:80`;
    await accessCheck(before, true, destination);
    const result = removePolicyTag(
      parsePolicy(JSON.stringify(before)),
      "tag:retired",
    );
    expect(result.ok).toBe(true);
    if (!result.ok)
      throw new Error("Expected a supported tag-reference cleanup");
    const after = serializePolicy(result.state);
    expect(after.acls).toEqual([]);
    if (kind === "grant") expect(after.grants).toEqual([]);
    await accessCheck(after, false, destination);
  },
);

test("A29: removing the last grant via deletes the grant; merely stripping via would allow the denied flow", async () => {
  const grant = {
    src: ["192.0.2.10"],
    dst: ["198.51.100.20"],
    ip: ["tcp:80"],
    via: ["tag:retired"],
  };
  const before = { tagOwners: { "tag:retired": [] }, grants: [grant] };
  expect(
    (
      await fixture.call("POST", "/api/v1/policy/check", {
        policy: JSON.stringify(before),
      })
    ).status,
  ).toBe(200);
  const result = removePolicyTag(
    parsePolicy(JSON.stringify(before)),
    "tag:retired",
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected a supported grant-via cleanup");
  const after = serializePolicy(result.state);
  expect(after.grants).toEqual([]);
  expect(after.acls).toEqual([]);
  await accessCheck(after, false);
  const { via: _via, ...unsafeGrant } = grant;
  await accessCheck({ grants: [unsafeGrant] }, true);
});

describe("A25: file GET and runtime policy are independent observations", () => {
  test("added-but-unloaded definition appears in GET but SetTags rejects until restart loads it", async () => {
    const file = await createTagLifecycleFixture({
      filePolicy: JSON.stringify({
        acls: allow,
        tagOwners: { "tag:loaded": [] },
      }),
    });
    try {
      const key = await file.key([], { user: file.users.alice });
      const client = await file.client("file-add-node");
      await file.register(client, key.key);
      file.stop(client);
      const node = (await file.nodes())[0];
      file.writePolicyFile({
        acls: allow,
        tagOwners: { "tag:loaded": [], "tag:unloaded": [] },
      });
      expect(
        JSON.parse(
          (await file.ok<{ policy: string }>("GET", "/api/v1/policy")).policy,
        ).tagOwners,
      ).toHaveProperty("tag:unloaded");
      expect(
        (
          await file.call("POST", `/api/v1/node/${node.id}/tags`, {
            tags: ["tag:unloaded"],
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await file.call("POST", `/api/v1/node/${node.id}/tags`, {
            tags: ["tag:loaded"],
          })
        ).status,
      ).toBe(200);
      await file.restart();
      expect(
        (
          await file.call("POST", `/api/v1/node/${node.id}/tags`, {
            tags: ["tag:unloaded"],
          })
        ).status,
      ).toBe(200);
    } finally {
      await file.close();
    }
  });
  test("removed-but-unloaded definition is absent from GET while runtime still accepts it until restart", async () => {
    const file = await createTagLifecycleFixture({
      filePolicy: JSON.stringify({
        acls: allow,
        tagOwners: { "tag:removed": [], "tag:kept": [] },
      }),
    });
    try {
      const key = await file.key([], { user: file.users.alice });
      const client = await file.client("file-remove-node");
      await file.register(client, key.key);
      file.stop(client);
      const node = (await file.nodes())[0];
      file.writePolicyFile({ acls: allow, tagOwners: { "tag:kept": [] } });
      expect(
        JSON.parse(
          (await file.ok<{ policy: string }>("GET", "/api/v1/policy")).policy,
        ).tagOwners,
      ).not.toHaveProperty("tag:removed");
      expect(
        (
          await file.call("POST", `/api/v1/node/${node.id}/tags`, {
            tags: ["tag:removed"],
          })
        ).status,
      ).toBe(200);
      await file.restart();
      expect(
        (
          await file.call("POST", `/api/v1/node/${node.id}/tags`, {
            tags: ["tag:removed"],
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await file.call("POST", `/api/v1/node/${node.id}/tags`, {
            tags: ["tag:kept"],
          })
        ).status,
      ).toBe(200);
    } finally {
      await file.close();
    }
  });
});
