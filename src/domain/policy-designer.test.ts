import { describe, expect, test } from "vitest";
import { addRule } from "@/test/policy-state";
import {
  addMemberToGroup,
  addMemberToGroupByName,
  addOwnerToTag,
  classifyMember,
  createGroup,
  createRule,
  createTagOwner,
  emptyState,
  findOrphanReferences,
  isPolicyIdentityName,
  joinCommaList,
  parseCommaList,
  parseMemberList,
  parsePolicy,
  removeMemberFromGroup,
  removeMemberFromGroupByName,
  removeOrphanReferences,
  removeOwnerFromTag,
  removeOwnerFromTagByName,
  removeRuleById,
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

  test.each([
    {
      name: "restricted grants",
      grants: [{ src: ["alice@"], dst: ["tag:server"], ip: ["tcp:443"] }],
    },
    { name: "explicit empty grants", grants: [] },
  ])("does not add allow-all ACLs to $name when saving", ({ grants }) => {
    const state = parsePolicy(JSON.stringify({ grants }));
    const saved = serializePolicy(state);

    expect(state.rules).toEqual([]);
    expect(saved.acls ?? []).toEqual([]);
    expect(saved.grants).toEqual(grants);
    expect(parsePolicy(JSON.stringify(saved)).rules).toEqual([]);
  });

  test.each(["", "{}", '{"acls":null}', '{"grants":null}'])(
    "represents default access with all IPv4 and IPv6 addresses when saving %j",
    (raw) => {
      const state = parsePolicy(raw);
      const saved = serializePolicy(state);

      expect(state.rules).toHaveLength(1);
      expect(saved.acls).toEqual([
        { action: "accept", src: ["0.0.0.0/0", "::/0"], dst: ["0.0.0.0/0:*"] },
        { action: "accept", src: ["0.0.0.0/0", "::/0"], dst: ["::/0:*"] },
      ]);
      expect(parsePolicy(JSON.stringify(saved)).rules).toHaveLength(2);
    },
  );

  test("keeps default access while editing only groups", () => {
    const state = upsertGroup(parsePolicy("{}"), createGroup("group:ops", [toMemberRef("alice@")]));
    const saved = serializePolicy(state);

    expect(saved.groups).toEqual({ "group:ops": ["alice@"] });
    expect(saved.acls).toEqual(serializePolicy(emptyState()).acls);
  });

  test("keeps all-address default access when adding a second rule", () => {
    const state = addRule(parsePolicy("{}"), createRule("alice@", "tag:server", "443"));
    expect(serializePolicy(state).acls).toEqual([
      { action: "accept", src: ["0.0.0.0/0", "::/0"], dst: ["0.0.0.0/0:*"] },
      { action: "accept", src: ["0.0.0.0/0", "::/0"], dst: ["::/0:*"] },
      { action: "accept", src: ["alice@"], dst: ["tag:server:443"] },
    ]);
  });

  test("keeps an existing explicit wildcard ACL unchanged", () => {
    const acls = [{ action: "accept", src: ["*"], dst: ["*:*"] }];
    expect(serializePolicy(parsePolicy(JSON.stringify({ acls }))).acls).toEqual(acls);
  });

  test("keeps a newly added multi-destination rule stable after saving and reloading", () => {
    const state = addRule(parsePolicy("{}"), createRule("alice@", "tag:server, tag:db", "443"));
    const saved = serializePolicy(state);

    expect(serializePolicy(parsePolicy(JSON.stringify(saved)))).toEqual(saved);
    expect(saved.acls).toEqual([
      { action: "accept", src: ["0.0.0.0/0", "::/0"], dst: ["0.0.0.0/0:*"] },
      { action: "accept", src: ["0.0.0.0/0", "::/0"], dst: ["::/0:*"] },
      { action: "accept", src: ["alice@"], dst: ["tag:server:443"] },
      { action: "accept", src: ["alice@"], dst: ["tag:db:443"] },
    ]);
  });

  test("preserves grants and other extra sections after deleting the last ACL", () => {
    const extras = {
      grants: [{ src: ["alice@"], dst: ["tag:server"], ip: ["tcp:443"] }],
      nodeAttrs: [{ target: ["alice@"], attr: ["randomize-client-port"] }],
    };
    const state = parsePolicy(
      JSON.stringify({
        ...extras,
        acls: [{ action: "accept", src: ["*"], dst: ["*:*"] }],
      }),
    );
    const saved = serializePolicy(removeRuleById(state, state.rules[0].id));

    expect(saved).toMatchObject({ ...extras, acls: [] });
    expect(parsePolicy(JSON.stringify(saved)).rules).toEqual([]);
  });

  test("serializes edits to the default rule", () => {
    const state = parsePolicy("{}");
    state.rules[0].ports = "443";

    expect(serializePolicy(state).acls).toEqual([
      { action: "accept", src: ["0.0.0.0/0", "::/0"], dst: ["0.0.0.0/0:443"] },
      { action: "accept", src: ["0.0.0.0/0", "::/0"], dst: ["::/0:443"] },
    ]);
  });

  test("deleting the default denies access instead of restoring defaults", () => {
    const state = parsePolicy("{}");
    const saved = serializePolicy(removeRuleById(state, state.rules[0].id));

    expect(saved.acls).toEqual([]);
    expect(parsePolicy(JSON.stringify(saved)).rules).toEqual([]);
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

  test("invalid JSON cannot be saved as a default allow-all policy", () => {
    const state = parsePolicy("not-valid-json-{");
    expect(state.groups).toEqual([]);
    expect(state.tagOwners).toEqual([]);
    expect(state.extras).toEqual({});
    expect(state.rules).toEqual([]);
    expect(state.error).toEqual(expect.any(String));
    expect(() => serializePolicy(state)).toThrow();
  });

  test("empty raw string returns empty state", () => {
    const state = parsePolicy("");
    expect(state.groups).toEqual([]);
    expect(state.rules).toHaveLength(1);
  });

  test("array root JSON is read-only instead of falling back to default access", () => {
    const state = parsePolicy("[]");
    expect(state.groups).toEqual([]);
    expect(state.rules).toEqual([]);
    expect(() => serializePolicy(state)).toThrow();
  });

  test("rules with missing dst ports cannot be widened to all ports", () => {
    const state = parsePolicy(
      JSON.stringify({ acls: [{ action: "accept", src: ["*"], dst: ["10.0.0.1"] }] }),
    );
    expect(state.rules).toEqual([]);
    expect(() => serializePolicy(state)).toThrow();
  });

  test("malformed ACL containers and scalar fields cannot be normalized into grants", () => {
    const state = parsePolicy(
      JSON.stringify({
        acls: [{ src: "group:testers", dst: "tag:service:443" }, { src: 42, dst: [] }, null],
        groups: [],
        tagOwners: "invalid",
      }),
    );

    expect(state.rules).toEqual([]);
    expect(state.groups).toEqual([]);
    expect(state.tagOwners).toEqual([]);
    expect(() => serializePolicy(state)).toThrow();
  });

  test("refuses to widen blank edited rule fields to wildcard destinations", () => {
    const state = emptyState();
    state.rules = [{ ...state.rules[0], source: "", destination: "", ports: "  " }];

    expect(() => serializePolicy(state)).toThrow();
  });

  test("allocates deterministic fallback IDs when Web Crypto is unavailable", () => {
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
    try {
      const first = createGroup("group:first").id;
      const second = createTagOwner("tag:second").id;
      expect(first).toMatch(/^policy-/);
      expect(second).toMatch(/^policy-/);
      expect(second).not.toBe(first);
    } finally {
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });
    }
  });
});

describe("policy parsing safety", () => {
  test("treats prototype-looking keys as preserved JSON data, never inherited policy sections", () => {
    const raw = `{
      "__proto__": { "acls": [{ "action": "accept", "src": ["*"], "dst": ["*:*"] }] },
      "acls": [{
        "action": "accept", "src": ["alice@"], "dst": ["tag:server:443"],
        "__proto__": { "proto": "tcp" },
        "metadata": { "__proto__": { "nested": true } }
      }]
    }`;
    const saved = serializePolicy(parsePolicy(raw));

    expect(saved).toEqual({ ...JSON.parse(raw), groups: {}, tagOwners: {} });
    expect(Object.hasOwn(saved, "__proto__")).toBe(true);
  });

  test("accepts HuJSON comments and trailing commas without changing strings", () => {
    const state = parsePolicy(`{
      // Restricted service access.
      "acls": [{ "action": "accept", "src": ["alice@",], "dst": ["tag:server:443",], },],
      /* Unknown sections must survive serialization. */
      "metadata": { "url": "https://example.test/a//b", "text": "/* literal */", },
    }`);

    expect(state.error).toBeUndefined();
    expect(serializePolicy(state)).toEqual({
      acls: [{ action: "accept", src: ["alice@"], dst: ["tag:server:443"] }],
      groups: {},
      tagOwners: {},
      metadata: { url: "https://example.test/a//b", text: "/* literal */" },
    });
  });

  test.each([
    '{"acls":[]} trailing-data',
    '{"acls":[], "groups":',
    '{"acls":[] /* unfinished',
    '{"acls":[,]}',
    "{'acls':[]}",
    "{acls:[]}",
    "null",
    "false",
    "42",
    '"policy"',
  ])("refuses partial or non-object parsing of %s", (raw) => {
    const state = parsePolicy(raw);

    expect(state.error).toEqual(expect.any(String));
    expect(state.rules).toEqual([]);
    expect(state.groups).toEqual([]);
    expect(state.tagOwners).toEqual([]);
    expect(() => serializePolicy(state)).toThrow();
    expect(() =>
      serializePolicy(addRule(state, createRule("alice@", "tag:server", "443"))),
    ).toThrow();
  });

  test.each([
    { acls: {} },
    { acls: [null] },
    { acls: [[]] },
    { acls: [{ action: "deny", src: ["alice@"], dst: ["*:*"] }] },
    { acls: [{ src: ["alice@"], dst: ["*:*"] }] },
    { acls: [{ action: "accept", src: [], dst: ["*:*"] }] },
    { acls: [{ action: "accept", src: [""], dst: ["*:*"] }] },
    { acls: [{ action: "accept", src: [1], dst: ["*:*"] }] },
    { acls: [{ action: "accept", src: ["alice@,bob@"], dst: ["*:*"] }] },
    { acls: [{ action: "accept", src: "alice@", dst: ["*:*"] }] },
    { acls: [{ action: "accept", src: ["alice@"], dst: [] }] },
    { acls: [{ action: "accept", src: ["alice@"], dst: [""] }] },
    { acls: [{ action: "accept", src: ["alice@"], dst: [42] }] },
    { acls: [{ action: "accept", src: ["alice@"], dst: "*:443" }] },
    { acls: [{ action: "accept", src: ["alice@"], dst: ["tag:server:"] }] },
    { acls: [{ action: "accept", src: ["alice@"], dst: ["tag:server,tag:db:443"] }] },
    { groups: [] },
    { groups: { "group:ops": "alice@,bob@" } },
    { groups: { "group:ops": [1] } },
    { tagOwners: "alice@" },
    { tagOwners: { "tag:server": [false] } },
    { grants: {} },
  ])("makes unsafe-to-model policy data read-only: %j", (raw) => {
    const state = parsePolicy(JSON.stringify(raw));

    expect(state.error).toEqual(expect.any(String));
    expect(state.rules).toEqual([]);
    expect(state.groups).toEqual([]);
    expect(state.tagOwners).toEqual([]);
    expect(() => serializePolicy(state)).toThrow();
  });

  test("preserves ACL extension fields on every split destination", () => {
    const state = parsePolicy(
      JSON.stringify({
        acls: [
          {
            action: "accept",
            src: ["group:ops", "alice@"],
            dst: ["tag:web:443", "tag:ssh:22"],
            proto: "tcp",
            srcPosture: ["posture:managed"],
            extension: { disabled: false, count: 0, value: null, nested: [["literal"]] },
          },
        ],
      }),
    );

    expect(serializePolicy(state).acls).toEqual([
      {
        action: "accept",
        src: ["group:ops", "alice@"],
        dst: ["tag:web:443"],
        proto: "tcp",
        srcPosture: ["posture:managed"],
        extension: { disabled: false, count: 0, value: null, nested: [["literal"]] },
      },
      {
        action: "accept",
        src: ["group:ops", "alice@"],
        dst: ["tag:ssh:22"],
        proto: "tcp",
        srcPosture: ["posture:managed"],
        extension: { disabled: false, count: 0, value: null, nested: [["literal"]] },
      },
    ]);
  });

  test("member changes retain protocol and posture restrictions", () => {
    let state = parsePolicy(
      JSON.stringify({
        groups: { "group:ops": ["alice@", "bob@"] },
        tagOwners: { "tag:server": ["group:ops"] },
        acls: [
          {
            action: "accept",
            src: ["group:ops", "alice@"],
            dst: ["tag:server:443"],
            proto: "tcp",
            srcPosture: ["posture:managed"],
          },
        ],
      }),
    );

    state = addMemberToGroup(state, state.groups[0].id, toMemberRef("carol@"));

    expect(serializePolicy(state)).toEqual({
      groups: { "group:ops": ["alice@", "bob@", "carol@"] },
      tagOwners: { "tag:server": ["group:ops"] },
      acls: [
        {
          action: "accept",
          src: ["group:ops", "alice@"],
          dst: ["tag:server:443"],
          proto: "tcp",
          srcPosture: ["posture:managed"],
        },
      ],
    });
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

  test("upsertGroup cannot replace another group with the same name", () => {
    let state = emptyState();
    const a = createGroup("group:ops", [toMemberRef("alice@example.com")]);
    const b = createGroup("group:ops", [toMemberRef("bob@example.com")]);
    state = upsertGroup(state, a);
    expect(upsertGroup(state, b)).toBe(state);
    state = upsertGroup(state, b);

    expect(state.groups).toHaveLength(1);
    expect(state.groups[0]?.id).toBe(a.id);
    expect(state.groups[0]?.members[0]?.value).toBe("alice@example.com");
  });

  test("upsertGroup ignores empty names", () => {
    const state = emptyState();
    const next = upsertGroup(state, createGroup("  "));
    expect(next).toBe(state);
    expect(next.groups).toHaveLength(0);
  });

  test("upsertTagOwner cannot replace another definition with the same tag", () => {
    let state = emptyState();
    state = upsertTagOwner(state, createTagOwner("tag:server", [toMemberRef("group:ops")]));
    expect(upsertTagOwner(state, createTagOwner("tag:server", [toMemberRef("group:dev")]))).toBe(
      state,
    );
    state = upsertTagOwner(state, createTagOwner("tag:server", [toMemberRef("group:dev")]));

    expect(state.tagOwners).toHaveLength(1);
    expect(state.tagOwners[0]?.owners[0]?.value).toBe("group:ops");
  });

  test("upsertTagOwner ignores empty tag", () => {
    const state = emptyState();
    const next = upsertTagOwner(state, createTagOwner("   "));
    expect(next).toBe(state);
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

    const addMemberResult = addMemberToGroup(
      state,
      "missing-group",
      toMemberRef("other@example.test"),
    );
    const memberResult = removeMemberFromGroup(state, "missing-group", "user@example.test");
    const addOwnerResult = addOwnerToTag(state, "missing-tag", toMemberRef("other@example.test"));
    const ownerResult = removeOwnerFromTag(state, "missing-tag", "group:testers");

    expect(addMemberResult.groups[0]).toBe(state.groups[0]);
    expect(memberResult.groups[0]).toBe(state.groups[0]);
    expect(addOwnerResult.tagOwners[0]).toBe(state.tagOwners[0]);
    expect(ownerResult.tagOwners[0]).toBe(state.tagOwners[0]);
  });
});

describe("name-keyed mutators", () => {
  const member = toMemberRef("bob@");
  function setup() {
    const group = createGroup("group:ops", [toMemberRef("alice@")]);
    const tagOwner = createTagOwner("tag:server", [toMemberRef("alice@"), toMemberRef("bob@")]);
    return upsertTagOwner(upsertGroup(emptyState(), group), tagOwner);
  }

  test("addMemberToGroupByName appends once and keeps the other groups", () => {
    const state = upsertGroup(setup(), createGroup("group:dev", []));
    const added = addMemberToGroupByName(state, "group:ops", member);
    expect(added.groups.map((g) => g.members.map((m) => m.value))).toEqual([
      ["alice@", "bob@"],
      [],
    ]);
    expect(addMemberToGroupByName(added, "group:ops", member).groups[0]?.members).toHaveLength(2);
  });

  test("removeMemberFromGroupByName removes by value", () => {
    const state = addMemberToGroupByName(setup(), "group:ops", member);
    expect(removeMemberFromGroupByName(state, "group:ops", "alice@").groups[0]?.members).toEqual([
      member,
    ]);
  });

  test("removeOwnerFromTagByName removes by value", () => {
    expect(removeOwnerFromTagByName(setup(), "tag:server", "alice@").tagOwners[0]?.owners).toEqual([
      member,
    ]);
  });

  test("an unknown group or label leaves the state untouched", () => {
    const state = setup();
    expect(addMemberToGroupByName(state, "group:gone", member)).toBe(state);
    expect(removeMemberFromGroupByName(state, "group:gone", "alice@")).toBe(state);
    expect(removeOwnerFromTagByName(state, "tag:gone", "alice@")).toBe(state);
  });

  test("a group or label the editor cannot define is left unchanged", () => {
    // parsePolicy accepts these names; upsertGroup/upsertTagOwner refuse to rewrite them.
    const state = parsePolicy(
      JSON.stringify({
        groups: { "group:a:b": ["alice@"] },
        tagOwners: { "tag:1x": ["alice@"] },
      }),
    );
    expect(addMemberToGroupByName(state, "group:a:b", member)).toBe(state);
    expect(removeMemberFromGroupByName(state, "group:a:b", "alice@")).toBe(state);
    expect(removeOwnerFromTagByName(state, "tag:1x", "alice@")).toBe(state);
  });
});

describe("removeOrphanReferences", () => {
  const known = new PrincipalIndex(["alice@example.com"]);

  test("drops reported references and keeps everything else", () => {
    const state = parsePolicy(
      JSON.stringify({
        groups: {
          "group:ops": ["alice@example.com", "gone@example.com", "group:missing"],
          "group:dev": ["alice@example.com"],
        },
        tagOwners: { "tag:server": ["group:ops", "gone@example.com"] },
        hosts: { office: "10.0.0.0/8" },
      }),
    );
    const next = removeOrphanReferences(state, findOrphanReferences(state, known));
    expect(serializePolicy(next)).toMatchObject({
      groups: { "group:ops": ["alice@example.com"], "group:dev": ["alice@example.com"] },
      tagOwners: { "tag:server": ["group:ops"] },
      hosts: { office: "10.0.0.0/8" },
    });
    expect(findOrphanReferences(next, known)).toEqual([]);
  });

  test("only removes the value from the container that reported it", () => {
    const state = parsePolicy(
      JSON.stringify({
        groups: { "group:ops": ["gone@example.com"], "group:dev": ["gone@example.com"] },
        tagOwners: { "tag:server": ["gone@example.com"] },
      }),
    );
    const [first] = findOrphanReferences(state, known);
    if (!first) throw new Error("Missing orphan fixture");
    const next = removeOrphanReferences(state, [first]);
    expect(next.groups.map((g) => g.members.length)).toEqual([0, 1]);
    expect(next.tagOwners[0]?.owners).toHaveLength(1);
  });

  test("an empty report changes nothing", () => {
    const state = parsePolicy(JSON.stringify({ groups: { "group:ops": ["gone@example.com"] } }));
    expect(serializePolicy(removeOrphanReferences(state, []))).toEqual(serializePolicy(state));
  });

  test("also cleans entries whose names the editor cannot define", () => {
    const state = parsePolicy(
      JSON.stringify({
        groups: { "group:a:b": ["gone@example.com", "alice@example.com"] },
        tagOwners: { "tag:1x": ["gone@example.com"] },
      }),
    );
    const next = removeOrphanReferences(state, findOrphanReferences(state, known));
    expect(serializePolicy(next)).toMatchObject({
      groups: { "group:a:b": ["alice@example.com"] },
      tagOwners: { "tag:1x": [] },
    });
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

  test("does not flag blank or bare IPv4 entries as orphan users", () => {
    let state = emptyState();
    state = upsertGroup(
      state,
      createGroup("group:raw", [toMemberRef(""), toMemberRef("100.64.0.7")]),
    );

    expect(findOrphanReferences(state, new PrincipalIndex([]))).toEqual([]);
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

describe("isPolicyIdentityName", () => {
  test.each([
    ["group:ops", "group"],
    ["group:dev_ops", "group"],
    ["group:研发", "group"],
    ["tag:server", "tag"],
    ["tag:k8s_node", "tag"],
    ["tag:ci.runner-2", "tag"],
    ["tag:Web1", "tag"],
    ["tag:web-服务", "tag"],
  ] as const)("accepts %s as a %s", (name, kind) => {
    expect(isPolicyIdentityName(name, kind)).toBe(true);
  });

  test.each([
    ["group:", "group"],
    ["group:a b", "group"],
    ["group:a,b", "group"],
    ["group:a:b", "group"],
    ["group:a@b", "group"],
    ["ops", "group"],
    ["tag:ops", "group"],
    ["tag:", "tag"],
    ["tag:1abc", "tag"],
    ["tag:-x", "tag"],
    ["tag:_x", "tag"],
    ["tag:ü", "tag"],
    ["tag:a b", "tag"],
    ["tag:a,b", "tag"],
    ["tag:a@b", "tag"],
    ["tag:a:22", "tag"],
    ["server", "tag"],
    ["group:ops", "tag"],
  ] as const)("rejects %s as a %s", (name, kind) => {
    expect(isPolicyIdentityName(name, kind)).toBe(false);
  });
});

describe("upsert keeps position", () => {
  test("upsertTagOwner creates an underscore tag that serializes", () => {
    const next = upsertTagOwner(
      parsePolicy("{}"),
      createTagOwner("tag:k8s_node", [toMemberRef("alice@")]),
    );
    expect(serializePolicy(next).tagOwners).toEqual({ "tag:k8s_node": ["alice@"] });
  });

  test.each([createTagOwner("tag:1bad"), createTagOwner("tag:a,b"), createTagOwner("group:a b")])(
    "upsertTagOwner returns the same state for $tag",
    (owner) => {
      const state = parsePolicy("{}");
      expect(upsertTagOwner(state, owner)).toBe(state);
    },
  );

  test("upsertGroup returns the same state for an invalid name", () => {
    const state = parsePolicy("{}");
    expect(upsertGroup(state, createGroup("group:a b"))).toBe(state);
  });

  test("editing a group keeps its index in memory and in the serialized key order", () => {
    const [a, b, c] = ["group:a", "group:b", "group:c"].map((name) =>
      createGroup(name, [toMemberRef("x@")]),
    );
    let state = emptyState();
    for (const group of [a, b, c]) state = upsertGroup(state, group);

    const next = upsertGroup(state, { ...a, members: [...a.members, toMemberRef("y@")] });

    expect(next.groups.map((group) => group.name)).toEqual(["group:a", "group:b", "group:c"]);
    expect(Object.keys(serializePolicy(next).groups as object)).toEqual([
      "group:a",
      "group:b",
      "group:c",
    ]);
    expect(next.groups[0]?.members).toHaveLength(2);
  });

  test("editing a tag owner keeps its index in memory and in the serialized key order", () => {
    const [a, b, c] = ["tag:a", "tag:b", "tag:c"].map((tag) =>
      createTagOwner(tag, [toMemberRef("x@")]),
    );
    let state = emptyState();
    for (const owner of [a, b, c]) state = upsertTagOwner(state, owner);

    const next = upsertTagOwner(state, { ...a, owners: [...a.owners, toMemberRef("y@")] });

    expect(next.tagOwners.map((owner) => owner.tag)).toEqual(["tag:a", "tag:b", "tag:c"]);
    expect(Object.keys(serializePolicy(next).tagOwners as object)).toEqual([
      "tag:a",
      "tag:b",
      "tag:c",
    ]);
  });

  test("a new id appends and a same-id rename keeps the index", () => {
    const a = createGroup("group:a");
    const b = createGroup("group:b");
    let state = upsertGroup(upsertGroup(emptyState(), a), b);
    state = upsertGroup(state, createGroup("group:c"));
    expect(state.groups.map((group) => group.name)).toEqual(["group:a", "group:b", "group:c"]);

    state = upsertGroup(state, { ...a, name: "group:renamed" });
    expect(state.groups.map((group) => group.name)).toEqual([
      "group:renamed",
      "group:b",
      "group:c",
    ]);

    const owner = createTagOwner("tag:a");
    let tags = upsertTagOwner(upsertTagOwner(emptyState(), owner), createTagOwner("tag:b"));
    tags = upsertTagOwner(tags, { ...owner, tag: "tag:renamed" });
    expect(tags.tagOwners.map((item) => item.tag)).toEqual(["tag:renamed", "tag:b"]);
  });

  test("adding then removing a member serializes identically", () => {
    const a = createGroup("group:a", [toMemberRef("x@")]);
    const b = createGroup("group:b", [toMemberRef("x@")]);
    const state = upsertGroup(upsertGroup(emptyState(), a), b);
    const roundTrip = removeMemberFromGroup(
      upsertGroup(state, { ...a, members: [...a.members, toMemberRef("y@")] }),
      a.id,
      "y@",
    );
    expect(JSON.stringify(serializePolicy(roundTrip))).toBe(JSON.stringify(serializePolicy(state)));
  });
});
