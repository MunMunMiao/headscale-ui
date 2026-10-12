import { expect, expectTypeOf, test } from "vitest";
import { OPERATION_IDS } from "@/domain/headscale-operations";
import * as commands from "./commands";

test("all 30 commands are cloneable operation/input descriptors", () => {
  const descriptors = [
    commands.health(),
    commands.version(),
    commands.listUsers({}),
    commands.createUser({ name: "alice" }),
    commands.renameUser({ id: "1", newName: "bob" }),
    commands.deleteUser({ id: "1" }),
    commands.listPreAuthKeys(),
    commands.createPreAuthKey({ user: "1", expiration: "2027-01-01T00:00:00Z" }),
    commands.expirePreAuthKey({ id: "1" }),
    commands.deletePreAuthKey({ id: "1" }),
    commands.listNodes({}),
    commands.getNode({ nodeId: "1" }),
    commands.registerNode({ user: "1", key: "mkey:fixture" }),
    commands.debugCreateNode({ user: "1", key: "mkey:fixture", name: "node" }),
    commands.renameNode({ nodeId: "1", newName: "node" }),
    commands.expireNode({ nodeId: "1" }),
    commands.deleteNode({ nodeId: "1" }),
    commands.setTags({ nodeId: "1", tags: ["tag:server"] }),
    commands.setApprovedRoutes({ nodeId: "1", routes: [] }),
    commands.backfillNodeIps({ confirmed: true }),
    commands.authRegister({ user: "alice", authId: "hskey-authreq-abcdefghijklmnopqrstuvwx" }),
    commands.authApprove({ authId: "hskey-authreq-abcdefghijklmnopqrstuvwx" }),
    commands.authReject({ authId: "hskey-authreq-abcdefghijklmnopqrstuvwx" }),
    commands.listApiKeys(),
    commands.createApiKey({ expiration: "2027-01-01T00:00:00Z" }),
    commands.expireApiKey({ prefix: "fixture" }),
    commands.deleteApiKey({ prefix: "fixture" }),
    commands.getPolicy(),
    commands.setPolicy({ policy: '{"acls":[]}' }),
    commands.checkPolicy({ policy: '{"acls":[]}' }),
  ];
  expect(descriptors.map(({ operation }) => operation)).toEqual(OPERATION_IDS);
  expect(structuredClone(descriptors)).toEqual(descriptors);
  for (const descriptor of descriptors) {
    expect(Reflect.ownKeys(descriptor)).toEqual(["operation", "input"]);
    expect(Object.getPrototypeOf(descriptor)).toBe(Object.prototype);
  }
});

test("keeps declared input as data without constructing transport headers or URLs", () => {
  const input = { nodeId: "1/2", tags: ["tag:server", "tag:mobile"] };
  expect(commands.setTags(input)).toEqual({ operation: "node.setTags", input });
  expect(commands.health()).toEqual({ operation: "health.check", input: undefined });
});

test("derives operation-specific input and output from the real request registry", () => {
  expectTypeOf(commands.setTags)
    .parameter(0)
    .toEqualTypeOf<commands.OperationInput<"node.setTags">>();
  expectTypeOf(commands.getPolicy()).toEqualTypeOf<commands.OperationCommand<"policy.get">>();
  expectTypeOf<commands.OperationOutput<"policy.get">>()
    .toHaveProperty("policy")
    .toEqualTypeOf<string>();
  expectTypeOf<commands.OperationOutput<"user.delete">>().toEqualTypeOf<undefined>();
  expectTypeOf<commands.OperationInput<"health.check">>().toEqualTypeOf<undefined>();
});
