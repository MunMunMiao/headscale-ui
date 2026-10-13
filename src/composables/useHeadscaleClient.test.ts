import { expect, test } from "vitest";
import type { PublicSessionSnapshot } from "@/session/types";
import { createHeadscaleClientStore } from "./useHeadscaleClient";

function unlocked(
  id: string,
  revision = 1,
): Extract<PublicSessionSnapshot, { status: "unlocked" }> {
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
test("a page publishes under the identity it adopted and shows only the server address", () => {
  const client = createHeadscaleClientStore();
  client.adopt(unlocked("a"));
  const previous = client.getSnapshot().identity;
  client.adopt(unlocked("b", 2));
  expect(previous).toEqual(unlocked("a").identity);
  expect(client.getSnapshot().identity).toEqual(unlocked("b").identity);
  expect(client.getSnapshot().settings).toEqual({ baseUrl: "https://b.example" });
  expect(JSON.stringify(client.getSnapshot())).not.toContain("apiKey");
});
test("activity snapshots keep the adopted identity while a lock removes it", () => {
  const client = createHeadscaleClientStore();
  client.adopt(unlocked("a"));
  const identity = client.getSnapshot().identity;
  client.adopt({ ...unlocked("a", 2), expiresAt: Date.now() + 30_000 });
  expect(client.getSnapshot().identity).toBe(identity);
  client.adopt({
    ...unlocked("a", 3),
    status: "locked",
    identity: null,
    profile: null,
    expiresAt: null,
    apiKeyPrefix: null,
  });
  expect(client.getSnapshot()).toEqual({ settings: { baseUrl: "" }, identity: null });
});
