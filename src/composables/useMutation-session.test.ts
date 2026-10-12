import { expect, test } from "vitest";
import { createUser } from "@/api/commands";
import type { PublicSessionSnapshot, SessionResult } from "@/session/types";
import { createSessionDrafts } from "./session-drafts";
import { createActionFeedbackStore } from "./useActionFeedback";
import { createHeadscaleClientStore } from "./useHeadscaleClient";
import { createMutation } from "./useMutation";
import { createSnapshotStore } from "./useSnapshot";

function unlocked(sessionId: string): PublicSessionSnapshot {
  return {
    status: "unlocked",
    identity: { workerId: "worker", sessionId },
    profile: { id: sessionId, name: sessionId, baseUrl: `https://${sessionId}.test` },
    expiresAt: Date.now() + 1800000,
    pendingProfileId: null,
    reason: null,
    apiKeyPrefix: null,
    revision: 1,
  };
}

test("a callback created for server A cannot submit its old form to server B", async () => {
  let active = "a";
  const writes: string[] = [];
  const client = createHeadscaleClientStore({
    async execute(expected) {
      if (expected.sessionId !== active) return { ok: false, error: { kind: "stale" } };
      writes.push(active);
      return { ok: true, value: { user: { id: "1", name: "old-form" } } };
    },
  });
  client.adopt(unlocked("a"));
  const feedback = createActionFeedbackStore();
  const snapshot = createSnapshotStore(client, feedback);
  snapshot.setAuthorized(true);
  const mutation = createMutation(
    { client, feedback, snapshot, drafts: createSessionDrafts() },
    { skipRefresh: true },
  );
  active = "b";
  client.adopt(unlocked("b"));
  snapshot.setAuthorized(false);
  snapshot.setAuthorized(true);
  expect(await mutation.mutate("create-member", createUser({ name: "old-form" }))).toBe(false);
  expect(writes).toEqual([]);
  expect(feedback.actionError("create-member")).toBe("");
});

test("locked pages can create mutation callbacks and clicking reports locked without any transport call", async () => {
  let calls = 0;
  const client = createHeadscaleClientStore({
    async execute() {
      calls++;
      return { ok: false, error: { kind: "locked" } };
    },
  });
  const feedback = createActionFeedbackStore();
  const snapshot = createSnapshotStore(client, feedback);
  let mutation: ReturnType<typeof createMutation> | undefined;
  expect(() => {
    mutation = createMutation(
      { client, feedback, snapshot, drafts: createSessionDrafts() },
      { skipRefresh: true },
    );
  }).not.toThrow();
  expect.assert(mutation);
  expect(await mutation.mutate("create-member", createUser({ name: "member" }))).toBe(false);
  expect(calls).toBe(0);
  expect(feedback.getSnapshot().lastError).toBe(t("sessionLocked"));
});

import { t } from "@/i18n";

test("callbacks recreated for the new server cannot send a retained stale draft", async () => {
  let calls = 0;
  const client = createHeadscaleClientStore({
    async execute() {
      calls++;
      return { ok: true, value: { user: { id: "1", name: "old draft" } } };
    },
  });
  client.adopt(unlocked("b"));
  const feedback = createActionFeedbackStore();
  const snapshot = createSnapshotStore(client, feedback);
  snapshot.setAuthorized(true);
  const drafts = createSessionDrafts();
  drafts.hold({ id: "a", name: "A" }, true);
  const mutation = createMutation({ client, feedback, snapshot, drafts }, { skipRefresh: true });
  expect(await mutation.mutate("create-member", createUser({ name: "old draft" }))).toBe(false);
  expect(calls).toBe(0);
  expect(feedback.getSnapshot().lastError).toBe(t("sessionChanged"));
});

test("a write result cannot refresh or adopt while its draft has become stale", async () => {
  const reply = Promise.withResolvers<void>();
  const client = createHeadscaleClientStore({
    async execute() {
      await reply.promise;
      return { ok: true, value: { user: { id: "1", name: "old draft" } } };
    },
  });
  client.adopt(unlocked("a"));
  const feedback = createActionFeedbackStore();
  const snapshot = createSnapshotStore(client, feedback);
  snapshot.setAuthorized(true);
  const drafts = createSessionDrafts();
  const mutation = createMutation({ client, feedback, snapshot, drafts }, { skipRefresh: true });
  const writing = mutation.mutate("create-member", createUser({ name: "old draft" }));
  drafts.hold({ id: "a", name: "A" }, true);
  reply.resolve();
  expect(await writing).toBe(false);
  // The write succeeded upstream, so its result is reported as unconfirmed rather than dropped.
  expect(feedback.getSnapshot().lastError).toBe(t("sessionOutcomeUnknown"));
});

const unknownWrite = {
  ok: false,
  error: { kind: "api", code: "NET_TIMEOUT", message: "timed out", outcome: "unknown" },
} as const;
const definiteWrite = {
  ok: false,
  error: { kind: "api", code: "HTTP_STATUS", message: "bad", status: 400 },
} as const;

/** A session whose write answers `writeResult` and whose reads are counted. */
function counted(writeResult: SessionResult<unknown>, held?: Promise<void>) {
  const calls: string[] = [];
  const client = createHeadscaleClientStore({
    async execute(_expected, command) {
      calls.push(command.operation);
      if (command.operation === "user.create") {
        await held;
        return writeResult;
      }
      const reads: Record<string, unknown> = {
        "user.list": { users: [] },
        "preauthkey.list": { preAuthKeys: [] },
        "apikey.list": { apiKeys: [] },
        "health.check": { databaseConnectivity: true },
        "version.get": { version: "0.29.4" },
        "node.list": { nodes: [] },
        "policy.get": { policy: "" },
      };
      return { ok: true, value: reads[command.operation] };
    },
  });
  client.adopt(unlocked("a"));
  const feedback = createActionFeedbackStore();
  const snapshot = createSnapshotStore(client, feedback);
  snapshot.setAuthorized(true);
  const session = { client, feedback, snapshot, drafts: createSessionDrafts() };
  return { calls, feedback, snapshot, session };
}
const refreshes = (calls: string[]) =>
  calls.filter((operation) => operation === "user.list").length;
const writes = (calls: string[]) => calls.filter((operation) => operation === "user.create").length;

test("an unconfirmed write shows the check-first copy and refreshes the page once without replaying", async () => {
  const { calls, feedback, session } = counted(unknownWrite);
  expect(await createMutation(session).mutate("create-member", createUser({ name: "x" }))).toBe(
    false,
  );
  expect(feedback.actionError("create-member")).toBe(t("sessionOutcomeUnknown"));
  expect(writes(calls)).toBe(1);
  expect(refreshes(calls)).toBe(1);
});

test.each([
  ["skipRefresh is set", unknownWrite, true, t("sessionOutcomeUnknown")],
  [
    "the failure is a definite rejection",
    definiteWrite,
    false,
    t("requestUnexpectedResponse", { status: 400 }),
  ],
] as const)(
  "no refresh follows a failed write when %s",
  async (_name, result, skipRefresh, message) => {
    const { calls, feedback, session } = counted(result);
    expect(
      await createMutation(session, { skipRefresh }).mutate(
        "create-member",
        createUser({ name: "x" }),
      ),
    ).toBe(false);
    expect(feedback.actionError("create-member")).toBe(message);
    expect(writes(calls)).toBe(1);
    expect(refreshes(calls)).toBe(0);
  },
);

test("an unconfirmed write of a replaced session neither refreshes nor reports", async () => {
  const reply = Promise.withResolvers<void>();
  const { calls, feedback, session, snapshot } = counted(unknownWrite, reply.promise);
  const writing = createMutation(session).mutate("create-member", createUser({ name: "x" }));
  await expect.poll(() => writes(calls)).toBe(1);
  snapshot.setAuthorized(false);
  snapshot.setAuthorized(true);
  reply.resolve();
  expect(await writing).toBe(false);
  expect(feedback.actionError("create-member")).toBe("");
  expect(refreshes(calls)).toBe(0);
});

test("discarding a stale draft invalidates its callbacks even when the current server identity is unchanged", async () => {
  let calls = 0;
  const client = createHeadscaleClientStore({
    async execute() {
      calls++;
      return { ok: true, value: { user: { id: "1", name: "old draft" } } };
    },
  });
  client.adopt(unlocked("b"));
  const feedback = createActionFeedbackStore();
  const snapshot = createSnapshotStore(client, feedback);
  snapshot.setAuthorized(true);
  const drafts = createSessionDrafts();
  drafts.hold({ id: "a", name: "A" }, true);
  const session = { client, feedback, snapshot, drafts };
  const old = createMutation(session, { skipRefresh: true });
  drafts.discard();
  expect(await old.mutate("create-member", createUser({ name: "old draft" }))).toBe(false);
  expect(calls).toBe(0);
  expect(
    await createMutation(session, { skipRefresh: true }).mutate(
      "create-member",
      createUser({ name: "new draft" }),
    ),
  ).toBe(true);
});
