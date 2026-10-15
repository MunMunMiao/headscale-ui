import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createGroup, parsePolicy, removeRuleById, upsertGroup } from "@/domain/policy-designer";
import { __resetForTest } from "@/lib/idb";
import { hydrateSettings, settingsStorageTestingHandle } from "@/lib/settings-storage";
import { defaultPolicy, sessionPolicyFixture } from "@/test/session-policy-fixture";
import { POLICY_FILE_MODE_WITHOUT_PATH } from "./usePolicyDesigner";
import { createPolicySave } from "./usePolicySave";

const cleanup: (() => void | Promise<void>)[] = [];
beforeEach(async () => {
  __resetForTest();
  globalThis.indexedDB = new IDBFactory();
  settingsStorageTestingHandle.reset();
  await hydrateSettings();
});
afterEach(async () => {
  for (const stop of cleanup.reverse().splice(0)) await stop();
});
const fixture = (text?: string) => sessionPolicyFixture(cleanup, text);
const richPolicy =
  '{"acls":[{"action":"accept","src":["group:ops"],"dst":["tag:server:443"]}],"groups":{"group:ops":["alice@"]},"tagOwners":{"tag:server":["alice@"]}}';

test("unchanged policy refresh preserves the existing card objects", async () => {
  const { session, server } = await fixture(richPolicy);
  const { snapshot, policy } = session;
  const before = policy.getSnapshot();
  const reads = server.requests.filter((request) => request === "GET /api/v1/policy").length;
  await snapshot.refreshSegments(["policy"]);
  expect(server.requests.filter((request) => request === "GET /api/v1/policy")).toHaveLength(
    reads + 1,
  );
  expect(policy.getSnapshot().policyRules[0]).toBe(before.policyRules[0]);
  expect(policy.getSnapshot().policyGroups[0]).toBe(before.policyGroups[0]);
  expect(policy.getSnapshot().policyTagOwners[0]).toBe(before.policyTagOwners[0]);
  expect(policy.isPolicyDirty).toBe(false);
});

test("switching to the same policy retains edited input until explicit discard", async () => {
  const { session, switchTo } = await fixture();
  const { policy } = session;
  const baseline = policy.getSnapshot().policyDraft;
  policy.commitState(
    removeRuleById(policy.policyDesignerState, policy.getSnapshot().policyRules[0].id),
  );
  policy.setState({ tagDetailOpen: true });
  await switchTo(defaultPolicy);
  expect(policy.getSnapshot().policyDraft).toBe(baseline);
  expect(policy.getSnapshot().policyRules).toEqual([]);
  expect(policy.isPolicyDirty).toBe(true);
  expect(policy.getSnapshot().tagDetailOpen).toBe(true);
  expect(session.drafts.isCurrent()).toBe(false);
  session.discardDrafts();
  expect(policy.getSnapshot().policyRules).toHaveLength(1);
  expect(policy.isPolicyDirty).toBe(false);
  expect(policy.isPolicyEditing).toBe(false);
});

test("edits made during a route refresh survive and are sent as the saved payload", async () => {
  const { session, server, router } = await fixture();
  const { snapshot, policy } = session;
  const baseline = policy.getSnapshot().policyDraft;
  const pending = server.holdNext("GET");
  await router.navigate({ to: "/secure-two" });
  await pending.entered;
  expect(snapshot.isRefreshing).toBe(true);
  policy.commitState(
    removeRuleById(policy.policyDesignerState, policy.getSnapshot().policyRules[0].id),
  );
  pending.release();
  await expect.poll(() => snapshot.isRefreshing).toBe(false);
  expect(policy.getSnapshot().policyDraft).toBe(baseline);
  expect(policy.isPolicyDirty).toBe(true);
  expect(
    (await createPolicySave(session).savePolicy("save-policy", policy.policyDesignerState)).ok,
  ).toBe(true);
  expect(JSON.parse(server.writes[0]).acls).toEqual([]);
});

test("a policy read started before saving cannot replace the newly accepted clean baseline", async () => {
  const { session, server } = await fixture();
  const { snapshot, policy } = session;
  const pending = server.holdNext("GET");
  const reading = snapshot.refreshSnapshot();
  await pending.entered;
  policy.commitState(
    removeRuleById(policy.policyDesignerState, policy.getSnapshot().policyRules[0].id),
  );
  expect(
    (await createPolicySave(session).savePolicy("save-policy", policy.policyDesignerState)).ok,
  ).toBe(true);
  const baseline = policy.getSnapshot().policyDraft;
  pending.release();
  await reading;
  snapshot.applyPatch({ users: [] });
  expect(policy.getSnapshot().policyRules).toEqual([]);
  expect(policy.getSnapshot().policyDraft).toBe(baseline);
  expect(policy.isPolicyDirty).toBe(false);
  expect(snapshot.getSnapshot().snapshot.users).toEqual([]);
});

test("clean empty policy refreshes while local edits to an empty policy remain intact", async () => {
  const { session } = await fixture("");
  const { snapshot, policy } = session;
  expect(policy.getSnapshot().policyRules).toHaveLength(1);
  snapshot.applyPatch({ policy: { policy: '{"acls":[],"groups":{"group:remote":[]}}' } });
  expect(policy.getSnapshot().policyGroups[0]?.name).toBe("group:remote");
  snapshot.applyPatch({ policy: null });
  expect(policy.getSnapshot().policyGroups).toEqual([]);
  policy.commitState(upsertGroup(policy.policyDesignerState, createGroup("group:local")));
  snapshot.applyPatch({ policy: null });
  expect(policy.getSnapshot().policyGroups[0]?.name).toBe("group:local");
  expect(policy.isPolicyDirty).toBe(true);
});

test("uncommitted dialog inputs survive a different remote policy until the editor closes", async () => {
  const { session, server } = await fixture();
  const { snapshot, policy } = session;
  const rules = policy.getSnapshot().policyRules;
  const pending = server.holdNext("GET");
  const reading = snapshot.refreshSegments(["policy"]);
  await pending.entered;
  policy.setState({ tagDetailOpen: true });
  server.snapshot.policy = { policy: '{"acls":[]}' };
  pending.release(Response.json(server.snapshot.policy));
  await reading;
  expect(policy.getSnapshot().policyRules).toBe(rules);
  expect(policy.isPolicyDirty).toBe(false);
  policy.setState({ tagDetailOpen: false });
  expect(policy.getSnapshot().policyRules).toEqual([]);
  expect(policy.getSnapshot().policyDraft).toBe('{"acls":[]}');
  expect(policy.isPolicyDirty).toBe(false);
});

test("a dirty edit, a remote change and a discard end on the remote policy once the dialog closes", async () => {
  const { session } = await fixture();
  const { snapshot, policy } = session;
  policy.setState({ teamDetailOpen: true });
  policy.commitState(upsertGroup(policy.policyDesignerState, createGroup("group:local")));
  snapshot.applyPatch({ policy: { policy: '{"acls":[]}' } });
  expect(policy.getSnapshot().policyGroups[0]?.name).toBe("group:local");
  policy.commitState(parsePolicy(policy.getSnapshot().policyDraft));
  expect(policy.isPolicyDirty).toBe(false);
  expect(policy.getSnapshot().policyDraft).toBe(defaultPolicy);
  policy.setState({ teamDetailOpen: false });
  expect(policy.getSnapshot().policyDraft).toBe('{"acls":[]}');
  expect(policy.getSnapshot().policyRules).toEqual([]);
  expect(policy.getSnapshot().policyGroups).toEqual([]);
});

test("a held remote refresh is never applied over local edits that are still unsaved", async () => {
  const { session } = await fixture();
  const { snapshot, policy } = session;
  policy.commitState(upsertGroup(policy.policyDesignerState, createGroup("group:local")));
  snapshot.applyPatch({ policy: { policy: '{"acls":[]}' } });
  policy.setState({ teamDetailOpen: true });
  policy.setState({ teamDetailOpen: false });
  expect(policy.getSnapshot().policyDraft).toBe(defaultPolicy);
  expect(policy.getSnapshot().policyGroups[0]?.name).toBe("group:local");
  expect(policy.isPolicyDirty).toBe(true);
});

test("a refresh equal to the draft is not loaded when the editor closes", async () => {
  const { session } = await fixture();
  const { snapshot, policy } = session;
  const rules = policy.getSnapshot().policyRules;
  policy.setState({ tagDetailOpen: true });
  snapshot.applyPatch({ policy: { policy: defaultPolicy } });
  policy.setState({ tagDetailOpen: false });
  expect(policy.getSnapshot().policyRules).toBe(rules);
});

test("a switch drops a held refresh and never loads the previous server's text", async () => {
  const { session, server } = await fixture();
  const { snapshot, policy } = session;
  policy.setState({ tagDetailOpen: true });
  snapshot.applyPatch({ policy: { policy: '{"acls":[],"groups":{"group:old":[]}}' } });
  expect(policy.getSnapshot().policyGroups).toEqual([]);
  const seen = new Set<string>();
  policy.subscribe(() => seen.add(policy.getSnapshot().policyDraft));
  await session.profiles.logout();
  expect([...seen]).not.toContain('{"acls":[],"groups":{"group:old":[]}}');
  expect(policy.getSnapshot().policyDraft).toBe("");
  expect(policy.getSnapshot().policyGroups).toEqual([]);
  policy.setState({ tagDetailOpen: false });
  expect(policy.getSnapshot().policyDraft).toBe("");
  expect(server.writes).toEqual([]);
});

test("inline rule editors preserve their object and input across remote refresh", async () => {
  const { session } = await fixture();
  const { snapshot, policy } = session;
  const rules = policy.getSnapshot().policyRules;
  policy.setState({ editingIpRuleId: rules[0].id });
  snapshot.applyPatch({ policy: { policy: '{"acls":[]}' } });
  expect(policy.getSnapshot().policyRules).toBe(rules);
  expect(policy.getSnapshot().editingIpRuleId).toBe(rules[0].id);
  policy.closeAccessEditors();
  expect(policy.getSnapshot().policyRules).toEqual([]);
});

test.each(["assignMembershipsOpen", "assignTagOwnershipsOpen"] as const)(
  "%s selections survive refresh and a switch, and only explicit discard clears them",
  async (editor) => {
    const { session, switchTo } = await fixture(richPolicy);
    const { snapshot, policy } = session;
    policy.setState({ [editor]: true });
    policy.closeAccessEditors();
    const before = policy.getSnapshot();
    snapshot.applyPatch({ policy: { policy: '{"acls":[]}' } });
    expect(policy.getSnapshot().policyGroups).toBe(before.policyGroups);
    expect(policy.getSnapshot().policyTagOwners).toBe(before.policyTagOwners);
    await switchTo(richPolicy);
    expect(policy.getSnapshot()[editor]).toBe(true);
    expect(session.drafts.isCurrent()).toBe(false);
    session.discardDrafts();
    expect(policy.getSnapshot()[editor]).toBe(false);
    expect(policy.isPolicyDirty).toBe(false);
  },
);

test.each([true, false])(
  "newer local edits survive a pending save (accepted: %s)",
  async (accepted) => {
    const { session, server } = await fixture();
    const { policy } = session;
    const baseline = policy.getSnapshot().policyDraft;
    policy.commitState(
      removeRuleById(policy.policyDesignerState, policy.getSnapshot().policyRules[0].id),
    );
    const pending = server.holdNext("PUT");
    const saving = createPolicySave(session).savePolicy("save-policy", policy.policyDesignerState);
    const submitted = await pending.entered;
    policy.commitState(upsertGroup(policy.policyDesignerState, createGroup("group:local")));
    pending.release(
      accepted ? undefined : Response.json({ message: "policy rejected" }, { status: 400 }),
    );
    expect((await saving).ok).toBe(accepted);
    await session.snapshot.refreshSegments(["policy"]);
    expect(policy.getSnapshot().policyDraft).toBe(accepted ? submitted : baseline);
    expect(policy.getSnapshot().policyRules).toEqual([]);
    expect(policy.getSnapshot().policyGroups).toHaveLength(1);
    expect(policy.isPolicyDirty).toBe(true);
    expect(session.feedback.actionError("save-policy")).toBe(accepted ? "" : "policy rejected");
  },
);

test("a previous server's delayed read cannot overwrite the retained draft or the new server snapshot", async () => {
  const { session, server, switchTo } = await fixture();
  const { policy, snapshot } = session;
  const pending = server.holdNext("GET");
  const reading = snapshot.refreshSnapshot();
  await pending.entered;
  const baseline = policy.getSnapshot().policyDraft;
  policy.commitState(
    removeRuleById(policy.policyDesignerState, policy.getSnapshot().policyRules[0].id),
  );
  policy.setState({
    editingIpRuleId: "previous-rule",
    teamDetailOpen: true,
    teamDetailCurrent: "group:previous",
    pendingHighRiskAction: () => {},
  });
  const nextPolicy = '{"acls":[],"groups":{"group:next":[]}}';
  await switchTo(nextPolicy);
  pending.release();
  await reading;
  expect(policy.getSnapshot().policyDraft).toBe(baseline);
  expect(policy.getSnapshot().policyRules).toEqual([]);
  expect(policy.getSnapshot().teamDetailCurrent).toBe("group:previous");
  expect(snapshot.getSnapshot().snapshot.policy?.policy).toBe(nextPolicy);
  session.discardDrafts();
  expect(policy.getSnapshot().policyDraft).toBe(nextPolicy);
  expect(policy.getSnapshot().pendingHighRiskAction).toBeNull();
});

test("logout clears unsaved server editors and a fresh login cannot receive the old read", async () => {
  const { session, server, profile, password } = await fixture();
  const { policy, snapshot } = session;
  const pending = server.holdNext("GET");
  const reading = snapshot.refreshSnapshot();
  await pending.entered;
  policy.commitState(
    removeRuleById(policy.policyDesignerState, policy.getSnapshot().policyRules[0].id),
  );
  await session.profiles.logout();
  expect(policy.getSnapshot().policyDraft).toBe("");
  server.snapshot.policy = { policy: '{"acls":[]}' };
  expect(await session.profiles.enterProfile(profile, password)).toBe(true);
  await expect.poll(() => snapshot.isRefreshing).toBe(false);
  pending.release();
  await reading;
  expect(policy.getSnapshot().policyDraft).toBe('{"acls":[]}');
  expect(policy.isPolicyDirty).toBe(false);
});

test("a lock records that it discarded unsaved Access edits, and a clean lock does not", async () => {
  const { session, profile, password } = await fixture();
  const { policy, profiles } = session;
  await session.profiles.logout();
  expect(profiles.getSnapshot().discardedPolicyDraft).toBe(false);
  expect(await profiles.enterProfile(profile, password)).toBe(true);
  await expect.poll(() => policy.getSnapshot().policyRules.length).toBeGreaterThan(0);
  policy.commitState(
    removeRuleById(policy.policyDesignerState, policy.getSnapshot().policyRules[0].id),
  );
  await profiles.logout();
  expect(profiles.getSnapshot().discardedPolicyDraft).toBe(true);
  expect(policy.isPolicyDirty).toBe(false);
});

test.each([true, false])(
  "old server save completion cannot change new feedback or release new state (accepted: %s)",
  async (accepted) => {
    const { session, server, switchTo } = await fixture();
    const { policy, snapshot, feedback } = session;
    policy.commitState(
      removeRuleById(policy.policyDesignerState, policy.getSnapshot().policyRules[0].id),
    );
    const pending = server.holdNext("PUT");
    const saving = createPolicySave(session).savePolicy("save-policy", policy.policyDesignerState);
    await pending.entered;
    const nextPolicy = '{"acls":[],"groups":{"group:next":[]}}';
    const next = await switchTo(nextPolicy);
    session.discardDrafts();
    feedback.setState({ lastError: "new session feedback" });
    const data = snapshot.getSnapshot().snapshot;
    pending.release(
      accepted ? undefined : Response.json({ message: "old rejection" }, { status: 400 }),
    );
    expect(await saving).toEqual({ ok: false });
    expect(policy.getSnapshot().policyDraft).toBe(nextPolicy);
    expect(feedback.getSnapshot().lastError).toBe("new session feedback");
    expect(feedback.actionError("save-policy")).toBe("");
    expect(snapshot.getSnapshot().snapshot).toBe(data);
    expect(next.server.writes).toEqual([]);
  },
);

test("a previous login's late save cannot release the next login's pending save ticket", async () => {
  const { session, server, profile, password } = await fixture();
  const oldPending = server.holdNext("PUT");
  const oldSave = createPolicySave(session).savePolicy(
    "save-policy",
    session.policy.policyDesignerState,
  );
  await oldPending.entered;
  await session.profiles.logout();
  expect(await session.profiles.enterProfile(profile, password)).toBe(true);
  await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
  const pending = server.holdNext("PUT");
  const saving = createPolicySave(session).savePolicy(
    "save-policy",
    session.policy.policyDesignerState,
  );
  await pending.entered;
  oldPending.release();
  expect(await oldSave).toEqual({ ok: false });
  expect(session.feedback.isActionPending("save-policy")).toBe(true);
  expect(session.policy.isPolicySaving).toBe(true);
  pending.release();
  expect((await saving).ok).toBe(true);
  expect(session.feedback.isActionPending("save-policy")).toBe(false);
  expect(session.policy.isPolicySaving).toBe(false);
});

const unsetPathFailure = () =>
  Response.json(
    { code: 2, message: 'reading policy from path "": open : no such file or directory' },
    { status: 500 },
  );

test("an unset file-mode policy read locks the designer without a refresh error and no write is sent", async () => {
  const { session, server } = await fixture();
  const { snapshot, policy } = session;
  const pending = server.holdNext("GET");
  const reading = snapshot.refreshSegments(["policy"]);
  await pending.entered;
  pending.release(unsetPathFailure());
  await reading;
  expect(snapshot.getSnapshot().refreshErrors.policy).toBeUndefined();
  expect(snapshot.getSnapshot().snapshot.policy?.fileModeWithoutPath).toBe(true);
  expect(policy.getSnapshot().policyError).toBe(POLICY_FILE_MODE_WITHOUT_PATH);
  expect(
    await createPolicySave(session).savePolicy("save-policy", policy.policyDesignerState),
  ).toEqual({ ok: false });
  expect(server.writes).toEqual([]);
  await snapshot.refreshSegments(["policy"]);
  expect(snapshot.getSnapshot().snapshot.policy?.fileModeWithoutPath).toBeUndefined();
  expect(policy.getSnapshot().policyError).toBeNull();
});

test("the file-mode lock is lifted by a snapshot reset and re-applied for an unchanged empty policy", async () => {
  const { session } = await fixture("");
  const { snapshot, policy } = session;
  snapshot.applyPatch({ policy: { policy: "", fileModeWithoutPath: true } });
  expect(policy.getSnapshot().policyError).toBe(POLICY_FILE_MODE_WITHOUT_PATH);
  snapshot.applyPatch({ policy: { policy: "", fileModeWithoutPath: true } });
  expect(policy.getSnapshot().policyError).toBe(POLICY_FILE_MODE_WITHOUT_PATH);
  snapshot.resetSnapshot();
  expect(policy.getSnapshot().policyError).toBeNull();
});

test("a held draft is not submitted to a file-mode server and discarding keeps the lock", async () => {
  const { session, switchTo } = await fixture();
  const { policy, snapshot } = session;
  policy.commitState(
    removeRuleById(policy.policyDesignerState, policy.getSnapshot().policyRules[0].id),
  );
  const next = await switchTo(defaultPolicy);
  expect(session.drafts.isCurrent()).toBe(false);
  const pending = next.server.holdNext("GET");
  const reading = snapshot.refreshSegments(["policy"]);
  await pending.entered;
  pending.release(unsetPathFailure());
  await reading;
  expect(policy.getSnapshot().policyError).toBe(POLICY_FILE_MODE_WITHOUT_PATH);
  expect(
    await createPolicySave(session).savePolicy("save-policy", policy.policyDesignerState),
  ).toEqual({ ok: false });
  expect(next.server.writes).toEqual([]);
  session.discardDrafts();
  expect(policy.getSnapshot().policyDraft).toBe("");
  expect(policy.getSnapshot().policyError).toBe(POLICY_FILE_MODE_WITHOUT_PATH);
  expect(policy.isPolicyDirty).toBe(false);
});
