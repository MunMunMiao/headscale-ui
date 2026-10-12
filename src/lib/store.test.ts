import { expect, test, vi } from "vitest";
import { createStore } from "./store";

test("subscribers see a new snapshot only for an actual update and can unsubscribe", () => {
  const store = createStore({ count: 0, pending: false });
  const notify = vi.fn();
  const unsubscribe = store.subscribe(notify);
  const initial = store.getSnapshot();

  store.setState({ count: 0 });
  expect(store.getSnapshot()).toBe(initial);
  expect(notify).not.toHaveBeenCalled();

  store.setState({ count: 1 });
  expect(store.getSnapshot()).toEqual({ count: 1, pending: false });
  expect(initial.count).toBe(0);
  expect(notify).toHaveBeenCalledTimes(1);

  store.setState((current) => ({ count: current.count + 1, pending: true }));
  expect(store.getSnapshot()).toEqual({ count: 2, pending: true });
  expect(notify).toHaveBeenCalledTimes(2);
  unsubscribe();
  store.setState({ count: 3 });
  expect(notify).toHaveBeenCalledTimes(2);
});
