import { createClient, withEndpoint, withHTTPHandle } from "@defjs/core";
import { I18nProvider } from "@lingui/react";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { i18n } from "@/i18n";
import { productDescriptors } from "@/i18n/descriptors";
import { fixtureSession } from "@/test/dispatch-fixture";
import { snapshotFixture } from "@/test-utils/headscale.test";
import { type Session, SessionContext } from "./session-context";
import { createSessionDrafts } from "./session-drafts";
import { createTagLifecycleStore } from "./tag-lifecycle-state";
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

function Capture({
  onCreate,
}: {
  onCreate: (create: ReturnType<typeof useCreatePreAuthKey>) => void;
}) {
  onCreate(useCreatePreAuthKey());
  return null;
}

function setup(
  respond: (body: unknown) => Response | Promise<Response>,
  read?: (path: string) => Response | undefined | Promise<Response | undefined>,
) {
  const bodies: unknown[] = [];
  const fixture = snapshotFixture();
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
      const overridden = await read?.(path);
      if (overridden) return overridden;
      const reads: Record<string, unknown> = {
        "/api/v1/user": { users: fixture.users },
        "/api/v1/node": { nodes: fixture.nodes },
        "/api/v1/health": fixture.health,
        "/version": fixture.version,
        "/api/v1/apikey": { apiKeys: [] },
        "/api/v1/preauthkey": { preAuthKeys: fixture.preAuthKeys },
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
  const tagLifecycle = createTagLifecycleStore();
  tagLifecycle.bind({
    profileId: "test-profile",
    baseUrl: "https://headscale.test",
    workerId: "test-worker",
    sessionId: "test-session",
    viewEpoch: 0,
    version: "0.29.4",
    versionFresh: true,
  });
  const session = {
    feedback,
    auth,
    client,
    snapshot,
    drafts: createSessionDrafts(),
    deviceSetup,
    tagLifecycle,
  } as Session;
  let create: ReturnType<typeof useCreatePreAuthKey> | undefined;
  renderToString(
    createElement(
      I18nProvider,
      { i18n },
      createElement(
        SessionContext.Provider,
        { value: session },
        createElement(Capture, {
          onCreate: (value) => {
            create = value;
          },
        }),
      ),
    ),
  );
  if (!create) throw new Error("hook did not render");
  return {
    create,
    deviceSetup,
    feedback,
    bodies,
    tagLifecycle,
    snapshot,
    fixture,
    drafts: session.drafts,
    session,
  };
}

describe("useCreatePreAuthKey", () => {
  test("stores the created key and requests a one-shot reveal", async () => {
    const { create, deviceSetup, bodies } = setup(() =>
      Response.json({
        preAuthKey: {
          id: "9",
          key: "new-secret",
          user: { id: "1", name: "alice" },
        },
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
      Response.json({
        preAuthKey: { id: "9", key: "tagged", aclTags: ["tag:server"] },
      }),
    );
    const { user: _owner, ...tagOnly } = {
      ...payload,
      aclTags: ["tag:server"],
    };
    expect(await create(tagOnly)).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty("user");
    expect(bodies[0]).toMatchObject({ aclTags: ["tag:server"] });
  });

  // The listing only returns masked keys, so dropping the previous secret on a failed attempt loses it for good.
  test("keeps the previous one-time key when creation fails", async () => {
    const { create, deviceSetup, feedback } = setup(() =>
      Response.json(
        { code: 3, message: "denied", details: [] },
        { status: 400 },
      ),
    );
    deviceSetup.setState({ lastCreatedInvite: "old" });
    const seen: string[] = [];
    deviceSetup.subscribe(() =>
      seen.push(deviceSetup.getSnapshot().lastCreatedInvite),
    );
    expect(await create(payload)).toBe(false);
    expect(seen).toEqual([]);
    expect(deviceSetup.getSnapshot()).toMatchObject({
      lastCreatedInvite: "old",
      revealCreatedInvite: false,
    });
    expect(feedback.actionError("create-invite")).not.toBe("");
  });

  test("a lost creation response sends once and permits another ordinary explicit submit", async () => {
    const { create, bodies, deviceSetup, feedback } = setup(() => {
      throw new TypeError("Creation response lost");
    });
    deviceSetup.setState({ lastCreatedInvite: "previous-one-time-secret" });
    expect(await create(payload)).toBe(false);
    expect(bodies).toHaveLength(1);
    expect(feedback.actionOutcome("create-invite")?.status).toBe("unknown");
    expect(feedback.actionError("create-invite")).not.toBe("");
    expect(await create(payload)).toBe(false);
    expect(bodies).toHaveLength(2);
    expect(deviceSetup.getSnapshot().lastCreatedInvite).toBe(
      "previous-one-time-secret",
    );
  });

  test("does not create for a chosen user renamed during the pre-creation identity read", async () => {
    const ctx = setup(() =>
      Response.json({ preAuthKey: { id: "9", key: "wrong-user-key" } }),
    );
    await ctx.snapshot.refreshSegments(["identity"]);
    ctx.fixture.users = ctx.fixture.users.map((user) =>
      user.id === payload.user
        ? { ...user, name: "renamed-after-selection" }
        : user,
    );
    expect(await ctx.create(payload)).toBe(false);
    expect(ctx.bodies).toEqual([]);
    expect(ctx.feedback.actionError("create-invite")).not.toBe("");
  });

  test("a failed pre-creation inventory read never posts or destroys the previous secret", async () => {
    const ctx = setup(
      () => Response.json({ preAuthKey: { key: "must-not-create" } }),
      (path) =>
        path === "/api/v1/preauthkey"
          ? Response.json({ message: "inventory unavailable" }, { status: 503 })
          : undefined,
    );
    ctx.deviceSetup.setState({ lastCreatedInvite: "previous-secret" });
    expect(await ctx.create(payload)).toBe(false);
    expect(ctx.bodies).toEqual([]);
    expect(ctx.deviceSetup.getSnapshot().lastCreatedInvite).toBe(
      "previous-secret",
    );
    expect(ctx.feedback.actionError("create-invite")).not.toBe("");
  });

  test("a missing selected user blocks the request after refreshing identity", async () => {
    const ctx = setup(() =>
      Response.json({ preAuthKey: { key: "must-not-create" } }),
    );
    ctx.fixture.users = [];
    expect(await ctx.create(payload)).toBe(false);
    expect(ctx.bodies).toEqual([]);
  });

  test.each(["scope", "draft"] as const)(
    "a stale %s cannot start creation",
    async (kind) => {
      const ctx = setup(() =>
        Response.json({ preAuthKey: { key: "must-not-create" } }),
      );
      if (kind === "scope") ctx.tagLifecycle.bind(null);
      else ctx.drafts.hold({ id: "previous", name: "Previous server" }, true);
      expect(await ctx.create(payload)).toBe(false);
      expect(ctx.bodies).toEqual([]);
    },
  );

  test("a different already-pending creation blocks this hook", async () => {
    const gate = Promise.withResolvers<void>();
    const ctx = setup(() =>
      Response.json({ preAuthKey: { key: "must-not-create" } }),
    );
    const pending = ctx.feedback.runAction("create-invite", () => gate.promise);
    try {
      expect(await ctx.create(payload)).toBe(false);
      expect(ctx.bodies).toEqual([]);
    } finally {
      gate.resolve();
    }
    await pending;
  });

  test("concurrent submits share one preparation and issue only one creation", async () => {
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const ctx = setup(
      () => Response.json({ preAuthKey: { id: "9", key: "once" } }),
      async (path) => {
        if (path === "/api/v1/preauthkey") {
          entered.resolve();
          await gate.promise;
        }
        return undefined;
      },
    );
    const pending = ctx.create(payload);
    await entered.promise;
    try {
      expect(await ctx.create(payload)).toBe(false);
      expect(ctx.bodies).toEqual([]);
    } finally {
      gate.resolve();
    }
    expect(await pending).toBe(true);
    expect(ctx.bodies).toHaveLength(1);
  });

  test.each(["version", "draft"] as const)(
    "%s invalidation during the pre-read cannot dispatch creation",
    async (kind) => {
      const entered = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      const ctx = setup(
        () => Response.json({ preAuthKey: { key: "must-not-create" } }),
        async (path) => {
          if (path === "/api/v1/preauthkey") {
            entered.resolve();
            await gate.promise;
          }
          return undefined;
        },
      );
      const pending = ctx.create(payload);
      await entered.promise;
      if (kind === "version") {
        const scope = ctx.tagLifecycle.captureScope();
        expect.assert(scope);
        ctx.tagLifecycle.bind({ ...scope, version: "0.29.5" });
      } else ctx.drafts.hold({ id: "previous", name: "Previous server" }, true);
      gate.resolve();
      expect(await pending).toBe(false);
      expect(ctx.bodies).toEqual([]);
    },
  );

  test("the next explicit creation can succeed after an unknown result without a release step", async () => {
    let first = true;
    const ctx = setup(() => {
      if (first) {
        first = false;
        throw new TypeError("Response lost");
      }
      return Response.json({
        preAuthKey: { id: "10", key: "new-operation-secret" },
      });
    });
    expect(await ctx.create(payload)).toBe(false);
    expect(ctx.feedback.actionOutcome("create-invite")?.status).toBe("unknown");
    expect(ctx.bodies).toHaveLength(1);
    expect(await ctx.create(payload)).toBe(true);
    expect(ctx.bodies).toHaveLength(2);
    expect(ctx.feedback.actionOutcome("create-invite")?.status).toBe(
      "confirmed",
    );
    expect(ctx.deviceSetup.getSnapshot().lastCreatedInvite).toBe(
      "new-operation-secret",
    );
  });

  test("known tag validation rejection remains retryable rather than inventing an uncertain creation", async () => {
    const ctx = setup(() =>
      Response.json(
        { code: 3, message: "tag must start with the string 'tag:'" },
        { status: 400 },
      ),
    );
    const add = vi.spyOn(ctx.feedback.toastManager, "add");
    expect(await ctx.create(payload)).toBe(false);
    expect(ctx.feedback.actionOutcome("create-invite")?.status).toBe(
      "pre-rejected",
    );
    expect(add).not.toHaveBeenCalled();
    expect(await ctx.create(payload)).toBe(false);
    expect(ctx.bodies).toHaveLength(2);
  });

  test("a confirmed creation keeps its secret even when the following inventory read fails", async () => {
    let written = false;
    const ctx = setup(
      () => {
        written = true;
        return Response.json({
          preAuthKey: { id: "9", key: "confirmed-secret" },
        });
      },
      (path) =>
        written && path === "/api/v1/preauthkey"
          ? Response.json({ message: "post-read unavailable" }, { status: 503 })
          : undefined,
    );
    expect(await ctx.create(payload)).toBe(true);
    expect(ctx.deviceSetup.getSnapshot().lastCreatedInvite).toBe(
      "confirmed-secret",
    );
    expect(ctx.feedback.actionOutcome("create-invite")).toMatchObject({
      status: "confirmed",
      refresh: "failed",
    });
    expect(ctx.bodies).toHaveLength(1);
  });

  test("an unrelated fabric failure after a confirmed creation is not reported as an inventory failure", async () => {
    let written = false;
    const ctx = setup(
      () => {
        written = true;
        return Response.json({
          preAuthKey: { id: "9", key: "confirmed-secret" },
        });
      },
      (path) =>
        written && path === "/api/v1/node"
          ? Response.json({ message: "fabric unavailable" }, { status: 503 })
          : undefined,
    );
    const add = vi.spyOn(ctx.feedback.toastManager, "add");
    expect(await ctx.create(payload)).toBe(true);
    expect(ctx.feedback.actionOutcome("create-invite")).toMatchObject({
      status: "confirmed",
      refresh: "failed",
    });
    expect(add).not.toHaveBeenCalled();
    expect(ctx.deviceSetup.getSnapshot().lastCreatedInvite).toBe(
      "confirmed-secret",
    );
  });

  test("an unrelated fabric failure does not erase an unknown creation or the refreshed key list", async () => {
    let written = false;
    const ctx = setup(
      () => {
        written = true;
        throw new TypeError("lost create response");
      },
      (path) =>
        written && path === "/api/v1/node"
          ? Response.json({ message: "fabric unavailable" }, { status: 503 })
          : undefined,
    );
    const add = vi.spyOn(ctx.feedback.toastManager, "add");
    expect(await ctx.create(payload)).toBe(false);
    expect(ctx.feedback.actionOutcome("create-invite")?.status).toBe("unknown");
    expect(ctx.snapshot.getSnapshot().segmentStatus.identity).toBe("ready");
    expect(
      ctx.snapshot.getSnapshot().snapshot.preAuthKeys.map((key) => key.id),
    ).toContain("1");
    expect(ctx.bodies).toHaveLength(1);
    expect(add).not.toHaveBeenCalled();
  });

  test("an unknown response followed by a failed read retains the previous list without claiming absence", async () => {
    let written = false;
    const ctx = setup(
      () => {
        written = true;
        throw new TypeError("lost create response");
      },
      (path) =>
        written && path === "/api/v1/preauthkey"
          ? Response.json({ message: "post-read unavailable" }, { status: 503 })
          : undefined,
    );
    expect(await ctx.create(payload)).toBe(false);
    expect(ctx.feedback.actionOutcome("create-invite")).toMatchObject({
      status: "unknown",
      refresh: "failed",
    });
    expect(ctx.snapshot.getSnapshot().refreshErrors.identity).toBeTruthy();
    expect(
      ctx.snapshot.getSnapshot().snapshot.preAuthKeys.map((key) => key.id),
    ).toEqual(["1"]);
    expect(ctx.bodies).toHaveLength(1);
  });

  test("reports the create-invite action as pending until the server answers", async () => {
    const gate = Promise.withResolvers<void>();
    const { create, deviceSetup, feedback } = setup(async () => {
      await gate.promise;
      return Response.json({ preAuthKey: { id: "9", key: "late" } });
    });
    const creating = create(payload);
    await expect
      .poll(() => feedback.isActionPending("create-invite"))
      .toBe(true);
    expect(deviceSetup.getSnapshot().revealCreatedInvite).toBe(false);
    gate.resolve();
    expect(await creating).toBe(true);
    expect(feedback.isActionPending("create-invite")).toBe(false);
    expect(deviceSetup.getSnapshot().lastCreatedInvite).toBe("late");
  });

  test("a confirmed creation keeps the one-time key out of notifications", async () => {
    const ctx = setup(() =>
      Response.json({
        preAuthKey: {
          id: "9",
          key: "created-secret",
          user: { id: "1", name: "alice" },
        },
      }),
    );
    const add = vi.spyOn(ctx.feedback.toastManager, "add");
    expect(await ctx.create(payload)).toBe(true);
    expect(ctx.deviceSetup.getSnapshot().lastCreatedInvite).toBe(
      "created-secret",
    );
    expect(add).not.toHaveBeenCalled();
    expect(JSON.stringify(add.mock.calls)).not.toContain("created-secret");
  });

  test("repeated identity preflight failures publish separate notifications with the same text", async () => {
    const ctx = setup(
      () => Response.json({ preAuthKey: { key: "must-not-create" } }),
      (path) =>
        path === "/api/v1/preauthkey"
          ? Response.json({ message: "inventory unavailable" }, { status: 503 })
          : undefined,
    );
    const add = vi.spyOn(ctx.feedback.toastManager, "add");
    expect(await ctx.create(payload)).toBe(false);
    expect(await ctx.create(payload)).toBe(false);
    expect(ctx.bodies).toEqual([]);
    expect(ctx.deviceSetup.getSnapshot().lastCreatedInvite).toBe("");
    expect(add).toHaveBeenCalledTimes(2);
    const [first, second] = add.mock.calls.map(([toast]) => toast);
    expect(first?.title).toBe(
      i18n._(productDescriptors.inviteCreateReadFailed),
    );
    expect(second?.title).toBe(first?.title);
    expect(first?.id).not.toBe(second?.id);
    expect(first?.data).toEqual({ tone: "error" });
    expect(JSON.stringify(add.mock.calls)).not.toContain("must-not-create");
  });

  test("a renamed user during identity preflight publishes that result and does not create a key", async () => {
    const ctx = setup(() =>
      Response.json({ preAuthKey: { key: "wrong-user-key" } }),
    );
    await ctx.snapshot.refreshSegments(["identity"]);
    ctx.fixture.users = ctx.fixture.users.map((user) =>
      user.id === payload.user
        ? { ...user, name: "renamed-after-selection" }
        : user,
    );
    const add = vi.spyOn(ctx.feedback.toastManager, "add");
    expect(await ctx.create(payload)).toBe(false);
    expect(ctx.bodies).toEqual([]);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]?.[0]).toMatchObject({
      title: i18n._(productDescriptors.inviteUserUnavailable),
      data: { tone: "error" },
    });
    expect(JSON.stringify(add.mock.calls)).not.toContain("wrong-user-key");
  });

  test("a failed identity preflight replaces the previous unknown outcome without losing its one-time secret", async () => {
    let failIdentity = false;
    const ctx = setup(
      () => {
        throw new TypeError("Creation response lost");
      },
      (path) =>
        failIdentity && path === "/api/v1/preauthkey"
          ? Response.json({ message: "inventory unavailable" }, { status: 503 })
          : undefined,
    );
    ctx.deviceSetup.setState({ lastCreatedInvite: "previous-one-time-secret" });
    const add = vi.spyOn(ctx.feedback.toastManager, "add");
    expect(await ctx.create(payload)).toBe(false);
    expect(ctx.feedback.actionOutcome("create-invite")?.status).toBe("unknown");
    expect(add).not.toHaveBeenCalled();
    expect(ctx.bodies).toHaveLength(1);
    failIdentity = true;
    expect(await ctx.create(payload)).toBe(false);
    expect(ctx.bodies).toHaveLength(1);
    expect(ctx.deviceSetup.getSnapshot().lastCreatedInvite).toBe(
      "previous-one-time-secret",
    );
    expect(ctx.feedback.actionOutcome("create-invite")).toEqual({
      status: "not-dispatched",
      refresh: "not-requested",
    });
    expect(ctx.feedback.actionError("create-invite")).toBe(
      i18n._(productDescriptors.inviteCreateReadFailed),
    );
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]?.[0]).toMatchObject({
      title: i18n._(productDescriptors.inviteCreateReadFailed),
      description: undefined,
      data: { tone: "error" },
    });
    expect(add.mock.calls[0]?.[0]?.title).not.toBe(
      i18n._(productDescriptors.inviteCreateResponseUnknown),
    );
    expect(JSON.stringify(add.mock.calls)).not.toContain(
      "previous-one-time-secret",
    );
    ctx.feedback.toastManager.close(String(add.mock.calls[0]?.[0]?.id));
    failIdentity = false;
    expect(await ctx.create(payload)).toBe(false);
    expect(ctx.bodies).toHaveLength(2);
    expect(ctx.feedback.actionOutcome("create-invite")?.status).toBe("unknown");
  });

  test("G27: a newer slow inventory read cannot turn a confirmed creation into a failure notification", async () => {
    let written = false;
    let holdInventory = false;
    const policy = Promise.withResolvers<void>();
    const inventory = Promise.withResolvers<void>();
    const ctx = setup(
      () => {
        written = true;
        return Response.json({
          preAuthKey: { id: "9", key: "confirmed-secret" },
        });
      },
      async (path) => {
        if (written && path === "/api/v1/policy") await policy.promise;
        if (holdInventory && path === "/api/v1/preauthkey")
          await inventory.promise;
        return undefined;
      },
    );
    const add = vi.spyOn(ctx.feedback.toastManager, "add");
    const creation = ctx.create(payload);
    let refresh: Promise<boolean> | undefined;
    try {
      await vi.waitFor(() => {
        expect(ctx.bodies).toHaveLength(1);
        expect(ctx.snapshot.getSnapshot().segmentStatus).toMatchObject({
          identity: "ready",
          policy: "loading",
        });
      });
      holdInventory = true;
      refresh = ctx.snapshot.refreshSegments(["identity"]);
      await vi.waitFor(() => {
        expect(ctx.snapshot.getSnapshot().segmentStatus.identity).toBe(
          "loading",
        );
      });
      policy.resolve();
      expect(await creation).toBe(true);
      expect(ctx.snapshot.getSnapshot().refreshErrors.identity).toBeUndefined();
      expect(
        ctx.deviceSetup.getSnapshot().lastCreatedInvite === "confirmed-secret",
      ).toBe(true);
      expect(ctx.feedback.actionOutcome("create-invite")).toMatchObject({
        status: "confirmed",
        refresh: "succeeded",
      });
      expect(ctx.bodies).toHaveLength(1);
      expect(add).not.toHaveBeenCalled();
    } finally {
      policy.resolve();
      inventory.resolve();
      await Promise.allSettled([creation, refresh]);
    }
    expect(ctx.snapshot.getSnapshot().segmentStatus.identity).toBe("ready");
    expect(
      ctx.deviceSetup.getSnapshot().lastCreatedInvite === "confirmed-secret",
    ).toBe(true);
    expect(ctx.bodies).toHaveLength(1);
  });

  test("a confirmed creation with a failed inventory refresh publishes one warning and keeps the secret out of it", async () => {
    let written = false;
    const ctx = setup(
      () => {
        written = true;
        return Response.json({
          preAuthKey: { id: "9", key: "confirmed-secret" },
        });
      },
      (path) =>
        written && path === "/api/v1/preauthkey"
          ? Response.json({ message: "post-read unavailable" }, { status: 503 })
          : undefined,
    );
    const add = vi.spyOn(ctx.feedback.toastManager, "add");
    expect(await ctx.create(payload)).toBe(true);
    expect(ctx.deviceSetup.getSnapshot().lastCreatedInvite).toBe(
      "confirmed-secret",
    );
    expect(ctx.feedback.actionOutcome("create-invite")).toMatchObject({
      status: "confirmed",
      refresh: "failed",
    });
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]?.[0]).toMatchObject({
      title: i18n._(productDescriptors.inviteCreateConfirmedRefreshFailed),
      data: { tone: "warning" },
    });
    expect(JSON.stringify(add.mock.calls)).not.toContain("confirmed-secret");
    ctx.feedback.toastManager.close(String(add.mock.calls[0]?.[0]?.id));
    expect(ctx.feedback.actionOutcome("create-invite")).toMatchObject({
      status: "confirmed",
      refresh: "failed",
    });
    expect(ctx.deviceSetup.getSnapshot().lastCreatedInvite).toBe(
      "confirmed-secret",
    );
  });

  test("refreshing the list after an unknown creation never replays the write or changes its outcome", async () => {
    let failIdentity = false;
    const ctx = setup(
      () => {
        throw new TypeError("Creation response lost");
      },
      (path) =>
        failIdentity && path === "/api/v1/preauthkey"
          ? Response.json({ message: "inventory unavailable" }, { status: 503 })
          : undefined,
    );
    expect(await ctx.create(payload)).toBe(false);
    const originalOutcome = structuredClone(
      ctx.feedback.actionOutcome("create-invite"),
    );
    expect(originalOutcome?.status).toBe("unknown");
    expect(await ctx.snapshot.refreshSegments(["identity"])).toBe(true);
    failIdentity = true;
    expect(await ctx.snapshot.refreshSegments(["identity"])).toBe(false);
    expect(ctx.bodies).toHaveLength(1);
    expect(ctx.feedback.actionOutcome("create-invite")).toEqual(
      originalOutcome,
    );
    expect(ctx.snapshot.getSnapshot().refreshErrors.identity).toBeTruthy();
  });
});
