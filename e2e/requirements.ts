import type { OperationId } from "./network-observations";

// Every Headscale REST operation must be exercised by the Headscale lifecycle test, either
// through the UI or as an API contract; the test asserts that this list matches what it observed.
export type E2ERequirement = {
  id: string;
  kind: "rest";
  environment: "docker-headscale";
  testTitle: string;
  operationId: OperationId;
  driver: "ui" | "api-contract";
  evidence: string;
};

const restLifecycleTitle =
  "exercises every supported Headscale v0.29.4 REST operation with deterministic readback";

export const E2E_REQUIREMENTS = [
  ...(
    [
      ["health.check", "ui", 'expectUiOperationDelta("health.check"'],
      ["version.get", "ui", 'expectUiOperationDelta("version.get"'],
      ["user.list", "ui", 'expectUiOperationDelta("user.list"'],
      ["user.create", "ui", 'expectUiOperationDelta("user.create"'],
      ["user.rename", "ui", 'expectUiOperationDelta("user.rename"'],
      ["user.delete", "ui", 'expectUiOperationDelta("user.delete"'],
      ["preauthkey.list", "ui", 'expectUiOperationDelta("preauthkey.list"'],
      ["preauthkey.create", "ui", 'expectUiOperationDelta("preauthkey.create"'],
      ["preauthkey.expire", "ui", 'expectUiOperationDelta("preauthkey.expire"'],
      ["preauthkey.delete", "ui", 'expectUiOperationDelta("preauthkey.delete"'],
      ["node.list", "ui", 'expectUiOperationDelta("node.list"'],
      ["node.get", "api-contract", 'observeApiContract("node.get"'],
      ["node.register", "api-contract", 'observeApiContract("node.register"'],
      ["node.debugCreate", "api-contract", 'observeApiContract("node.debugCreate"'],
      ["node.rename", "ui", 'expectUiOperationDelta("node.rename"'],
      ["node.expire", "ui", 'expectUiOperationDelta("node.expire"'],
      ["node.delete", "ui", 'expectUiOperationDelta("node.delete"'],
      ["node.setTags", "ui", 'expectUiOperationDelta("node.setTags"'],
      ["node.setApprovedRoutes", "ui", 'expectUiOperationDelta("node.setApprovedRoutes"'],
      ["node.backfillIps", "ui", 'expectUiOperationDelta("node.backfillIps"'],
      ["auth.register", "ui", 'expectUiOperationDelta("auth.register"'],
      ["auth.approve", "ui", 'expectUiOperationDelta("auth.approve"'],
      ["auth.reject", "ui", 'expectUiOperationDelta("auth.reject"'],
      ["apikey.list", "ui", 'expectUiOperationDelta("apikey.list"'],
      ["apikey.create", "ui", 'expectUiOperationDelta("apikey.create"'],
      ["apikey.expire", "ui", 'expectUiOperationDelta("apikey.expire"'],
      ["apikey.delete", "ui", 'expectUiOperationDelta("apikey.delete"'],
      ["policy.get", "ui", 'expectUiOperationDelta("policy.get"'],
      ["policy.set", "ui", 'expectUiOperationDelta("policy.set"'],
      ["policy.check", "ui", 'expectUiOperationDelta("policy.check"'],
    ] as const
  ).map(([operationId, driver, evidence]) => ({
    id: `rest.${operationId}`,
    kind: "rest" as const,
    environment: "docker-headscale" as const,
    testTitle: restLifecycleTitle,
    operationId,
    driver,
    evidence,
  })),
] as const satisfies readonly E2ERequirement[];
