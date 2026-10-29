import type { FaultCode } from "@defjs/core";
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
    const client =
      http ??
      createWorkerHeadscaleHttp(context, {
        readUnreadBody:
          endpoint("input" in command ? command.input : undefined).definition
            .output === undefined,
      });
    const [fault, value] = await client.execute(
      endpoint("input" in command ? command.input : undefined),
      { signal: context.signal },
    );
    const { apiKey } = context.requireCurrent();
    // defjs decoded the body against this endpoint's output contract.
    if (!fault) return { ok: true, value: value as ApiOutput<K> };
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
        kind: error instanceof SessionFault ? error.kind : "unavailable",
      },
    };
  }
}
