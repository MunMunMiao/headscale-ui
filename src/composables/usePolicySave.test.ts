import { createClient, type FetchHandle, withEndpoint, withHTTPHandle } from "@defjs/core";
import { describe, expect, test } from "vitest";
import { parsePolicy, toMemberRef } from "@/domain/policy-designer";
import { fixtureClientStore } from "@/test/operation-gateway";
import { createSessionDrafts } from "./session-drafts";
import { createActionFeedbackStore } from "./useActionFeedback";
import { createPolicyDesignerStore } from "./usePolicyDesigner";
import { createPolicySave } from "./usePolicySave";
import { createSnapshotStore } from "./useSnapshot";

function setup(handle: FetchHandle) {
  const http = createClient(withEndpoint("https://headscale.test"), withHTTPHandle(handle));
  const client = fixtureClientStore(http);
  const feedback = createActionFeedbackStore();
  const snapshot = createSnapshotStore(client, feedback);
  const policy = createPolicyDesignerStore();
  const session = { client, feedback, snapshot, policy, drafts: createSessionDrafts() };
  snapshot.setAuthorized(true);
  policy.load('{"acls":[],"groups":{"group:ops":["alice@"]}}');
  return { ...session, ...createPolicySave(session) };
}

describe("policy save protocol", () => {
  test.each(["session replaced", "draft discarded"] as const)(
    "an obsolete save callback sends zero writes after %s",
    async (transition) => {
      let calls = 0;
      const session = setup(async (input, init) => {
        calls++;
        return Response.json(await new Request(input, init).json());
      });
      const obsoleteState = session.policy.policyDesignerState;
      if (transition === "session replaced") {
        session.snapshot.setAuthorized(false);
        session.policy.load('{"acls":[],"groups":{"group:new":["new@"]}}');
        session.snapshot.setAuthorized(true);
      } else {
        session.drafts.hold({ id: "a", name: "A" }, true);
        session.drafts.discard();
      }
      const currentBaseline = session.policy.getSnapshot().policyDraft;
      expect(await session.savePolicy("save-policy", obsoleteState)).toEqual({ ok: false });
      expect(calls).toBe(0);
      expect(session.policy.isPolicySaving).toBe(false);
      expect(session.policy.getSnapshot().policyDraft).toBe(currentBaseline);
      expect(
        await createPolicySave(session).savePolicy(
          "save-policy",
          session.policy.policyDesignerState,
        ),
      ).toEqual({ ok: true, hasNewerEdits: false });
      expect(calls).toBe(1);
    },
  );

  test("a retained stale policy does not acquire a save ticket or send to the new server", async () => {
    let calls = 0;
    const session = setup(async () => {
      calls++;
      return Response.json({ policy: '{"acls":[]}' });
    });
    session.drafts.hold({ id: "a", name: "A" }, true);
    expect(await session.savePolicy("save-policy", session.policy.policyDesignerState)).toEqual({
      ok: false,
    });
    expect(calls).toBe(0);
    expect(session.policy.isPolicySaving).toBe(false);
  });
  test("adopts the server accepted text and structure without closing an active editor", async () => {
    const accepted = '{"groups":{"group:ops":["alice@","bob@"]},"acls":[]}';
    const session = setup(async () => Response.json({ policy: accepted }));
    session.policy.setState({ teamDetailOpen: true, teamDetailCurrent: "group:ops" });
    expect(await session.savePolicy("save-policy", session.policy.policyDesignerState)).toEqual({
      ok: true,
      hasNewerEdits: false,
    });
    expect(session.policy.getSnapshot().policyDraft).toBe(accepted);
    expect(session.snapshot.getSnapshot().snapshot.policy?.policy).toBe(accepted);
    expect(session.policy.policyPayload?.groups).toEqual({ "group:ops": ["alice@", "bob@"] });
    expect(session.policy.isPolicyDirty).toBe(false);
    expect(session.policy.getSnapshot().teamDetailOpen).toBe(true);
    expect(session.policy.isPolicySaving).toBe(false);
  });

  test("keeps newer edits and advances only the accepted baseline", async () => {
    const response = Promise.withResolvers<Response>();
    let submitted = "";
    const session = setup(async (input, init) => {
      submitted = (await new Request(input, init).json()).policy;
      return response.promise;
    });
    const saving = session.savePolicy("save-policy", session.policy.policyDesignerState);
    await expect.poll(() => submitted !== "").toBe(true);
    const current = session.policy.policyDesignerState;
    session.policy.commitState({
      ...current,
      groups: current.groups.map((group) => ({
        ...group,
        members: [...group.members, toMemberRef("newer@")],
      })),
    });
    response.resolve(Response.json({ policy: submitted }));
    expect(await saving).toEqual({ ok: true, hasNewerEdits: true });
    expect(session.policy.policyPayload?.groups).toEqual({ "group:ops": ["alice@", "newer@"] });
    expect(session.policy.getSnapshot().policyDraft).toBe(submitted);
    expect(session.policy.isPolicyDirty).toBe(true);
  });

  test("one pending document save rejects other action keys without queueing", async () => {
    const response = Promise.withResolvers<Response>();
    const bodies: string[] = [];
    const session = setup(async (input, init) => {
      bodies.push((await new Request(input, init).json()).policy);
      return response.promise;
    });
    const submitted = session.policy.policyDesignerState;
    const saving = session.savePolicy("assign-user-groups", submitted);
    submitted.groups[0].members.push(toMemberRef("mutated-after-submit@"));
    expect(await session.savePolicy("assign-user-tags", parsePolicy('{"acls":[]}'))).toEqual({
      ok: false,
    });
    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0]).not.toContain("mutated-after-submit");
    response.resolve(Response.json({ policy: bodies[0] }));
    await saving;
    expect(session.policy.policyPayload?.groups).toEqual({ "group:ops": ["alice@"] });
    expect(bodies).toHaveLength(1);
  });

  test("failed saves retain baseline and working draft and retry the same payload", async () => {
    const bodies: string[] = [];
    const session = setup(async (input, init) => {
      const body = await new Request(input, init).json();
      bodies.push(body.policy);
      return bodies.length === 1
        ? Response.json({ message: "Rejected" }, { status: 403 })
        : Response.json(body);
    });
    const baseline = session.policy.getSnapshot().policyDraft;
    const next = parsePolicy('{"acls":[],"groups":{"group:ops":["bob@"]}}');
    session.policy.commitState(next);
    expect(await session.savePolicy("save-policy", next)).toEqual({ ok: false });
    expect(session.policy.getSnapshot().policyDraft).toBe(baseline);
    expect(session.policy.policyPayload?.groups).toEqual({ "group:ops": ["bob@"] });
    expect(session.policy.isPolicyDirty).toBe(true);
    expect(session.feedback.actionError("save-policy")).toBe("Rejected");
    expect((await session.savePolicy("save-policy", next)).ok).toBe(true);
    expect(bodies[0]).toBe(bodies[1]);
  });

  test("an old session response cannot accept data or release the new pending ticket", async () => {
    const replies = [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()];
    let calls = 0;
    const session = setup(async () => replies[calls++].promise);
    const old = session.savePolicy("save-policy", session.policy.policyDesignerState);
    await expect.poll(() => calls).toBe(1);
    session.snapshot.setAuthorized(false);
    session.policy.load('{"acls":[],"groups":{"group:new":["new@"]}}');
    session.snapshot.setAuthorized(true);
    const current = createPolicySave(session).savePolicy(
      "save-policy",
      session.policy.policyDesignerState,
    );
    await expect.poll(() => calls).toBe(2);
    replies[0].resolve(Response.json({ policy: '{"acls":[]}' }));
    expect(await old).toEqual({ ok: false });
    expect(session.policy.isPolicySaving).toBe(true);
    expect(session.policy.policyPayload?.groups).toEqual({ "group:new": ["new@"] });
    replies[1].resolve(Response.json({ policy: '{"acls":[],"groups":{"group:new":["new@"]}}' }));
    expect((await current).ok).toBe(true);
    expect(session.policy.isPolicySaving).toBe(false);
  });

  test("unreadable and unserializable submissions never send a request", async () => {
    let calls = 0;
    const session = setup(async () => {
      calls++;
      return Response.json({ policy: "" });
    });
    session.policy.load('{"acls":[');
    expect(await session.savePolicy("save-policy", parsePolicy('{"acls":[]}'))).toEqual({
      ok: false,
    });
    session.policy.load('{"acls":[]}');
    expect(await session.savePolicy("save-policy", parsePolicy('{"acls":['))).toEqual({
      ok: false,
    });
    expect(calls).toBe(0);
    expect(session.policy.isPolicySaving).toBe(false);
  });

  describe("targeted saves (Members writes)", () => {
    const edit = (session: ReturnType<typeof setup>) => {
      const current = session.policy.policyDesignerState;
      session.policy.commitState({
        ...current,
        groups: current.groups.map((group) => ({
          ...group,
          members: [...group.members, toMemberRef("typed@")],
        })),
      });
    };

    test("a targeted save is refused while the Access draft is dirty", async () => {
      let calls = 0;
      const session = setup(async (input, init) => {
        calls++;
        return Response.json(await new Request(input, init).json());
      });
      edit(session);
      expect(session.policy.isPolicyDirty).toBe(true);
      const draft = session.policy.getSnapshot().policyDraft;
      expect(
        await session.savePolicy("save-policy", session.policy.policyDesignerState, {
          targeted: true,
        }),
      ).toEqual({ ok: false });
      expect(calls).toBe(0);
      expect(session.policy.isPolicySaving).toBe(false);
      expect(session.policy.getSnapshot().policyDraft).toBe(draft);
      expect(session.feedback.actionError("save-policy")).toBe("");
    });

    test("a targeted save of a clean draft is sent", async () => {
      let calls = 0;
      const session = setup(async (input, init) => {
        calls++;
        return Response.json(await new Request(input, init).json());
      });
      expect(
        await session.savePolicy("save-policy", session.policy.policyDesignerState, {
          targeted: true,
        }),
      ).toEqual({ ok: true, hasNewerEdits: false });
      expect(calls).toBe(1);
    });

    test("an untargeted save still publishes a dirty draft (Access contract)", async () => {
      const session = setup(async (input, init) =>
        Response.json(await new Request(input, init).json()),
      );
      edit(session);
      expect(await session.savePolicy("save-policy", session.policy.policyDesignerState)).toEqual({
        ok: true,
        hasNewerEdits: false,
      });
    });

    test("edits made during a targeted save are kept as newer edits", async () => {
      const response = Promise.withResolvers<Response>();
      let submitted = "";
      const session = setup(async (input, init) => {
        submitted = (await new Request(input, init).json()).policy;
        return response.promise;
      });
      const saving = session.savePolicy("save-policy", session.policy.policyDesignerState, {
        targeted: true,
      });
      await expect.poll(() => submitted !== "").toBe(true);
      edit(session);
      response.resolve(Response.json({ policy: submitted }));
      expect(await saving).toEqual({ ok: true, hasNewerEdits: true });
      expect(session.policy.isPolicyDirty).toBe(true);
    });
  });
});
