import { createClient, withEndpoint, withHTTPHandle } from "@defjs/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fixtureSession } from "@/test/dispatch-fixture";
import { snapshotFixture } from "@/test-utils/headscale.test";
import { createSessionDrafts } from "./session-drafts";
import {
  createActionFeedbackStore,
  mutationNotification,
} from "./useActionFeedback";
import type { createHeadscaleClientStore } from "./useHeadscaleClient";
import { createMutation } from "./useMutation";
import { createSnapshotStore } from "./useSnapshot";

let session: {
  feedback: ReturnType<typeof createActionFeedbackStore>;
  auth: ReturnType<typeof fixtureSession>["auth"];
  client: ReturnType<typeof createHeadscaleClientStore>;
  snapshot: ReturnType<typeof createSnapshotStore>;
  drafts: ReturnType<typeof createSessionDrafts>;
};

let requests: string[];
beforeEach(() => {
  const feedback = createActionFeedbackStore();
  const data = snapshotFixture();
  requests = [];
  const { auth, client } = fixtureSession(
    createClient(
      withEndpoint("https://headscale.test"),
      withHTTPHandle(async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        requests.push(`${request.method} ${path}`);
        if (request.method === "PUT" && path === "/api/v1/policy") {
          data.policy = { policy: (await request.json()).policy };
          return Response.json(data.policy);
        }
        const responses: Record<string, unknown> = {
          "/api/v1/health": data.health,
          "/version": data.version,
          "/api/v1/user": { users: data.users },
          "/api/v1/node": { nodes: data.nodes },
          "/api/v1/preauthkey": { preAuthKeys: data.preAuthKeys },
          "/api/v1/apikey": { apiKeys: data.apiKeys },
          "/api/v1/policy": data.policy,
        };
        return Response.json(responses[path]);
      }),
    ),
  );
  session = {
    feedback,
    auth,
    client,
    snapshot: createSnapshotStore(auth, client, feedback),
    drafts: createSessionDrafts(),
  };
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("useMutation", () => {
  test("runs against the active client and refreshes after success", async () => {
    const snapshot = session.snapshot;
    snapshot.setAuthorized(true);

    const result = await createMutation(session).mutateWith("save-policy", {
      endpoint: "setPolicy",
      input: { policy: '{"acls":[]}' },
    });

    expect(result).toEqual({ ok: true, result: { policy: '{"acls":[]}' } });
    expect(requests).toContain("PUT /api/v1/policy");
    expect(snapshot.getSnapshot().snapshot.policy).toEqual({
      policy: '{"acls":[]}',
    });
    expect(snapshot.getSnapshot().snapshot.users).toHaveLength(1);
    expect(snapshot.getSnapshot().snapshot.nodes).toHaveLength(2);
  });

  test("a committed mutation remains successful when its refresh fails and is never replayed", async () => {
    let writes = 0;
    let failRefresh = true;
    const fixture = snapshotFixture();
    const savedUser = { id: "2", name: "committed" };
    const http = createClient(
      withEndpoint("https://headscale.test"),
      withHTTPHandle(async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (request.method === "POST") {
          writes++;
          return Response.json({ user: savedUser });
        }
        if (path === "/api/v1/user")
          return failRefresh
            ? Response.json({ users: "invalid" })
            : Response.json({ users: [savedUser] });
        const responses: Record<string, unknown> = {
          "/api/v1/node": { nodes: fixture.nodes },
          "/api/v1/health": fixture.health,
          "/version": fixture.version,
          "/api/v1/apikey": { apiKeys: [] },
          "/api/v1/preauthkey": { preAuthKeys: [] },
          "/api/v1/policy": fixture.policy,
        };
        return Response.json(responses[path]);
      }),
    );
    ({ auth: session.auth, client: session.client } = fixtureSession(http));
    session.snapshot = createSnapshotStore(
      session.auth,
      session.client,
      session.feedback,
    );
    session.snapshot.setAuthorized(true);
    session.snapshot.applyPatch(fixture);
    expect(
      await createMutation(session).mutate("create-member", {
        endpoint: "createUser",
        input: { name: "committed" },
      }),
    ).toBe(true);
    expect(writes).toBe(1);
    expect(session.feedback.actionError("create-member")).toBe("");
    expect(session.snapshot.getSnapshot().snapshot.users).toEqual(
      fixture.users,
    );
    expect(session.snapshot.getSnapshot().refreshErrors.identity).toBeTruthy();
    failRefresh = false;
    await session.snapshot.refreshSegments(["identity"]);
    expect(session.snapshot.getSnapshot().snapshot.users).toEqual([savedUser]);
    expect(writes).toBe(1);
  });

  test.each([
    [401, "json"],
    [401, "text"],
    [403, "json"],
    [403, "text"],
  ] as const)(
    "HTTP %s with a %s body is a definite rejection without replay",
    async (status, body) => {
      let writes = 0;
      const { auth, client } = fixtureSession(
        createClient(
          withEndpoint("https://headscale.test"),
          withHTTPHandle(async () => {
            writes++;
            return body === "json"
              ? Response.json(
                  { code: 7, message: "Permission denied", details: [] },
                  { status },
                )
              : new Response("Permission denied", { status });
          }),
        ),
      );
      const result = await createMutation(
        { ...session, auth, client },
        { skipRefresh: true },
      ).mutateDetailed("save-policy", {
        endpoint: "setPolicy",
        input: { policy: '{"acls":[]}' },
      });

      expect(result).toMatchObject({
        ok: false,
        outcome: {
          status: "pre-rejected",
          refresh: "not-requested",
          failure: { status },
        },
      });
      expect(mutationNotification(result.outcome)).toMatchObject({
        tone: "error",
        title: "product.feedbackRequestRejected",
      });
      expect(session.feedback.actionOutcome("save-policy")?.status).toBe(
        "pre-rejected",
      );
      expect(writes).toBe(1);
    },
  );

  test("can skip refresh and reports mutation failures as false", async () => {
    const snapshot = session.snapshot;
    snapshot.setAuthorized(true);
    let refreshes = 0;
    snapshot.setOnApplySnapshot(() => void refreshes++);
    const mutation = createMutation(session, { skipRefresh: true });

    expect(
      await mutation.mutate("save-policy", {
        endpoint: "setPolicy",
        input: { policy: '{"acls":[]}' },
      }),
    ).toBe(true);
    expect(refreshes).toBe(0);
    expect(
      await createMutation(
        {
          ...session,
          ...fixtureSession(
            createClient(
              withEndpoint("https://headscale.example.test"),
              withHTTPHandle(async () =>
                Response.json({ message: "denied" }, { status: 403 }),
              ),
            ),
          ),
        },
        { skipRefresh: true },
      ).mutate("save-policy", {
        endpoint: "setPolicy",
        input: { policy: '{"acls":[]}' },
      }),
    ).toBe(false);
  });
});
