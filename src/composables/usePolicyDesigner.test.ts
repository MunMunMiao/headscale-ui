import { describe, expect, test } from "vitest";
import {
  createGroup,
  createRule,
  type PolicyDesignerState,
  parsePolicy,
  removeRuleById,
  toMemberRef,
  upsertGroup,
} from "@/domain/policy-designer";
import { addRule } from "@/test/policy-state";
import {
  createPolicyDesignerStore,
  POLICY_FILE_MODE_WITHOUT_PATH,
  policyBlockedMessage,
} from "./usePolicyDesigner";

const state = (): PolicyDesignerState => ({
  rules: [
    { id: "wide", action: "accept", source: "*", destination: "*", ports: "*" },
    { id: "narrow", action: "accept", source: "group:ops", destination: "tag:web", ports: "443" },
  ],
  groups: [{ id: "ops", name: "group:ops", members: [toMemberRef("alice@example.com")] }],
  tagOwners: [{ id: "web", tag: "tag:web", owners: [toMemberRef("group:ops")] }],
  extras: { hosts: { db: "100.64.0.1" } },
});

describe("policy draft store", () => {
  test("keeps an unreadable policy untouched until a valid load repairs it", () => {
    const designer = createPolicyDesignerStore();
    designer.load('{"groups":{"group:previous":["alice@"]},"acls":[]}');
    const unreadable = '{"acls":[';
    designer.load(unreadable);
    designer.commitState(state());
    expect(designer.policyPayload).toBeNull();
    expect(designer.getSnapshot().policyDraft).toBe(unreadable);
    expect(designer.policyDesignerState).toMatchObject({ rules: [], groups: [], tagOwners: [] });
    expect(designer.isPolicyDirty).toBe(false);
    expect(designer.beginSave(state())).toBeNull();
    designer.load('{"groups":{"group:repaired":["bob@"]},"acls":[]}');
    expect(designer.policyPayload).toMatchObject({
      groups: { "group:repaired": ["bob@"] },
      acls: [],
    });
    designer.commitState(
      addRule(designer.policyDesignerState, createRule("bob@", "tag:web", "443")),
    );
    expect(designer.isPolicyDirty).toBe(true);
  });

  test("keeps an unserializable draft dirty so refresh cannot discard it", () => {
    const designer = createPolicyDesignerStore();
    designer.load('{"acls":[]}');
    const extras: Record<string, unknown> = {};
    extras.circular = extras;
    designer.commitState({ ...designer.policyDesignerState, extras });
    expect(designer.isPolicyDirty).toBe(true);
    expect(designer.getSnapshot().policyExtraSections.circular).toBe(extras);
    expect(designer.getSnapshot().policyDraft).toBe('{"acls":[]}');
    expect(designer.beginSave(designer.policyDesignerState)).toBeNull();
  });

  test("an incomplete edited rule is unsaved and cannot be serialized", () => {
    const designer = createPolicyDesignerStore();
    designer.load('{"acls":[{"action":"accept","src":["alice@"],"dst":["10.0.0.1:22"]}]}');
    const current = designer.policyDesignerState;
    designer.commitState({
      ...current,
      rules: current.rules.map((rule) => ({ ...rule, ports: " " })),
    });
    expect(designer.policyPayload).toBeNull();
    expect(designer.isPolicyDirty).toBe(true);
    expect(designer.getSnapshot().policyRules[0]?.ports).toBe(" ");
  });

  test("tracks a canonical accepted baseline, including initially empty policies", () => {
    const designer = createPolicyDesignerStore();
    const saved = '{"acls":[], "tagOwners":{}, "groups":{"group:ops":["alice@example.com"]}}';
    designer.load(saved);
    expect(designer.getSnapshot().policyDraft).toBe(saved);
    expect(designer.isPolicyDirty).toBe(false);
    const current = designer.policyDesignerState;
    designer.commitState({
      ...current,
      groups: current.groups.map((group) => ({
        ...group,
        members: [...group.members, toMemberRef("bob@example.com")],
      })),
    });
    expect(designer.isPolicyDirty).toBe(true);
    const ticket = designer.beginSave(designer.policyDesignerState);
    if (!ticket) throw new Error("Expected a writable policy");
    designer.acceptSavedPolicy(ticket, ticket.submittedText);
    designer.finishSave(ticket.operationId);
    expect(designer.isPolicyDirty).toBe(false);
    designer.load("");
    expect(designer.isPolicyDirty).toBe(false);
    designer.commitState(upsertGroup(designer.policyDesignerState, createGroup("group:new")));
    expect(designer.isPolicyDirty).toBe(true);
  });

  test("isolates stores and loads the complete structured policy", () => {
    const designer = createPolicyDesignerStore();
    const other = createPolicyDesignerStore();
    designer.commitState(state());
    expect(other.getSnapshot()).not.toBe(designer.getSnapshot());
    expect(other.policyDesignerState.rules).toEqual([]);
    expect(designer.policyDesignerState).toEqual(state());
    designer.load(
      JSON.stringify({
        acls: [{ action: "accept", src: ["group:loaded"], dst: ["tag:loaded:22"] }],
        groups: { "group:loaded": ["loaded@example.com"] },
        tagOwners: { "tag:loaded": ["group:loaded"] },
        hosts: { db: "100.64.0.1" },
      }),
    );
    expect(designer.getSnapshot().policyRules[0]).toMatchObject({
      source: "group:loaded",
      destination: "tag:loaded",
      ports: "22",
    });
    expect(designer.getSnapshot().policyGroups[0]?.name).toBe("group:loaded");
    expect(designer.getSnapshot().policyTagOwners[0]?.tag).toBe("tag:loaded");
    expect(designer.getSnapshot().policyExtraSections).toEqual({ hosts: { db: "100.64.0.1" } });
  });

  test("advances edit revision only for structured draft changes", () => {
    const designer = createPolicyDesignerStore();
    designer.load('{"acls":[],"groups":{"group:ops":["alice@"]}}');
    const revision = designer.getSnapshot().editRevision;
    designer.setState({ teamDetailOpen: true, teamDetailCurrent: "group:ops" });
    designer.commitState(parsePolicy(designer.getSnapshot().policyDraft));
    expect(designer.getSnapshot().editRevision).toBe(revision);
    designer.commitState(upsertGroup(designer.policyDesignerState, createGroup("group:new")));
    expect(designer.getSnapshot().editRevision).toBe(revision + 1);
  });

  test("ignores completion from a ticket replaced by a new loaded session", () => {
    const designer = createPolicyDesignerStore();
    designer.load('{"acls":[]}');
    const old = designer.beginSave(designer.policyDesignerState);
    if (!old) throw new Error("Missing old save ticket");
    designer.load('{"acls":[],"groups":{"group:new":["new@"]}}');
    const current = designer.beginSave(designer.policyDesignerState);
    if (!current) throw new Error("Missing current save ticket");
    const before = designer.getSnapshot();
    expect(designer.acceptSavedPolicy(old, old.submittedText)).toEqual({ hasNewerEdits: true });
    designer.finishSave(old.operationId);
    expect(designer.getSnapshot()).toBe(before);
    expect(designer.isPolicySaving).toBe(true);
    designer.finishSave(current.operationId);
    expect(designer.isPolicySaving).toBe(false);
  });

  test("keeps an unreadable accepted response as baseline and disables later writes", () => {
    const designer = createPolicyDesignerStore();
    designer.load('{"acls":[]}');
    const ticket = designer.beginSave(designer.policyDesignerState);
    if (!ticket) throw new Error("Missing save ticket");
    const accepted = '{"acls":[';
    designer.acceptSavedPolicy(ticket, accepted);
    expect(designer.getSnapshot().policyDraft).toBe(accepted);
    expect(designer.policyPayload).toBeNull();
    expect(designer.policyDesignerState.error).toBeTruthy();
  });
});

describe("policy workspace lifecycle", () => {
  test("publishes a loaded policy and its saved draft together", () => {
    const designer = createPolicyDesignerStore();
    designer.load('{"acls":[]}');
    const dirtyStates: boolean[] = [];
    const unsubscribe = designer.subscribe(() => dirtyStates.push(designer.isPolicyDirty));
    designer.load('{"acls":[],"groups":{"group:ops":["alice@example.com"]}}');
    unsubscribe();
    expect(dirtyStates.length).toBeGreaterThan(0);
    expect(dirtyStates.every((dirty) => !dirty)).toBe(true);
  });

  test.each([
    { editingIpRuleId: "rule" },
    { assignMembershipsOpen: true },
    { assignTagOwnershipsOpen: true },
    { tagDetailOpen: true },
    { teamDetailOpen: true },
    { policyRemovalDialogOpen: true },
    { highRiskConfirmOpen: true },
  ])("protects each active editor from background replacement: %j", (patch) => {
    const designer = createPolicyDesignerStore();
    expect(designer.isPolicyEditing).toBe(false);
    designer.setState(patch);
    expect(designer.isPolicyEditing).toBe(true);
    designer.load('{"acls":[]}');
    expect(designer.isPolicyEditing).toBe(false);
  });

  test("closes Access editors without clearing Members assignments or current policy", () => {
    const designer = createPolicyDesignerStore();
    designer.commitState(state());
    const previous = designer.getSnapshot();
    designer.setState({
      editingIpRuleId: "wide",
      tagDetailOpen: true,
      tagDetailCurrent: "tag:web",
      teamDetailOpen: true,
      teamDetailCurrent: "group:ops",
      policyRemovalDialogOpen: true,
      pendingPolicyRemoval: { kind: "group", id: "ops", label: "Operations" },
      highRiskConfirmOpen: true,
      pendingHighRiskAction: () =>
        designer.commitState(removeRuleById(designer.policyDesignerState, "wide")),
      assignMembershipsOpen: true,
      assignTagOwnershipsOpen: true,
    });
    designer.closeAccessEditors();
    expect(designer.getSnapshot()).toMatchObject({
      editingIpRuleId: null,
      tagDetailOpen: false,
      tagDetailCurrent: "",
      teamDetailOpen: false,
      teamDetailCurrent: "",
      policyRemovalDialogOpen: false,
      pendingPolicyRemoval: null,
      highRiskConfirmOpen: false,
      pendingHighRiskAction: null,
      assignMembershipsOpen: true,
      assignTagOwnershipsOpen: true,
    });
    expect(designer.getSnapshot().policyRules).toBe(previous.policyRules);
    expect(designer.policyDesignerState).toEqual(state());
  });
});

describe("policy file mode without a path", () => {
  test("locks the designer behind the existing policy error gate and survives loads", () => {
    const designer = createPolicyDesignerStore();
    designer.load('{"acls":[]}');
    designer.setFileModeWithoutPath(true);
    expect(designer.getSnapshot().policyError).toBe(POLICY_FILE_MODE_WITHOUT_PATH);
    expect(designer.beginSave(state())).toBeNull();
    expect(designer.policyPayload).toBeNull();
    expect(designer.isPolicyDirty).toBe(false);
    const rules = designer.getSnapshot().policyRules;
    designer.commitState(state());
    expect(designer.getSnapshot().policyRules).toBe(rules);
    designer.load("");
    expect(designer.getSnapshot().policyError).toBe(POLICY_FILE_MODE_WITHOUT_PATH);
    designer.setFileModeWithoutPath(true);
    expect(designer.getSnapshot().policyError).toBe(POLICY_FILE_MODE_WITHOUT_PATH);
  });

  test("closes open editors when locking and keeps the lock after a save is accepted", () => {
    const designer = createPolicyDesignerStore();
    designer.load('{"acls":[]}');
    const ticket = designer.beginSave(state());
    if (!ticket) throw new Error("expected save ticket");
    designer.setState({ tagDetailOpen: true, editingIpRuleId: "wide" });
    designer.setFileModeWithoutPath(true);
    expect(designer.isPolicyEditing).toBe(false);
    designer.acceptSavedPolicy(ticket, '{"acls":[]}');
    expect(designer.getSnapshot().policyError).toBe(POLICY_FILE_MODE_WITHOUT_PATH);
  });

  test("unlocking restores the parse state of the draft", () => {
    const designer = createPolicyDesignerStore();
    designer.load('{"acls":[]}');
    designer.setFileModeWithoutPath(true);
    designer.setFileModeWithoutPath(false);
    expect(designer.getSnapshot().policyError).toBeNull();
    designer.load('{"acls":[');
    const parseError = designer.getSnapshot().policyError;
    expect(parseError).toBeTruthy();
    designer.setFileModeWithoutPath(true);
    designer.setFileModeWithoutPath(false);
    expect(designer.getSnapshot().policyError).toBe(parseError);
  });

  test("picks the blocked copy matching the policy error", () => {
    const copy = { policyReadOnlyError: "unreadable", policyFileModeNoPath: "no path" };
    expect(policyBlockedMessage(copy, POLICY_FILE_MODE_WITHOUT_PATH)).toBe("no path");
    expect(policyBlockedMessage(copy, "Unexpected token")).toBe("unreadable");
  });
});
