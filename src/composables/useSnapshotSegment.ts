import { useMemo } from "react";
import type { SnapshotSegment } from "@/api/snapshot";
import { createStore } from "@/lib/store";
import { useSession, useStore } from "./session-context";

export function createSegmentStore(
  refreshSegments: (segments: readonly SnapshotSegment[]) => Promise<void>,
) {
  const state = createStore({ inFlight: 0 });

  async function refresh(segments: readonly SnapshotSegment[]) {
    state.setState((current) => ({ inFlight: current.inFlight + 1 }));
    try {
      await refreshSegments(segments);
    } finally {
      state.setState((current) => ({
        inFlight: Math.max(0, current.inFlight - 1),
      }));
    }
  }

  return { ...state, refresh };
}

/** A page's refresh button: the shell announces its success (snapshot `refreshNotice`). */
export function useSegment(...segments: SnapshotSegment[]) {
  const { snapshot } = useSession();
  const store = useMemo(
    () => createSegmentStore(snapshot.refreshByUser),
    [snapshot],
  );
  const current = useStore(store);
  return {
    isRefreshing: current.inFlight > 0,
    refresh: () => current.refresh(segments),
  };
}
