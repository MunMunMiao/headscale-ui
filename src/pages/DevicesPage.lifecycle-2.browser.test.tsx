import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { getProductCopy } from "@/i18n/product-copy";
import {
  authenticateTestSession,
  AUTH_ID,
  alice,
  bob,
  fixtureNode,
  openRestore,
  openTags,
  setup,
} from "@/test/devices-page-lifecycle-harness";

test("device management return refreshes first, restores the full selection once and never writes", async () => {
  const ctx = await setup();
  await openTags();
  await page.getByTestId("node-tags-option-tag:prod").click();
  await page.getByTestId("node-tags-search").fill("keep this filter");
  await page.getByTestId("node-tags-manage").click();
  await expect
    .element(page.getByTestId("test-route"))
    .toHaveTextContent("/access");
  const saved = ctx.session.tagLifecycle.getSnapshot().returnTo;
  expect(saved?.source).toBe("device");
  const release = ctx.holdReads();
  expect.assert(saved);
  ctx.session.tagLifecycle.requestReturn(saved.id);
  await ctx.router.navigate({ to: "/devices" });
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(true);
  expect(document.querySelector('[data-testid="node-tags-dialog"]')).toBeNull();
  release();
  await expect.element(page.getByTestId("node-tags-dialog")).toBeVisible();
  await expect
    .element(page.getByTestId("node-tags-remove-tag:legacy"))
    .toBeVisible();
  await expect
    .element(page.getByTestId("node-tags-remove-tag:extra"))
    .toBeVisible();
  await expect
    .element(page.getByTestId("node-tags-remove-tag:prod"))
    .toBeVisible();
  await expect
    .element(page.getByTestId("node-tags-search"))
    .toHaveValue("keep this filter");
  expect(ctx.session.tagLifecycle.getSnapshot().returnTo).toBeNull();
  expect(ctx.writes()).toHaveLength(0);
  await page.getByTestId("node-tags-cancel").click();
  await ctx.router.navigate({ to: "/access" });
  await ctx.router.navigate({ to: "/devices" });
  expect(document.querySelector('[data-testid="node-tags-dialog"]')).toBeNull();
});

test.each([false, true, "history"] as const)(
  "setup explicit return restores its saved source filter without overwriting newer input=%s",
  async (newer) => {
    const ctx = await setup();
    await page.getByTestId("device-search").fill("laptop");
    await page.getByTestId("add-device-toggle").click();
    await page.getByTestId("add-linux-device").click();
    await page.getByTestId("setup-tags-search").fill("tag:saved-query");
    await page.getByTestId("setup-tags-manage").click();
    await expect
      .element(page.getByTestId("test-route"))
      .toHaveTextContent("/access");
    const saved = ctx.session.tagLifecycle.getSnapshot().returnTo;
    expect.assert(saved?.source === "setup");
    expect(saved.filter).toBe("laptop");
    const finishRead = ctx.holdReads();
    ctx.session.tagLifecycle.requestReturn(saved.id);
    await ctx.router.navigate({ to: "/devices" });
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(true);
    if (newer === "history")
      ctx.router.history.replace("/devices?search=newer%20source%20filter");
    else if (newer)
      await page.getByTestId("device-search").fill("newer source filter");
    finishRead();
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
    if (newer) {
      await expect
        .element(page.getByTestId("device-search"))
        .toHaveValue("newer source filter");
      await expect
        .element(page.getByTestId("tag-return-read-error"))
        .toMatchTextContent(getProductCopy("en-US").tagReturnNewerEdit);
      expect(
        document.querySelector('[data-testid="add-device-dialog"]'),
      ).toBeNull();
      expect(ctx.session.tagLifecycle.getSnapshot().returnTo?.id).toBe(
        saved.id,
      );
      await page.getByTestId("tag-return-retry").click();
    }
    await expect
      .element(page.getByTestId("setup-tags-search"))
      .toHaveValue("tag:saved-query");
    await expect
      .element(page.getByTestId("device-search"))
      .toHaveValue("laptop");
    expect(ctx.router.state.location.search).toEqual({ search: "laptop" });
    expect(ctx.session.tagLifecycle.getSnapshot().returnTo).toBeNull();
    expect(ctx.writes()).toHaveLength(0);
  },
);

test("setup management saves every non-secret field and the actual absolute expiry before closing", async () => {
  const ctx = await setup();
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("add-linux-device").click();
  await page.getByTestId("setup-ephemeral").click();
  await page.getByTestId("setup-exit-node").click();
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("setup-owner").selectOptions("2");
  await page.getByTestId("setup-reusable").click();
  await page.getByTestId("setup-expiration").fill("12");
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("add-device-step-preferences").click();
  await page.getByTestId("setup-tags-manage").click();
  const saved = ctx.session.tagLifecycle.getSnapshot().returnTo;
  expect(saved?.source).toBe("setup");
  expect(saved).toMatchObject({
    task: "server",
    step: "preferences",
    advertiseExitNode: true,
    form: {
      userId: "2",
      userName: "bob",
      tags: ["tag:server"],
      reusable: false,
      ephemeral: true,
      expiryDays: "12",
    },
  });
  if (saved?.source !== "setup") throw new Error("Expected setup return");
  const absoluteExpiry = saved.form.expiration;
  expect(Date.parse(absoluteExpiry)).toBeGreaterThan(Date.now());
  ctx.session.tagLifecycle.requestReturn(saved.id);
  await ctx.router.navigate({ to: "/devices" });
  await expect.element(page.getByTestId("setup-device-step")).toBeVisible();
  await expect
    .element(page.getByTestId("setup-ephemeral"))
    .toHaveAttribute("aria-checked", "true");
  await page.getByTestId("add-device-next").click();
  await expect.element(page.getByTestId("setup-owner")).toHaveValue("2");
  await expect.element(page.getByTestId("setup-expiration")).toHaveValue("12");
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("generate-install-script").click();
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  expect(
    ctx.writes().filter((call) => call.path === "/api/v1/preauthkey"),
  ).toHaveLength(1);
  expect(
    ctx.writes().find((call) => call.path === "/api/v1/preauthkey")?.body
      .expiration,
  ).toBe(absoluteExpiry);
});

test("personal conversion reviews the whole set, cancel writes nothing, and unrelated activity does not invalidate confirmation", async () => {
  const ctx = await setup();
  await openTags("2");
  await page.getByTestId("node-tags-option-tag:prod").click();
  await page.getByTestId("node-tags-confirm").click();
  await expect
    .poll(() => page.getByTestId("node-tags-review").element().textContent)
    .toContain("tag:prod");
  expect(ctx.writes()).toHaveLength(0);
  await page.getByTestId("node-tags-cancel").click();
  expect(ctx.writes()).toHaveLength(0);
  await openTags("2");
  await page.getByTestId("node-tags-option-tag:prod").click();
  await page.getByTestId("node-tags-confirm").click();
  await page.getByTestId("node-tags-acknowledge").click();
  fixtureNode(ctx.backend, "2").lastSeen = "2026-10-18T22:00:00Z";
  await page.getByTestId("node-tags-apply").click();
  await expect.element(page.getByTestId("node-tags-result")).toBeVisible();
  expect(ctx.writes()).toHaveLength(1);
  expect(ctx.writes()[0]?.body).toEqual({ tags: ["tag:prod"] });
  expect(ctx.backend.nodes[1]?.user).toBeUndefined();
});

test("a late SetTags failure is non-blocking, retains the selected tags, and offers verification in the device list", async () => {
  const ctx = await setup((backend) => {
    fixtureNode(backend).tags = ["tag:extra"];
  });
  await openTags();
  await page.getByTestId("node-tags-option-tag:prod").click();
  await page.getByTestId("node-tags-confirm").click();
  ctx.failWrite("database persistence failed", true);
  await page.getByTestId("node-tags-apply").click();
  await expect
    .element(page.getByTestId("node-tags-error"))
    .toMatchTextContent(/verify.*list/i);
  await expect.element(page.getByTestId("node-tags-confirm")).toBeEnabled();
  await expect
    .element(page.getByTestId("node-tags-remove-tag:prod"))
    .toBeVisible();
  await expect
    .element(page.getByTestId("node-tags-release"))
    .not.toBeInTheDocument();
  expect(ctx.writes()).toHaveLength(1);
  await page.getByTestId("node-tags-verify").click();
  await expect
    .element(page.getByTestId("node-tags-dialog"))
    .not.toBeInTheDocument();
  expect(ctx.router.state.location.pathname).toBe("/devices");
  await openTags();
  await expect.element(page.getByTestId("node-tags-confirm")).toBeEnabled();
  expect(ctx.writes()).toHaveLength(1);
});

test("server confirmation and failed refresh are separate, with no second SetTags", async () => {
  const ctx = await setup((backend) => {
    fixtureNode(backend).tags = ["tag:extra"];
  });
  await openTags();
  await page.getByTestId("node-tags-option-tag:prod").click();
  await page.getByTestId("node-tags-confirm").click();
  ctx.failRefresh();
  await page.getByTestId("node-tags-apply").click();
  await expect
    .element(page.getByTestId("node-tags-result"))
    .toHaveTextContent(getProductCopy("en-US").tagRefreshFailed);
  await expect.element(page.getByTestId("node-tags-confirm")).toBeDisabled();
  expect(ctx.writes()).toHaveLength(1);
});

test("G02 control: a confirmed tag replacement opens recovery in the same editor without a stale baseline", async () => {
  const ctx = await setup((backend) => {
    fixtureNode(backend).tags = ["tag:prod", "tag:extra"];
  });
  await openTags();
  await page.getByTestId("node-tags-remove-tag:extra").click();
  await page.getByTestId("node-tags-confirm").click();
  await page.getByTestId("node-tags-apply").click();
  await expect.element(page.getByTestId("node-tags-result")).toBeVisible();
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  await page.getByTestId("node-tags-restore").click();
  await page.getByTestId("restore-user").selectOptions("2");
  await page.getByTestId("restore-login-server").fill("https://public.example");
  await page.getByTestId("restore-server-confirm").click();
  await page.getByTestId("restore-backup-confirm").click();
  await page.getByTestId("restore-auth-id").fill(AUTH_ID);
  await page.getByTestId("restore-source-confirm").click();
  await page.getByTestId("restore-personal-confirm").click();
  await expect
    .element(page.getByTestId("restore-result"))
    .toHaveTextContent(getProductCopy("en-US").restoreIdentityObserved);
  expect(ctx.writes()).toEqual([
    {
      method: "POST",
      path: "/api/v1/node/1/tags",
      body: { tags: ["tag:prod"] },
    },
    {
      method: "POST",
      path: "/api/v1/auth/register",
      body: { user: "bob", authId: AUTH_ID },
    },
  ]);
});

test.each(["same-id", "new-id"])(
  "explicit recovery reread renews a changed tag baseline only after new confirmations (%s)",
  async (identity) => {
    const ctx = await setup((backend) => {
      fixtureNode(backend).tags = ["tag:prod"];
      fixtureNode(backend).user = { id: "2147455555", name: "tagged-devices" };
    });
    await openRestore(ctx);
    await page.getByTestId("restore-source-confirm").click();
    const current = fixtureNode(ctx.backend);
    current.tags = ["tag:prod", "tag:extra"];
    if (identity === "new-id") current.id = "3";
    await page.getByTestId("restore-personal-confirm").click();
    await expect
      .element(page.getByTestId("restore-safety-error"))
      .toBeVisible();
    expect(ctx.writes()).toEqual([]);
    await expect
      .element(page.getByTestId("restore-auth-id"))
      .toHaveValue(`https://public.example/register/${AUTH_ID}`);
    expect(
      Boolean(document.querySelector('[data-testid="restore-readonly-check"]')),
    ).toBe(true);
    await page.getByTestId("restore-readonly-check").click();
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
    expect(ctx.writes()).toEqual([]);
    await expect
      .element(page.getByTestId("restore-baseline"))
      .toMatchTextContent(/tagged-devices.*2147455555/);
    await expect
      .element(page.getByTestId("restore-baseline"))
      .toMatchTextContent(/tag:prod/);
    await expect
      .element(page.getByTestId("restore-baseline"))
      .toMatchTextContent(/tag:extra/);
    await expect
      .element(page.getByTestId("restore-personal-confirm"))
      .toBeDisabled();
    for (const id of [
      "restore-server-confirm",
      "restore-backup-confirm",
      "restore-source-confirm",
    ]) {
      await expect.element(page.getByTestId(id)).not.toBeChecked();
      await page.getByTestId(id).click();
    }
    await page.getByTestId("restore-personal-confirm").click();
    await expect.poll(() => ctx.writes().length).toBe(1);
    expect(ctx.writes()).toEqual([
      {
        method: "POST",
        path: "/api/v1/auth/register",
        body: { user: "bob", authId: AUTH_ID },
      },
    ]);
    await expect.element(page.getByTestId("restore-auth-id")).toHaveValue("");
    expect(current.tags).toEqual([]);
    expect(current.user?.id).toBe("2");
    expect(
      JSON.stringify(ctx.session.tagLifecycle.getSnapshot()).includes(AUTH_ID),
    ).toBe(false);
  },
);

test.each(["duplicate-machine", "missing-machine"])(
  "G02 round1: final pre-read revokes a renewed baseline when its machine becomes %s",
  async (change) => {
    const ctx = await setup();
    await openRestore(ctx);
    await page.getByTestId("restore-readonly-check").click();
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
    for (const name of ["server", "backup", "source"]) {
      await expect
        .element(page.getByTestId(`restore-${name}-confirm`))
        .not.toBeChecked();
      await page.getByTestId(`restore-${name}-confirm`).click();
    }
    const release = ctx.holdReads();
    await page.getByTestId("restore-personal-confirm").click();
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(true);
    const node = fixtureNode(ctx.backend);
    if (change === "duplicate-machine")
      ctx.backend.nodes.push({ ...node, id: "3" });
    else ctx.backend.nodes = ctx.backend.nodes.filter((item) => item !== node);
    release();
    await expect
      .element(page.getByTestId("restore-readonly-check"))
      .toBeEnabled();
    expect(ctx.writes()).toHaveLength(0);
    await expect
      .element(page.getByTestId("restore-auth-id"))
      .toHaveValue(`https://public.example/register/${AUTH_ID}`);
    await expect
      .element(page.getByTestId("restore-source-confirm"))
      .not.toBeChecked();
    await page.getByTestId("restore-source-confirm").click();
    await expect
      .element(page.getByTestId("restore-personal-confirm"))
      .toBeDisabled();
    (
      page.getByTestId("pending-registration-flow").element() as HTMLFormElement
    ).requestSubmit();
    expect(ctx.writes()).toHaveLength(0);
  },
);

test.each(["/api/v1/node", "/api/v1/user"])(
  "an explicit recovery reread failing at %s keeps the request but cannot recreate approval",
  async (path) => {
    const ctx = await setup();
    await openRestore(ctx);
    await page.getByTestId("restore-source-confirm").click();
    ctx.failRead(path);
    expect(
      Boolean(document.querySelector('[data-testid="restore-readonly-check"]')),
    ).toBe(true);
    await page.getByTestId("restore-readonly-check").click();
    await expect.element(page.getByTestId("restore-read-error")).toBeVisible();
    for (const id of [
      "restore-server-confirm",
      "restore-backup-confirm",
      "restore-source-confirm",
    ]) {
      await expect.element(page.getByTestId(id)).not.toBeChecked();
      await page.getByTestId(id).click();
    }
    await expect
      .element(page.getByTestId("restore-personal-confirm"))
      .toBeDisabled();
    (
      page.getByTestId("pending-registration-flow").element() as HTMLFormElement
    ).requestSubmit();
    await expect
      .element(page.getByTestId("restore-auth-id"))
      .toHaveValue(`https://public.example/register/${AUTH_ID}`);
    expect(ctx.writes()).toEqual([]);
    ctx.failRead("");
    await page.getByTestId("restore-readonly-check").click();
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
    for (const id of [
      "restore-server-confirm",
      "restore-backup-confirm",
      "restore-source-confirm",
    ]) {
      await expect.element(page.getByTestId(id)).not.toBeChecked();
      await page.getByTestId(id).click();
    }
    await expect
      .element(page.getByTestId("restore-personal-confirm"))
      .toBeEnabled();
    await page.getByTestId("restore-personal-confirm").click();
    await expect.poll(() => ctx.writes().length).toBe(1);
  },
);

test.each([
  "missing-machine",
  "different-machine",
  "duplicate-machine",
  "different-tagged-owner",
  "already-target",
  "different-personal-owner",
])(
  "explicit recovery reread cannot authorize an unsafe or already personal baseline: %s",
  async (change) => {
    const ctx = await setup((backend) => {
      if (change === "missing-machine") delete fixtureNode(backend).machineKey;
    });
    await openRestore(ctx);
    await page.getByTestId("restore-source-confirm").click();
    const node = fixtureNode(ctx.backend);
    if (change === "different-machine") node.machineKey = "mkey:other-device";
    if (change === "duplicate-machine")
      ctx.backend.nodes.push({ ...node, id: "3" });
    if (change === "different-tagged-owner") node.user = { ...alice };
    if (change === "already-target" || change === "different-personal-owner") {
      node.tags = [];
      node.user = change === "already-target" ? { ...bob } : { ...alice };
    }
    expect(
      Boolean(document.querySelector('[data-testid="restore-readonly-check"]')),
    ).toBe(true);
    await page.getByTestId("restore-readonly-check").click();
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
    await expect
      .element(page.getByTestId("restore-result"))
      .toHaveTextContent(
        change === "already-target"
          ? getProductCopy("en-US").restoreIdentityObserved
          : getProductCopy("en-US").tagObservedConflict,
      );
    for (const id of [
      "restore-server-confirm",
      "restore-backup-confirm",
      "restore-source-confirm",
    ]) {
      await expect.element(page.getByTestId(id)).not.toBeChecked();
      await page.getByTestId(id).click();
    }
    await expect
      .element(page.getByTestId("restore-personal-confirm"))
      .toBeDisabled();
    (
      page.getByTestId("pending-registration-flow").element() as HTMLFormElement
    ).requestSubmit();
    await expect
      .element(page.getByTestId("restore-auth-id"))
      .toHaveValue(`https://public.example/register/${AUTH_ID}`);
    expect(ctx.writes()).toEqual([]);
  },
);

test.each([
  "version-ABA",
  "fresh-version",
  "view",
  "reunlock",
  "server-switch",
  "leave-page",
])(
  "an explicit recovery reread interrupted by %s cannot install a new review baseline",
  async (change) => {
    const ctx = await setup();
    await openRestore(ctx);
    await page.getByTestId("restore-source-confirm").click();
    const release = ctx.holdReads();
    expect(
      Boolean(document.querySelector('[data-testid="restore-readonly-check"]')),
    ).toBe(true);
    await page.getByTestId("restore-readonly-check").click();
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(true);
    fixtureNode(ctx.backend).tags = ["tag:prod"];
    if (change === "version-ABA") {
      ctx.session.snapshot.applyPatch({ version: { version: "0.29.5" } });
      ctx.session.snapshot.applyPatch({ version: { version: "0.29.4" } });
    } else if (change === "fresh-version")
      ctx.backend.version = { version: "0.29.5" };
    else if (change === "view") ctx.session.drafts.discard();
    else if (change === "reunlock") {
      const profile = ctx.session.profiles.getSnapshot().profiles[0];
      expect.assert(profile);
      await ctx.session.auth.lock(
        ctx.session.auth.getSessionSnapshot()?.identity ?? null,
      );
      // Unlock performs a health preflight; release after the lock invalidates the old read.
      release();
      await ctx.session.profiles.enterProfile(
        profile,
        "isolated-test-password",
      );
    } else if (change === "server-switch")
      await authenticateTestSession(ctx.session, "https://other.invalid");
    else await ctx.router.navigate({ to: "/access" });
    release();
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
    expect(ctx.writes()).toEqual([]);
    if (change === "version-ABA" || change === "fresh-version") {
      await expect
        .element(page.getByTestId("restore-readonly-check"))
        .toBeEnabled();
      await expect
        .element(page.getByTestId("restore-baseline"))
        .toMatchTextContent(/tag:legacy/);
      for (const id of [
        "restore-server-confirm",
        "restore-backup-confirm",
        "restore-source-confirm",
      ]) {
        await expect.element(page.getByTestId(id)).not.toBeChecked();
        await page.getByTestId(id).click();
      }
      await expect
        .element(page.getByTestId("restore-personal-confirm"))
        .toBeDisabled();
    } else if (change === "leave-page") {
      await expect
        .element(page.getByTestId("test-route"))
        .toHaveTextContent("/access");
      await ctx.router.navigate({ to: "/devices" });
      await userEvent.keyboard("{Escape}");
      await page.getByTestId("machine-actions-trigger-1").click();
      await page.getByTestId("restore-personal-action-1").click();
      await expect.element(page.getByTestId("restore-auth-id")).toHaveValue("");
      await expect
        .element(page.getByTestId("restore-result"))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByTestId("restore-personal-confirm"))
        .toBeDisabled();
    } else {
      expect(ctx.session.tagLifecycle.getSnapshot().returnTo).toBeNull();
      if (change === "reunlock") {
        await expect
          .element(page.getByTestId("restore-personal-dialog"))
          .not.toBeInTheDocument();
        expect(
          ctx.session.deviceSetup.getSnapshot().pendingRegistrationForm.key,
        ).toBe("");
      } else
        await expect
          .element(page.getByTestId("restore-personal-confirm"))
          .toBeDisabled();
    }
  },
);
