import { createStore } from "@/lib/store";
import type { PublicSessionSnapshot, SessionIdentity } from "@/session/types";
import { useSession, useStore } from "./session-context";

/** The unlocked session the page publishes its requests under, and the server it shows. */
export function createHeadscaleClientStore() {
  const state = createStore<{
    settings: { baseUrl: string };
    identity: SessionIdentity | null;
  }>({
    settings: { baseUrl: "" },
    identity: null,
  });
  function clear() {
    state.setState({ settings: { baseUrl: "" }, identity: null });
  }
  return {
    getSnapshot: state.getSnapshot,
    subscribe: state.subscribe,
    clear,
    adopt(snapshot: PublicSessionSnapshot) {
      const identity = snapshot.identity;
      if (!identity || !snapshot.profile || snapshot.status !== "unlocked")
        return clear();
      const previous = state.getSnapshot().identity;
      if (
        previous?.workerId === identity.workerId &&
        previous.sessionId === identity.sessionId
      )
        return;
      state.setState({
        settings: { baseUrl: snapshot.profile.baseUrl },
        identity: Object.freeze({
          workerId: identity.workerId,
          sessionId: identity.sessionId,
        }),
      });
    },
  };
}

export function useHeadscaleClient() {
  return useStore(useSession().client);
}
