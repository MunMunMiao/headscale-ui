import { expect, test } from "vitest";
import { parsePolicy } from "@/domain/policy-designer";
import { t } from "@/i18n";
import { fakeAuth } from "@/test/dispatch-fixture";
import { createSessionDrafts } from "./session-drafts";
import { createActionFeedbackStore } from "./useActionFeedback";
import { createHeadscaleClientStore } from "./useHeadscaleClient";
import { createPolicyDesignerStore } from "./usePolicyDesigner";
import { createPolicySave } from "./usePolicySave";
import { createSnapshotStore } from "./useSnapshot";

test("an unconfirmed policy write keeps the draft dirty, reports it under save-policy and is not resubmitted", async () => {
  const writes: string[] = [];
  const auth = fakeAuth({
    async execute(_expected, command) {
      if (command.endpoint === "getPolicy")
        return {
          ok: true,
          value: { policy: '{"acls":[],"groups":{"group:ops":["alice@"]}}' },
        };
      writes.push(command.endpoint);
      return {
        ok: false,
        error: {
          kind: "api",
          code: "NET_TIMEOUT",
          message: "timed out",
          outcome: "unknown",
        },
      };
    },
  });
  const client = createHeadscaleClientStore();
  client.adopt({
    status: "unlocked",
    identity: { workerId: "worker", sessionId: "a" },
    profile: { id: "a", name: "a", baseUrl: "https://a.test" },
    expiresAt: Date.now() + 1800000,
    pendingProfileId: null,
    reason: null,
    apiKeyPrefix: null,
    revision: 1,
  });
  const feedback = createActionFeedbackStore();
  const snapshot = createSnapshotStore(auth, client, feedback);
  const policy = createPolicyDesignerStore();
  const session = {
    auth,
    client,
    feedback,
    snapshot,
    policy,
    drafts: createSessionDrafts(),
  };
  snapshot.setAuthorized(true);
  policy.load('{"acls":[],"groups":{"group:ops":["alice@"]}}');
  const baseline = policy.getSnapshot().policyDraft;
  const next = parsePolicy('{"acls":[],"groups":{"group:ops":["bob@"]}}');
  policy.commitState(next);

  expect(
    await createPolicySave(session).savePolicy("save-policy", next),
  ).toEqual({ ok: false });
  expect(feedback.actionError("save-policy")).toBe(t("sessionOutcomeUnknown"));
  expect(policy.getSnapshot().policyDraft).toBe(baseline);
  expect(policy.isPolicyDirty).toBe(true);
  expect(policy.isPolicySaving).toBe(false);
  // The required pre-read does not cause a replay: exactly one write left the page.
  expect(writes).toEqual(["setPolicy"]);
});
