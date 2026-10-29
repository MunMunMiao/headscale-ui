import { type FaultCode, type Infer, struct } from "@defjs/core";
import { rpcStatus } from "@/api/contracts";

export const SESSION_PROTOCOL_VERSION = 1;
export const MAX_PORT_REQUESTS = 64;

// Wire contracts shared by the page and the Worker; every type that crosses the MessagePort is inferred here.
// The page imports this module at run time, so it must never import src/api/requests.ts (and defjs's HTTP
// pipeline with it); the page → Worker command structs live in protocol.ts, which only the Worker loads.
export const sessionIdentity = struct.object({
  workerId: struct.string(),
  sessionId: struct.string(),
});
export type SessionIdentity = Infer<typeof sessionIdentity>;

const sessionProfile = struct.object({
  id: struct.string(),
  name: struct.string(),
  baseUrl: struct.string(),
});
export type SessionProfile = Infer<typeof sessionProfile>;

const snapshotFields = {
  pendingProfileId: struct.string().null(),
  reason: struct
    .enum(["initial", "user", "expired", "clock-reversed", "profile-changed"])
    .null(),
  revision: struct.number(),
};
export const publicSessionSnapshot = struct.discriminatedUnion("status", [
  struct.object({
    ...snapshotFields,
    status: struct.literal("locked"),
    identity: struct.null(),
    profile: struct.null(),
    expiresAt: struct.null(),
    apiKeyPrefix: struct.null(),
  }),
  struct.object({
    ...snapshotFields,
    status: struct.literal("unlocked"),
    identity: sessionIdentity,
    profile: sessionProfile,
    expiresAt: struct.number(),
    // The display string `apikey list` already shows for the current key, never the key itself.
    apiKeyPrefix: struct.string().null(),
  }),
]);
export type PublicSessionSnapshot = Infer<typeof publicSessionSnapshot>;

const sessionFailureKind = struct.enum([
  "locked",
  "expired",
  "stale",
  "busy",
  "unlock-failed",
  "storage-conflict",
  "storage-failed",
  "unavailable",
  "cancelled",
  "invalid-request",
  "reload-required",
]);
export type SessionFailureKind = Infer<typeof sessionFailureKind>;

// Every code defjs reports; `satisfies` fails the build when a defjs upgrade adds or drops one.
const faultCodes = {
  CAP_BUFFER_EXCEEDED: 0,
  CAP_QUEUE_OVERFLOW: 0,
  ENV_UNSUPPORTED: 0,
  EXT_HOOK_FAILED: 0,
  EXT_INTERCEPTOR_FAILED: 0,
  EXT_OBSERVER_FAILED: 0,
  HTTP_STATUS: 0,
  NET_ABORTED: 0,
  NET_BODY_INCOMPLETE: 0,
  NET_TIMEOUT: 0,
  NET_UNREACHABLE: 0,
  REQ_BUILD_FAILED: 0,
  REQ_INPUT_INVALID: 0,
  REQ_OPTIONS_INVALID: 0,
  RES_DECODE_FAILED: 0,
  RES_MEDIA_TYPE_INVALID: 0,
  RES_STRUCT_MISMATCH: 0,
} satisfies Record<FaultCode, 0>;

// A write may have reached the server, but its result is unknown.
const outcome = struct.literal("unknown").optional();
export const workerError = struct.or(
  struct.object({
    kind: struct.literal("api"),
    code: struct.enum(Object.keys(faultCodes) as [FaultCode, ...FaultCode[]]),
    message: struct.string(),
    status: struct.number().optional(),
    data: rpcStatus.optional(),
    outcome,
  }),
  struct.object({ kind: sessionFailureKind, outcome }),
);
export type WorkerErrorDto = Infer<typeof workerError>;
export type ApiFailure = Extract<WorkerErrorDto, { kind: "api" }>;
export type SessionFailure = Exclude<WorkerErrorDto, ApiFailure>;

export const vaultVersion = struct.object({
  keyEpoch: struct.string(),
  profilesRevision: struct.number(),
});

/** Worker → page: the handshake, replies, and broadcasts. */
export const workerMessage = struct.discriminatedUnion("type", [
  struct.object({
    type: struct.literal("hello"),
    workerId: struct.string(),
    buildId: struct.string(),
    protocolVersion: struct.number(),
    storageVersion: struct.number(),
    snapshot: publicSessionSnapshot,
  }),
  struct.object({
    type: struct.literal("reply"),
    requestId: struct.number(),
    result: struct.discriminatedUnion("ok", [
      // The Worker client already decoded an API value with its endpoint's output struct; a request
      // without output (deleteUser) succeeds with no value.
      struct.object({
        ok: struct.literal(true),
        value: struct.unknown().nullish(),
      }),
      struct.object({ ok: struct.literal(false), error: workerError }),
    ]),
    snapshot: publicSessionSnapshot,
  }),
  struct.object({
    type: struct.literal("snapshot"),
    snapshot: publicSessionSnapshot,
  }),
  struct.object({ type: struct.literal("reset"), version: vaultVersion }),
  struct.object({ type: struct.literal("profiles-changed") }),
  struct.object({ type: struct.literal("error"), error: workerError }),
]);
export type WorkerMessage = Infer<typeof workerMessage>;

export type SessionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: WorkerErrorDto };

/** A Worker failure on the page side: a session failure, or the Worker's report of an API fault. */
export class ApiError extends Error {
  readonly kind: WorkerErrorDto["kind"];
  readonly code?: FaultCode;
  readonly status?: number;
  readonly data?: Infer<typeof rpcStatus>;
  readonly outcome?: "unknown";

  constructor(error: WorkerErrorDto) {
    super(
      error.kind === "api"
        ? error.message
        : `Session request failed (${error.kind}).`,
    );
    this.name = "ApiError";
    this.kind = error.kind;
    if (error.kind === "api") {
      this.code = error.code;
      this.status = error.status;
      this.data = error.data;
    }
    if (error.outcome === "unknown") this.outcome = "unknown";
  }
}
