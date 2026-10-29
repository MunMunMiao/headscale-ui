import { expect, test } from "vitest";
import { endpointOf } from "@/session/protocol";
import * as endpoints from "./requests";

test("requests.ts exports only request endpoints, each with its own operation id", () => {
  const operations = Object.keys(endpoints).map((name) => {
    const endpoint = endpointOf(name);
    expect(endpoint, name).toBeTypeOf("function");
    return endpoint?.().definition.operation;
  });
  expect(new Set(operations).size).toBe(operations.length);
});
