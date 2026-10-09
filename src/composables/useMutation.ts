import type { HeadscaleClient } from "@/api/types";
import { type ActionFeedbackKey, type ActionResult, useActionFeedback } from "./useActionFeedback";
import { useHeadscaleClient } from "./useHeadscaleClient";
import { useSnapshot } from "./useSnapshot";

interface UseMutationOptions {
  /**
   * Skip the post-action `refreshSnapshot()`. Use when the mutation's response
   * is self-contained (e.g. `savePolicy`) or when the caller orchestrates its
   * own refresh.
   */
  skipRefresh?: boolean;
}

interface UseMutationReturn {
  /** Returns false on failure, reentry, or session change; a stale request may still reach the server. */
  mutate(
    key: ActionFeedbackKey,
    action: (client: HeadscaleClient) => Promise<unknown>,
  ): Promise<boolean>;
  /** Run a mutation and surface its typed result via `ActionResult<T>`. */
  mutateWith<T>(
    key: ActionFeedbackKey,
    action: (client: HeadscaleClient) => Promise<T>,
  ): Promise<ActionResult<T>>;
}

/**
 * Run a mutation against the live client and surface its progress/error via
 * `useActionFeedback`; by default the snapshot is refreshed afterwards so the
 * UI reflects server state.
 *
 * Use `mutate` when you only care whether the action succeeded; use
 * `mutateWith<T>` when you need the server response (e.g. the freshly-minted
 * pre-auth key from `createPreAuthKey`).
 */
export function useMutation(opts: UseMutationOptions = {}): UseMutationReturn {
  const { runAction } = useActionFeedback();
  const { createClient } = useHeadscaleClient();
  const { refreshSnapshot, captureSession } = useSnapshot();

  async function mutateWith<T>(
    key: ActionFeedbackKey,
    action: (client: HeadscaleClient) => Promise<T>,
  ): Promise<ActionResult<T>> {
    const isCurrent = captureSession();
    return runAction(
      key,
      async () => {
        const result = await action(createClient());
        if (isCurrent() && !opts.skipRefresh) await refreshSnapshot();
        return result;
      },
      isCurrent,
    );
  }

  return {
    mutateWith,
    async mutate(key, action) {
      const completed = await mutateWith(key, action);
      return completed.ok;
    },
  };
}
