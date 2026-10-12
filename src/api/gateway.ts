import type { FaultCode, Infer } from "@defjs/core";
import type { OperationId } from "@/domain/headscale-operations";
import type { SessionResult, WorkerErrorDto } from "@/session/types";
import type { OperationCommand, OperationOutput } from "./commands";
import type { rpcStatus } from "./contracts";

export interface GatewayExecuteOptions {
  signal?: AbortSignal;
}

export class ApiError extends Error {
  readonly kind: WorkerErrorDto["kind"];
  readonly code?: FaultCode;
  readonly status?: number;
  readonly data?: Infer<typeof rpcStatus>;
  readonly outcome?: "unknown";

  constructor(error: WorkerErrorDto) {
    super(error.kind === "api" ? error.message : `Session request failed (${error.kind}).`);
    this.name = "ApiError";
    this.kind = error.kind;
    if (error.kind === "api") {
      this.code = error.code;
      this.status = error.status;
      this.data = error.data;
    }
    if (error.outcome === "unknown") this.outcome = "unknown";
  }
}

export type ApiResult<T> = [error: ApiError, data: null] | [error: null, data: T];

export interface HeadscaleGateway {
  execute<K extends OperationId>(
    command: OperationCommand<K>,
    options?: GatewayExecuteOptions,
  ): Promise<ApiResult<OperationOutput<K>>>;
}

export type OperationTransport = <K extends OperationId>(
  command: OperationCommand<K>,
  options?: GatewayExecuteOptions,
) => Promise<SessionResult<unknown>>;

export function createHeadscaleGateway(transport: OperationTransport): HeadscaleGateway {
  return {
    async execute<K extends OperationId>(
      command: OperationCommand<K>,
      options?: GatewayExecuteOptions,
    ): Promise<ApiResult<OperationOutput<K>>> {
      try {
        const result = await transport(command, options);
        return result.ok
          ? // The Worker decodes with this build's contracts, and the bridge refuses a Worker
            // with a different build id, so the page applies only the static type here.
            [null, result.value as OperationOutput<K>]
          : [new ApiError(result.error), null];
      } catch {
        return [new ApiError({ kind: "unavailable" }), null];
      }
    },
  };
}
