import { expect, test } from "vitest";
import { endpointOf } from "@/session/protocol";
import * as endpoints from "./requests";

test("rejects a name the registry does not export", () => {
  expect(endpointOf("missing")).toBeUndefined();
});

test("requests.ts exports only request endpoints, each with its own operation id", () => {
  const operations = Object.keys(endpoints).map((name) => {
    const operation = endpointOf(name);
    expect(operation?.endpoint, name).toBeTypeOf("function");
    return operation?.definition.operation;
  });
  expect(new Set(operations).size).toBe(operations.length);
});
