import type { FaultCode, FaultOf, Infer } from "@defjs/core";
import type { rpcStatus } from "@/api/contracts";
import { createWorkerHeadscaleHttp, type HeadscaleHttp } from "@/api/http";
import { redactDiagnosticData } from "@/api/operation-log";
import { type SessionExecutionContext, SessionFault } from "./auth-session";
import {
  type ApiOutput,
  type ApiRequest,
  type EndpointName,
  endpointOf,
} from "./protocol";
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

export async function executeOperation<K extends EndpointName>(
  command: ApiRequest<K>,
  context: SessionExecutionContext,
  http?: HeadscaleHttp, // only tests inject a client; production always builds the Worker client
): Promise<SessionResult<ApiOutput<K>>> {
  const endpoint = endpointOf(command.endpoint);
  if (!endpoint) return { ok: false, error: { kind: "invalid-request" } };
  try {
    const client = (
      http ??
      createWorkerHeadscaleHttp(context, {
        readUnreadBody: endpoint.definition.output === undefined,
      })
    )({ signal: context.signal });
    const [fault, value] = (await endpoint(
      client,
      "input" in command ? command.input : undefined,
    )) as [HeadscaleFault, undefined] | [null, unknown];
    const { apiKey } = context.requireCurrent();
    // defjs decoded the body against this endpoint's output contract.
    if (!fault) return { ok: true, value: value as ApiOutput<K> };
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
          ? { data: redactDiagnosticData(fault.data, apiKey) }
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
