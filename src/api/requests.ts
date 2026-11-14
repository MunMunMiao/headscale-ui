import { defineRequest, struct } from "@defjs/core";
import {
  ApiKeysResponse,
  ChangesResponse,
  CreateApiKeyResponse,
  HealthPayload,
  NodeResponse,
  NodesResponse,
  PolicyResponse,
  PreAuthKeyResponse,
  PreAuthKeysResponse,
  RpcStatus,
  UserResponse,
  UsersResponse,
  VersionResponse,
} from "./contracts";

// A builder only places its input. Checks belong before a command is built (defjs struct.mdx).
export const health = defineRequest({
  meta: { operation: "health.check" },
  method: "GET",
  path: "/api/v1/health",
  output: HealthPayload,
  error: RpcStatus,
});

export const version = defineRequest({
  meta: { operation: "version.get" },
  method: "GET",
  path: "/version",
  output: VersionResponse,
  error: RpcStatus,
});

export const listUsers = defineRequest({
  meta: { operation: "user.list" },
  method: "GET",
  path: "/api/v1/user",
  input: struct.object({
    id: struct.string().optional(),
    name: struct.string().optional(),
    email: struct.string().optional(),
  }),
  builder: (input) => ({ query: input }),
  output: UsersResponse,
  error: RpcStatus,
});

export const createUser = defineRequest({
  meta: { operation: "user.create" },
  method: "POST",
  path: "/api/v1/user",
  input: struct.object({
    name: struct.string(),
    displayName: struct.string().optional(),
    email: struct.string().optional(),
    pictureUrl: struct.string().optional(),
  }),
  builder: (input) => ({ body: input }),
  output: UserResponse,
  error: RpcStatus,
});

export const renameUser = defineRequest({
  meta: { operation: "user.rename" },
  method: "POST",
  path: "/api/v1/user/:id/rename/:newName",
  input: struct.object({ id: struct.string(), newName: struct.string() }),
  builder: (input) => ({ path: input }),
  output: UserResponse,
  error: RpcStatus,
});

export const deleteUser = defineRequest({
  meta: { operation: "user.delete" },
  method: "DELETE",
  path: "/api/v1/user/:id",
  input: struct.object({ id: struct.string() }),
  builder: (input) => ({ path: input }),
  error: RpcStatus,
});

export const listPreAuthKeys = defineRequest({
  meta: { operation: "preauthkey.list" },
  method: "GET",
  path: "/api/v1/preauthkey",
  output: PreAuthKeysResponse,
  error: RpcStatus,
});

export const createPreAuthKey = defineRequest({
  meta: { operation: "preauthkey.create" },
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
  output: PreAuthKeyResponse,
  error: RpcStatus,
});

export const expirePreAuthKey = defineRequest({
  meta: { operation: "preauthkey.expire" },
  method: "POST",
  path: "/api/v1/preauthkey/expire",
  input: struct.object({ id: struct.string() }),
  builder: (input) => ({ body: input }),
  error: RpcStatus,
});

export const deletePreAuthKey = defineRequest({
  meta: { operation: "preauthkey.delete" },
  method: "DELETE",
  path: "/api/v1/preauthkey",
  input: struct.object({ id: struct.string() }),
  builder: (input) => ({ query: input }),
  error: RpcStatus,
});

export const listNodes = defineRequest({
  meta: { operation: "node.list" },
  method: "GET",
  path: "/api/v1/node",
  input: struct.object({ user: struct.string().optional() }),
  builder: (input) => ({ query: input }),
  output: NodesResponse,
  error: RpcStatus,
});

export const getNode = defineRequest({
  meta: { operation: "node.get" },
  method: "GET",
  path: "/api/v1/node/:nodeId",
  input: struct.object({ nodeId: struct.string() }),
  builder: (input) => ({ path: input }),
  output: NodeResponse,
  error: RpcStatus,
});

export const registerNode = defineRequest({
  meta: { operation: "node.register" },
  method: "POST",
  path: "/api/v1/node/register",
  input: struct.object({ user: struct.string(), key: struct.string() }),
  builder: (input) => ({ query: input }),
  output: NodeResponse,
  error: RpcStatus,
});

export const authRegister = defineRequest({
  meta: { operation: "auth.register" },
  method: "POST",
  path: "/api/v1/auth/register",
  // user is the Headscale user name, not its numeric id.
  input: struct.object({ user: struct.string(), authId: struct.string() }),
  builder: (input) => ({ body: input }),
  output: NodeResponse,
  error: RpcStatus,
});

export const authApprove = defineRequest({
  meta: { operation: "auth.approve" },
  method: "POST",
  path: "/api/v1/auth/approve",
  input: struct.object({ authId: struct.string() }),
  builder: (input) => ({ body: input }),
  error: RpcStatus,
});

export const authReject = defineRequest({
  meta: { operation: "auth.reject" },
  method: "POST",
  path: "/api/v1/auth/reject",
  input: struct.object({ authId: struct.string() }),
  builder: (input) => ({ body: input }),
  error: RpcStatus,
});

export const debugCreateNode = defineRequest({
  meta: { operation: "node.debugCreate" },
  method: "POST",
  path: "/api/v1/debug/node",
  input: struct.object({
    user: struct.string(),
    key: struct.string(),
    name: struct.string(),
    routes: struct.array(struct.string()).optional(),
  }),
  builder: (input) => ({ body: input }),
  output: NodeResponse,
  error: RpcStatus,
});

export const renameNode = defineRequest({
  meta: { operation: "node.rename" },
  method: "POST",
  path: "/api/v1/node/:nodeId/rename/:newName",
  input: struct.object({ nodeId: struct.string(), newName: struct.string() }),
  builder: (input) => ({ path: input }),
  output: NodeResponse,
  error: RpcStatus,
});

export const expireNode = defineRequest({
  meta: { operation: "node.expire" },
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
  output: NodeResponse,
  error: RpcStatus,
});

export const deleteNode = defineRequest({
  meta: { operation: "node.delete" },
  method: "DELETE",
  path: "/api/v1/node/:nodeId",
  input: struct.object({ nodeId: struct.string() }),
  builder: (input) => ({ path: input }),
  error: RpcStatus,
});

export const setTags = defineRequest({
  meta: { operation: "node.setTags" },
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
  output: NodeResponse,
  error: RpcStatus,
});

export const setApprovedRoutes = defineRequest({
  meta: { operation: "node.setApprovedRoutes" },
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
  output: NodeResponse,
  error: RpcStatus,
});

export const backfillNodeIps = defineRequest({
  meta: { operation: "node.backfillIps" },
  method: "POST",
  path: "/api/v1/node/backfillips",
  input: struct.object({ confirmed: struct.boolean() }),
  builder: (input) => ({ query: input }),
  output: ChangesResponse,
  error: RpcStatus,
});

export const listApiKeys = defineRequest({
  meta: { operation: "apikey.list" },
  method: "GET",
  path: "/api/v1/apikey",
  output: ApiKeysResponse,
  error: RpcStatus,
});

export const createApiKey = defineRequest({
  meta: { operation: "apikey.create" },
  method: "POST",
  path: "/api/v1/apikey",
  input: struct.object({ expiration: struct.string() }),
  builder: (input) => ({ body: input }),
  output: CreateApiKeyResponse,
  error: RpcStatus,
});

export const expireApiKey = defineRequest({
  meta: { operation: "apikey.expire" },
  method: "POST",
  path: "/api/v1/apikey/expire",
  input: struct.or(
    struct.object({ prefix: struct.string(), id: struct.string().optional() }),
    struct.object({ id: struct.string(), prefix: struct.string().optional() }),
  ),
  builder: (input) => ({ body: input }),
  error: RpcStatus,
});

export const deleteApiKey = defineRequest({
  meta: { operation: "apikey.delete" },
  method: "DELETE",
  path: "/api/v1/apikey/:prefix",
  input: struct.object({ prefix: struct.string() }),
  builder: (input) => ({ path: input }),
  error: RpcStatus,
});

export const getPolicy = defineRequest({
  meta: { operation: "policy.get" },
  method: "GET",
  path: "/api/v1/policy",
  output: PolicyResponse,
  error: RpcStatus,
});

export const setPolicy = defineRequest({
  meta: { operation: "policy.set" },
  method: "PUT",
  path: "/api/v1/policy",
  input: struct.object({ policy: struct.string() }),
  builder: (input) => ({ body: input }),
  output: PolicyResponse,
  error: RpcStatus,
});

export const checkPolicy = defineRequest({
  meta: { operation: "policy.check" },
  method: "POST",
  path: "/api/v1/policy/check",
  input: struct.object({ policy: struct.string() }),
  builder: (input) => ({ body: input }),
  error: RpcStatus,
});
