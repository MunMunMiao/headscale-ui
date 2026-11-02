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
