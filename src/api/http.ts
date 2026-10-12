import {
  createClient,
  createHttpInterceptor,
  withEndpoint,
  withHTTPHandle,
  withInterceptors,
  withTimeout,
} from "@defjs/core";
import type { SessionExecutionContext } from "@/session/auth-session";

export function createWorkerHeadscaleHttp(context: SessionExecutionContext) {
  const { baseUrl } = context.requireCurrent();
  const nativeFetch = globalThis.fetch;
  return createClient(
    withEndpoint(baseUrl),
    withTimeout(15_000),
    withInterceptors(
      createHttpInterceptor((request, next) => {
        const { apiKey } = context.requireCurrent();
        const headers = new Headers(request.headers);
        headers.set("Authorization", `Bearer ${apiKey}`);
        return next({ ...request, headers });
      }),
    ),
    withHTTPHandle((input, init) => {
      context.requireCurrent();
      return nativeFetch(input, init);
    }),
  );
}

export type HeadscaleHttp = ReturnType<typeof createWorkerHeadscaleHttp>;
