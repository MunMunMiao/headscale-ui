import { expect, test } from "vitest";
import {
  isolateVersion,
  serverVersionSupport,
  UnsupportedServerVersionError,
} from "./server-version";

test.each([
  ["0.29.0", "supported"],
  ["v0.29.4", "supported"],
  ["0.29.0-beta.1", "supported"],
  [" 0.29.4+build ", "supported"],
  ["0.29", "supported"],
  ["v0.28.5", "unsupported"],
  ["0.30.0", "unsupported"],
  ["1.0.0", "unsupported"],
  ["0.290.1", "unsupported"],
  ["dev", "unknown"],
  ["(devel)", "unknown"],
  ["", "unknown"],
  ["0.29x", "unknown"],
] as const)("classifies %j as %s", (version, support) => {
  expect(serverVersionSupport(version)).toBe(support);
});

test("isolateVersion bounds untrusted text and wraps it in bidi isolates", () => {
  expect(isolateVersion(" 0.28.0 ")).toBe("\u20680.28.0\u2069");
  expect(isolateVersion("x".repeat(80))).toBe(`\u2068${"x".repeat(40)}\u2069`);
});

test("UnsupportedServerVersionError carries the version and cause", () => {
  const cause = new Error("decode");
  const error = new UnsupportedServerVersionError("0.28.0", { cause });
  expect(error).toBeInstanceOf(Error);
  expect(error.serverVersion).toBe("0.28.0");
  expect(error.cause).toBe(cause);
});
