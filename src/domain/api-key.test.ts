import { expect, test } from "vitest";
import { listedApiKeyPrefix } from "./api-key";

test.each([
  ["hskey-api-ab-_cd1234ZZ-0123456789abcdef", "hskey-api-ab-_cd1234ZZ-***"],
  ["abcdefg.0123456789abcdef0123456789abcdef", "abcdefg***"],
])("derives the listed prefix of %s", (key, expected) => {
  expect(listedApiKeyPrefix(key)).toBe(expected);
});

test.each([
  "",
  "isolated-test-key",
  "hskey-api-short",
  "hskey-api-abcdefghijkl_0123",
  "abcdefgh.0123456789",
])("returns null for %j", (key) => {
  expect(listedApiKeyPrefix(key)).toBeNull();
});
