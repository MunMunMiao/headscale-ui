import type { FaultCode } from "@defjs/core";
import type { OperationId } from "@/domain/headscale-operations";
import { serverVersionSupport, UnsupportedServerVersionError } from "@/domain/server-version";
import type { OperationCommand, OperationOutput } from "./commands";
import * as commands from "./commands";
import type { HeadscaleSnapshot, HealthResponse, PolicyReading } from "./contracts";
import { normalizeHeadscaleNode, normalizePreAuthKey } from "./contracts";
import { ApiError, type GatewayExecuteOptions, type HeadscaleGateway } from "./gateway";

export type SnapshotSegment = "identity" | "fabric" | "policy";
export const ALL_SEGMENTS: readonly SnapshotSegment[] = ["identity", "fabric", "policy"];

async function request<K extends OperationId>(
  gateway: HeadscaleGateway,
  command: OperationCommand<K>,
  options?: GatewayExecuteOptions,
): Promise<OperationOutput<K>> {
  const [error, data] = await gateway.execute(command, options);
  if (error) throw error;
  return data;
}

export async function readHealth(
  gateway: HeadscaleGateway,
  options?: GatewayExecuteOptions,
): Promise<HealthResponse> {
  const startedAt = performance.now();
  const response = await request(gateway, commands.health(), options);
  return {
    ...response,
    checkedAt: new Date().toISOString(),
    latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    serverReachable: true,
  };
}

const MISSING_DATABASE_POLICY = /acl\s+policy not found/i;
const UNSET_FILE_POLICY = /^reading policy from path "":/;

export async function readPolicy(
  gateway: HeadscaleGateway,
  options?: GatewayExecuteOptions,
): Promise<PolicyReading> {
  const [error, response] = await gateway.execute(commands.getPolicy(), options);
  if (error) {
    const message =
      error.code === "HTTP_STATUS" && error.status === 500 ? (error.data?.message ?? "") : "";
    if (MISSING_DATABASE_POLICY.test(message)) return { policy: "" };
    // File mode with an empty policy.path means no policy is configured: Headscale itself runs allow-all.
    if (UNSET_FILE_POLICY.test(message)) return { policy: "", fileModeWithoutPath: true };
    throw error;
  }
  return response;
}

const UNREADABLE_RESPONSE = new Set<FaultCode>([
  "RES_STRUCT_MISMATCH",
  "RES_DECODE_FAILED",
  "RES_MEDIA_TYPE_INVALID",
]);

const SEGMENT_FETCHERS = {
  identity: async (gateway, options) => {
    const [users, preAuthKeys, apiKeys] = await Promise.all([
      request(gateway, commands.listUsers({}), options),
      request(gateway, commands.listPreAuthKeys(), options),
      request(gateway, commands.listApiKeys(), options),
    ]);
    return {
      users: users.users ?? [],
      preAuthKeys: (preAuthKeys.preAuthKeys ?? []).map(normalizePreAuthKey),
      apiKeys: apiKeys.apiKeys ?? [],
    };
  },
  fabric: async (gateway, options) => {
    // ponytail: resolves when all three settle, so a hanging (not failing) optional read can delay
    // the nodes by up to the Worker request timeout; apply the nodes patch first if that matters.
    const [nodes, health, version] = await Promise.allSettled([
      request(gateway, commands.listNodes({}), options),
      readHealth(gateway, options),
      request(gateway, commands.version(), options),
    ]);
    if (nodes.status === "rejected") {
      const unreadable =
        nodes.reason instanceof ApiError &&
        nodes.reason.code !== undefined &&
        UNREADABLE_RESPONSE.has(nodes.reason.code);
      // Only a contract-level failure is explained by an unsupported series; transport and status
      // failures keep their own meaning (offline health, abort checks).
      if (
        unreadable &&
        version.status === "fulfilled" &&
        serverVersionSupport(version.value.version) === "unsupported"
      )
        throw new UnsupportedServerVersionError(version.value.version, { cause: nodes.reason });
      throw nodes.reason;
    }
    return {
      nodes: (nodes.value.nodes ?? []).map(normalizeHeadscaleNode),
      health: health.status === "fulfilled" ? health.value : null,
      // A failed read leaves the last known version in place.
      ...(version.status === "fulfilled" ? { version: version.value } : {}),
    };
  },
  policy: async (gateway, options) => ({ policy: await readPolicy(gateway, options) }),
} satisfies Record<
  SnapshotSegment,
  (
    gateway: HeadscaleGateway,
    options?: GatewayExecuteOptions,
  ) => Promise<Partial<HeadscaleSnapshot>>
>;

export function fetchSegment(
  gateway: HeadscaleGateway,
  segment: SnapshotSegment,
  options?: GatewayExecuteOptions,
): Promise<Partial<HeadscaleSnapshot>> {
  return SEGMENT_FETCHERS[segment](gateway, options);
}

export async function fetchSnapshot(
  gateway: HeadscaleGateway,
  options?: GatewayExecuteOptions,
): Promise<HeadscaleSnapshot> {
  const [identity, fabric, policy] = await Promise.all([
    SEGMENT_FETCHERS.identity(gateway, options),
    SEGMENT_FETCHERS.fabric(gateway, options),
    SEGMENT_FETCHERS.policy(gateway, options),
  ]);
  // version is omitted from the fabric patch when its optional read failed.
  return { version: null, ...identity, ...fabric, ...policy };
}
