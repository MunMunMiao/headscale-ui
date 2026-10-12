import type { OperationCommand } from "@/api/commands";
import { modifiesServer } from "@/domain/headscale-operations";
import type {
  ChangeProfilePasswordInput,
  MigrateProfileInput,
  ProfileList,
  ProfileWriteExpected,
  StoredProfileCommit,
  VaultVersion,
} from "@/lib/profile-storage";
import type { AuthOperationCommand, SessionRequestOptions } from "./auth-session";
import type { ProfileResetOutcome, ProfileSaveInput, ProfileSaveOutcome } from "./profile-actions";
import type { PageUnlockInput } from "./protocol";
import {
  MAX_PORT_REQUESTS,
  SESSION_PROTOCOL_VERSION,
  type SessionCommand,
  type SessionMessagePort,
  validWorkerMessage,
} from "./protocol";
import type {
  PublicSessionSnapshot,
  SessionFailureKind,
  SessionIdentity,
  SessionResult,
} from "./types";

export interface SessionBridgeSnapshot {
  readonly status:
    | "connecting"
    | "ready-locked"
    | "ready-unlocked"
    | "unavailable"
    | "reload-required";
  readonly workerId: string | null;
  readonly buildId: string | null;
  readonly session: PublicSessionSnapshot | null;
}
export interface SessionBridgeOptions {
  openPort(): SessionMessagePort;
  ownerTabId(): string;
  buildId: string;
  storageVersion: number;
  now?: () => number;
  schedule?: (milliseconds: number, callback: () => void) => () => void;
}

export function createSessionBridge(options: SessionBridgeOptions) {
  let snapshot: SessionBridgeSnapshot = Object.freeze({
    status: "connecting",
    workerId: null,
    buildId: null,
    session: null,
  });
  const listeners = new Set<() => void>();
  interface Pending {
    resolve(value: SessionResult<unknown>): void;
    expected: SessionIdentity | null;
    modifies: boolean;
    sent: boolean;
    kind: SessionCommand["type"];
    cancelTimer(): void;
    clearAbort?: () => void;
    received?: SessionResult<unknown>;
  }
  const pending = new Map<number, Pending>();
  const now = options.now ?? Date.now;
  const schedule =
    options.schedule ??
    ((milliseconds: number, callback: () => void) => {
      const timer = setTimeout(callback, milliseconds);
      return () => clearTimeout(timer);
    });
  let suspended = false;
  let resumeGeneration = 0;
  let checking: Promise<SessionResult<PublicSessionSnapshot>> | null = null;
  const resetListeners = new Set<(version: VaultVersion) => void>();
  const profileListeners = new Set<() => void>();
  let deferredReset: VaultVersion | null = null;
  let disposed = false;
  let port: SessionMessagePort | null = null;
  let stopConnection: (() => void) | null = null;
  let nextId = 0;
  let hello: ReturnType<typeof Promise.withResolvers<SessionResult<PublicSessionSnapshot>>> | null =
    null;
  let cancelHello: (() => void) | null = null;
  function publish(next: SessionBridgeSnapshot) {
    if (
      next.status === snapshot.status &&
      next.workerId === snapshot.workerId &&
      next.buildId === snapshot.buildId &&
      next.session === snapshot.session
    )
      return;
    snapshot = Object.freeze(next);
    for (const listener of listeners) listener();
  }
  function update(session: PublicSessionSnapshot) {
    if (session.identity && session.identity.workerId !== snapshot.workerId) return;
    if (snapshot.session && session.revision <= snapshot.session.revision) return;
    publish({
      ...snapshot,
      status: session.status === "locked" ? "ready-locked" : "ready-unlocked",
      session: Object.freeze({
        status: session.status,
        identity:
          session.identity &&
          Object.freeze({
            workerId: session.identity.workerId,
            sessionId: session.identity.sessionId,
          }),
        profile:
          session.profile &&
          Object.freeze({
            id: session.profile.id,
            name: session.profile.name,
            baseUrl: session.profile.baseUrl,
          }),
        expiresAt: session.expiresAt,
        pendingProfileId: session.pendingProfileId,
        reason: session.reason,
        revision: session.revision,
        apiKeyPrefix: session.apiKeyPrefix,
      }),
    });
    flush();
  }
  function matches(expected: SessionIdentity) {
    return (
      snapshot.session?.identity?.workerId === expected.workerId &&
      snapshot.session.identity.sessionId === expected.sessionId
    );
  }
  // A held, unmarked api failure is a definite server or contract answer. Plain session
  // failures are not: the runtime answers an interrupted fiber with an unmarked "cancelled".
  const answered = (result?: SessionResult<unknown>) =>
    result !== undefined &&
    !result.ok &&
    result.error.kind === "api" &&
    result.error.outcome === undefined;
  /** The page gave up on a command: a sent write whose answer was not definite may have been applied. */
  function lost(entry: Pending, kind: SessionFailureKind): SessionResult<never> {
    const unknown = entry.modifies && entry.sent && !answered(entry.received);
    return { ok: false, error: { kind, ...(unknown ? { outcome: "unknown" as const } : {}) } };
  }
  function finish(id: number, entry: Pending, result: SessionResult<unknown>) {
    pending.delete(id);
    entry.cancelTimer();
    entry.clearAbort?.();
    entry.resolve(result);
    deliverReset();
  }
  function deliverReset() {
    if (!deferredReset || [...pending.values()].some((entry) => entry.kind === "storage.reset"))
      return;
    const version = deferredReset;
    deferredReset = null;
    for (const listener of resetListeners) listener(version);
  }
  function flush() {
    for (const [id, entry] of pending) {
      if (!entry.expected) continue;
      if (!matches(entry.expected)) {
        finish(
          id,
          entry,
          lost(entry, snapshot.session?.reason === "expired" ? "expired" : "stale"),
        );
        continue;
      }
      if (!entry.received || suspended) continue;
      // validWorkerMessage only admits an identity together with a finite expiry.
      if ((snapshot.session as PublicSessionSnapshot & { expiresAt: number }).expiresAt <= now()) {
        void check();
        continue;
      }
      finish(id, entry, entry.received);
    }
  }
  function check(): Promise<SessionResult<PublicSessionSnapshot>> {
    if (!checking)
      checking = request<PublicSessionSnapshot>({ type: "session.snapshot" }).then((result) => {
        checking = null;
        flush();
        return result;
      });
    return checking;
  }
  function request<T>(
    command: SessionCommand,
    requestOptions?: SessionRequestOptions,
  ): Promise<SessionResult<T>> {
    if (!port || !snapshot.workerId)
      return Promise.resolve({ ok: false, error: { kind: "unavailable" } });
    if (requestOptions?.signal?.aborted)
      return Promise.resolve({ ok: false, error: { kind: "cancelled" } });
    const control = ["session.snapshot", "session.touch", "session.lock"].includes(command.type);
    if (pending.size >= MAX_PORT_REQUESTS - (control ? 0 : 1))
      return Promise.resolve({ ok: false, error: { kind: "busy" } });
    const id = ++nextId;
    return new Promise((resolve) => {
      const milliseconds =
        command.type === "api.execute"
          ? 20_000
          : ["session.snapshot", "session.touch", "session.lock"].includes(command.type)
            ? 5_000
            : 30_000;
      const modifies =
        command.type === "api.execute"
          ? modifiesServer(command.command.operation)
          : command.type === "storage.reset" ||
            (command.type.startsWith("profiles.") && command.type !== "profiles.list");
      const entry: Pending = {
        resolve: (result) => resolve(result as SessionResult<T>),
        expected: command.type === "api.execute" ? command.expected : null,
        modifies,
        sent: false,
        kind: command.type,
        cancelTimer: schedule(milliseconds, unavailable),
      };
      pending.set(id, entry);
      if (requestOptions?.signal) {
        const signal = requestOptions.signal;
        const cancel = () => {
          finish(id, entry, lost(entry, "cancelled"));
          post({ type: "cancel", requestId: id });
        };
        signal.addEventListener("abort", cancel, { once: true });
        entry.clearAbort = () => signal.removeEventListener("abort", cancel);
      }
      entry.sent = post({ type: "request", requestId: id, command });
    });
  }
  function disconnect() {
    cancelHello?.();
    cancelHello = null;
    stopConnection?.();
    stopConnection = null;
    port = null;
    hello?.resolve({ ok: false, error: { kind: "unavailable" } });
    hello = null;
    for (const entry of pending.values()) {
      entry.cancelTimer();
      entry.clearAbort?.();
      entry.resolve(lost(entry, "unavailable"));
    }
    pending.clear();
    deliverReset();
  }
  function unavailable() {
    disconnect();
    publish({ status: "unavailable", session: null, workerId: null, buildId: null });
  }
  function post(message: unknown): boolean {
    try {
      port?.postMessage(message);
      return true;
    } catch {
      unavailable();
      return false;
    }
  }
  const bridge = {
    getSnapshot: () => snapshot,
    getSessionSnapshot: () => snapshot.session,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeReset(listener: (version: VaultVersion) => void) {
      resetListeners.add(listener);
      return () => {
        resetListeners.delete(listener);
      };
    },
    subscribeProfiles(listener: () => void) {
      profileListeners.add(listener);
      return () => {
        profileListeners.delete(listener);
      };
    },
    connect(): Promise<SessionResult<PublicSessionSnapshot>> {
      if (disposed) return Promise.resolve({ ok: false, error: { kind: "unavailable" } });
      if (hello) return hello.promise;
      if (port && snapshot.session) return Promise.resolve({ ok: true, value: snapshot.session });
      hello = Promise.withResolvers<SessionResult<PublicSessionSnapshot>>();
      const result = hello.promise;
      cancelHello = schedule(10_000, unavailable);
      let current: SessionMessagePort;
      try {
        current = options.openPort();
      } catch {
        unavailable();
        return result;
      }
      port = current;
      nextId = 0;
      function receive(event: Event) {
        if (port !== current) return;
        const message: unknown = (event as MessageEvent).data;
        if (!validWorkerMessage(message)) return unavailable();
        if (message.type === "hello") {
          if (
            !hello ||
            (message.snapshot.identity && message.snapshot.identity.workerId !== message.workerId)
          )
            return unavailable();
          if (
            message.protocolVersion !== SESSION_PROTOCOL_VERSION ||
            message.storageVersion !== options.storageVersion ||
            message.buildId !== options.buildId
          ) {
            hello?.resolve({ ok: false, error: { kind: "reload-required" } });
            hello = null;
            disconnect();
            publish({ status: "reload-required", session: null, workerId: null, buildId: null });
            return;
          }
          cancelHello?.();
          cancelHello = null;
          snapshot = Object.freeze({
            ...snapshot,
            workerId: message.workerId,
            buildId: message.buildId,
          });
          update(message.snapshot);
          hello?.resolve({ ok: true, value: snapshot.session as PublicSessionSnapshot });
          hello = null;
        } else if (message.type === "snapshot") update(message.snapshot);
        else if (message.type === "reply") {
          update(message.snapshot);
          const entry = pending.get(message.requestId);
          if (entry) {
            entry.cancelTimer();
            if (entry.expected) {
              entry.received = message.result;
              flush();
            } else finish(message.requestId, entry, message.result);
          }
        } else if (message.type === "error") {
          hello?.resolve({ ok: false, error: message.error });
          hello = null;
          disconnect();
          publish({
            status: message.error.kind === "reload-required" ? "reload-required" : "unavailable",
            session: null,
            workerId: null,
            buildId: null,
          });
        } else if (message.type === "reset") {
          deferredReset = message.version;
          deliverReset();
        } else {
          // validWorkerMessage admits only these six types, so this is profiles-changed.
          for (const listener of profileListeners) listener();
        }
      }
      current.addEventListener("message", receive);
      current.addEventListener("messageerror", unavailable);
      current.start();
      stopConnection = () => {
        current.removeEventListener("message", receive);
        current.removeEventListener("messageerror", unavailable);
        try {
          current.postMessage({ type: "disconnect" });
        } catch {}
        current.close();
      };
      try {
        post({
          type: "hello",
          protocolVersion: SESSION_PROTOCOL_VERSION,
          storageVersion: options.storageVersion,
          buildId: options.buildId,
          ownerTabId: options.ownerTabId(),
        });
      } catch {
        unavailable();
      }
      return result;
    },
    reconnect(): Promise<SessionResult<PublicSessionSnapshot>> {
      disconnect();
      publish({ status: "connecting", session: null, workerId: null, buildId: null });
      return bridge.connect();
    },
    check,
    unlock: (input: PageUnlockInput, options?: SessionRequestOptions) =>
      request<PublicSessionSnapshot>({ type: "session.unlock", input }, options),
    touch: (expected: SessionIdentity) =>
      request<PublicSessionSnapshot>({ type: "session.touch", expected }),
    lock: (expected: SessionIdentity | null) =>
      request<PublicSessionSnapshot>({ type: "session.lock", expected }),
    execute: (
      expected: SessionIdentity,
      command: AuthOperationCommand,
      options?: SessionRequestOptions,
    ): Promise<SessionResult<unknown>> =>
      matches(expected)
        ? request<unknown>(
            { type: "api.execute", expected, command: command as OperationCommand },
            options,
          )
        : Promise.resolve({ ok: false, error: { kind: "stale" } }),
    listProfiles: () => request<ProfileList>({ type: "profiles.list" }),
    saveProfile: (input: ProfileSaveInput, options?: SessionRequestOptions) =>
      request<ProfileSaveOutcome>({ type: "profiles.save", input }, options),
    migrateProfile: (input: MigrateProfileInput, options?: SessionRequestOptions) =>
      request<StoredProfileCommit>({ type: "profiles.migrate", input }, options),
    changeProfilePassword: (input: ChangeProfilePasswordInput, options?: SessionRequestOptions) =>
      request<StoredProfileCommit>({ type: "profiles.change-password", input }, options),
    deleteProfile: (expected: ProfileWriteExpected, options?: SessionRequestOptions) =>
      request<{ version: VaultVersion }>({ type: "profiles.delete", expected }, options),
    resetStorage: (expected: VaultVersion | null, options?: SessionRequestOptions) =>
      request<ProfileResetOutcome>({ type: "storage.reset", expected }, options),
    suspend() {
      suspended = true;
      ++resumeGeneration;
    },
    async resume() {
      const generation = ++resumeGeneration;
      suspended = true;
      const result = await check();
      if (generation === resumeGeneration && result.ok) {
        suspended = false;
        flush();
      }
      return result;
    },
    dispose() {
      disposed = true;
      disconnect();
      listeners.clear();
      resetListeners.clear();
      profileListeners.clear();
    },
  };
  return bridge;
}

export type SessionBridge = ReturnType<typeof createSessionBridge>;
