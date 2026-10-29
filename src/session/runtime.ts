import { Cause, Effect, Exit, Fiber, Result, Scope } from "effect";
import {
  type AuthSessionDependencies,
  createAuthSession,
  SessionFault,
} from "./auth-session";
import type { SessionIdentity, SessionResult, WorkerErrorDto } from "./types";

export interface SessionRuntimeDependencies {
  auth: AuthSessionDependencies;
  idleSleep?: (milliseconds: number) => Effect.Effect<void>;
}

export function createSessionRuntime(deps: SessionRuntimeDependencies) {
  const auth = createAuthSession(deps.auth);
  const scope = Effect.runSync(Scope.make());
  const ports = new Map<
    string,
    Map<string, Fiber.Fiber<unknown, WorkerErrorDto>>
  >();
  let expiryTask: Fiber.Fiber<void> | null = null;
  const sleep = deps.idleSleep ?? Effect.sleep;
  const expireAt = (
    identity: SessionIdentity,
    revision: number,
    expiresAt: number,
  ): Effect.Effect<void> =>
    sleep(Math.max(1, expiresAt - deps.auth.now())).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          auth.check(identity);
          // A timer that fires early leaves the snapshot untouched: wait for the remainder.
          return auth.getSnapshot().revision === revision
            ? expireAt(identity, revision, expiresAt)
            : Effect.void;
        }),
      ),
    );
  let disposed = false;
  const stopExpiry = auth.subscribe(() => {
    if (expiryTask) Effect.runFork(Fiber.interrupt(expiryTask));
    expiryTask = null;
    const snapshot = auth.getSnapshot();
    if (!snapshot.identity || snapshot.expiresAt === null) return;
    expiryTask = Fiber.runIn(
      Effect.runFork(
        expireAt(snapshot.identity, snapshot.revision, snapshot.expiresAt),
      ),
      scope,
    );
  });
  return {
    auth,
    attachPort(portId: string): boolean {
      if (disposed || ports.has(portId)) return false;
      ports.set(portId, new Map());
      return true;
    },
    async runOperation<T>(
      portId: string,
      requestId: string,
      run: (signal: AbortSignal) => Promise<SessionResult<T>>,
    ): Promise<SessionResult<T>> {
      const pending = ports.get(portId);
      if (disposed || !pending)
        return { ok: false, error: { kind: "unavailable" } };
      if (pending.has(requestId))
        return { ok: false, error: { kind: "invalid-request" } };
      if (pending.size >= 64) return { ok: false, error: { kind: "busy" } };
      const task = Effect.tryPromise({
        try: run,
        catch: (error): WorkerErrorDto => ({
          kind: error instanceof SessionFault ? error.kind : "unavailable",
        }),
      }).pipe(
        Effect.flatMap((result) =>
          result.ok ? Effect.succeed(result.value) : Effect.fail(result.error),
        ),
      );
      const fiber = Fiber.runIn(Effect.runFork(task), scope);
      pending.set(requestId, fiber);
      const exit = await Effect.runPromise(Fiber.await(fiber));
      pending.delete(requestId);
      if (Exit.isSuccess(exit)) return { ok: true, value: exit.value };
      const error = Cause.findError(exit.cause);
      return {
        ok: false,
        error: Result.isSuccess(error) ? error.success : { kind: "cancelled" },
      };
    },
    async cancel(portId: string, requestId: string): Promise<void> {
      const fiber = ports.get(portId)?.get(requestId);
      if (fiber) await Effect.runPromise(Fiber.interrupt(fiber));
    },
    async cancelPending(except: {
      portId: string;
      requestId: string;
    }): Promise<void> {
      const cancelled: Fiber.Fiber<unknown, WorkerErrorDto>[] = [];
      for (const [portId, pending] of ports)
        for (const [requestId, fiber] of pending) {
          if (portId !== except.portId || requestId !== except.requestId)
            cancelled.push(fiber);
        }
      await Effect.runPromise(Fiber.interruptAll(cancelled));
    },
    async detachPort(portId: string): Promise<void> {
      const pending = ports.get(portId);
      if (!pending) return;
      ports.delete(portId);
      await Effect.runPromise(Fiber.interruptAll(pending.values()));
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      ports.clear();
      stopExpiry();
      auth.lock(auth.getSnapshot().identity);
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
}

export type SessionRuntime = ReturnType<typeof createSessionRuntime>;
