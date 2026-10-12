export const OPERATION_IDS = [
  "health.check",
  "version.get",
  "user.list",
  "user.create",
  "user.rename",
  "user.delete",
  "preauthkey.list",
  "preauthkey.create",
  "preauthkey.expire",
  "preauthkey.delete",
  "node.list",
  "node.get",
  "node.register",
  "node.debugCreate",
  "node.rename",
  "node.expire",
  "node.delete",
  "node.setTags",
  "node.setApprovedRoutes",
  "node.backfillIps",
  "auth.register",
  "auth.approve",
  "auth.reject",
  "apikey.list",
  "apikey.create",
  "apikey.expire",
  "apikey.delete",
  "policy.get",
  "policy.set",
  "policy.check",
] as const;

export type OperationId = (typeof OPERATION_IDS)[number];

// policy.check is a POST that only validates; every other non-GET operation writes.
const READ_ONLY_OPERATIONS: ReadonlySet<OperationId> = new Set<OperationId>([
  "health.check",
  "version.get",
  "user.list",
  "node.list",
  "node.get",
  "preauthkey.list",
  "apikey.list",
  "policy.get",
  "policy.check",
]);

/** Writes are the default so a new operation is treated as modifying until listed above. */
export const modifiesServer = (operation: OperationId) => !READ_ONLY_OPERATIONS.has(operation);
