import { expect, test } from "vitest";
import { createSegmentStore } from "./useSnapshotSegment";

test("tracks overlapping segment refreshes through success and failure", async () => {
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const calls: string[][] = [];
  const segment = createSegmentStore((segments) => {
    calls.push([...segments]);
    return calls.length === 1 ? first.promise : second.promise;
  });
  const a = segment.refresh(["identity", "policy"]);
  const b = segment.refresh(["identity", "policy"]);
  expect(segment.getSnapshot().inFlight).toBe(2);
  first.resolve();
  await a;
  expect(segment.getSnapshot().inFlight).toBe(1);
  second.reject(new Error("failed refresh"));
  await expect(b).rejects.toThrow("failed refresh");
  expect(segment.getSnapshot().inFlight).toBe(0);
  expect(calls).toEqual([
    ["identity", "policy"],
    ["identity", "policy"],
  ]);
});
