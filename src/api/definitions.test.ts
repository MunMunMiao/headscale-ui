import { expect, test } from "vitest";
import { definitionOf, registerDefinition } from "./definitions";

test("reads a registered definition without running it", () => {
  registerDefinition("definitions.test", {
    operation: "definitions.test",
    method: "GET",
    path: "/test",
  });

  expect(definitionOf("definitions.test")).toEqual({
    operation: "definitions.test",
    method: "GET",
    path: "/test",
  });
});

test("rejects a name that was never registered", () => {
  expect(() => definitionOf("definitions.missing")).toThrow(
    'No defjs definition registered for "definitions.missing"',
  );
});
