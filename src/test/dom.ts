/** Narrows an unknown DOM or event value without a type assertion. */
export function requireInstance<T>(
  value: unknown,
  constructor: abstract new (...args: never[]) => T,
): T {
  if (!(value instanceof constructor))
    throw new Error(`Expected ${constructor.name}`);
  return value;
}

/** Removes null and undefined from a value the test has already located. */
export function requireValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("Expected a value");
  return value;
}

/**
 * A stand-in that implements only the surface a test exercises. No typed path exists from a
 * partial fixture to the interface it replaces, so this is the one documented erasure point.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller supplies the decoded type
export function testDouble<T>(value: unknown): T {
  // oxlint-disable-next-line typescript/no-explicit-any -- fixture boundary, value is returned as-is
  const erased: any = value;
  return erased;
}

/** Reads one field from an unknown message or fixture value. */
export function fieldOf(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? Reflect.get(value, key)
    : undefined;
}

/** Requires an unknown value to be a non-null object. */
export function requireObject(value: unknown): object {
  if (value === null || typeof value !== "object")
    throw new Error("Expected an object");
  return value;
}
