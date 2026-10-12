export function createStore<State extends object>(initialState: State) {
  let state = initialState;
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setState(update: Partial<State> | ((current: State) => Partial<State>)) {
      const patch = typeof update === "function" ? update(state) : update;
      const keys = Object.keys(patch) as (keyof State)[];
      if (keys.every((key) => Object.is(state[key], patch[key]))) return;
      state = { ...state, ...patch };
      for (const listener of listeners) listener();
    },
  };
}
