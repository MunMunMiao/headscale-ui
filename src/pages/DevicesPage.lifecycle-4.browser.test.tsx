import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { getProductCopy } from "@/i18n/product-copy";
import {
  authenticateTestSession,
  AUTH_ID,
  fixtureNode,
  openRestore,
  openTags,
  setup,
  submitTags,
} from "@/test/devices-page-lifecycle-harness";

test("removing the last tag offers personal recovery and never sends an empty SetTags", async () => {
  const ctx = await setup((backend) => {
    fixtureNode(backend).tags = ["tag:extra"];
  });
  await openTags();
  await page.getByTestId("node-tags-remove-tag:extra").click();
  submitTags();
  await expect.element(page.getByTestId("node-tags-required")).toBeVisible();
  await expect.element(page.getByTestId("node-tags-confirm")).toBeDisabled();
  await expect.element(page.getByTestId("node-tags-restore")).toBeVisible();
  expect(ctx.writes()).toHaveLength(0);
});

test("set equality ignores a remove-and-readd display reorder", async () => {
  const ctx = await setup((backend) => {
    fixtureNode(backend).tags = ["tag:extra", "tag:prod"];
  });
  await openTags();
  await page.getByTestId("node-tags-remove-tag:extra").click();
  await page.getByTestId("node-tags-option-tag:extra").click();
  await page.getByTestId("node-tags-confirm").click();
  await expect
    .element(page.getByTestId("node-tags-notice"))
    .toHaveTextContent(getProductCopy("en-US").tagNoChange);
  expect(ctx.writes()).toHaveLength(0);
});

test("a version change during final pre-read invalidates confirmation without replacing the selected set", async () => {
  const ctx = await setup((backend) => {
    fixtureNode(backend).tags = ["tag:extra"];
  });
  await openTags();
  await page.getByTestId("node-tags-option-tag:prod").click();
  await page.getByTestId("node-tags-confirm").click();
  await expect.element(page.getByTestId("node-tags-apply")).toBeVisible();
  ctx.backend.version = { version: "0.29.5" };
  await page.getByTestId("node-tags-apply").click();
  await expect.element(page.getByTestId("node-tags-notice")).toBeVisible();
  expect(document.querySelector('[data-testid="node-tags-apply"]')).toBeNull();
  await expect
    .element(page.getByTestId("node-tags-remove-tag:prod"))
    .toBeVisible();
  expect(ctx.writes()).toHaveLength(0);
});

test.each(["dev", "version-read-failed"])(
  "a fresh explicit confirmation permits %s rather than globally banning writes",
  async (version) => {
    const ctx = await setup((backend) => {
      fixtureNode(backend).tags = ["tag:extra"];
      if (version === "dev") backend.version = { version: "dev" };
    });
    if (version === "version-read-failed") ctx.failRead("/version");
    await openTags();
    await page.getByTestId("node-tags-option-tag:prod").click();
    await page.getByTestId("node-tags-confirm").click();
    await expect.element(page.getByTestId("node-tags-review")).toBeVisible();
    await page.getByTestId("node-tags-apply").click();
    await expect.element(page.getByTestId("node-tags-result")).toBeVisible();
    expect(ctx.writes()).toHaveLength(1);
  },
);

test.each(["reunlock", "view", "version-ABA", "server-ABA"])(
  "%s cannot resurrect an old tag confirmation",
  async (change) => {
    const ctx = await setup((backend) => {
      fixtureNode(backend).tags = ["tag:extra"];
    });
    await openTags();
    await page.getByTestId("node-tags-option-tag:prod").click();
    await page.getByTestId("node-tags-confirm").click();
    await expect.element(page.getByTestId("node-tags-apply")).toBeVisible();
    const profile = ctx.session.profiles
      .getSnapshot()
      .profiles.find((item) => item.baseUrl === "https://fixture.invalid");
    if (!profile) throw new Error("Missing fixture profile");
    if (change === "reunlock")
      await ctx.session.profiles.enterProfile(
        profile,
        "isolated-test-password",
      );
    else if (change === "view") ctx.session.drafts.discard();
    else if (change === "version-ABA") {
      ctx.session.snapshot.applyPatch({ version: { version: "0.29.5" } });
      ctx.session.snapshot.applyPatch({ version: { version: "0.29.4" } });
    } else {
      await authenticateTestSession(ctx.session, "https://other.invalid");
      await ctx.session.profiles.enterProfile(
        profile,
        "isolated-test-password",
      );
    }
    await expect.element(page.getByTestId("node-tags-notice")).toBeVisible();
    expect(
      document.querySelector('[data-testid="node-tags-apply"]'),
    ).toBeNull();
    expect(ctx.writes()).toHaveLength(0);
  },
);

test("an expired restored absolute expiry remains expired until an explicit field edit", async () => {
  const ctx = await setup();
  const saved = ctx.session.tagLifecycle.saveReturn({
    source: "setup",
    managedTag: "tag:prod",
    editVersion: 1,
    task: "server",
    step: "generate",
    advertiseExitNode: true,
    loginServer: "https://public.example",
    form: {
      userId: "2",
      userName: "bob",
      tags: ["tag:prod"],
      tagInput: "retained query",
      reusable: true,
      ephemeral: true,
      expiration: "2000-01-01T00:00:00.000Z",
      expirationMode: "preset",
      expiryDays: "7",
    },
  });
  if (!saved) throw new Error("Missing return record");
  ctx.session.tagLifecycle.requestReturn(saved.id);
  await expect
    .element(page.getByTestId("setup-expiration-expired"))
    .toBeVisible();
  await page.getByTestId("generate-install-script").click();
  await expect
    .element(page.getByTestId("setup-expiration-expired"))
    .toBeVisible();
  expect(ctx.writes()).toHaveLength(0);
  await page.getByTestId("add-device-step-authKey").click();
  await page.getByTestId("setup-expiration").fill("8");
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("generate-install-script").click();
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  expect(ctx.writes()).toHaveLength(1);
});

test("a failed return read preserves its slot and retries without resetting tags", async () => {
  const ctx = await setup();
  await openTags();
  await page.getByTestId("node-tags-option-tag:prod").click();
  await page.getByTestId("node-tags-manage").click();
  await expect.element(page.getByTestId("test-route")).toBeVisible();
  const saved = ctx.session.tagLifecycle.getSnapshot().returnTo;
  if (!saved) throw new Error("Missing return record");
  ctx.failRead("/api/v1/policy");
  ctx.session.tagLifecycle.requestReturn(saved.id);
  await ctx.router.navigate({ to: "/devices" });
  await expect.element(page.getByTestId("tag-return-read-error")).toBeVisible();
  expect(ctx.session.tagLifecycle.getSnapshot().returnTo?.id).toBe(saved.id);
  ctx.failRead("");
  await page.getByTestId("tag-return-retry").click();
  await expect
    .element(page.getByTestId("node-tags-remove-tag:prod"))
    .toBeVisible();
  expect(ctx.writes()).toHaveLength(0);
});

test("new local wizard editing while a return read is held cannot be overwritten or navigated away", async () => {
  const ctx = await setup();
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("add-linux-device").click();
  await page.getByTestId("setup-tags-manage").click();
  await expect.element(page.getByTestId("test-route")).toBeVisible();
  const saved = ctx.session.tagLifecycle.getSnapshot().returnTo;
  if (!saved) throw new Error("Missing return record");
  const release = ctx.holdReads();
  ctx.session.tagLifecycle.requestReturn(saved.id);
  await ctx.router.navigate({ to: "/devices" });
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(true);
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("add-client-device").click();
  await page.getByTestId("setup-tags-search").fill("tag:new-local");
  await page.getByTestId("setup-tags-add").click();
  release();
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  await expect
    .element(page.getByTestId("setup-tags-remove-tag:new-local"))
    .toBeVisible();
  expect(
    document.querySelector('[data-testid="setup-tags-remove-tag:server"]'),
  ).toBeNull();
  expect(ctx.writes()).toHaveLength(0);
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("tag-return-retry")).toBeVisible();
  expect(ctx.session.tagLifecycle.getSnapshot().returnTo?.id).toBe(saved.id);
  await page.getByTestId("tag-return-retry").click();
  await expect
    .element(page.getByTestId("setup-tags-remove-tag:server"))
    .toBeVisible();
  expect(
    document.querySelector('[data-testid="setup-tags-remove-tag:new-local"]'),
  ).toBeNull();
  expect(ctx.session.tagLifecycle.getSnapshot().returnTo).toBeNull();
});

test("reopening personal recovery after an uncertain write requires a new trusted request without restoring its consumed Auth ID", async () => {
  const ctx = await setup();
  await openRestore(ctx);
  await page.getByTestId("restore-source-confirm").click();
  ctx.failWrite("post-registration persistence failed");
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
  await expect
    .element(page.getByTestId("restore-source-confirm"))
    .not.toBeChecked();
  expect(
    JSON.stringify(ctx.session.tagLifecycle.getSnapshot()).includes(AUTH_ID),
  ).toBe(false);
  expect(ctx.writes()).toHaveLength(1);
});

test.each([
  "https://user:secret@public.example",
  "https://public.example?secret=value",
  "https://public.example/#secret",
])(
  "a public login-server containing credentials or request data cannot be confirmed: %s",
  async (server) => {
    const ctx = await setup();
    await openRestore(ctx);
    await page.getByTestId("restore-auth-id").fill(AUTH_ID);
    await page.getByTestId("restore-login-server").fill(server);
    await expect
      .element(page.getByTestId("restore-server-confirm"))
      .toBeDisabled();
    (
      page.getByTestId("pending-registration-flow").element() as HTMLFormElement
    ).requestSubmit();
    await expect
      .element(page.getByTestId("restore-personal-confirm"))
      .toBeDisabled();
    expect(ctx.writes()).toHaveLength(0);
  },
);

test.each(["tags", "registration"])(
  "switching sessions during the %s pre-write read dispatches nothing",
  async (kind) => {
    const ctx = await setup((backend) => {
      fixtureNode(backend).tags = ["tag:extra"];
    });
    if (kind === "tags") {
      await openTags();
      await page.getByTestId("node-tags-option-tag:prod").click();
      await page.getByTestId("node-tags-confirm").click();
    } else {
      await openRestore(ctx);
      await page.getByTestId("restore-source-confirm").click();
    }
    await expect
      .element(
        page.getByTestId(
          kind === "tags" ? "node-tags-apply" : "restore-personal-confirm",
        ),
      )
      .toBeEnabled();
    const release = ctx.holdReads();
    await page
      .getByTestId(
        kind === "tags" ? "node-tags-apply" : "restore-personal-confirm",
      )
      .click();
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(true);
    await authenticateTestSession(ctx.session, "https://other.invalid");
    release();
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
    await expect
      .element(
        page.getByTestId(
          kind === "tags" ? "node-tags-read-error" : "restore-safety-error",
        ),
      )
      .toBeVisible();
    expect(ctx.writes()).toHaveLength(0);
  },
);

test("a late SetTags response cannot publish success or replace a new server snapshot", async () => {
  const ctx = await setup((backend) => {
    fixtureNode(backend).tags = ["tag:extra"];
  });
  await openTags();
  await page.getByTestId("node-tags-option-tag:prod").click();
  await page.getByTestId("node-tags-confirm").click();
  const release = ctx.holdWrites();
  await page.getByTestId("node-tags-apply").click();
  await expect.poll(() => ctx.writes().length).toBe(1);
  await authenticateTestSession(ctx.session, "https://other.invalid");
  ctx.session.snapshot.applyPatch({ nodes: [] });
  release();
  await expect
    .poll(() => ctx.session.feedback.isActionPending("node-tags"))
    .toBe(false);
  expect(ctx.session.snapshot.getSnapshot().snapshot.nodes).toEqual([]);
  expect(document.querySelector('[data-testid="node-tags-result"]')).toBeNull();
  expect(ctx.writes()).toHaveLength(1);
});
