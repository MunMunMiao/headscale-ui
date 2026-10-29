import { describe, expect, test } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  test("joins conditional classes and resolves Tailwind conflicts", () => {
    expect(
      cn("px-2", ["text-sm", { block: true, hidden: false }], "px-4"),
    ).toBe("text-sm block px-4");
  });
});
