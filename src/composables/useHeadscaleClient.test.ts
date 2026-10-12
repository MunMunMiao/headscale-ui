import { expect, test, vi } from "vitest";
import { version } from "@/api/commands";
import type { PublicSessionSnapshot, SessionResult } from "@/session/types";
import { createHeadscaleClientStore } from "./useHeadscaleClient";

function unlocked(id: string, revision = 1): PublicSessionSnapshot {
  return {
    status: "unlocked",
    identity: { workerId: "worker", sessionId: id },
    profile: { id, name: id, baseUrl: `https://${id}.example` },
    expiresAt: Date.now() + 1000,
    pendingProfileId: null,
    reason: null,
    revision,
    apiKeyPrefix: null,
  };
}
test("a page gateway is permanently bound to the identity it adopted", async () => {
  const execute = vi.fn(
    async (): Promise<SessionResult<unknown>> => ({ ok: true, value: { version: "0.29.4" } }),
  );
  const client = createHeadscaleClientStore({ execute });
  client.adopt(unlocked("a"));
  const previous = client.createClient();
  client.adopt(unlocked("b", 2));
  await previous.execute(version());
  expect(execute.mock.calls[0]).toEqual([unlocked("a").identity, version(), undefined]);
  await client.createClient().execute(version());
  expect(execute.mock.calls[1]).toEqual([unlocked("b").identity, version(), undefined]);
  expect(client.getSnapshot().settings).toEqual({ baseUrl: "https://b.example" });
  expect(JSON.stringify(client.getSnapshot())).not.toContain("apiKey");
});
test("activity snapshots retain the gateway while a lock removes it", () => {
  const execute = vi.fn();
  const client = createHeadscaleClientStore({ execute });
  client.adopt(unlocked("a"));
  const gateway = client.createClient();
  client.adopt({ ...unlocked("a", 2), expiresAt: Date.now() + 30_000 });
  expect(client.createClient()).toBe(gateway);
  client.clear();
  expect(client.getSnapshot().settings).toEqual({ baseUrl: "" });
  expect(() => client.createClient()).toThrow();
});
