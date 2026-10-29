import { describe, expect, test } from "vitest";
import { isNodeTag, isValidNodeName, parseNodeTags } from "./node";

describe("parseNodeTags", () => {
  test("splits on commas, spaces and newlines and drops empty entries", () => {
    expect(parseNodeTags(" tag:web  tag:db,tag:x\n tag:y ,, ")).toEqual([
      "tag:web",
      "tag:db",
      "tag:x",
      "tag:y",
    ]);
    expect(parseNodeTags("   ")).toEqual([]);
  });
});

describe("isNodeTag", () => {
  test("requires the tag: prefix and a name", () => {
    expect(isNodeTag("tag:server")).toBe(true);
    expect(isNodeTag("tag:")).toBe(false);
    expect(isNodeTag("server")).toBe(false);
    expect(isNodeTag("Tag:server")).toBe(false);
  });
});

test("tag writes reject uppercase names and embedded separators without silently lowercasing", () => {
  for (const tag of [
    "tag:Server",
    "tag:PROD",
    "tag:web db",
    "tag:web,tag:db",
    "tag:web\n",
  ]) {
    expect(isNodeTag(tag), tag).toBe(false);
  }
  expect(isNodeTag("tag:server-1")).toBe(true);
});

describe("isValidNodeName", () => {
  test("accepts a DNS label of 1 to 63 letters, digits and inner hyphens", () => {
    for (const name of ["a", "7", "New-Host-1", "a".repeat(63)])
      expect(isValidNodeName(name)).toBe(true);
    for (const name of [
      "",
      "-a",
      "a-",
      "a b",
      "Bad!",
      "ä",
      "a.b",
      "a".repeat(64),
    ])
      expect(isValidNodeName(name)).toBe(false);
  });
});
