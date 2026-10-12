import { describe, expect, test } from "vitest";
import { parsePolicy, serializePolicy, toMemberRef } from "./policy-designer";
import {
  removePolicyGroup,
  removePolicyTag,
  renamePolicyGroup,
  renamePolicyTag,
  retargetUserReferences,
} from "./policy-references";

function policy(extras: Record<string, unknown> = {}) {
  return parsePolicy(
    JSON.stringify({
      groups: { "group:ops": ["alice@"], "group:ops2": ["bob@"] },
      tagOwners: { "tag:server": ["group:ops"], "tag:other": ["tag:server", "bob@"] },
      acls: [
        {
          action: "accept",
          src: ["group:ops", "group:ops2"],
          dst: ["tag:server:22"],
          proto: "tcp",
        },
      ],
      ...extras,
    }),
  );
}

describe("policy identity references", () => {
  test("group rename updates known aliases while preserving non-reference strings and source state", () => {
    const state = policy({
      hosts: { literal: "group:ops" },
      randomizeClientPort: true,
      ssh: [
        {
          action: "check",
          src: ["group:ops"],
          dst: ["tag:server"],
          users: ["group:ops"],
          checkPeriod: "1h",
          acceptEnv: ["group:ops"],
        },
      ],
      autoApprovers: {
        routes: { "10.0.0.0/8": ["group:ops", "group:ops2"] },
        exitNode: ["group:ops"],
      },
      grants: [
        {
          src: ["group:ops"],
          dst: ["group:ops", "tag:server"],
          ip: ["group:ops"],
          app: {},
          via: ["tag:other"],
        },
      ],
      nodeAttrs: [{ target: ["group:ops"], attr: ["group:ops"], ipPool: ["group:ops"] }],
      tests: [
        {
          src: "group:ops",
          proto: "tcp",
          accept: ["group:ops:22", "group:ops2:443"],
          deny: ["tag:other:80"],
        },
      ],
      sshTests: [
        {
          src: "group:ops",
          dst: ["group:ops", "tag:server"],
          accept: ["group:ops"],
          deny: ["root"],
          check: ["deploy"],
        },
      ],
    });
    const original = structuredClone(state);
    const result = renamePolicyGroup(state, state.groups[0].id, "group:engineering");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.groups[0].id).toBe(state.groups[0].id);
    expect(serializePolicy(result.state)).toEqual({
      groups: { "group:engineering": ["alice@"], "group:ops2": ["bob@"] },
      tagOwners: { "tag:server": ["group:engineering"], "tag:other": ["tag:server", "bob@"] },
      acls: [
        {
          action: "accept",
          src: ["group:engineering", "group:ops2"],
          dst: ["tag:server:22"],
          proto: "tcp",
        },
      ],
      hosts: { literal: "group:ops" },
      randomizeClientPort: true,
      ssh: [
        {
          action: "check",
          src: ["group:engineering"],
          dst: ["tag:server"],
          users: ["group:ops"],
          checkPeriod: "1h",
          acceptEnv: ["group:ops"],
        },
      ],
      autoApprovers: {
        routes: { "10.0.0.0/8": ["group:engineering", "group:ops2"] },
        exitNode: ["group:engineering"],
      },
      grants: [
        {
          src: ["group:engineering"],
          dst: ["group:engineering", "tag:server"],
          ip: ["group:ops"],
          app: {},
          via: ["tag:other"],
        },
      ],
      nodeAttrs: [{ target: ["group:engineering"], attr: ["group:ops"], ipPool: ["group:ops"] }],
      tests: [
        {
          src: "group:engineering",
          proto: "tcp",
          accept: ["group:engineering:22", "group:ops2:443"],
          deny: ["tag:other:80"],
        },
      ],
      sshTests: [
        {
          src: "group:engineering",
          dst: ["group:engineering", "tag:server"],
          accept: ["group:ops"],
          deny: ["root"],
          check: ["deploy"],
        },
      ],
    });
    expect(state).toEqual(original);
  });

  test("tag rename covers definitions, owners, grants via and all test destinations without substring replacement", () => {
    const state = policy({
      ssh: [{ action: "accept", src: ["tag:server"], dst: ["tag:server"], users: ["tag:server"] }],
      grants: [
        {
          src: ["tag:server"],
          dst: ["tag:server", "tag:server2"],
          ip: ["tcp:22"],
          via: ["tag:server"],
        },
      ],
      autoApprovers: { routes: { "10.0.0.0/8": ["tag:server"] }, exitNode: ["tag:server"] },
      nodeAttrs: [{ target: ["tag:server"], attr: ["tag:server"] }],
      tests: [{ src: "tag:server", accept: ["tag:server:22"], deny: ["tag:server2:80"] }],
      sshTests: [{ src: "tag:server", dst: ["tag:server"], check: ["tag:server"] }],
    });
    const result = renamePolicyTag(state, "tag:server", "tag:gateway");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.tagOwners[0].id).toBe(state.tagOwners[0].id);
    expect(serializePolicy(result.state)).toMatchObject({
      tagOwners: { "tag:gateway": ["group:ops"], "tag:other": ["tag:gateway", "bob@"] },
      acls: [{ src: ["group:ops", "group:ops2"], dst: ["tag:gateway:22"], proto: "tcp" }],
      ssh: [{ src: ["tag:gateway"], dst: ["tag:gateway"], users: ["tag:server"] }],
      grants: [
        {
          src: ["tag:gateway"],
          dst: ["tag:gateway", "tag:server2"],
          ip: ["tcp:22"],
          via: ["tag:gateway"],
        },
      ],
      autoApprovers: { routes: { "10.0.0.0/8": ["tag:gateway"] }, exitNode: ["tag:gateway"] },
      nodeAttrs: [{ target: ["tag:gateway"], attr: ["tag:server"] }],
      tests: [{ src: "tag:gateway", accept: ["tag:gateway:22"], deny: ["tag:server2:80"] }],
      sshTests: [{ src: "tag:gateway", dst: ["tag:gateway"], check: ["tag:server"] }],
    });
  });

  test("deletion removes rules whose required references become empty, especially the last via constraint", () => {
    const state = policy({
      ssh: [{ action: "accept", src: ["tag:server"], dst: ["tag:other"], users: ["root"] }],
      grants: [
        { src: ["group:ops"], dst: ["tag:other"], ip: ["*"], via: ["tag:server"] },
        { src: ["tag:server"], dst: ["tag:other"], ip: ["*"] },
        { src: ["group:ops"], dst: ["tag:server"], ip: ["*"] },
        { src: ["group:ops"], dst: ["tag:other"], ip: ["*"], via: ["tag:server", "tag:other"] },
      ],
      nodeAttrs: [
        { target: ["tag:server"], attr: ["keep"] },
        { target: ["tag:server", "group:ops"], attr: ["keep"] },
      ],
      tests: [
        { src: "tag:server", accept: ["tag:other:22"] },
        { src: "alice@", accept: ["tag:server:22"] },
        {
          src: "alice@",
          accept: ["tag:server:22", "tag:other:22"],
          deny: ["tag:server:80", "tag:other:80"],
        },
      ],
      sshTests: [
        { src: "tag:server", dst: ["tag:other"], accept: ["root"] },
        { src: "alice@", dst: ["tag:server"], accept: ["root"] },
        { src: "alice@", dst: ["tag:server", "tag:other"], deny: ["tag:server"] },
      ],
    });
    const result = removePolicyTag(state, "tag:server");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(serializePolicy(result.state)).toMatchObject({
      tagOwners: { "tag:other": ["bob@"] },
      acls: [],
      ssh: [],
      grants: [{ src: ["group:ops"], dst: ["tag:other"], ip: ["*"], via: ["tag:other"] }],
      nodeAttrs: [{ target: ["group:ops"], attr: ["keep"] }],
      tests: [{ src: "alice@", accept: ["tag:other:22"], deny: ["tag:other:80"] }],
      sshTests: [{ src: "alice@", dst: ["tag:other"], deny: ["tag:server"] }],
    });
    const removedGroup = removePolicyGroup(policy(), state.groups[0].id);
    expect(removedGroup).toMatchObject({ ok: false, issue: { code: "entity-not-found" } });
    const groupState = policy();
    const removed = removePolicyGroup(groupState, groupState.groups[0].id);
    expect(removed.ok).toBe(true);
    if (removed.ok)
      expect(serializePolicy(removed.state)).toMatchObject({
        groups: { "group:ops2": ["bob@"] },
        tagOwners: { "tag:server": [] },
        acls: [{ src: ["group:ops2"] }],
      });
  });

  test.each([
    [{ future: { owner: "group:ops" } }, "future"],
    [{ hosts: [] }, "hosts"],
    [{ hosts: { office: 3 } }, "hosts.office"],
    [{ randomizeClientPort: "yes" }, "randomizeClientPort"],
    [{ autoApprovers: null }, "autoApprovers"],
    [{ autoApprovers: { future: [] } }, "autoApprovers.future"],
    [{ autoApprovers: { routes: [] } }, "autoApprovers.routes"],
    [{ autoApprovers: { exitNode: "group:ops" } }, "autoApprovers.exitNode"],
    [{ autoApprovers: { exitNode: ["*"] } }, "autoApprovers.exitNode[0]"],
    [
      { autoApprovers: { routes: { "10.0.0.0/24": ["hostname"] } } },
      "autoApprovers.routes.10.0.0.0/24[0]",
    ],
    [{ ssh: {} }, "ssh"],
    [{ ssh: [null] }, "ssh[0]"],
    [
      { ssh: [{ action: "deny", src: ["group:ops"], dst: ["tag:server"], users: ["root"] }] },
      "ssh[0].action",
    ],
    [
      { ssh: [{ action: "accept", src: ["group:ops"], dst: ["tag:server"], users: [] }] },
      "ssh[0].users",
    ],
    [
      { ssh: [{ action: "accept", src: ["alice@"], dst: ["group:ops"], users: ["root"] }] },
      "ssh[0].dst[0]",
    ],
    [
      {
        ssh: [
          {
            action: "check",
            src: ["alice@"],
            dst: ["tag:server"],
            users: ["root"],
            checkPeriod: 5,
          },
        ],
      },
      "ssh[0].checkPeriod",
    ],
    [
      { grants: [{ src: ["group:ops"], dst: ["tag:server"], ip: ["*"], future: {} }] },
      "grants[0].future",
    ],
    [
      {
        grants: [
          {
            src: ["group:ops"],
            dst: ["tag:server"],
            app: { "example.com/app": [{ owner: "group:ops" }] },
          },
        ],
      },
      "grants[0].app",
    ],
    [
      { grants: [{ src: ["group:ops"], dst: ["tag:server"], ip: ["*"], via: ["group:ops"] }] },
      "grants[0].via[0]",
    ],
    [{ grants: [{ src: [], dst: ["tag:server"], ip: ["*"] }] }, "grants[0].src"],
    [{ grants: ["not an object"] }, "grants[0]"],
    [{ nodeAttrs: [1] }, "nodeAttrs[0]"],
    [{ tests: [null] }, "tests[0]"],
    [{ sshTests: ["not an object"] }, "sshTests[0]"],
    [{ nodeAttrs: [{ target: [false], attr: ["keep"] }] }, "nodeAttrs[0].target"],
    [{ nodeAttrs: [{ target: [], attr: ["keep"] }] }, "nodeAttrs[0].target"],
    [{ tests: [{ src: 2, accept: ["tag:server:22"] }] }, "tests[0].src"],
    [{ tests: [{ src: "alice@", proto: 22, accept: ["tag:server:22"] }] }, "tests[0].proto"],
    [{ tests: [{ src: "alice@", accept: ["tag:server"] }] }, "tests[0].accept[0]"],
    [{ tests: [{ src: "alice@", accept: [], deny: [] }] }, "tests[0]"],
    [{ sshTests: [{ src: "alice@", dst: ["tag:server"], check: "root" }] }, "sshTests[0].check"],
    [{ sshTests: [{ src: "alice@", dst: [], check: ["root"] }] }, "sshTests[0].dst"],
  ])("opaque or malformed references block atomically: %j", (extras, path) => {
    const state = policy(extras);
    const original = structuredClone(state);
    for (const result of [
      renamePolicyGroup(state, state.groups[0].id, "group:new"),
      removePolicyTag(state, "tag:server"),
    ]) {
      expect(result).toMatchObject({
        ok: false,
        issue: { code: "unsupported-reference", paths: expect.arrayContaining([path]) },
      });
    }
    expect(state).toEqual(original);
  });

  test("unknown ACL extras and recursive group members block identity operations", () => {
    const state = policy();
    state.rules[0].extras = { proto: "tcp", srcPosture: ["posture:managed"] };
    state.groups[0].members.push({ kind: "group", value: "group:ops2" });
    expect(renamePolicyGroup(state, state.groups[0].id, "group:new")).toMatchObject({
      ok: false,
      issue: { paths: expect.arrayContaining(["acls[0].srcPosture", "groups.group:ops[1]"]) },
    });
  });

  test("an incomplete ACL or malformed protocol blocks identity changes without discarding the draft", () => {
    const state = policy();
    state.rules[0].ports = " ";
    state.rules[0].extras = { proto: 6 };
    const before = structuredClone(state);
    expect(removePolicyTag(state, "tag:server")).toMatchObject({
      ok: false,
      issue: { paths: expect.arrayContaining(["acls[0]", "acls[0].proto"]) },
    });
    expect(state).toEqual(before);
  });

  test("a group whose name is not a group identity blocks identity changes", () => {
    const state = policy();
    state.groups[0].name = "ops";
    expect(removePolicyTag(state, "tag:server")).toMatchObject({
      ok: false,
      issue: { code: "unsupported-reference", paths: ["groups[0].name"] },
    });
  });

  test("malformed tag owners block renaming instead of carrying unsupported owner aliases forward", () => {
    const state = policy();
    state.tagOwners[0].owners = [toMemberRef("autogroup:member")];
    expect(renamePolicyGroup(state, state.groups[0].id, "group:new")).toMatchObject({
      ok: false,
      issue: { paths: ["tagOwners.tag:server[0]"] },
    });
  });

  test("invalid names, collisions, unreadable state and absent entities never change the document", () => {
    const state = policy();
    expect(renamePolicyGroup(state, state.groups[0].id, "group:ops2")).toMatchObject({
      ok: false,
      issue: { code: "name-conflict" },
    });
    expect(renamePolicyTag(state, "tag:server", "tag:other")).toMatchObject({
      ok: false,
      issue: { code: "name-conflict" },
    });
    expect(renamePolicyTag(state, "tag:server", "tag:1bad")).toMatchObject({
      ok: false,
      issue: { code: "invalid-name" },
    });
    expect(renamePolicyGroup(state, state.groups[0].id, "group:bad name")).toMatchObject({
      ok: false,
      issue: { code: "invalid-name" },
    });
    expect(removePolicyTag(state, "tag:missing")).toMatchObject({
      ok: false,
      issue: { code: "entity-not-found" },
    });
    expect(removePolicyGroup(parsePolicy("invalid"), "id")).toMatchObject({
      ok: false,
      issue: { code: "unreadable-policy" },
    });
  });

  test("same-name edits retain exact state and inline tags remain editable without creating a definition", () => {
    const state = policy({ future: {} });
    const group = renamePolicyGroup(state, state.groups[0].id, "group:ops");
    const tag = renamePolicyTag(state, "tag:server", "tag:server");
    if (!group.ok || !tag.ok) throw new Error("A no-op must remain safe");
    expect(group.state).toBe(state);
    expect(tag.state).toBe(state);
    const inline = parsePolicy(
      '{"acls":[{"action":"accept","src":["tag:inline"],"dst":["tag:other:22"]}]}',
    );
    const renamed = renamePolicyTag(inline, "tag:inline", "tag:renamed");
    if (!renamed.ok) throw new Error("Expected inline tag support");
    expect(renamed.state.tagOwners).toEqual([]);
    expect(renamed.state.rules[0].source).toBe("tag:renamed");
  });

  test("tags with underscores no longer block unrelated group and tag operations", () => {
    const state = parsePolicy(
      JSON.stringify({
        groups: { "group:ops": ["alice@"] },
        tagOwners: { "tag:k8s_node": ["group:ops"], "tag:server": ["group:ops"] },
        acls: [{ action: "accept", src: ["group:ops"], dst: ["tag:k8s_node:22"] }],
      }),
    );
    const results = [
      renamePolicyGroup(state, state.groups[0].id, "group:eng"),
      removePolicyGroup(state, state.groups[0].id),
      renamePolicyTag(state, "tag:server", "tag:ci_runner"),
      removePolicyTag(state, "tag:server"),
    ];
    for (const result of results) {
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(JSON.stringify(serializePolicy(result.state))).toContain("tag:k8s_node");
    }
    const renamed = renamePolicyTag(state, "tag:k8s_node", "tag:k8s_pool");
    expect(renamed.ok).toBe(true);
    if (renamed.ok) {
      const saved = serializePolicy(renamed.state);
      expect(saved.tagOwners).toEqual({
        "tag:k8s_pool": ["group:ops"],
        "tag:server": ["group:ops"],
      });
      expect(saved.acls).toEqual([
        { action: "accept", src: ["group:ops"], dst: ["tag:k8s_pool:22"] },
      ]);
    }
  });

  test("names with an at sign or a comma stay excluded from tag operations", () => {
    const state = policy();
    expect(renamePolicyTag(state, "tag:server", "tag:a@b")).toMatchObject({
      ok: false,
      issue: { code: "invalid-name" },
    });
    const comma = policy();
    comma.tagOwners[0].tag = "tag:a,b";
    expect(renamePolicyGroup(comma, comma.groups[0].id, "group:new")).toMatchObject({
      ok: false,
      issue: { code: "unsupported-reference", paths: ["tagOwners[0].tag"] },
    });
  });
});

describe("retargetUserReferences", () => {
  const USER_POLICY = {
    groups: {
      "group:ops": ["alice@", "alice@example.com", "bob@", "malice@"],
      "group:dup": ["alice@", "alice2@"],
    },
    tagOwners: { "tag:server": ["alice@", "group:ops"], "tag:solo": ["alice@"] },
    acls: [
      { action: "accept", src: ["alice@", "bob@"], dst: ["tag:server:22"] },
      { action: "accept", src: ["alice@"], dst: ["tag:server:22"] },
      { action: "accept", src: ["bob@"], dst: ["alice@:22", "tag:server:80"] },
      { action: "accept", src: ["alice"], dst: ["alice:22"] },
      { action: "accept", src: ["alice@", "alice2@"], dst: ["tag:server:443"] },
    ],
    ssh: [
      { action: "accept", src: ["alice@", "bob@"], dst: ["tag:server"], users: ["root"] },
      { action: "accept", src: ["alice"], dst: ["tag:server"], users: ["root"] },
      { action: "accept", src: ["alice@"], dst: ["tag:server"], users: ["root"] },
    ],
    autoApprovers: { routes: { "10.0.0.0/8": ["alice@", "bob@"] }, exitNode: ["alice@"] },
    grants: [
      { src: ["alice@"], dst: ["tag:server"], ip: ["*"] },
      { src: ["bob@"], dst: ["tag:server", "alice@"], ip: ["*"] },
    ],
    nodeAttrs: [
      { target: ["alice@"], attr: ["a"] },
      { target: ["alice@", "bob@"], attr: ["b"] },
    ],
    tests: [
      { src: "alice@", accept: ["tag:server:22"] },
      {
        src: "bob@",
        accept: ["alice@:22", "tag:server:22"],
        deny: ["alice@example.com:80", "tag:server:80"],
      },
      { src: "bob@", accept: ["alice@:22"], deny: ["tag:server:80"] },
    ],
    sshTests: [
      { src: "alice@", dst: ["tag:server"], accept: ["root"] },
      { src: "bob@", dst: ["alice@", "tag:server"], accept: ["root"] },
      { src: "bob@", dst: ["alice@"], accept: ["root"] },
    ],
  };

  function saved(result: ReturnType<typeof retargetUserReferences>) {
    if (!result.ok) throw new Error(`expected ok, got ${result.issue.code}`);
    return { saved: serializePolicy(result.state), sections: [...result.sections].sort() };
  }

  test("deleting a user drops it everywhere and removes emptied entries", () => {
    const state = parsePolicy(JSON.stringify(USER_POLICY));
    const original = structuredClone(state);
    const { saved: out, sections } = saved(
      retargetUserReferences(state, ["alice@", "alice@example.com"], null),
    );

    expect(state).toEqual(original);
    expect(sections).toEqual(
      [
        "groups",
        "tagOwners",
        "acls",
        "ssh",
        "autoApprovers",
        "grants",
        "nodeAttrs",
        "tests",
        "sshTests",
      ].sort(),
    );
    expect(out.groups).toEqual({ "group:ops": ["bob@", "malice@"], "group:dup": ["alice2@"] });
    expect(out.tagOwners).toEqual({ "tag:server": ["group:ops"], "tag:solo": [] });
    expect(out.acls).toEqual([
      { action: "accept", src: ["bob@"], dst: ["tag:server:22"] },
      { action: "accept", src: ["bob@"], dst: ["tag:server:80"] },
      { action: "accept", src: ["alice"], dst: ["alice:22"] },
      { action: "accept", src: ["alice2@"], dst: ["tag:server:443"] },
    ]);
    expect(out.ssh).toEqual([
      { action: "accept", src: ["bob@"], dst: ["tag:server"], users: ["root"] },
      { action: "accept", src: ["alice"], dst: ["tag:server"], users: ["root"] },
    ]);
    expect(out.autoApprovers).toEqual({ routes: { "10.0.0.0/8": ["bob@"] }, exitNode: [] });
    expect(out.grants).toEqual([{ src: ["bob@"], dst: ["tag:server"], ip: ["*"] }]);
    expect(out.nodeAttrs).toEqual([{ target: ["bob@"], attr: ["b"] }]);
    expect(out.tests).toEqual([
      { src: "bob@", accept: ["tag:server:22"], deny: ["tag:server:80"] },
      { src: "bob@", deny: ["tag:server:80"], accept: [] },
    ]);
    expect(out.sshTests).toEqual([{ src: "bob@", dst: ["tag:server"], accept: ["root"] }]);
  });

  test("a policy that does not mention the user changes nothing", () => {
    const state = parsePolicy(JSON.stringify(USER_POLICY));
    const result = retargetUserReferences(state, ["carol@", "carol"], null);
    expect(saved(result).sections).toEqual([]);
  });

  test("renaming rewrites groups, owners, rules and ssh and de-duplicates", () => {
    const state = parsePolicy(JSON.stringify(USER_POLICY));
    const { saved: out, sections } = saved(retargetUserReferences(state, ["alice@"], "alice2@"));

    expect(sections).toContain("groups");
    expect(out.groups).toEqual({
      "group:ops": ["alice2@", "alice@example.com", "bob@", "malice@"],
      "group:dup": ["alice2@"],
    });
    expect(out.tagOwners).toEqual({
      "tag:server": ["alice2@", "group:ops"],
      "tag:solo": ["alice2@"],
    });
    expect(out.acls).toEqual([
      { action: "accept", src: ["alice2@", "bob@"], dst: ["tag:server:22"] },
      { action: "accept", src: ["alice2@"], dst: ["tag:server:22"] },
      { action: "accept", src: ["bob@"], dst: ["alice2@:22"] },
      { action: "accept", src: ["bob@"], dst: ["tag:server:80"] },
      { action: "accept", src: ["alice"], dst: ["alice:22"] },
      { action: "accept", src: ["alice2@"], dst: ["tag:server:443"] },
    ]);
    expect(out.ssh).toEqual([
      { action: "accept", src: ["alice2@", "bob@"], dst: ["tag:server"], users: ["root"] },
      { action: "accept", src: ["alice"], dst: ["tag:server"], users: ["root"] },
      { action: "accept", src: ["alice2@"], dst: ["tag:server"], users: ["root"] },
    ]);
  });

  test("a rename de-duplicates a destination list too", () => {
    const state = parsePolicy(
      JSON.stringify({
        tests: [{ src: "bob@", accept: ["alice@:22", "alice2@:22"] }],
      }),
    );
    expect(saved(retargetUserReferences(state, ["alice@"], "alice2@")).saved.tests).toEqual([
      { src: "bob@", accept: ["alice2@:22"] },
    ]);
  });

  test("a deny-only test entry is retargeted without inventing an accept list", () => {
    const state = parsePolicy(
      JSON.stringify({ tests: [{ src: "bob@", deny: ["alice@:22", "alice2@:22"] }] }),
    );
    const result = retargetUserReferences(state, ["alice@"], "alice2@");
    expect(saved(result).saved.tests).toStrictEqual([{ src: "bob@", deny: ["alice2@:22"] }]);
    expect(saved(result).sections).toContain("tests");
  });

  test("bare names and non-user principals are never rewritten", () => {
    const state = parsePolicy(JSON.stringify(USER_POLICY));
    expect(saved(retargetUserReferences(state, ["alice"], null)).sections).toEqual([]);
  });

  test.each([
    [
      "non-empty grants.app",
      {
        grants: [{ src: ["alice@"], dst: ["tag:server"], app: { "example.com/app": [{ a: 1 }] } }],
      },
      "grants[0].app",
      true,
    ],
    [
      "an unknown section",
      { groups: { "group:ops": ["alice@"] }, future: { a: 1 } },
      "future",
      true,
    ],
    ["a malformed entry", { ssh: [null], tagOwners: { "tag:x": ["alice@"] } }, "ssh[0]", true],
    ["an unrelated unknown section", { future: { a: 1 } }, "future", false],
    ["an opaque host value", { hosts: { alice: 3, "alice@": "1.1.1.1" } }, "hosts.alice", false],
  ])("strictly refuses %s", (_name, raw, path, mentioned) => {
    const state = parsePolicy(JSON.stringify(raw));
    const original = structuredClone(state);
    const result = retargetUserReferences(state, ["alice@"], null);

    expect(result).toMatchObject({
      ok: false,
      issue: { code: "unsupported-reference", paths: expect.arrayContaining([path]) },
      mentioned,
    });
    expect(state).toEqual(original);
  });

  test("ACL extensions the editor cannot rewrite refuse the operation", () => {
    const state = policy();
    state.groups[0].members = [toMemberRef("alice@")];
    state.rules[0].extras = { proto: "tcp", srcPosture: ["posture:managed"] };
    expect(retargetUserReferences(state, ["alice@"], null)).toMatchObject({
      ok: false,
      issue: { code: "unsupported-reference", paths: ["acls[0].srcPosture"] },
      mentioned: true,
    });
  });

  test("an unreadable policy is reported without reading references", () => {
    expect(retargetUserReferences(parsePolicy("invalid"), ["alice@"], null)).toEqual({
      ok: false,
      issue: { code: "unreadable-policy", paths: [] },
      mentioned: false,
    });
  });
});
