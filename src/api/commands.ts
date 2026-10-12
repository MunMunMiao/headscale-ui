import type { HttpCommand, RequestSuccessData } from "@defjs/core";
import type { OperationId } from "@/domain/headscale-operations";
import type { REQUEST_REGISTRY } from "./requests";

type Registry = typeof REQUEST_REGISTRY;
export type OperationInput<K extends OperationId> =
  Parameters<Registry[K]> extends [] ? undefined : Parameters<Registry[K]>[0];
export type OperationOutput<K extends OperationId> =
  ReturnType<Registry[K]> extends HttpCommand<infer _Input, infer Output, infer _Error>
    ? RequestSuccessData<Output>
    : never;
export type OperationCommand<K extends OperationId = OperationId> = {
  [Id in K]: { readonly operation: Id; readonly input: OperationInput<Id> };
}[K];

function command<K extends OperationId>(operation: K) {
  return (...[input]: Parameters<Registry[K]>) => ({ operation, input }) as OperationCommand<K>;
}

export const health = command("health.check");
export const version = command("version.get");
export const listUsers = command("user.list");
export const createUser = command("user.create");
export const renameUser = command("user.rename");
export const deleteUser = command("user.delete");
export const listPreAuthKeys = command("preauthkey.list");
export const createPreAuthKey = command("preauthkey.create");
export const expirePreAuthKey = command("preauthkey.expire");
export const deletePreAuthKey = command("preauthkey.delete");
export const listNodes = command("node.list");
export const getNode = command("node.get");
export const registerNode = command("node.register");
export const debugCreateNode = command("node.debugCreate");
export const renameNode = command("node.rename");
export const expireNode = command("node.expire");
export const deleteNode = command("node.delete");
export const setTags = command("node.setTags");
export const setApprovedRoutes = command("node.setApprovedRoutes");
export const backfillNodeIps = command("node.backfillIps");
export const authRegister = command("auth.register");
export const authApprove = command("auth.approve");
export const authReject = command("auth.reject");
export const listApiKeys = command("apikey.list");
export const createApiKey = command("apikey.create");
export const expireApiKey = command("apikey.expire");
export const deleteApiKey = command("apikey.delete");
export const getPolicy = command("policy.get");
export const setPolicy = command("policy.set");
export const checkPolicy = command("policy.check");
