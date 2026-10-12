import { expect, test } from "vitest";
import { modifiesServer, OPERATION_IDS } from "@/domain/headscale-operations";
import { definitionOf } from "../../e2e/headscale-upstream";
import { REQUEST_REGISTRY } from "./requests";

// Consistency only: upstream completeness is checked in scripts/headscale-upstream.test.ts.
test("the request registry has one contract for each declared operation id", () => {
  expect(Object.keys(REQUEST_REGISTRY).sort()).toEqual([...OPERATION_IDS].sort());
  for (const id of OPERATION_IDS) expect(definitionOf(REQUEST_REGISTRY[id]).operation).toBe(id);
});

// Every non-GET operation is a write, except policy.check which only validates.
test("modifiesServer is false exactly for the read-only operations in the request registry", () => {
  for (const id of OPERATION_IDS)
    expect(!modifiesServer(id), id).toBe(
      definitionOf(REQUEST_REGISTRY[id]).method === "GET" || id === "policy.check",
    );
});
