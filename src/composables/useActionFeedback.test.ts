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

  test("clearing a key also clears the banner it produced, and only that one", async () => {
    const feedback = createActionFeedbackStore();
    await feedback.runAction("create-member", async () => {
      throw new Error("boom");
    });
    expect(feedback.getSnapshot().lastError).toBe("boom");
    feedback.clearActionFeedback("create-member");
    expect(feedback.actionError("create-member")).toBe("");
    expect(feedback.getSnapshot().lastError).toBe("");

    feedback.setState({ lastError: "storage" });
    feedback.setState({ actionErrors: { "delete-member": "other" } });
    feedback.clearActionFeedback("create-member");
    expect(feedback.getSnapshot().lastError).toBe("storage");
    feedback.clearActionFeedback("delete-member");
    expect(feedback.getSnapshot().lastError).toBe("storage");

    await feedback.runAction("create-member", async () => {
      throw new Error("first");
    });
    await feedback.runAction("save-policy", async () => {
      throw new Error("second");
    });
    feedback.clearActionFeedback("create-member");
    expect(feedback.actionError("save-policy")).toBe("second");
    expect(feedback.getSnapshot().lastError).toBe("second");
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
    expect(feedback.getSnapshot().lastError).toBe("failed");

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
