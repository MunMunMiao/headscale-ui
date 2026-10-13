import { useEffect, useReducer } from "react";
import type { HeadscaleNode, HeadscaleSnapshot, PreAuthKey } from "@/api/contracts";
import { ALL_SEGMENTS, fetchSegment, type SnapshotSegment } from "@/api/snapshot";
import { isTimestampExpired, msUntilNextExpiry } from "@/domain/node-status";
import { createStore } from "@/lib/store";
import type { SessionBridge } from "@/session/bridge";
import { ApiError } from "@/session/types";
import { getErrorMessage } from "@/utils/error-mapping";
import { useSession, useStore } from "./session-context";
import type { createActionFeedbackStore } from "./useActionFeedback";
import type { createHeadscaleClientStore } from "./useHeadscaleClient";

type ApplySnapshotHook = (next: HeadscaleSnapshot, patch: Partial<HeadscaleSnapshot>) => void;

interface SnapshotState {
  snapshot: HeadscaleSnapshot;
  isAuthorized: boolean;
  isReady: boolean;
  refreshSnapshotInFlight: number;
  refreshErrors: Partial<Record<SnapshotSegment, string>>;
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
  });
  let onApplySnapshot: ApplySnapshotHook | null = null;
  const emptySnapshot = state.getSnapshot().snapshot;
  const loadedSegments = new Set<SnapshotSegment>();
  let sessionRevision = 0;
  let policyRevision = 0;
  const generations: Record<SnapshotSegment, number> = { identity: 0, fabric: 0, policy: 0 };
  const controllers: Partial<Record<SnapshotSegment, AbortController>> = {};
  // Drops every read that started before now; their results and failures are ignored.
  function supersedeRequests() {
    ++sessionRevision;
    for (const segment of ALL_SEGMENTS) controllers[segment]?.abort();
    state.setState({ refreshSnapshotInFlight: 0 });
  }
  function changeSession() {
    supersedeRequests();
    loadedSegments.clear();
    state.setState({ isReady: false, refreshErrors: {} });
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
  async function refreshSegments(segments: readonly SnapshotSegment[]) {
    if (!state.getSnapshot().isAuthorized) return;
    state.setState((current) => ({ refreshSnapshotInFlight: current.refreshSnapshotInFlight + 1 }));
    const requestSession = sessionRevision;
    try {
      await Promise.all(
        [...new Set(segments)].map(async (segment) => {
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
            if (!isCurrent()) return;
            applyPatch(patch);
            loadedSegments.add(segment);
            state.setState((current) => {
              const refreshErrors = { ...current.refreshErrors };
              delete refreshErrors[segment];
              return { refreshErrors, isReady: loadedSegments.size === ALL_SEGMENTS.length };
            });
          } catch (error) {
            if (!isCurrent() || controller.signal.aborted) return;
            if (
              segment === "fabric" &&
              error instanceof Error &&
              "code" in error &&
              (error.code === "NET_UNREACHABLE" || error.code === "NET_TIMEOUT")
            )
              applyOfflineHealth();
            state.setState((current) => ({
              refreshErrors: { ...current.refreshErrors, [segment]: getErrorMessage(error) },
            }));
          } finally {
            if (controllers[segment] === controller) delete controllers[segment];
          }
        }),
      );
    } finally {
      if (requestSession === sessionRevision) {
        state.setState((current) => ({
          refreshSnapshotInFlight: Math.max(0, current.refreshSnapshotInFlight - 1),
        }));
      }
    }
  }
  async function refreshSnapshot() {
    await refreshSegments(ALL_SEGMENTS);
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
        .snapshot.preAuthKeys.filter((key) => !key.used && !isTimestampExpired(key.expiration));
    },
    get routeNodes() {
      return state
        .getSnapshot()
        .snapshot.nodes.filter(
          (node) => node.availableRoutes.length > 0 || node.approvedRoutes.length > 0,
        );
    },
    nodeById: (id: string) => state.getSnapshot().snapshot.nodes.find((node) => node.id === id),
    userById: (id: string) => state.getSnapshot().snapshot.users.find((user) => user.id === id),
    setAuthorized,
    // Same server, new credentials: keep data and readiness, only retire reads made with the old session.
    rebindSession: supersedeRequests,
    resetSnapshot,
    applyPatch,
    applyOfflineHealth,
    refreshSnapshot,
    refreshSegments,
    invalidatePolicyRefreshes() {
      ++policyRevision;
      controllers.policy?.abort();
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
function useExpiryTick(nodes: readonly HeadscaleNode[], preAuthKeys: readonly PreAuthKey[]) {
  const [tick, bump] = useReducer((count: number) => count + 1, 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick re-arms the timer after it fires or was clamped
  useEffect(() => {
    const ms = msUntilNextExpiry(
      [...nodes.map((node) => node.expiry), ...preAuthKeys.map((key) => key.expiration)],
      Date.now(),
    );
    if (ms === null) return;
    const id = setTimeout(bump, ms);
    return () => clearTimeout(id);
  }, [nodes, preAuthKeys, tick]);
}

export function useSnapshot() {
  const view = useStore(useSession().snapshot);
  useExpiryTick(view.snapshot.nodes, view.snapshot.preAuthKeys);
  return view;
}
