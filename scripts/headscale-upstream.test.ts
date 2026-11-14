import { expect, test } from "vitest";
import { routeKey, swaggerRoutes } from "../e2e/headscale-upstream";

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
