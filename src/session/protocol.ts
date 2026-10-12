import type { OperationCommand } from "@/api/commands";
import { OPERATION_IDS } from "@/domain/headscale-operations";
import type {
  ChangeProfilePasswordInput,
  MigrateProfileInput,
  ProfileWriteExpected,
  VaultVersion,
} from "@/lib/profile-storage";
import type { UnlockInput } from "./auth-session";
import type { ProfileActions, ProfileSaveInput } from "./profile-actions";
import type { SessionRuntime } from "./runtime";
import type {
  PublicSessionSnapshot,
  SessionIdentity,
  SessionResult,
  WorkerErrorDto,
} from "./types";

export const SESSION_PROTOCOL_VERSION = 1;
export const MAX_PORT_REQUESTS = 64;

export type SessionMessagePort = Pick<
  MessagePort,
  "postMessage" | "start" | "close" | "addEventListener" | "removeEventListener"
>;
export type PageUnlockInput = Omit<UnlockInput, "ownerTabId" | "portId" | "operationId">;
export type SessionCommand =
  | { type: "session.snapshot" }
  | { type: "session.unlock"; input: PageUnlockInput }
  | { type: "session.touch"; expected: SessionIdentity }
  | { type: "session.lock"; expected: SessionIdentity | null }
  | { type: "api.execute"; expected: SessionIdentity; command: OperationCommand }
  | { type: "profiles.list" }
  | { type: "profiles.save"; input: ProfileSaveInput }
  | { type: "profiles.migrate"; input: MigrateProfileInput }
  | { type: "profiles.change-password"; input: ChangeProfilePasswordInput }
  | { type: "profiles.delete"; expected: ProfileWriteExpected }
  | { type: "storage.reset"; expected: VaultVersion | null };

export type WorkerMessage =
  | {
      type: "hello";
      workerId: string;
      buildId: string;
      protocolVersion: number;
      storageVersion: number;
      snapshot: PublicSessionSnapshot;
    }
  | {
      type: "reply";
      requestId: number;
      result: SessionResult<unknown>;
      snapshot: PublicSessionSnapshot;
    }
  | { type: "snapshot"; snapshot: PublicSessionSnapshot }
  | { type: "reset"; version: VaultVersion }
  | { type: "profiles-changed" }
  | { type: "error"; error: WorkerErrorDto };

export interface SessionProtocolDependencies {
  runtime: SessionRuntime;
  profiles: ProfileActions;
  workerId: string;
  buildId: string;
  storageVersion: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requestId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function identity(value: unknown): value is SessionIdentity {
  return record(value) && typeof value.workerId === "string" && typeof value.sessionId === "string";
}
function version(value: unknown): value is VaultVersion {
  return (
    record(value) &&
    typeof value.keyEpoch === "string" &&
    Number.isSafeInteger(value.profilesRevision) &&
    (value.profilesRevision as number) >= 0
  );
}
function expectedProfile(value: unknown): value is ProfileWriteExpected {
  return (
    record(value) &&
    typeof value.ownerTabId === "string" &&
    version(value.version) &&
    (value.profile === null ||
      (record(value.profile) &&
        typeof value.profile.id === "string" &&
        (value.profile.credentialVersion === null ||
          typeof value.profile.credentialVersion === "string")))
  );
}
function scope(value: unknown) {
  return value === "session" || value === "persistent";
}
function validSnapshot(value: unknown): value is PublicSessionSnapshot {
  if (
    !record(value) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !(value.pendingProfileId === null || typeof value.pendingProfileId === "string") ||
    ![null, "initial", "user", "expired", "clock-reversed", "profile-changed"].includes(
      value.reason as never,
    )
  )
    return false;
  if (value.status === "locked")
    return (
      value.identity === null &&
      value.profile === null &&
      value.expiresAt === null &&
      value.apiKeyPrefix === null
    );
  return (
    value.status === "unlocked" &&
    (value.apiKeyPrefix === null || typeof value.apiKeyPrefix === "string") &&
    identity(value.identity) &&
    Number.isFinite(value.expiresAt) &&
    record(value.profile) &&
    typeof value.profile.id === "string" &&
    typeof value.profile.name === "string" &&
    typeof value.profile.baseUrl === "string"
  );
}
function validError(value: unknown): value is WorkerErrorDto {
  if (!record(value)) return false;
  const outcomeOk = value.outcome === undefined || value.outcome === "unknown";
  if (value.kind === "api")
    return (
      typeof value.code === "string" &&
      typeof value.message === "string" &&
      (value.status === undefined || Number.isFinite(value.status)) &&
      outcomeOk
    );
  return (
    [
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
    ].includes(value.kind as string) && outcomeOk
  );
}
export function validWorkerMessage(value: unknown): value is WorkerMessage {
  if (!record(value)) return false;
  switch (value.type) {
    case "hello":
      return (
        typeof value.workerId === "string" &&
        typeof value.buildId === "string" &&
        Number.isInteger(value.protocolVersion) &&
        Number.isInteger(value.storageVersion) &&
        validSnapshot(value.snapshot)
      );
    case "reply":
      return (
        requestId(value.requestId) &&
        validSnapshot(value.snapshot) &&
        record(value.result) &&
        (value.result.ok === true || (value.result.ok === false && validError(value.result.error)))
      );
    case "snapshot":
      return validSnapshot(value.snapshot);
    case "reset":
      return version(value.version);
    case "profiles-changed":
      return true;
    case "error":
      return validError(value.error);
    default:
      return false;
  }
}
function validCommand(value: unknown): value is SessionCommand {
  if (!record(value)) return false;
  const input = value.input;
  switch (value.type) {
    case "session.snapshot":
    case "profiles.list":
      return true;
    case "session.lock":
      return value.expected === null || identity(value.expected);
    case "session.touch":
      return identity(value.expected);
    case "api.execute":
      return (
        identity(value.expected) &&
        record(value.command) &&
        OPERATION_IDS.some((id) => id === (value.command as Record<string, unknown>).operation)
      );
    case "session.unlock":
      return (
        record(input) &&
        typeof input.profileId === "string" &&
        typeof input.password === "string" &&
        typeof input.expectedWorkerId === "string" &&
        typeof input.expectedCredentialVersion === "string" &&
        (input.expectedIdentity === null || identity(input.expectedIdentity))
      );
    case "profiles.delete":
      return expectedProfile(value.expected);
    case "storage.reset":
      return value.expected === null || version(value.expected);
    case "profiles.migrate":
      return (
        record(input) &&
        expectedProfile(input.expected) &&
        typeof input.password === "string" &&
        (input.legacyPassword === undefined || typeof input.legacyPassword === "string")
      );
    case "profiles.change-password":
      return (
        record(input) &&
        expectedProfile(input.expected) &&
        typeof input.password === "string" &&
        typeof input.newPassword === "string"
      );
    case "profiles.save": {
      if (!record(input) || !expectedProfile(input.expected)) return false;
      if (input.kind === "metadata") return typeof input.name === "string" && scope(input.scope);
      return (
        input.kind === "credentials" &&
        record(input.profile) &&
        typeof input.profile.id === "string" &&
        typeof input.profile.name === "string" &&
        typeof input.profile.baseUrl === "string" &&
        scope(input.profile.scope) &&
        typeof input.apiKey === "string" &&
        typeof input.password === "string" &&
        (input.validation === "required" || input.validation === "skip") &&
        typeof input.activate === "boolean" &&
        typeof input.expectedWorkerId === "string" &&
        (input.expectedIdentity === null || identity(input.expectedIdentity))
      );
    }
    default:
      return false;
  }
}

export function createSessionProtocol(deps: SessionProtocolDependencies) {
  const connections = new Set<{ send(message: WorkerMessage): void; close(): void }>();
  let disposed = false;
  const stop = deps.runtime.auth.subscribe(() => {
    for (const connection of connections)
      connection.send({ type: "snapshot", snapshot: deps.runtime.auth.getSnapshot() });
  });
  return {
    connect(port: SessionMessagePort) {
      const portId = crypto.randomUUID();
      let ownerTabId: string | null = null;
      let highestId = 0;
      let closed = disposed;
      let ready = false;
      const pending = new Set<number>();
      const connection = {
        send(message: WorkerMessage) {
          if (closed || (!ready && message.type !== "hello" && message.type !== "error")) return;
          try {
            port.postMessage(message);
          } catch {
            connection.close();
          }
        },
        close() {
          if (closed) return;
          closed = true;
          connections.delete(connection);
          pending.clear();
          port.removeEventListener("message", receive);
          port.removeEventListener("messageerror", connection.close);
          port.close();
          void deps.runtime.detachPort(portId);
        },
      };
      function reject(error: WorkerErrorDto) {
        connection.send({ type: "error", error });
        connection.close();
      }
      function receive(event: Event) {
        const data: unknown = (event as MessageEvent).data;
        if (closed) return;
        if (!record(data)) return reject({ kind: "invalid-request" });
        if (ownerTabId === null) {
          if (
            data.type !== "hello" ||
            typeof data.ownerTabId !== "string" ||
            !data.ownerTabId ||
            typeof data.buildId !== "string"
          )
            return reject({ kind: "invalid-request" });
          if (
            data.protocolVersion !== SESSION_PROTOCOL_VERSION ||
            data.storageVersion !== deps.storageVersion
          )
            return reject({ kind: "reload-required" });
          ownerTabId = data.ownerTabId;
          if (!deps.runtime.attachPort(portId)) return reject({ kind: "unavailable" });
          deps.runtime.auth.check();
          ready = true;
          connection.send({
            type: "hello",
            workerId: deps.workerId,
            buildId: deps.buildId,
            protocolVersion: SESSION_PROTOCOL_VERSION,
            storageVersion: deps.storageVersion,
            snapshot: deps.runtime.auth.getSnapshot(),
          });
          return;
        }
        if (data.type === "disconnect") return connection.close();
        if (data.type === "cancel" && requestId(data.requestId)) {
          highestId = Math.max(highestId, data.requestId);
          pending.delete(data.requestId);
          void deps.runtime.cancel(portId, String(data.requestId));
          return;
        }
        if (data.type !== "request" || !requestId(data.requestId))
          return reject({ kind: "invalid-request" });
        const id = data.requestId;
        const reply = (result: SessionResult<unknown>) =>
          connection.send({
            type: "reply",
            requestId: id,
            result,
            snapshot: deps.runtime.auth.getSnapshot(),
          });
        if (id <= highestId || !validCommand(data.command)) {
          highestId = Math.max(highestId, id);
          reply({ ok: false, error: { kind: "invalid-request" } });
          return;
        }
        highestId = id;
        const control = ["session.snapshot", "session.touch", "session.lock"].includes(
          data.command.type,
        );
        if (pending.size >= MAX_PORT_REQUESTS - (control ? 0 : 1))
          return reply({ ok: false, error: { kind: "busy" } });
        pending.add(id);
        const command = data.command;
        const owner = ownerTabId;
        void deps.runtime
          .runOperation(portId, String(id), async (signal) => {
            const context = { ownerTabId: owner, portId, requestId: String(id), signal };
            switch (command.type) {
              case "session.snapshot":
                deps.runtime.auth.check();
                return { ok: true, value: deps.runtime.auth.getSnapshot() };
              case "session.unlock":
                return deps.runtime.auth.unlock(
                  { ...command.input, ownerTabId: owner, portId, operationId: String(id) },
                  { signal },
                );
              case "session.touch":
                return deps.runtime.auth.touch(command.expected);
              case "session.lock": {
                const result = deps.runtime.auth.lock(command.expected);
                if (result.ok) await deps.runtime.cancelPending(context);
                return result;
              }
              case "api.execute":
                return deps.runtime.auth.execute(command.expected, command.command, { signal });
              case "profiles.list":
                return deps.profiles.list(context);
              case "profiles.save":
                return deps.profiles.save(command.input, context);
              case "profiles.migrate":
                return deps.profiles.migrate(command.input, context);
              case "profiles.change-password":
                return deps.profiles.changePassword(command.input, context);
              case "profiles.delete":
                return deps.profiles.delete(command.expected, context);
              case "storage.reset":
                return deps.profiles.reset(command.expected, context);
            }
          })
          .then((result) => {
            if (!pending.delete(id) || closed) return;
            reply(result);
          });
      }
      if (disposed) {
        port.close();
        return () => {};
      }
      connections.add(connection);
      port.addEventListener("message", receive);
      port.addEventListener("messageerror", connection.close);
      port.start();
      return connection.close;
    },
    notifyProfiles() {
      for (const connection of connections) connection.send({ type: "profiles-changed" });
    },
    notifyReset(version: VaultVersion) {
      for (const connection of connections) connection.send({ type: "reset", version });
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      stop();
      for (const connection of connections) connection.close();
    },
  };
}
