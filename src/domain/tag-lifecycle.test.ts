import { describe, expect, test } from "vitest";
import { normalizeHeadscaleNode, normalizePreAuthKey } from "@/api/contracts";
import { parsePolicy } from "./policy-designer";
import {
  assignableTagsFromPolicy,
  nodeTagBaseline,
  observeTags,
  registrationKeyStatus,
  replaceTagInSet,
  sameNodeTagBaseline,
  sameTagSet,
  tagOwnerDependencies,
  tagSetDiff,
} from "./tag-lifecycle";

const node = normalizeHeadscaleNode({
  id: "n1",
  name: "offline",
  online: false,
  tags: ["tag:node-only"],
});
const key = normalizePreAuthKey({
  id: "k1",
  key: "never-project-this-secret",
  aclTags: ["tag:key-only", "tag:1abc"],
});
const reading = {
  policy: JSON.stringify({
    tagOwners: {
      "tag:declared": [],
      "tag:Web1": [],
      "tag:child": ["tag:parent"],
    },
    acls: [
      { action: "accept", src: ["tag:source"], dst: ["tag:destination:22"] },
    ],
    grants: [
      { src: ["tag:grant"], dst: ["*"], via: ["tag:router"], ip: ["*"] },
    ],
    ssh: [
      {
        action: "accept",
        src: ["tag:ssh"],
        dst: ["tag:declared"],
        users: ["root"],
      },
    ],
    autoApprovers: { routes: { "10.0.0.0/8": ["tag:route"] } },
  }),
};

describe("tag observations and assignment candidates", () => {
  test("discovers key-only, offline node and supported reference tags independently of declaration", () => {
    const inventory = observeTags({
      policy: reading,
      nodes: [node],
      preAuthKeys: [key],
    });
    expect(inventory.tags.map((entry) => entry.tag)).toEqual([
      "tag:1abc",
      "tag:Web1",
      "tag:child",
      "tag:declared",
      "tag:destination",
      "tag:grant",
      "tag:key-only",
      "tag:node-only",
      "tag:parent",
      "tag:route",
      "tag:router",
      "tag:source",
      "tag:ssh",
    ]);
    expect(
      inventory.tags.find((entry) => entry.tag === "tag:key-only"),
    ).toMatchObject({
      definition: "undeclared",
      sources: ["key"],
      keys: [
        { id: "k1", registration: "available", oldDeployment: "possible" },
      ],
    });
    expect(
      inventory.tags.find((entry) => entry.tag === "tag:node-only"),
    ).toMatchObject({
      sources: ["node"],
      nodeIds: ["n1"],
    });
    expect(
      inventory.tags.find((entry) => entry.tag === "tag:router")
        ?.referencePaths,
    ).toEqual(["grants[0].via[0]"]);
    expect(JSON.stringify(inventory)).not.toContain(
      "never-project-this-secret",
    );
  });

  test("only readback declarations valid for SetTags are assignable, not rules, keys or dirty drafts", () => {
    expect(assignableTagsFromPolicy(reading)).toEqual([
      "tag:child",
      "tag:declared",
    ]);
    const dirtyDraft = { policy: '{"tagOwners":{"tag:draft":[]}}' };
    expect(assignableTagsFromPolicy(reading)).not.toContain("tag:draft");
    expect(assignableTagsFromPolicy(dirtyDraft)).toEqual(["tag:draft"]);
    expect(assignableTagsFromPolicy(null)).toEqual([]);
    expect(assignableTagsFromPolicy({ policy: "not a policy" })).toEqual([]);
  });

  test("preserves incompatible observed names without silently normalizing or promising declaration", () => {
    const inventory = observeTags({
      policy: reading,
      nodes: [node],
      preAuthKeys: [key],
    });
    expect(
      inventory.tags.find((entry) => entry.tag === "tag:1abc"),
    ).toMatchObject({
      policyCompatible: false,
      deviceCompatible: true,
    });
    expect(
      inventory.tags.find((entry) => entry.tag === "tag:Web1"),
    ).toMatchObject({
      policyCompatible: true,
      deviceCompatible: false,
    });
    expect(inventory.assignableTags).not.toContain("tag:web1");
  });

  test("failed reads retain observed data but mark definitions and dependency sources unknown", () => {
    const inventory = observeTags({
      policy: reading,
      nodes: [node],
      preAuthKeys: [key],
      readState: { policy: "error", fabric: "loading", identity: "unknown" },
    });
    expect(inventory.unknownSources).toEqual(["policy", "fabric", "identity"]);
    expect(
      inventory.tags.find((entry) => entry.tag === "tag:declared")?.definition,
    ).toBe("unknown");
    expect(
      inventory.tags.find((entry) => entry.tag === "tag:key-only")?.keys,
    ).toEqual([
      { id: "k1", registration: "unknown", oldDeployment: "unknown" },
    ]);
  });

  test("unparseable policy and unmodeled references prevent a clean dependency conclusion", () => {
    const broken = observeTags({
      policy: { policy: "not json" },
      nodes: [node],
      preAuthKeys: [],
    });
    expect(broken.unknownSources).toContain("policy");
    expect(broken.tags[0]?.definition).toBe("unknown");
    const opaque = observeTags({
      policy: {
        policy: '{"tagOwners":{"tag:x":[]},"opaque":{"target":"tag:hidden"}}',
      },
      nodes: [],
      preAuthKeys: [],
    });
    expect(opaque.referenceIssues).toEqual(["opaque"]);
    expect(opaque.unknownSources).toContain("references");
    expect(opaque.tags.map((entry) => entry.tag)).toEqual(["tag:x"]);
  });
});

test("a missing policy read keeps existing observations unknown rather than declaring them absent", () => {
  const inventory = observeTags({
    policy: null,
    nodes: [node],
    preAuthKeys: [],
  });
  expect(inventory.assignableTags).toEqual([]);
  expect(inventory.unknownSources).toEqual(["policy"]);
  expect(inventory.tags[0]).toMatchObject({
    tag: "tag:node-only",
    definition: "unknown",
  });
});

test("supported scalar, grouped, test-port and exit-node references retain their original locations", () => {
  const inventory = observeTags({
    policy: {
      policy: JSON.stringify({
        groups: { "group:ops": ["tag:grouped", "alice@"] },
        tests: [
          {
            src: "tag:source",
            accept: ["tag:target:22"],
            deny: ["tag:blocked:80"],
          },
        ],
        sshTests: [{ src: "tag:ssh", dst: ["tag:target"] }],
        nodeAttrs: [{ target: ["tag:target"], attr: [] }],
        autoApprovers: { exitNode: ["tag:router"] },
      }),
    },
    nodes: [],
    preAuthKeys: [],
  });
  expect(
    inventory.tags.find((entry) => entry.tag === "tag:grouped")?.referencePaths,
  ).toEqual(["groups.group:ops[0]"]);
  expect(
    inventory.tags.find((entry) => entry.tag === "tag:source")?.referencePaths,
  ).toEqual(["tests[0].src"]);
  expect(
    inventory.tags.find((entry) => entry.tag === "tag:target")?.referencePaths,
  ).toEqual([
    "nodeAttrs[0].target[0]",
    "tests[0].accept[0]",
    "sshTests[0].dst[0]",
  ]);
  expect(
    inventory.tags.find((entry) => entry.tag === "tag:router")?.referencePaths,
  ).toEqual(["autoApprovers.exitNode[0]"]);
});

test("malformed reference values remain unknown without inventing tag locations", () => {
  const inventory = observeTags({
    policy: {
      policy: JSON.stringify({
        ssh: [null, 1, { src: [42], dst: null }],
        autoApprovers: { routes: 3 },
      }),
    },
    nodes: [],
    preAuthKeys: [],
  });
  expect(inventory.unknownSources).toContain("references");
  expect(inventory.tags).toEqual([]);
});

test("reference paths point to original multi-destination ACL locations, not expanded editor rows", () => {
  const inventory = observeTags({
    policy: {
      policy:
        '{"acls":[{"action":"accept","src":["tag:src"],"dst":["tag:first:22","tag:second:443"]}]}',
    },
    nodes: [],
    preAuthKeys: [],
  });
  expect(
    inventory.tags.find((entry) => entry.tag === "tag:second")?.referencePaths,
  ).toEqual(["acls[0].dst[1]"]);
  expect(
    inventory.tags.find((entry) => entry.tag === "tag:src")?.referencePaths,
  ).toEqual(["acls[0].src[0]"]);
});

test("unmodeled ACL diagnostic paths also point to original readback positions and are not duplicated", () => {
  const inventory = observeTags({
    policy: {
      policy: JSON.stringify({
        acls: [
          { action: "accept", src: ["*"], dst: ["tag:x:22", "tag:x:443"] },
          {
            action: "accept",
            src: ["tag:x"],
            dst: ["*:80", "*:443"],
            futureOption: true,
          },
        ],
      }),
    },
    nodes: [],
    preAuthKeys: [],
  });
  expect(inventory.referenceIssues).toEqual(["acls[1].futureOption"]);
  expect(inventory.unknownSources).toContain("references");
});

test("ACL diagnostics map expanded destination zero to the original destination index while keeping source indices", () => {
  const inventory = observeTags({
    policy: {
      policy: JSON.stringify({
        acls: [
          {
            action: "accept",
            src: ["*"],
            dst: ["tag:valid:22", "tag:1abc:443"],
          },
          { action: "accept", src: ["tag:valid", "tag:2abc"], dst: ["*:80"] },
        ],
      }),
    },
    nodes: [],
    preAuthKeys: [],
  });
  expect(inventory.referenceIssues).toEqual([
    "acls[0].dst[1]",
    "acls[1].src[1]",
  ]);
  expect(
    inventory.tags.find((entry) => entry.tag === "tag:1abc")?.referencePaths,
  ).toEqual(["acls[0].dst[1]"]);
});

test("shared owner dependency DAG visits each edge once rather than expanding exponentially many paths", () => {
  const owners: Record<string, string[]> = { "tag:root": ["tag:a0", "tag:b0"] };
  for (let level = 0; level < 14; level++) {
    for (const side of ["a", "b"])
      owners[`tag:${side}${level}`] =
        level === 13 ? ["alice@"] : [`tag:a${level + 1}`, `tag:b${level + 1}`];
  }
  const dependencies = tagOwnerDependencies(
    parsePolicy(JSON.stringify({ tagOwners: owners })),
    "tag:root",
  );
  expect(dependencies).toHaveLength(56);
  expect(
    dependencies.some(
      (entry) => entry.path.slice(-2).join("/") === "tag:a5/tag:b6",
    ),
  ).toBe(true);
  expect(
    dependencies.some(
      (entry) => entry.path.slice(-2).join("/") === "tag:b5/tag:a6",
    ),
  ).toBe(true);
  expect(dependencies.some((entry) => entry.principal === "alice@")).toBe(true);
});

describe("registration and old deployment dependency are independent", () => {
  test.each([
    [{ reusable: true, used: true }, "available"],
    [{ reusable: false, used: true }, "exhausted"],
    [{ reusable: false, used: false }, "available"],
    [
      { reusable: true, used: true, expiration: "2020-01-01T00:00:00Z" },
      "expired",
    ],
    [
      { reusable: false, used: true, expiration: "2020-01-01T00:00:00Z" },
      "expired",
    ],
    [{ reusable: true, used: false, expiration: "unreadable" }, "unknown"],
  ] as const)(
    "classifies %j without hiding an existing deployment",
    (fields, registration) => {
      expect(
        registrationKeyStatus(fields, Date.parse("2026-10-18T00:00:00Z")),
      ).toEqual({
        registration,
        oldDeployment: "possible",
      });
    },
  );
  test("unknown is not a deletion, while a confirmed deletion blocks lookup rather than removing nodes", () => {
    expect(registrationKeyStatus(null)).toEqual({
      registration: "unknown",
      oldDeployment: "unknown",
    });
    expect(registrationKeyStatus(null, Date.now(), true)).toEqual({
      registration: "deleted",
      oldDeployment: "lookup-blocked",
    });
  });
});

test("set equality and replacement retain extra tags and do not duplicate an existing migration target", () => {
  expect(
    sameTagSet(["tag:old", "tag:extra"], ["tag:extra", "tag:old", "tag:old"]),
  ).toBe(true);
  expect(sameTagSet(["tag:old"], ["tag:new"])).toBe(false);
  expect(
    replaceTagInSet(
      ["tag:old", "tag:prod", "tag:extra"],
      "tag:old",
      "tag:prod",
    ),
  ).toEqual(["tag:prod", "tag:extra"]);
  expect(replaceTagInSet(["tag:extra"], "tag:missing", "tag:prod")).toEqual([
    "tag:extra",
  ]);
  expect(
    tagSetDiff(["tag:old", "tag:extra"], ["tag:prod", "tag:extra", "tag:prod"]),
  ).toEqual({
    added: ["tag:prod"],
    removed: ["tag:old"],
    unchanged: ["tag:extra"],
  });
});

test("node baseline binds identity and tags, not presence timestamps or display order", () => {
  const source = normalizeHeadscaleNode({
    id: "n1",
    name: "node",
    machineKey: "machine:public",
    user: { id: "u1", name: "alice" },
    tags: ["tag:x", "tag:y"],
    lastSeen: "yesterday",
  });
  const baseline = nodeTagBaseline(source);
  expect(baseline).toEqual({
    nodeId: "n1",
    machineKey: "machine:public",
    user: { id: "u1", name: "alice" },
    tags: ["tag:x", "tag:y"],
  });
  expect(
    sameNodeTagBaseline(
      baseline,
      nodeTagBaseline({
        ...source,
        online: true,
        lastSeen: "now",
        tags: ["tag:y", "tag:x"],
      }),
    ),
  ).toBe(true);
  expect(
    sameNodeTagBaseline(
      baseline,
      nodeTagBaseline({ ...source, user: { id: "u1", name: "renamed" } }),
    ),
  ).toBe(false);
  expect(
    sameNodeTagBaseline(
      baseline,
      nodeTagBaseline({ ...source, machineKey: "replacement" }),
    ),
  ).toBe(false);
  expect(nodeTagBaseline(node)).toMatchObject({ machineKey: null, user: null });
});

test("owner dependency paths keep direct, group, nested, cyclic and dangling relations distinct", () => {
  const policy = parsePolicy(
    JSON.stringify({
      groups: { "group:ops": ["alice@"] },
      tagOwners: {
        "tag:x": ["alice@", "group:ops", "tag:y", "group:missing"],
        "tag:y": ["bob@", "tag:x", "tag:missing"],
      },
    }),
  );
  const paths = tagOwnerDependencies(policy, "tag:x");
  expect(paths).toContainEqual({
    principal: "alice@",
    path: ["tag:x", "alice@"],
    kind: "direct",
    cycle: false,
    missing: false,
  });
  expect(paths).toContainEqual({
    principal: "alice@",
    path: ["tag:x", "group:ops", "alice@"],
    kind: "group",
    cycle: false,
    missing: false,
  });
  expect(paths).toContainEqual({
    principal: "bob@",
    path: ["tag:x", "tag:y", "bob@"],
    kind: "tag",
    cycle: false,
    missing: false,
  });
  expect(
    paths.some(
      (entry) => entry.cycle && entry.path.join("/") === "tag:x/tag:y/tag:x",
    ),
  ).toBe(true);
  expect(
    paths.some((entry) => entry.principal === "group:missing" && entry.missing),
  ).toBe(true);
  expect(
    paths.some((entry) => entry.principal === "tag:missing" && entry.missing),
  ).toBe(true);
  expect(tagOwnerDependencies(policy, "tag:absent")).toEqual([]);
});
