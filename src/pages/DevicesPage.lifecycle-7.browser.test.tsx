import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { getProductCopy } from "@/i18n/product-copy";
import {
  authenticateTestSession,
  AUTH_ID,
  alice,
  fixtureNode,
  openRestore,
  openTags,
  setup,
} from "@/test/devices-page-lifecycle-harness";

test("setup refresh and define routes never equate a created key to an enrolled device", async () => {
  const ctx = await setup();
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("add-linux-device").click();
  const before = ctx.calls.length;
  await page.getByTestId("setup-tags-retry").click();
  await expect.poll(() => ctx.calls.length).toBeGreaterThan(before);
  await page.getByTestId("setup-tags-define-tag:server").click();
  await expect.element(page.getByTestId("test-route")).toBeVisible();
  expect(ctx.router.state.location.search).toEqual({ tag: "tag:server" });
  await ctx.router.navigate({ to: "/devices" });
  await expect.element(page.getByTestId("setup-device-step")).toBeVisible();
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("generate-install-script").click();
  await expect.element(page.getByTestId("setup-awaiting-device")).toBeVisible();
  const reads = ctx.calls.length;
  await page.getByTestId("setup-refresh-devices").click();
  await expect.poll(() => ctx.calls.length).toBeGreaterThan(reads);
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  expect(ctx.writes()).toHaveLength(1);
});

test.each(["late-error", "lost-response"])(
  "G02 round1: an explicit new request after %s clears the old attempt and requires a fresh baseline",
  async (failure) => {
    const ctx = await setup((backend) => {
      fixtureNode(backend).tags = ["tag:prod"];
    });
    await openRestore(ctx);
    await page.getByTestId("restore-source-confirm").click();
    if (failure === "late-error")
      ctx.failWrite("late persistence failure", true);
    else ctx.loseWriteResponse();
    await page.getByTestId("restore-personal-confirm").click();
    await expect
      .element(page.getByTestId("register-pending-node-error"))
      .toBeVisible();
    await expect.element(page.getByTestId("restore-auth-id")).toHaveValue("");
    expect(
      ctx.session.feedback.actionOutcome("register-pending-node")?.status,
    ).toBe(failure === "late-error" ? "possibly-applied" : "unknown");
    await page.getByTestId("restore-readonly-check").click();
    await expect
      .element(page.getByTestId("restore-result"))
      .toHaveTextContent(getProductCopy("en-US").restoreIdentityObserved);
    const nextAuthId = "hskey-authreq-bcdefghijklmnopqrstuvwxy";
    await page.getByTestId("restore-auth-id").fill(nextAuthId);
    await expect
      .element(page.getByTestId("restore-result"))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByTestId("register-pending-node-error"))
      .not.toBeInTheDocument();
    expect(
      ctx.session.feedback.actionOutcome("register-pending-node")?.status,
    ).toBe("not-dispatched");
    for (const name of ["server", "backup", "source"]) {
      await expect
        .element(page.getByTestId(`restore-${name}-confirm`))
        .not.toBeChecked();
      await page.getByTestId(`restore-${name}-confirm`).click();
    }
    await expect
      .element(page.getByTestId("restore-personal-confirm"))
      .toBeDisabled();
    (
      page.getByTestId("pending-registration-flow").element() as HTMLFormElement
    ).requestSubmit();
    expect(ctx.writes()).toHaveLength(1);
    const current = fixtureNode(ctx.backend);
    current.tags = ["tag:prod", "tag:extra"];
    delete current.user;
    await page.getByTestId("restore-readonly-check").click();
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
    await expect
      .element(page.getByTestId("restore-baseline"))
      .toMatchTextContent(/tag:prod, tag:extra/);
    for (const name of ["server", "backup", "source"]) {
      await expect
        .element(page.getByTestId(`restore-${name}-confirm`))
        .not.toBeChecked();
      await page.getByTestId(`restore-${name}-confirm`).click();
    }
    ctx.failWrite("");
    await page.getByTestId("restore-personal-confirm").click();
    await expect.poll(() => ctx.writes().length).toBe(2);
    expect(ctx.writes().map((write) => write.body.authId)).toEqual([
      AUTH_ID,
      nextAuthId,
    ]);
    await expect.element(page.getByTestId("restore-auth-id")).toHaveValue("");
    expect(current.tags).toEqual([]);
    expect(fixtureNode(ctx.backend).user?.id).toBe("2");
    expect(
      JSON.stringify(ctx.session.tagLifecycle.getSnapshot()).includes(
        nextAuthId,
      ),
    ).toBe(false);
  },
);

test("G02 round1: a changed baseline for request B can be rereviewed in the same window without replaying A", async () => {
  const ctx = await setup();
  await openRestore(ctx);
  await page.getByTestId("restore-source-confirm").click();
  ctx.failWrite("uncertain persistence failure");
  await page.getByTestId("restore-personal-confirm").click();
  await expect
    .element(page.getByTestId("register-pending-node-error"))
    .toBeVisible();
  const nextAuthId = "hskey-authreq-bcdefghijklmnopqrstuvwxy";
  await page.getByTestId("restore-auth-id").fill(nextAuthId);
  for (const name of ["server", "backup", "source"]) {
    const checkbox = page.getByTestId(`restore-${name}-confirm`);
    if (!(checkbox.element() as HTMLInputElement).checked)
      await checkbox.click();
  }
  fixtureNode(ctx.backend).tags = ["tag:prod"];
  (
    page.getByTestId("pending-registration-flow").element() as HTMLFormElement
  ).requestSubmit();
  await expect.element(page.getByTestId("restore-safety-error")).toBeVisible();
  expect(ctx.writes()).toHaveLength(1);
  await page.getByTestId("restore-readonly-check").click();
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  await expect
    .element(page.getByTestId("restore-baseline"))
    .toMatchTextContent(/tag:prod/);
  for (const name of ["server", "backup", "source"]) {
    await expect
      .element(page.getByTestId(`restore-${name}-confirm`))
      .not.toBeChecked();
    await page.getByTestId(`restore-${name}-confirm`).click();
  }
  ctx.failWrite("");
  await page.getByTestId("restore-personal-confirm").click();
  await expect
    .element(page.getByTestId("restore-result"))
    .toHaveTextContent(getProductCopy("en-US").restoreIdentityObserved);
  expect(ctx.writes().map((write) => write.body.authId)).toEqual([
    AUTH_ID,
    nextAuthId,
  ]);
});

test.each(["already-target", "different-person", "duplicate-machine"])(
  "G02 round1: a new request cannot reauthorize a %s baseline from the old attempt",
  async (change) => {
    const ctx = await setup();
    await openRestore(ctx);
    await page.getByTestId("restore-source-confirm").click();
    ctx.failWrite("late persistence failure", true);
    await page.getByTestId("restore-personal-confirm").click();
    await expect
      .element(page.getByTestId("register-pending-node-error"))
      .toBeVisible();
    const nextAuthId = "hskey-authreq-bcdefghijklmnopqrstuvwxy";
    await page.getByTestId("restore-auth-id").fill(nextAuthId);
    const node = fixtureNode(ctx.backend);
    if (change === "different-person") node.user = { ...alice };
    if (change === "duplicate-machine") {
      node.tags = ["tag:prod"];
      delete node.user;
      ctx.backend.nodes.push({ ...node, id: "3" });
    }
    await page.getByTestId("restore-readonly-check").click();
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
    for (const name of ["server", "backup", "source"]) {
      const checkbox = page.getByTestId(`restore-${name}-confirm`);
      if (!(checkbox.element() as HTMLInputElement).checked)
        await checkbox.click();
    }
    await expect
      .element(page.getByTestId("restore-personal-confirm"))
      .toBeDisabled();
    (
      page.getByTestId("pending-registration-flow").element() as HTMLFormElement
    ).requestSubmit();
    await expect
      .element(page.getByTestId("restore-auth-id"))
      .toHaveValue(nextAuthId);
    expect(ctx.writes()).toHaveLength(1);
  },
);

test("G02 round1: editing a rereviewed new request revokes that attempt's review and confirmations", async () => {
  const ctx = await setup();
  await openRestore(ctx);
  await page.getByTestId("restore-source-confirm").click();
  ctx.failWrite("uncertain persistence failure");
  await page.getByTestId("restore-personal-confirm").click();
  await expect
    .element(page.getByTestId("register-pending-node-error"))
    .toBeVisible();
  await page
    .getByTestId("restore-auth-id")
    .fill("hskey-authreq-bcdefghijklmnopqrstuvwxy");
  await page.getByTestId("restore-readonly-check").click();
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  for (const name of ["server", "backup", "source"]) {
    const checkbox = page.getByTestId(`restore-${name}-confirm`);
    if (!(checkbox.element() as HTMLInputElement).checked)
      await checkbox.click();
  }
  await page
    .getByTestId("restore-auth-id")
    .fill("hskey-authreq-cdefghijklmnopqrstuvwxyz");
  for (const name of ["server", "backup", "source"]) {
    await expect
      .element(page.getByTestId(`restore-${name}-confirm`))
      .not.toBeChecked();
    await page.getByTestId(`restore-${name}-confirm`).click();
  }
  await expect
    .element(page.getByTestId("restore-personal-confirm"))
    .toBeDisabled();
  expect(ctx.writes()).toHaveLength(1);
});

test.each([
  "checkboxes",
  "target",
  "server",
  "draft-sync",
  "blank-request",
  "cleared-request",
])(
  "G02 round1: %s without a new request keeps the consumed attempt read-only",
  async (edit) => {
    const ctx = await setup((backend) => {
      fixtureNode(backend).tags = ["tag:prod"];
    });
    await openRestore(ctx);
    await page.getByTestId("restore-source-confirm").click();
    ctx.failWrite("late persistence failure");
    await page.getByTestId("restore-personal-confirm").click();
    await expect
      .element(page.getByTestId("register-pending-node-error"))
      .toBeVisible();
    await expect.element(page.getByTestId("restore-auth-id")).toHaveValue("");
    const outcome = ctx.session.feedback.actionOutcome("register-pending-node");
    fixtureNode(ctx.backend).tags = ["tag:prod", "tag:extra"];
    if (edit === "checkboxes") {
      await page.getByTestId("restore-backup-confirm").click();
      await page.getByTestId("restore-backup-confirm").click();
    } else if (edit === "target") {
      await page.getByTestId("restore-user").selectOptions("1");
    } else if (edit === "server") {
      await page
        .getByTestId("restore-login-server")
        .fill("https://other.example");
      await page.getByTestId("restore-server-confirm").click();
    } else if (edit === "blank-request" || edit === "cleared-request") {
      const input = page.getByTestId("restore-auth-id");
      await input.fill("   ");
      await expect.element(input).toHaveValue("   ");
      if (edit === "cleared-request") {
        await input.fill("");
        await expect.element(input).toHaveValue("");
      }
      await expect
        .element(page.getByTestId("restore-personal-confirm"))
        .toBeDisabled();
    } else {
      ctx.session.deviceSetup.setState({
        pendingRegistrationForm: { user: "1", key: "", kind: "device" },
      });
      await expect.element(page.getByTestId("restore-user")).toHaveValue("1");
    }
    await page.getByTestId("restore-readonly-check").click();
    await expect
      .element(page.getByTestId("restore-result"))
      .toHaveTextContent(getProductCopy("en-US").tagObservedConflict);
    await expect
      .element(page.getByTestId("restore-baseline"))
      .not.toMatchTextContent(/tag:extra/);
    await expect
      .element(page.getByTestId("restore-server-confirm"))
      .toBeChecked();
    await expect
      .element(page.getByTestId("restore-backup-confirm"))
      .toBeChecked();
    await expect
      .element(page.getByTestId("restore-readonly-check"))
      .toHaveTextContent(getProductCopy("en-US").tagReadOnlyCheck);
    await expect.element(page.getByTestId("restore-auth-id")).toHaveValue("");
    await expect
      .element(page.getByTestId("restore-personal-confirm"))
      .toBeDisabled();
    expect(ctx.session.feedback.actionOutcome("register-pending-node")).toEqual(
      outcome,
    );
    expect(ctx.writes()).toHaveLength(1);
  },
);

test("an uncertain approval does not lock a new explicit trusted request", async () => {
  const ctx = await setup();
  await openRestore(ctx);
  await page.getByTestId("restore-source-confirm").click();
  ctx.failWrite("uncertain persistence failure");
  await page.getByTestId("restore-personal-confirm").click();
  await expect
    .element(page.getByTestId("register-pending-node-error"))
    .toMatchTextContent(/verify.*list/i);
  await expect.element(page.getByTestId("restore-auth-id")).toHaveValue("");
  expect(ctx.writes()).toHaveLength(1);
  const nextAuthId = "hskey-authreq-bcdefghijklmnopqrstuvwxy";
  await page.getByTestId("restore-auth-id").fill(nextAuthId);
  await expect
    .element(page.getByTestId("restore-personal-confirm"))
    .toBeDisabled();
  await page.getByTestId("restore-readonly-check").click();
  await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
  for (const name of ["server", "backup", "source"]) {
    await expect
      .element(page.getByTestId(`restore-${name}-confirm`))
      .not.toBeChecked();
    await page.getByTestId(`restore-${name}-confirm`).click();
  }
  await expect
    .element(page.getByTestId("restore-personal-confirm"))
    .toBeEnabled();
  ctx.failWrite("");
  await page.getByTestId("restore-personal-confirm").click();
  await expect.element(page.getByTestId("restore-result")).toBeVisible();
  expect(ctx.writes()).toHaveLength(2);
  expect(ctx.writes()[1]?.body.authId === nextAuthId).toBe(true);
});

test.each(["server-switch", "leave-page"])(
  "an interrupted recovery observation after %s cannot change a previous outcome",
  async (change) => {
    const ctx = await setup();
    await openRestore(ctx);
    await page.getByTestId("restore-source-confirm").click();
    ctx.failWrite("late error", true);
    await page.getByTestId("restore-personal-confirm").click();
    await expect
      .element(page.getByTestId("register-pending-node-error"))
      .toBeVisible();
    const original = structuredClone(
      ctx.session.feedback.actionOutcome("register-pending-node"),
    );
    const release = ctx.holdReads();
    await page.getByTestId("restore-readonly-check").click();
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(true);
    if (change === "server-switch")
      await authenticateTestSession(ctx.session, "https://other.invalid");
    else await ctx.router.navigate({ to: "/access" });
    release();
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
    expect(ctx.session.feedback.actionOutcome("register-pending-node")).toEqual(
      change === "server-switch" ? undefined : original,
    );
    expect(ctx.writes()).toHaveLength(1);
  },
);

test.each(["server-switch", "leave-page"])(
  "recovery interrupted during its final pre-read by %s sends no approval",
  async (change) => {
    const ctx = await setup();
    await openRestore(ctx);
    await page.getByTestId("restore-source-confirm").click();
    const release = ctx.holdReads();
    await page.getByTestId("restore-personal-confirm").click();
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(true);
    if (change === "server-switch")
      await authenticateTestSession(ctx.session, "https://other.invalid");
    else await ctx.router.navigate({ to: "/access" });
    release();
    await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
    expect(ctx.writes()).toHaveLength(0);
    expect(ctx.session.deviceSetup.getSnapshot().lastRegisteredNode).toBeNull();
  },
);

test("malformed tags in a returned setup draft stay visible but cannot create a key", async () => {
  const ctx = await setup();
  const saved = ctx.session.tagLifecycle.saveReturn({
    source: "setup",
    managedTag: "",
    editVersion: 1,
    task: "server",
    step: "preferences",
    advertiseExitNode: false,
    loginServer: "https://public.example",
    form: {
      userId: "2",
      userName: "bob",
      tags: ["tag:Web1"],
      tagInput: "",
      reusable: false,
      ephemeral: false,
      expiration: new Date(Date.now() + 86400000).toISOString(),
      expirationMode: "preset",
      expiryDays: "1",
    },
  });
  expect.assert(saved);
  ctx.session.tagLifecycle.requestReturn(saved.id);
  await expect
    .element(page.getByTestId("setup-tags-remove-tag:Web1"))
    .toBeVisible();
  await page.getByTestId("add-device-next").click();
  await expect
    .element(page.getByTestId("setup-tags-error"))
    .toHaveTextContent(getProductCopy("en-US").invalidTags);
  await expect
    .element(page.getByTestId("setup-tags-remove-tag:Web1"))
    .toBeVisible();
  expect(ctx.writes()).toHaveLength(0);
});

test("search does not replace the full selected collection or submit SetTags with Enter", async () => {
  const ctx = await setup();
  await openTags();
  const dialog = page.getByTestId("node-tags-dialog");
  await expect.element(dialog.getByRole("textbox")).toBeEnabled();
  await dialog.getByRole("textbox").fill("tag:prod");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(
      dialog.getByRole("button", { name: "Remove tag:legacy", exact: true }),
    )
    .toBeVisible();
  await expect
    .element(
      dialog.getByRole("button", { name: "Remove tag:extra", exact: true }),
    )
    .toBeVisible();
  expect(ctx.writes()).toHaveLength(0);
});

test("only compatible definitions from policy readback are new device options", async () => {
  const ctx = await setup();
  ctx.session.policy.setState({
    policyDraft: JSON.stringify({ tagOwners: { "tag:draft": [] } }),
  });
  await openTags();
  await expect
    .element(page.getByTestId("node-tags-option-tag:prod"))
    .toBeVisible();
  expect(
    document.querySelector('[data-testid="node-tags-option-tag:draft"]'),
  ).toBeNull();
  expect(
    document.querySelector('[data-testid="node-tags-option-tag:Web1"]'),
  ).toBeNull();
  expect(
    document.querySelector('[data-testid="node-tags-option-tag:legacy"]'),
  ).toBeNull();
  expect(ctx.writes()).toHaveLength(0);
});
