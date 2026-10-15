import { describe, expect, test } from "vitest";
import { createActionFeedbackStore } from "./useActionFeedback";

describe("useActionFeedback", () => {
  test("starts with empty feedback and clears individual action errors", () => {
    const feedback = createActionFeedbackStore();

    expect(feedback.isActionPending("create-member")).toBe(false);
    expect(feedback.actionError("create-member")).toBe("");

    feedback.setState({ actionErrors: { "create-member": "stale" } });
    feedback.clearActionFeedback("create-member");
    expect(feedback.actionError("create-member")).toBe("");
  });

  test("a failure is reported inline only and clearing it leaves keyless banners alone", async () => {
    const feedback = createActionFeedbackStore();
    feedback.setState({ lastError: "earlier" });
    for (const key of ["api-key-create", "approve-auth-request", "reject-auth-request"] as const) {
      await feedback.runAction(key, async () => {
        throw new Error(`${key} failed`);
      });
      expect(feedback.actionError(key)).toBe(`${key} failed`);
      expect(feedback.getSnapshot().lastError).toBe("");
    }

    feedback.setState({ lastError: "storage" });
    feedback.clearActionFeedback("approve-auth-request");
    expect(feedback.actionError("approve-auth-request")).toBe("");
    expect(feedback.actionError("reject-auth-request")).toBe("reject-auth-request failed");
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
    expect(await feedback.runAction("create-member", async () => 99)).toEqual({ ok: false });

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

    expect(await feedback.runAction("rename-member", async () => "ok")).toEqual({
      ok: true,
      result: "ok",
    });
    expect(feedback.actionError("rename-member")).toBe("");
    expect(feedback.getSnapshot().lastError).toBe("");
  });
});
