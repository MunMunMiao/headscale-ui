import { useEffect, useReducer } from "react";
import type {
  ApiKey,
  HeadscaleNode,
  HeadscaleSnapshot,
  PreAuthKey,
} from "@/api/contracts";
import {
  ALL_SEGMENTS,
  fetchSegment,
  type SnapshotSegment,
} from "@/api/snapshot";
import { msUntilNextExpiry } from "@/domain/node-status";
import {
  registrationKeyStatus,
  type TagReadStates,
} from "@/domain/tag-lifecycle";
import { createStore } from "@/lib/store";
import type { SessionBridge } from "@/session/bridge";
import { ApiError } from "@/session/types";
import { getErrorMessage } from "@/utils/error-mapping";
import { useSession, useStore } from "./session-context";
import type { createActionFeedbackStore } from "./useActionFeedback";
import type { createHeadscaleClientStore } from "./useHeadscaleClient";

type ApplySnapshotHook = (
  next: HeadscaleSnapshot,
  patch: Partial<HeadscaleSnapshot>,
) => void;

interface SnapshotState {
  snapshot: HeadscaleSnapshot;
  isAuthorized: boolean;
  isReady: boolean;
  refreshSnapshotInFlight: number;
  refreshErrors: Partial<Record<SnapshotSegment, string>>;
  segmentStatus: TagReadStates;
  versionFresh: boolean;
  /** A refresh the user asked for finished without errors; failures show in refreshErrors. */
  refreshNotice: boolean;
}

export function createSnapshotStore(
  auth: Pick<SessionBridge, "read">,
  client: ReturnType<typeof createHeadscaleClientStore>,
  feedback: ReturnType<typeof createActionFeedbackStore>,
) {
  const state = createStore<SnapshotState>({
    snapshot: {
      health: null,
      version: null,
      users: [],
      preAuthKeys: [],
      nodes: [],
      apiKeys: [],
      policy: null,
    },
    isAuthorized: false,
    isReady: false,
    refreshSnapshotInFlight: 0,
    refreshErrors: {},
    segmentStatus: {
      identity: "unknown",
      fabric: "unknown",
      policy: "unknown",
    },
    versionFresh: false,
    refreshNotice: false,
  });
  let onApplySnapshot: ApplySnapshotHook | null = null;
  const emptySnapshot = state.getSnapshot().snapshot;
  const loadedSegments = new Set<SnapshotSegment>();
  let sessionRevision = 0;
  let policyRevision = 0;
  let userRefreshGeneration = 0;
  const generations: Record<SnapshotSegment, number> = {
    identity: 0,
    fabric: 0,
    policy: 0,
  };
  const controllers: Partial<Record<SnapshotSegment, AbortController>> = {};
  // Drops every read that started before now; their results and failures are ignored.
  function supersedeRequests() {
    ++sessionRevision;
    for (const segment of ALL_SEGMENTS) controllers[segment]?.abort();
    state.setState({
      refreshSnapshotInFlight: 0,
      versionFresh: false,
      segmentStatus: {
        identity: "unknown",
        fabric: "unknown",
        policy: "unknown",
      },
    });
  }
  function changeSession() {
    supersedeRequests();
    loadedSegments.clear();
    state.setState({ isReady: false, refreshErrors: {}, refreshNotice: false });
    feedback.clearAllActionFeedback();
  }
  function setAuthorized(isAuthorized: boolean) {
    if (state.getSnapshot().isAuthorized === isAuthorized) return;
    changeSession();
    state.setState({ isAuthorized });
  }
  function applyPatch(patch: Partial<HeadscaleSnapshot>) {
    const snapshot = { ...state.getSnapshot().snapshot, ...patch };
    state.setState({ snapshot });
    onApplySnapshot?.(snapshot, patch);
  }
  function resetSnapshot() {
    changeSession();
    applyPatch(emptySnapshot);
  }
  function applyOfflineHealth() {
    state.setState((current) => ({
      snapshot: {
        ...current.snapshot,
        health: {
          checkedAt: new Date().toISOString(),
          databaseConnectivity: false,
          serverReachable: false,
        },
      },
    }));
  }
  /**
   * `applied` means this call applied every requested segment. `failed` excludes reads that a
   * newer request superseded, so callers do not report another operation's result as their own.
   */
  async function runSegments(
    segments: readonly SnapshotSegment[],
  ): Promise<{ applied: boolean; failed: boolean }> {
    if (!state.getSnapshot().isAuthorized)
      return { applied: false, failed: false };
    state.setState((current) => ({
      refreshSnapshotInFlight: current.refreshSnapshotInFlight + 1,
    }));
    const requestSession = sessionRevision;
    try {
      const applied = await Promise.all(
        [...new Set(segments)].map(async (segment) => {
          state.setState((current) => ({
            segmentStatus: { ...current.segmentStatus, [segment]: "loading" },
          }));
          const generation = ++generations[segment];
          controllers[segment]?.abort();
          const controller = new AbortController();
          controllers[segment] = controller;
          const requestPolicy = policyRevision;
          const isCurrent = () =>
            requestSession === sessionRevision &&
            generation === generations[segment] &&
            (segment !== "policy" || requestPolicy === policyRevision);
          try {
            const { identity } = client.getSnapshot();
            if (!identity) throw new ApiError({ kind: "locked" });
            const patch = await fetchSegment(
              (command, options) => auth.read(identity, command, options),
              segment,
              { signal: controller.signal },
            );
            if (!isCurrent()) return "superseded" as const;
            applyPatch(patch);
            loadedSegments.add(segment);
            state.setState((current) => {
              const refreshErrors = { ...current.refreshErrors };
              delete refreshErrors[segment];
              return {
                refreshErrors,
                isReady: loadedSegments.size === ALL_SEGMENTS.length,
                segmentStatus: { ...current.segmentStatus, [segment]: "ready" },
                ...(segment === "fabric"
                  ? { versionFresh: patch.version != null }
                  : {}),
              };
            });
            return "applied" as const;
          } catch (error) {
            if (!isCurrent() || controller.signal.aborted)
              return "superseded" as const;
            if (
              segment === "fabric" &&
              error instanceof Error &&
              "code" in error &&
              (error.code === "NET_UNREACHABLE" || error.code === "NET_TIMEOUT")
            )
              applyOfflineHealth();
            state.setState((current) => ({
              refreshErrors: {
                ...current.refreshErrors,
                [segment]: getErrorMessage(error),
              },
              segmentStatus: { ...current.segmentStatus, [segment]: "error" },
              ...(segment === "fabric" ? { versionFresh: false } : {}),
            }));
            return "failed" as const;
          } finally {
            if (controllers[segment] === controller)
              delete controllers[segment];
          }
        }),
      );
      return {
        applied: applied.every((status) => status === "applied"),
        failed: applied.includes("failed"),
      };
    } finally {
      if (requestSession === sessionRevision) {
        state.setState((current) => ({
          refreshSnapshotInFlight: Math.max(
            0,
            current.refreshSnapshotInFlight - 1,
          ),
        }));
      }
    }
  }
  async function refreshSegments(
    segments: readonly SnapshotSegment[],
  ): Promise<boolean> {
    return (await runSegments(segments)).applied;
  }
  async function refreshSnapshot() {
    await refreshSegments(ALL_SEGMENTS);
  }
  async function refreshByUser(
    segments: readonly SnapshotSegment[] = ALL_SEGMENTS,
  ) {
    const requestSession = sessionRevision;
    const refreshGeneration = ++userRefreshGeneration;
    const notification = feedback.beginNotification({
      isCurrent: () => requestSession === sessionRevision,
    });
    state.setState({ refreshNotice: false });
    const result = await runSegments(segments);
    if (
      requestSession !== sessionRevision ||
      refreshGeneration !== userRefreshGeneration
    )
      return;
    const { isAuthorized, refreshErrors } = state.getSnapshot();
    if (!isAuthorized) return;
    if (segments.some((segment) => refreshErrors[segment])) {
      if (result.failed)
        notification.publish({
          tone: "error",
          title: "product.feedbackRefreshFailed",
        });
      return;
    }
    // A newer request replaced this one's reads; it owns whatever result appears next.
    if (!result.applied) return;
    state.setState({ refreshNotice: true });
    notification.publish({ tone: "success", title: "product.dataRefreshed" });
  }
  return {
    getSnapshot: state.getSnapshot,
    subscribe: state.subscribe,
    get isRefreshing() {
      return state.getSnapshot().refreshSnapshotInFlight > 0;
    },
    get onlineNodes() {
      return state.getSnapshot().snapshot.nodes.filter((node) => node.online);
    },
    get openInvites() {
      return state
        .getSnapshot()
        .snapshot.preAuthKeys.filter(
          (key) =>
            !key.used &&
            registrationKeyStatus(key).registration === "available",
        );
    },
    get routeNodes() {
      return state
        .getSnapshot()
        .snapshot.nodes.filter(
          (node) =>
            node.availableRoutes.length > 0 || node.approvedRoutes.length > 0,
        );
    },
    nodeById: (id: string) =>
      state.getSnapshot().snapshot.nodes.find((node) => node.id === id),
    userById: (id: string) =>
      state.getSnapshot().snapshot.users.find((user) => user.id === id),
    setAuthorized,
    // Same server, new credentials: keep data and readiness, only retire reads made with the old session.
    rebindSession: supersedeRequests,
    resetSnapshot,
    applyPatch,
    applyOfflineHealth,
    refreshSnapshot,
    refreshSegments,
    refreshByUser,
    clearRefreshNotice() {
      state.setState({ refreshNotice: false });
    },
    invalidatePolicyRefreshes() {
      ++policyRevision;
      controllers.policy?.abort();
      if (state.getSnapshot().segmentStatus.policy === "loading")
        state.setState((current) => ({
          segmentStatus: { ...current.segmentStatus, policy: "unknown" },
        }));
    },
    captureSession() {
      const captured = sessionRevision;
      return () => captured === sessionRevision;
    },
    setOnApplySnapshot(hook: ApplySnapshotHook | null) {
      onApplySnapshot = hook;
    },
  };
}

// Expiry is derived from the clock, so re-render once just after the next expiry instant, without fetching.
function useExpiryTick(
  nodes: readonly HeadscaleNode[],
  preAuthKeys: readonly PreAuthKey[],
  apiKeys: readonly ApiKey[],
) {
  const [tick, bump] = useReducer((count: number) => count + 1, 0);
  // tick re-arms the timer after it fires or was clamped
  useEffect(() => {
    const ms = msUntilNextExpiry(
      [
        ...nodes.map((node) => node.expiry),
        ...preAuthKeys.map((key) => key.expiration),
        ...apiKeys.map((key) => key.expiration),
      ],
      Date.now(),
    );
    if (ms === null) return;
    const id = setTimeout(bump, ms);
    return () => clearTimeout(id);
  }, [nodes, preAuthKeys, apiKeys, tick]);
}

export function useSnapshot() {
  const view = useStore(useSession().snapshot);
  useExpiryTick(
    view.snapshot.nodes,
    view.snapshot.preAuthKeys,
    view.snapshot.apiKeys,
  );
  return view;
}

const AUTO_REFRESH_MS = 30_000;

/**
 * Re-reads the server every 30 s while the page is visible, and once when it becomes visible again,
 * so device status and new devices appear without a manual refresh. It waits while a refresh runs
 * or a draft or dialog is open or held, so open forms keep their data. Reads are not user activity:
 * polling never renews the session (README "Shared session and logout").
 */
export function useAutoRefresh() {
  const { snapshot, drafts } = useSession();
  const { isAuthorized } = useStore(snapshot);
  useEffect(() => {
    if (!isAuthorized) return;
    function refresh() {
      if (
        document.visibilityState !== "visible" ||
        snapshot.isRefreshing ||
        drafts.hasActiveDrafts() ||
        !drafts.isCurrent()
      )
        return;
      void snapshot.refreshSnapshot();
    }
    const timer = setInterval(refresh, AUTO_REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [snapshot, drafts, isAuthorized]);
}
