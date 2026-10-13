import type { AnyStruct, FaultCode, HttpCommand } from "@defjs/core";
import type { rpcStatus } from "@/api/contracts";
import { createWorkerHeadscaleHttp, type HeadscaleHttp } from "@/api/http";
import { redactDiagnosticData } from "@/api/operation-log";
import { REQUEST_REGISTRY } from "@/api/requests";
import { modifiesServer } from "@/domain/headscale-operations";
import {
  type AuthOperationCommand,
  type SessionExecutionContext,
  SessionFault,
} from "./auth-session";
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

export async function executeOperation(
  command: AuthOperationCommand,
  context: SessionExecutionContext,
  http?: HeadscaleHttp, // only tests inject a client; production always builds the Worker client
): Promise<SessionResult<unknown>> {
  if (!Object.hasOwn(REQUEST_REGISTRY, command.operation))
    return { ok: false, error: { kind: "invalid-request" } };
  try {
    const client = http ?? createWorkerHeadscaleHttp(context);
    const makeRequest = REQUEST_REGISTRY[command.operation] as (
      input: unknown,
    ) => HttpCommand<AnyStruct | undefined, AnyStruct | undefined, typeof rpcStatus>;
    const [fault, value] = await client.execute(makeRequest(command.input), {
      signal: context.signal,
    });
    const { apiKey } = context.requireCurrent();
    if (!fault) return { ok: true, value };
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
        ...(fault.code === "HTTP_STATUS" ? { data: redactDiagnosticData(fault.data, apiKey) } : {}),
        ...(uncertain && modifiesServer(command.operation) ? { outcome: "unknown" as const } : {}),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: { kind: error instanceof SessionFault ? error.kind : "unavailable" },
    };
  }
}
