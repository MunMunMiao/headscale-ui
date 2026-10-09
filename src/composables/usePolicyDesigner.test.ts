import { beforeEach, describe, expect, test } from "bun:test";
import { type PolicyDesignerState, toMemberRef } from "@/domain/policy-designer";
import { policyDesignerTestingHandle, usePolicyDesigner } from "./usePolicyDesigner";

beforeEach(() => policyDesignerTestingHandle.reset());

const state = (): PolicyDesignerState => ({
  rules: [
    { id: "wide", action: "accept", source: "*", destination: "*", ports: "*" },
    { id: "narrow", action: "accept", source: "group:ops", destination: "tag:web", ports: "443" },
  ],
  groups: [
    { id: "ops", name: "group:ops", members: [toMemberRef("alice@example.com")] },
    { id: "dev", name: "group:dev", members: [toMemberRef("bob@example.com")] },
  ],
  tagOwners: [
    { id: "web", tag: "tag:web", owners: [toMemberRef("group:ops")] },
    { id: "db", tag: "tag:db", owners: [toMemberRef("carol@example.com")] },
  ],
  extras: { zeta: true, alpha: 1 },
});

describe("usePolicyDesigner", () => {
  test("treats an unserializable draft as dirty so refresh cannot discard it", () => {
    const designer = usePolicyDesigner();
    designer.load('{"acls":[]}');
    const extras: Record<string, unknown> = {};
    extras.circular = extras;
    designer.policyExtraSections.value = extras;

    expect(designer.isPolicyDirty.value).toBe(true);
    expect(designer.policyExtraSections.value.circular).toBe(designer.policyExtraSections.value);
    expect(designer.policyDraft.value).toBe('{"acls":[]}');
  });

  test("tracks a canonical saved baseline, including initially empty policies", () => {
    const designer = usePolicyDesigner();
    const saved = '{"acls":[], "tagOwners":{}, "groups":{"group:ops":["alice@example.com"]}}';
    designer.load(saved);
    expect(designer.policyDraft.value).toBe(saved);
    expect(designer.isPolicyDirty.value).toBe(false);

    designer.policyGroups.value[0].members.push(toMemberRef("bob@example.com"));
    expect(designer.isPolicyDirty.value).toBe(true);
    designer.policyDraft.value = JSON.stringify(designer.policyPayload.value, null, 2);
    expect(designer.isPolicyDirty.value).toBe(false);

    designer.load("");
    expect(designer.isPolicyDirty.value).toBe(false);
    designer.addPolicyGroup();
    expect(designer.isPolicyDirty.value).toBe(true);
  });

  test("shares initial state and exposes stable choice and risk helpers", () => {
    const designer = usePolicyDesigner();

    expect(usePolicyDesigner()).toBe(designer);
    expect(designer.policyChoiceId("source", " Group:Ops / Admin ")).toBe("source-group-ops-admin");
    expect(designer.policyChoiceId("ports", "***")).toBe("ports-any");
    expect(designer.isPolicyRuleHighRisk({ source: " * ", destination: "*", ports: " *" })).toBe(
      true,
    );
    expect(
      designer.isPolicyRuleHighRisk({ source: "group:ops", destination: "*", ports: "*" }),
    ).toBe(false);

    const members = [toMemberRef("alice@example.com")];
    expect(designer.addUniqueMemberRef(members, " ")).toBe(members);
    expect(designer.addUniqueMemberRef(members, " alice@example.com ")).toBe(members);
    expect(designer.addUniqueMemberRef(members, " group:ops ")).toEqual([
      ...members,
      toMemberRef("group:ops"),
    ]);
  });

  test("commits, filters, serializes, and loads policy state", () => {
    const designer = usePolicyDesigner();
    const next = state();
    designer.commitState(next);

    expect(designer.policyDesignerState.value).toEqual(next);
    expect(designer.policyPayload.value).toMatchObject({ zeta: true, alpha: 1 });
    expect(designer.policyExtraSectionKeys.value).toEqual(["alpha", "zeta"]);
    expect(designer.policyRiskCount.value).toBe(1);
    expect(designer.filteredPolicyGroups.value).toBe(designer.policyGroups.value);
    expect(designer.filteredPolicyTagOwners.value).toBe(designer.policyTagOwners.value);

    designer.policyGroupSearch.value = "ALICE";
    designer.policyTagOwnerSearch.value = "CAROL";
    expect(designer.filteredPolicyGroups.value.map((group) => group.id)).toEqual(["ops"]);
    expect(designer.filteredPolicyTagOwners.value.map((owner) => owner.id)).toEqual(["db"]);

    designer.load(
      JSON.stringify({
        acls: [{ action: "accept", src: ["group:loaded"], dst: ["tag:loaded:22"] }],
        groups: { "group:loaded": ["loaded@example.com"] },
        tagOwners: { "tag:loaded": ["group:loaded"] },
        hosts: { db: "100.64.0.1" },
      }),
    );
    expect(designer.policyRules.value[0]).toMatchObject({
      source: "group:loaded",
      destination: "tag:loaded",
      ports: "22",
    });
    expect(designer.policyGroups.value[0]?.name).toBe("group:loaded");
    expect(designer.policyTagOwners.value[0]?.tag).toBe("tag:loaded");
    expect(designer.policyExtraSections.value).toEqual({ hosts: { db: "100.64.0.1" } });
  });

  test("adds rules with defaults and closes the rule dialog", () => {
    const designer = usePolicyDesigner();
    designer.policyRules.value = [];
    designer.policyRuleForm.source = "";
    designer.policyRuleForm.destination = "";
    designer.policyRuleForm.ports = "";
    designer.policyRuleDialogOpen.value = true;

    designer.addPolicyRule();

    expect(designer.policyRules.value).toHaveLength(1);
    expect(designer.policyRules.value[0]).toMatchObject({
      action: "accept",
      source: "*",
      destination: "*",
      ports: "*",
    });
    expect(designer.policyRuleDialogOpen.value).toBe(false);
  });

  test("creates and edits groups while ignoring blank names", () => {
    const designer = usePolicyDesigner();
    designer.policyGroups.value = [];
    designer.policyGroupForm.name = " ";
    designer.addPolicyGroup();
    expect(designer.policyGroups.value).toEqual([]);

    designer.policyGroupForm.name = " group:new ";
    designer.policyGroupForm.members = [toMemberRef("alice@example.com")];
    designer.policyGroupDialogOpen.value = true;
    designer.addPolicyGroup();
    expect(designer.policyGroups.value[0]).toMatchObject({ name: "group:new" });
    expect(designer.policyGroupDialogOpen.value).toBe(false);

    const existing = designer.policyGroups.value[0];
    if (!existing) throw new Error("Expected the group to be created");
    designer.policyGroupEditing.value = existing;
    designer.policyGroupForm.name = "group:renamed";
    designer.policyGroupForm.members = [toMemberRef("bob@example.com")];
    designer.addPolicyGroup();
    expect(designer.policyGroups.value).toHaveLength(1);
    expect(designer.policyGroups.value[0]?.id).toBe(existing.id);
    expect(designer.policyGroups.value[0]?.name).toBe("group:renamed");
    expect(designer.policyGroups.value[0]?.members.map((member) => member.value)).toEqual([
      "bob@example.com",
    ]);
    expect(designer.policyGroupEditing.value).toBeNull();
  });

  test("creates and edits tag owners while ignoring blank tags", () => {
    const designer = usePolicyDesigner();
    designer.policyTagOwners.value = [];
    designer.policyTagOwnerForm.tag = " ";
    designer.addPolicyTagOwner();
    expect(designer.policyTagOwners.value).toEqual([]);

    designer.policyTagOwnerForm.tag = " tag:new ";
    designer.policyTagOwnerForm.owners = [toMemberRef("group:ops")];
    designer.policyTagOwnerDialogOpen.value = true;
    designer.addPolicyTagOwner();
    expect(designer.policyTagOwners.value[0]).toMatchObject({ tag: "tag:new" });
    expect(designer.policyTagOwnerDialogOpen.value).toBe(false);

    const existing = designer.policyTagOwners.value[0];
    if (!existing) throw new Error("Expected the tag owner to be created");
    designer.policyTagOwnerEditing.value = existing;
    designer.policyTagOwnerForm.tag = "tag:renamed";
    designer.policyTagOwnerForm.owners = [toMemberRef("carol@example.com")];
    designer.addPolicyTagOwner();
    expect(designer.policyTagOwners.value).toHaveLength(1);
    expect(designer.policyTagOwners.value[0]?.id).toBe(existing.id);
    expect(designer.policyTagOwners.value[0]?.tag).toBe("tag:renamed");
    expect(designer.policyTagOwners.value[0]?.owners.map((owner) => owner.value)).toEqual([
      "carol@example.com",
    ]);
    expect(designer.policyTagOwnerEditing.value).toBeNull();
  });

  test("removes rules, groups, and tag owners by id", () => {
    const designer = usePolicyDesigner();
    designer.commitState(state());

    designer.removeRule("wide");
    designer.removeGroup("ops");
    designer.removeTagOwner("web");

    expect(designer.policyRules.value.map((rule) => rule.id)).toEqual(["narrow"]);
    expect(designer.policyGroups.value.map((group) => group.id)).toEqual(["dev"]);
    expect(designer.policyTagOwners.value.map((owner) => owner.id)).toEqual(["db"]);
  });
});
