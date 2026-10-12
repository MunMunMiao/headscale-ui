import type { OperationCommand } from "@/api/commands";
import { createHeadscaleGateway, type OperationTransport } from "@/api/gateway";
import type { HeadscaleHttp } from "@/api/http";
import { createHeadscaleClientStore } from "@/composables/useHeadscaleClient";

/** Run the real dispatcher against a test-controlled client so the actual endpoint contracts apply. */
function transport(http: HeadscaleHttp): OperationTransport {
  return (command, options) =>
    executeOperation(
      command,
      {
        signal: options?.signal ?? new AbortController().signal,
        requireCurrent: () => ({ baseUrl: "https://headscale.test", apiKey: "test-key" }),
      },
      http,
    );
}
export function fixtureGateway(http: HeadscaleHttp) {
  return createHeadscaleGateway(transport(http));
}
export function fixtureClientStore(http: HeadscaleHttp, baseUrl = "https://headscale.test") {
  const execute = transport(http);
  const client = createHeadscaleClientStore({
    execute: (_expected, command, options) => execute(command as OperationCommand, options),
  });
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
  return client;
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

import { type ConnectionSettings, connectionSettingsError } from "@/api/connection";
import { createWorkerHeadscaleHttp } from "@/api/http";
import { executeOperation } from "@/session/operation-dispatch";
