import { useState } from "react";
import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { t } from "@/i18n";
import type { PublicSessionSnapshot } from "@/session/types";
import { fakeAuth } from "@/test/dispatch-fixture";
import { type Session, SessionContext } from "./session-context";
import { createSessionDrafts } from "./session-drafts";
import { createActionFeedbackStore } from "./useActionFeedback";
import { createHeadscaleClientStore } from "./useHeadscaleClient";
import { useMutation } from "./useMutation";
import { createPolicyDesignerStore } from "./usePolicyDesigner";
import { usePolicySave } from "./usePolicySave";
import { createSnapshotStore, useSnapshot } from "./useSnapshot";

function current(id: string): PublicSessionSnapshot {
  return {
    status: "unlocked",
    identity: { workerId: "worker", sessionId: id },
    profile: { id, name: id, baseUrl: `https://${id}.test` },
    expiresAt: Date.now() + 1800000,
    pendingProfileId: null,
    reason: null,
    apiKeyPrefix: null,
    revision: 1,
  };
}

test("React mutation and policy hooks use the subscribed safe gateway after a session switch", async () => {
  const calls: string[] = [];
  const auth = fakeAuth({
    async execute(expected, command) {
      calls.push(`${expected.sessionId}:${command.endpoint}`);
      return command.endpoint === "setPolicy"
        ? { ok: true, value: { policy: '{"acls":[]}' } }
        : { ok: true, value: { user: { id: "1", name: expected.sessionId } } };
    },
  });
  const client = createHeadscaleClientStore();
  client.adopt(current("a"));
  const feedback = createActionFeedbackStore();
  const snapshot = createSnapshotStore(auth, client, feedback);
  const policy = createPolicyDesignerStore();
  snapshot.setAuthorized(true);
  policy.load('{"acls":[]}');
  const session = {
    auth,
    client,
    feedback,
    snapshot,
    policy,
    drafts: createSessionDrafts(),
  } as unknown as Session;
  function Controls() {
    const mutation = useMutation({ skipRefresh: true });
    const save = usePolicySave();
    const state = useSnapshot();
    const [result, setResult] = useState("");
    return (
      <>
        <span>{state.isAuthorized ? "Authorized" : "Locked"}</span>
        <button
          type="button"
          onClick={async () => {
            const saved = await mutation.mutateWith("create-member", {
              endpoint: "createUser",
              input: { name: "member" },
            });
            if (saved.ok) setResult(saved.result.user?.name ?? "");
          }}
        >
          Create
        </button>
        <button
          type="button"
          onClick={async () => {
            const saved = await save.savePolicy("save-policy", policy.policyDesignerState);
            setResult(saved.ok ? "Policy saved" : "Policy failed");
          }}
        >
          Save policy
        </button>
        <output>{result}</output>
      </>
    );
  }
  await render(
    <SessionContext.Provider value={session}>
      <Controls />
    </SessionContext.Provider>,
  );
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect.element(page.getByRole("status")).toHaveTextContent("a");
  snapshot.setAuthorized(false);
  client.adopt(current("b"));
  snapshot.setAuthorized(true);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect.element(page.getByRole("status")).toHaveTextContent("b");
  await page.getByRole("button", { name: "Save policy", exact: true }).click();
  await expect.element(page.getByRole("status")).toHaveTextContent("Policy saved");
  expect(calls).toEqual(["a:createUser", "b:createUser", "b:setPolicy"]);
});

test("locked React controls render and reject mutation and policy clicks without transport", async () => {
  let calls = 0;
  const auth = fakeAuth({
    async execute() {
      calls++;
      return { ok: false, error: { kind: "locked" } };
    },
  });
  const client = createHeadscaleClientStore();
  const feedback = createActionFeedbackStore();
  const snapshot = createSnapshotStore(auth, client, feedback);
  const policy = createPolicyDesignerStore();
  policy.load('{"acls":[]}');
  const session = {
    auth,
    client,
    feedback,
    snapshot,
    policy,
    drafts: createSessionDrafts(),
  } as unknown as Session;
  function Controls() {
    const mutation = useMutation({ skipRefresh: true });
    const policySave = usePolicySave();
    const [result, setResult] = useState("");
    return (
      <>
        <button
          type="button"
          onClick={async () => {
            const saved = await mutation.mutate("create-member", {
              endpoint: "createUser",
              input: { name: "member" },
            });
            setResult(saved ? "Created" : feedback.actionError("create-member"));
          }}
        >
          Locked create
        </button>
        <button
          type="button"
          onClick={async () => {
            const saved = await policySave.savePolicy("save-policy", policy.policyDesignerState);
            setResult(saved.ok ? "Saved" : feedback.actionError("save-policy"));
          }}
        >
          Locked policy
        </button>
        <output>{result}</output>
      </>
    );
  }
  await render(
    <SessionContext.Provider value={session}>
      <Controls />
    </SessionContext.Provider>,
  );
  await page.getByRole("button", { name: "Locked create" }).click();
  await expect.element(page.getByRole("status")).toHaveTextContent(t("sessionLocked"));
  await page.getByRole("button", { name: "Locked policy" }).click();
  await expect.element(page.getByRole("status")).toHaveTextContent(t("sessionLocked"));
  expect(policy.isPolicySaving).toBe(false);
  expect(calls).toBe(0);
});
