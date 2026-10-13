import { defineRequest, struct } from "@defjs/core";
import type { OperationId } from "@/domain/headscale-operations";
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

// A builder only places its input. Checks belong before a command is built (defjs struct.mdx).
export const health = defineRequest({
  operation: "health.check",
  method: "GET",
  path: "/api/v1/health",
  output: healthResponse,
  error: rpcStatus,
});

export const version = defineRequest({
  operation: "version.get",
  method: "GET",
  path: "/version",
  output: versionResponse,
  error: rpcStatus,
});

export const listUsers = defineRequest({
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

export const createUser = defineRequest({
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

export const renameUser = defineRequest({
  operation: "user.rename",
  method: "POST",
  path: "/api/v1/user/:id/rename/:newName",
  input: struct.object({ id: struct.string(), newName: struct.string() }),
  builder: (input) => ({ path: input }),
  output: userResponse,
  error: rpcStatus,
});

export const deleteUser = defineRequest({
  operation: "user.delete",
  method: "DELETE",
  path: "/api/v1/user/:id",
  input: struct.object({ id: struct.string() }),
  builder: (input) => ({ path: input }),
  error: rpcStatus,
});

export const listPreAuthKeys = defineRequest({
  operation: "preauthkey.list",
  method: "GET",
  path: "/api/v1/preauthkey",
  output: preAuthKeysResponse,
  error: rpcStatus,
});

export const createPreAuthKey = defineRequest({
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

export const expirePreAuthKey = defineRequest({
  operation: "preauthkey.expire",
  method: "POST",
  path: "/api/v1/preauthkey/expire",
  input: struct.object({ id: struct.string() }),
  builder: (input) => ({ body: input }),
  error: rpcStatus,
});

export const deletePreAuthKey = defineRequest({
  operation: "preauthkey.delete",
  method: "DELETE",
  path: "/api/v1/preauthkey",
  input: struct.object({ id: struct.string() }),
  builder: (input) => ({ query: input }),
  error: rpcStatus,
});

export const listNodes = defineRequest({
  operation: "node.list",
  method: "GET",
  path: "/api/v1/node",
  input: struct.object({ user: struct.string().optional() }),
  builder: (input) => ({ query: input }),
  output: nodesResponse,
  error: rpcStatus,
});

export const getNode = defineRequest({
  operation: "node.get",
  method: "GET",
  path: "/api/v1/node/:nodeId",
  input: struct.object({ nodeId: struct.string() }),
  builder: (input) => ({ path: input }),
  output: nodeResponse,
  error: rpcStatus,
});

export const registerNode = defineRequest({
  operation: "node.register",
  method: "POST",
  path: "/api/v1/node/register",
  input: struct.object({ user: struct.string(), key: struct.string() }),
  builder: (input) => ({ query: input }),
  output: nodeResponse,
  error: rpcStatus,
});

export const authRegister = defineRequest({
  operation: "auth.register",
  method: "POST",
  path: "/api/v1/auth/register",
  // user is the Headscale user name, not its numeric id.
  input: struct.object({ user: struct.string(), authId: struct.string() }),
  builder: (input) => ({ body: input }),
  output: nodeResponse,
  error: rpcStatus,
});

export const authApprove = defineRequest({
  operation: "auth.approve",
  method: "POST",
  path: "/api/v1/auth/approve",
  input: struct.object({ authId: struct.string() }),
  builder: (input) => ({ body: input }),
  error: rpcStatus,
});

export const authReject = defineRequest({
  operation: "auth.reject",
  method: "POST",
  path: "/api/v1/auth/reject",
  input: struct.object({ authId: struct.string() }),
  builder: (input) => ({ body: input }),
  error: rpcStatus,
});

export const debugCreateNode = defineRequest({
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

export const renameNode = defineRequest({
  operation: "node.rename",
  method: "POST",
  path: "/api/v1/node/:nodeId/rename/:newName",
  input: struct.object({ nodeId: struct.string(), newName: struct.string() }),
  builder: (input) => ({ path: input }),
  output: nodeResponse,
  error: rpcStatus,
});

export const expireNode = defineRequest({
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

export const deleteNode = defineRequest({
  operation: "node.delete",
  method: "DELETE",
  path: "/api/v1/node/:nodeId",
  input: struct.object({ nodeId: struct.string() }),
  builder: (input) => ({ path: input }),
  error: rpcStatus,
});

export const setTags = defineRequest({
  operation: "node.setTags",
  method: "POST",
  path: "/api/v1/node/:nodeId/tags",
  input: struct.object({ nodeId: struct.string(), tags: struct.array(struct.string()) }),
  builder: (input) => ({ path: { nodeId: input.nodeId }, body: { tags: input.tags } }),
  output: nodeResponse,
  error: rpcStatus,
});

export const setApprovedRoutes = defineRequest({
  operation: "node.setApprovedRoutes",
  method: "POST",
  path: "/api/v1/node/:nodeId/approve_routes",
  input: struct.object({ nodeId: struct.string(), routes: struct.array(struct.string()) }),
  builder: (input) => ({ path: { nodeId: input.nodeId }, body: { routes: input.routes } }),
  output: nodeResponse,
  error: rpcStatus,
});

export const backfillNodeIps = defineRequest({
  operation: "node.backfillIps",
  method: "POST",
  path: "/api/v1/node/backfillips",
  input: struct.object({ confirmed: struct.boolean() }),
  builder: (input) => ({ query: input }),
  output: changesResponse,
  error: rpcStatus,
});

export const listApiKeys = defineRequest({
  operation: "apikey.list",
  method: "GET",
  path: "/api/v1/apikey",
  output: apiKeysResponse,
  error: rpcStatus,
});

export const createApiKey = defineRequest({
  operation: "apikey.create",
  method: "POST",
  path: "/api/v1/apikey",
  input: struct.object({ expiration: struct.string() }),
  builder: (input) => ({ body: input }),
  output: createApiKeyResponse,
  error: rpcStatus,
});

export const expireApiKey = defineRequest({
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

export const deleteApiKey = defineRequest({
  operation: "apikey.delete",
  method: "DELETE",
  path: "/api/v1/apikey/:prefix",
  input: struct.object({ prefix: struct.string() }),
  builder: (input) => ({ path: input }),
  error: rpcStatus,
});

export const getPolicy = defineRequest({
  operation: "policy.get",
  method: "GET",
  path: "/api/v1/policy",
  output: policyResponse,
  error: rpcStatus,
});

export const setPolicy = defineRequest({
  operation: "policy.set",
  method: "PUT",
  path: "/api/v1/policy",
  input: struct.object({ policy: struct.string() }),
  builder: (input) => ({ body: input }),
  output: policyResponse,
  error: rpcStatus,
});

export const checkPolicy = defineRequest({
  operation: "policy.check",
  method: "POST",
  path: "/api/v1/policy/check",
  input: struct.object({ policy: struct.string() }),
  builder: (input) => ({ body: input }),
  error: rpcStatus,
});

export const REQUEST_REGISTRY = {
  "health.check": health,
  "version.get": version,
  "user.list": listUsers,
  "user.create": createUser,
  "user.rename": renameUser,
  "user.delete": deleteUser,
  "preauthkey.list": listPreAuthKeys,
  "preauthkey.create": createPreAuthKey,
  "preauthkey.expire": expirePreAuthKey,
  "preauthkey.delete": deletePreAuthKey,
  "node.list": listNodes,
  "node.get": getNode,
  "node.register": registerNode,
  "node.debugCreate": debugCreateNode,
  "node.rename": renameNode,
  "node.expire": expireNode,
  "node.delete": deleteNode,
  "node.setTags": setTags,
  "node.setApprovedRoutes": setApprovedRoutes,
  "node.backfillIps": backfillNodeIps,
  "auth.register": authRegister,
  "auth.approve": authApprove,
  "auth.reject": authReject,
  "apikey.list": listApiKeys,
  "apikey.create": createApiKey,
  "apikey.expire": expireApiKey,
  "apikey.delete": deleteApiKey,
  "policy.get": getPolicy,
  "policy.set": setPolicy,
  "policy.check": checkPolicy,
} satisfies Record<OperationId, unknown>;
