import { describe, expect, test } from "vitest";
import { addRule } from "@/test/policy-state";
import type { PolicyDesignerState } from "./policy-designer";
import {
  createGroup,
  createRule,
  createTagOwner,
  emptyState,
  parseCommaList,
  parsePolicy,
  serializePolicy,
  toMemberRef,
  upsertGroup,
  upsertTagOwner,
} from "./policy-designer";
import {
  getGroupAccess,
  getIpRules,
  getOpenAccessWarnings,
  getTagAccessors,
  hasOnlyDefaultAccess,
  listTagsFromState,
  parsePortsToServices,
  removeTagAccessor,
  servicesToPortsString,
  setTagAccessor,
  stripGroupPrefix,
  stripTagPrefix,
  updateIpRule,
  withGroupPrefix,
  withTagPrefix,
} from "./policy-views";

describe("parsePortsToServices", () => {
  test("identifies SSH preset", () => {
    expect(parsePortsToServices("22")).toEqual({ presets: ["ssh"], custom: "" });
  });

  test("identifies Web preset (80 + 443)", () => {
    expect(parsePortsToServices("80,443")).toEqual({ presets: ["web"], custom: "" });
  });

  test("identifies combined SSH + Web", () => {
    const result = parsePortsToServices("22,80,443");
    expect(result.presets).toContain("ssh");
    expect(result.presets).toContain("web");
    expect(result.custom).toBe("");
  });

  test("wildcard maps to 'all'", () => {
    expect(parsePortsToServices("*")).toEqual({ presets: ["all"], custom: "" });
  });

  test("empty ports returns empty result", () => {
    expect(parsePortsToServices("")).toEqual({ presets: [], custom: "" });
  });

  test("non-preset ports become custom", () => {
    expect(parsePortsToServices("8080,9000")).toEqual({ presets: [], custom: "8080,9000" });
  });

  test("mixed preset and custom ports", () => {
    const result = parsePortsToServices("22,8080");
    expect(result.presets).toEqual(["ssh"]);
    expect(result.custom).toBe("8080");
  });

  test("partial web ports become custom (80 only without 443)", () => {
    const result = parsePortsToServices("80");
    expect(result.presets).not.toContain("web");
    expect(result.custom).toBe("80");
  });
});

describe("servicesToPortsString", () => {
  test("'all' overrides everything", () => {
    expect(servicesToPortsString(["all", "ssh"], "8080")).toBe("*");
  });

  test("SSH alone produces '22'", () => {
    expect(servicesToPortsString(["ssh"], "")).toBe("22");
  });

  test("Web produces '80,443'", () => {
    expect(servicesToPortsString(["web"], "")).toBe("80,443");
  });

  test("SSH + Web combined", () => {
    expect(servicesToPortsString(["ssh", "web"], "")).toBe("22,80,443");
  });

  test("Custom ports appended", () => {
    expect(servicesToPortsString(["ssh"], "8080,9000")).toBe("22,8080,9000");
  });

  test("Empty inputs return empty string", () => {
    expect(servicesToPortsString([], "")).toBe("");
  });

  test("Duplicates collapsed", () => {
    expect(servicesToPortsString(["ssh"], "22,8080")).toBe("22,8080");
  });

  test("ids without a preset contribute no ports", () => {
    expect(servicesToPortsString(["ping"], "")).toBe("");
    expect(servicesToPortsString(["ping", "ssh"], "8080")).toBe("22,8080");
  });
});

describe("round-trip parsePortsToServices ↔ servicesToPortsString", () => {
  const cases = ["22", "*", "80,443", "22,80,443", "3389", "53", "22,8080", ""];
  for (const ports of cases) {
    test(`preserves: "${ports}"`, () => {
      const { presets, custom } = parsePortsToServices(ports);
      const back = servicesToPortsString(presets, custom);
      const reparsed = parsePortsToServices(back);
      expect(reparsed).toEqual({ presets, custom });
    });
  }
});

describe("getTagAccessors", () => {
  test("marks every aggregate containing an extended rule as read-only", () => {
    const state = parsePolicy(
      JSON.stringify({
        acls: [
          { action: "accept", src: ["alice@"], dst: ["tag:server:22"] },
          { action: "accept", src: ["alice@"], dst: ["tag:server:443"], proto: "tcp" },
          { action: "accept", src: ["bob@"], dst: ["tag:server:53"], proto: "udp" },
          { action: "accept", src: ["bob@"], dst: ["tag:server:80"] },
          { action: "accept", src: ["carol@"], dst: ["tag:server:22"] },
        ],
      }),
    );

    const accessors = getTagAccessors(state, "tag:server");
    expect(accessors.find((accessor) => accessor.who === "alice@")?.readOnly).toBe(true);
    expect(accessors.find((accessor) => accessor.who === "bob@")?.readOnly).toBe(true);
    expect(accessors.find((accessor) => accessor.who === "carol@")?.readOnly).not.toBe(true);
  });

  test("returns accessors with their services for a tag", () => {
    let state = emptyState();
    state = { ...state, rules: [] };
    state = addRule(state, createRule("group:ops", "tag:server", "22"));
    state = addRule(state, createRule("alice@example.com", "tag:server", "80,443"));

    const accessors = getTagAccessors(state, "tag:server");
    expect(accessors).toHaveLength(2);

    const ops = accessors.find((a) => a.who === "group:ops");
    expect(ops?.whoKind).toBe("group");
    expect(ops?.services).toEqual(["ssh"]);

    const alice = accessors.find((a) => a.who === "alice@example.com");
    expect(alice?.whoKind).toBe("user");
    expect(alice?.services).toEqual(["web"]);
  });

  test("merges multiple rules for same (who, tag)", () => {
    let state = emptyState();
    state = { ...state, rules: [] };
    state = addRule(state, createRule("group:ops", "tag:server", "22"));
    state = addRule(state, createRule("group:ops", "tag:server", "80,443"));

    const accessors = getTagAccessors(state, "tag:server");
    expect(accessors).toHaveLength(1);
    expect(accessors[0]?.services.sort()).toEqual(["ssh", "web"].sort());
  });

  test("returns empty when tag has no rules", () => {
    const state = emptyState();
    expect(getTagAccessors(state, "tag:nonexistent")).toEqual([]);
  });

  test("handles comma-separated sources", () => {
    let state = emptyState();
    state = { ...state, rules: [] };
    state = addRule(state, createRule("alice@example.com,bob@example.com", "tag:server", "22"));

    const accessors = getTagAccessors(state, "tag:server");
    expect(accessors).toHaveLength(2);
    expect(accessors.map((a) => a.who).sort()).toEqual(["alice@example.com", "bob@example.com"]);
  });

  test("handles comma-separated destinations", () => {
    let state = emptyState();
    state = { ...state, rules: [] };
    state = addRule(state, createRule("group:ops", "tag:server,tag:db", "22"));

    const serverAccessors = getTagAccessors(state, "tag:server");
    const dbAccessors = getTagAccessors(state, "tag:db");
    expect(serverAccessors[0]?.who).toBe("group:ops");
    expect(dbAccessors[0]?.who).toBe("group:ops");
  });
});

describe("getGroupAccess", () => {
  test("lists tags a group can access", () => {
    let state = emptyState();
    state = { ...state, rules: [] };
    state = addRule(state, createRule("group:ops", "tag:server", "22"));
    state = addRule(state, createRule("group:ops", "tag:db", "5432"));
    state = addRule(state, createRule("group:dev", "tag:server", "22"));

    const access = getGroupAccess(state, "group:ops");
    expect(access).toHaveLength(2);
    const tags = access.map((a) => a.tagName).sort();
    expect(tags).toEqual(["tag:db", "tag:server"]);
  });

  test("excludes non-tag destinations", () => {
    let state = emptyState();
    state = { ...state, rules: [] };
    state = addRule(state, createRule("group:ops", "10.0.0.1", "22"));
    state = addRule(state, createRule("group:ops", "tag:server", "22"));

    const access = getGroupAccess(state, "group:ops");
    expect(access).toHaveLength(1);
    expect(access[0]?.tagName).toBe("tag:server");
  });

  test("returns empty for group not referenced", () => {
    const state = emptyState();
    expect(getGroupAccess(state, "group:nobody")).toEqual([]);
  });

  test("merges services and custom ports for repeated group-to-tag rules", () => {
    let state: PolicyDesignerState = { ...emptyState(), rules: [] };
    state = addRule(state, createRule("group:testers", "tag:service", "22,8080"));
    state = addRule(state, createRule("group:testers", "tag:service", "80,443,8443"));

    expect(getGroupAccess(state, "group:testers")).toEqual([
      {
        tagName: "tag:service",
        services: ["ssh", "web"],
        customPorts: "8080,8443",
      },
    ]);
  });
});

describe("setTagAccessor", () => {
  test.each(["80,443", ""])(
    "refuses aggregate edits that would drop protocol constraints: %s",
    (ports) => {
      const state = parsePolicy(
        JSON.stringify({
          acls: [
            { action: "accept", src: ["alice@"], dst: ["tag:server:22"], proto: "tcp" },
            { action: "accept", src: ["alice@"], dst: ["tag:server:53"], proto: "udp" },
          ],
        }),
      );

      expect(() => setTagAccessor(state, "tag:server", "alice@", ports)).toThrow();
      expect(serializePolicy(state).acls).toEqual([
        { action: "accept", src: ["alice@"], dst: ["tag:server:22"], proto: "tcp" },
        { action: "accept", src: ["alice@"], dst: ["tag:server:53"], proto: "udp" },
      ]);
    },
  );

  test("creates a new rule when accessor doesn't exist", () => {
    const state = { ...emptyState(), rules: [] };
    const next = setTagAccessor(state, "tag:server", "alice@example.com", "22");
    expect(next.rules).toHaveLength(1);
    expect(next.rules[0]?.source).toBe("alice@example.com");
    expect(next.rules[0]?.destination).toBe("tag:server");
    expect(next.rules[0]?.ports).toBe("22");
  });

  test("replaces existing accessor rule (idempotent on services change)", () => {
    let state: PolicyDesignerState = { ...emptyState(), rules: [] };
    state = setTagAccessor(state, "tag:server", "alice@example.com", "22");
    state = setTagAccessor(state, "tag:server", "alice@example.com", "80,443");

    expect(state.rules).toHaveLength(1);
    expect(state.rules[0]?.ports).toBe("80,443");
  });

  test("setTagAccessor with empty ports removes the accessor", () => {
    let state: PolicyDesignerState = { ...emptyState(), rules: [] };
    state = setTagAccessor(state, "tag:server", "alice@example.com", "22");
    state = setTagAccessor(state, "tag:server", "alice@example.com", "");

    expect(state.rules).toHaveLength(0);
  });

  test("ignores empty tag or who", () => {
    const state = { ...emptyState(), rules: [] };
    expect(setTagAccessor(state, "", "alice@example.com", "22")).toBe(state);
    expect(setTagAccessor(state, "tag:server", "", "22")).toBe(state);
  });

  test("preserves rules for other (who, tag) pairs", () => {
    let state: PolicyDesignerState = { ...emptyState(), rules: [] };
    state = setTagAccessor(state, "tag:server", "alice@example.com", "22");
    state = setTagAccessor(state, "tag:db", "alice@example.com", "5432");
    state = setTagAccessor(state, "tag:server", "alice@example.com", "80,443");

    expect(state.rules).toHaveLength(2);
    const serverRule = state.rules.find((r) => r.destination === "tag:server");
    const dbRule = state.rules.find((r) => r.destination === "tag:db");
    expect(serverRule?.ports).toBe("80,443");
    expect(dbRule?.ports).toBe("5432");
  });
});

describe("removeTagAccessor", () => {
  test("revokes an extended rule for one source without dropping restrictions for other sources", () => {
    const state = parsePolicy(
      JSON.stringify({
        acls: [
          {
            action: "accept",
            src: ["alice@", "bob@"],
            dst: ["tag:server:443"],
            proto: "tcp",
            srcPosture: ["posture:managed"],
          },
        ],
      }),
    );

    expect(serializePolicy(removeTagAccessor(state, "tag:server", "alice@")).acls).toEqual([
      {
        action: "accept",
        src: ["bob@"],
        dst: ["tag:server:443"],
        proto: "tcp",
        srcPosture: ["posture:managed"],
      },
    ]);
  });

  test("removes rule cleanly when single source and destination", () => {
    let state: PolicyDesignerState = { ...emptyState(), rules: [] };
    state = setTagAccessor(state, "tag:server", "alice@example.com", "22");
    state = removeTagAccessor(state, "tag:server", "alice@example.com");
    expect(state.rules).toHaveLength(0);
  });

  test("trims source when rule has multiple sources", () => {
    let state: PolicyDesignerState = { ...emptyState(), rules: [] };
    state = addRule(state, createRule("alice@example.com,bob@example.com", "tag:server", "22"));
    state = removeTagAccessor(state, "tag:server", "alice@example.com");

    expect(state.rules).toHaveLength(1);
    expect(state.rules[0]?.source).toBe("bob@example.com");
  });

  test("trims destination when rule has multiple destinations and one source", () => {
    let state: PolicyDesignerState = { ...emptyState(), rules: [] };
    state = addRule(state, createRule("alice@example.com", "tag:server,tag:db", "22"));
    state = removeTagAccessor(state, "tag:server", "alice@example.com");

    expect(state.rules).toHaveLength(1);
    expect(state.rules[0]?.destination).toBe("tag:db");
  });

  test("splits a multi-source, multi-destination rule so only the removed pair is revoked", () => {
    let state: PolicyDesignerState = { ...emptyState(), rules: [] };
    const sharedRule = createRule(
      "user@example.test,group:testers",
      "tag:service,tag:database",
      "22",
    );
    state = addRule(state, sharedRule);

    const next = removeTagAccessor(state, "tag:service", "user@example.test");

    expect(next.rules).toHaveLength(2);
    expect(next.rules[0]).toEqual({
      ...sharedRule,
      source: "user@example.test,group:testers",
      destination: "tag:database",
    });
    expect(next.rules[1]).toMatchObject({
      source: "group:testers",
      destination: "tag:service",
      ports: "22",
      action: "accept",
    });
    expect(next.rules[1]?.id).not.toBe(sharedRule.id);
    expect(getTagAccessors(next, "tag:service").map((a) => a.who)).toEqual(["group:testers"]);
    expect(getTagAccessors(next, "tag:database").map((a) => a.who)).toEqual([
      "user@example.test",
      "group:testers",
    ]);
  });

  const pairs = (state: PolicyDesignerState) =>
    state.rules
      .flatMap((rule) =>
        parseCommaList(rule.source).flatMap((source) =>
          parseCommaList(rule.destination).map(
            (destination) => `${source}|${destination}|${rule.ports}`,
          ),
        ),
      )
      .sort();

  test.each([
    ["1x1", "alice@", "tag:server"],
    ["1xN", "alice@", "tag:server,tag:db"],
    ["Nx1", "alice@,bob@", "tag:server"],
    ["NxN", "alice@,bob@", "tag:server,tag:db"],
    ["only source is who", "alice@", "tag:server,tag:db,10.0.0.0/8"],
    ["no match", "bob@", "tag:db"],
  ])("removing one pair keeps every other pair (%s)", (_name, source, destination) => {
    const state = addRule(
      { ...emptyState(), rules: [] },
      createRule(source, destination, "22,443"),
    );
    const before = pairs(state);

    const after = pairs(removeTagAccessor(state, "tag:server", "alice@"));

    expect(after).toEqual(before.filter((pair) => !pair.startsWith("alice@|tag:server|")));
  });

  test("keeps extension fields on both parts of a split rule", () => {
    const parsed = parsePolicy(
      JSON.stringify({
        acls: [
          {
            action: "accept",
            src: ["carol@"],
            dst: ["10.0.0.1:443"],
            proto: "tcp",
            srcPosture: ["posture:managed"],
          },
        ],
      }),
    );
    const state = updateIpRule(parsed, parsed.rules[0].id, {
      source: "alice@,bob@",
      destination: "tag:server,10.0.0.0/8",
    });

    const next = removeTagAccessor(state, "tag:server", "alice@");

    expect(next.rules).toHaveLength(2);
    for (const rule of next.rules) {
      expect(rule.extras).toEqual({ proto: "tcp", srcPosture: ["posture:managed"] });
      expect(rule.ports).toBe("443");
    }
    expect(pairs(next)).not.toContain("alice@|tag:server|443");
    expect(pairs(next)).toContain("bob@|tag:server|443");
    expect(pairs(next)).toContain("alice@|10.0.0.0/8|443");
  });

  test("replacing an accessor on an NxN rule leaves exactly one rule for that pair", () => {
    let state: PolicyDesignerState = { ...emptyState(), rules: [] };
    state = addRule(state, createRule("alice@,bob@", "tag:server,tag:db", "22"));

    const next = setTagAccessor(
      removeTagAccessor(state, "tag:server", "alice@"),
      "tag:server",
      "alice@",
      "22",
    );

    expect(pairs(next).filter((pair) => pair.startsWith("alice@|tag:server|"))).toEqual([
      "alice@|tag:server|22",
    ]);
    expect(getTagAccessors(next, "tag:server").filter((a) => a.who === "alice@")).toHaveLength(1);
    const replaced = setTagAccessor(state, "tag:server", "alice@", "80");
    expect(pairs(replaced).filter((pair) => pair.startsWith("alice@|tag:server|"))).toEqual([
      "alice@|tag:server|80",
    ]);
  });
});

describe("getOpenAccessWarnings", () => {
  test.each(["0.0.0.0/0", "::/0"])("flags all-address source or destination %s", (cidr) => {
    const state = {
      ...emptyState(),
      rules: [createRule(cidr, "tag:server", "22"), createRule("alice@", cidr, "443")],
    };
    expect(getOpenAccessWarnings(state)).toHaveLength(2);
  });

  test("flags rules with wildcard source", () => {
    let state: PolicyDesignerState = { ...emptyState(), rules: [] };
    state = addRule(state, createRule("*", "tag:server", "22"));
    const warnings = getOpenAccessWarnings(state);
    expect(warnings).toHaveLength(1);
  });

  test("flags rules with wildcard destination", () => {
    let state: PolicyDesignerState = { ...emptyState(), rules: [] };
    state = addRule(state, createRule("group:ops", "*", "22"));
    const warnings = getOpenAccessWarnings(state);
    expect(warnings).toHaveLength(1);
  });

  test("ignores rules without wildcards", () => {
    let state: PolicyDesignerState = { ...emptyState(), rules: [] };
    state = addRule(state, createRule("group:ops", "tag:server", "22"));
    expect(getOpenAccessWarnings(state)).toEqual([]);
  });
});

describe("hasOnlyDefaultAccess", () => {
  test.each(["*", "0.0.0.0/0, ::/0"])(
    "does not hide protocol-restricted all-address access: %s",
    (target) => {
      const state = {
        ...emptyState(),
        rules: [{ ...createRule(target, target, "*"), extras: { proto: "tcp" } }],
      };
      expect(hasOnlyDefaultAccess(state)).toBe(false);
    },
  );

  test("recognizes the default before and after splitting its destinations on reload", () => {
    const state = emptyState();
    expect(hasOnlyDefaultAccess(state)).toBe(true);
    expect(hasOnlyDefaultAccess(parsePolicy(JSON.stringify(serializePolicy(state))))).toBe(true);
  });

  test("recognizes an existing explicit wildcard rule", () => {
    expect(hasOnlyDefaultAccess({ ...emptyState(), rules: [createRule("*", "*", "*")] })).toBe(
      true,
    );
  });

  test("does not hide additional or restricted rules as the default", () => {
    expect(
      hasOnlyDefaultAccess(addRule(emptyState(), createRule("alice@", "tag:server", "443"))),
    ).toBe(false);
    expect(
      hasOnlyDefaultAccess({
        ...emptyState(),
        rules: [createRule("0.0.0.0/0, ::/0", "0.0.0.0/0", "*")],
      }),
    ).toBe(false);
    expect(
      hasOnlyDefaultAccess({
        ...emptyState(),
        rules: [createRule("0.0.0.0/0, ::/0", "0.0.0.0/0, ::/0", "443")],
      }),
    ).toBe(false);
    expect(hasOnlyDefaultAccess({ ...emptyState(), rules: [] })).toBe(false);
  });
});

// Characterization: only applyTemplate replaces the open default. A single accessor
// checkbox must not silently turn an open tailnet into deny-all; the open-access
// banner and the IP-rule Remove button are the explicit way to close it.
test("setTagAccessor keeps the open default rule", () => {
  const state = setTagAccessor(parsePolicy("{}"), "tag:server", "group:ops", "22");

  expect(state.rules).toHaveLength(2);
  expect(hasOnlyDefaultAccess(state)).toBe(false);
  expect(getOpenAccessWarnings(state)).toHaveLength(1);
});

describe("getIpRules", () => {
  test("separates rules with IP/CIDR destinations from tag rules", () => {
    let state: PolicyDesignerState = { ...emptyState(), rules: [] };
    state = addRule(state, createRule("group:ops", "tag:server", "22"));
    state = addRule(state, createRule("group:ops", "10.0.0.1", "22"));
    state = addRule(state, createRule("group:ops", "192.168.0.0/24", "22"));

    const ipRules = getIpRules(state);
    expect(ipRules).toHaveLength(2);
    expect(ipRules.map((r) => r.destination).sort()).toEqual(["10.0.0.1", "192.168.0.0/24"]);
  });

  test("skips a rule that has no destination yet", () => {
    const state = {
      ...emptyState(),
      rules: [{ ...createRule("group:ops", "tag:server", "22"), destination: "" }],
    };

    expect(getIpRules(state)).toEqual([]);
  });

  test("exposes the reported allow-all ACL as an editable rule", () => {
    const state = parsePolicy(
      JSON.stringify({ acls: [{ action: "accept", src: ["*"], dst: ["*:*"] }] }),
    );

    expect(getOpenAccessWarnings(state)).toHaveLength(1);
    expect(getIpRules(state)).toEqual([
      { ruleId: state.rules[0].id, source: "*", destination: "*", ports: "*" },
    ]);
  });

  test("keeps wildcard targets visible with restricted ports or mixed tag targets", () => {
    const state = {
      ...emptyState(),
      rules: [
        createRule("group:ops", "*", "22"),
        createRule("group:ops", "tag:server,*", "443"),
        createRule("group:ops", "tag:server,tag:db", "22"),
      ],
    };

    expect(
      getIpRules(state).map(({ source, destination, ports }) => ({ source, destination, ports })),
    ).toEqual([
      { source: "group:ops", destination: "*", ports: "22" },
      { source: "group:ops", destination: "tag:server,*", ports: "443" },
    ]);
  });
});

describe("updateIpRule", () => {
  test("edits an individual ACL row without removing extension fields or changing sibling protocols", () => {
    const state = parsePolicy(
      JSON.stringify({
        acls: [
          {
            action: "accept",
            src: ["alice@"],
            dst: ["10.0.0.1:443"],
            proto: "tcp",
            srcPosture: ["posture:managed"],
          },
          { action: "accept", src: ["alice@"], dst: ["10.0.0.1:53"], proto: "udp" },
        ],
      }),
    );
    const edited = updateIpRule(state, state.rules[0].id, { ports: "8443" });

    expect(serializePolicy(edited).acls).toEqual([
      {
        action: "accept",
        src: ["alice@"],
        dst: ["10.0.0.1:8443"],
        proto: "tcp",
        srcPosture: ["posture:managed"],
      },
      { action: "accept", src: ["alice@"], dst: ["10.0.0.1:53"], proto: "udp" },
    ]);
  });

  test("patches source/destination/ports on the matching rule only", () => {
    let state: PolicyDesignerState = { ...emptyState(), rules: [] };
    state = addRule(state, createRule("group:ops", "10.0.0.1", "22"));
    state = addRule(state, createRule("group:dev", "10.0.0.2", "80"));
    const targetId = state.rules[0].id;

    const next = updateIpRule(state, targetId, {
      source: "group:sre",
      destination: "10.0.0.5",
      ports: "22,80",
    });

    expect(next.rules[0]).toMatchObject({
      id: targetId,
      source: "group:sre",
      destination: "10.0.0.5",
      ports: "22,80",
    });
    expect(next.rules[1]).toBe(state.rules[1]);
  });

  test("ignores unknown rule ids", () => {
    let state: PolicyDesignerState = { ...emptyState(), rules: [] };
    state = addRule(state, createRule("group:ops", "10.0.0.1", "22"));
    const next = updateIpRule(state, "nonexistent-id", { ports: "443" });
    expect(next.rules).toEqual(state.rules);
  });
});

describe("listTagsFromState", () => {
  test("collects tags from tagOwners and rules", () => {
    let state = emptyState();
    state = upsertTagOwner(state, createTagOwner("tag:server", [toMemberRef("group:ops")]));
    state = { ...state, rules: [] };
    state = addRule(state, createRule("group:ops", "tag:db", "5432"));
    state = addRule(state, createRule("tag:workstation", "tag:server", "22"));

    const tags = listTagsFromState(state);
    expect(tags).toContain("tag:server");
    expect(tags).toContain("tag:db");
    expect(tags).toContain("tag:workstation");
  });

  test("ignores destinations that are not tags", () => {
    let state: PolicyDesignerState = { ...emptyState(), rules: [] };
    state = addRule(state, createRule("tag:client", "10.0.0.0/8, group:ops", "22"));
    expect(listTagsFromState(state)).toEqual(["tag:client"]);
  });

  test("dedupes and sorts", () => {
    let state = emptyState();
    state = upsertTagOwner(state, createTagOwner("tag:b"));
    state = upsertTagOwner(state, createTagOwner("tag:a"));
    state = { ...state, rules: [] };
    state = addRule(state, createRule("group:x", "tag:a", "22"));

    expect(listTagsFromState(state)).toEqual(["tag:a", "tag:b"]);
  });
});

describe("listTagsFromState with a blank tag owner", () => {
  // The listing relies on this: a blank tagOwners key makes the whole policy unreadable.
  test("pasted policy text with a blank tag owner is rejected and lists no phantom tag", () => {
    const state = parsePolicy('{"tagOwners":{"":["alice@"],"tag:a":[]}}');
    expect(state.error).toBeTruthy();
    expect(state.tagOwners).toEqual([]);
    expect(listTagsFromState(state)).toEqual([]);
  });

  test("the designer refuses to add a blank tag owner", () => {
    const state = upsertTagOwner(emptyState(), createTagOwner("", [toMemberRef("alice@")]));
    expect(state.tagOwners).toEqual([]);
  });
});

describe("name prefix helpers", () => {
  test("stripTagPrefix removes 'tag:'", () => {
    expect(stripTagPrefix("tag:server")).toBe("server");
    expect(stripTagPrefix("server")).toBe("server");
  });

  test("stripGroupPrefix removes 'group:'", () => {
    expect(stripGroupPrefix("group:ops")).toBe("ops");
    expect(stripGroupPrefix("ops")).toBe("ops");
  });

  test("withTagPrefix adds 'tag:'", () => {
    expect(withTagPrefix("server")).toBe("tag:server");
    expect(withTagPrefix("tag:server")).toBe("tag:server");
    expect(withTagPrefix("  ")).toBe("");
  });

  test("withGroupPrefix adds 'group:'", () => {
    expect(withGroupPrefix("ops")).toBe("group:ops");
    expect(withGroupPrefix("group:ops")).toBe("group:ops");
    expect(withGroupPrefix("")).toBe("");
  });
});

describe("integration: setTagAccessor + getTagAccessors round-trip", () => {
  test("multi-step operations consistent", () => {
    let state: PolicyDesignerState = { ...emptyState(), rules: [] };
    state = upsertGroup(state, createGroup("group:ops"));
    state = upsertTagOwner(state, createTagOwner("tag:server"));

    state = setTagAccessor(state, "tag:server", "group:ops", "22");
    state = setTagAccessor(state, "tag:server", "alice@example.com", "80,443");

    const accessors = getTagAccessors(state, "tag:server");
    expect(accessors).toHaveLength(2);

    state = removeTagAccessor(state, "tag:server", "group:ops");
    const after = getTagAccessors(state, "tag:server");
    expect(after).toHaveLength(1);
    expect(after[0]?.who).toBe("alice@example.com");
  });
});
