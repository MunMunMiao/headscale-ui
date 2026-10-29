import { normalizePublicLoginServer } from "@/domain/auth-request";
import type { NodeTagBaseline } from "@/domain/tag-lifecycle";
import { createStore } from "@/lib/store";
import type { WorkerErrorDto } from "@/session/types";

export interface LifecycleScope {
  /** Monotonic token: equal server/version fields must not revive an invalidated confirmation. */
  generation: number;
  profileId: string;
  baseUrl: string;
  workerId: string;
  sessionId: string;
  viewEpoch: number;
  version: string | null;
  versionFresh: boolean;
}
type LifecycleBinding = Omit<LifecycleScope, "generation">;

export interface TagInviteDraft {
  userId: string;
  userName: string;
  tags: string[];
  tagInput: string;
  reusable: boolean;
  ephemeral: boolean;
  expiration: string;
  expirationMode: "preset" | "custom";
  expiryDays: string;
}
interface TagReturnContext {
  managedTag: string;
  editVersion: number;
  filter?: string;
}
export type TagReturnDraft = TagReturnContext &
  (
    | {
        source: "device";
        nodeId: string;
        tags: string[];
        baseline: NodeTagBaseline;
      }
    | {
        source: "invite" | "member-invite";
        form: TagInviteDraft;
        memberId?: string;
      }
    | {
        source: "setup";
        form: TagInviteDraft;
        task: "server" | "client" | null;
        step: "type" | "preferences" | "authKey" | "generate" | "result";
        advertiseExitNode: boolean;
        loginServer: string | null;
      }
  );
export type TagReturnRecord = TagReturnDraft & {
  id: string;
  scope: LifecycleScope;
  status: "managing" | "returning";
};
export interface TagMaintenanceDraft {
  tag: string;
  targetInput: string;
  intent: "new" | "existing";
}
export interface MutationOutcome {
  status:
    | "not-dispatched"
    | "confirmed"
    | "pre-rejected"
    | "possibly-applied"
    | "unknown";
  refresh: "not-requested" | "succeeded" | "failed";
  failure?: {
    kind: WorkerErrorDto["kind"];
    code?: string;
    status?: number;
    message?: string;
  };
}

function copyBaseline({
  nodeId,
  machineKey,
  user,
  tags,
}: NodeTagBaseline): NodeTagBaseline {
  return {
    nodeId,
    machineKey,
    user: user ? { id: user.id, name: user.name } : null,
    tags: [...tags],
  };
}
function copyForm({
  userId,
  userName,
  tags,
  tagInput,
  reusable,
  ephemeral,
  expiration,
  expirationMode,
  expiryDays,
}: TagInviteDraft): TagInviteDraft {
  return {
    userId,
    userName,
    tags: [...tags],
    tagInput,
    reusable,
    ephemeral,
    expiration,
    expirationMode,
    expiryDays,
  };
}
function copyScope({
  generation,
  profileId,
  baseUrl,
  workerId,
  sessionId,
  viewEpoch,
  version,
  versionFresh,
}: LifecycleScope): LifecycleScope {
  return {
    generation,
    profileId,
    baseUrl,
    workerId,
    sessionId,
    viewEpoch,
    version,
    versionFresh,
  };
}
function sameServer(
  left: LifecycleBinding | null,
  right: LifecycleBinding | null,
): boolean {
  return Boolean(
    left &&
    right &&
    left.profileId === right.profileId &&
    left.baseUrl === right.baseUrl,
  );
}
function sameIdentity(
  left: LifecycleBinding | null,
  right: LifecycleBinding | null,
): boolean {
  return (
    sameServer(left, right) &&
    left?.workerId === right?.workerId &&
    left?.sessionId === right?.sessionId &&
    left?.viewEpoch === right?.viewEpoch
  );
}
function sameScope(
  left: LifecycleBinding | null,
  right: LifecycleBinding | null,
): boolean {
  return (
    sameIdentity(left, right) &&
    left?.version === right?.version &&
    left?.versionFresh === right?.versionFresh
  );
}
function copyReturn(draft: TagReturnDraft): TagReturnDraft | null {
  const common = {
    managedTag: draft.managedTag,
    editVersion: draft.editVersion,
    ...(draft.filter === undefined ? {} : { filter: draft.filter }),
  };
  switch (draft.source) {
    case "device":
      return {
        ...common,
        source: draft.source,
        nodeId: draft.nodeId,
        tags: [...draft.tags],
        baseline: copyBaseline(draft.baseline),
      };
    case "invite":
    case "member-invite":
      return {
        ...common,
        source: draft.source,
        form: copyForm(draft.form),
        ...(draft.memberId === undefined ? {} : { memberId: draft.memberId }),
      };
    case "setup":
      return draft.loginServer === null ||
        normalizePublicLoginServer(draft.loginServer) !== null
        ? {
            ...common,
            source: draft.source,
            form: copyForm(draft.form),
            task: draft.task,
            step: draft.step,
            advertiseExitNode: draft.advertiseExitNode,
            loginServer: draft.loginServer,
          }
        : null;
  }
}

/** One nonsecret return slot, isolated by session generation; never an operation replay queue. */
export function createTagLifecycleStore() {
  const state = createStore<{
    scope: LifecycleScope | null;
    returnTo: TagReturnRecord | null;
    maintenanceDraft: TagMaintenanceDraft | null;
  }>({ scope: null, returnTo: null, maintenanceDraft: null });
  let sequence = 0;
  let generation = -1;
  const isCurrent = (scope: LifecycleScope | null) =>
    scope?.generation === state.getSnapshot().scope?.generation &&
    sameScope(scope, state.getSnapshot().scope);
  return {
    getSnapshot: state.getSnapshot,
    subscribe: state.subscribe,
    bind(scope: LifecycleBinding | null) {
      const current = state.getSnapshot();
      if (
        (scope === null && current.scope === null) ||
        sameScope(scope, current.scope)
      )
        return;
      ++generation;
      const next = scope ? copyScope({ ...scope, generation }) : null;
      state.setState({
        scope: next,
        maintenanceDraft: sameIdentity(current.scope, next)
          ? current.maintenanceDraft
          : null,
        returnTo:
          current.returnTo && sameIdentity(current.scope, next) && next
            ? { ...current.returnTo, scope: next }
            : null,
      });
    },
    rememberMaintenance({ tag, targetInput, intent }: TagMaintenanceDraft) {
      if (state.getSnapshot().scope)
        state.setState({ maintenanceDraft: { tag, targetInput, intent } });
    },
    captureScope: (): LifecycleScope | null => state.getSnapshot().scope,
    isCurrent,
    saveReturn(draft: TagReturnDraft): TagReturnRecord | null {
      const scope = state.getSnapshot().scope;
      const fields = copyReturn(draft);
      if (!scope || !fields) return null;
      const record: TagReturnRecord = {
        ...fields,
        id: `tag-return-${++sequence}`,
        scope,
        status: "managing",
      };
      state.setState({ returnTo: record });
      return record;
    },
    requestReturn(id: string): boolean {
      const record = state.getSnapshot().returnTo;
      if (!record || record.id !== id) return false;
      state.setState({ returnTo: { ...record, status: "returning" } });
      return true;
    },
    consumeReturn(id: string): TagReturnRecord | null {
      const record = state.getSnapshot().returnTo;
      if (!record || record.id !== id) return null;
      state.setState({ returnTo: null });
      return record;
    },
    cancelReturn(id?: string): void {
      if (id === undefined || state.getSnapshot().returnTo?.id === id)
        state.setState({ returnTo: null });
    },
  };
}
