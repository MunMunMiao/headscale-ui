import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { getProductCopy } from "@/i18n/product-copy";
import {
  AUTH_ID,
  alice,
  openRestore,
  setup,
} from "@/test/devices-page-lifecycle-harness";

test.each(["version-ABA", "new-version"])(
  "explicit recovery reread recovering freshness still rejects %s",
  async (change) => {
    const ctx = await setup();
    await openRestore(ctx);
    ctx.failRead("/api/v1/node");
    await page.getByTestId("restore-readonly-check").click();
    await expect.element(page.getByTestId("restore-read-error")).toBeVisible();
    expect(ctx.session.tagLifecycle.captureScope()?.versionFresh).toBe(false);
    ctx.failRead("");
    const release = ctx.holdReads();
    await page.getByTestId("restore-readonly-check").click();
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(true);
    if (change === "version-ABA") {
      ctx.session.snapshot.applyPatch({ version: { version: "0.29.5" } });
      ctx.session.snapshot.applyPatch({ version: { version: "0.29.4" } });
    } else ctx.backend.version = { version: "0.29.5" };
    release();
    await expect
      .element(page.getByTestId("restore-readonly-check"))
      .toBeEnabled();
    await expect
      .element(page.getByTestId("restore-safety-error"))
      .toHaveTextContent(getProductCopy("en-US").tagConfirmationStale);
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
    expect(ctx.writes()).toEqual([]);
  },
);

test.each(["renamed", "removed"])(
  "explicit recovery reread rejects a %s target without selecting another user",
  async (change) => {
    const ctx = await setup();
    await openRestore(ctx);
    const target = ctx.backend.users.find((user) => user.id === "2");
    expect.assert(target);
    if (change === "renamed") target.name = "renamed";
    else ctx.backend.users = [{ ...alice }];
    expect(
      Boolean(document.querySelector('[data-testid="restore-readonly-check"]')),
    ).toBe(true);
    await page.getByTestId("restore-readonly-check").click();
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
    await expect
      .element(page.getByTestId("restore-target"))
      .toHaveTextContent("bob · 2");
    await expect.element(page.getByTestId("restore-user")).toHaveValue("2");
    await expect
      .element(page.getByTestId("restore-personal-confirm"))
      .toBeDisabled();
    expect(ctx.writes()).toEqual([]);
  },
);

test("explicit recovery reread retains the dialog while busy and reopening cannot inherit its confirmations", async () => {
  const ctx = await setup();
  await openRestore(ctx);
  await page.getByTestId("restore-source-confirm").click();
  const release = ctx.holdReads();
  expect(
    Boolean(document.querySelector('[data-testid="restore-readonly-check"]')),
  ).toBe(true);
  await page.getByTestId("restore-readonly-check").click();
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(true);
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByTestId("restore-personal-dialog"))
    .toBeVisible();
  release();
  await expect
    .element(page.getByTestId("restore-readonly-check"))
    .toBeEnabled();
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("machine-actions-trigger-1").click();
  await page.getByTestId("restore-personal-action-1").click();
  await expect.element(page.getByTestId("restore-auth-id")).toHaveValue("");
  await expect
    .element(page.getByTestId("restore-personal-confirm"))
    .toBeDisabled();
  expect(ctx.writes()).toEqual([]);
});

test("same-server recovery remains blocked until trusted device source is explicitly confirmed", async () => {
  const ctx = await setup();
  await openRestore(ctx);
  (
    page.getByTestId("pending-registration-flow").element() as HTMLFormElement
  ).requestSubmit();
  await expect
    .element(page.getByTestId("restore-personal-confirm"))
    .toBeDisabled();
  await expect.element(page.getByTestId("auth-source-required")).toBeVisible();
  expect(ctx.writes()).toHaveLength(0);
  await page.getByTestId("restore-source-confirm").click();
  await expect
    .element(page.getByTestId("restore-personal-confirm"))
    .toBeEnabled();
  await page.getByTestId("restore-source-confirm").click();
  await expect
    .element(page.getByTestId("restore-source-confirm"))
    .not.toBeChecked();
  await expect
    .element(page.getByTestId("restore-personal-confirm"))
    .toBeDisabled();
  (
    page.getByTestId("pending-registration-flow").element() as HTMLFormElement
  ).requestSubmit();
  await expect.element(page.getByTestId("auth-source-required")).toBeVisible();
  expect(ctx.writes()).toEqual([]);
  await page.getByTestId("restore-source-confirm").click();
  await page.getByTestId("restore-personal-confirm").click();
  await expect.element(page.getByTestId("restore-result")).toBeVisible();
  expect(ctx.writes()).toHaveLength(1);
  expect(ctx.writes()[0]?.path).toBe("/api/v1/auth/register");
  expect(ctx.writes()[0]?.body).toEqual({ user: "bob", authId: AUTH_ID });
  await expect.element(page.getByTestId("restore-auth-id")).toHaveValue("");
});

test("wrong-server recovery never enables source verification or writes", async () => {
  const ctx = await setup();
  await openRestore(ctx);
  await page
    .getByTestId("restore-auth-id")
    .fill(`https://foreign.example/register/${AUTH_ID}`);
  await expect.element(page.getByTestId("restore-wrong-server")).toBeVisible();
  await expect
    .element(page.getByTestId("restore-source-confirm"))
    .toBeDisabled();
  await expect
    .element(page.getByTestId("restore-personal-confirm"))
    .toBeDisabled();
  expect(ctx.writes()).toHaveLength(0);
});

test("renaming the chosen target never falls back to the first user", async () => {
  const ctx = await setup();
  await openRestore(ctx);
  await page.getByTestId("restore-source-confirm").click();
  const target = ctx.backend.users.find((user) => user.id === "2");
  expect.assert(target);
  target.name = "renamed";
  await page.getByTestId("restore-personal-confirm").click();
  await expect.element(page.getByTestId("restore-safety-error")).toBeVisible();
  await expect
    .element(page.getByTestId("restore-target"))
    .toHaveTextContent("bob · 2");
  await expect.element(page.getByTestId("restore-user")).toHaveValue("2");
  expect(ctx.writes()).toHaveLength(0);
});

test("late approval failure clears the consumed Auth ID, keeps only the non-secret target and never replays on reread", async () => {
  const ctx = await setup();
  await openRestore(ctx);
  await page.getByTestId("restore-source-confirm").click();
  ctx.failWrite("post-registration persistence failed", true);
  await page.getByTestId("restore-personal-confirm").click();
  await expect
    .element(page.getByTestId("register-pending-node-error"))
    .toBeVisible();
  await expect.element(page.getByTestId("restore-auth-id")).toHaveValue("");
  expect(JSON.stringify(ctx.session.tagLifecycle.getSnapshot())).not.toContain(
    AUTH_ID,
  );
  await page.getByTestId("restore-readonly-check").click();
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  expect(ctx.writes()).toHaveLength(1);
  await page.getByTestId("register-pending-node-verify").click();
  await expect
    .element(page.getByTestId("add-device-dialog"))
    .not.toBeInTheDocument();
  expect(ctx.router.state.location.pathname).toBe("/devices");
  expect(
    ctx.session.deviceSetup.getSnapshot().pendingRegistrationForm.key,
  ).toBe("");
  expect(ctx.writes()).toHaveLength(1);
});

test("a precise pre-effect user lookup rejection is not mislabeled as a partially applied recovery", async () => {
  const ctx = await setup();
  await openRestore(ctx);
  await page.getByTestId("restore-source-confirm").click();
  ctx.failWrite("looking up user: user not found");
  await page.getByTestId("restore-personal-confirm").click();
  await expect
    .element(page.getByTestId("register-pending-node-error"))
    .toBeVisible();
  await expect
    .element(page.getByTestId("restore-result"))
    .not.toBeInTheDocument();

  await expect.element(page.getByTestId("restore-auth-id")).toHaveValue("");
  expect(ctx.writes()).toHaveLength(1);
  ctx.failWrite("");
  await page
    .getByTestId("restore-auth-id")
    .fill("hskey-authreq-bcdefghijklmnopqrstuvwxy");
  await page.getByTestId("restore-readonly-check").click();
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  for (const name of ["server", "backup", "source"]) {
    await expect
      .element(page.getByTestId(`restore-${name}-confirm`))
      .not.toBeChecked();
    await page.getByTestId(`restore-${name}-confirm`).click();
  }
  await page.getByTestId("restore-personal-confirm").click();
  await expect
    .element(page.getByTestId("restore-result"))
    .toHaveTextContent(getProductCopy("en-US").restoreIdentityObserved);
  expect(ctx.writes()).toHaveLength(2);
});

test("a same-name registration response with a different machine key is explicitly uncertain", async () => {
  const ctx = await setup();
  await openRestore(ctx);
  ctx.foreignRegistration();
  await page.getByTestId("restore-source-confirm").click();
  await page.getByTestId("restore-personal-confirm").click();
  await expect
    .element(page.getByTestId("restore-result"))
    .toHaveTextContent(getProductCopy("en-US").restoreUncertain);
  await page.getByTestId("restore-readonly-check").click();
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  await expect
    .element(page.getByTestId("restore-result"))
    .toHaveTextContent(getProductCopy("en-US").restoreUncertain);
  expect(ctx.writes()).toHaveLength(1);
  expect(ctx.backend.nodes[0]?.tags).toEqual(["tag:legacy", "tag:extra"]);
});

test("a stale session arriving in the same turn as setup generation sends no request", async () => {
  const ctx = await setup();
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("add-linux-device").click();
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("add-device-next").click();
  const generate = page
    .getByTestId("generate-install-script")
    .element() as HTMLButtonElement;
  const scope = ctx.session.tagLifecycle.captureScope();
  expect.assert(scope);
  ctx.session.drafts.hold({ id: scope.profileId, name: "Fixture" });
  generate.click();
  await expect
    .element(page.getByTestId("generate-install-script"))
    .toBeDisabled();
  await expect.element(page.getByTestId("setup-generate-error")).toBeVisible();
  expect(ctx.writes()).toHaveLength(0);
});

test("a setup form retaining an unread one-time key cannot leave through tag management", async () => {
  const ctx = await setup();
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("add-linux-device").click();
  ctx.session.deviceSetup.setState({ lastCreatedInvite: "fixture-unread-key" });
  await page.getByTestId("setup-tags-manage").click();
  await expect.element(page.getByTestId("add-device-dialog")).toBeVisible();
  expect(ctx.session.tagLifecycle.getSnapshot().returnTo).toBeNull();
  expect(ctx.router.state.location.pathname).toBe("/devices");
  expect(ctx.writes()).toHaveLength(0);
});

test("setup unknown key creation shows a non-blocking notice and never retries automatically", async () => {
  const ctx = await setup();
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("add-linux-device").click();
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("add-device-next").click();
  ctx.loseWriteResponse();
  await page.getByTestId("generate-install-script").click();
  await expect
    .element(page.getByTestId("invite-create-unknown"))
    .toMatchTextContent(/Auth keys list/i);
  await expect
    .element(page.getByTestId("generate-install-script"))
    .toBeEnabled();
  await expect
    .element(page.getByTestId("invite-create-verify"))
    .toHaveAttribute("href", "/invites");
  expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe("");
  expect(ctx.writes()).toHaveLength(1);
  await page.getByTestId("generate-install-script").click();
  await expect.poll(() => ctx.writes().length).toBe(2);
});
