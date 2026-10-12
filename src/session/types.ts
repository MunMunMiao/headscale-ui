import type { FaultCode, Infer } from "@defjs/core";
import type { rpcStatus } from "@/api/contracts";

export interface SessionIdentity {
  readonly workerId: string;
  readonly sessionId: string;
}

export interface SessionProfile {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
}

export interface PublicSessionSnapshot {
  readonly status: "locked" | "unlocked";
  readonly identity: SessionIdentity | null;
  readonly profile: SessionProfile | null;
  readonly expiresAt: number | null;
  readonly pendingProfileId: string | null;
  readonly reason: "initial" | "user" | "expired" | "clock-reversed" | "profile-changed" | null;
  readonly revision: number;
  /** The display string `apikey list` already shows for the current key, never the key itself. */
  readonly apiKeyPrefix: string | null;
}

export type SessionFailureKind =
  | "locked"
  | "expired"
  | "stale"
  | "busy"
  | "unlock-failed"
  | "storage-conflict"
  | "storage-failed"
  | "unavailable"
  | "cancelled"
  | "invalid-request"
  | "reload-required";

export interface SessionFailure {
  readonly kind: SessionFailureKind;
  readonly outcome?: "unknown";
}

export interface ApiFailure {
  readonly kind: "api";
  readonly code: FaultCode;
  readonly message: string;
  readonly status?: number;
  readonly data?: Infer<typeof rpcStatus>;
  /** A write may have reached the server, but its result is unknown. */
  readonly outcome?: "unknown";
}

export type WorkerErrorDto = SessionFailure | ApiFailure;
export type SessionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: WorkerErrorDto };
