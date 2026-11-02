import { expect, test } from "vitest";
import { assertProductCopy, getProductCopy } from "./product-copy";

test("accepts a translated copy", () => {
  expect(() => assertProductCopy(getProductCopy("en-US"))).not.toThrow();
});

test("rejects a value that is not an object", () => {
  expect(() => assertProductCopy(null)).toThrow(
    "Product copy must be an object",
  );
});

test("rejects a missing message", () => {
  const copy = getProductCopy("en-US");
  Reflect.deleteProperty(copy, "templatesSectionTitle");
  expect(() => assertProductCopy(copy)).toThrow(
    "Product copy templatesSectionTitle must be a string",
  );
});

test("rejects a nav group that is not an object", () => {
  const copy = getProductCopy("en-US");
  Reflect.set(copy, "nav", null);
  expect(() => assertProductCopy(copy)).toThrow(
    "Product copy nav must be an object",
  );
});

test("rejects a nav entry that is not a string", () => {
  const copy = getProductCopy("en-US");
  Reflect.set(copy.nav, "devices", 42);
  expect(() => assertProductCopy(copy)).toThrow(
    "Product copy nav.devices must be a string",
  );
});
