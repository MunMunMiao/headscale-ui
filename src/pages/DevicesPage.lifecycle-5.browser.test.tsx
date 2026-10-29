import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { getProductCopy } from "@/i18n/product-copy";
import {
  authenticateTestSession,
  AUTH_ID,
  fixtureNode,
  openRestore,
  openTags,
  setup,
} from "@/test/devices-page-lifecycle-harness";

test("first personal-to-tagged review explains the distinct non-authkey restoration route", async () => {
  const ctx = await setup();
  await openTags("2");
  await page.getByTestId("node-tags-option-tag:prod").click();
  await expect
    .element(page.getByTestId("node-tags-restore-help"))
    .toHaveTextContent(getProductCopy("en-US").restorePersonalLead);
  await expect
    .element(page.getByTestId("node-tags-restore-docs"))
    .toHaveAttribute("href", "https://headscale.net/stable/ref/tags/");
  expect(ctx.writes()).toHaveLength(0);
});

test.each(["server-switch", "leave-page"])(
  "a late recovery response after %s cannot update the current form or snapshot",
  async (change) => {
    const ctx = await setup();
    await openRestore(ctx);
    await page.getByTestId("restore-source-confirm").click();
    const release = ctx.holdWrites();
    await page.getByTestId("restore-personal-confirm").click();
    await expect.poll(() => ctx.writes().length).toBe(1);
    if (change === "server-switch") {
      await authenticateTestSession(ctx.session, "https://other.invalid");
      ctx.session.snapshot.applyPatch({ nodes: [] });
    } else await ctx.router.navigate({ to: "/access" });
    release();
    await expect
      .poll(() => ctx.session.feedback.isActionPending("register-pending-node"))
      .toBe(false);
    expect(ctx.session.deviceSetup.getSnapshot().lastRegisteredNode).toBeNull();
    if (change === "server-switch")
      expect(ctx.session.snapshot.getSnapshot().snapshot.nodes).toEqual([]);
    else
      await expect
        .element(page.getByTestId("test-route"))
        .toHaveTextContent("/access");
    expect(ctx.writes()).toHaveLength(1);
  },
);

test("a completed device A write cannot put its delayed refresh warning into a new device B editor", async () => {
  const ctx = await setup((backend) => {
    fixtureNode(backend).tags = ["tag:extra"];
  });
  await openTags();
  await page.getByTestId("node-tags-option-tag:prod").click();
  await page.getByTestId("node-tags-confirm").click();
  const finishWrite = ctx.holdWrites();
  await page.getByTestId("node-tags-apply").click();
  await expect.poll(() => ctx.writes().length).toBe(1);
  const finishRead = ctx.holdReads();
  finishWrite();
  await expect
    .element(page.getByTestId("node-tags-result"))
    .toHaveTextContent(getProductCopy("en-US").tagWriteConfirmed);
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(true);
  await page.getByTestId("node-tags-cancel").click();
  await openTags("2");
  finishRead();
  await expect.element(page.getByTestId("node-tags-search")).toBeEnabled();
  expect(document.querySelector('[data-testid="node-tags-result"]')).toBeNull();
  await page.getByTestId("node-tags-option-tag:prod").click();
  await expect.element(page.getByTestId("node-tags-confirm")).toBeEnabled();
  await page.getByTestId("node-tags-confirm").click();
  await expect
    .element(page.getByTestId("node-tags-review"))
    .toMatchTextContent("laptop");
  expect(ctx.writes()).toHaveLength(1);
});

test("reloading tags preserves selection, invalidates changed policy and recovers a failed read", async () => {
  const ctx = await setup((backend) => {
    fixtureNode(backend).tags = ["tag:extra"];
  });
  await openTags();
  await page.getByTestId("node-tags-option-tag:prod").click();
  await page.getByTestId("node-tags-retry").click();
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  await expect
    .element(page.getByTestId("node-tags-remove-tag:prod"))
    .toBeVisible();
  ctx.backend.policy = {
    policy: JSON.stringify({
      tagOwners: { "tag:prod": [], "tag:extra": [], "tag:new": [] },
    }),
  };
  await page.getByTestId("node-tags-retry").click();
  await expect
    .element(page.getByTestId("node-tags-notice"))
    .toHaveTextContent(getProductCopy("en-US").tagDecisionChanged);
  ctx.failRead("/api/v1/policy");
  await page.getByTestId("node-tags-retry").click();
  await expect.element(page.getByTestId("node-tags-read-error")).toBeVisible();
  ctx.failRead("");
  await page.getByTestId("node-tags-retry").click();
  await expect
    .element(page.getByTestId("node-tags-read-error"))
    .not.toBeInTheDocument();
  expect(ctx.writes()).toHaveLength(0);
});

test("external identity changes revoke the initial review without replacing the desired set", async () => {
  const ctx = await setup((backend) => {
    fixtureNode(backend).tags = ["tag:extra"];
  });
  await openTags();
  await page.getByTestId("node-tags-option-tag:prod").click();
  fixtureNode(ctx.backend).machineKey = "mkey:changed";
  await page.getByTestId("node-tags-confirm").click();
  await expect
    .element(page.getByTestId("node-tags-notice"))
    .toHaveTextContent(getProductCopy("en-US").tagDecisionChanged);
  expect(document.querySelector('[data-testid="node-tags-apply"]')).toBeNull();
  await expect
    .element(page.getByTestId("node-tags-remove-tag:prod"))
    .toBeVisible();
  expect(ctx.writes()).toHaveLength(0);
});

test("retained undeclared tags cannot enter a replacement until explicitly removed or defined", async () => {
  const ctx = await setup();
  await openTags();
  await page.getByTestId("node-tags-option-tag:prod").click();
  await page.getByTestId("node-tags-confirm").click();
  await expect.element(page.getByTestId("node-tags-notice")).toBeVisible();
  expect(document.querySelector('[data-testid="node-tags-apply"]')).toBeNull();
  await page.getByTestId("node-tags-define-tag:legacy").click();
  await expect
    .element(page.getByTestId("test-route"))
    .toHaveTextContent("/access");
  expect(ctx.router.state.location.search).toEqual({ tag: "tag:legacy" });
  expect(ctx.session.tagLifecycle.getSnapshot().returnTo).toMatchObject({
    source: "device",
    managedTag: "tag:legacy",
    tags: ["tag:legacy", "tag:extra", "tag:prod"],
  });
  expect(ctx.writes()).toHaveLength(0);
});

test("a canceled opening read cannot reopen the tag editor", async () => {
  const ctx = await setup();
  const release = ctx.holdReads();
  await openTags();
  await page.getByTestId("node-tags-cancel").click();
  release();
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  expect(document.querySelector('[data-testid="node-tags-dialog"]')).toBeNull();
  expect(ctx.writes()).toHaveLength(0);
});

test("browser back restores the single managing slot and revalidates a changed device baseline", async () => {
  const ctx = await setup();
  await openTags();
  await page.getByTestId("node-tags-option-tag:prod").click();
  await page.getByTestId("node-tags-manage").click();
  await expect.element(page.getByTestId("test-route")).toBeVisible();
  fixtureNode(ctx.backend).tags = ["tag:extra"];
  await ctx.router.navigate({ to: "/devices" });
  await expect
    .element(page.getByTestId("node-tags-notice"))
    .toHaveTextContent(getProductCopy("en-US").tagDecisionChanged);
  await expect
    .element(page.getByTestId("node-tags-remove-tag:legacy"))
    .toBeVisible();
  expect(ctx.session.tagLifecycle.getSnapshot().returnTo).toBeNull();
  expect(ctx.writes()).toHaveLength(0);
});

test.each(["missing-device", "unreadable-policy"])(
  "a return with %s preserves its input until explicit cancellation",
  async (cause) => {
    const ctx = await setup();
    await openTags();
    await page.getByTestId("node-tags-manage").click();
    await expect.element(page.getByTestId("test-route")).toBeVisible();
    if (cause === "missing-device") ctx.backend.nodes = [];
    else ctx.backend.policy = { policy: '{"tagOwners":' };
    await ctx.router.navigate({ to: "/devices" });
    await expect
      .element(page.getByTestId("tag-return-read-error"))
      .toBeVisible();
    expect(ctx.session.tagLifecycle.getSnapshot().returnTo).not.toBeNull();
    await page.getByTestId("tag-return-cancel").click();
    expect(ctx.session.tagLifecycle.getSnapshot().returnTo).toBeNull();
    expect(ctx.writes()).toHaveLength(0);
  },
);

test("a return canceled during its refresh cannot reopen the saved editor", async () => {
  const ctx = await setup();
  await openTags();
  await page.getByTestId("node-tags-manage").click();
  await expect.element(page.getByTestId("test-route")).toBeVisible();
  const release = ctx.holdReads();
  await ctx.router.navigate({ to: "/devices" });
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(true);
  ctx.session.tagLifecycle.cancelReturn();
  release();
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  expect(document.querySelector('[data-testid="node-tags-dialog"]')).toBeNull();
  expect(ctx.writes()).toHaveLength(0);
});

test("a failed read-only tag check keeps the selected set and original unknown outcome without replaying the write", async () => {
  const ctx = await setup((backend) => {
    fixtureNode(backend).tags = ["tag:extra"];
  });
  await openTags();
  await page.getByTestId("node-tags-option-tag:prod").click();
  await page.getByTestId("node-tags-confirm").click();
  ctx.failWrite("late policy update failed");
  await page.getByTestId("node-tags-apply").click();
  await expect.element(page.getByTestId("node-tags-error")).toBeVisible();
  const original = structuredClone(
    ctx.session.feedback.actionOutcome("node-tags"),
  );
  ctx.failRead("/api/v1/policy");
  await page.getByTestId("node-tags-reread").click();
  await expect.element(page.getByTestId("node-tags-read-error")).toBeVisible();
  await expect
    .element(page.getByTestId("node-tags-remove-tag:prod"))
    .toBeVisible();
  expect(ctx.session.feedback.actionOutcome("node-tags")).toEqual(original);
  expect(ctx.writes()).toHaveLength(1);
});

test("recovery fresh-read failure retains the unconsumed request and dispatches nothing", async () => {
  const ctx = await setup();
  await openRestore(ctx);
  await page.getByTestId("restore-source-confirm").click();
  ctx.failRead("/api/v1/user");
  await page.getByTestId("restore-personal-confirm").click();
  await expect
    .element(page.getByTestId("restore-safety-error"))
    .toHaveTextContent(getProductCopy("en-US").tagFreshReadRequired);
  await expect
    .element(page.getByTestId("restore-auth-id"))
    .toHaveValue(`https://public.example/register/${AUTH_ID}`);
  expect(ctx.writes()).toHaveLength(0);
});
