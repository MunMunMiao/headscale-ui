import { describe, expect, test } from "vitest";
import { createRule, emptyState, parsePolicy, serializePolicy } from "./policy-designer";
import { applyTemplate, POLICY_TEMPLATES, type PolicyTemplate } from "./policy-templates";
import { hasOnlyDefaultAccess } from "./policy-views";

const triple = ({
  source,
  destination,
  ports,
}: {
  source: string;
  destination: string;
  ports: string;
}) => ({
  source,
  destination,
  ports,
});
const OPEN_STATES: [string, () => ReturnType<typeof emptyState>][] = [
  ["emptyState()", () => emptyState()],
  ["blank text", () => parsePolicy("")],
  ["{}", () => parsePolicy("{}")],
  ["reloaded default pair", () => parsePolicy(JSON.stringify(serializePolicy(emptyState())))],
  [
    "explicit allow-all",
    () => parsePolicy('{"acls":[{"action":"accept","src":["*"],"dst":["*:*"]}]}'),
  ],
];

describe("policy templates", () => {
  test("applying a template cannot make an unparsed policy writable", () => {
    const state = parsePolicy('{"acls":');
    const next = applyTemplate(state, POLICY_TEMPLATES[1]);

    expect(() => serializePolicy(next)).toThrow();
  });

  test("builds every supported template with independent policy objects", () => {
    expect(POLICY_TEMPLATES.map((template) => template.id)).toEqual([
      "self-only",
      "small-team",
      "split-env",
    ]);

    const selfOnly = POLICY_TEMPLATES[0].build();
    expect(
      selfOnly.rules?.map(({ source, destination, ports }) => ({ source, destination, ports })),
    ).toEqual([{ source: "*", destination: "tag:personal", ports: "*" }]);
    expect(selfOnly.groups).toEqual([]);
    expect(selfOnly.tagOwners?.map(({ tag, owners }) => ({ tag, owners }))).toEqual([
      { tag: "tag:personal", owners: [] },
    ]);

    const smallTeam = POLICY_TEMPLATES[1].build();
    expect(smallTeam.groups?.map((group) => group.name)).toEqual(["group:team"]);
    expect(smallTeam.tagOwners?.map(({ tag, owners }) => ({ tag, owners }))).toEqual([
      { tag: "tag:shared", owners: [{ kind: "group", value: "group:team" }] },
    ]);
    expect(smallTeam.rules?.[0]).toMatchObject({
      source: "group:team",
      destination: "tag:shared",
      ports: "22,80,443",
    });

    const splitEnv = POLICY_TEMPLATES[2].build();
    expect(splitEnv.groups?.map((group) => group.name)).toEqual(["group:dev", "group:ops"]);
    expect(splitEnv.tagOwners?.map((owner) => owner.tag)).toEqual([
      "tag:dev-server",
      "tag:prod-server",
    ]);
    expect(
      splitEnv.rules?.map(({ source, destination, ports }) => ({ source, destination, ports })),
    ).toEqual([
      { source: "group:dev", destination: "tag:dev-server", ports: "22,80,443" },
      {
        source: "group:ops",
        destination: "tag:dev-server,tag:prod-server",
        ports: "*",
      },
    ]);

    expect(POLICY_TEMPLATES[2].build().groups?.[0]?.id).not.toBe(splitEnv.groups?.[0]?.id);
  });

  test("applies template content to the empty state while preserving existing state", () => {
    const state = emptyState();
    state.extras = { hosts: { demo: "192.0.2.10" } };

    const merged = applyTemplate(state, POLICY_TEMPLATES[1]);
    expect(merged.rules.map(triple)).toEqual([
      { source: "group:team", destination: "tag:shared", ports: "22,80,443" },
    ]);
    expect(merged.groups.map((group) => group.name)).toEqual(["group:team"]);
    expect(merged.tagOwners.map((owner) => owner.tag)).toEqual(["tag:shared"]);
    expect(merged.extras).toBe(state.extras);
    expect(state.groups).toEqual([]);
    expect(state.rules).toHaveLength(1);

    const emptyTemplate: PolicyTemplate = {
      id: "self-only",
      titleKey: "unusedTitle",
      descriptionKey: "unusedDescription",
      build: () => ({}),
    };
    expect(applyTemplate(state, emptyTemplate)).toEqual(state);
  });

  describe("over the open default rule", () => {
    const cases = POLICY_TEMPLATES.flatMap((template) =>
      OPEN_STATES.map(([name, make]) => ({ id: template.id, name, template, make })),
    );

    test.each(cases)("$id replaces the open default ($name)", ({ template, make }) => {
      const applied = applyTemplate(make(), template);

      expect(applied.rules.map(triple)).toEqual((template.build().rules ?? []).map(triple));
      const acls = JSON.stringify(serializePolicy(applied).acls);
      expect(acls).not.toContain("0.0.0.0/0");
      expect(acls).not.toContain("::/0");
      expect(acls).not.toContain("*:*");
      expect(hasOnlyDefaultAccess(parsePolicy(JSON.stringify(serializePolicy(applied))))).toBe(
        false,
      );
    });

    test("appends to scoped rules and to the default with extras", () => {
      const scoped = { ...emptyState(), rules: [createRule("alice@", "tag:server", "443")] };
      const withDefault = { ...emptyState() };
      withDefault.rules = [...withDefault.rules, createRule("alice@", "tag:server", "443")];
      const withExtras = emptyState();
      withExtras.rules = [{ ...withExtras.rules[0], extras: { proto: "tcp" } }];

      for (const state of [scoped, withDefault, withExtras]) {
        const applied = applyTemplate(state, POLICY_TEMPLATES[1]);
        expect(applied.rules.slice(0, state.rules.length)).toEqual(state.rules);
        expect(applied.rules).toHaveLength(state.rules.length + 1);
      }
    });

    test("deny-all policy gets exactly the template rules", () => {
      const applied = applyTemplate(parsePolicy('{"acls":[]}'), POLICY_TEMPLATES[2]);
      expect(applied.rules.map(triple)).toEqual(
        (POLICY_TEMPLATES[2].build().rules ?? []).map(triple),
      );
    });
  });
});
