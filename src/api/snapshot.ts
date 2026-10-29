import type { FaultCode } from "@defjs/core";
import {
  serverVersionSupport,
  UnsupportedServerVersionError,
} from "@/domain/server-version";
import type { SessionRequestOptions } from "@/session/auth-session";
import type { ApiCommand, ApiOutput, EndpointName } from "@/session/protocol";
import { ApiError, type SessionResult } from "@/session/types";
import type {
  HeadscaleSnapshot,
  HealthResponse,
  PolicyReading,
} from "./contracts";
import { normalizeHeadscaleNode, normalizePreAuthKey } from "./contracts";

/** Runs one request in the Worker: the page's bridge bound to its session, or the Worker's dispatcher. */
export type Execute = <K extends EndpointName>(
  command: ApiCommand<K>,
  options?: SessionRequestOptions,
) => Promise<SessionResult<ApiOutput<K>>>;

export type SnapshotSegment = "identity" | "fabric" | "policy";
export const ALL_SEGMENTS: readonly SnapshotSegment[] = [
  "identity",
  "fabric",
  "policy",
];

async function request<K extends EndpointName>(
  execute: Execute,
  command: ApiCommand<K>,
  options?: SessionRequestOptions,
): Promise<ApiOutput<K>> {
  const result = await execute(command, options);
  if (!result.ok) throw new ApiError(result.error);
  return result.value;
}

export async function readHealth(
  execute: Execute,
  options?: SessionRequestOptions,
): Promise<HealthResponse> {
  const startedAt = performance.now();
  const response = await request(execute, { endpoint: "health" }, options);
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
  execute: Execute,
  options?: SessionRequestOptions,
): Promise<PolicyReading> {
  const result = await execute({ endpoint: "getPolicy" }, options);
  if (!result.ok) {
    const error = new ApiError(result.error);
    const message =
      error.code === "HTTP_STATUS" && error.status === 500
        ? (error.data?.message ?? "")
        : "";
    if (MISSING_DATABASE_POLICY.test(message)) return { policy: "" };
    // File mode with an empty policy.path means no policy is configured: Headscale itself runs allow-all.
    if (UNSET_FILE_POLICY.test(message))
      return { policy: "", fileModeWithoutPath: true };
    throw error;
  }
  return result.value;
}

const UNREADABLE_RESPONSE = new Set<FaultCode>([
  "RES_STRUCT_MISMATCH",
  "RES_DECODE_FAILED",
  "RES_MEDIA_TYPE_INVALID",
]);

const SEGMENT_FETCHERS = {
  identity: async (execute, options) => {
    const [users, preAuthKeys, apiKeys] = await Promise.all([
      request(execute, { endpoint: "listUsers", input: {} }, options),
      request(execute, { endpoint: "listPreAuthKeys" }, options),
      request(execute, { endpoint: "listApiKeys" }, options),
    ]);
    return {
      users: users.users ?? [],
      preAuthKeys: (preAuthKeys.preAuthKeys ?? []).map(normalizePreAuthKey),
      apiKeys: apiKeys.apiKeys ?? [],
    };
  },
  fabric: async (execute, options) => {
    // ponytail: resolves when all three settle, so a hanging (not failing) optional read can delay
    // the nodes by up to the Worker request timeout; apply the nodes patch first if that matters.
    const [nodes, health, version] = await Promise.allSettled([
      request(execute, { endpoint: "listNodes", input: {} }, options),
      readHealth(execute, options),
      request(execute, { endpoint: "version" }, options),
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
        throw new UnsupportedServerVersionError(version.value.version, {
          cause: nodes.reason,
        });
      throw nodes.reason;
    }
    return {
      nodes: (nodes.value.nodes ?? []).map(normalizeHeadscaleNode),
      health: health.status === "fulfilled" ? health.value : null,
      // A failed read leaves the last known version in place.
      ...(version.status === "fulfilled" ? { version: version.value } : {}),
    };
  },
  policy: async (execute, options) => ({
    policy: await readPolicy(execute, options),
  }),
} satisfies Record<
  SnapshotSegment,
  (
    execute: Execute,
    options?: SessionRequestOptions,
  ) => Promise<Partial<HeadscaleSnapshot>>
>;

export function fetchSegment(
  execute: Execute,
  segment: SnapshotSegment,
  options?: SessionRequestOptions,
): Promise<Partial<HeadscaleSnapshot>> {
  return SEGMENT_FETCHERS[segment](execute, options);
}

export async function fetchSnapshot(
  execute: Execute,
  options?: SessionRequestOptions,
): Promise<HeadscaleSnapshot> {
  const [identity, fabric, policy] = await Promise.all([
    SEGMENT_FETCHERS.identity(execute, options),
    SEGMENT_FETCHERS.fabric(execute, options),
    SEGMENT_FETCHERS.policy(execute, options),
  ]);
  // version is omitted from the fabric patch when its optional read failed.
  return { version: null, ...identity, ...fabric, ...policy };
}
