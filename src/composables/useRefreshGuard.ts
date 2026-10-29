import { useEffect, useMemo } from "react";
import type { SnapshotSegment } from "@/api/snapshot";
import { useSession } from "./session-context";

/**
 * Per-dialog "refresh epoch" guard. Each call to `next()` invalidates earlier
 * epochs; `refresh(token, apply)` runs the snapshot fetch and applies the
 * result *only* if the token is still the latest epoch and the session that
 * started the refresh is still current (a server switch, lock or same-server
 * re-unlock during the fetch drops it). `cancel()` is the "close-the-dialog"
 * shorthand for invalidating any in-flight refresh. Call `refresh` right after
 * `next()`: the session is captured when it starts.
 *
 * Replaces the recurring `let xxxRefreshGeneration = 0; ... if (generation
 * !== xxxRefreshGeneration) return;` pattern that lived in every dialog
 * lifecycle.
 */
export function createRefreshGuard(
  // Preserve existing Promise<void> callbacks alongside segment success results.
  refreshSnapshot: () => Promise<void | boolean>,
  captureSession: () => () => boolean,
) {
  let generation = 0;
  return {
    next(): number {
      generation += 1;
      return generation;
    },
    cancel(): void {
      generation += 1;
    },
    async refresh(
      token: number,
      apply: (fresh: boolean) => void,
    ): Promise<void> {
      const sameSession = captureSession();
      const result = await refreshSnapshot();
      if (token === generation && sameSession()) apply(result !== false);
    },
  };
}

// A segment guard reports whether its own read applied; existing whole-snapshot callers keep their behavior.
export function useRefreshGuard(segment?: SnapshotSegment) {
  const { snapshot } = useSession();
  const guard = useMemo(
    () =>
      createRefreshGuard(
        segment
          ? () => snapshot.refreshSegments([segment])
          : snapshot.refreshSnapshot,
        snapshot.captureSession,
      ),
    [snapshot, segment],
  );
  useEffect(() => () => guard.cancel(), [guard]);
  return guard;
}
