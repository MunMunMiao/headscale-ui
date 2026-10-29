import { struct } from "@defjs/core";
import type {
  ChangeProfilePasswordInput,
  MigrateProfileInput,
  ProfileList,
  ProfileWriteExpected,
  StoredProfileCommit,
  VaultVersion,
} from "@/lib/profile-storage";
import type { SessionRequestOptions } from "./auth-session";
import type {
  ProfileResetOutcome,
  ProfileSaveInput,
  ProfileSaveOutcome,
} from "./profile-actions";
// Types only: protocol.ts loads requests.ts, and with it defjs's HTTP pipeline, which the page must not ship.
import type {
  ApiCommand,
  ApiOutput,
  EndpointName,
  PageUnlockInput,
  SessionCommand,
  SessionMessagePort,
} from "./protocol";
import {
  MAX_PORT_REQUESTS,
  type PublicSessionSnapshot,
  SESSION_PROTOCOL_VERSION,
  type SessionFailureKind,
  type SessionIdentity,
  type SessionResult,
  workerMessage,
} from "./types";

/** The fields every build's hello carries, read before anything else a Worker of another build sends. */
const helloStamp = struct.object({
  type: struct.literal("hello"),
  buildId: struct.string(),
  protocolVersion: struct.number(),
  storageVersion: struct.number(),
});

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
  let hello: ReturnType<
    typeof Promise.withResolvers<SessionResult<PublicSessionSnapshot>>
  > | null = null;
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
  /** Everything subscribers render; a renewal changes only the expiry and revision. */
  const visible = ({
    expiresAt: _expiry,
    revision: _revision,
    ...rest
  }: PublicSessionSnapshot) => JSON.stringify(rest);
  function update(session: PublicSessionSnapshot) {
    if (session.identity && session.identity.workerId !== snapshot.workerId)
      return;
    if (snapshot.session && session.revision <= snapshot.session.revision)
      return;
    // struct.parse built these objects for this message alone, so they can be frozen in place.
    if (session.identity) Object.freeze(session.identity);
    if (session.profile) Object.freeze(session.profile);
    const next: SessionBridgeSnapshot = {
      ...snapshot,
      status: session.status === "locked" ? "ready-locked" : "ready-unlocked",
      session: Object.freeze(session),
    };
    // Activity renews the session about once a second; reads see the new expiry without re-rendering every page.
    if (snapshot.session && visible(snapshot.session) === visible(session))
      snapshot = Object.freeze(next);
    else publish(next);
    flush();
  }
  function matches(expected: SessionIdentity) {
    return (
      snapshot.session?.identity?.workerId === expected.workerId &&
      snapshot.session.identity.sessionId === expected.sessionId
    );
  }
  /** Retain received write failures as evidence, never an old success value or read result. */
  function lost(
    entry: Pending,
    kind: SessionFailureKind,
  ): SessionResult<never> {
    if (
      entry.kind === "api.write" &&
      entry.received?.ok === false &&
      entry.received.error.kind === "api"
    )
      return entry.received;
    // A plain runtime failure (including an interrupted fiber's "cancelled") proves no outcome.
    const unknown = entry.modifies && entry.sent;
    return {
      ok: false,
      error: { kind, ...(unknown ? { outcome: "unknown" as const } : {}) },
    };
  }
  function finish(id: number, entry: Pending, result: SessionResult<unknown>) {
    pending.delete(id);
    entry.cancelTimer();
    entry.clearAbort?.();
    entry.resolve(result);
    deliverReset();
  }
  function deliverReset() {
    if (
      !deferredReset ||
      [...pending.values()].some((entry) => entry.kind === "storage.reset")
    )
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
          lost(
            entry,
            snapshot.session?.reason === "expired" ? "expired" : "stale",
          ),
        );
        continue;
      }
      if (!entry.received || suspended) continue;
      // The unlocked snapshot struct requires an identity together with an expiry.
      if (
        (snapshot.session as PublicSessionSnapshot & { expiresAt: number })
          .expiresAt <= now()
      ) {
        void check();
        continue;
      }
      finish(id, entry, entry.received);
    }
  }
  function check(): Promise<SessionResult<PublicSessionSnapshot>> {
    if (!checking)
      checking = request<PublicSessionSnapshot>({
        type: "session.snapshot",
      }).then((result) => {
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
    const control = [
      "session.snapshot",
      "session.touch",
      "session.lock",
    ].includes(command.type);
    if (pending.size >= MAX_PORT_REQUESTS - (control ? 0 : 1))
      return Promise.resolve({ ok: false, error: { kind: "busy" } });
    const id = ++nextId;
    return new Promise((resolve) => {
      const headscale =
        command.type === "api.read" || command.type === "api.write";
      const milliseconds = headscale
        ? 20_000
        : ["session.snapshot", "session.touch", "session.lock"].includes(
              command.type,
            )
          ? 5_000
          : 30_000;
      // The command type says whether a request the page loses may have been applied.
      const modifies =
        command.type === "api.write" ||
        command.type === "storage.reset" ||
        (command.type.startsWith("profiles.") &&
          command.type !== "profiles.list");
      const entry: Pending = {
        resolve: (result) => resolve(result as SessionResult<T>),
        expected: headscale ? command.expected : null,
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
  /** Sends one Headscale request, run by the Worker under the session `expected` names. */
  function api(type: "api.read" | "api.write") {
    return <K extends EndpointName>(
      expected: SessionIdentity,
      command: ApiCommand<K>,
      options?: SessionRequestOptions,
    ): Promise<SessionResult<ApiOutput<K>>> =>
      matches(expected)
        ? // The Worker decodes with this build's contracts and the handshake refused any other build.
          request<ApiOutput<K>>(
            { ...(command as ApiCommand), type, expected },
            options,
          )
        : Promise.resolve({ ok: false, error: { kind: "stale" } });
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
    publish({
      status: "unavailable",
      session: null,
      workerId: null,
      buildId: null,
    });
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
      if (disposed)
        return Promise.resolve({ ok: false, error: { kind: "unavailable" } });
      if (hello) return hello.promise;
      if (port && snapshot.session)
        return Promise.resolve({ ok: true, value: snapshot.session });
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
        const data: unknown = (event as MessageEvent).data;
        // Another build may shape the rest of its messages differently: compare the build first.
        const [, stamp] = struct.parse(helloStamp, data);
        if (
          hello &&
          stamp &&
          (stamp.protocolVersion !== SESSION_PROTOCOL_VERSION ||
            stamp.storageVersion !== options.storageVersion ||
            stamp.buildId !== options.buildId)
        ) {
          hello.resolve({ ok: false, error: { kind: "reload-required" } });
          hello = null;
          disconnect();
          publish({
            status: "reload-required",
            session: null,
            workerId: null,
            buildId: null,
          });
          return;
        }
        const [invalid, message] = struct.parse(workerMessage, data);
        if (invalid) return unavailable();
        if (message.type === "hello") {
          if (
            !hello ||
            (message.snapshot.identity &&
              message.snapshot.identity.workerId !== message.workerId)
          )
            return unavailable();
          cancelHello?.();
          cancelHello = null;
          snapshot = Object.freeze({
            ...snapshot,
            workerId: message.workerId,
            buildId: message.buildId,
          });
          update(message.snapshot);
          hello?.resolve({
            ok: true,
            value: snapshot.session as PublicSessionSnapshot,
          });
          hello = null;
        } else if (message.type === "snapshot") update(message.snapshot);
        else if (message.type === "reply") {
          // Record evidence before the accompanying snapshot can retire this request in flush().
          // A request without output (deleteUser) answers with no value, which reads as undefined.
          const result = message.result as SessionResult<unknown>;
          const waiting = pending.get(message.requestId);
          if (waiting) waiting.received = result;
          update(message.snapshot);
          const entry = pending.get(message.requestId);
          if (entry) {
            entry.cancelTimer();
            if (entry.expected) flush();
            else finish(message.requestId, entry, result);
          }
        } else if (message.type === "error") {
          hello?.resolve({ ok: false, error: message.error });
          hello = null;
          disconnect();
          publish({
            status:
              message.error.kind === "reload-required"
                ? "reload-required"
                : "unavailable",
            session: null,
            workerId: null,
            buildId: null,
          });
        } else if (message.type === "reset") {
          deferredReset = message.version;
          deliverReset();
        } else {
          // workerMessage admits only these six types, so this is profiles-changed.
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
      publish({
        status: "connecting",
        session: null,
        workerId: null,
        buildId: null,
      });
      return bridge.connect();
    },
    check,
    unlock: (input: PageUnlockInput, options?: SessionRequestOptions) =>
      request<PublicSessionSnapshot>(
        { type: "session.unlock", input },
        options,
      ),
    touch: (expected: SessionIdentity) =>
      request<PublicSessionSnapshot>({ type: "session.touch", expected }),
    lock: (expected: SessionIdentity | null) =>
      request<PublicSessionSnapshot>({ type: "session.lock", expected }),
    /** Publish a request that leaves the server untouched; the Worker accepts only GET endpoints. */
    read: api("api.read"),
    /** Publish a request that may change the server: if its answer is lost, its outcome is unknown. */
    write: api("api.write"),
    listProfiles: () => request<ProfileList>({ type: "profiles.list" }),
    saveProfile: (input: ProfileSaveInput, options?: SessionRequestOptions) =>
      request<ProfileSaveOutcome>({ type: "profiles.save", input }, options),
    migrateProfile: (
      input: MigrateProfileInput,
      options?: SessionRequestOptions,
    ) =>
      request<StoredProfileCommit>(
        { type: "profiles.migrate", input },
        options,
      ),
    changeProfilePassword: (
      input: ChangeProfilePasswordInput,
      options?: SessionRequestOptions,
    ) =>
      request<StoredProfileCommit>(
        { type: "profiles.change-password", input },
        options,
      ),
    deleteProfile: (
      expected: ProfileWriteExpected,
      options?: SessionRequestOptions,
    ) =>
      request<{ version: VaultVersion }>(
        { type: "profiles.delete", expected },
        options,
      ),
    resetStorage: (
      expected: VaultVersion | null,
      options?: SessionRequestOptions,
    ) =>
      request<ProfileResetOutcome>(
        { type: "storage.reset", expected },
        options,
      ),
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
