import { createStore } from "@/lib/store";
import { getErrorMessage } from "@/utils/error-mapping";
import { useSession, useStore } from "./session-context";

// Each keyed action reports its failure once, inline in the dialog or form that ran it; the page
// banner (lastError) is left to keyless profile and storage messages.
export type ActionFeedbackKey =
  | "api-key-action"
  | "api-key-create"
  | "approve-auth-request"
  | "approve-route"
  | "approve-routes"
  | "assign-user-groups"
  | "assign-user-tags"
  | "backfill-node-ips"
  | "check-policy"
  | "create-invite"
  | "create-member"
  | "delete-member"
  | "expire-node"
  | "invite-action"
  | "node-tags"
  | "register-auth-request"
  | "register-pending-node"
  | "reject-auth-request"
  | "remove-node"
  | "rename-member"
  | "rename-node"
  | "revoke-route"
  | "save-policy";

export type ActionResult<T> = { ok: true; result: T } | { ok: false };

interface FeedbackState {
  actionPending: Partial<Record<ActionFeedbackKey, boolean>>;
  actionErrors: Partial<Record<ActionFeedbackKey, string>>;
  lastError: string;
}

export function createActionFeedbackStore() {
  const state = createStore<FeedbackState>({ actionPending: {}, actionErrors: {}, lastError: "" });
  let mapper = (error: unknown): string => getErrorMessage(error);

  function isActionPending(key: ActionFeedbackKey) {
    return state.getSnapshot().actionPending[key] === true;
  }
  function actionError(key: ActionFeedbackKey) {
    return state.getSnapshot().actionErrors[key] ?? "";
  }
  function clearActionFeedback(key: ActionFeedbackKey) {
    const next = { ...state.getSnapshot().actionErrors };
    delete next[key];
    state.setState({ actionErrors: next });
  }
  function clearAllActionFeedback() {
    state.setState({ actionPending: {}, actionErrors: {}, lastError: "" });
  }
  async function runAction<T>(
    key: ActionFeedbackKey,
    action: () => Promise<T>,
    isCurrent: () => boolean = () => true,
  ): Promise<ActionResult<T>> {
    if (isActionPending(key)) return { ok: false };
    state.setState((current) => ({
      actionPending: { ...current.actionPending, [key]: true },
      lastError: "",
    }));
    clearActionFeedback(key);
    try {
      const result = await action();
      if (!isCurrent()) return { ok: false };
      return { ok: true, result };
    } catch (error) {
      if (!isCurrent()) return { ok: false };
      const message = mapper(error);
      state.setState((current) => ({
        actionErrors: { ...current.actionErrors, [key]: message },
      }));
      return { ok: false };
    } finally {
      if (isCurrent())
        state.setState((current) => ({
          actionPending: { ...current.actionPending, [key]: false },
        }));
    }
  }
  return {
    ...state,
    isActionPending,
    actionError,
    clearActionFeedback,
    clearAllActionFeedback,
    runAction,
    setErrorMapper(fn: (error: unknown) => string) {
      mapper = fn;
    },
  };
}

export function useActionFeedback() {
  return useStore(useSession().feedback);
}
