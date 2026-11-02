import { expect, test } from "vitest";
import {
  fieldOf,
  requireInstance,
  requireObject,
  requireValue,
  testDouble,
} from "./dom";

test("returns a value of the requested class", () => {
  const target = new EventTarget();
  expect(requireInstance(target, EventTarget)).toBe(target);
});

test("rejects a value of another class", () => {
  expect(() => requireInstance({}, EventTarget)).toThrow(
    "Expected EventTarget",
  );
});

test("requires a located value to exist", () => {
  const value = { id: "1" };
  expect(requireValue(value)).toBe(value);
  expect(() => requireValue(null)).toThrow("Expected a value");
  expect(() => requireValue(undefined)).toThrow("Expected a value");
});

test("returns a partial test double as the requested type", () => {
  const value = { listen: () => {} };
  expect(testDouble<typeof value>(value)).toBe(value);
});

test("reads a field from an unknown object", () => {
  expect(fieldOf({ type: "reply" }, "type")).toBe("reply");
  expect(fieldOf(null, "type")).toBeUndefined();
  expect(fieldOf("text", "type")).toBeUndefined();
});

test("requires an unknown value to be an object", () => {
  const value = {};
  expect(requireObject(value)).toBe(value);
  expect(() => requireObject(null)).toThrow("Expected an object");
  expect(() => requireObject("text")).toThrow("Expected an object");
});
