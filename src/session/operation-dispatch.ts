import type { Client, FaultCode, FaultOf, Infer } from "@defjs/core";
import type { rpcStatus } from "@/api/contracts";
import { createWorkerHeadscaleHttp, type HeadscaleHttp } from "@/api/http";
import { redactDiagnosticData, redactStatusData } from "@/api/operation-log";
import * as endpoints from "@/api/requests";
import { type SessionExecutionContext, SessionFault } from "./auth-session";
import { type ApiOutput, type ApiRequest, type EndpointName } from "./protocol";
import type { SessionResult } from "./types";

type HeadscaleFault = FaultOf<Infer<typeof rpcStatus>>;

/**
 * Defjs reports a throwing interceptor or transport as a fault whose cause is the original error.
 * A `SessionFault` on that chain still means the session failed, not that the server did.
 */
function sessionFaultOf(error: unknown): SessionFault | undefined {
  for (let cause = error; cause instanceof Error; cause = cause.cause)
    if (cause instanceof SessionFault) return cause;
  return undefined;
}

// Faults after which a write may have been applied without a usable answer.
const UNCERTAIN: ReadonlySet<FaultCode> = new Set<FaultCode>([
  "NET_ABORTED",
  "NET_TIMEOUT",
  "NET_UNREACHABLE",
  "NET_BODY_INCOMPLETE",
  "RES_DECODE_FAILED",
  "RES_MEDIA_TYPE_INVALID",
  "RES_STRUCT_MISMATCH",
]);
// A proxy answered for an upstream that may already have applied the write.
const GATEWAY_STATUS: ReadonlySet<number> = new Set([502, 503, 504]);

type AnyEndpoint = (client: Client, ...input: never[]) => Promise<unknown>;

type SuccessData<T> = T extends readonly [null, infer Data, ...unknown[]]
  ? Data
  : never;
type SuccessOf<E extends AnyEndpoint> = SuccessData<Awaited<ReturnType<E>>>;

type Outcome<E extends AnyEndpoint> =
  | { readonly fault: null; readonly value: SuccessOf<E> }
  | { readonly fault: HeadscaleFault; readonly value: undefined };

/**
 * Defjs types each operation's callable by its own input. The Worker dispatches by name, so the
 * argument tuple is built at runtime and the operation validates it. `Reflect.apply` keeps the
 * callable boundary free of a type assertion; the callable's own return type supplies the tuple.
 */
async function invoke<E extends AnyEndpoint>(
  endpoint: E,
  client: Client,
  input: unknown,
): Promise<Outcome<E>> {
  const result: Awaited<ReturnType<E>> = await Reflect.apply(
    endpoint,
    undefined,
    input === undefined ? [client] : [client, input],
  );
  return result[0] === null
    ? { fault: null, value: result[1] }
    : { fault: result[0], value: undefined };
}

export async function executeOperation<K extends EndpointName>(
  command: ApiRequest<K>,
  context: SessionExecutionContext,
  http?: HeadscaleHttp, // only tests inject a client; production always builds the Worker client
): Promise<SessionResult<ApiOutput<K>>> {
  if (!Object.hasOwn(endpoints, command.endpoint))
    return { ok: false, error: { kind: "invalid-request" } };
  try {
    const endpoint = endpoints[command.endpoint];
    const client = (http ?? createWorkerHeadscaleHttp(context))({
      signal: context.signal,
    });
    const outcome = await invoke(
      endpoint,
      client,
      "input" in command ? command.input : undefined,
    );
    const { apiKey } = context.requireCurrent();
    // defjs decoded the body against this endpoint's output contract.
    if (outcome.fault === null) return { ok: true, value: outcome.value };
    const fault = outcome.fault;
    // A throwing interceptor or transport arrives as a fault; a session failure is still one.
    const sessionFault = sessionFaultOf(fault);
    if (sessionFault) return { ok: false, error: { kind: sessionFault.kind } };
    const status = "status" in fault ? fault.status : undefined;
    const uncertain =
      GATEWAY_STATUS.has(status ?? 0) ||
      (UNCERTAIN.has(fault.code) && (status === undefined || status < 300));
    return {
      ok: false,
      error: {
        kind: "api",
        code: fault.code,
        message: redactDiagnosticData(fault.message, apiKey),
        ...(status === undefined ? {} : { status }),
        ...(fault.code === "HTTP_STATUS"
          ? { data: redactStatusData(fault.data, apiKey) }
          : {}),
        ...(uncertain && command.type === "api.write"
          ? { outcome: "unknown" as const }
          : {}),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: sessionFaultOf(error)?.kind ?? "unavailable",
      },
    };
  }
}
