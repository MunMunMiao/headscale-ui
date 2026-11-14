// Runs in Node: a browser page always has a document and cannot be made to lose it.
import { expect, test } from "vitest";
import { applyStoredTheme } from "./useTheme";

test("applying the stored theme does nothing without a document", () => {
  expect(typeof document).toBe("undefined");
  expect(() => applyStoredTheme()).not.toThrow();
});
