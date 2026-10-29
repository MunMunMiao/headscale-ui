import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { getProductCopy } from "@/i18n/product-copy";
import {
  fixtureNode,
  openTags,
  setup,
  submitTags,
} from "@/test/devices-page-lifecycle-harness";

test("a same-tick scope invalidation prevents an old Apply button from dispatching", async () => {
  const ctx = await setup((backend) => {
    fixtureNode(backend).tags = ["tag:extra"];
  });
  await openTags();
  await page.getByTestId("node-tags-option-tag:prod").click();
  const finishRead = ctx.holdReads();
  try {
    await page.getByTestId("node-tags-confirm").click();
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(true);
    await expect
      .element(page.getByTestId("node-tags-apply"))
      .not.toBeInTheDocument();
    expect(ctx.writes()).toHaveLength(0);
  } finally {
    finishRead();
  }
  await expect.element(page.getByTestId("node-tags-apply")).toBeEnabled();
  const apply = page
    .getByTestId("node-tags-apply")
    .element() as HTMLButtonElement;
  ctx.session.snapshot.applyPatch({ version: { version: "0.29.5" } });
  apply.click();
  await expect
    .element(page.getByTestId("node-tags-review"))
    .not.toBeInTheDocument();
  expect(ctx.writes()).toHaveLength(0);
});

test("Escape during the review form's fresh read retains the editor until the read completes", async () => {
  const ctx = await setup((backend) => {
    fixtureNode(backend).tags = ["tag:extra"];
  });
  await openTags();
  await page.getByTestId("node-tags-option-tag:prod").click();
  const finishRead = ctx.holdReads();
  submitTags();
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(true);
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("node-tags-dialog")).toBeVisible();
  finishRead();
  await expect.element(page.getByTestId("node-tags-review")).toBeVisible();
  expect(ctx.writes()).toHaveLength(0);
});

test("a confirmed SetTags survives a successful readback in which its node has disappeared", async () => {
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
  await expect.element(page.getByTestId("node-tags-result")).toBeVisible();
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(true);
  ctx.backend.nodes = [];
  finishRead();
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  await expect
    .element(page.getByTestId("node-tags-result"))
    .toHaveTextContent(getProductCopy("en-US").tagWriteConfirmed);
  await expect.element(page.getByTestId("node-tags-confirm")).toBeDisabled();
  expect(ctx.writes()).toHaveLength(1);
});

test("tag management cannot save a return without a readable device-policy baseline", async () => {
  const ctx = await setup((backend) => {
    backend.policy = { policy: "{" };
  });
  await openTags();
  await expect.element(page.getByTestId("node-tags-read-error")).toBeVisible();
  await page.getByTestId("node-tags-manage").click();
  await expect.element(page.getByTestId("node-tags-dialog")).toBeVisible();
  expect(ctx.router.state.location.pathname).toBe("/devices");
  expect(ctx.session.tagLifecycle.getSnapshot().returnTo).toBeNull();
  expect(ctx.writes()).toHaveLength(0);
});

test.each(["pointer", "virtual"])(
  "an ownerless setup return commits a changed expiry before leaving preferences: %s",
  async (activation) => {
    const ctx = await setup();
    await page.getByTestId("add-device-toggle").click();
    await page.getByTestId("add-linux-device").click();
    await page.getByTestId("add-device-next").click();
    await page.getByTestId("setup-owner").selectOptions("");
    const before = Date.now();
    await page.getByTestId("setup-expiration").fill("3");
    if (activation === "pointer")
      await page.getByTestId("add-device-step-preferences").click();
    else
      (
        page
          .getByTestId("add-device-step-preferences")
          .element() as HTMLButtonElement
      ).click();
    await page.getByTestId("setup-tags-manage").click();
    await expect
      .element(page.getByTestId("test-route"))
      .toHaveTextContent("/access");
    const saved = ctx.session.tagLifecycle.getSnapshot().returnTo;
    expect.assert(saved?.source === "setup");
    expect(saved.form).toMatchObject({
      userId: "",
      userName: "",
      expiryDays: "3",
    });
    expect(Date.parse(saved.form.expiration)).toBeGreaterThanOrEqual(
      before + 3 * 86400000,
    );
    expect(Date.parse(saved.form.expiration)).toBeLessThanOrEqual(
      Date.now() + 3 * 86400000,
    );
    ctx.session.tagLifecycle.requestReturn(saved.id);
    await ctx.router.navigate({ to: "/devices" });
    await expect.element(page.getByTestId("setup-device-step")).toBeVisible();
    await page.getByTestId("add-device-next").click();
    await expect.element(page.getByTestId("setup-owner")).toHaveValue("");
    expect(ctx.writes()).toHaveLength(0);
  },
);

test.each(["device", "setup"])(
  "a revoked scope rejects the %s handoff without closing or saving a return",
  async (source) => {
    const ctx = await setup();
    if (source === "device") await openTags();
    else {
      await page.getByTestId("add-device-toggle").click();
      await page.getByTestId("add-linux-device").click();
    }
    const manageButton = page.getByTestId(
      source === "device" ? "node-tags-manage" : "setup-tags-manage",
    );
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
    await expect.element(manageButton).toBeEnabled();
    const manage = manageButton.element() as HTMLButtonElement;
    ctx.session.tagLifecycle.bind(null);
    manage.click();
    await expect
      .element(
        page.getByTestId(
          source === "device" ? "node-tags-dialog" : "add-device-dialog",
        ),
      )
      .toBeVisible();
    expect(ctx.router.state.location.pathname).toBe("/devices");
    expect(ctx.session.tagLifecycle.getSnapshot().returnTo).toBeNull();
    expect(ctx.writes()).toHaveLength(0);
  },
);

test("a failed device return never consumes another source slot, and retry without a slot is inert", async () => {
  const ctx = await setup();
  await openTags();
  await page.getByTestId("node-tags-manage").click();
  await expect
    .element(page.getByTestId("test-route"))
    .toHaveTextContent("/access");
  const original = ctx.session.tagLifecycle.getSnapshot().returnTo;
  expect.assert(original);
  ctx.failRead("/api/v1/policy");
  ctx.session.tagLifecycle.requestReturn(original.id);
  await ctx.router.navigate({ to: "/devices" });
  await expect.element(page.getByTestId("tag-return-read-error")).toBeVisible();
  const foreign = ctx.session.tagLifecycle.saveReturn({
    source: "invite",
    managedTag: "tag:extra",
    editVersion: 1,
    form: {
      userId: "2",
      userName: "bob",
      tags: ["tag:extra"],
      tagInput: "keep",
      reusable: false,
      ephemeral: false,
      expiration: new Date(Date.now() + 86400000).toISOString(),
      expirationMode: "preset",
      expiryDays: "1",
    },
  });
  expect.assert(foreign);
  const calls = ctx.calls.length;
  await page.getByTestId("tag-return-retry").click();
  expect(ctx.session.tagLifecycle.getSnapshot().returnTo).toEqual(foreign);
  expect(ctx.calls).toHaveLength(calls);
  const retry = page
    .getByTestId("tag-return-retry")
    .element() as HTMLButtonElement;
  ctx.session.tagLifecycle.cancelReturn(foreign.id);
  retry.click();
  await expect
    .element(page.getByTestId("tag-return-retry"))
    .not.toBeInTheDocument();
  expect(ctx.calls).toHaveLength(calls);
  expect(document.querySelector('[data-testid="node-tags-dialog"]')).toBeNull();
  expect(ctx.writes()).toHaveLength(0);
});

test("a newer return slot supersedes a held return read and optional filters default to empty", async () => {
  const ctx = await setup();
  await openTags();
  await page.getByTestId("node-tags-search").fill("old filter");
  await page.getByTestId("node-tags-manage").click();
  await expect
    .element(page.getByTestId("test-route"))
    .toHaveTextContent("/access");
  const older = ctx.session.tagLifecycle.getSnapshot().returnTo;
  expect.assert(older?.source === "device");
  const finishRead = ctx.holdReads();
  ctx.session.tagLifecycle.requestReturn(older.id);
  await ctx.router.navigate({ to: "/devices" });
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(true);
  const newer = ctx.session.tagLifecycle.saveReturn({
    ...older,
    tags: ["tag:prod"],
    filter: undefined,
  });
  expect.assert(newer);
  ctx.session.tagLifecycle.requestReturn(newer.id);
  finishRead();
  await expect.element(page.getByTestId("node-tags-dialog")).toBeVisible();
  await expect.element(page.getByTestId("node-tags-search")).toHaveValue("");
  await expect
    .element(page.getByTestId("node-tags-remove-tag:prod"))
    .toBeVisible();
  await expect
    .element(page.getByTestId("node-tags-remove-tag:legacy"))
    .not.toBeInTheDocument();
  expect(ctx.session.tagLifecycle.getSnapshot().returnTo).toBeNull();
  expect(ctx.writes()).toHaveLength(0);
});

test("explicitly migrating to an already selected identity deduplicates the target and preserves extra tags and owners", async () => {
  const ctx = await setup((backend) => {
    fixtureNode(backend).tags = ["tag:legacy", "tag:prod", "tag:extra"];
    backend.policy = {
      policy: '{"tagOwners":{"tag:prod":["bob@"],"tag:extra":[]}}',
    };
  });
  const policy = ctx.backend.policy?.policy;
  await openTags();
  await page.getByTestId("node-tags-remove-tag:legacy").click();
  await page.getByTestId("node-tags-confirm").click();
  await expect
    .element(page.getByTestId("node-tags-review"))
    .toMatchTextContent("tag:prod");
  await expect
    .element(page.getByTestId("node-tags-review"))
    .toMatchTextContent("tag:extra");
  await page.getByTestId("node-tags-apply").click();
  await expect.element(page.getByTestId("node-tags-result")).toBeVisible();
  expect(ctx.writes()).toEqual([
    {
      method: "POST",
      path: "/api/v1/node/1/tags",
      body: { tags: ["tag:prod", "tag:extra"] },
    },
  ]);
  expect(fixtureNode(ctx.backend).tags).toEqual(["tag:prod", "tag:extra"]);
  expect(ctx.backend.policy?.policy).toBe(policy);
});

test.each([0, 1, 2])(
  "removing the last proposed tag after submission and %i validation microtasks cannot review or write an empty set",
  async (microtasks) => {
    const ctx = await setup((backend) => {
      fixtureNode(backend).tags = ["tag:extra"];
    });
    await openTags();
    await page.getByTestId("node-tags-remove-tag:extra").click();
    await page.getByTestId("node-tags-option-tag:prod").click();
    const remove = page
      .getByTestId("node-tags-remove-tag:prod")
      .element() as HTMLButtonElement;
    const finishRead = ctx.holdReads();
    submitTags();
    for (let i = 0; i < microtasks; i++) await Promise.resolve();
    remove.click();
    finishRead();
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
    await expect
      .element(page.getByTestId("node-tags-remove-tag:prod"))
      .not.toBeInTheDocument();
    await expect.element(page.getByTestId("node-tags-required")).toBeVisible();
    expect(
      document.querySelector('[data-testid="node-tags-review"]'),
    ).toBeNull();
    expect(ctx.writes()).toHaveLength(0);
  },
);

test("an unchanged collection is a no-op rather than a repeated full replacement", async () => {
  const ctx = await setup((backend) => {
    fixtureNode(backend).tags = ["tag:prod", "tag:extra"];
  });
  await openTags();
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  submitTags();
  await expect.element(page.getByTestId("node-tags-notice")).toBeVisible();
  await expect
    .poll(() => ctx.session.feedback.isActionPending("node-tags"))
    .toBe(false);
  expect(ctx.writes()).toHaveLength(0);
});

test("a failed fresh policy read blocks the write and keeps selected tags", async () => {
  const ctx = await setup((backend) => {
    fixtureNode(backend).tags = ["tag:prod"];
  });
  ctx.failRead("/api/v1/policy");
  await openTags();
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  submitTags();
  await expect.element(page.getByTestId("node-tags-read-error")).toBeVisible();
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  expect(ctx.writes()).toHaveLength(0);
});
