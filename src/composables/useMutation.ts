import { useMemo } from "react";
import type { OperationCommand, OperationOutput } from "@/api/commands";
import { ApiError, type GatewayExecuteOptions } from "@/api/gateway";
import type { OperationId } from "@/domain/headscale-operations";
import { type Session, useSession, useStore } from "./session-context";
import type { ActionFeedbackKey, ActionResult } from "./useActionFeedback";

interface UseMutationOptions {
  /** The caller handles response adoption or its own refresh. */
  skipRefresh?: boolean;
}
interface UseMutationReturn {
  /**
   * A write whose answer was lost or discarded rejects with `outcome: "unknown"` (including a
   * stale draft after success); unless skipRefresh, the page then refreshes once. Never replayed.
   */
  mutate<K extends OperationId>(
    key: ActionFeedbackKey,
    command: OperationCommand<K>,
    options?: GatewayExecuteOptions,
  ): Promise<boolean>;
  mutateWith<K extends OperationId>(
    key: ActionFeedbackKey,
    command: OperationCommand<K>,
    options?: GatewayExecuteOptions,
  ): Promise<ActionResult<OperationOutput<K>>>;
}

export function createMutation(
  session: Pick<Session, "client" | "snapshot" | "feedback" | "drafts">,
  opts: UseMutationOptions = {},
): UseMutationReturn {
  const { runAction } = session.feedback;
  const { refreshSnapshot, captureSession } = session.snapshot;
  const client = session.client.getSnapshot().http;
  const ownsSession = captureSession();
  const viewEpoch = session.drafts.getSnapshot().viewEpoch;
  const ownsView = () => viewEpoch === session.drafts.getSnapshot().viewEpoch;
  async function mutateWith<K extends OperationId>(
    key: ActionFeedbackKey,
    command: OperationCommand<K>,
    options?: GatewayExecuteOptions,
  ): Promise<ActionResult<OperationOutput<K>>> {
    if (!ownsSession() || !ownsView()) return { ok: false };
    const isCurrentSession = captureSession();
    const isCurrent = () => isCurrentSession() && ownsView();
    return runAction(
      key,
      async () => {
        if (!session.drafts.isCurrent()) throw new ApiError({ kind: "stale" });
        if (!client) throw new ApiError({ kind: "locked" });
        const [error, result] = await client.execute(command, options);
        if (error) {
          // The write may have been applied: show the real state, never replay it.
          if (
            error.outcome === "unknown" &&
            !opts.skipRefresh &&
            isCurrent() &&
            session.drafts.isCurrent()
          )
            await refreshSnapshot();
          throw error;
        }
        if (!session.drafts.isCurrent()) throw new ApiError({ kind: "stale", outcome: "unknown" });
        if (isCurrent() && !opts.skipRefresh) await refreshSnapshot();
        return result;
      },
      isCurrent,
    );
  }
  return {
    mutateWith,
    async mutate(key, command, options) {
      const completed = await mutateWith(key, command, options);
      return completed.ok;
    },
  };
}

export function useMutation({ skipRefresh = false }: UseMutationOptions = {}): UseMutationReturn {
  const session = useSession();
  const { http } = useStore(session.client);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The factory captures the external store's current gateway.
  return useMemo(() => createMutation(session, { skipRefresh }), [session, skipRefresh, http]);
}
