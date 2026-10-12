import { ApiError, createHeadscaleGateway, type HeadscaleGateway } from "@/api/gateway";
import { createStore } from "@/lib/store";
import type { SessionBridge } from "@/session/bridge";
import type { PublicSessionSnapshot, SessionIdentity } from "@/session/types";
import { useSession, useStore } from "./session-context";

export function createHeadscaleClientStore(bridge: Pick<SessionBridge, "execute">) {
  const state = createStore<{
    settings: { baseUrl: string };
    identity: SessionIdentity | null;
    http: HeadscaleGateway | null;
  }>({ settings: { baseUrl: "" }, identity: null, http: null });
  function clear() {
    state.setState({ settings: { baseUrl: "" }, identity: null, http: null });
  }
  return {
    getSnapshot: state.getSnapshot,
    subscribe: state.subscribe,
    clear,
    adopt(snapshot: PublicSessionSnapshot) {
      const identity = snapshot.identity;
      if (!identity || !snapshot.profile || snapshot.status !== "unlocked") return clear();
      const previous = state.getSnapshot().identity;
      if (previous?.workerId === identity.workerId && previous.sessionId === identity.sessionId)
        return;
      const expected = Object.freeze({
        workerId: identity.workerId,
        sessionId: identity.sessionId,
      });
      const http = createHeadscaleGateway((command, options) =>
        bridge.execute(expected, command, options),
      );
      state.setState({ settings: { baseUrl: snapshot.profile.baseUrl }, identity: expected, http });
    },
    createClient(): HeadscaleGateway {
      const client = state.getSnapshot().http;
      if (!client) throw new ApiError({ kind: "locked" });
      return client;
    },
  };
}

export function useHeadscaleClient() {
  return useStore(useSession().client);
}
