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

export type ApiResult<T> = [Error, undefined] | [null, T];

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
): Promise<ApiResult<ApiOutput<K>>> {
  try {
    const result = await execute(command, options);
    if (!result.ok) return [new ApiError(result.error), undefined];
    return [null, result.value];
  } catch (cause) {
    return [new Error("execute request", { cause }), undefined];
  }
}

/** Promise.all requires rejection to fail fast; only this aggregation adapter throws tuple failures. */
async function required<T>(
  step: string,
  reading: Promise<ApiResult<T>>,
): Promise<T> {
  const [err, value] = await reading;
  if (err) throw new Error(step, { cause: err });
  return value;
}

export async function readHealth(
  execute: Execute,
  options?: SessionRequestOptions,
): Promise<ApiResult<HealthResponse>> {
  const startedAt = performance.now();
  const [err, response] = await request(
    execute,
    { endpoint: "health" },
    options,
  );
  if (err) return [err, undefined];
  return [
    null,
    {
      ...response,
      checkedAt: new Date().toISOString(),
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      serverReachable: true,
    },
  ];
}

const MISSING_DATABASE_POLICY = /acl\s+policy not found/i;
const UNSET_FILE_POLICY = /^reading policy from path "":/;

export async function readPolicy(
  execute: Execute,
  options?: SessionRequestOptions,
): Promise<ApiResult<PolicyReading>> {
  const [err, policy] = await request(
    execute,
    { endpoint: "getPolicy" },
    options,
  );
  if (err) {
    const message =
      err instanceof ApiError &&
      err.code === "HTTP_STATUS" &&
      err.status === 500
        ? (err.data?.message ?? "")
        : "";
    if (MISSING_DATABASE_POLICY.test(message)) return [null, { policy: "" }];
    // File mode with an empty policy.path means no policy is configured: Headscale itself runs allow-all.
    if (UNSET_FILE_POLICY.test(message))
      return [null, { policy: "", fileModeWithoutPath: true }];
    return [err, undefined];
  }
  return [null, policy];
}

const UNREADABLE_RESPONSE = new Set<FaultCode>([
  "RES_STRUCT_MISMATCH",
  "RES_DECODE_FAILED",
  "RES_MEDIA_TYPE_INVALID",
]);

type SegmentFetcher = (
  execute: Execute,
  options?: SessionRequestOptions,
) => Promise<ApiResult<Partial<HeadscaleSnapshot>>>;

const SEGMENT_FETCHERS = {
  identity: async (execute, options) => {
    try {
      const [users, preAuthKeys, apiKeys] = await Promise.all([
        required(
          "list users",
          request(execute, { endpoint: "listUsers", input: {} }, options),
        ),
        required(
          "list pre-auth keys",
          request(execute, { endpoint: "listPreAuthKeys" }, options),
        ),
        required(
          "list api keys",
          request(execute, { endpoint: "listApiKeys" }, options),
        ),
      ]);
      return [
        null,
        {
          users: users.users ?? [],
          preAuthKeys: (preAuthKeys.preAuthKeys ?? []).map(normalizePreAuthKey),
          apiKeys: apiKeys.apiKeys ?? [],
        },
      ];
    } catch (cause) {
      return [new Error("read identity", { cause }), undefined];
    }
  },
  fabric: async (execute, options) => {
    // ponytail: optional reads may delay the nodes until their request deadline; apply nodes first if that matters.
    const [[nodesErr, nodes], [healthErr, health], [versionErr, version]] =
      await Promise.all([
        request(execute, { endpoint: "listNodes", input: {} }, options),
        readHealth(execute, options),
        request(execute, { endpoint: "version" }, options),
      ]);
    if (nodesErr) {
      const unreadable =
        nodesErr instanceof ApiError &&
        nodesErr.code !== undefined &&
        UNREADABLE_RESPONSE.has(nodesErr.code);
      // Only a contract-level failure is explained by an unsupported series; transport and status
      // failures keep their own meaning (offline health, abort checks).
      if (
        unreadable &&
        !versionErr &&
        serverVersionSupport(version.version) === "unsupported"
      )
        return [
          new UnsupportedServerVersionError(version.version, {
            cause: nodesErr,
          }),
          undefined,
        ];
      return [new Error("list nodes", { cause: nodesErr }), undefined];
    }
    return [
      null,
      {
        nodes: (nodes.nodes ?? []).map(normalizeHeadscaleNode),
        health: healthErr ? null : health,
        // A failed optional read leaves the last known version in place.
        ...(versionErr ? {} : { version }),
      },
    ];
  },
  policy: async (execute, options) => {
    const [err, policy] = await readPolicy(execute, options);
    if (err) return [err, undefined];
    return [null, { policy }];
  },
} satisfies Record<SnapshotSegment, SegmentFetcher>;

export function fetchSegment(
  execute: Execute,
  segment: SnapshotSegment,
  options?: SessionRequestOptions,
): Promise<ApiResult<Partial<HeadscaleSnapshot>>> {
  return SEGMENT_FETCHERS[segment](execute, options);
}

export async function fetchSnapshot(
  execute: Execute,
  options?: SessionRequestOptions,
): Promise<ApiResult<HeadscaleSnapshot>> {
  try {
    const [identity, fabric, policy] = await Promise.all([
      required("read identity", SEGMENT_FETCHERS.identity(execute, options)),
      required("read fabric", SEGMENT_FETCHERS.fabric(execute, options)),
      required("read policy", SEGMENT_FETCHERS.policy(execute, options)),
    ]);
    // version is omitted from the fabric patch when its optional read failed.
    return [null, { version: null, ...identity, ...fabric, ...policy }];
  } catch (cause) {
    return [new Error("read snapshot", { cause }), undefined];
  }
}
