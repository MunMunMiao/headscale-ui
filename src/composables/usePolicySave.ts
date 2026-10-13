import { useMemo } from "react";
import type { PolicyDesignerState } from "@/domain/policy-designer";
import { ApiError } from "@/session/types";
import { type Session, useSession, useStore } from "./session-context";
import { createMutation } from "./useMutation";

export type PolicySaveKey = "save-policy" | "assign-user-groups" | "assign-user-tags";
export type PolicySaveResult = { ok: true; hasNewerEdits: boolean } | { ok: false };

export function createPolicySave(
  session: Pick<Session, "client" | "snapshot" | "feedback" | "policy" | "drafts"> & {
    auth: Pick<Session["auth"], "write">;
  },
) {
  const mutation = createMutation(session, { skipRefresh: true });
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
      isCurrentSession() && viewEpoch === session.drafts.getSnapshot().viewEpoch;
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
    // A targeted write serialises a state derived from a clean draft; it must not publish Access edits.
    if (options?.targeted && session.policy.isPolicyDirty) return { ok: false };
    const ticket = session.policy.beginSave(state);
    if (!ticket) return { ok: false };
    session.snapshot.invalidatePolicyRefreshes();
    try {
      const saved = await mutation.mutateWith(key, {
        endpoint: "setPolicy",
        input: { policy: ticket.submittedText },
      });
      if (!saved.ok || !isCurrent() || !session.drafts.isCurrent()) return { ok: false };
      const accepted = session.policy.acceptSavedPolicy(ticket, saved.result.policy);
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new session must replace callbacks bound to the previous one.
  return useMemo(() => createPolicySave(session), [session, identity]);
}
