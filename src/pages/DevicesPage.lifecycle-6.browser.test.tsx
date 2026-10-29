import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { getProductCopy } from "@/i18n/product-copy";
import {
  authenticateTestSession,
  AUTH_ID,
  currentToasts,
  fixtureNode,
  openRestore,
  openTags,
  setup,
} from "@/test/devices-page-lifecycle-harness";

test("recovery identity changes invalidate source approval instead of registering a different baseline", async () => {
  const ctx = await setup();
  await openRestore(ctx);
  await page.getByTestId("restore-source-confirm").click();
  fixtureNode(ctx.backend).machineKey = "mkey:changed";
  await page.getByTestId("restore-personal-confirm").click();
  await expect
    .element(page.getByTestId("restore-safety-error"))
    .toHaveTextContent(getProductCopy("en-US").tagDecisionChanged);
  expect(ctx.writes()).toHaveLength(0);
});

test("recovery source approval is revoked by version ABA and re-unlock", async () => {
  const ctx = await setup();
  await openRestore(ctx);
  await page.getByTestId("restore-source-confirm").click();
  ctx.session.snapshot.applyPatch({ version: { version: "0.29.5" } });
  ctx.session.snapshot.applyPatch({ version: { version: "0.29.4" } });
  await expect
    .element(page.getByTestId("restore-safety-error"))
    .toHaveTextContent(getProductCopy("en-US").tagConfirmationStale);
  await expect
    .element(page.getByTestId("restore-source-confirm"))
    .not.toBeChecked();
  await page.getByTestId("restore-server-confirm").click();
  await page.getByTestId("restore-source-confirm").click();
  const profile = ctx.session.profiles.getSnapshot().profiles[0];
  expect.assert(profile);
  await ctx.session.profiles.enterProfile(profile, "isolated-test-password");
  await expect
    .element(page.getByTestId("restore-personal-confirm"))
    .toBeDisabled();
  expect(ctx.writes()).toHaveLength(0);
});

test.each(["missing", "still-tagged"])(
  "confirmed approval with a %s readback keeps delivery separate from identity observation",
  async (observation) => {
    const ctx = await setup();
    await openRestore(ctx);
    await page.getByTestId("restore-source-confirm").click();
    const finishWrite = ctx.holdWrites();
    await page.getByTestId("restore-personal-confirm").click();
    await expect.poll(() => ctx.writes().length).toBe(1);
    const finishRead = ctx.holdReads();
    finishWrite();
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(true);
    if (observation === "missing") ctx.backend.nodes = [];
    else {
      fixtureNode(ctx.backend).tags = ["tag:extra"];
      delete fixtureNode(ctx.backend).user;
    }
    finishRead();
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
    await expect
      .element(page.getByTestId("restore-result"))
      .toHaveTextContent(
        observation === "missing"
          ? getProductCopy("en-US").restoreUncertain
          : getProductCopy("en-US").restoreIdentityPending,
      );

    expect(ctx.writes()).toHaveLength(1);
    await expect.element(page.getByTestId("restore-auth-id")).toHaveValue("");
  },
);

test.each(["server-switch", "leave-page"])(
  "a confirmed approval interrupted during readback by %s cannot publish a late observation",
  async (change) => {
    const ctx = await setup();
    await openRestore(ctx);
    await page.getByTestId("restore-source-confirm").click();
    const finishWrite = ctx.holdWrites();
    await page.getByTestId("restore-personal-confirm").click();
    await expect.poll(() => ctx.writes().length).toBe(1);
    const finishRead = ctx.holdReads();
    finishWrite();
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(true);
    if (change === "server-switch") {
      await authenticateTestSession(ctx.session, "https://other.invalid");
      ctx.session.snapshot.applyPatch({ nodes: [] });
    } else await ctx.router.navigate({ to: "/access" });
    finishRead();
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
    if (change === "server-switch") {
      expect(
        ctx.session.deviceSetup.getSnapshot().lastRegisteredNode,
      ).toBeNull();
      expect(ctx.session.snapshot.getSnapshot().snapshot.nodes).toEqual([]);
    } else
      await expect
        .element(page.getByTestId("test-route"))
        .toHaveTextContent("/access");
    expect(ctx.writes()).toHaveLength(1);
  },
);

test("clearing the recovery target prevents a read-only check from falling back to another user", async () => {
  const ctx = await setup();
  await openRestore(ctx);
  await page.getByTestId("restore-source-confirm").click();
  ctx.loseWriteResponse();
  await page.getByTestId("restore-personal-confirm").click();
  await expect
    .element(page.getByTestId("register-pending-node-error"))
    .toBeVisible();
  await page.getByTestId("restore-user").selectOptions("");
  await expect.element(page.getByTestId("restore-user")).toHaveValue("");
  const calls = ctx.calls.length;
  await page.getByTestId("restore-readonly-check").click();
  expect(ctx.calls).toHaveLength(calls);
  expect(ctx.writes()).toHaveLength(1);
});

test("a fresh version change during recovery pre-read revokes the old approval without dispatch", async () => {
  const ctx = await setup();
  await openRestore(ctx);
  await page.getByTestId("restore-source-confirm").click();
  ctx.backend.version = { version: "0.29.5" };
  await page.getByTestId("restore-personal-confirm").click();
  await expect
    .element(page.getByTestId("restore-safety-error"))
    .toHaveTextContent(getProductCopy("en-US").tagConfirmationStale);
  await expect
    .element(page.getByTestId("restore-source-confirm"))
    .not.toBeChecked();
  expect(ctx.writes()).toHaveLength(0);
});

test("a new recovery without a machine key requires the admin to reselect the target and uses its current node ID", async () => {
  const ctx = await setup((backend) => {
    delete fixtureNode(backend).machineKey;
  });
  await openRestore(ctx);
  await page.getByTestId("restore-source-confirm").click();
  ctx.failWrite("late persistence failure");
  await page.getByTestId("restore-personal-confirm").click();
  await expect
    .element(page.getByTestId("register-pending-node-error"))
    .toBeVisible();
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("machine-actions-trigger-1").click();
  await page.getByTestId("restore-personal-action-1").click();
  await expect.element(page.getByTestId("restore-auth-id")).toHaveValue("");
  await expect
    .element(page.getByTestId("restore-personal-confirm"))
    .toBeDisabled();
  await page.getByTestId("restore-user").selectOptions("2");
  await expect
    .element(page.getByTestId("restore-target"))
    .toHaveTextContent("bob · 2");
  await page.getByTestId("restore-readonly-check").click();
  await expect
    .element(page.getByTestId("restore-result"))
    .toHaveTextContent(getProductCopy("en-US").tagObservedConflict);
  expect(ctx.writes()).toHaveLength(1);
});

test("a successful approval with a failed refresh is not retried and remains distinct from uncertain delivery", async () => {
  const ctx = await setup();
  await openRestore(ctx);
  await page.getByTestId("restore-source-confirm").click();
  ctx.failRefresh();
  await page.getByTestId("restore-personal-confirm").click();
  await expect
    .element(page.getByTestId("restore-result"))
    .toHaveTextContent(getProductCopy("en-US").restoreRefreshFailed);

  expect(ctx.writes()).toHaveLength(1);
});

test.each(["late-error", "lost-response"])(
  "a failed recovery observation after %s never confirms approval or replays the consumed Auth ID",
  async (failure) => {
    const ctx = await setup();
    await openRestore(ctx);
    await page.getByTestId("restore-source-confirm").click();
    if (failure === "late-error") ctx.failWrite("late error", true);
    else ctx.loseWriteResponse();
    await page.getByTestId("restore-personal-confirm").click();
    await expect
      .element(page.getByTestId("register-pending-node-error"))
      .toBeVisible();
    const original = structuredClone(
      ctx.session.feedback.actionOutcome("register-pending-node"),
    );
    expect(original?.status).toBe(
      failure === "late-error" ? "possibly-applied" : "unknown",
    );
    ctx.failRead("/api/v1/node");
    await page.getByTestId("restore-readonly-check").click();
    const readError = page.getByTestId("restore-read-error");
    await expect.element(readError).toBeVisible();
    await expect
      .element(readError)
      .toHaveTextContent(getProductCopy("en-US").restoreObservationFailed);
    await expect
      .element(page.getByTestId("restore-safety-error"))
      .not.toBeInTheDocument();
    await expect.poll(() => currentToasts().length).toBe(1);
    expect(currentToasts()[0]?.textContent).toContain("Could not refresh data");
    expect(
      page.getByTestId("registration-safety").element().textContent,
    ).not.toContain("Approval was confirmed");
    expect(ctx.session.feedback.actionOutcome("register-pending-node")).toEqual(
      original,
    );
    expect(
      JSON.stringify(ctx.session.tagLifecycle.getSnapshot()),
    ).not.toContain(AUTH_ID);
    expect(ctx.writes()).toHaveLength(1);
  },
);

test.each([
  ["missing", "late-error"],
  ["still-tagged", "late-error"],
  ["missing", "lost-response"],
  ["still-tagged", "lost-response"],
])(
  "read-only recovery with %s original identity after %s remains unconfirmed",
  async (observation, failure) => {
    const ctx = await setup();
    await openRestore(ctx);
    await page.getByTestId("restore-source-confirm").click();
    if (failure === "late-error") ctx.failWrite("late error");
    else ctx.loseWriteResponse();
    await page.getByTestId("restore-personal-confirm").click();
    await expect
      .element(page.getByTestId("register-pending-node-error"))
      .toBeVisible();
    const original = structuredClone(
      ctx.session.feedback.actionOutcome("register-pending-node"),
    );
    if (observation === "missing") ctx.backend.nodes = [];
    else {
      fixtureNode(ctx.backend).tags = ["tag:extra"];
      delete fixtureNode(ctx.backend).user;
    }
    await page.getByTestId("restore-readonly-check").click();
    await expect
      .element(page.getByTestId("restore-result"))
      .toHaveTextContent(getProductCopy("en-US").tagObservedConflict);
    expect(
      page.getByTestId("registration-safety").element().textContent,
    ).not.toContain("Approval was confirmed");
    expect(ctx.session.feedback.actionOutcome("register-pending-node")).toEqual(
      original,
    );
    expect(ctx.writes()).toHaveLength(1);
  },
);

test("an ephemeral recovery without machineKey uses the original node ID and keeps connectivity separate", async () => {
  const ctx = await setup((backend) => {
    const node = fixtureNode(backend);
    delete node.machineKey;
    node.preAuthKey = {
      id: "4",
      key: "masked",
      reusable: false,
      ephemeral: true,
      used: true,
      aclTags: ["tag:extra"],
    };
  });
  await openRestore(ctx);
  await page.getByTestId("restore-source-confirm").click();
  await page.getByTestId("restore-personal-confirm").click();
  await expect
    .element(page.getByTestId("restore-result"))
    .toHaveTextContent(getProductCopy("en-US").restoreIdentityObserved);
  await expect
    .element(page.getByTestId("restore-key-association"))
    .toHaveTextContent(getProductCopy("en-US").restoreAssociationCleared);
  await expect.element(page.getByTestId("restore-ephemeral")).toBeVisible();
  await expect.element(page.getByTestId("restore-connectivity")).toBeVisible();
  expect(ctx.writes()).toHaveLength(1);
});

test("mobile and last-tag guidance open the same personal recovery without a write", async () => {
  const ctx = await setup();
  await page.viewport(375, 812);
  await page.getByTestId("machine-actions-trigger-mobile-1").click();
  await page.getByTestId("restore-personal-action-mobile-1").click();
  await expect
    .element(page.getByTestId("restore-personal-dialog"))
    .toBeVisible();
  await userEvent.keyboard("{Escape}");
  await page.viewport(1366, 900);
  await openTags();
  await page.getByTestId("node-tags-restore").click();
  await expect
    .element(page.getByTestId("restore-personal-dialog"))
    .toBeVisible();
  expect(ctx.writes()).toHaveLength(0);
});
