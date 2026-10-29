import {
  type ConnectionSettings,
  connectionSettingsError,
} from "@/api/connection";
import { createWorkerHeadscaleHttp, type HeadscaleHttp } from "@/api/http";
import type { Execute } from "@/api/snapshot";
import { createHeadscaleClientStore } from "@/composables/useHeadscaleClient";
import type { SessionRequestOptions } from "@/session/auth-session";
import type { SessionBridge } from "@/session/bridge";
import { executeOperation } from "@/session/operation-dispatch";
import type { ApiCommand, ApiRequest } from "@/session/protocol";
import type { SessionIdentity, SessionResult } from "@/session/types";

/** Runs the Worker dispatcher against a test-controlled client so the real endpoint contracts apply. */
export function fixtureExecute(
  http: HeadscaleHttp,
  type: ApiRequest["type"] = "api.read",
): Execute {
  return (command, options) =>
    executeOperation(
      { ...command, type },
      {
        signal: options?.signal ?? new AbortController().signal,
        requireCurrent: () => ({
          baseUrl: "https://headscale.test",
          apiKey: "test-key",
        }),
      },
      http,
    );
}

/** A page session whose bridge publishes to the fixture dispatcher. */
export function fixtureSession(
  http: HeadscaleHttp,
  baseUrl = "https://headscale.test",
) {
  const auth = fakeAuth({
    execute: (_expected, command, options) =>
      fixtureExecute(http, command.type)(command, options),
  });
  const client = createHeadscaleClientStore();
  client.adopt({
    status: "unlocked",
    identity: { workerId: "test-worker", sessionId: "test-session" },
    profile: { id: "test-profile", name: "Test", baseUrl },
    expiresAt: Date.now() + 1800000,
    pendingProfileId: null,
    reason: null,
    revision: 1,
    apiKeyPrefix: null,
  });
  return { auth, client };
}

export function createFixtureHttp(settings: ConnectionSettings) {
  const error = connectionSettingsError(settings);
  if (error)
    throw new Error(
      error === "connectionInvalidUrl"
        ? "Enter an absolute HTTP(S) server URL."
        : "Enter an API key.",
    );
  return createWorkerHeadscaleHttp({
    signal: new AbortController().signal,
    requireCurrent: () => ({
      baseUrl: settings.baseUrl.trim().replace(/\/+$/, ""),
      apiKey: settings.apiKey.trim(),
    }),
  });
}

/** A bridge stand-in that sees the kind the page declared; the reply it fakes is the test's business. */
export function fakeAuth(bridge: {
  execute(
    expected: SessionIdentity,
    command: ApiRequest,
    options?: SessionRequestOptions,
  ): Promise<SessionResult<unknown>>;
}): Pick<SessionBridge, "read" | "write"> {
  const publish =
    (type: ApiRequest["type"]) =>
    (
      expected: SessionIdentity,
      command: ApiCommand,
      options?: SessionRequestOptions,
    ) =>
      bridge.execute(expected, { ...command, type } as ApiRequest, options);
  return { read: publish("api.read"), write: publish("api.write") } as Pick<
    SessionBridge,
    "read" | "write"
  >;
}
