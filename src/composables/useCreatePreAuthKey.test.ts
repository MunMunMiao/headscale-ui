import { createClient, withEndpoint, withHTTPHandle } from "@defjs/core";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { fixtureSession } from "@/test/dispatch-fixture";
import { snapshotFixture } from "@/test-utils/headscale.test";
import { type Session, SessionContext } from "./session-context";
import { createSessionDrafts } from "./session-drafts";
import { createActionFeedbackStore } from "./useActionFeedback";
import { useCreatePreAuthKey } from "./useCreatePreAuthKey";
import { createDeviceSetupStore } from "./useDeviceSetup";
import { createSnapshotStore } from "./useSnapshot";

const payload = {
  user: "1",
  reusable: true,
  ephemeral: false,
  expiration: "2027-01-01T00:00:00.000Z",
  aclTags: [],
};

function setup(respond: (body: unknown) => Response | Promise<Response>) {
  const bodies: unknown[] = [];
  const http = createClient(
    withEndpoint("https://headscale.test"),
    withHTTPHandle(async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (request.method === "POST") {
        const body = await request.json();
        bodies.push(body);
        return respond(body);
      }
      const fixture = snapshotFixture();
      const reads: Record<string, unknown> = {
        "/api/v1/user": { users: fixture.users },
        "/api/v1/node": { nodes: fixture.nodes },
        "/api/v1/health": fixture.health,
        "/version": fixture.version,
        "/api/v1/apikey": { apiKeys: [] },
        "/api/v1/preauthkey": { preAuthKeys: [] },
        "/api/v1/policy": fixture.policy,
      };
      return Response.json(reads[path]);
    }),
  );
  const feedback = createActionFeedbackStore();
  const { auth, client } = fixtureSession(http);
  const snapshot = createSnapshotStore(auth, client, feedback);
  snapshot.setAuthorized(true);
  const deviceSetup = createDeviceSetupStore();
  const session = {
    feedback,
    auth,
    client,
    snapshot,
    drafts: createSessionDrafts(),
    deviceSetup,
  } as Session;
  let create: ReturnType<typeof useCreatePreAuthKey> | undefined;
  function Capture() {
    create = useCreatePreAuthKey();
    return null;
  }
  renderToString(
    createElement(SessionContext.Provider, { value: session }, createElement(Capture)),
  );
  if (!create) throw new Error("hook did not render");
  return { create, deviceSetup, feedback, bodies };
}

describe("useCreatePreAuthKey", () => {
  test("stores the created key and requests a one-shot reveal", async () => {
    const { create, deviceSetup, bodies } = setup(() =>
      Response.json({
        preAuthKey: { id: "9", key: "new-secret", user: { id: "1", name: "alice" } },
      }),
    );
    expect(await create(payload)).toBe(true);
    expect(deviceSetup.getSnapshot()).toMatchObject({
      lastCreatedInvite: "new-secret",
      revealCreatedInvite: true,
    });
    expect(bodies).toEqual([payload]);
  });

  test("a tag-only payload omits the user key from the request", async () => {
    const { create, bodies } = setup(() =>
      Response.json({ preAuthKey: { id: "9", key: "tagged", aclTags: ["tag:server"] } }),
    );
    const { user: _owner, ...tagOnly } = { ...payload, aclTags: ["tag:server"] };
    expect(await create(tagOnly)).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty("user");
    expect(bodies[0]).toMatchObject({ aclTags: ["tag:server"] });
  });

  // The listing only returns masked keys, so dropping the previous secret on a failed attempt loses it for good.
  test("keeps the previous one-time key when creation fails", async () => {
    const { create, deviceSetup, feedback } = setup(() =>
      Response.json({ code: 3, message: "denied", details: [] }, { status: 400 }),
    );
    deviceSetup.setState({ lastCreatedInvite: "old" });
    const seen: string[] = [];
    deviceSetup.subscribe(() => seen.push(deviceSetup.getSnapshot().lastCreatedInvite));
    expect(await create(payload)).toBe(false);
    expect(seen).toEqual([]);
    expect(deviceSetup.getSnapshot()).toMatchObject({
      lastCreatedInvite: "old",
      revealCreatedInvite: false,
    });
    expect(feedback.actionError("create-invite")).not.toBe("");
  });

  test("reports the create-invite action as pending until the server answers", async () => {
    const gate = Promise.withResolvers<void>();
    const { create, deviceSetup, feedback } = setup(async () => {
      await gate.promise;
      return Response.json({ preAuthKey: { id: "9", key: "late" } });
    });
    const creating = create(payload);
    await expect.poll(() => feedback.isActionPending("create-invite")).toBe(true);
    expect(deviceSetup.getSnapshot().revealCreatedInvite).toBe(false);
    gate.resolve();
    expect(await creating).toBe(true);
    expect(feedback.isActionPending("create-invite")).toBe(false);
    expect(deviceSetup.getSnapshot().lastCreatedInvite).toBe("late");
  });
});
