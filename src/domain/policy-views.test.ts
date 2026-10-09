import { describe, expect, test } from "bun:test";
import {
  addRule,
  createGroup,
  createRule,
  createTagOwner,
  emptyState,
  parsePolicy,
  toMemberRef,
  upsertGroup,
  upsertTagOwner,
} from "./policy-designer";
import {
  getGroupAccess,
  getIpRules,
  getOpenAccessWarnings,
  getServicePresets,
  getTagAccessors,
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

test("service presets expose the supported built-in port groups", () => {
  expect(getServicePresets()).toEqual([
    { id: "all", ports: ["*"] },
    { id: "ssh", ports: ["22"] },
    { id: "web", ports: ["80", "443"] },
    { id: "rdp", ports: ["3389"] },
    { id: "dns", ports: ["53"] },
  ]);
});

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
    let state = { ...emptyState(), rules: [] };
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
  test("creates a new rule when accessor doesn't exist", () => {
    const state = { ...emptyState(), rules: [] };
    const next = setTagAccessor(state, "tag:server", "alice@example.com", "22");
    expect(next.rules).toHaveLength(1);
    expect(next.rules[0]?.source).toBe("alice@example.com");
    expect(next.rules[0]?.destination).toBe("tag:server");
    expect(next.rules[0]?.ports).toBe("22");
  });

  test("replaces existing accessor rule (idempotent on services change)", () => {
    let state = { ...emptyState(), rules: [] };
    state = setTagAccessor(state, "tag:server", "alice@example.com", "22");
    state = setTagAccessor(state, "tag:server", "alice@example.com", "80,443");

    expect(state.rules).toHaveLength(1);
    expect(state.rules[0]?.ports).toBe("80,443");
  });

  test("setTagAccessor with empty ports removes the accessor", () => {
    let state = { ...emptyState(), rules: [] };
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
    let state = { ...emptyState(), rules: [] };
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
  test("removes rule cleanly when single source and destination", () => {
    let state = { ...emptyState(), rules: [] };
    state = setTagAccessor(state, "tag:server", "alice@example.com", "22");
    state = removeTagAccessor(state, "tag:server", "alice@example.com");
    expect(state.rules).toHaveLength(0);
  });

  test("trims source when rule has multiple sources", () => {
    let state = { ...emptyState(), rules: [] };
    state = addRule(state, createRule("alice@example.com,bob@example.com", "tag:server", "22"));
    state = removeTagAccessor(state, "tag:server", "alice@example.com");

    expect(state.rules).toHaveLength(1);
    expect(state.rules[0]?.source).toBe("bob@example.com");
  });

  test("trims destination when rule has multiple destinations and one source", () => {
    let state = { ...emptyState(), rules: [] };
    state = addRule(state, createRule("alice@example.com", "tag:server,tag:db", "22"));
    state = removeTagAccessor(state, "tag:server", "alice@example.com");

    expect(state.rules).toHaveLength(1);
    expect(state.rules[0]?.destination).toBe("tag:db");
  });

  test("preserves a multi-source, multi-destination rule to avoid changing its cross-product", () => {
    let state = { ...emptyState(), rules: [] };
    const sharedRule = createRule(
      "user@example.test,group:testers",
      "tag:service,tag:database",
      "22",
    );
    state = addRule(state, sharedRule);

    const next = removeTagAccessor(state, "tag:service", "user@example.test");

    expect(next.rules).toEqual([sharedRule]);
  });
});

describe("getOpenAccessWarnings", () => {
  test("flags rules with wildcard source", () => {
    let state = { ...emptyState(), rules: [] };
    state = addRule(state, createRule("*", "tag:server", "22"));
    const warnings = getOpenAccessWarnings(state);
    expect(warnings).toHaveLength(1);
  });

  test("flags rules with wildcard destination", () => {
    let state = { ...emptyState(), rules: [] };
    state = addRule(state, createRule("group:ops", "*", "22"));
    const warnings = getOpenAccessWarnings(state);
    expect(warnings).toHaveLength(1);
  });

  test("ignores rules without wildcards", () => {
    let state = { ...emptyState(), rules: [] };
    state = addRule(state, createRule("group:ops", "tag:server", "22"));
    expect(getOpenAccessWarnings(state)).toEqual([]);
  });
});

describe("getIpRules", () => {
  test("separates rules with IP/CIDR destinations from tag rules", () => {
    let state = { ...emptyState(), rules: [] };
    state = addRule(state, createRule("group:ops", "tag:server", "22"));
    state = addRule(state, createRule("group:ops", "10.0.0.1", "22"));
    state = addRule(state, createRule("group:ops", "192.168.0.0/24", "22"));

    const ipRules = getIpRules(state);
    expect(ipRules).toHaveLength(2);
    expect(ipRules.map((r) => r.destination).sort()).toEqual(["10.0.0.1", "192.168.0.0/24"]);
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
  test("patches source/destination/ports on the matching rule only", () => {
    let state = { ...emptyState(), rules: [] };
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
    let state = { ...emptyState(), rules: [] };
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

  test("dedupes and sorts", () => {
    let state = emptyState();
    state = upsertTagOwner(state, createTagOwner("tag:b"));
    state = upsertTagOwner(state, createTagOwner("tag:a"));
    state = { ...state, rules: [] };
    state = addRule(state, createRule("group:x", "tag:a", "22"));

    expect(listTagsFromState(state)).toEqual(["tag:a", "tag:b"]);
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
    let state = { ...emptyState(), rules: [] };
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
