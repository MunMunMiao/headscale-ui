import { expect, test } from "vitest";
import {
  HEADSCALE_UPSTREAM_VERSION,
  NON_RPC_OPERATIONS,
  routeKey,
  swaggerRoutes,
  UPSTREAM_RPCS,
} from "../e2e/headscale-upstream";
import * as endpoints from "../src/api/requests";

test("the request module covers every pinned upstream RPC plus the non-RPC routes", () => {
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

test("normalizes swagger path parameters to the route key", () => {
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
