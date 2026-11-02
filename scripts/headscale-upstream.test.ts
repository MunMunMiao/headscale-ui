import { expect, test } from "vitest";
import {
  diffRoutes,
  HEADSCALE_UPSTREAM_VERSION,
  NON_RPC_OPERATIONS,
  routeKey,
  swaggerRoutes,
  UPSTREAM_RPCS,
} from "../e2e/headscale-upstream";
import { definitionOf as appDefinitionOf } from "../src/api/definitions";
import * as endpoints from "../src/api/requests";

test("every pinned upstream RPC has exactly one operation and no operation lacks an upstream route", () => {
  expect(diffRoutes(UPSTREAM_RPCS, endpoints)).toEqual([]);
  expect(Object.keys(endpoints)).toHaveLength(
    UPSTREAM_RPCS.length + NON_RPC_OPERATIONS.length,
  );
});

test("pinned upstream routes are unique and the E2E fixture runs the pinned Headscale version", async () => {
  const keys = UPSTREAM_RPCS.map(({ method, path }) => routeKey(method, path));
  expect(new Set(keys).size).toBe(keys.length);
  expect(UPSTREAM_RPCS.map(({ rpc }) => rpc)).toHaveLength(
    new Set(UPSTREAM_RPCS.map(({ rpc }) => rpc)).size,
  );
  expect(
    await Bun.file(
      new URL("../e2e/docker-compose.yml", import.meta.url),
    ).text(),
  ).toContain(`headscale/headscale:${HEADSCALE_UPSTREAM_VERSION}`);
});

test("reports an upstream route whose operation was removed", () => {
  const { authApprove: _removed, ...registry } = endpoints;
  expect(diffRoutes(UPSTREAM_RPCS, registry)).toEqual([
    "Missing operation for upstream route: POST /api/v1/auth/approve",
  ]);
});

test("reports an operation pointed at a path upstream does not serve", () => {
  const resolve = (name: string) =>
    name === "checkPolicy"
      ? {
          operation: "policy.check",
          method: "POST",
          path: "/api/v1/policy/validate",
        }
      : appDefinitionOf(name);
  expect(
    diffRoutes(UPSTREAM_RPCS, endpoints, NON_RPC_OPERATIONS, resolve).sort(),
  ).toEqual([
    "Missing operation for upstream route: POST /api/v1/policy/check",
    "Operation without upstream route: policy.check",
  ]);
});

test("reports fabricated and duplicate upstream routes", () => {
  expect(
    diffRoutes(
      [
        ...UPSTREAM_RPCS,
        { method: "POST", path: "/api/v1/fabricated" },
        UPSTREAM_RPCS[0],
      ],
      endpoints,
    ),
  ).toEqual([
    `Duplicate upstream route: ${routeKey(UPSTREAM_RPCS[0].method, UPSTREAM_RPCS[0].path)}`,
    "Missing operation for upstream route: POST /api/v1/fabricated",
  ]);
});

test("normalizes swagger and registry path parameters to the same key", () => {
  const document = {
    paths: {
      "/api/v1/node/{nodeId}": { get: {}, delete: {}, parameters: [] },
      "/api/v1/node/:nodeId/tags": { post: {} },
    },
  };
  expect(
    swaggerRoutes(document).map(({ method, path }) => routeKey(method, path)),
  ).toEqual([
    "GET /api/v1/node/{}",
    "DELETE /api/v1/node/{}",
    "POST /api/v1/node/{}/tags",
  ]);
});

test.each([
  null,
  [],
  {},
  { paths: null },
  { paths: [] },
  { paths: { "/x": 1 } },
])("rejects a malformed swagger document: %j", (document) => {
  expect(() => swaggerRoutes(document)).toThrow(/Malformed swagger document/);
});

test("rejects two operations that share one route", () => {
  const resolve = (name: string) =>
    name === "checkPolicy"
      ? appDefinitionOf("getPolicy")
      : appDefinitionOf(name);
  expect(() => diffRoutes([], endpoints, NON_RPC_OPERATIONS, resolve)).toThrow(
    "share the route GET /api/v1/policy",
  );
});

test("rejects a registry entry without a usable definition", () => {
  expect(() =>
    diffRoutes(
      [],
      { "version.get": true },
      NON_RPC_OPERATIONS,
      () => undefined,
    ),
  ).toThrow("no HTTP definition");
  expect(() =>
    diffRoutes([], { "version.get": true }, NON_RPC_OPERATIONS, () => null),
  ).toThrow("no HTTP definition");
  expect(() =>
    diffRoutes([], { "version.get": true }, NON_RPC_OPERATIONS, () => ({
      method: "GET",
    })),
  ).toThrow("no HTTP definition");
});
