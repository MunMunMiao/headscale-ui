import { Toast } from "@base-ui/react/toast";
import { i18n } from "@/i18n";
import { commonDescriptors, productDescriptors } from "@/i18n/descriptors";
import { createStore } from "@/lib/store";
import { getErrorDetails } from "@/utils/error-mapping";
import { useSession, useStore } from "./session-context";
import type { MutationOutcome } from "./tag-lifecycle-state";

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

export type NotificationMessageKey =
  | `common.${keyof typeof commonDescriptors}`
  | `product.${Exclude<keyof typeof productDescriptors, "nav">}`
  | `product.nav.${keyof typeof productDescriptors.nav}`;
export type NotificationTone = "success" | "info" | "warning" | "error";
export interface NotificationMessage {
  tone: NotificationTone;
  title: NotificationMessageKey;
  description?: NotificationMessageKey;
}
export interface NotificationOperation {
  readonly id: string;
  publish(message: NotificationMessage): boolean;
  publishMutation(
    outcome: MutationOutcome,
    confirmedTitle?: NotificationMessageKey,
  ): boolean;
}
export interface NotificationData {
  tone: NotificationTone;
  /** Adjacent explicit refresh successes only; never a write confirmation. */
  refreshGroup?: string;
}

/** Presentation only: never interpret server text or change the underlying write evidence. */
export function mutationNotification(
  outcome: MutationOutcome,
  confirmedTitle?: NotificationMessageKey,
): NotificationMessage | null {
  switch (outcome.status) {
    case "confirmed":
      if (outcome.refresh === "failed")
        return {
          tone: "warning",
          title: confirmedTitle ?? "product.feedbackRequestConfirmed",
          description: "product.tagRefreshFailed",
        };
      return confirmedTitle ? { tone: "success", title: confirmedTitle } : null;
    case "not-dispatched":
      return outcome.failure
        ? { tone: "error", title: "product.feedbackRequestNotSent" }
        : null;
    case "pre-rejected":
      return { tone: "error", title: "product.feedbackRequestRejected" };
    case "possibly-applied":
    case "unknown":
      return {
        tone: "warning",
        title:
          outcome.status === "unknown"
            ? "product.inviteCreateResponseUnknown"
            : "product.feedbackPossiblyApplied",
        description: "common.sessionOutcomeUnknown",
      };
  }
}

function notificationText(key: unknown): string | undefined {
  if (typeof key !== "string") return;
  const [namespace, name, child, ...rest] = key.split(".");
  if (rest.length) return;
  if (
    namespace === "common" &&
    child === undefined &&
    Object.hasOwn(commonDescriptors, name)
  )
    return i18n._(commonDescriptors[name as keyof typeof commonDescriptors]);
  if (namespace !== "product") return;
  if (name === "nav") {
    if (child && Object.hasOwn(productDescriptors.nav, child))
      return i18n._(
        productDescriptors.nav[child as keyof typeof productDescriptors.nav],
      );
    return;
  }
  if (child === undefined && Object.hasOwn(productDescriptors, name))
    return i18n._(
      productDescriptors[
        name as Exclude<keyof typeof productDescriptors, "nav">
      ],
    );
}

interface FeedbackState {
  actionPending: Partial<Record<ActionFeedbackKey, boolean>>;
  actionErrors: Partial<
    Record<ActionFeedbackKey, ReturnType<typeof getErrorDetails>>
  >;
  actionOutcomes: Partial<Record<ActionFeedbackKey, MutationOutcome>>;
  lastError: string;
}

export function createActionFeedbackStore() {
  const state = createStore<FeedbackState>({
    actionPending: {},
    actionErrors: {},
    actionOutcomes: {},
    lastError: "",
  });
  let mapper = getErrorDetails;
  const toastManager = Toast.createToastManager<NotificationData>();
  let nextNotificationId = 0;
  let adjacentRefresh: { id: string; ids: Set<string> } | undefined;

  function beginNotification({
    isCurrent,
  }: {
    isCurrent: () => boolean;
  }): NotificationOperation {
    const id = `notification-${++nextNotificationId}`;
    let published = false;
    function publish(
      message: NotificationMessage,
      isMutation = false,
    ): boolean {
      if (published || !isCurrent()) return false;
      if (
        !message ||
        !["success", "info", "warning", "error"].includes(message.tone)
      )
        return false;
      const title = notificationText(message.title);
      const description =
        message.description === undefined
          ? undefined
          : notificationText(message.description);
      if (
        title === undefined ||
        (message.description !== undefined && description === undefined)
      )
        return false;
      published = true;
      const group =
        !isMutation &&
        message.tone === "success" &&
        message.title === "product.dataRefreshed" &&
        message.description === undefined
          ? (adjacentRefresh ??= { id, ids: new Set<string>() })
          : undefined;
      adjacentRefresh = group;
      group?.ids.add(id);
      toastManager.add({
        id,
        title,
        description,
        priority: "low",
        data: group
          ? { tone: message.tone, refreshGroup: group.id }
          : { tone: message.tone },
        ...(group
          ? {
              onClose() {
                const ids = [...group.ids];
                group.ids.clear();
                if (adjacentRefresh === group) adjacentRefresh = undefined;
                for (const member of ids) toastManager.close(member);
              },
            }
          : {}),
      });
      return true;
    }
    return {
      id,
      publish,
      publishMutation(outcome, confirmedTitle) {
        const message = mutationNotification(outcome, confirmedTitle);
        return message ? publish(message, true) : false;
      },
    };
  }

  function isActionPending(key: ActionFeedbackKey) {
    return state.getSnapshot().actionPending[key] === true;
  }
  function actionError(key: ActionFeedbackKey) {
    return state.getSnapshot().actionErrors[key]?.message ?? "";
  }
  function actionErrorKey(key: ActionFeedbackKey) {
    return state.getSnapshot().actionErrors[key]?.productKey;
  }
  function clearActionFeedback(key: ActionFeedbackKey) {
    const next = { ...state.getSnapshot().actionErrors };
    delete next[key];
    state.setState({ actionErrors: next });
  }
  function clearAllActionFeedback() {
    // Close the old presentation before a subscriber can publish a new session's result.
    adjacentRefresh = undefined;
    toastManager.close();
    state.setState({
      actionPending: {},
      actionErrors: {},
      actionOutcomes: {},
      lastError: "",
    });
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
      const details = mapper(error);
      state.setState((current) => ({
        actionErrors: { ...current.actionErrors, [key]: details },
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
    toastManager,
    beginNotification,
    isActionPending,
    actionError,
    actionErrorKey,
    actionOutcome: (key: ActionFeedbackKey) =>
      state.getSnapshot().actionOutcomes[key],
    setActionOutcome(key: ActionFeedbackKey, outcome: MutationOutcome) {
      state.setState((current) => ({
        actionOutcomes: { ...current.actionOutcomes, [key]: outcome },
      }));
    },
    clearActionFeedback,
    clearAllActionFeedback,
    runAction,
    setErrorMapper(fn: (error: unknown) => string) {
      mapper = (error) => ({ message: fn(error) });
    },
  };
}

export function useActionFeedback() {
  return useStore(useSession().feedback);
}
