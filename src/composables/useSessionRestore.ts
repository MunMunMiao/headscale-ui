import { type AnyRouter, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { type Session, useSession } from "./session-context";

export function createSessionRestoration(session: Session, router: AnyRouter) {
  let generation = 0;
  const requiresAuth = () => router.state.matches.some((match) => match.staticData.requiresAuth);
  async function reconcile() {
    if (session.auth.getSnapshot().status !== "ready-unlocked" && requiresAuth()) {
      const location = router.state.location;
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
      if (changed && requiresAuth() && session.snapshot.getSnapshot().isAuthorized)
        void session.snapshot.refreshSnapshot();
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
      if (switched && router.state.location.search.profile) {
        const { profile: _profile, ...search } = router.state.location.search;
        void router.navigate({
          to: router.state.location.pathname,
          search,
          hash: router.state.location.hash,
          replace: true,
        });
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
  const restoration = useMemo(() => createSessionRestoration(session, router), [session, router]);
  useEffect(() => restoration.start(), [restoration]);
}
