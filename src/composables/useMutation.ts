import { useMemo } from "react";
import type { SessionRequestOptions } from "@/session/auth-session";
import type { ApiCommand, ApiOutput, EndpointName } from "@/session/protocol";
import { ApiError } from "@/session/types";
import { type Session, useSession, useStore } from "./session-context";
import type { ActionFeedbackKey, ActionResult } from "./useActionFeedback";

interface UseMutationOptions {
  /** The caller handles response adoption or its own refresh. */
  skipRefresh?: boolean;
}
interface UseMutationReturn {
  /**
   * A write whose answer was lost or discarded rejects with `outcome: "unknown"` (including a
   * stale draft after success). After that, or after any server answer to a failed write, the page
   * refreshes once unless skipRefresh. Never replayed.
   */
  mutate<K extends EndpointName>(
    key: ActionFeedbackKey,
    command: ApiCommand<K>,
    options?: SessionRequestOptions,
  ): Promise<boolean>;
  mutateWith<K extends EndpointName>(
    key: ActionFeedbackKey,
    command: ApiCommand<K>,
    options?: SessionRequestOptions,
  ): Promise<ActionResult<ApiOutput<K>>>;
}

export function createMutation(
  session: Pick<Session, "client" | "snapshot" | "feedback" | "drafts"> & {
    auth: Pick<Session["auth"], "write">;
  },
  opts: UseMutationOptions = {},
): UseMutationReturn {
  const { runAction } = session.feedback;
  const { refreshSnapshot, captureSession } = session.snapshot;
  const identity = session.client.getSnapshot().identity;
  const ownsSession = captureSession();
  const viewEpoch = session.drafts.getSnapshot().viewEpoch;
  const ownsView = () => viewEpoch === session.drafts.getSnapshot().viewEpoch;
  async function mutateWith<K extends EndpointName>(
    key: ActionFeedbackKey,
    command: ApiCommand<K>,
    options?: SessionRequestOptions,
  ): Promise<ActionResult<ApiOutput<K>>> {
    if (!ownsSession() || !ownsView()) return { ok: false };
    const isCurrentSession = captureSession();
    const isCurrent = () => isCurrentSession() && ownsView();
    return runAction(
      key,
      async () => {
        if (!session.drafts.isCurrent()) throw new ApiError({ kind: "stale" });
        if (!identity) throw new ApiError({ kind: "locked" });
        const reply = await session.auth.write(identity, command, options);
        if (!reply.ok) {
          const error = new ApiError(reply.error);
          // The write may have been applied: show the server state, never replay it. A definite
          // server answer may also follow an applied write, because Chromium resends a POST whose
          // reused connection closed before any response byte.
          if (
            (error.kind === "api" || error.outcome === "unknown") &&
            !opts.skipRefresh &&
            isCurrent() &&
            session.drafts.isCurrent()
          )
            await refreshSnapshot();
          throw error;
        }
        if (!session.drafts.isCurrent()) throw new ApiError({ kind: "stale", outcome: "unknown" });
        if (isCurrent() && !opts.skipRefresh) await refreshSnapshot();
        return reply.value;
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
  const { identity } = useStore(session.client);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The factory captures the external store's current session.
  return useMemo(() => createMutation(session, { skipRefresh }), [session, skipRefresh, identity]);
}
