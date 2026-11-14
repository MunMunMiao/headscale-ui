import { createContext, useContext, useSyncExternalStore } from "react";
import type { Session } from "./session-context";

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("Application state requires AppProviders");
  return session;
}

type ObservableStore<State extends object> = {
  getSnapshot(this: void): State;
  subscribe(this: void, listener: () => void): () => void;
};

export function useStore<
  State extends object,
  Model extends ObservableStore<State>,
>(store: Model & { getSnapshot(this: void): State }): State & Model {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  return { ...state, ...store };
}
