import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { i18n, t } from "@/i18n";
import { commonDescriptors, productDescriptors } from "@/i18n/descriptors";
import { loadLocale } from "@/i18n/runtime";
import { ApiError } from "@/session/types";
import type { MutationOutcome } from "./tag-lifecycle-state";
import {
  createActionFeedbackStore,
  mutationNotification,
  type NotificationMessage,
} from "./useActionFeedback";

describe("useActionFeedback", () => {
  test("keeps confirmed refresh warnings across dialog feedback clearing but retires them on a session boundary", () => {
    const feedback = createActionFeedbackStore();
    feedback.setActionOutcome("create-invite", {
      status: "confirmed",
      refresh: "failed",
    });
    expect(feedback.actionOutcome("create-invite")).toEqual({
      status: "confirmed",
      refresh: "failed",
    });
    feedback.clearActionFeedback("create-invite");
    expect(feedback.getSnapshot().actionOutcomes["create-invite"]).toEqual({
      status: "confirmed",
      refresh: "failed",
    });
    feedback.clearAllActionFeedback();
    expect(feedback.actionOutcome("create-invite")).toBeUndefined();
  });

  test("starts with empty feedback and clears individual action errors", () => {
    const feedback = createActionFeedbackStore();

    expect(feedback.isActionPending("create-member")).toBe(false);
    expect(feedback.actionError("create-member")).toBe("");

    feedback.setState({
      actionErrors: { "create-member": { message: "stale" } },
    });
    feedback.clearActionFeedback("create-member");
    expect(feedback.actionError("create-member")).toBe("");
  });

  test("a failure is reported inline only and clearing it leaves keyless banners alone", async () => {
    const feedback = createActionFeedbackStore();
    feedback.setState({ lastError: "earlier" });
    for (const key of [
      "api-key-create",
      "approve-auth-request",
      "reject-auth-request",
    ] as const) {
      await feedback.runAction(key, async () => {
        throw new Error(`${key} failed`);
      });
      expect(feedback.actionError(key)).toBe(`${key} failed`);
      expect(feedback.getSnapshot().lastError).toBe("");
    }

    feedback.setState({ lastError: "storage" });
    feedback.clearActionFeedback("approve-auth-request");
    expect(feedback.actionError("approve-auth-request")).toBe("");
    expect(feedback.actionError("reject-auth-request")).toBe(
      "reject-auth-request failed",
    );
    expect(feedback.getSnapshot().lastError).toBe("storage");
  });

  test("returns a result and rejects re-entry while an action is pending", async () => {
    const feedback = createActionFeedbackStore();
    let resolveAction!: (value: number) => void;
    const action = new Promise<number>((resolve) => {
      resolveAction = resolve;
    });

    const pending = feedback.runAction("create-member", () => action);
    expect(feedback.isActionPending("create-member")).toBe(true);
    expect(await feedback.runAction("create-member", async () => 99)).toEqual({
      ok: false,
    });

    resolveAction(42);
    expect(await pending).toEqual({ ok: true, result: 42 });
    expect(feedback.isActionPending("create-member")).toBe(false);
  });

  test("maps thrown values, supports a custom mapper, and clears stale errors", async () => {
    const feedback = createActionFeedbackStore();

    expect(
      await feedback.runAction("create-member", async () => {
        throw new Error("failed");
      }),
    ).toEqual({ ok: false });
    expect(feedback.actionError("create-member")).toBe("failed");
    expect(feedback.getSnapshot().lastError).toBe("");

    await feedback.runAction("delete-member", async () => {
      throw 404;
    });
    expect(feedback.actionError("delete-member")).toBe("404");

    feedback.setErrorMapper(() => "friendly");
    await feedback.runAction("rename-member", async () => {
      throw new Error("hidden");
    });
    expect(feedback.actionError("rename-member")).toBe("friendly");

    expect(await feedback.runAction("rename-member", async () => "ok")).toEqual(
      {
        ok: true,
        result: "ok",
      },
    );
    expect(feedback.actionError("rename-member")).toBe("");
    expect(feedback.getSnapshot().lastError).toBe("");
  });
});

describe("current action diagnostics", () => {
  const readonlyText = "update is disabled for modes other than 'database'";
  const readonlyFailure = {
    kind: "api",
    code: "HTTP_STATUS",
    status: 400,
    message: "Headscale rejected the request",
    data: { message: readonlyText },
  } as const;
  const reject = (error: unknown) => async () => {
    throw error;
  };

  beforeEach(() => i18n.activate("en-US"));
  afterEach(() => i18n.activate("en-US"));

  test.each([
    readonlyText,
    "  Cannot save: Update is disabled for modes other than 'database'.  ",
  ])(
    "keeps the mapped diagnostic stable across a locale change: %s",
    async (message) => {
      const feedback = createActionFeedbackStore();
      await feedback.runAction(
        "save-policy",
        reject(new ApiError({ ...readonlyFailure, data: { message } })),
      );
      const original = feedback.getSnapshot().actionErrors["save-policy"];
      const english = i18n._(productDescriptors.policyUpdateDisabled);
      expect(original).toEqual({
        message: english,
        productKey: "policyUpdateDisabled",
      });
      expect(feedback.actionError("save-policy")).toBe(english);
      expect(feedback.actionErrorKey("save-policy")).toBe(
        "policyUpdateDisabled",
      );

      await loadLocale("zh-Hans");
      i18n.activate("zh-Hans");
      expect(i18n._(productDescriptors.policyUpdateDisabled)).not.toBe(english);
      expect(feedback.getSnapshot().actionErrors["save-policy"]).toBe(original);
      expect(feedback.getSnapshot().actionErrors["save-policy"]).toEqual({
        message: english,
        productKey: "policyUpdateDisabled",
      });
      expect(feedback.actionError("save-policy")).toBe(english);
      expect(feedback.actionErrorKey("save-policy")).toBe(
        "policyUpdateDisabled",
      );
    },
  );

  test.each([
    {
      name: "unknown write outcome",
      error: new ApiError({ ...readonlyFailure, outcome: "unknown" }),
      expected: () => ({ message: t("sessionOutcomeUnknown") }),
    },
    {
      name: "non-API session failure",
      error: new ApiError({ kind: "locked" }),
      expected: () => ({ message: t("sessionLocked") }),
    },
    {
      name: "401 authentication guidance",
      error: new ApiError({ ...readonlyFailure, status: 401 }),
      expected: () => ({
        message: `${i18n._(productDescriptors.errorRequestFailed)} ${readonlyText}`,
      }),
    },
    {
      name: "first matching Headscale phrase",
      error: new ApiError({
        ...readonlyFailure,
        data: { message: `${readonlyText}: user not found` },
      }),
      expected: () => ({
        message: i18n._(productDescriptors.errorUserNotFound),
        productKey: "errorUserNotFound",
      }),
    },
    {
      name: "non-HTTP transport failure",
      error: new ApiError({ ...readonlyFailure, code: "NET_TIMEOUT" }),
      expected: () => ({ message: t("requestUnreachable") }),
    },
  ])(
    "preserves mapper priority for $name without inheriting an earlier key",
    async ({ error, expected }) => {
      const feedback = createActionFeedbackStore();
      await feedback.runAction(
        "save-policy",
        reject(new ApiError(readonlyFailure)),
      );
      await feedback.runAction("save-policy", reject(error));
      expect(feedback.getSnapshot().actionErrors["save-policy"]).toEqual(
        expected(),
      );
      expect(feedback.actionError("save-policy")).toBe(expected().message);
      expect(feedback.actionErrorKey("save-policy")).toBe(
        feedback.getSnapshot().actionErrors["save-policy"]?.productKey,
      );
    },
  );

  test("a new ordinary error replaces the whole diagnostic in one store update", async () => {
    const feedback = createActionFeedbackStore();
    await feedback.runAction(
      "save-policy",
      reject(new ApiError(readonlyFailure)),
    );
    const original = feedback.getSnapshot().actionErrors["save-policy"];
    const observed: unknown[] = [];
    const stop = feedback.subscribe(() => {
      observed.push(feedback.getSnapshot().actionErrors["save-policy"]);
    });
    await feedback.runAction(
      "save-policy",
      reject(new Error("ordinary failure")),
    );
    stop();
    expect(observed).toEqual([
      original,
      undefined,
      { message: "ordinary failure" },
      { message: "ordinary failure" },
    ]);
    expect(feedback.actionError("save-policy")).toBe("ordinary failure");
  });

  test("an older outcome cannot fabricate a current diagnostic or attach its classification to a new error", async () => {
    const feedback = createActionFeedbackStore();
    const original: MutationOutcome = {
      status: "pre-rejected",
      refresh: "not-requested",
      failure: {
        kind: "api",
        code: "HTTP_STATUS",
        status: 400,
        message: i18n._(productDescriptors.policyUpdateDisabled),
      },
    };
    feedback.setActionOutcome("save-policy", original);
    expect(feedback.getSnapshot().actionErrors["save-policy"]).toBeUndefined();
    expect(feedback.actionErrorKey("save-policy")).toBeUndefined();
    await feedback.runAction("save-policy", reject(new Error("new failure")));
    expect(feedback.getSnapshot().actionErrors["save-policy"]).toEqual({
      message: "new failure",
    });
    feedback.clearActionFeedback("save-policy");
    expect(feedback.getSnapshot().actionErrors["save-policy"]).toBeUndefined();
    expect(feedback.actionErrorKey("save-policy")).toBeUndefined();
    expect(feedback.actionOutcome("save-policy")).toBe(original);
  });

  test("a custom string mapper does not reverse-classify even an identical friendly message", async () => {
    const feedback = createActionFeedbackStore();
    await feedback.runAction(
      "save-policy",
      reject(new ApiError(readonlyFailure)),
    );
    const friendly = i18n._(productDescriptors.policyUpdateDisabled);
    feedback.setErrorMapper(() => friendly);
    await feedback.runAction(
      "save-policy",
      reject(new ApiError(readonlyFailure)),
    );
    expect(feedback.getSnapshot().actionErrors["save-policy"]).toEqual({
      message: friendly,
    });
    expect(feedback.actionError("save-policy")).toBe(friendly);
    expect(feedback.actionErrorKey("save-policy")).toBeUndefined();
  });

  test("a new operation in the same store clears the entire old diagnostic before executing", async () => {
    const feedback = createActionFeedbackStore();
    await feedback.runAction(
      "save-policy",
      reject(new ApiError(readonlyFailure)),
    );
    expect(feedback.getSnapshot().actionErrors["save-policy"]).toEqual({
      message: i18n._(productDescriptors.policyUpdateDisabled),
      productKey: "policyUpdateDisabled",
    });
    const gate = Promise.withResolvers<string>();
    const action = vi.fn(() => {
      expect(
        feedback.getSnapshot().actionErrors["save-policy"],
      ).toBeUndefined();
      expect(feedback.actionErrorKey("save-policy")).toBeUndefined();
      expect(feedback.actionError("save-policy")).toBe("");
      return gate.promise;
    });
    const pending = feedback.runAction("save-policy", action);
    expect(action).toHaveBeenCalledTimes(1);
    expect(feedback.isActionPending("save-policy")).toBe(true);
    expect(feedback.getSnapshot().actionErrors["save-policy"]).toBeUndefined();
    expect(feedback.actionErrorKey("save-policy")).toBeUndefined();
    gate.resolve("reviewed operation completed");
    expect(await pending).toEqual({
      ok: true,
      result: "reviewed operation completed",
    });
    expect(feedback.getSnapshot().actionErrors["save-policy"]).toBeUndefined();
    expect(feedback.actionErrorKey("save-policy")).toBeUndefined();
  });

  test("individual clearing and session reset remove message and classification together", async () => {
    const feedback = createActionFeedbackStore();
    await feedback.runAction(
      "save-policy",
      reject(new ApiError(readonlyFailure)),
    );
    await feedback.runAction(
      "create-member",
      reject(new Error("member failure")),
    );
    expect(feedback.getSnapshot().actionErrors["save-policy"]).toEqual({
      message: i18n._(productDescriptors.policyUpdateDisabled),
      productKey: "policyUpdateDisabled",
    });
    feedback.clearActionFeedback("save-policy");
    expect(feedback.getSnapshot().actionErrors).toEqual({
      "create-member": { message: "member failure" },
    });
    expect(feedback.actionError("save-policy")).toBe("");
    await feedback.runAction(
      "save-policy",
      reject(new ApiError(readonlyFailure)),
    );
    feedback.clearAllActionFeedback();
    expect(feedback.getSnapshot()).toEqual({
      actionPending: {},
      actionErrors: {},
      actionOutcomes: {},
      lastError: "",
    });
  });
});

describe("explicit operation notifications", () => {
  beforeAll(() => {
    // Catalog extraction is a separate coordinated step, not a behavior under test here.
    i18n.load("en-US", {
      [commonDescriptors.operationFailed.id]:
        "The operation could not be completed.",
      [productDescriptors.feedbackRequestConfirmed.id]: "Request confirmed",
    });
  });
  const message: NotificationMessage = {
    tone: "success",
    title: "product.dataRefreshed",
  };

  test("adjacent explicit refresh successes carry one presentation group while retaining independent operation IDs", () => {
    const feedback = createActionFeedbackStore();
    const add = vi.spyOn(feedback.toastManager, "add");
    const first = feedback.beginNotification({ isCurrent: () => true });
    const second = feedback.beginNotification({ isCurrent: () => true });
    expect(first.publish(message)).toBe(true);
    expect(second.publish(message)).toBe(true);
    expect(add.mock.calls.map(([toast]) => toast.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(add.mock.calls.map(([toast]) => toast.data)).toEqual([
      { tone: "success", refreshGroup: first.id },
      { tone: "success", refreshGroup: first.id },
    ]);
  });

  test.each([
    { status: "pre-rejected", refresh: "not-requested", tone: "error" },
    { status: "unknown", refresh: "not-requested", tone: "warning" },
    { status: "possibly-applied", refresh: "not-requested", tone: "warning" },
    { status: "confirmed", refresh: "failed", tone: "warning" },
    { status: "confirmed", refresh: "succeeded", tone: "success" },
  ] as const)(
    "$status/$refresh write results break refresh presentation groups, even with the same title",
    ({ status, refresh, tone }) => {
      const feedback = createActionFeedbackStore();
      const add = vi.spyOn(feedback.toastManager, "add");
      const first = feedback.beginNotification({ isCurrent: () => true });
      first.publish(message);
      feedback
        .beginNotification({ isCurrent: () => true })
        .publishMutation({ status, refresh }, "product.dataRefreshed");
      const next = feedback.beginNotification({ isCurrent: () => true });
      next.publish(message);
      expect(add.mock.calls.map(([toast]) => toast.data)).toEqual([
        { tone: "success", refreshGroup: first.id },
        { tone },
        { tone: "success", refreshGroup: next.id },
      ]);
    },
  );

  test.each([
    { tone: "success", title: "common.updatedProfile" },
    { tone: "info", title: "product.dataRefreshed" },
    { tone: "warning", title: "product.dataRefreshed" },
    { tone: "error", title: "product.dataRefreshed" },
    {
      tone: "success",
      title: "product.dataRefreshed",
      description: "common.sessionOutcomeUnknown",
    },
  ] satisfies NotificationMessage[])(
    "a non-refresh $tone/$title message is not grouped and breaks adjacency",
    (barrier) => {
      const feedback = createActionFeedbackStore();
      const add = vi.spyOn(feedback.toastManager, "add");
      const first = feedback.beginNotification({ isCurrent: () => true });
      first.publish(message);
      feedback.beginNotification({ isCurrent: () => true }).publish(barrier);
      const next = feedback.beginNotification({ isCurrent: () => true });
      next.publish(message);
      expect(add.mock.calls.map(([toast]) => toast.data)).toEqual([
        { tone: "success", refreshGroup: first.id },
        { tone: barrier.tone },
        { tone: "success", refreshGroup: next.id },
      ]);
    },
  );

  test("retired and repeated publications cannot change the adjacent refresh group", () => {
    const feedback = createActionFeedbackStore();
    const add = vi.spyOn(feedback.toastManager, "add");
    const first = feedback.beginNotification({ isCurrent: () => true });
    first.publish(message);
    expect(
      first.publish({ tone: "error", title: "common.operationFailed" }),
    ).toBe(false);
    expect(
      feedback
        .beginNotification({ isCurrent: () => false })
        .publish({ tone: "error", title: "common.operationFailed" }),
    ).toBe(false);
    feedback.beginNotification({ isCurrent: () => true }).publish(message);
    expect(add.mock.calls.map(([toast]) => toast.data)).toEqual([
      { tone: "success", refreshGroup: first.id },
      { tone: "success", refreshGroup: first.id },
    ]);
  });

  test("a session clear retires the refresh group before subscribers publish a new result", () => {
    const feedback = createActionFeedbackStore();
    const add = vi.spyOn(feedback.toastManager, "add");
    const first = feedback.beginNotification({ isCurrent: () => true });
    first.publish(message);
    const next = feedback.beginNotification({ isCurrent: () => true });
    const stop = feedback.subscribe(() => next.publish(message));
    feedback.clearAllActionFeedback();
    stop();
    expect(add.mock.calls.map(([toast]) => toast.data)).toEqual([
      { tone: "success", refreshGroup: first.id },
      { tone: "success", refreshGroup: next.id },
    ]);
  });

  test("publishes once per operation, not once per translated message, including after dismissal", () => {
    const feedback = createActionFeedbackStore();
    const add = vi.spyOn(feedback.toastManager, "add");
    const first = feedback.beginNotification({ isCurrent: () => true });
    const second = feedback.beginNotification({ isCurrent: () => true });
    expect(first.id).not.toBe(second.id);
    expect(first.publish(message)).toBe(true);
    expect(first.publish(message)).toBe(false);
    feedback.toastManager.close(first.id);
    expect(first.publish(message)).toBe(false);
    expect(second.publish(message)).toBe(true);
    expect(add).toHaveBeenCalledTimes(2);
    expect(add.mock.calls.map(([value]) => value.id)).toEqual([
      first.id,
      second.id,
    ]);
  });

  test("a retired scope cannot notify, while a separate current read failure still can", () => {
    const feedback = createActionFeedbackStore();
    const add = vi.spyOn(feedback.toastManager, "add");
    let current = true;
    const old = feedback.beginNotification({ isCurrent: () => current });
    current = false;
    expect(old.publish(message)).toBe(false);
    expect(add).not.toHaveBeenCalled();
    const write = feedback.beginNotification({ isCurrent: () => true });
    expect(
      write.publishMutation({ status: "unknown", refresh: "not-requested" }),
    ).toBe(true);
    const read = feedback.beginNotification({ isCurrent: () => true });
    expect(
      read.publish({ tone: "error", title: "product.feedbackRefreshFailed" }),
    ).toBe(true);
    expect(add).toHaveBeenCalledTimes(2);
  });

  test("dismissing a toast leaves errors, unresolved outcomes and keyless feedback untouched", () => {
    const feedback = createActionFeedbackStore();
    feedback.setState({
      lastError: "storage feedback",
      actionErrors: {
        "save-policy": { message: "file mode remains read-only" },
      },
    });
    feedback.setActionOutcome("save-policy", {
      status: "possibly-applied",
      refresh: "failed",
    });
    const before = feedback.getSnapshot();
    const operation = feedback.beginNotification({ isCurrent: () => true });
    const outcome = before.actionOutcomes["save-policy"];
    expect.assert(outcome);
    expect(operation.publishMutation(outcome)).toBe(true);
    feedback.toastManager.close(operation.id);
    expect(feedback.getSnapshot()).toBe(before);
    expect(feedback.actionError("save-policy")).toBe(
      "file mode remains read-only",
    );
    expect(feedback.actionOutcome("save-policy")?.status).toBe(
      "possibly-applied",
    );
  });

  test("a session boundary closes old presentation before subscribers may publish a new result", () => {
    const feedback = createActionFeedbackStore();
    const events: string[] = [];
    vi.spyOn(feedback.toastManager, "close").mockImplementation(() =>
      events.push("close"),
    );
    vi.spyOn(feedback.toastManager, "add").mockImplementation((value) => {
      events.push("new result");
      return value.id ?? "test-notification";
    });
    const before = feedback.beginNotification({ isCurrent: () => false });
    const stop = feedback.subscribe(() => {
      feedback.beginNotification({ isCurrent: () => true }).publish(message);
    });
    feedback.clearAllActionFeedback();
    stop();
    expect(events).toEqual(["close", "new result"]);
    expect(feedback.beginNotification({ isCurrent: () => true }).id).not.toBe(
      before.id,
    );
  });

  test("only central fixed message keys reach the manager; raw descriptors and extra data never do", () => {
    i18n.activate("en-US");
    const feedback = createActionFeedbackStore();
    const add = vi.spyOn(feedback.toastManager, "add");
    const raw = "notification-secret-canary";
    const operation = feedback.beginNotification({ isCurrent: () => true });
    for (const title of [
      { id: "common.close", message: raw, values: { secret: raw } },
      "common.__proto__",
      "product.nav.__proto__",
      "product.__proto__",
      "product.dataRefreshed.extra",
      "product.nav.access.extra",
      "common.close.extra",
      "product.nav",
      raw,
      null,
    ]) {
      expect(() =>
        operation.publish({
          tone: "error",
          title,
        } as unknown as NotificationMessage),
      ).not.toThrow();
      expect(
        operation.publish({
          tone: "error",
          title,
        } as unknown as NotificationMessage),
      ).toBe(false);
    }
    expect(
      operation.publish({
        tone: "error",
        title: "common.operationFailed",
        description: { id: "common.close", message: raw },
      } as unknown as NotificationMessage),
    ).toBe(false);
    expect(operation.publish(null as unknown as NotificationMessage)).toBe(
      false,
    );
    expect(
      operation.publish({
        tone: "not-a-tone",
        title: "common.close",
      } as unknown as NotificationMessage),
    ).toBe(false);
    expect(add).not.toHaveBeenCalled();
    expect(
      operation.publish({
        tone: "info",
        title: "product.nav.access",
        description: "common.operationFailed",
        data: { authorization: raw },
        values: { secret: raw },
      } as NotificationMessage),
    ).toBe(true);
    expect(add).toHaveBeenCalledWith({
      id: operation.id,
      title: "Access controls",
      description: "The operation could not be completed.",
      priority: "low",
      data: { tone: "info" },
    });
    expect(JSON.stringify(add.mock.calls)).not.toContain(raw);
  });

  test("mutation notifications never read raw failure messages or carry outcome objects", () => {
    const feedback = createActionFeedbackStore();
    const add = vi.spyOn(feedback.toastManager, "add");
    const outcome: MutationOutcome = {
      status: "possibly-applied",
      refresh: "failed",
      failure: { kind: "api", code: "HTTP_STATUS" },
    };
    Object.defineProperty(outcome.failure, "message", {
      get() {
        throw new Error("raw failure must not be read");
      },
    });
    const operation = feedback.beginNotification({ isCurrent: () => true });
    expect(() => operation.publishMutation(outcome)).not.toThrow();
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]?.[0].data).toEqual({ tone: "warning" });
    expect(add.mock.calls[0]?.[0].description).toBe(
      "The result could not be confirmed. The server may have saved the change. Check its state before trying again.",
    );
  });

  test("existing action errors and lastError are not an automatic notification feed", async () => {
    const feedback = createActionFeedbackStore();
    const add = vi.spyOn(feedback.toastManager, "add");
    await feedback.runAction("save-policy", async () => {
      throw new Error("near-field feedback owner");
    });
    feedback.setState({ lastError: "background storage error" });
    expect(add).not.toHaveBeenCalled();
    expect(feedback.actionError("save-policy")).toBe(
      "near-field feedback owner",
    );
  });

  test("confirmed writes with failed readback keep both facts, without claiming a write failure", () => {
    const feedback = createActionFeedbackStore();
    const add = vi.spyOn(feedback.toastManager, "add");
    const operation = feedback.beginNotification({ isCurrent: () => true });
    expect(
      operation.publishMutation({ status: "confirmed", refresh: "failed" }),
    ).toBe(true);
    expect(add).toHaveBeenCalledWith({
      id: operation.id,
      title: "Request confirmed",
      description:
        "The write was confirmed, but the list refresh failed. Read again; do not resend.",
      priority: "low",
      data: { tone: "warning" },
    });
  });

  test.each([
    ["not-dispatched", "product.feedbackRequestNotSent", "error"],
    ["pre-rejected", "product.feedbackRequestRejected", "error"],
    ["possibly-applied", "product.feedbackPossiblyApplied", "warning"],
    ["unknown", "product.inviteCreateResponseUnknown", "warning"],
  ] as const)(
    "maps %s through a fixed non-secret message",
    (status, title, tone) => {
      expect(
        mutationNotification({
          status,
          refresh: "not-requested",
          failure: { kind: "api", message: "raw response must never escape" },
        }),
      ).toMatchObject({ title, tone });
    },
  );

  test("an action-specific confirmation keeps the separate readback warning", () => {
    expect(
      mutationNotification(
        { status: "confirmed", refresh: "failed" },
        "common.updatedProfile",
      ),
    ).toEqual({
      tone: "warning",
      title: "common.updatedProfile",
      description: "product.tagRefreshFailed",
    });
  });

  test.each([false, true])(
    "an old action completion cannot restore cleared feedback (reject=%s)",
    async (reject) => {
      const feedback = createActionFeedbackStore();
      const add = vi.spyOn(feedback.toastManager, "add");
      let current = true;
      let finish!: () => void;
      const waiting = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const pending = feedback.runAction(
        "save-policy",
        async () => {
          await waiting;
          if (reject) throw new Error("old scope failure");
          return "old scope success";
        },
        () => current,
      );
      current = false;
      feedback.clearAllActionFeedback();
      finish();
      expect(await pending).toEqual({ ok: false });
      expect(feedback.getSnapshot()).toEqual({
        actionPending: {},
        actionErrors: {},
        actionOutcomes: {},
        lastError: "",
      });
      expect(add).not.toHaveBeenCalled();
    },
  );

  test("silent success and non-dispatched gate results do not claim a notification", () => {
    const feedback = createActionFeedbackStore();
    const add = vi.spyOn(feedback.toastManager, "add");
    const operation = feedback.beginNotification({ isCurrent: () => true });
    expect(
      operation.publishMutation({
        status: "not-dispatched",
        refresh: "not-requested",
      }),
    ).toBe(false);
    expect(
      operation.publishMutation({ status: "confirmed", refresh: "succeeded" }),
    ).toBe(false);
    expect(add).not.toHaveBeenCalled();
    expect(
      operation.publishMutation(
        { status: "confirmed", refresh: "succeeded" },
        "product.dataRefreshed",
      ),
    ).toBe(true);
  });
});
