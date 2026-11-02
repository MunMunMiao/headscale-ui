import { type AnyStruct, defineRequest, struct } from "@defjs/core";
import { registerDefinition } from "./definitions";
import {
  apiKeysResponse,
  changesResponse,
  createApiKeyResponse,
  healthResponse,
  nodeResponse,
  nodesResponse,
  policyResponse,
  preAuthKeyResponse,
  preAuthKeysResponse,
  rpcStatus,
  userResponse,
  usersResponse,
  versionResponse,
} from "./contracts";

/**
 * Defjs 0.6 exposes no metadata on the callable operation, so the application registers each
 * definition as data. `definitionOf` reads it without running a request.
 */
function define<
  const M extends string,
  const P extends string,
  TI extends AnyStruct | undefined = undefined,
  TO extends AnyStruct | undefined = undefined,
  TE extends AnyStruct | undefined = undefined,
>(
  name: string,
  definition: Parameters<typeof defineRequest<M, P, TI, TO, TE>>[0] & {
    operation: string;
  },
) {
  const endpoint = defineRequest(definition);
  registerDefinition(name, definition);
  return endpoint;
}

// A builder only places its input. Checks belong before a command is built (defjs struct.mdx).
export const health = define("health", {
  operation: "health.check",
  method: "GET",
  path: "/api/v1/health",
  output: healthResponse,
  error: rpcStatus,
});

export const version = define("version", {
  operation: "version.get",
  method: "GET",
  path: "/version",
  output: versionResponse,
  error: rpcStatus,
});

export const listUsers = define("listUsers", {
  operation: "user.list",
  method: "GET",
  path: "/api/v1/user",
  input: struct.object({
    id: struct.string().optional(),
    name: struct.string().optional(),
    email: struct.string().optional(),
  }),
  builder: (input) => ({ query: input }),
  output: usersResponse,
  error: rpcStatus,
});

export const createUser = define("createUser", {
  operation: "user.create",
  method: "POST",
  path: "/api/v1/user",
  input: struct.object({
    name: struct.string(),
    displayName: struct.string().optional(),
    email: struct.string().optional(),
    pictureUrl: struct.string().optional(),
  }),
  builder: (input) => ({ body: input }),
  output: userResponse,
  error: rpcStatus,
});

export const renameUser = define("renameUser", {
  operation: "user.rename",
  method: "POST",
  path: "/api/v1/user/:id/rename/:newName",
  input: struct.object({ id: struct.string(), newName: struct.string() }),
  builder: (input) => ({ path: input }),
  output: userResponse,
  error: rpcStatus,
});

export const deleteUser = define("deleteUser", {
  operation: "user.delete",
  method: "DELETE",
  path: "/api/v1/user/:id",
  input: struct.object({ id: struct.string() }),
  builder: (input) => ({ path: input }),
  error: rpcStatus,
});

export const listPreAuthKeys = define("listPreAuthKeys", {
  operation: "preauthkey.list",
  method: "GET",
  path: "/api/v1/preauthkey",
  output: preAuthKeysResponse,
  error: rpcStatus,
});

export const createPreAuthKey = define("createPreAuthKey", {
  operation: "preauthkey.create",
  method: "POST",
  path: "/api/v1/preauthkey",
  input: struct.object({
    user: struct.string().optional(),
    reusable: struct.boolean().optional(),
    ephemeral: struct.boolean().optional(),
    expiration: struct.string(),
    aclTags: struct.array(struct.string()).optional(),
  }),
  builder: (input) => ({ body: input }),
  output: preAuthKeyResponse,
  error: rpcStatus,
});

export const expirePreAuthKey = define("expirePreAuthKey", {
  operation: "preauthkey.expire",
  method: "POST",
  path: "/api/v1/preauthkey/expire",
  input: struct.object({ id: struct.string() }),
  builder: (input) => ({ body: input }),
  error: rpcStatus,
});

export const deletePreAuthKey = define("deletePreAuthKey", {
  operation: "preauthkey.delete",
  method: "DELETE",
  path: "/api/v1/preauthkey",
  input: struct.object({ id: struct.string() }),
  builder: (input) => ({ query: input }),
  error: rpcStatus,
});

export const listNodes = define("listNodes", {
  operation: "node.list",
  method: "GET",
  path: "/api/v1/node",
  input: struct.object({ user: struct.string().optional() }),
  builder: (input) => ({ query: input }),
  output: nodesResponse,
  error: rpcStatus,
});

export const getNode = define("getNode", {
  operation: "node.get",
  method: "GET",
  path: "/api/v1/node/:nodeId",
  input: struct.object({ nodeId: struct.string() }),
  builder: (input) => ({ path: input }),
  output: nodeResponse,
  error: rpcStatus,
});

export const registerNode = define("registerNode", {
  operation: "node.register",
  method: "POST",
  path: "/api/v1/node/register",
  input: struct.object({ user: struct.string(), key: struct.string() }),
  builder: (input) => ({ query: input }),
  output: nodeResponse,
  error: rpcStatus,
});

export const authRegister = define("authRegister", {
  operation: "auth.register",
  method: "POST",
  path: "/api/v1/auth/register",
  // user is the Headscale user name, not its numeric id.
  input: struct.object({ user: struct.string(), authId: struct.string() }),
  builder: (input) => ({ body: input }),
  output: nodeResponse,
  error: rpcStatus,
});

export const authApprove = define("authApprove", {
  operation: "auth.approve",
  method: "POST",
  path: "/api/v1/auth/approve",
  input: struct.object({ authId: struct.string() }),
  builder: (input) => ({ body: input }),
  error: rpcStatus,
});

export const authReject = define("authReject", {
  operation: "auth.reject",
  method: "POST",
  path: "/api/v1/auth/reject",
  input: struct.object({ authId: struct.string() }),
  builder: (input) => ({ body: input }),
  error: rpcStatus,
});

export const debugCreateNode = define("debugCreateNode", {
  operation: "node.debugCreate",
  method: "POST",
  path: "/api/v1/debug/node",
  input: struct.object({
    user: struct.string(),
    key: struct.string(),
    name: struct.string(),
    routes: struct.array(struct.string()).optional(),
  }),
  builder: (input) => ({ body: input }),
  output: nodeResponse,
  error: rpcStatus,
});

export const renameNode = define("renameNode", {
  operation: "node.rename",
  method: "POST",
  path: "/api/v1/node/:nodeId/rename/:newName",
  input: struct.object({ nodeId: struct.string(), newName: struct.string() }),
  builder: (input) => ({ path: input }),
  output: nodeResponse,
  error: rpcStatus,
});

export const expireNode = define("expireNode", {
  operation: "node.expire",
  method: "POST",
  path: "/api/v1/node/:nodeId/expire",
  input: struct.object({
    nodeId: struct.string(),
    expiry: struct.string().optional(),
    disableExpiry: struct.boolean().optional(),
  }),
  builder: (input) => ({
    path: { nodeId: input.nodeId },
    query: { expiry: input.expiry, disableExpiry: input.disableExpiry },
  }),
  output: nodeResponse,
  error: rpcStatus,
});

export const deleteNode = define("deleteNode", {
  operation: "node.delete",
  method: "DELETE",
  path: "/api/v1/node/:nodeId",
  input: struct.object({ nodeId: struct.string() }),
  builder: (input) => ({ path: input }),
  error: rpcStatus,
});

export const setTags = define("setTags", {
  operation: "node.setTags",
  method: "POST",
  path: "/api/v1/node/:nodeId/tags",
  input: struct.object({
    nodeId: struct.string(),
    tags: struct.array(struct.string()),
  }),
  builder: (input) => ({
    path: { nodeId: input.nodeId },
    body: { tags: input.tags },
  }),
  output: nodeResponse,
  error: rpcStatus,
});

export const setApprovedRoutes = define("setApprovedRoutes", {
  operation: "node.setApprovedRoutes",
  method: "POST",
  path: "/api/v1/node/:nodeId/approve_routes",
  input: struct.object({
    nodeId: struct.string(),
    routes: struct.array(struct.string()),
  }),
  builder: (input) => ({
    path: { nodeId: input.nodeId },
    body: { routes: input.routes },
  }),
  output: nodeResponse,
  error: rpcStatus,
});

export const backfillNodeIps = define("backfillNodeIps", {
  operation: "node.backfillIps",
  method: "POST",
  path: "/api/v1/node/backfillips",
  input: struct.object({ confirmed: struct.boolean() }),
  builder: (input) => ({ query: input }),
  output: changesResponse,
  error: rpcStatus,
});

export const listApiKeys = define("listApiKeys", {
  operation: "apikey.list",
  method: "GET",
  path: "/api/v1/apikey",
  output: apiKeysResponse,
  error: rpcStatus,
});

export const createApiKey = define("createApiKey", {
  operation: "apikey.create",
  method: "POST",
  path: "/api/v1/apikey",
  input: struct.object({ expiration: struct.string() }),
  builder: (input) => ({ body: input }),
  output: createApiKeyResponse,
  error: rpcStatus,
});

export const expireApiKey = define("expireApiKey", {
  operation: "apikey.expire",
  method: "POST",
  path: "/api/v1/apikey/expire",
  input: struct.or(
    struct.object({ prefix: struct.string(), id: struct.string().optional() }),
    struct.object({ id: struct.string(), prefix: struct.string().optional() }),
  ),
  builder: (input) => ({ body: input }),
  error: rpcStatus,
});

export const deleteApiKey = define("deleteApiKey", {
  operation: "apikey.delete",
  method: "DELETE",
  path: "/api/v1/apikey/:prefix",
  input: struct.object({ prefix: struct.string() }),
  builder: (input) => ({ path: input }),
  error: rpcStatus,
});

export const getPolicy = define("getPolicy", {
  operation: "policy.get",
  method: "GET",
  path: "/api/v1/policy",
  output: policyResponse,
  error: rpcStatus,
});

export const setPolicy = define("setPolicy", {
  operation: "policy.set",
  method: "PUT",
  path: "/api/v1/policy",
  input: struct.object({ policy: struct.string() }),
  builder: (input) => ({ body: input }),
  output: policyResponse,
  error: rpcStatus,
});

export const checkPolicy = define("checkPolicy", {
  operation: "policy.check",
  method: "POST",
  path: "/api/v1/policy/check",
  input: struct.object({ policy: struct.string() }),
  builder: (input) => ({ body: input }),
  error: rpcStatus,
});
