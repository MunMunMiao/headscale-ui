import {
  type AnyStruct,
  type HttpCommand,
  type Infer,
  type RequestSuccessData,
  struct,
} from "@defjs/core";
import type { rpcStatus } from "@/api/contracts";
import * as endpoints from "@/api/requests";
import type { VaultVersion } from "@/lib/profile-storage";
import type { ProfileActions } from "./profile-actions";
import type { SessionRuntime } from "./runtime";
import {
  MAX_PORT_REQUESTS,
  SESSION_PROTOCOL_VERSION,
  type SessionResult,
  sessionIdentity,
  vaultVersion,
  type WorkerErrorDto,
  type WorkerMessage,
} from "./types";

type Endpoints = typeof endpoints;
/** An export of src/api/requests.ts; the Worker runs that endpoint with its own client. */
export type EndpointName = keyof Endpoints;
export type ApiCommand<K extends EndpointName = EndpointName> = {
  [N in K]: Parameters<Endpoints[N]> extends []
    ? { readonly endpoint: N }
    : { readonly endpoint: N; readonly input: Parameters<Endpoints[N]>[0] };
}[K];
export type ApiOutput<K extends EndpointName> =
  ReturnType<Endpoints[K]> extends HttpCommand<infer _Input, infer Output, infer _Error>
    ? RequestSuccessData<Output>
    : never;

/**
 * A request as the Worker runs it. The page declares which kind it publishes, as tRPC's query and
 * mutate do: a lost `api.write` may have been applied, a lost `api.read` was not.
 */
export type ApiRequest<K extends EndpointName = EndpointName> = ApiCommand<K> & {
  readonly type: "api.read" | "api.write";
};

type AnyEndpoint = (
  input?: unknown,
) => HttpCommand<AnyStruct | undefined, AnyStruct | undefined, typeof rpcStatus>;

/** The endpoint a request names, or undefined for anything requests.ts does not export. */
export function endpointOf(name: unknown) {
  return typeof name === "string" && Object.hasOwn(endpoints, name)
    ? // biome-ignore lint/performance/noDynamicNamespaceImportAccess: the Worker serves every endpoint, so none can be shaken.
      (endpoints[name as EndpointName] as AnyEndpoint)
    : undefined;
}

const ENDPOINTS = Object.keys(endpoints) as [EndpointName, ...EndpointName[]];
/** Only these may be published as reads, so a write can never pass for one (like Connect's GET check). */
const GET_ENDPOINTS = ENDPOINTS.filter(
  (name) => (endpointOf(name) as AnyEndpoint)().definition.method === "GET",
) as [EndpointName, ...EndpointName[]];

export type SessionMessagePort = Pick<
  MessagePort,
  "postMessage" | "start" | "close" | "addEventListener" | "removeEventListener"
>;

const profileWriteExpected = struct.object({
  version: vaultVersion,
  ownerTabId: struct.string(),
  profile: struct.object({ id: struct.string(), credentialVersion: struct.string().null() }).null(),
});
const scope = struct.enum(["session", "persistent"]);

const unlockInput = struct.object({
  profileId: struct.string(),
  password: struct.string(),
  expectedWorkerId: struct.string(),
  expectedCredentialVersion: struct.string(),
  expectedIdentity: sessionIdentity.null(),
});
export type PageUnlockInput = Infer<typeof unlockInput>;

export const profileSaveInput = struct.discriminatedUnion("kind", [
  struct.object({
    kind: struct.literal("metadata"),
    expected: profileWriteExpected,
    name: struct.string(),
    scope,
  }),
  struct.object({
    kind: struct.literal("credentials"),
    expected: profileWriteExpected,
    profile: struct.object({
      id: struct.string(),
      name: struct.string(),
      baseUrl: struct.string(),
      scope,
    }),
    apiKey: struct.string(),
    password: struct.string(),
    validation: struct.enum(["required", "skip"]),
    activate: struct.boolean(),
    expectedWorkerId: struct.string(),
    expectedIdentity: sessionIdentity.null(),
  }),
]);

/** One page → Worker business command; `api.read`/`api.write` name an export of src/api/requests.ts. */
export const sessionCommand = struct.discriminatedUnion("type", [
  struct.object({ type: struct.literal("session.snapshot") }),
  struct.object({
    type: struct.literal("session.unlock"),
    input: unlockInput,
  }),
  struct.object({ type: struct.literal("session.touch"), expected: sessionIdentity }),
  struct.object({ type: struct.literal("session.lock"), expected: sessionIdentity.null() }),
  struct.object({
    type: struct.literal("api.read"),
    expected: sessionIdentity,
    endpoint: struct.enum(GET_ENDPOINTS),
    // The endpoint's own input struct checks this when the Worker client executes it.
    input: struct.unknown().optional(),
  }),
  struct.object({
    type: struct.literal("api.write"),
    expected: sessionIdentity,
    endpoint: struct.enum(ENDPOINTS),
    input: struct.unknown().optional(),
  }),
  struct.object({ type: struct.literal("profiles.list") }),
  struct.object({
    type: struct.literal("profiles.save"),
    input: profileSaveInput,
  }),
  struct.object({
    type: struct.literal("profiles.migrate"),
    input: struct.object({
      expected: profileWriteExpected,
      password: struct.string(),
      legacyPassword: struct.string().optional(),
    }),
  }),
  struct.object({
    type: struct.literal("profiles.change-password"),
    input: struct.object({
      expected: profileWriteExpected,
      password: struct.string(),
      newPassword: struct.string(),
    }),
  }),
  struct.object({ type: struct.literal("profiles.delete"), expected: profileWriteExpected }),
  struct.object({ type: struct.literal("storage.reset"), expected: vaultVersion.null() }),
]);
export type SessionCommand = Infer<typeof sessionCommand>;

/** Page → Worker envelope. A request's command is parsed on its own so a bad one is answered, not fatal. */
const pageMessage = struct.discriminatedUnion("type", [
  struct.object({
    type: struct.literal("hello"),
    ownerTabId: struct.string(),
    buildId: struct.string(),
    protocolVersion: struct.number(),
    storageVersion: struct.number(),
  }),
  struct.object({
    type: struct.literal("request"),
    requestId: struct.number(),
    command: struct.unknown().nullish(),
  }),
  struct.object({ type: struct.literal("cancel"), requestId: struct.number() }),
  struct.object({ type: struct.literal("disconnect") }),
]);

export interface SessionProtocolDependencies {
  runtime: SessionRuntime;
  profiles: ProfileActions;
  workerId: string;
  buildId: string;
  storageVersion: number;
}

// Struct checks shape only; ordering needs a positive safe integer.
const requestId = (value: number) => Number.isSafeInteger(value) && value > 0;

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
        if (closed) return;
        const [invalid, message] = struct.parse(pageMessage, (event as MessageEvent).data);
        if (invalid) return reject({ kind: "invalid-request" });
        if (ownerTabId === null) {
          if (message.type !== "hello" || !message.ownerTabId)
            return reject({ kind: "invalid-request" });
          if (
            message.protocolVersion !== SESSION_PROTOCOL_VERSION ||
            message.storageVersion !== deps.storageVersion
          )
            return reject({ kind: "reload-required" });
          ownerTabId = message.ownerTabId;
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
        if (message.type === "disconnect") return connection.close();
        if (message.type === "hello" || !requestId(message.requestId))
          return reject({ kind: "invalid-request" });
        const id = message.requestId;
        if (message.type === "cancel") {
          highestId = Math.max(highestId, id);
          pending.delete(id);
          void deps.runtime.cancel(portId, String(id));
          return;
        }
        const reply = (result: SessionResult<unknown>) =>
          connection.send({
            type: "reply",
            requestId: id,
            result,
            snapshot: deps.runtime.auth.getSnapshot(),
          });
        const [malformed, command] = struct.parse(sessionCommand, message.command);
        if (id <= highestId || malformed) {
          highestId = Math.max(highestId, id);
          reply({ ok: false, error: { kind: "invalid-request" } });
          return;
        }
        highestId = id;
        const control = ["session.snapshot", "session.touch", "session.lock"].includes(
          command.type,
        );
        if (pending.size >= MAX_PORT_REQUESTS - (control ? 0 : 1))
          return reply({ ok: false, error: { kind: "busy" } });
        pending.add(id);
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
              case "api.read":
              case "api.write":
                // The endpoint is one requests.ts exports; its input struct runs inside client.execute.
                return deps.runtime.auth.execute(command.expected, command as ApiRequest, {
                  signal,
                });
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
