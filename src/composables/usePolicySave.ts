import { useMemo } from "react";
import type { PolicyDesignerState } from "@/domain/policy-designer";
import { i18n } from "@/i18n";
import { productDescriptors } from "@/i18n/descriptors";
import { ApiError } from "@/session/types";
import { type Session, useSession, useStore } from "./session-context";
import { createMutation } from "./useMutation";

export type PolicySaveKey =
  "save-policy" | "assign-user-groups" | "assign-user-tags";
export type PolicySaveResult =
  { ok: true; hasNewerEdits: boolean } | { ok: false };

export function createPolicySave(
  session: Pick<
    Session,
    "client" | "snapshot" | "feedback" | "policy" | "drafts"
  > & {
    auth: Pick<Session["auth"], "write">;
    tagLifecycle?: Session["tagLifecycle"];
  },
) {
  const ownsSession = session.snapshot.captureSession();
  const viewEpoch = session.drafts.getSnapshot().viewEpoch;
  async function savePolicy(
    key: PolicySaveKey,
    state: PolicyDesignerState,
    options?: { targeted?: boolean },
  ): Promise<PolicySaveResult> {
    if (!ownsSession() || viewEpoch !== session.drafts.getSnapshot().viewEpoch)
      return { ok: false };
    const isCurrentSession = session.snapshot.captureSession();
    const isCurrent = () =>
      isCurrentSession() &&
      viewEpoch === session.drafts.getSnapshot().viewEpoch;
    if (!session.drafts.isCurrent()) {
      await session.feedback.runAction(
        key,
        async () => {
          throw new ApiError({ kind: "stale" });
        },
        isCurrent,
      );
      return { ok: false };
    }
    if (!session.client.getSnapshot().identity) {
      await session.feedback.runAction(
        key,
        async () => {
          throw new ApiError({ kind: "locked" });
        },
        isCurrent,
      );
      return { ok: false };
    }
    // A targeted write serialises a state derived from a clean draft; it must not publish Access edits.
    if (options?.targeted && session.policy.isPolicyDirty) return { ok: false };
    const scope = session.tagLifecycle?.captureScope();
    // Bind this explicit operation, not the lifetime of a mounted page, to the current version.
    const mutation = createMutation(session, { skipRefresh: true });
    const baseline = session.policy.getSnapshot().policyDraft;
    const reportConflict = () =>
      session.feedback.runAction(
        key,
        async () => {
          throw new Error(i18n._(productDescriptors.policySaveConflict));
        },
        isCurrent,
      );
    // Raw changes matter: publishing normalized JSON must not silently erase a remote comment edit.
    const observed = session.snapshot.getSnapshot().snapshot.policy;
    if (observed && observed.policy !== baseline) {
      await reportConflict();
      return { ok: false };
    }
    // Capture before the read: the ticket freezes the submitted document and prevents a clean
    // targeted draft from being replaced by syncServerPolicy while its pre-read is in flight.
    const ticket = session.policy.beginSave(state);
    if (!ticket) return { ok: false };
    session.feedback.clearActionFeedback(key);
    session.feedback.setActionOutcome(key, {
      status: "not-dispatched",
      refresh: "not-requested",
    });
    try {
      const fresh = await session.snapshot.refreshSegments(["policy"]);
      if (
        !isCurrent() ||
        !session.drafts.isCurrent() ||
        (scope && !session.tagLifecycle?.isCurrent(scope))
      )
        return { ok: false };
      if (!fresh) {
        await session.feedback.runAction(
          key,
          async () => {
            throw new Error(
              session.snapshot.getSnapshot().refreshErrors.policy ||
                i18n._(productDescriptors.policySaveConflict),
            );
          },
          isCurrent,
        );
        return { ok: false };
      }
      const latest = session.snapshot.getSnapshot().snapshot.policy;
      if (!latest || latest.fileModeWithoutPath || latest.policy !== baseline) {
        await reportConflict();
        return { ok: false };
      }
      // This pre-read is not CAS: the server can still change between GET and PUT.
      session.snapshot.invalidatePolicyRefreshes();
      const saved = await mutation.mutateDetailed(key, {
        endpoint: "setPolicy",
        input: { policy: ticket.submittedText },
      });
      if (
        !isCurrent() ||
        !session.drafts.isCurrent() ||
        (scope && !session.tagLifecycle?.isCurrent(scope))
      )
        return { ok: false };
      if (!saved.ok) return { ok: false };
      const accepted = session.policy.acceptSavedPolicy(
        ticket,
        saved.result.policy,
      );
      session.snapshot.invalidatePolicyRefreshes();
      session.snapshot.applyPatch({ policy: saved.result });
      return { ok: true, ...accepted };
    } finally {
      session.policy.finishSave(ticket.operationId);
    }
  }
  return { savePolicy };
}

export function usePolicySave() {
  const session = useSession();
  const { identity } = useStore(session.client);
  // A new session must replace callbacks bound to the previous one.
  return useMemo(() => createPolicySave(session), [session, identity]);
}
