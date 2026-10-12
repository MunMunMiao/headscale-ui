import { afterEach, expect, test, vi } from "vitest";
import { getOrCreateTabOwnerId } from "./tab-owner";

afterEach(() => vi.unstubAllGlobals());

test("keeps the existing per-tab owner and persists a new owner only when absent", () => {
  const data = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
  });
  const owner = getOrCreateTabOwnerId();
  expect(owner).not.toBe("");
  expect(data.get("headscale-ui-tab-id")).toBe(owner);
  expect(getOrCreateTabOwnerId()).toBe(owner);
  data.set("headscale-ui-tab-id", "existing-owner");
  expect(getOrCreateTabOwnerId()).toBe("existing-owner");
});

test("has a stable in-memory fallback when sessionStorage is absent", () => {
  vi.stubGlobal("sessionStorage", undefined);
  const owner = getOrCreateTabOwnerId();
  expect(owner).not.toBe("");
  expect(getOrCreateTabOwnerId()).toBe(owner);
});
