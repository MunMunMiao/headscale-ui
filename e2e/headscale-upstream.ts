// Route table reviewed against the Headscale v0.29.4 gRPC gateway.
// The runtime image and /version check use this patch.
export const HEADSCALE_UPSTREAM_VERSION = "0.29.6";

// Routes the UI needs that are not gateway RPCs.
export const NON_RPC_OPERATIONS: readonly string[] = ["version.get"];

export interface UpstreamRpc {
  rpc: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
}

export const UPSTREAM_RPCS: readonly UpstreamRpc[] = [
  { rpc: "CreateUser", method: "POST", path: "/api/v1/user" },
  {
    rpc: "RenameUser",
    method: "POST",
    path: "/api/v1/user/{oldId}/rename/{newName}",
  },
  { rpc: "DeleteUser", method: "DELETE", path: "/api/v1/user/{id}" },
  { rpc: "ListUsers", method: "GET", path: "/api/v1/user" },
  { rpc: "CreatePreAuthKey", method: "POST", path: "/api/v1/preauthkey" },
  {
    rpc: "ExpirePreAuthKey",
    method: "POST",
    path: "/api/v1/preauthkey/expire",
  },
  { rpc: "DeletePreAuthKey", method: "DELETE", path: "/api/v1/preauthkey" },
  { rpc: "ListPreAuthKeys", method: "GET", path: "/api/v1/preauthkey" },
  { rpc: "DebugCreateNode", method: "POST", path: "/api/v1/debug/node" },
  { rpc: "GetNode", method: "GET", path: "/api/v1/node/{nodeId}" },
  { rpc: "SetTags", method: "POST", path: "/api/v1/node/{nodeId}/tags" },
  {
    rpc: "SetApprovedRoutes",
    method: "POST",
    path: "/api/v1/node/{nodeId}/approve_routes",
  },
  { rpc: "RegisterNode", method: "POST", path: "/api/v1/node/register" },
  { rpc: "DeleteNode", method: "DELETE", path: "/api/v1/node/{nodeId}" },
  { rpc: "ExpireNode", method: "POST", path: "/api/v1/node/{nodeId}/expire" },
  {
    rpc: "RenameNode",
    method: "POST",
    path: "/api/v1/node/{nodeId}/rename/{newName}",
  },
  { rpc: "ListNodes", method: "GET", path: "/api/v1/node" },
  { rpc: "BackfillNodeIPs", method: "POST", path: "/api/v1/node/backfillips" },
  { rpc: "AuthRegister", method: "POST", path: "/api/v1/auth/register" },
  { rpc: "AuthApprove", method: "POST", path: "/api/v1/auth/approve" },
  { rpc: "AuthReject", method: "POST", path: "/api/v1/auth/reject" },
  { rpc: "CreateApiKey", method: "POST", path: "/api/v1/apikey" },
  { rpc: "ExpireApiKey", method: "POST", path: "/api/v1/apikey/expire" },
  { rpc: "ListApiKeys", method: "GET", path: "/api/v1/apikey" },
  { rpc: "DeleteApiKey", method: "DELETE", path: "/api/v1/apikey/{prefix}" },
  { rpc: "GetPolicy", method: "GET", path: "/api/v1/policy" },
  { rpc: "SetPolicy", method: "PUT", path: "/api/v1/policy" },
  { rpc: "CheckPolicy", method: "POST", path: "/api/v1/policy/check" },
  { rpc: "Health", method: "GET", path: "/api/v1/health" },
];

export interface RouteRef {
  method: string;
  path: string;
}

export const routeKey = (method: string, path: string) =>
  `${method.toUpperCase()} ${path.replace(/\{[^}]+\}|:[A-Za-z]+/g, "{}")}`;

export function definitionOf(
  request: unknown,
): RouteRef & { operation: string } {
  if (typeof request !== "function")
    throw new Error("Request registry entry is not a function");
  const definition: unknown = request({}).definition;
  if (
    definition === null ||
    typeof definition !== "object" ||
    !("method" in definition) ||
    !("path" in definition) ||
    !("operation" in definition) ||
    typeof definition.method !== "string" ||
    typeof definition.path !== "string" ||
    typeof definition.operation !== "string"
  )
    throw new Error("Request registry entry has no HTTP definition");
  return {
    method: definition.method,
    path: definition.path,
    operation: definition.operation,
  };
}

/** Route of every request in a module of endpoints, keyed by its defjs operation id. */
export function registryRoutes(registry: Readonly<Record<string, unknown>>) {
  const routes = new Map<string, string>();
  for (const request of Object.values(registry)) {
    const { method, path, operation: id } = definitionOf(request);
    const key = routeKey(method, path);
    const other = routes.get(key);
    if (other)
      throw new Error(`Operations ${other} and ${id} share the route ${key}`);
    routes.set(key, id);
  }
  return routes;
}

/** Human-readable differences between the expected upstream routes and the request registry. */
export function diffRoutes(
  expected: readonly RouteRef[],
  registry: Readonly<Record<string, unknown>>,
  nonRpc: readonly string[] = NON_RPC_OPERATIONS,
): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const { method, path } of expected) {
    const key = routeKey(method, path);
    if (seen.has(key)) lines.push(`Duplicate upstream route: ${key}`);
    seen.add(key);
  }
  const actual = registryRoutes(registry);
  for (const key of seen)
    if (!actual.has(key))
      lines.push(`Missing operation for upstream route: ${key}`);
  for (const [key, id] of actual)
    if (!seen.has(key) && !nonRpc.includes(id))
      lines.push(`Operation without upstream route: ${id}`);
  return lines;
}

/** Route list of a swagger/OpenAPI document, shaped like UPSTREAM_RPCS. */
export function swaggerRoutes(document: unknown): RouteRef[] {
  if (
    document === null ||
    typeof document !== "object" ||
    !("paths" in document)
  )
    throw new Error("Malformed swagger document: paths is missing");
  const { paths } = document;
  if (paths === null || typeof paths !== "object" || Array.isArray(paths))
    throw new Error("Malformed swagger document: paths is not an object");
  const routes: RouteRef[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (item === null || typeof item !== "object")
      throw new Error(`Malformed swagger document: ${path} is not an object`);
    for (const method of ["get", "post", "put", "delete", "patch"])
      if (method in item) routes.push({ method: method.toUpperCase(), path });
  }
  return routes;
}
