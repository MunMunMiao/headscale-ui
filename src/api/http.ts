import {
  createClient,
  createHttpInterceptor,
  withEndpoint,
  withHTTPHandle,
  withInterceptors,
  withTimeout,
} from "@defjs/core";
import type { SessionExecutionContext } from "@/session/auth-session";

/**
 * Endpoints without an output contract leave the body unread, so a dropped response would look
 * like a completed write. `readUnreadBody` buffers those responses here and fails the transport.
 */
export function createWorkerHeadscaleHttp(
  context: SessionExecutionContext,
  { readUnreadBody = false }: { readUnreadBody?: boolean } = {},
) {
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
    withHTTPHandle(async (input, init) => {
      context.requireCurrent();
      const response = await nativeFetch(input, init);
      // The library already reads declared error bodies and keeps their status. Only a 2xx body
      // that nobody would read needs to be drained, so a dropped response cannot look complete.
      if (!readUnreadBody || !response.body || !response.ok) return response;
      const reader = response.body.getReader();
      while (true) {
        const next = await reader.read();
        if (next.done) break;
      }
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }),
  );
}

export type HeadscaleHttp = ReturnType<typeof createWorkerHeadscaleHttp>;
