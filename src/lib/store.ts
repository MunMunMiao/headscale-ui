export function createStore<State extends object>(initialState: State) {
  let state = initialState;
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => state,
    subscribe(this: void, listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setState(
      this: void,
      update: Partial<State> | ((current: State) => Partial<State>),
    ) {
      const patch = typeof update === "function" ? update(state) : update;
      if (
        Object.keys(patch).every((key) =>
          Object.is(Reflect.get(state, key), Reflect.get(patch, key)),
        )
      )
        return;
      state = { ...state, ...patch };
      for (const listener of listeners) listener();
    },
  };
}
