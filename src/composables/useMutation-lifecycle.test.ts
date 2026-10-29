import { expect, test } from "vitest";
import { nodeTagBaseline } from "@/domain/tag-lifecycle";
import { t } from "@/i18n";
import type { ApiCommand } from "@/session/protocol";
import type { SessionResult } from "@/session/types";
import { fakeAuth } from "@/test/dispatch-fixture";
import { snapshotFixture } from "@/test-utils/headscale.test";
import { createSessionDrafts } from "./session-drafts";
import { createTagLifecycleStore } from "./tag-lifecycle-state";
import {
  createActionFeedbackStore,
  mutationNotification,
} from "./useActionFeedback";
import { createHeadscaleClientStore } from "./useHeadscaleClient";
import { createMutation } from "./useMutation";
import { createSnapshotStore } from "./useSnapshot";

function fixture(
  reply:
    | SessionResult<unknown>
    | ((command: ApiCommand) => Promise<SessionResult<unknown>>),
  failRead = false,
) {
  const data = snapshotFixture();
  const calls: ApiCommand[] = [];
  const auth = fakeAuth({
    async execute(_identity, command) {
      calls.push(command);
      if (command.type === "api.write")
        return typeof reply === "function" ? reply(command) : reply;
      if (failRead)
        return {
          ok: false,
          error: {
            kind: "api",
            code: "HTTP_STATUS",
            status: 503,
            message: "read failed",
          },
        };
      const values: Record<string, unknown> = {
        listUsers: { users: data.users },
        listPreAuthKeys: { preAuthKeys: data.preAuthKeys },
        listApiKeys: { apiKeys: data.apiKeys },
        listNodes: { nodes: data.nodes },
        getPolicy: data.policy,
        version: data.version,
        health: data.health,
      };
      return { ok: true, value: values[command.endpoint] };
    },
  });
  const client = createHeadscaleClientStore();
  client.adopt({
    status: "unlocked",
    identity: { workerId: "worker", sessionId: "s1" },
    profile: { id: "p1", name: "A", baseUrl: "https://a.test" },
    expiresAt: Date.now() + 60000,
    pendingProfileId: null,
    reason: null,
    revision: 1,
    apiKeyPrefix: null,
  });
  const feedback = createActionFeedbackStore();
  const snapshot = createSnapshotStore(auth, client, feedback);
  snapshot.setAuthorized(true);
  snapshot.applyPatch(data);
  const tagLifecycle = createTagLifecycleStore();
  tagLifecycle.bind({
    profileId: "p1",
    baseUrl: "https://a.test",
    workerId: "worker",
    sessionId: "s1",
    viewEpoch: 0,
    version: "0.29.4",
    versionFresh: true,
  });
  return {
    calls,
    data,
    session: {
      auth,
      client,
      feedback,
      snapshot,
      drafts: createSessionDrafts(),
      tagLifecycle,
    },
  };
}
const command: ApiCommand<"setTags"> = {
  endpoint: "setTags",
  input: { nodeId: "1", tags: ["tag:new", "tag:extra"] },
};
const unknownReply = {
  ok: false,
  error: {
    kind: "api",
    code: "NET_TIMEOUT",
    message: "connection closed",
    outcome: "unknown",
  },
} as const;
const serverError = (
  message: string,
  status = 400,
): SessionResult<unknown> => ({
  ok: false,
  error: {
    kind: "api",
    code: "HTTP_STATUS",
    status,
    message: "rejected",
    data: { code: 3, message },
  },
});

test("confirmed write plus failed refresh preserves authoritative result and a separate warning", async () => {
  const reply = {
    node: { id: "1", name: "server", tags: ["tag:new", "tag:extra"] },
  };
  const { session, calls } = fixture({ ok: true, value: reply }, true);
  const result = await createMutation(session).mutateDetailed(
    "node-tags",
    command,
  );
  expect(result).toEqual({
    ok: true,
    result: reply,
    outcome: { status: "confirmed", refresh: "failed" },
  });
  expect(session.feedback.actionError("node-tags")).toBe("");
  expect(session.feedback.actionOutcome("node-tags")).toEqual({
    status: "confirmed",
    refresh: "failed",
  });
  expect(calls.filter((entry) => entry.endpoint === "setTags")).toHaveLength(1);
});

test.each([
  ["setTags", "persisting node: disk full"],
  ["setPolicy", "reloading policy: failed"],
] as const)(
  "%s server error remains possibly applied after readback and permits an explicit new submission",
  async (endpoint, message) => {
    const { session, calls } = fixture(serverError(message));
    const operation: ApiCommand =
      endpoint === "setTags"
        ? command
        : { endpoint, input: { policy: '{"tagOwners":{"tag:new":[]}}' } };
    const key = endpoint === "setTags" ? "node-tags" : "save-policy";
    const result = await createMutation(session).mutateDetailed(key, operation);
    expect(result).toMatchObject({
      ok: false,
      outcome: {
        status: "possibly-applied",
        refresh: "succeeded",
        failure: { kind: "api", status: 400, message },
      },
    });
    expect(session.feedback.actionOutcome(key)?.status).toBe(
      "possibly-applied",
    );
    expect(mutationNotification(result.outcome)?.tone).toBe("warning");
    expect(calls.filter((entry) => entry.endpoint === endpoint)).toHaveLength(
      1,
    );
    const next = await createMutation(session).mutateDetailed(key, operation);
    expect(next.outcome.status).toBe("possibly-applied");
    expect(calls.filter((entry) => entry.endpoint === endpoint)).toHaveLength(
      2,
    );
  },
);

test.each([
  ["unknown", unknownReply],
  ["possibly-applied", serverError("reloading policy: failed", 500)],
] as const)(
  "%s policy publication does not lock a returned device draft after matching reads",
  async (status, reply) => {
    const submitted = '{"acls":[],"tagOwners":{"tag:extra":[],"tag:x":[]}}';
    const { session, calls, data } = fixture(async (operation) => {
      if (operation.endpoint === "setPolicy") {
        data.policy = { policy: operation.input.policy };
        return reply;
      }
      if (operation.endpoint === "setTags") {
        const node = {
          ...data.nodes[0],
          tags: operation.input.tags,
          user: null,
        };
        data.nodes[0] = node;
        return { ok: true, value: { node } };
      }
      throw new Error(`Unexpected fixture write: ${operation.endpoint}`);
    });
    data.policy = { policy: '{"acls":[],"tagOwners":{"tag:extra":[]}}' };
    session.snapshot.applyPatch(data);
    const handoff = session.tagLifecycle.saveReturn({
      source: "device",
      nodeId: data.nodes[0].id,
      managedTag: "tag:x",
      tags: ["tag:x", "tag:extra"],
      baseline: nodeTagBaseline(data.nodes[0]),
      editVersion: 19,
    });
    expect.assert(handoff);
    const published = await createMutation(session).mutateDetailed(
      "save-policy",
      {
        endpoint: "setPolicy",
        input: { policy: submitted },
      },
    );
    expect(published.ok).toBe(false);
    expect(published.outcome.status).toBe(status);
    expect(session.feedback.actionOutcome("save-policy")?.status).toBe(status);
    expect(
      calls.filter((entry) => entry.endpoint === "setPolicy"),
    ).toHaveLength(1);
    expect(await session.snapshot.refreshSegments(["fabric", "policy"])).toBe(
      true,
    );
    expect(session.snapshot.getSnapshot().snapshot.policy?.policy).toBe(
      submitted,
    );
    expect(session.tagLifecycle.requestReturn(handoff.id)).toBe(true);
    const restored = session.tagLifecycle.consumeReturn(handoff.id);
    expect.assert(restored?.source === "device");
    expect(session.tagLifecycle.getSnapshot().returnTo).toBeNull();
    const result = await createMutation(session).mutateDetailed("node-tags", {
      endpoint: "setTags",
      input: { nodeId: restored.nodeId, tags: restored.tags },
    });
    expect(result.outcome.status).toBe("confirmed");
    expect(calls.filter((entry) => entry.endpoint === "setTags")).toHaveLength(
      1,
    );
    expect(session.feedback.actionOutcome("save-policy")?.status).toBe(status);
  },
);

test.each([
  [
    "setTags",
    "cannot remove all tags from a node - tagged nodes must have at least one tag",
  ],
  ["setTags", "tag should be lowercase"],
  ["setTags", "node not found"],
  ["setTags", "requested tags [tag:missing] are invalid or not permitted"],
  ["setPolicy", "update is disabled for modes other than 'database'"],
] as const)(
  "known pre-side-effect %s rejection is not generalized to a partial write",
  async (endpoint, message) => {
    const { session } = fixture(serverError(message));
    const operation: ApiCommand =
      endpoint === "setTags" ? command : { endpoint, input: { policy: "{}" } };
    const result = await createMutation(session).mutateDetailed(
      "node-tags",
      operation,
    );
    expect(result.outcome.status).toBe("pre-rejected");
  },
);

test("a lost response dispatches once, reports unknown and permits the next explicit submission", async () => {
  let writes = 0;
  const { session, calls } = fixture(async () =>
    ++writes === 1
      ? unknownReply
      : { ok: true, value: { node: { id: "1", tags: ["tag:new"] } } },
  );
  const result = await createMutation(session).mutateDetailed(
    "node-tags",
    command,
  );
  expect(result).toMatchObject({
    ok: false,
    outcome: { status: "unknown", refresh: "succeeded" },
  });
  expect(session.feedback.actionError("node-tags")).toBe(
    t("sessionOutcomeUnknown"),
  );
  expect(session.feedback.actionOutcome("node-tags")?.status).toBe("unknown");
  expect(mutationNotification(result.outcome)?.tone).toBe("warning");
  expect(calls.filter((entry) => entry.endpoint === "setTags")).toHaveLength(1);
  session.feedback.clearActionFeedback("node-tags");
  expect(
    (await createMutation(session).mutateDetailed("node-tags", command)).outcome
      .status,
  ).toBe("confirmed");
  expect(calls.filter((entry) => entry.endpoint === "setTags")).toHaveLength(2);
});

test.each([
  ["expirePreAuthKey", "deletePreAuthKey"],
  ["deletePreAuthKey", "expirePreAuthKey"],
] as const)(
  "%s applied before response loss permits an explicit key action without a release step",
  async (endpoint, nextEndpoint) => {
    let writes = 0;
    const { session, calls, data } = fixture(async (operation) => {
      if (
        operation.endpoint !== "expirePreAuthKey" &&
        operation.endpoint !== "deletePreAuthKey"
      )
        throw new Error(`Unexpected fixture write: ${operation.endpoint}`);
      data.preAuthKeys =
        operation.endpoint === "deletePreAuthKey"
          ? data.preAuthKeys.filter((key) => key.id !== operation.input.id)
          : data.preAuthKeys.map((key) =>
              key.id === operation.input.id
                ? { ...key, expiration: "2000-01-01T00:00:00Z" }
                : key,
            );
      return ++writes === 1 ? unknownReply : { ok: true, value: undefined };
    });
    data.preAuthKeys[0] = { ...data.preAuthKeys[0], key: "KEY-STOP-SECRET" };
    session.snapshot.applyPatch(data);
    const stopped = await createMutation(session).mutateDetailed(
      "invite-action",
      {
        endpoint,
        input: { id: "1" },
      },
    );
    expect(stopped.outcome).toMatchObject({
      status: "unknown",
      refresh: "succeeded",
    });
    expect(
      calls.filter((entry) => entry.endpoint === "listPreAuthKeys"),
    ).toHaveLength(1);
    const observed = session.snapshot
      .getSnapshot()
      .snapshot.preAuthKeys.find((key) => key.id === "1");
    if (endpoint === "deletePreAuthKey") expect(observed).toBeUndefined();
    else expect(observed?.expiration).toBe("2000-01-01T00:00:00Z");
    expect(writes).toBe(1);
    expect(session.feedback.actionOutcome("invite-action")?.status).toBe(
      "unknown",
    );
    expect(JSON.stringify(session.tagLifecycle.getSnapshot())).not.toContain(
      "KEY-STOP-SECRET",
    );
    expect(JSON.stringify(session.feedback.getSnapshot())).not.toContain(
      "KEY-STOP-SECRET",
    );
    const next = await createMutation(session).mutateDetailed("invite-action", {
      endpoint: nextEndpoint,
      input: { id: "1" },
    });
    expect(next.outcome.status).toBe("confirmed");
    expect(writes).toBe(2);
    expect(calls.filter((entry) => entry.endpoint === endpoint)).toHaveLength(
      1,
    );
    expect(
      calls.filter((entry) => entry.endpoint === nextEndpoint),
    ).toHaveLength(1);
  },
);

test.each([
  "tag must start with the string 'tag:'",
  "tag should be lowercase",
  "tags must not contain spaces",
  "auth-key must be either tagged or owned by user",
  "user not found",
])(
  "key creation pre-validation rejection %s permits a new submission",
  async (message) => {
    const { session, calls } = fixture(serverError(message));
    const create: ApiCommand<"createPreAuthKey"> = {
      endpoint: "createPreAuthKey",
      input: {
        user: "1",
        aclTags: ["tag:Web1"],
        reusable: false,
        ephemeral: false,
        expiration: "2027-01-01T00:00:00Z",
      },
    };
    const mutation = createMutation(session);
    expect(
      (await mutation.mutateDetailed("create-invite", create)).outcome.status,
    ).toBe("pre-rejected");
    await mutation.mutateDetailed("create-invite", create);
    expect(
      calls.filter((entry) => entry.endpoint === "createPreAuthKey"),
    ).toHaveLength(2);
  },
);

test("unknown key creation does not retain inventory secrets or block a new explicit creation", async () => {
  const { session, calls } = fixture(unknownReply);
  const create: ApiCommand<"createPreAuthKey"> = {
    endpoint: "createPreAuthKey",
    input: {
      user: "1",
      aclTags: ["tag:x"],
      reusable: true,
      ephemeral: false,
      expiration: "2027-01-01T00:00:00Z",
    },
  };
  const mutation = createMutation(session);
  expect(
    (await mutation.mutateDetailed("create-invite", create)).outcome.status,
  ).toBe("unknown");
  expect(
    calls.filter((entry) => entry.endpoint === "createPreAuthKey"),
  ).toHaveLength(1);
  expect(JSON.stringify(session.tagLifecycle.getSnapshot())).not.toContain(
    "test-preauth-key",
  );
  expect(
    (await mutation.mutateDetailed("create-invite", create)).outcome.status,
  ).toBe("unknown");
  expect(
    calls.filter((entry) => entry.endpoint === "createPreAuthKey"),
  ).toHaveLength(2);
});

test.each([
  ["looking up user: user not found", "pre-rejected"],
  ["node not found in registration cache", "possibly-applied"],
  ["user not found", "possibly-applied"],
] as const)(
  "AuthRegister classifies only the exact pre-consumption user lookup failure: %s",
  async (message, status) => {
    const { session } = fixture(serverError(message, 500));
    const result = await createMutation(session).mutateDetailed(
      "register-auth-request",
      {
        endpoint: "authRegister",
        input: { user: "alice", authId: "hskey-authreq-not-retained" },
      },
    );
    expect(result.outcome.status).toBe(status);
  },
);

test("AuthRegister late error redacts consumed Auth ID from the outcome and session feedback", async () => {
  const authId = "hskey-authreq-do-not-retain";
  const { session } = fixture(
    serverError(`persist failed after consuming ${authId}`),
  );
  const result = await createMutation(session).mutateDetailed(
    "register-auth-request",
    {
      endpoint: "authRegister",
      input: { user: "alice", authId },
    },
  );
  expect(result.outcome.status).toBe("possibly-applied");
  expect(JSON.stringify(result)).not.toContain(authId);
  expect(JSON.stringify(session.tagLifecycle.getSnapshot())).not.toContain(
    authId,
  );
  expect(JSON.stringify(session.feedback.getSnapshot())).not.toContain(authId);
  expect(result.outcome.failure?.message).toContain("persist failed");
});

test("stale version callbacks and locked sessions are not dispatched; unknown/dev version is not a global write ban", async () => {
  const { session, calls } = fixture({
    ok: true,
    value: { node: { id: "1", name: "ok" } },
  });
  const old = createMutation(session);
  const scope = session.tagLifecycle.captureScope();
  expect.assert(scope);
  session.tagLifecycle.bind({ ...scope, version: "dev", versionFresh: false });
  expect((await old.mutateDetailed("node-tags", command)).outcome.status).toBe(
    "not-dispatched",
  );
  expect(calls).toEqual([]);
  expect(
    (
      await createMutation(session, { skipRefresh: true }).mutateDetailed(
        "node-tags",
        command,
      )
    ).outcome.status,
  ).toBe("confirmed");
  session.client.clear();
  expect(
    (await createMutation(session).mutateDetailed("node-tags", command)).outcome
      .status,
  ).toBe("not-dispatched");
  expect(calls).toHaveLength(1);
});

test.each([
  [
    { kind: "api", code: "REQ_INPUT_INVALID", message: "invalid input" },
    "not-dispatched",
  ],
  [{ kind: "stale" }, "not-dispatched"],
  [
    { kind: "api", code: "NET_UNREACHABLE", message: "response lost" },
    "unknown",
  ],
] as const)(
  "structured failure %j retains its delivery classification",
  async (error, status) => {
    const { session } = fixture({ ok: false, error });
    const result = await createMutation(session, {
      skipRefresh: true,
    }).mutateDetailed("node-tags", command);
    expect(result.outcome.status).toBe(status);
  },
);

test("an unexpected gateway throw remains unknown rather than a false pre-rejection", async () => {
  const { session } = fixture(async () => {
    throw new Error("gateway stopped");
  });
  const result = await createMutation(session).mutateDetailed(
    "node-tags",
    command,
  );
  expect(result.outcome).toMatchObject({
    status: "unknown",
    failure: { kind: "unavailable", message: "gateway stopped" },
  });
});

test("a rejected malformed key creation does not fabricate a successful creation", async () => {
  const { session } = fixture({
    ok: false,
    error: {
      kind: "api",
      code: "REQ_INPUT_INVALID",
      message: "expiration is required",
    },
  });
  const result = await createMutation(session).mutateDetailed("create-invite", {
    endpoint: "createPreAuthKey",
    input: {},
  } as ApiCommand<"createPreAuthKey">);
  expect(result.ok).toBe(false);
  expect(result.outcome.status).toBe("not-dispatched");
});

test("legacy key-bearing commands redact their input key from the outcome and feedback", async () => {
  const secret = "hskey-auth-legacy-secret";
  const { session } = fixture(serverError(`could not persist ${secret}`));
  const result = await createMutation(session).mutateDetailed(
    "register-auth-request",
    {
      endpoint: "registerNode",
      input: { user: "alice", key: secret },
    },
  );
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(session.feedback.getSnapshot())).not.toContain(secret);
  expect(session.feedback.actionError("register-auth-request")).toContain(
    "could not persist",
  );
});

test("commands without inputs and malformed secret inputs preserve a structured worker rejection", async () => {
  const { session } = fixture({
    ok: false,
    error: {
      kind: "api",
      code: "REQ_INPUT_INVALID",
      message: "invalid command",
    },
  });
  for (const input of [
    { endpoint: "health" },
    { endpoint: "authRegister", input: { user: "alice", authId: 42 } },
  ]) {
    const result = await createMutation(session).mutateDetailed(
      "register-auth-request",
      input as ApiCommand,
    );
    expect(result.outcome).toMatchObject({
      status: "not-dispatched",
      failure: { message: "invalid command" },
    });
  }
});

test("a duplicate pending click is not dispatched and cannot replace the first outcome", async () => {
  const reply = Promise.withResolvers<SessionResult<unknown>>();
  const { session, calls } = fixture(() => reply.promise);
  const mutation = createMutation(session, { skipRefresh: true });
  const first = mutation.mutateDetailed("node-tags", command, {
    signal: new AbortController().signal,
  });
  expect(await mutation.mutateWith("node-tags", command)).toEqual({
    ok: false,
  });
  expect(calls).toHaveLength(1);
  expect(session.feedback.actionOutcome("node-tags")).toBeUndefined();
  reply.resolve({ ok: true, value: { node: { id: "1", name: "device" } } });
  expect((await first).outcome.status).toBe("confirmed");
  expect(session.feedback.actionOutcome("node-tags")?.status).toBe("confirmed");
});

test("old in-flight failures cannot update a new session's feedback or refresh it", async () => {
  const reply = Promise.withResolvers<SessionResult<unknown>>();
  const { session, calls } = fixture(() => reply.promise);
  const pending = createMutation(session).mutateDetailed("node-tags", command);
  const oldScope = session.tagLifecycle.captureScope();
  expect.assert(oldScope);
  session.snapshot.rebindSession();
  session.tagLifecycle.bind({
    ...oldScope,
    profileId: "b",
    baseUrl: "https://b.test",
    sessionId: "s2",
  });
  session.feedback.clearAllActionFeedback();
  reply.resolve(unknownReply);
  expect((await pending).outcome.status).toBe("unknown");
  expect(session.feedback.actionOutcome("node-tags")).toBeUndefined();
  expect(calls).toHaveLength(1);
});
