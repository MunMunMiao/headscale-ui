import { useMemo } from "react";
import { redactDiagnosticData } from "@/api/operation-log";
import { ALL_SEGMENTS } from "@/api/snapshot";
import type { SessionRequestOptions } from "@/session/auth-session";
import type { ApiCommand, ApiOutput, EndpointName } from "@/session/protocol";
import { ApiError, type WorkerErrorDto } from "@/session/types";
import { getErrorMessage } from "@/utils/error-mapping";
import { type Session, useSession, useStore } from "./session-context";
import type { MutationOutcome } from "./tag-lifecycle-state";
import type { ActionFeedbackKey, ActionResult } from "./useActionFeedback";

export type DetailedMutationResult<T> =
  | { ok: true; result: T; outcome: MutationOutcome }
  | { ok: false; outcome: MutationOutcome };
interface UseMutationOptions {
  /** The caller handles response adoption or its own refresh. */
  skipRefresh?: boolean;
}
interface UseMutationReturn {
  mutateDetailed<K extends EndpointName>(
    key: ActionFeedbackKey,
    command: ApiCommand<K>,
    options?: SessionRequestOptions,
  ): Promise<DetailedMutationResult<ApiOutput<K>>>;
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

const DRY_RUNS: ReadonlySet<EndpointName> = new Set(["checkPolicy"]);
const NOT_SENT: ReadonlySet<ApiError["code"]> = new Set([
  "REQ_BUILD_FAILED",
  "REQ_INPUT_INVALID",
  "REQ_OPTIONS_INVALID",
  "ENV_UNSUPPORTED",
  "CAP_BUFFER_EXCEEDED",
  "CAP_QUEUE_OVERFLOW",
]);

// These exact v0.29.4 failures precede any mutation. A generic 4xx is not such evidence.
function preRejected(endpoint: EndpointName, error: ApiError): boolean {
  const message = error.data?.message?.trim() ?? "";
  if (error.code !== "HTTP_STATUS") return false;
  if (endpoint === "setPolicy")
    return message === "update is disabled for modes other than 'database'";
  if (endpoint === "authRegister")
    return message === "looking up user: user not found";
  const tagFormat =
    /^(?:tag should be lowercase|tags must not contain spaces|tag must start with the string 'tag:')$/.test(
      message,
    );
  if (endpoint === "createPreAuthKey")
    return (
      tagFormat ||
      message === "auth-key must be either tagged or owned by user" ||
      message === "user not found"
    );
  return (
    endpoint === "setTags" &&
    (tagFormat ||
      /^(?:cannot remove all tags from a node - tagged nodes must have at least one tag|node not found)$/.test(
        message,
      ) ||
      /^requested tags \[.*\] are invalid or not permitted$/.test(message))
  );
}
function failureOutcome(
  endpoint: EndpointName,
  error: unknown,
  dispatched: boolean,
): MutationOutcome {
  const dryRun = DRY_RUNS.has(endpoint);
  const api = error instanceof ApiError ? error : null;
  const status = !dispatched
    ? "not-dispatched"
    : api?.status === 401 || api?.status === 403
      ? "pre-rejected"
      : api?.outcome === "unknown" && !dryRun
        ? "unknown"
        : api && (api.kind !== "api" || NOT_SENT.has(api.code))
          ? "not-dispatched"
          : dryRun || (api && preRejected(endpoint, api))
            ? "pre-rejected"
            : api?.code === "HTTP_STATUS"
              ? "possibly-applied"
              : "unknown";
  return {
    status,
    refresh: "not-requested",
    failure: {
      kind: api?.kind ?? "unavailable",
      code: api?.code,
      status: api?.status,
      message: getErrorMessage(error),
    },
  };
}

function safeReplyError(command: ApiCommand, error: WorkerErrorDto): ApiError {
  const input = "input" in command ? command.input : undefined;
  const secret =
    input && "authId" in input
      ? input.authId
      : input && "key" in input
        ? input.key
        : "";
  const clean = redactDiagnosticData(
    error,
    typeof secret === "string" ? secret : "",
  );
  return new ApiError(
    DRY_RUNS.has(command.endpoint) ? { ...clean, outcome: undefined } : clean,
  );
}

type MutationSession = Pick<
  Session,
  "client" | "snapshot" | "feedback" | "drafts"
> &
  Partial<Pick<Session, "tagLifecycle">> & {
    auth: Pick<Session["auth"], "write">;
  };

/** Each explicit submission dispatches at most once and reports its outcome separately from refresh. */
export function createMutation(
  session: MutationSession,
  opts: UseMutationOptions = {},
): UseMutationReturn {
  const { runAction } = session.feedback;
  const { captureSession } = session.snapshot;
  const identity = session.client.getSnapshot().identity;
  const ownsSession = captureSession();
  const viewEpoch = session.drafts.getSnapshot().viewEpoch;
  const ownsView = () => viewEpoch === session.drafts.getSnapshot().viewEpoch;
  const scope = session.tagLifecycle?.captureScope() ?? null;

  async function mutateDetailed<K extends EndpointName>(
    key: ActionFeedbackKey,
    command: ApiCommand<K>,
    options?: SessionRequestOptions,
  ): Promise<DetailedMutationResult<ApiOutput<K>>> {
    let outcome: MutationOutcome = {
      status: "not-dispatched",
      refresh: "not-requested",
    };
    if (
      !ownsSession() ||
      !ownsView() ||
      (scope && !session.tagLifecycle?.isCurrent(scope))
    )
      return { ok: false, outcome };
    const isCurrentSession = captureSession();
    const isCurrent = () => isCurrentSession() && ownsView();
    const dryRun = DRY_RUNS.has(command.endpoint);
    const skipRefresh = opts.skipRefresh || dryRun;
    let dispatched = false;
    let ran = false;
    const refresh = async () => {
      outcome = {
        ...outcome,
        refresh: (await session.snapshot.refreshSegments(ALL_SEGMENTS))
          ? "succeeded"
          : "failed",
      };
    };
    const completed = await runAction(
      key,
      async () => {
        ran = true;
        try {
          if (!session.drafts.isCurrent())
            throw new ApiError({ kind: "stale" });
          if (!identity) throw new ApiError({ kind: "locked" });
          dispatched = true;
          const reply = await session.auth.write(
            identity,
            command,
            options?.signal ? { signal: options.signal } : undefined,
          );
          if (!reply.ok) {
            const error = safeReplyError(command as ApiCommand, reply.error);
            outcome = failureOutcome(command.endpoint, error, dispatched);
            // Refresh once after a server answer or a lost response; never replay the write.
            if (
              (error.kind === "api" || error.outcome === "unknown") &&
              !skipRefresh &&
              isCurrent() &&
              session.drafts.isCurrent()
            )
              await refresh();
            throw error;
          }
          outcome = { status: "confirmed", refresh: "not-requested" };
          if (!session.drafts.isCurrent())
            throw new ApiError({
              kind: "stale",
              outcome: dryRun ? undefined : "unknown",
            });
          if (isCurrent() && !skipRefresh) await refresh();
          return reply.value;
        } catch (error) {
          if (outcome.status === "not-dispatched")
            outcome = failureOutcome(command.endpoint, error, dispatched);
          throw error;
        }
      },
      isCurrent,
    );
    if (ran && isCurrent()) session.feedback.setActionOutcome(key, outcome);
    return completed.ok ? { ...completed, outcome } : { ok: false, outcome };
  }
  return {
    mutateDetailed,
    async mutateWith(key, command, options) {
      const completed = await mutateDetailed(key, command, options);
      return completed.ok
        ? { ok: true, result: completed.result }
        : { ok: false };
    },
    async mutate(key, command, options) {
      return (await mutateDetailed(key, command, options)).ok;
    },
  };
}

export function useMutation({
  skipRefresh = false,
}: UseMutationOptions = {}): UseMutationReturn {
  const session = useSession();
  const { identity } = useStore(session.client);
  const { scope } = useStore(session.tagLifecycle);
  // The factory captures the external store's current session and lifecycle scope.
  return useMemo(
    () => createMutation(session, { skipRefresh }),
    [session, skipRefresh, identity, scope],
  );
}
