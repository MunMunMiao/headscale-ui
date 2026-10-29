import { type AnyRouter, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { isLoginPath, redirectTarget } from "@/router/search";
import { type Session, useSession } from "./session-context";

export function createSessionRestoration(session: Session, router: AnyRouter) {
  let generation = 0;
  const requiresAuth = () =>
    router.state.matches.some((match) => match.staticData.requiresAuth);
  async function reconcile() {
    const location = router.state.location;
    // A page already leaving for login (logout) still has the old matches and keeps its own redirect.
    if (
      session.auth.getSnapshot().status !== "ready-unlocked" &&
      requiresAuth() &&
      !isLoginPath(location.pathname)
    ) {
      await router.navigate({
        to: "/login",
        replace: true,
        search: {
          ...(typeof location.search.profile === "string"
            ? { profile: location.search.profile }
            : {}),
          redirect: location.href,
        },
      });
    }
  }
  /** A login page continues once any tab unlocks; this tab's own unlock or save navigates itself. */
  function follow(): boolean {
    const location = router.state.location;
    const current = session.auth.getSessionSnapshot();
    if (current?.status !== "unlocked" || !isLoginPath(location.pathname))
      return false;
    const { phase, connectionDialogOpen, discardedPolicyDraft } =
      session.profiles.getSnapshot();
    // An open profile form keeps its typed input, and discarded edits are explained first.
    if (
      phase.kind === "idle" &&
      !connectionDialogOpen &&
      !discardedPolicyDraft
    ) {
      session.profiles.closeUnlockDialog();
      void router.navigate(
        redirectTarget(
          location.search.redirect,
          current.profile,
          session.navigationProfile,
        ),
      );
    }
    return true;
  }
  async function restore() {
    const ticket = ++generation;
    await session.auth.check();
    if (ticket === generation) await reconcile();
  }
  function start() {
    let previousPath = router.state.location.pathname;
    let previous = session.auth.getSessionSnapshot()?.identity;
    let previousStatus = session.auth.getSnapshot().status;
    const stopRoute = router.subscribe("onLoad", ({ toLocation }) => {
      const changed = previousPath !== toLocation.pathname;
      previousPath = toLocation.pathname;
      if (requiresAuth() && session.snapshot.getSnapshot().isAuthorized) {
        if (session.drafts.isCurrent()) session.acceptNavigationProfile();
        if (changed) void session.snapshot.refreshSnapshot();
      }
    });
    const stopAuth = session.auth.subscribe(() => {
      const current = session.auth.getSessionSnapshot()?.identity;
      const status = session.auth.getSnapshot().status;
      if (
        previous?.workerId === current?.workerId &&
        previous?.sessionId === current?.sessionId &&
        previousStatus === status
      )
        return;
      ++generation;
      const switched = previous && current;
      previous = current;
      previousStatus = status;
      if (follow()) return;
      const profile = session.auth.getSessionSnapshot()?.profile;
      if (
        switched &&
        profile &&
        (profile.id !== session.navigationProfile?.id ||
          profile.baseUrl !== session.navigationProfile.baseUrl)
      ) {
        // A held editor must be explicitly discarded before its URL can follow the new server.
        if (session.drafts.isCurrent())
          void router.navigate(
            redirectTarget(
              router.state.location.href,
              profile,
              session.navigationProfile,
            ),
          );
      } else void reconcile();
    });
    void restore();
    return () => {
      ++generation;
      stopRoute();
      stopAuth();
    };
  }
  return { restore, start };
}
export function useSessionRestore(): void {
  const session = useSession();
  const router = useRouter();
  const restoration = useMemo(
    () => createSessionRestoration(session, router),
    [session, router],
  );
  useEffect(() => restoration.start(), [restoration]);
}
