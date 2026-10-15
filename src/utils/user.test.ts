import { describe, expect, test } from "vitest";
import type { HeadscaleUser } from "@/api/contracts";
import { isEmailLike, userNameIssue } from "./user";

const users = [
  { id: "1", name: "alice" },
  { id: "0", name: "tagged-devices" },
] as HeadscaleUser[];

describe("userNameIssue", () => {
  test("requires a name", () => {
    expect(userNameIssue("", users)).toBe("required");
  });

  test.each(["Bad User!", "tab\there", "line\nbreak", "nul\u0000", "del\u007f"])(
    "rejects whitespace and control characters in %j",
    (name) => {
      expect(userNameIssue(name, users)).toBe("invalid");
    },
  );

  test("rejects a name another user already has, matching case-sensitively", () => {
    expect(userNameIssue("alice", users)).toBe("taken");
    expect(userNameIssue("tagged-devices", users)).toBe("taken");
    expect(userNameIssue("Alice", users)).toBeNull();
    expect(userNameIssue("alice", users, "1")).toBeNull();
  });

  test("accepts names Headscale and policies can use", () => {
    expect(userNameIssue("carol", users)).toBeNull();
    expect(userNameIssue("ops@corp", users)).toBeNull();
  });
});

describe("isEmailLike", () => {
  test.each(["a@b.c", "first.last+tag@example.co.uk"])("accepts %j", (value) => {
    expect(isEmailLike(value)).toBe(true);
  });

  test.each(["not-an-email", "a@b", "@b.c", "a@.c", "a b@c.d", "a@b.c "])("rejects %j", (value) => {
    expect(isEmailLike(value)).toBe(false);
  });
});
