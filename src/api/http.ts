import {
  createClient,
  createHttpInterceptor,
  withEndpoint,
  withInterceptors,
} from "@defjs/core";
import type { SessionExecutionContext } from "@/session/auth-session";

/** The Worker client: binds the session credential to every request. */
export function createWorkerHeadscaleHttp(context: SessionExecutionContext) {
  const { baseUrl } = context.requireCurrent();
  return createClient(
    withEndpoint(baseUrl),
    withInterceptors(
      createHttpInterceptor((request, next) => {
        const { apiKey } = context.requireCurrent();
        const headers = new Headers(request.headers);
        headers.set("Authorization", `Bearer ${apiKey}`);
        return next({ ...request, headers });
      }),
    ),
  );
}

export type HeadscaleHttp = ReturnType<typeof createWorkerHeadscaleHttp>;
