import { type Ref, reactive, ref } from "vue";

export type ActionFeedbackKey =
  | "api-key-action"
  | "api-key-create"
  | "approve-auth-request"
  | "approve-route"
  | "approve-routes"
  | "assign-user-groups"
  | "assign-user-tags"
  | "backfill-node-ips"
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
  | "save-policy";

export type ActionResult<T> = { ok: true; result: T } | { ok: false };

interface UseActionFeedbackReturn {
  actionPending: Partial<Record<ActionFeedbackKey, boolean>>;
  actionErrors: Partial<Record<ActionFeedbackKey, string>>;
  lastError: Ref<string>;
  isActionPending(key: ActionFeedbackKey): boolean;
  actionError(key: ActionFeedbackKey): string;
  clearActionFeedback(key: ActionFeedbackKey): void;
  clearAllActionFeedback(): void;
  runAction<T>(
    key: ActionFeedbackKey,
    action: () => Promise<T>,
    isCurrent?: () => boolean,
  ): Promise<ActionResult<T>>;
  setErrorMapper(fn: (error: unknown) => string): void;
}

let instance: UseActionFeedbackReturn | null = null;

/** Internal: invoked by `__testing.ts` only. */
export const actionFeedbackTestingHandle = {
  reset() {
    instance = null;
  },
};

function defaultMapper(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useActionFeedback(): UseActionFeedbackReturn {
  if (instance) return instance;
  const actionPending = reactive<Partial<Record<ActionFeedbackKey, boolean>>>({});
  const actionErrors = reactive<Partial<Record<ActionFeedbackKey, string>>>({});
  const lastError = ref("");
  let mapper: (error: unknown) => string = defaultMapper;

  function isActionPending(key: ActionFeedbackKey) {
    return actionPending[key] === true;
  }
  function actionError(key: ActionFeedbackKey) {
    return actionErrors[key] ?? "";
  }
  function clearActionFeedback(key: ActionFeedbackKey) {
    delete actionErrors[key];
  }
  function clearAllActionFeedback() {
    for (const key of Object.keys(actionPending) as ActionFeedbackKey[]) delete actionPending[key];
    for (const key of Object.keys(actionErrors) as ActionFeedbackKey[]) delete actionErrors[key];
    lastError.value = "";
  }
  async function runAction<T>(
    key: ActionFeedbackKey,
    action: () => Promise<T>,
    isCurrent: () => boolean = () => true,
  ): Promise<ActionResult<T>> {
    if (isActionPending(key)) {
      return { ok: false as const };
    }
    actionPending[key] = true;
    clearActionFeedback(key);
    lastError.value = "";
    try {
      const result = await action();
      if (!isCurrent()) return { ok: false as const };
      return { ok: true as const, result };
    } catch (error) {
      if (!isCurrent()) return { ok: false as const };
      const message = mapper(error);
      actionErrors[key] = message;
      lastError.value = message;
      return { ok: false as const };
    } finally {
      if (isCurrent()) actionPending[key] = false;
    }
  }

  instance = {
    actionPending,
    actionErrors,
    lastError,
    isActionPending,
    actionError,
    clearActionFeedback,
    clearAllActionFeedback,
    runAction,
    setErrorMapper(fn: (error: unknown) => string) {
      mapper = fn;
    },
  };
  return instance;
}
