import { type AnyStruct, defineRequest, struct } from "@defjs/core";
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
 * Defjs 0.5 executes an operation directly, so the HTTP metadata the Worker routes on stays on the
 * operation itself. `endpointOf` reads it without running a request.
 */
function define<
  const M extends string,
  const P extends string,
  TI extends AnyStruct | undefined = undefined,
  TO extends AnyStruct | undefined = undefined,
  TE extends AnyStruct | undefined = undefined,
>(definition: Parameters<typeof defineRequest<M, P, TI, TO, TE>>[0]) {
  return Object.assign(defineRequest(definition), { definition });
}

// A builder only places its input. Checks belong before a command is built (defjs struct.mdx).
export const health = define({
  operation: "health.check",
  method: "GET",
  path: "/api/v1/health",
  output: healthResponse,
  error: rpcStatus,
});

export const version = define({
  operation: "version.get",
  method: "GET",
  path: "/version",
  output: versionResponse,
  error: rpcStatus,
});

export const listUsers = define({
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

export const createUser = define({
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

export const renameUser = define({
  operation: "user.rename",
  method: "POST",
  path: "/api/v1/user/:id/rename/:newName",
  input: struct.object({ id: struct.string(), newName: struct.string() }),
  builder: (input) => ({ path: input }),
  output: userResponse,
  error: rpcStatus,
});

export const deleteUser = define({
  operation: "user.delete",
  method: "DELETE",
  path: "/api/v1/user/:id",
  input: struct.object({ id: struct.string() }),
  builder: (input) => ({ path: input }),
  error: rpcStatus,
});

export const listPreAuthKeys = define({
  operation: "preauthkey.list",
  method: "GET",
  path: "/api/v1/preauthkey",
  output: preAuthKeysResponse,
  error: rpcStatus,
});

export const createPreAuthKey = define({
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

export const expirePreAuthKey = define({
  operation: "preauthkey.expire",
  method: "POST",
  path: "/api/v1/preauthkey/expire",
  input: struct.object({ id: struct.string() }),
  builder: (input) => ({ body: input }),
  error: rpcStatus,
});

export const deletePreAuthKey = define({
  operation: "preauthkey.delete",
  method: "DELETE",
  path: "/api/v1/preauthkey",
  input: struct.object({ id: struct.string() }),
  builder: (input) => ({ query: input }),
  error: rpcStatus,
});

export const listNodes = define({
  operation: "node.list",
  method: "GET",
  path: "/api/v1/node",
  input: struct.object({ user: struct.string().optional() }),
  builder: (input) => ({ query: input }),
  output: nodesResponse,
  error: rpcStatus,
});

export const getNode = define({
  operation: "node.get",
  method: "GET",
  path: "/api/v1/node/:nodeId",
  input: struct.object({ nodeId: struct.string() }),
  builder: (input) => ({ path: input }),
  output: nodeResponse,
  error: rpcStatus,
});

export const registerNode = define({
  operation: "node.register",
  method: "POST",
  path: "/api/v1/node/register",
  input: struct.object({ user: struct.string(), key: struct.string() }),
  builder: (input) => ({ query: input }),
  output: nodeResponse,
  error: rpcStatus,
});

export const authRegister = define({
  operation: "auth.register",
  method: "POST",
  path: "/api/v1/auth/register",
  // user is the Headscale user name, not its numeric id.
  input: struct.object({ user: struct.string(), authId: struct.string() }),
  builder: (input) => ({ body: input }),
  output: nodeResponse,
  error: rpcStatus,
});

export const authApprove = define({
  operation: "auth.approve",
  method: "POST",
  path: "/api/v1/auth/approve",
  input: struct.object({ authId: struct.string() }),
  builder: (input) => ({ body: input }),
  error: rpcStatus,
});

export const authReject = define({
  operation: "auth.reject",
  method: "POST",
  path: "/api/v1/auth/reject",
  input: struct.object({ authId: struct.string() }),
  builder: (input) => ({ body: input }),
  error: rpcStatus,
});

export const debugCreateNode = define({
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

export const renameNode = define({
  operation: "node.rename",
  method: "POST",
  path: "/api/v1/node/:nodeId/rename/:newName",
  input: struct.object({ nodeId: struct.string(), newName: struct.string() }),
  builder: (input) => ({ path: input }),
  output: nodeResponse,
  error: rpcStatus,
});

export const expireNode = define({
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

export const deleteNode = define({
  operation: "node.delete",
  method: "DELETE",
  path: "/api/v1/node/:nodeId",
  input: struct.object({ nodeId: struct.string() }),
  builder: (input) => ({ path: input }),
  error: rpcStatus,
});

export const setTags = define({
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

export const setApprovedRoutes = define({
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

export const backfillNodeIps = define({
  operation: "node.backfillIps",
  method: "POST",
  path: "/api/v1/node/backfillips",
  input: struct.object({ confirmed: struct.boolean() }),
  builder: (input) => ({ query: input }),
  output: changesResponse,
  error: rpcStatus,
});

export const listApiKeys = define({
  operation: "apikey.list",
  method: "GET",
  path: "/api/v1/apikey",
  output: apiKeysResponse,
  error: rpcStatus,
});

export const createApiKey = define({
  operation: "apikey.create",
  method: "POST",
  path: "/api/v1/apikey",
  input: struct.object({ expiration: struct.string() }),
  builder: (input) => ({ body: input }),
  output: createApiKeyResponse,
  error: rpcStatus,
});

export const expireApiKey = define({
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

export const deleteApiKey = define({
  operation: "apikey.delete",
  method: "DELETE",
  path: "/api/v1/apikey/:prefix",
  input: struct.object({ prefix: struct.string() }),
  builder: (input) => ({ path: input }),
  error: rpcStatus,
});

export const getPolicy = define({
  operation: "policy.get",
  method: "GET",
  path: "/api/v1/policy",
  output: policyResponse,
  error: rpcStatus,
});

export const setPolicy = define({
  operation: "policy.set",
  method: "PUT",
  path: "/api/v1/policy",
  input: struct.object({ policy: struct.string() }),
  builder: (input) => ({ body: input }),
  output: policyResponse,
  error: rpcStatus,
});

export const checkPolicy = define({
  operation: "policy.check",
  method: "POST",
  path: "/api/v1/policy/check",
  input: struct.object({ policy: struct.string() }),
  builder: (input) => ({ body: input }),
  error: rpcStatus,
});
