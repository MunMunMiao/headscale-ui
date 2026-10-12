import { createStore } from "@/lib/store";

export function createSessionDrafts() {
  const state = createStore<{
    stale: { profileId: string; name: string } | null;
    viewEpoch: number;
  }>({ stale: null, viewEpoch: 0 });
  const editors = new Set<object>();
  return {
    getSnapshot: state.getSnapshot,
    subscribe: state.subscribe,
    isCurrent: () => state.getSnapshot().stale === null,
    setActive(owner: object, active: boolean) {
      if (active) editors.add(owner);
      else editors.delete(owner);
    },
    release(owner: object) {
      editors.delete(owner);
    },
    hold(profile: { id: string; name: string }, force = false) {
      if (state.getSnapshot().stale) return true;
      if (!force && editors.size === 0) return false;
      state.setState({ stale: { profileId: profile.id, name: profile.name } });
      return true;
    },
    discard() {
      editors.clear();
      state.setState({ stale: null, viewEpoch: state.getSnapshot().viewEpoch + 1 });
    },
  };
}
