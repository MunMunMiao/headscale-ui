import { type ComputedRef, computed, type Ref, ref, watch } from "vue";
import type {
  HeadscaleClient,
  HeadscaleNode,
  HeadscaleSnapshot,
  HeadscaleUser,
  PreAuthKey,
} from "@/api/types";
import { isTimestampExpired } from "@/domain/node-status";
import { useActionFeedback } from "./useActionFeedback";
import { useHeadscaleClient } from "./useHeadscaleClient";

type ApplySnapshotHook = (next: HeadscaleSnapshot, patch: Partial<HeadscaleSnapshot>) => void;

export type SnapshotSegment = "identity" | "fabric" | "policy";

export const ALL_SEGMENTS: readonly SnapshotSegment[] = ["identity", "fabric", "policy"];

interface UseSnapshotReturn {
  snapshot: Ref<HeadscaleSnapshot>;
  isAuthorized: Ref<boolean>;
  isRefreshing: ComputedRef<boolean>;
  refreshSnapshotInFlight: Ref<number>;
  onlineNodes: ComputedRef<HeadscaleNode[]>;
  openInvites: ComputedRef<PreAuthKey[]>;
  routeNodes: ComputedRef<HeadscaleNode[]>;
  /** Find a node by id in the current snapshot (returns `undefined` if absent). */
  nodeById(id: string): HeadscaleNode | undefined;
  /** Find a user by id in the current snapshot (returns `undefined` if absent). */
  userById(id: string): HeadscaleUser | undefined;
  applySnapshot(next: HeadscaleSnapshot): void;
  applyPatch(patch: Partial<HeadscaleSnapshot>): void;
  applyOfflineHealth(): void;
  refreshSnapshot(): Promise<void>;
  refreshSegments(segments: readonly SnapshotSegment[]): Promise<void>;
  invalidatePolicyRefreshes(): void;
  captureSession(): () => boolean;
  setOnApplySnapshot(hook: ApplySnapshotHook | null): void;
}

let instance: UseSnapshotReturn | null = null;

/** Internal: invoked by `__testing.ts` only. */
export const snapshotTestingHandle = {
  reset() {
    instance = null;
  },
};

const SEGMENT_FETCHERS: Record<
  SnapshotSegment,
  (client: HeadscaleClient) => Promise<Partial<HeadscaleSnapshot>>
> = {
  identity: async (client) => {
    const [users, preAuthKeys, apiKeys] = await Promise.all([
      client.listUsers({}),
      client.listPreAuthKeys(),
      client.listApiKeys(),
    ]);
    return {
      users: users.users,
      preAuthKeys: preAuthKeys.preAuthKeys,
      apiKeys: apiKeys.apiKeys,
    };
  },
  fabric: async (client) => {
    const [health, version, nodes] = await Promise.all([
      client.health(),
      client.version(),
      client.listNodes({}),
    ]);
    return { health, version, nodes: nodes.nodes };
  },
  policy: async (client) => {
    const policy = await client.getPolicy();
    return { policy };
  },
};

export async function fetchSegments(
  client: HeadscaleClient,
  segments: readonly SnapshotSegment[],
): Promise<Partial<HeadscaleSnapshot>> {
  const parts = await Promise.all(segments.map((s) => SEGMENT_FETCHERS[s](client)));
  return Object.assign({}, ...parts);
}

export async function fetchSnapshot(client: HeadscaleClient): Promise<HeadscaleSnapshot> {
  const merged = await fetchSegments(client, ALL_SEGMENTS);
  return merged as HeadscaleSnapshot;
}

export function useSnapshot(): UseSnapshotReturn {
  if (instance) return instance;

  const { createClient } = useHeadscaleClient();
  const { lastError, clearAllActionFeedback } = useActionFeedback();

  const snapshot = ref<HeadscaleSnapshot>({
    health: null,
    version: null,
    users: [],
    preAuthKeys: [],
    nodes: [],
    apiKeys: [],
    policy: null,
  });
  const isAuthorized = ref(false);
  const refreshSnapshotInFlight = ref(0);

  const isRefreshing = computed(() => refreshSnapshotInFlight.value > 0);
  const onlineNodes = computed(() => snapshot.value.nodes.filter((node) => node.online));
  const openInvites = computed(() =>
    snapshot.value.preAuthKeys.filter((key) => !key.used && !isTimestampExpired(key.expiration)),
  );
  const routeNodes = computed(() =>
    snapshot.value.nodes.filter(
      (node) => node.availableRoutes.length > 0 || node.approvedRoutes.length > 0,
    ),
  );

  let onApplySnapshot: ApplySnapshotHook | null = null;
  let sessionRevision = 0;
  let policyRevision = 0;
  function changeSession() {
    ++sessionRevision;
    clearAllActionFeedback();
  }
  watch(isAuthorized, changeSession, { flush: "sync" });

  function applyPatch(patch: Partial<HeadscaleSnapshot>) {
    snapshot.value = { ...snapshot.value, ...patch };
    onApplySnapshot?.(snapshot.value, patch);
  }

  function applySnapshot(nextSnapshot: HeadscaleSnapshot) {
    changeSession();
    applyPatch(nextSnapshot);
  }

  function applyOfflineHealth() {
    snapshot.value = {
      ...snapshot.value,
      health: {
        checkedAt: new Date().toISOString(),
        databaseConnectivity: false,
        serverReachable: false,
      },
    };
  }

  async function refreshSegments(segments: readonly SnapshotSegment[]) {
    if (!isAuthorized.value) {
      return;
    }

    refreshSnapshotInFlight.value += 1;
    const requestSession = sessionRevision;
    const requestPolicy = policyRevision;
    try {
      const patch = await fetchSegments(createClient(), segments);
      if (requestSession !== sessionRevision) return;
      // A save can finish before an older GET; retain its other fresh segments.
      if (requestPolicy !== policyRevision) delete patch.policy;
      applyPatch(patch);
      lastError.value = "";
    } catch (error) {
      if (requestSession !== sessionRevision) return;
      applyOfflineHealth();
      lastError.value = error instanceof Error ? error.message : String(error);
    } finally {
      refreshSnapshotInFlight.value = Math.max(0, refreshSnapshotInFlight.value - 1);
    }
  }

  async function refreshSnapshot() {
    await refreshSegments(ALL_SEGMENTS);
  }

  function setOnApplySnapshot(hook: ApplySnapshotHook | null) {
    onApplySnapshot = hook;
  }

  instance = {
    snapshot,
    isAuthorized,
    isRefreshing,
    refreshSnapshotInFlight,
    onlineNodes,
    openInvites,
    routeNodes,
    nodeById: (id) => snapshot.value.nodes.find((n) => n.id === id),
    userById: (id) => snapshot.value.users.find((u) => u.id === id),
    applySnapshot,
    applyPatch,
    applyOfflineHealth,
    refreshSnapshot,
    refreshSegments,
    invalidatePolicyRefreshes: () => ++policyRevision,
    captureSession() {
      const captured = sessionRevision;
      return () => captured === sessionRevision;
    },
    setOnApplySnapshot,
  };
  return instance;
}
