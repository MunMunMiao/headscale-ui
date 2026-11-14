/** Finds the first matching error without looping on a malformed cause chain. */
export function findErrorCause<T extends Error>(
  error: unknown,
  matches: (error: Error) => error is T,
): T | undefined {
  const seen = new Set<Error>();
  for (
    let cause = error;
    cause instanceof Error && !seen.has(cause);
    cause = cause.cause
  ) {
    if (matches(cause)) return cause;
    seen.add(cause);
  }
  return undefined;
}
