import { useEffect, useMemo } from "react";
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
  refreshSnapshot: () => Promise<void>,
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
    async refresh(token: number, apply: () => void): Promise<void> {
      const sameSession = captureSession();
      await refreshSnapshot();
      if (token === generation && sameSession()) apply();
    },
  };
}

export function useRefreshGuard() {
  const { snapshot } = useSession();
  const guard = useMemo(
    () => createRefreshGuard(snapshot.refreshSnapshot, snapshot.captureSession),
    [snapshot],
  );
  useEffect(() => () => guard.cancel(), [guard]);
  return guard;
}
