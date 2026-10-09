import { describe, expect, test } from "bun:test";
import {
  addMemberToGroup,
  addOwnerToTag,
  addRule,
  classifyMember,
  createGroup,
  createRule,
  createTagOwner,
  emptyState,
  findOrphanReferences,
  findReferencesToValues,
  joinCommaList,
  parseCommaList,
  parseMemberList,
  parsePolicy,
  removeGroupById,
  removeMemberFromGroup,
  removeOwnerFromTag,
  removeReferencesToValues,
  removeRuleById,
  removeTagOwnerById,
  serializePolicy,
  toMemberRef,
  upsertGroup,
  upsertTagOwner,
} from "./policy-designer";
import { PrincipalIndex } from "./principal";

function normalizeForCompare(input: Record<string, unknown>) {
  const clone: Record<string, unknown> = JSON.parse(JSON.stringify(input));
  for (const key of Object.keys(clone)) {
    const value = clone[key];
    if (Array.isArray(value)) {
      clone[key] = [...value].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    } else if (value && typeof value === "object") {
      clone[key] = Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, Array.isArray(v) ? [...v].sort() : v]),
      );
    }
  }
  return clone;
}

describe("parseCommaList / joinCommaList", () => {
  test("parseCommaList trims and drops empty entries", () => {
    expect(parseCommaList("22, 443 ,, 80")).toEqual(["22", "443", "80"]);
  });

  test("parseCommaList handles single value", () => {
    expect(parseCommaList("*")).toEqual(["*"]);
  });

  test("parseCommaList returns [] for empty string", () => {
    expect(parseCommaList("")).toEqual([]);
    expect(parseCommaList("   ")).toEqual([]);
  });

  test("parseCommaList keeps wildcard ports intact", () => {
    expect(parseCommaList("22, *, 80")).toEqual(["22", "*", "80"]);
  });

  test("joinCommaList trims and drops empty entries", () => {
    expect(joinCommaList(["22", " 443", "", "80"])).toBe("22,443,80");
  });

  test("joinCommaList returns empty string for empty input", () => {
    expect(joinCommaList([])).toBe("");
    expect(joinCommaList(["", "  "])).toBe("");
  });

  test("parseCommaList ↔ joinCommaList round trip", () => {
    const cases = ["22", "22,443", "alice@example.com,group:ops", "*"];
    for (const raw of cases) {
      expect(joinCommaList(parseCommaList(raw))).toBe(raw.replace(/\s/g, ""));
    }
  });
});

describe("classifyMember", () => {
  test("recognizes group prefix", () => {
    expect(classifyMember("group:ops")).toBe("group");
    expect(classifyMember("group:admins")).toBe("group");
  });

  test("recognizes tag prefix", () => {
    expect(classifyMember("tag:server")).toBe("tag");
  });

  test("recognizes host prefix", () => {
    expect(classifyMember("host:edge")).toBe("host");
  });

  test("recognizes email-like user identifiers", () => {
    expect(classifyMember("alice@example.com")).toBe("user");
    expect(classifyMember("alice@")).toBe("user");
    expect(classifyMember("bob+filter@corp.io")).toBe("user");
  });

  test("falls back to raw for everything else", () => {
    expect(classifyMember("*")).toBe("raw");
    expect(classifyMember("autogroup:internet")).toBe("raw");
    expect(classifyMember("100.64.0.0/16")).toBe("raw");
    expect(classifyMember("fd7a:115c::/48")).toBe("raw");
    expect(classifyMember("plain-name")).toBe("raw");
  });
});

describe("parseMemberList", () => {
  test("parses array of strings", () => {
    expect(parseMemberList(["alice@example.com", "group:ops"])).toEqual([
      { kind: "user", value: "alice@example.com" },
      { kind: "group", value: "group:ops" },
    ]);
  });

  test("parses comma-separated string", () => {
    expect(parseMemberList("alice@example.com, group:ops")).toEqual([
      { kind: "user", value: "alice@example.com" },
      { kind: "group", value: "group:ops" },
    ]);
  });

  test("filters empty entries", () => {
    expect(parseMemberList(["", " ", "alice@example.com"])).toEqual([
      { kind: "user", value: "alice@example.com" },
    ]);
  });

  test("returns empty for null/undefined/number", () => {
    expect(parseMemberList(null)).toEqual([]);
    expect(parseMemberList(undefined)).toEqual([]);
    expect(parseMemberList(42)).toEqual([]);
  });
});

describe("parsePolicy / serializePolicy round-trip", () => {
  const samples: Array<{ name: string; raw: unknown }> = [
    {
      name: "mock default policy with autoApprovers and ssh extras",
      raw: {
        acls: [{ action: "accept", src: ["*"], dst: ["*:*"] }],
        groups: { "group:ops": ["alice@example.com"] },
        tagOwners: { "tag:server": ["alice@"] },
        autoApprovers: { routes: { "10.42.0.0/16": ["alice@"] } },
        ssh: [{ action: "accept", src: ["group:ops"], dst: ["tag:server"], users: ["root"] }],
      },
    },
    {
      name: "empty policy",
      raw: {},
    },
    {
      name: "only acls, no groups",
      raw: {
        acls: [{ action: "accept", src: ["group:dev"], dst: ["tag:db:5432"] }],
      },
    },
    {
      name: "members include group: prefix references",
      raw: {
        groups: { "group:dev": ["group:ops", "alice@example.com"] },
      },
    },
    {
      name: "members include autogroup raw values",
      raw: {
        groups: { "group:wan": ["autogroup:internet", "bob@example.com"] },
      },
    },
    {
      name: "src includes CIDR ranges and wildcards",
      raw: {
        acls: [{ action: "accept", src: ["100.64.0.0/16", "*"], dst: ["tag:server:22"] }],
      },
    },
    {
      name: "unicode user emails",
      raw: {
        groups: { "group:ops": ["运维@corp.cn", "alice@example.com"] },
        tagOwners: { "tag:server": ["运维@corp.cn"] },
      },
    },
    {
      name: "members as string (legacy format)",
      raw: {
        groups: { "group:legacy": "alice@example.com, bob@example.com" },
      },
    },
    {
      name: "empty member arrays",
      raw: {
        groups: { "group:empty": [] },
        tagOwners: { "tag:empty": [] },
      },
    },
    {
      name: "multiple acl rules and groups",
      raw: {
        acls: [
          { action: "accept", src: ["group:ops"], dst: ["tag:server:22"] },
          { action: "accept", src: ["group:dev"], dst: ["tag:db:5432"] },
          { action: "accept", src: ["*"], dst: ["*:443"] },
        ],
        groups: {
          "group:ops": ["alice@example.com"],
          "group:dev": ["bob@example.com", "charlie@example.com"],
        },
        tagOwners: {
          "tag:server": ["group:ops"],
          "tag:db": ["group:ops", "group:dev"],
        },
      },
    },
    {
      name: "extras with deeply nested data preserved",
      raw: {
        groups: { "group:ops": ["alice@example.com"] },
        hosts: { "internal-host": "100.64.5.1" },
        nodeAttrs: [{ target: ["tag:server"], attr: ["funnel"] }],
      },
    },
    {
      name: "dst with no port separator",
      raw: {
        acls: [{ action: "accept", src: ["*"], dst: ["10.0.0.1"] }],
      },
    },
  ];

  for (const sample of samples) {
    test(`preserves data round-trip: ${sample.name}`, () => {
      const json = JSON.stringify(sample.raw);
      const state = parsePolicy(json);
      const serialized = serializePolicy(state);
      const reparsed = parsePolicy(JSON.stringify(serialized));
      const reserialized = serializePolicy(reparsed);

      expect(normalizeForCompare(serialized)).toEqual(normalizeForCompare(reserialized));
    });
  }

  test("preserves autoApprovers, ssh, hosts in extras", () => {
    const raw = JSON.stringify({
      acls: [{ action: "accept", src: ["*"], dst: ["*:*"] }],
      groups: {},
      tagOwners: {},
      autoApprovers: { routes: { "10.0.0.0/8": ["alice@"] } },
      ssh: [{ action: "accept", src: ["group:ops"], dst: ["tag:server"], users: ["root"] }],
      hosts: { "internal-host": "100.64.5.1" },
    });
    const state = parsePolicy(raw);
    const out = serializePolicy(state);

    expect(out.autoApprovers).toEqual({ routes: { "10.0.0.0/8": ["alice@"] } });
    expect(out.ssh).toEqual([
      { action: "accept", src: ["group:ops"], dst: ["tag:server"], users: ["root"] },
    ]);
    expect(out.hosts).toEqual({ "internal-host": "100.64.5.1" });
  });

  test("preserves all source, destination, and port combinations for mixed-port dst arrays", () => {
    const state = parsePolicy(
      JSON.stringify({
        acls: [
          {
            action: "accept",
            src: ["group:ops", "alice@"],
            dst: ["tag:web:80", "tag:ssh:22"],
          },
        ],
        hosts: { internal: "100.64.0.1" },
      }),
    );

    expect(serializePolicy(state)).toEqual({
      groups: {},
      tagOwners: {},
      acls: [
        {
          action: "accept",
          src: ["group:ops", "alice@"],
          dst: ["tag:web:80"],
        },
        {
          action: "accept",
          src: ["group:ops", "alice@"],
          dst: ["tag:ssh:22"],
        },
      ],
      hosts: { internal: "100.64.0.1" },
    });
  });

  test("keeps an explicit empty ACL empty after saving and reloading", () => {
    const state = parsePolicy(JSON.stringify({ acls: [], hosts: { server: "100.64.0.1" } }));

    expect(state.rules).toEqual([]);
    expect(serializePolicy(state)).toEqual({
      acls: [],
      groups: {},
      tagOwners: {},
      hosts: { server: "100.64.0.1" },
    });
    expect(parsePolicy(JSON.stringify(serializePolicy(state))).rules).toEqual([]);
  });

  test("does not restore the last deleted allow-all rule after saving and reloading", () => {
    const state = parsePolicy(
      JSON.stringify({ acls: [{ action: "accept", src: ["*"], dst: ["*:*"] }] }),
    );
    const withoutRule = removeRuleById(state, state.rules[0].id);
    const saved = serializePolicy(withoutRule);

    expect(saved.acls).toEqual([]);
    expect(parsePolicy(JSON.stringify(saved)).rules).toEqual([]);
  });

  test("invalid JSON returns empty state with default rule", () => {
    const state = parsePolicy("not-valid-json-{");
    expect(state.groups).toEqual([]);
    expect(state.tagOwners).toEqual([]);
    expect(state.extras).toEqual({});
    expect(state.rules).toHaveLength(1);
    expect(state.rules[0]).toMatchObject({ source: "*", destination: "*", ports: "*" });
  });

  test("empty raw string returns empty state", () => {
    const state = parsePolicy("");
    expect(state.groups).toEqual([]);
    expect(state.rules).toHaveLength(1);
  });

  test("array root JSON does not throw, falls back to empty state", () => {
    const state = parsePolicy("[]");
    expect(state.groups).toEqual([]);
    expect(state.rules).toHaveLength(1);
  });

  test("rules with missing dst port default to *", () => {
    const state = parsePolicy(
      JSON.stringify({ acls: [{ action: "accept", src: ["*"], dst: ["10.0.0.1"] }] }),
    );
    expect(state.rules[0]?.destination).toBe("10.0.0.1");
    expect(state.rules[0]?.ports).toBe("*");
  });

  test("normalizes malformed ACL containers and scalar fields", () => {
    const state = parsePolicy(
      JSON.stringify({
        acls: [{ src: "group:testers", dst: "tag:service:443" }, { src: 42, dst: [] }, null],
        groups: [],
        tagOwners: "invalid",
      }),
    );

    expect(
      state.rules.map(({ source, destination, ports }) => ({ source, destination, ports })),
    ).toEqual([
      { source: "group:testers", destination: "tag:service", ports: "443" },
      { source: "*", destination: "*", ports: "*" },
      { source: "*", destination: "*", ports: "*" },
    ]);
    expect(state.groups).toEqual([]);
    expect(state.tagOwners).toEqual([]);
  });

  test("serializes blank rule fields with wildcard defaults", () => {
    const state = emptyState();
    state.rules = [{ ...state.rules[0], source: "", destination: "", ports: "  " }];

    expect(serializePolicy(state).acls).toEqual([{ action: "accept", src: [], dst: ["*:*"] }]);
  });

  test("allocates deterministic fallback IDs when Web Crypto is unavailable", () => {
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
    try {
      const first = createGroup("group:first").id;
      const second = createTagOwner("tag:second").id;
      expect(first).toStartWith("policy-");
      expect(second).toStartWith("policy-");
      expect(second).not.toBe(first);
    } finally {
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });
    }
  });
});

describe("mutators", () => {
  test("addMemberToGroup is idempotent", () => {
    const state = emptyState();
    const group = createGroup("group:ops");
    const withGroup = upsertGroup(state, group);
    const member = toMemberRef("alice@example.com");

    const once = addMemberToGroup(withGroup, group.id, member);
    const twice = addMemberToGroup(once, group.id, member);

    expect(once.groups[0]?.members).toHaveLength(1);
    expect(twice.groups[0]?.members).toHaveLength(1);
  });

  test("removeMemberFromGroup removes by value", () => {
    let state = emptyState();
    const group = createGroup("group:ops", [
      toMemberRef("alice@example.com"),
      toMemberRef("bob@example.com"),
    ]);
    state = upsertGroup(state, group);
    state = removeMemberFromGroup(state, group.id, "alice@example.com");

    expect(state.groups[0]?.members).toEqual([{ kind: "user", value: "bob@example.com" }]);
  });

  test("addOwnerToTag and removeOwnerFromTag", () => {
    let state = emptyState();
    const tag = createTagOwner("tag:server");
    state = upsertTagOwner(state, tag);

    state = addOwnerToTag(state, tag.id, toMemberRef("group:ops"));
    state = addOwnerToTag(state, tag.id, toMemberRef("alice@example.com"));
    expect(state.tagOwners[0]?.owners).toHaveLength(2);

    state = removeOwnerFromTag(state, tag.id, "group:ops");
    expect(state.tagOwners[0]?.owners).toEqual([{ kind: "user", value: "alice@example.com" }]);
  });

  test("upsertGroup replaces by name (existing behavior)", () => {
    let state = emptyState();
    const a = createGroup("group:ops", [toMemberRef("alice@example.com")]);
    const b = createGroup("group:ops", [toMemberRef("bob@example.com")]);
    state = upsertGroup(state, a);
    state = upsertGroup(state, b);

    expect(state.groups).toHaveLength(1);
    expect(state.groups[0]?.members[0]?.value).toBe("bob@example.com");
  });

  test("upsertGroup ignores empty names", () => {
    const state = emptyState();
    const next = upsertGroup(state, createGroup("  "));
    expect(next.groups).toHaveLength(0);
  });

  test("upsertTagOwner replaces by tag name", () => {
    let state = emptyState();
    state = upsertTagOwner(state, createTagOwner("tag:server", [toMemberRef("group:ops")]));
    state = upsertTagOwner(state, createTagOwner("tag:server", [toMemberRef("group:dev")]));

    expect(state.tagOwners).toHaveLength(1);
    expect(state.tagOwners[0]?.owners[0]?.value).toBe("group:dev");
  });

  test("upsertTagOwner ignores empty tag", () => {
    const state = emptyState();
    const next = upsertTagOwner(state, createTagOwner("   "));
    expect(next.tagOwners).toHaveLength(0);
  });

  test("addRule appends a rule and removeRuleById removes it", () => {
    const state = emptyState();
    const rule = createRule("group:ops", "tag:server", "22");
    const withRule = addRule(state, rule);
    expect(withRule.rules.some((r) => r.id === rule.id)).toBe(true);

    const without = removeRuleById(withRule, rule.id);
    expect(without.rules.some((r) => r.id === rule.id)).toBe(false);
  });

  test("createRule defaults empty fields to *", () => {
    const rule = createRule("", "", "");
    expect(rule.source).toBe("*");
    expect(rule.destination).toBe("*");
    expect(rule.ports).toBe("*");
    expect(rule.action).toBe("accept");
    expect(rule.id).toBeDefined();
  });

  test("createGroup and createTagOwner allocate unique ids", () => {
    const a = createGroup("group:a");
    const b = createGroup("group:b");
    expect(a.id).not.toBe(b.id);

    const t1 = createTagOwner("tag:x");
    const t2 = createTagOwner("tag:y");
    expect(t1.id).not.toBe(t2.id);
  });

  test("non-matching mutators preserve sibling containers", () => {
    const group = createGroup("group:testers", [toMemberRef("user@example.test")]);
    const tagOwner = createTagOwner("tag:service", [toMemberRef("group:testers")]);
    let state = upsertGroup(emptyState(), group);
    state = upsertTagOwner(state, tagOwner);

    const memberResult = removeMemberFromGroup(state, "missing-group", "user@example.test");
    const addOwnerResult = addOwnerToTag(state, "missing-tag", toMemberRef("other@example.test"));
    const ownerResult = removeOwnerFromTag(state, "missing-tag", "group:testers");

    expect(memberResult.groups[0]).toBe(state.groups[0]);
    expect(addOwnerResult.tagOwners[0]).toBe(state.tagOwners[0]);
    expect(ownerResult.tagOwners[0]).toBe(state.tagOwners[0]);
  });

  test("removes groups and tag owners by ID without touching siblings", () => {
    const keepGroup = createGroup("group:keep");
    const removeGroup = createGroup("group:remove");
    const keepTag = createTagOwner("tag:keep");
    const removeTag = createTagOwner("tag:remove");
    let state = upsertGroup(emptyState(), keepGroup);
    state = upsertGroup(state, removeGroup);
    state = upsertTagOwner(state, keepTag);
    state = upsertTagOwner(state, removeTag);

    state = removeGroupById(state, removeGroup.id);
    state = removeTagOwnerById(state, removeTag.id);

    expect(state.groups).toEqual([keepGroup]);
    expect(state.tagOwners).toEqual([keepTag]);
  });
});

describe("references", () => {
  test("findReferencesToValues locates groups and tagOwners", () => {
    let state = emptyState();
    const ops = createGroup("group:ops", [toMemberRef("alice@example.com")]);
    const dev = createGroup("group:dev", [toMemberRef("bob@example.com")]);
    state = upsertGroup(state, ops);
    state = upsertGroup(state, dev);
    state = upsertTagOwner(state, createTagOwner("tag:server", [toMemberRef("alice@example.com")]));

    const refs = findReferencesToValues(state, ["alice@example.com"]);
    expect(refs.groupNames).toContain("group:ops");
    expect(refs.groupNames).not.toContain("group:dev");
    expect(refs.tagNames).toContain("tag:server");
  });

  test("removeReferencesToValues sweeps all containers", () => {
    let state = emptyState();
    state = upsertGroup(
      state,
      createGroup("group:ops", [toMemberRef("alice@example.com"), toMemberRef("bob@example.com")]),
    );
    state = upsertTagOwner(state, createTagOwner("tag:server", [toMemberRef("alice@example.com")]));

    state = removeReferencesToValues(state, ["alice@example.com"]);

    expect(state.groups[0]?.members.map((m) => m.value)).toEqual(["bob@example.com"]);
    expect(state.tagOwners[0]?.owners).toEqual([]);
  });

  test("removeReferencesToValues with empty list is identity", () => {
    const state = upsertGroup(
      emptyState(),
      createGroup("group:ops", [toMemberRef("alice@example.com")]),
    );
    const next = removeReferencesToValues(state, []);
    expect(next).toBe(state);
  });
});

describe("findOrphanReferences", () => {
  test("flags user members not in known principals", () => {
    let state = emptyState();
    state = upsertGroup(
      state,
      createGroup("group:ops", [
        toMemberRef("alice@example.com"),
        toMemberRef("ghost@example.com"),
      ]),
    );

    const orphans = findOrphanReferences(state, new PrincipalIndex(["alice@example.com"]));
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.value).toBe("ghost@example.com");
    expect(orphans[0]?.kind).toBe("group-member");
  });

  test("flags group references that no longer exist", () => {
    let state = emptyState();
    state = upsertTagOwner(state, createTagOwner("tag:server", [toMemberRef("group:nonexistent")]));

    const orphans = findOrphanReferences(state, new PrincipalIndex([]));
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.value).toBe("group:nonexistent");
    expect(orphans[0]?.kind).toBe("tag-owner");
  });

  test("reports every stale reference kind in groups and tag owners", () => {
    let state = emptyState();
    state = upsertGroup(state, createGroup("group:testers", [toMemberRef("group:missing")]));
    state = upsertTagOwner(
      state,
      createTagOwner("tag:service", [
        toMemberRef("missing@example.test"),
        toMemberRef("missing-user"),
      ]),
    );

    expect(findOrphanReferences(state, new PrincipalIndex([])).map((item) => item.kind)).toEqual([
      "group-member",
      "tag-owner",
      "tag-owner",
    ]);
  });

  test("ignores raw entries (autogroup, CIDR, wildcards)", () => {
    let state = emptyState();
    state = upsertGroup(
      state,
      createGroup("group:wan", [
        toMemberRef("autogroup:internet"),
        toMemberRef("100.64.0.0/16"),
        toMemberRef("*"),
      ]),
    );

    expect(findOrphanReferences(state, new PrincipalIndex([]))).toEqual([]);
  });

  test("returns empty when all members are known", () => {
    let state = emptyState();
    state = upsertGroup(state, createGroup("group:ops", [toMemberRef("alice@example.com")]));
    state = upsertTagOwner(state, createTagOwner("tag:server", [toMemberRef("group:ops")]));

    expect(findOrphanReferences(state, new PrincipalIndex(["alice@example.com"]))).toEqual([]);
  });

  test("flags case differences between principals and known users", () => {
    let state = emptyState();
    state = upsertGroup(state, createGroup("group:ops", [toMemberRef("  Alice@Example.COM  ")]));
    expect(findOrphanReferences(state, new PrincipalIndex(["alice@example.com"]))).toHaveLength(1);
  });

  test("flags bare username (no @) when not in known principals", () => {
    let state = emptyState();
    state = upsertGroup(state, createGroup("group:ops", [toMemberRef("alice")]));

    const orphans = findOrphanReferences(state, new PrincipalIndex([]));
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.value).toBe("alice");
    expect(orphans[0]?.kind).toBe("group-member");
  });

  test("accepts bare username when matched against known user.name", () => {
    let state = emptyState();
    state = upsertGroup(state, createGroup("group:ops", [toMemberRef("alice")]));
    expect(findOrphanReferences(state, new PrincipalIndex(["alice"]))).toEqual([]);
  });

  test("does not flag CIDR or wildcard as orphan even when treated as raw", () => {
    let state = emptyState();
    state = upsertTagOwner(
      state,
      createTagOwner("tag:server", [toMemberRef("10.0.0.0/8"), toMemberRef("*")]),
    );
    expect(findOrphanReferences(state, new PrincipalIndex([]))).toEqual([]);
  });

  test("flags hostname-shaped bare strings as orphan (documented trade-off)", () => {
    // A value like "myhost" that doesn't carry a host:/group:/tag: prefix and
    // isn't a CIDR cannot be distinguished from a typo'd username; if it
    // doesn't match a known principal we report it so the operator can fix it.
    let state = emptyState();
    state = upsertGroup(state, createGroup("group:ops", [toMemberRef("myhost")]));
    expect(findOrphanReferences(state, new PrincipalIndex([]))).toHaveLength(1);
  });
});
