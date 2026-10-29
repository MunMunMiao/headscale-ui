/** Advancing this clock deliberately does not run any scheduled work. */
export function createManualClock(initial = 1_000_000) {
  let current = initial;
  return {
    now: () => current,
    set(value: number) {
      current = value;
    },
    advance(milliseconds: number) {
      current += milliseconds;
    },
  };
}
