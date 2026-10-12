import { ApiError } from "@/api/gateway";
import { redactDiagnosticData } from "@/api/operation-log";
import { listedApiKeyPrefix } from "@/domain/api-key";
import { modifiesServer, type OperationId } from "@/domain/headscale-operations";
import type {
  PublicSessionSnapshot,
  SessionFailure,
  SessionFailureKind,
  SessionIdentity,
  SessionProfile,
  SessionResult,
} from "./types";

export const SESSION_IDLE_MS = 30 * 60 * 1000;

export interface UnlockInput {
  profileId: string;
  password: string;
  expectedWorkerId: string;
  expectedIdentity: SessionIdentity | null;
  expectedCredentialVersion: string;
  operationId: string;
  ownerTabId: string;
  portId: string;
}

/** Worker-local credentials; this type never crosses a MessagePort. */
export interface CandidateCredential {
  profile: SessionProfile;
  credentialVersion: string;
  keyEpoch: string;
  apiKey: string;
}

export interface AuthOperationCommand {
  operation: OperationId;
  input?: unknown;
}

export interface SessionRequestOptions {
  signal?: AbortSignal;
}

export interface SessionExecutionContext {
  signal: AbortSignal;
  requireCurrent(): { baseUrl: string; apiKey: string };
}

export interface AuthSessionDependencies {
  workerId: string;
  now(): number;
  newSessionId(): string;
  openCredential(input: UnlockInput, signal: AbortSignal): Promise<CandidateCredential>;
  readCurrentProfile(
    credential: CandidateCredential,
    ownerTabId: string,
  ): Promise<SessionProfile | null>;
  validateCredential(
    credential: CandidateCredential,
    signal: AbortSignal,
    requireCurrent: () => void,
  ): Promise<void>;
  execute(
    command: AuthOperationCommand,
    context: SessionExecutionContext,
  ): Promise<SessionResult<unknown>>;
}

/** The result of the synchronous session operations, which fail only with session faults. */
export type SessionOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SessionFailure };

export class SessionFault extends Error {
  constructor(readonly kind: SessionFailureKind) {
    super(kind);
    this.name = "SessionFault";
  }
}

export function createAuthSession(deps: AuthSessionDependencies) {
  const listeners = new Set<() => void>();
  let active: {
    credential: CandidateCredential;
    identity: SessionIdentity;
    expiresAt: number;
    controller: AbortController;
  } | null = null;
  type Candidate = {
    controller: AbortController;
    expectedIdentity: SessionIdentity | null;
    invalidated?: SessionFailureKind;
  };
  let candidate: Candidate | null = null;
  let lastObserved = deps.now();
  let snapshot: PublicSessionSnapshot = Object.freeze({
    status: "locked",
    identity: null,
    profile: null,
    expiresAt: null,
    pendingProfileId: null,
    reason: "initial",
    revision: 0,
    apiKeyPrefix: null,
  });
  const failure = (kind: SessionFailureKind, outcome?: "unknown"): SessionOutcome<never> => ({
    ok: false,
    error: { kind, ...(outcome ? { outcome } : {}) },
  });
  function publish(patch: Partial<PublicSessionSnapshot>) {
    if (
      (Object.keys(patch) as (keyof PublicSessionSnapshot)[]).every((key) =>
        Object.is(snapshot[key], patch[key]),
      )
    )
      return snapshot;
    snapshot = Object.freeze({ ...snapshot, ...patch, revision: snapshot.revision + 1 });
    for (const listener of listeners) listener();
    return snapshot;
  }
  function invalidate(reason: PublicSessionSnapshot["reason"]) {
    active?.controller.abort();
    if (candidate)
      candidate.invalidated =
        reason === "expired" ? "expired" : reason === "clock-reversed" ? "locked" : "stale";
    candidate?.controller.abort();
    candidate = null;
    active = null;
    publish({
      status: "locked",
      identity: null,
      profile: null,
      expiresAt: null,
      reason,
      pendingProfileId: null,
      apiKeyPrefix: null,
    });
  }
  function observeTime() {
    const now = deps.now();
    const reversed = now < lastObserved;
    lastObserved = now;
    if (reversed) {
      invalidate("clock-reversed");
      throw new SessionFault("locked");
    }
    if (active && now >= active.expiresAt) {
      invalidate("expired");
      throw new SessionFault("expired");
    }
    return now;
  }
  function requireActive(expected: SessionIdentity) {
    observeTime();
    if (!active) throw new SessionFault(snapshot.reason === "expired" ? "expired" : "locked");
    if (
      active.identity.workerId !== expected.workerId ||
      active.identity.sessionId !== expected.sessionId
    )
      throw new SessionFault("stale");
    return active;
  }
  function caught(error: unknown, outcome?: "unknown"): SessionOutcome<never> {
    return failure(error instanceof SessionFault ? error.kind : "unavailable", outcome);
  }
  function sameIdentity(a: SessionIdentity | null, b: SessionIdentity | null) {
    return (
      a === b ||
      (a !== null && b !== null && a.workerId === b.workerId && a.sessionId === b.sessionId)
    );
  }
  return {
    getSnapshot: () => snapshot,
    updateProfileName(profileId: string, name: string) {
      if (!active || active.credential.profile.id !== profileId || snapshot.profile?.name === name)
        return snapshot;
      active.credential.profile = Object.freeze({
        id: profileId,
        name,
        baseUrl: active.credential.profile.baseUrl,
      });
      return publish({ profile: active.credential.profile });
    },
    invalidateProfile(profileId: string) {
      if (active?.credential.profile.id === profileId) invalidate("profile-changed");
      else if (candidate && snapshot.pendingProfileId === profileId) {
        candidate.invalidated = "storage-conflict";
        candidate.controller.abort();
        candidate = null;
        publish({ pendingProfileId: null });
      }
      return snapshot;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async unlock(
      input: UnlockInput,
      options?: SessionRequestOptions,
    ): Promise<SessionResult<PublicSessionSnapshot>> {
      try {
        observeTime();
        if (
          input.expectedWorkerId !== deps.workerId ||
          !sameIdentity(input.expectedIdentity, active?.identity ?? null)
        )
          return failure("stale");
        if (candidate) return failure("busy");
        if (!input.password) return failure("unlock-failed");
        if (options?.signal?.aborted) return failure("cancelled");
        const ticket: Candidate = {
          controller: new AbortController(),
          expectedIdentity: active?.identity ?? null,
        };
        const signal = options?.signal
          ? AbortSignal.any([ticket.controller.signal, options.signal])
          : ticket.controller.signal;
        candidate = ticket;
        publish({ pendingProfileId: input.profileId });
        function requireCandidate() {
          if (ticket.invalidated) throw new SessionFault(ticket.invalidated);
          observeTime();
          if (
            candidate !== ticket ||
            !sameIdentity(ticket.expectedIdentity, active?.identity ?? null)
          )
            throw new SessionFault("stale");
          if (signal.aborted) throw new SessionFault("cancelled");
        }
        let credential: CandidateCredential | undefined;
        try {
          credential = await deps.openCredential(input, signal);
          requireCandidate();
          if (
            credential.profile.id !== input.profileId ||
            credential.credentialVersion !== input.expectedCredentialVersion
          )
            throw new SessionFault("storage-conflict");
          await deps.validateCredential(credential, signal, requireCandidate);
          requireCandidate();
          const current = await deps.readCurrentProfile(credential, input.ownerTabId);
          requireCandidate();
          if (
            !current ||
            current.id !== credential.profile.id ||
            current.baseUrl !== credential.profile.baseUrl
          )
            throw new SessionFault("storage-conflict");
          credential.profile = Object.freeze({
            id: current.id,
            name: current.name,
            baseUrl: current.baseUrl,
          });
          const identity = Object.freeze({
            workerId: deps.workerId,
            sessionId: deps.newSessionId(),
          });
          active?.controller.abort();
          active = {
            credential,
            identity,
            expiresAt: lastObserved + SESSION_IDLE_MS,
            controller: new AbortController(),
          };
          candidate = null;
          return {
            ok: true,
            value: publish({
              status: "unlocked",
              identity,
              profile: Object.freeze({
                id: credential.profile.id,
                name: credential.profile.name,
                baseUrl: credential.profile.baseUrl,
              }),
              expiresAt: active.expiresAt,
              pendingProfileId: null,
              reason: null,
              apiKeyPrefix: listedApiKeyPrefix(credential.apiKey),
            }),
          };
        } catch (error) {
          try {
            requireCandidate();
          } catch (invalidated) {
            return caught(invalidated);
          }
          if (credential && error instanceof ApiError && error.kind === "api" && error.code)
            return {
              ok: false,
              error: {
                kind: "api",
                code: error.code,
                message: redactDiagnosticData(error.message, credential.apiKey),
                status: error.status,
                data: redactDiagnosticData(error.data, credential.apiKey),
              },
            };
          return failure(error instanceof SessionFault ? error.kind : "unlock-failed");
        } finally {
          if (candidate === ticket) {
            candidate = null;
            publish({ pendingProfileId: null });
          }
        }
      } catch (error) {
        return caught(error);
      }
    },
    check(expected?: SessionIdentity): SessionOutcome<PublicSessionSnapshot> {
      try {
        if (expected) requireActive(expected);
        else observeTime();
        return { ok: true, value: snapshot };
      } catch (error) {
        return caught(error);
      }
    },
    touch(expected: SessionIdentity): SessionOutcome<PublicSessionSnapshot> {
      try {
        const current = requireActive(expected);
        current.expiresAt = lastObserved + SESSION_IDLE_MS;
        return { ok: true, value: publish({ expiresAt: current.expiresAt }) };
      } catch (error) {
        return caught(error);
      }
    },
    async execute(
      expected: SessionIdentity,
      command: AuthOperationCommand,
      options?: SessionRequestOptions,
    ): Promise<SessionResult<unknown>> {
      let admitted: SessionIdentity | undefined;
      let signal: AbortSignal | undefined;
      // Past admission only microtasks run before the fetch, so dispatched means sent.
      let unknown: "unknown" | undefined;
      try {
        const current = requireActive(expected);
        admitted = current.identity;
        signal = options?.signal
          ? AbortSignal.any([current.controller.signal, options.signal])
          : current.controller.signal;
        if (signal.aborted) return failure("cancelled");
        unknown = modifiesServer(command.operation) ? "unknown" : undefined;
        const result = await deps.execute(command, {
          signal,
          requireCurrent() {
            const credential = requireActive(current.identity).credential;
            if (signal?.aborted) throw new SessionFault("cancelled");
            return { baseUrl: credential.profile.baseUrl, apiKey: credential.apiKey };
          },
        });
        requireActive(current.identity);
        if (signal.aborted) return failure("cancelled", unknown);
        return result;
      } catch (error) {
        if (admitted) {
          try {
            requireActive(admitted);
          } catch (invalidated) {
            return caught(invalidated, unknown);
          }
          if (signal?.aborted) return failure("cancelled", unknown);
        }
        return caught(error, unknown);
      }
    },
    lock(expected: SessionIdentity | null): SessionOutcome<PublicSessionSnapshot> {
      try {
        observeTime();
        if (!sameIdentity(expected, active?.identity ?? null)) return failure("stale");
        invalidate("user");
        return { ok: true, value: snapshot };
      } catch (error) {
        return caught(error);
      }
    },
  };
}

export type AuthSession = ReturnType<typeof createAuthSession>;
