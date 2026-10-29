import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createGroup, upsertGroup } from "@/domain/policy-designer";
import { __resetForTest } from "@/lib/idb";
import {
  hydrateSettings,
  settingsStorageTestingHandle,
} from "@/lib/settings-storage";
import { createSessionHarness } from "@/test/session-host";
import { snapshotFixture } from "@/test-utils/headscale.test";
import { createSession } from "./session-context";
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
  vi.restoreAllMocks();
});

test.each(['{"acls":[{"action":"accept","src":["*"],"dst":["*:*"]}]}', ""])(
  "a same-server file-mode snapshot preserves unsaved edits and their baseline (%j)",
  async (baseline) => {
    const remote = snapshotFixture();
    remote.policy = { policy: baseline };
    const writes: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (request.method !== "GET") writes.push(`${request.method} ${path}`);
      const responses: Record<string, unknown> = {
        "/api/v1/health": remote.health,
        "/version": remote.version,
        "/api/v1/user": { users: remote.users },
        "/api/v1/node": { nodes: remote.nodes },
        "/api/v1/preauthkey": { preAuthKeys: remote.preAuthKeys },
        "/api/v1/apikey": { apiKeys: remote.apiKeys },
        "/api/v1/policy": remote.policy,
      };
      return Response.json(responses[path]);
    });
    const harness = await createSessionHarness();
    cleanup.push(() => harness.dispose());
    const session = createSession(await harness.openPage());
    cleanup.push(session.start());
    session.profiles.setConnectionForm({
      profileName: "Test server",
      baseUrl: "https://fixture.invalid",
      apiKey: "isolated-test-key",
      password: "isolated-test-password",
    });
    await session.profiles.addProfile(true);
    const { policy, snapshot } = session;
    await expect.poll(() => snapshot.isRefreshing).toBe(false);
    expect(snapshot.getSnapshot().isReady).toBe(true);
    expect(session.drafts.isCurrent()).toBe(true);
    policy.commitState(
      upsertGroup(policy.policyDesignerState, createGroup("group:local")),
    );
    const draft = policy.getSnapshot();
    expect(policy.isPolicyDirty).toBe(true);

    snapshot.applyPatch({ policy: { policy: "", fileModeWithoutPath: true } });

    expect(policy.getSnapshot().policyDraft).toBe(baseline);
    expect(policy.getSnapshot().policyGroups).toBe(draft.policyGroups);
    expect(policy.getSnapshot().policyGroups[0]?.name).toBe("group:local");
    expect(policy.getSnapshot().policyRules).toBe(draft.policyRules);
    expect(policy.isPolicyDirty).toBe(true);
    expect(policy.getSnapshot().policyError).toBe(
      POLICY_FILE_MODE_WITHOUT_PATH,
    );
    expect(policy.policyPayload).toBeNull();
    expect(policy.beginSave(policy.policyDesignerState)).toBeNull();
    expect(
      await createPolicySave(session).savePolicy(
        "save-policy",
        policy.policyDesignerState,
      ),
    ).toEqual({ ok: false });
    expect(writes).toEqual([]);

    snapshot.applyPatch({ policy: { policy: "", fileModeWithoutPath: true } });
    expect(policy.getSnapshot().policyDraft).toBe(baseline);
    expect(policy.getSnapshot().policyGroups).toBe(draft.policyGroups);
    expect(policy.isPolicyDirty).toBe(true);

    snapshot.applyPatch({ policy: { policy: baseline } });
    expect(policy.getSnapshot().policyDraft).toBe(baseline);
    expect(policy.getSnapshot().policyGroups).toBe(draft.policyGroups);
    expect(policy.getSnapshot().policyError).toBeNull();
    expect(policy.isPolicyDirty).toBe(true);
    expect(policy.policyPayload?.groups).toEqual({ "group:local": [] });

    snapshot.applyPatch({ policy: { policy: "", fileModeWithoutPath: true } });
    session.discardDrafts();
    expect(policy.getSnapshot().policyDraft).toBe("");
    expect(policy.getSnapshot().policyGroups).toEqual([]);
    expect(policy.isPolicyDirty).toBe(false);
    expect(policy.getSnapshot().policyError).toBe(
      POLICY_FILE_MODE_WITHOUT_PATH,
    );
    expect(policy.beginSave(policy.policyDesignerState)).toBeNull();
    expect(writes).toEqual([]);
  },
);
