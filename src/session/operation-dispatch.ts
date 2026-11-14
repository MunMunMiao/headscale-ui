import type { Client, FaultCode, HttpAwaitResult } from "@defjs/core";
import type { RpcStatus } from "@/api/contracts";
import { createWorkerHeadscaleHttp, type HeadscaleHttp } from "@/api/http";
import { redactDiagnosticData, redactStatusData } from "@/api/operation-log";
import * as endpoints from "@/api/requests";
import { findErrorCause } from "@/utils/error-cause";
import { type SessionExecutionContext, SessionFault } from "./auth-session";
import type { ApiOutput, ApiRequest, EndpointName } from "./protocol";
import type { SessionResult } from "./types";

/**
 * Defjs reports a throwing interceptor or transport as a fault whose cause is the original error.
 * A `SessionFault` on that chain still means the session failed, not that the server did.
 */
function sessionFaultOf(error: unknown): SessionFault | undefined {
  return findErrorCause(
    error,
    (cause): cause is SessionFault => cause instanceof SessionFault,
  );
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

// The command selects its input at runtime; each operation validates it before sending.
async function invoke<K extends EndpointName>(
  command: ApiRequest<K>,
  client: Client,
): Promise<HttpAwaitResult<ApiOutput<K>, RpcStatus>> {
  const input = "input" in command ? command.input : undefined;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- dynamic defjs operation dispatch
  return Reflect.apply(
    endpoints[command.endpoint],
    undefined,
    input === undefined ? [client] : [client, input],
  );
}

export async function executeOperation<K extends EndpointName>(
  command: ApiRequest<K>,
  context: SessionExecutionContext,
  http?: HeadscaleHttp,
): Promise<SessionResult<ApiOutput<K>>> {
  if (!Object.hasOwn(endpoints, command.endpoint))
    return { ok: false, error: { kind: "invalid-request" } };
  try {
    const client =
      http ??
      context.http ??
      createWorkerHeadscaleHttp(
        context.requireCurrent().baseUrl,
        context.requireCurrent,
      );
    const [err, value] = await invoke(
      command,
      client({ signal: context.signal }),
    );
    if (err) {
      const { apiKey } = context.requireCurrent();
      const sessionFault = sessionFaultOf(err);
      if (sessionFault)
        return { ok: false, error: { kind: sessionFault.kind } };
      const status = "status" in err ? err.status : undefined;
      const uncertain =
        GATEWAY_STATUS.has(status ?? 0) ||
        (UNCERTAIN.has(err.code) && (status === undefined || status < 300));
      return {
        ok: false,
        error: {
          kind: "api",
          code: err.code,
          message: redactDiagnosticData(err.message, apiKey),
          ...(status === undefined ? {} : { status }),
          ...(err.code === "HTTP_STATUS"
            ? { data: redactStatusData(err.data, apiKey) }
            : {}),
          ...(uncertain && command.type === "api.write"
            ? { outcome: "unknown" as const }
            : {}),
        },
      };
    }
    context.requireCurrent();
    return { ok: true, value };
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: sessionFaultOf(error)?.kind ?? "unavailable",
      },
    };
  }
}
