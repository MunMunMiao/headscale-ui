import {
  createClient,
  type FetchHandle,
  withEndpoint,
  withHTTPHandle,
} from "@defjs/core";
import { describe, expect, test } from "vitest";
import { parsePolicy, toMemberRef } from "@/domain/policy-designer";
import { i18n, t } from "@/i18n";
import { productDescriptors } from "@/i18n/descriptors";
import { fixtureSession } from "@/test/dispatch-fixture";
import { createSessionDrafts } from "./session-drafts";
import { createTagLifecycleStore } from "./tag-lifecycle-state";
import { createActionFeedbackStore } from "./useActionFeedback";
import { createPolicyDesignerStore } from "./usePolicyDesigner";
import { createPolicySave } from "./usePolicySave";
import { createSnapshotStore } from "./useSnapshot";

function setup(handle: FetchHandle, transportReads = false) {
  let remote = '{"acls":[],"groups":{"group:ops":["alice@"]}}';
  const http = createClient(
    withEndpoint("https://headscale.test"),
    withHTTPHandle(async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      if (request.method === "GET" && !transportReads)
        return Response.json({ policy: remote });
      const response = await handle(input, init);
      if (request.method === "PUT" && response.ok)
        remote = (await response.clone().json()).policy;
      return response;
    }),
  );
  const { auth, client } = fixtureSession(http);
  const feedback = createActionFeedbackStore();
  const snapshot = createSnapshotStore(auth, client, feedback);
  const policy = createPolicyDesignerStore();
  const tagLifecycle = createTagLifecycleStore();
  tagLifecycle.bind({
    profileId: "test-profile",
    baseUrl: "https://headscale.test",
    workerId: "test-worker",
    sessionId: "test-session",
    viewEpoch: 0,
    version: null,
    versionFresh: false,
  });
  const session = {
    auth,
    client,
    feedback,
    snapshot,
    policy,
    tagLifecycle,
    drafts: createSessionDrafts(),
  };
  snapshot.setAuthorized(true);
  policy.load(remote);
  return {
    ...session,
    ...createPolicySave(session),
    setRemote: (text: string) => {
      remote = text;
    },
  };
}

describe("policy save protocol", () => {
  test("a locked identity reports locked before reading or acquiring a write ticket", async () => {
    let calls = 0;
    const session = setup(async () => {
      calls++;
      return Response.json({});
    }, true);
    session.client.clear();
    expect(
      await session.savePolicy(
        "save-policy",
        session.policy.policyDesignerState,
      ),
    ).toEqual({
      ok: false,
    });
    expect(session.feedback.actionError("save-policy")).toBe(
      t("sessionLocked"),
    );
    expect(session.policy.isPolicySaving).toBe(false);
    expect(calls).toBe(0);
  });

  test("a lost policy response sends once and permits another explicit save without acknowledgement", async () => {
    let writes = 0;
    const session = setup(async (input, init) => {
      writes++;
      if (writes === 1) throw new TypeError("Policy response lost");
      return Response.json(await new Request(input, init).json());
    });
    const next = parsePolicy('{"acls":[],"groups":{"group:ops":["bob@"]}}');
    session.policy.commitState(next);
    expect(await session.savePolicy("save-policy", next)).toMatchObject({
      ok: false,
    });
    expect(session.feedback.actionOutcome("save-policy")?.status).toBe(
      "unknown",
    );
    expect(session.policy.isPolicyDirty).toBe(true);
    expect(session.policy.isPolicySaving).toBe(false);
    expect(writes).toBe(1);
    expect(await session.savePolicy("save-policy", next)).toEqual({
      ok: true,
      hasNewerEdits: false,
    });
    expect(writes).toBe(2);
  });

  test("a failed pre-read replaces an old unknown outcome and the next explicit save can proceed", async () => {
    let failRead = false;
    let readDelay: Promise<void> | undefined;
    let writes = 0;
    const session = setup(async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "GET") {
        if (readDelay) await readDelay;
        return failRead
          ? Response.json(
              { message: "policy read unavailable" },
              { status: 503 },
            )
          : Response.json({
              policy: '{"acls":[],"groups":{"group:ops":["alice@"]}}',
            });
      }
      writes++;
      if (writes === 1) throw new TypeError("Policy response lost");
      return Response.json(await request.json());
    }, true);
    const next = parsePolicy('{"acls":[],"groups":{"group:ops":["bob@"]}}');
    session.policy.commitState(next);
    expect(await session.savePolicy("save-policy", next)).toMatchObject({
      ok: false,
    });
    expect(session.feedback.actionOutcome("save-policy")?.status).toBe(
      "unknown",
    );
    expect(session.feedback.actionError("save-policy")).not.toBe("");
    failRead = true;
    const preread = Promise.withResolvers<void>();
    readDelay = preread.promise;
    const retry = session.savePolicy("save-policy", next);
    try {
      expect(session.policy.isPolicySaving).toBe(true);
      expect(session.feedback.actionError("save-policy")).toBe("");
    } finally {
      preread.resolve();
    }
    expect(await retry).toEqual({ ok: false });
    expect(writes).toBe(1);
    expect(session.feedback.actionOutcome("save-policy")).toEqual({
      status: "not-dispatched",
      refresh: "not-requested",
    });
    expect(session.feedback.actionError("save-policy")).toBe(
      "policy read unavailable",
    );
    expect(session.policy.isPolicyDirty).toBe(true);
    expect(session.policy.isPolicySaving).toBe(false);
    failRead = false;
    expect((await session.savePolicy("save-policy", next)).ok).toBe(true);
    expect(writes).toBe(2);
  });

  test("a superseded pre-read fails closed even without a server error message", async () => {
    const firstRead = Promise.withResolvers<Response>();
    let reads = 0;
    let writes = 0;
    const baseline = '{"acls":[],"groups":{"group:ops":["alice@"]}}';
    const session = setup(async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "GET") {
        reads++;
        return reads === 1
          ? firstRead.promise
          : Response.json({ policy: baseline });
      }
      writes++;
      return Response.json(await request.json());
    }, true);
    const next = parsePolicy('{"acls":[],"tagOwners":{"tag:new":[]}}');
    session.policy.commitState(next);
    const saving = session.savePolicy("save-policy", next);
    await expect.poll(() => reads).toBe(1);
    expect(await session.snapshot.refreshSegments(["policy"])).toBe(true);
    firstRead.resolve(Response.json({ policy: baseline }));
    expect(await saving).toEqual({ ok: false });
    expect(session.feedback.actionError("save-policy")).toBe(
      i18n._(productDescriptors.policySaveConflict),
    );
    expect(session.policy.isPolicyDirty).toBe(true);
    expect(writes).toBe(0);
  });

  test("a newly confirmed save uses the current version scope without recreating the saver", async () => {
    let writes = 0;
    const session = setup(async (input, init) => {
      writes++;
      return Response.json(await new Request(input, init).json());
    });
    const initial = session.tagLifecycle.captureScope();
    if (!initial) throw new Error("Missing fixture scope");
    session.tagLifecycle.bind({
      ...initial,
      version: "0.29.4",
      versionFresh: true,
    });
    const next = parsePolicy('{"acls":[],"groups":{"group:ops":["bob@"]}}');
    session.policy.commitState(next);
    expect(await session.savePolicy("save-policy", next)).toEqual({
      ok: true,
      hasNewerEdits: false,
    });
    expect(writes).toBe(1);
  });

  test("a version change while the pre-read is pending retires that save confirmation", async () => {
    const response = Promise.withResolvers<Response>();
    const methods: string[] = [];
    const session = setup(async (input, init) => {
      const request = new Request(input, init);
      methods.push(request.method);
      return request.method === "GET"
        ? response.promise
        : Response.json(await request.json());
    }, true);
    const baseline = session.policy.getSnapshot().policyDraft;
    const saving = session.savePolicy(
      "save-policy",
      session.policy.policyDesignerState,
    );
    await expect.poll(() => methods).toEqual(["GET"]);
    const initial = session.tagLifecycle.captureScope();
    if (!initial) throw new Error("Missing fixture scope");
    session.tagLifecycle.bind({
      ...initial,
      version: "0.29.4",
      versionFresh: true,
    });
    response.resolve(Response.json({ policy: baseline }));
    expect(await saving).toEqual({ ok: false });
    expect(methods).toEqual(["GET"]);
    expect(session.policy.isPolicySaving).toBe(false);
  });
  test("a version change during dispatch cannot adopt that old confirmed response", async () => {
    const response = Promise.withResolvers<Response>();
    let dispatched = false;
    const session = setup(async () => {
      dispatched = true;
      return response.promise;
    });
    const baseline = session.policy.getSnapshot().policyDraft;
    const next = parsePolicy('{"acls":[],"tagOwners":{"tag:new":[]}}');
    session.policy.commitState(next);
    const saving = session.savePolicy("save-policy", next);
    await expect.poll(() => dispatched).toBe(true);
    const scope = session.tagLifecycle.captureScope();
    if (!scope) throw new Error("Missing fixture scope");
    session.tagLifecycle.bind({
      ...scope,
      version: "0.29.5",
      versionFresh: true,
    });
    response.resolve(
      Response.json({ policy: '{"acls":[],"tagOwners":{"tag:new":[]}}' }),
    );
    expect(await saving).toEqual({ ok: false });
    expect(session.policy.getSnapshot().policyDraft).toBe(baseline);
    expect(session.policy.isPolicyDirty).toBe(true);
  });

  test.each([
    [
      "ACL-only",
      '{"acls":[{"action":"accept","src":["bob@"],"dst":["*:443"]}],"groups":{"group:ops":["alice@"]}}',
    ],
    [
      "comment-only",
      '{/* external operational note */"acls":[],"groups":{"group:ops":["alice@"]}}',
    ],
  ])(
    "actively reads and refuses an unseen %s remote change before publication",
    async (_kind, remote) => {
      const methods: string[] = [];
      const session = setup(async (input, init) => {
        const request = new Request(input, init);
        methods.push(request.method);
        return request.method === "GET"
          ? Response.json({ policy: remote })
          : Response.json(await request.json());
      }, true);
      const baseline = session.policy.getSnapshot().policyDraft;
      const next = parsePolicy('{"acls":[],"groups":{"group:ops":["local@"]}}');
      session.policy.commitState(next);
      expect(await session.savePolicy("save-policy", next)).toEqual({
        ok: false,
      });
      expect(methods).toEqual(["GET"]);
      expect(session.policy.getSnapshot().policyDraft).toBe(baseline);
      expect(session.policy.policyPayload?.groups).toEqual({
        "group:ops": ["local@"],
      });
      expect(session.policy.isPolicySaving).toBe(false);
    },
  );

  test("a failed publication pre-read never sends a policy write and retains the draft", async () => {
    const methods: string[] = [];
    const session = setup(async (input, init) => {
      const request = new Request(input, init);
      methods.push(request.method);
      return request.method === "GET"
        ? Response.json({ message: "policy read unavailable" }, { status: 503 })
        : Response.json(await request.json());
    }, true);
    const next = parsePolicy('{"acls":[],"groups":{"group:ops":["local@"]}}');
    session.policy.commitState(next);
    expect(await session.savePolicy("save-policy", next)).toEqual({
      ok: false,
    });
    expect(methods).toEqual(["GET"]);
    expect(session.policy.isPolicyDirty).toBe(true);
    expect(session.feedback.actionError("save-policy")).not.toBe("");
  });

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
      session.setRemote(currentBaseline);
      expect(await session.savePolicy("save-policy", obsoleteState)).toEqual({
        ok: false,
      });
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
    expect(
      await session.savePolicy(
        "save-policy",
        session.policy.policyDesignerState,
      ),
    ).toEqual({
      ok: false,
    });
    expect(calls).toBe(0);
    expect(session.policy.isPolicySaving).toBe(false);
  });
  test("an unconfirmed save reports its failure and keeps the draft without returning a write record", async () => {
    const session = setup(async () =>
      Response.json({ message: "source unavailable" }, { status: 500 }),
    );
    const next = parsePolicy('{"acls":[],"groups":{"group:ops":["bob@"]}}');
    session.policy.commitState(next);
    expect(await session.savePolicy("save-policy", next)).toEqual({
      ok: false,
    });
    expect(session.feedback.actionError("save-policy")).toBe(
      "source unavailable",
    );
    expect(session.feedback.actionOutcome("save-policy")).toMatchObject({
      status: "possibly-applied",
      failure: { message: "source unavailable" },
    });
    expect(session.policy.isPolicyDirty).toBe(true);
  });

  test("adopts the server accepted text and structure without closing an active editor", async () => {
    const accepted = '{"groups":{"group:ops":["alice@","bob@"]},"acls":[]}';
    const session = setup(async () => Response.json({ policy: accepted }));
    session.policy.setState({
      teamDetailOpen: true,
      teamDetailCurrent: "group:ops",
    });
    expect(
      await session.savePolicy(
        "save-policy",
        session.policy.policyDesignerState,
      ),
    ).toEqual({
      ok: true,
      hasNewerEdits: false,
    });
    expect(session.policy.getSnapshot().policyDraft).toBe(accepted);
    expect(session.snapshot.getSnapshot().snapshot.policy?.policy).toBe(
      accepted,
    );
    expect(session.policy.policyPayload?.groups).toEqual({
      "group:ops": ["alice@", "bob@"],
    });
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
    const saving = session.savePolicy(
      "save-policy",
      session.policy.policyDesignerState,
    );
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
    expect(session.policy.policyPayload?.groups).toEqual({
      "group:ops": ["alice@", "newer@"],
    });
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
    expect(
      await session.savePolicy("assign-user-tags", parsePolicy('{"acls":[]}')),
    ).toEqual({
      ok: false,
    });
    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0]).not.toContain("mutated-after-submit");
    response.resolve(Response.json({ policy: bodies[0] }));
    await saving;
    expect(session.policy.policyPayload?.groups).toEqual({
      "group:ops": ["alice@"],
    });
    expect(bodies).toHaveLength(1);
  });

  test("an explicit pre-rejection retains the draft and allows a new reviewed operation", async () => {
    const bodies: string[] = [];
    const session = setup(async (input, init) => {
      const body = await new Request(input, init).json();
      bodies.push(body.policy);
      return bodies.length === 1
        ? Response.json(
            { message: "update is disabled for modes other than 'database'" },
            { status: 400 },
          )
        : Response.json(body);
    });
    const baseline = session.policy.getSnapshot().policyDraft;
    const next = parsePolicy('{"acls":[],"groups":{"group:ops":["bob@"]}}');
    session.policy.commitState(next);
    expect(await session.savePolicy("save-policy", next)).toEqual({
      ok: false,
    });
    expect(session.policy.getSnapshot().policyDraft).toBe(baseline);
    expect(session.policy.policyPayload?.groups).toEqual({
      "group:ops": ["bob@"],
    });
    expect(session.policy.isPolicyDirty).toBe(true);
    expect(session.feedback.actionError("save-policy")).toBe(
      i18n._(productDescriptors.policyUpdateDisabled),
    );
    expect((await session.savePolicy("save-policy", next)).ok).toBe(true);
    expect(bodies[0]).toBe(bodies[1]);
  });

  test("an old session response cannot accept data or release the new pending ticket", async () => {
    const replies = [
      Promise.withResolvers<Response>(),
      Promise.withResolvers<Response>(),
    ];
    let calls = 0;
    const session = setup(async () => replies[calls++].promise);
    const old = session.savePolicy(
      "save-policy",
      session.policy.policyDesignerState,
    );
    await expect.poll(() => calls).toBe(1);
    session.snapshot.setAuthorized(false);
    session.policy.load('{"acls":[],"groups":{"group:new":["new@"]}}');
    session.setRemote(session.policy.getSnapshot().policyDraft);
    session.snapshot.setAuthorized(true);
    session.snapshot.applyPatch({
      policy: { policy: session.policy.getSnapshot().policyDraft },
    });
    const current = createPolicySave(session).savePolicy(
      "save-policy",
      session.policy.policyDesignerState,
    );
    await expect.poll(() => calls).toBe(2);
    replies[0].resolve(Response.json({ policy: '{"acls":[]}' }));
    expect(await old).toEqual({ ok: false });
    expect(session.policy.isPolicySaving).toBe(true);
    expect(session.policy.policyPayload?.groups).toEqual({
      "group:new": ["new@"],
    });
    replies[1].resolve(
      Response.json({ policy: '{"acls":[],"groups":{"group:new":["new@"]}}' }),
    );
    expect((await current).ok).toBe(true);
    expect(session.policy.isPolicySaving).toBe(false);
  });

  test("observed formatting, comments and object key order changes refuse a whole-document overwrite", async () => {
    const bodies: string[] = [];
    const session = setup(async (input, init) => {
      const body = await new Request(input, init).json();
      bodies.push(body.policy);
      return Response.json(body);
    });
    session.policy.load(
      '{"acls":[],"groups":{"group:a":["alice@"],"group:b":["bob@"]},"custom":{"enabled":true,"optional":null,"nested":{"a":1,"b":2}}}',
    );
    session.snapshot.applyPatch({
      policy: {
        policy: `{
      // Same document, different HuJSON formatting and key order.
      "custom": {"nested":{"b":2,"a":1},"optional":null,"enabled":true},
      "groups": {"group:b":["bob@"],"group:a":["alice@"]}, "acls":[],
    }`,
      },
    });
    const next = parsePolicy(
      '{"acls":[],"groups":{"group:a":["alice@","new@"],"group:b":["bob@"]},"custom":{"enabled":true,"optional":null,"nested":{"a":1,"b":2}}}',
    );
    session.policy.commitState(next);
    expect(await session.savePolicy("save-policy", next)).toEqual({
      ok: false,
    });
    expect(bodies).toEqual([]);
    expect(session.policy.policyPayload?.groups).toMatchObject({
      "group:a": ["alice@", "new@"],
    });
    expect(session.feedback.actionError("save-policy")).toBe(
      i18n._(productDescriptors.policySaveConflict),
    );
  });

  test.each([
    '{"acls":[',
    '{"acls":[],"grants":[{"src":["new@"],"dst":["*"],"ip":["*"]}]}',
  ])(
    "an observed unreadable or changed policy is not overwritten: %s",
    async (remote) => {
      let calls = 0;
      const session = setup(async () => {
        calls++;
        return Response.json({ policy: "" });
      });
      session.snapshot.applyPatch({ policy: { policy: remote } });
      expect(
        await session.savePolicy(
          "save-policy",
          session.policy.policyDesignerState,
        ),
      ).toEqual({
        ok: false,
      });
      expect(calls).toBe(0);
      expect(session.policy.isPolicySaving).toBe(false);
    },
  );

  test("unreadable and unserializable submissions never send a request", async () => {
    let calls = 0;
    const session = setup(async () => {
      calls++;
      return Response.json({ policy: "" });
    });
    session.policy.load('{"acls":[');
    expect(
      await session.savePolicy("save-policy", parsePolicy('{"acls":[]}')),
    ).toEqual({
      ok: false,
    });
    session.policy.load('{"acls":[]}');
    expect(
      await session.savePolicy("save-policy", parsePolicy('{"acls":[')),
    ).toEqual({
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
        await session.savePolicy(
          "save-policy",
          session.policy.policyDesignerState,
          {
            targeted: true,
          },
        ),
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
        await session.savePolicy(
          "save-policy",
          session.policy.policyDesignerState,
          {
            targeted: true,
          },
        ),
      ).toEqual({ ok: true, hasNewerEdits: false });
      expect(calls).toBe(1);
    });

    test("an untargeted save still publishes a dirty draft (Access contract)", async () => {
      const session = setup(async (input, init) =>
        Response.json(await new Request(input, init).json()),
      );
      edit(session);
      expect(
        await session.savePolicy(
          "save-policy",
          session.policy.policyDesignerState,
        ),
      ).toEqual({
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
      const saving = session.savePolicy(
        "save-policy",
        session.policy.policyDesignerState,
        {
          targeted: true,
        },
      );
      await expect.poll(() => submitted !== "").toBe(true);
      edit(session);
      response.resolve(Response.json({ policy: submitted }));
      expect(await saving).toEqual({ ok: true, hasNewerEdits: true });
      expect(session.policy.isPolicyDirty).toBe(true);
    });
  });
});
