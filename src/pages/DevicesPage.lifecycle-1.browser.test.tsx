import { expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { getProductCopy } from "@/i18n/product-copy";
import {
  createMutation,
  AUTH_ID,
  currentToasts,
  fixtureNode,
  openRestore,
  openTags,
  setup,
} from "@/test/devices-page-lifecycle-harness";

test.each(["source", "target"] as const)(
  "review I1: invalid migration %s keeps concurrent tags through final confirmation",
  async (invalidated) => {
    const ctx = await setup((backend) => {
      backend.policy = {
        policy: JSON.stringify({
          acls: [],
          tagOwners: {
            "tag:legacy": [],
            "tag:extra": [],
            "tag:prod": [],
            "tag:added": [],
            "tag:manual": [],
          },
        }),
      };
    });
    fixtureNode(ctx.backend).tags =
      invalidated === "source"
        ? ["tag:extra", "tag:added"]
        : ["tag:legacy", "tag:extra", "tag:added"];
    if (invalidated === "target")
      ctx.backend.policy = {
        policy:
          '{"acls":[],"tagOwners":{"tag:legacy":[],"tag:extra":[],"tag:added":[],"tag:manual":[]}}',
      };
    await ctx.router.navigate({
      to: "/devices",
      search: {
        node: "1",
        popup: "tags",
        from: "access",
        maintenance: "tag:legacy",
        migrateFrom: "tag:legacy",
        migrateTo: "tag:prod",
      },
    });
    await expect
      .element(page.getByTestId("node-tags-notice"))
      .toHaveTextContent(getProductCopy("en-US").tagDecisionChanged);
    const selected = invalidated === "source" ? "tag:prod" : "tag:manual";
    await page.getByTestId(`node-tags-option-${selected}`).click();
    await page.getByTestId("node-tags-confirm").click();
    await expect.element(page.getByTestId("node-tags-review")).toBeVisible();
    await page.getByTestId("node-tags-apply").click();
    await expect.element(page.getByTestId("node-tags-result")).toBeVisible();
    const expected =
      invalidated === "source"
        ? ["tag:extra", "tag:added", "tag:prod"]
        : ["tag:legacy", "tag:extra", "tag:added", "tag:manual"];
    expect(ctx.writes()).toEqual([
      { method: "POST", path: "/api/v1/node/1/tags", body: { tags: expected } },
    ]);
    expect(fixtureNode(ctx.backend).tags).toEqual(expected);
  },
);

test.each([
  ["tags", "/api/v1/policy"],
  ["tags", "/api/v1/node"],
  ["personal", "/api/v1/node"],
] as const)(
  "unified feedback: %s keeps an unknown notice and independently reports a later %s read failure without retrying",
  async (kind, failedRead) => {
    const ctx = await setup((backend) => {
      fixtureNode(backend).tags = ["tag:extra"];
    });
    if (kind === "tags") {
      await openTags();
      await page.getByTestId("node-tags-option-tag:prod").click();
      await page.getByTestId("node-tags-confirm").click();
      ctx.failWrite("post-write operator diagnostic", true);
      await page.getByTestId("node-tags-apply").click();
    } else {
      await openRestore(ctx);
      await page.getByTestId("restore-source-confirm").click();
      ctx.failWrite("post-write operator diagnostic", true);
      await page.getByTestId("restore-personal-confirm").click();
      await expect.element(page.getByTestId("restore-auth-id")).toHaveValue("");
    }
    const key = kind === "tags" ? "node-tags" : "register-pending-node";
    await expect
      .element(page.getByTestId(`${key}-error`))
      .toMatchTextContent(/verify.*list/i);
    expect(currentToasts()).toHaveLength(0);
    const original = structuredClone(ctx.session.feedback.actionOutcome(key));
    ctx.failRead(failedRead);
    await page
      .getByTestId(
        kind === "tags" ? "node-tags-reread" : "restore-readonly-check",
      )
      .click();
    await expect.poll(() => currentToasts().length).toBe(1);
    expect(currentToasts()[0]?.textContent).toContain("Could not refresh data");
    expect(currentToasts()[0]?.textContent?.includes(AUTH_ID)).toBe(false);
    expect(ctx.session.feedback.actionOutcome(key)).toEqual(original);
    const close = currentToasts()[0]?.querySelector<HTMLButtonElement>(
      'button[aria-label="Close"]',
    );
    expect.assert(close);
    close.click();
    await expect.poll(() => currentToasts().length).toBe(0);
    expect(ctx.writes()).toHaveLength(1);
    await expect.element(page.getByTestId(`${key}-error`)).toBeVisible();
  },
);

test("unified feedback: a precise AuthRegister pre-rejection notifies once without exposing the Auth ID", async () => {
  const ctx = await setup();
  await openRestore(ctx);
  await page.getByTestId("restore-source-confirm").click();
  ctx.failWrite("looking up user: user not found");
  await page.getByTestId("restore-personal-confirm").click();
  await expect.poll(() => currentToasts().length).toBe(1);
  expect(currentToasts()[0]?.textContent).toContain("Request rejected");
  expect(currentToasts()[0]?.textContent).not.toContain(AUTH_ID);
  expect(currentToasts()[0]?.textContent).not.toContain("looking up user");

  await expect.element(page.getByTestId("restore-auth-id")).toHaveValue("");
  expect(ctx.writes()).toHaveLength(1);
});

test("unified feedback: a precise SetTags pre-rejection notifies once and preserves the complete input", async () => {
  const ctx = await setup((backend) => {
    fixtureNode(backend).tags = ["tag:extra"];
  });
  await openTags();
  await page.getByTestId("node-tags-option-tag:prod").click();
  await page.getByTestId("node-tags-confirm").click();
  ctx.failWrite("requested tags [tag:prod] are invalid or not permitted");
  await page.getByTestId("node-tags-apply").click();
  await expect.poll(() => currentToasts().length).toBe(1);
  expect(currentToasts()[0]?.textContent).toContain("Request rejected");

  await expect
    .element(page.getByTestId("node-tags-remove-tag:extra"))
    .toBeVisible();
  await expect
    .element(page.getByTestId("node-tags-remove-tag:prod"))
    .toBeVisible();
  expect(ctx.writes()).toHaveLength(1);
});

test("unified feedback: a registration result retains the confirmed-write read warning without a duplicate toast", async () => {
  const ctx = await setup();
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("add-pending-node").click();
  await page.getByTestId("pending-registration-user").selectOptions("2");
  await page.getByTestId("pending-node-key").fill(AUTH_ID);
  await page.getByTestId("restore-login-server").fill("https://public.example");
  await page.getByTestId("restore-server-confirm").click();
  await page.getByTestId("restore-source-confirm").click();
  ctx.failRefresh();
  await page.getByTestId("register-pending-node").click();
  const result = page.getByTestId("registration-result");
  await expect.element(result).toBeVisible();
  await expect
    .element(
      result.getByText(getProductCopy("en-US").restoreRefreshFailed, {
        exact: true,
      }),
    )
    .toBeVisible();
  expect(currentToasts()).toHaveLength(0);
  expect(ctx.writes()).toHaveLength(1);
  expect(
    ctx.session.feedback.actionOutcome("register-pending-node")?.status,
  ).toBe("confirmed");
});

test.each([AUTH_ID, `https://public.example/register/${AUTH_ID}`])(
  "a registration request without trusted target-device source verification sends zero requests: %s",
  async (key) => {
    const ctx = await setup();
    await page.getByTestId("add-device-toggle").click();
    await page.getByTestId("add-pending-node").click();
    await page.getByTestId("pending-registration-user").selectOptions("2");
    await page.getByTestId("pending-node-key").fill(key);
    const form = page.getByTestId("pending-registration-flow");
    (form.element() as HTMLFormElement).requestSubmit();
    await expect
      .element(page.getByTestId("auth-source-required"))
      .toBeVisible();
    await expect
      .element(page.getByTestId("register-pending-node"))
      .toBeDisabled();
    expect(ctx.writes()).toHaveLength(0);
  },
);

test.each(["late-error", "lost-response"])(
  "an uncertain policy publication does not lock device tags or replay either write across a management return: %s",
  async (failure) => {
    const ctx = await setup();
    await openTags();
    await page.getByTestId("node-tags-option-tag:prod").click();
    await page.getByTestId("node-tags-define-tag:legacy").click();
    await expect
      .element(page.getByTestId("test-route"))
      .toHaveTextContent("/access");
    const saved = ctx.session.tagLifecycle.getSnapshot().returnTo;
    expect.assert(saved?.source === "device");
    expect(saved.tags).toEqual(["tag:legacy", "tag:extra", "tag:prod"]);
    if (failure === "late-error")
      ctx.failWrite("reloading policy: failed", true);
    else ctx.loseWriteResponse();
    const policy = JSON.stringify({
      tagOwners: { "tag:prod": [], "tag:extra": [], "tag:legacy": [] },
    });
    const publication = await createMutation(ctx.session).mutateDetailed(
      "save-policy",
      {
        endpoint: "setPolicy",
        input: { policy },
      },
    );
    expect(publication.outcome.status).toBe(
      failure === "late-error" ? "possibly-applied" : "unknown",
    );
    ctx.failWrite("");
    ctx.session.tagLifecycle.requestReturn(saved.id);
    await ctx.router.navigate({ to: "/devices" });
    await expect.element(page.getByTestId("node-tags-dialog")).toBeVisible();
    await expect.element(page.getByTestId("node-tags-confirm")).toBeEnabled();
    await expect
      .element(page.getByTestId("node-tags-policy-dependency"))
      .not.toBeInTheDocument();
    expect(ctx.writes()).toHaveLength(1);
    await page.getByTestId("node-tags-confirm").click();
    await page.getByTestId("node-tags-apply").click();
    await expect.element(page.getByTestId("node-tags-result")).toBeVisible();
    expect(ctx.writes().filter((call) => call.path.endsWith("/tags"))).toEqual([
      {
        method: "POST",
        path: "/api/v1/node/1/tags",
        body: { tags: ["tag:legacy", "tag:extra", "tag:prod"] },
      },
    ]);
    expect(ctx.writes()).toHaveLength(2);
  },
);

for (const source of ["device", "setup"] as const) {
  for (const sameTurn of [false, true]) {
    test.each([false, true])(
      `${source} restores pending Access Back with same-turn=${sameTurn} and newer-wizard=%s`,
      async (newer) => {
        const loading = Promise.withResolvers<void>();
        const ctx = await setup(undefined, loading.promise);
        if (source === "device") {
          await openTags();
          await page.getByTestId("node-tags-option-tag:prod").click();
          await page
            .getByTestId("node-tags-search")
            .fill("saved selection filter");
        } else {
          await page.getByTestId("add-device-toggle").click();
          await page.getByTestId("add-linux-device").click();
          await page.getByTestId("setup-ephemeral").click();
          await page.getByTestId("setup-tags-search").fill("tag:uncommitted");
        }
        const dialog = page.getByTestId(
          source === "device" ? "node-tags-dialog" : "add-device-dialog",
        );
        const manage = page.getByTestId(
          source === "device" ? "node-tags-manage" : "setup-tags-manage",
        );
        const newWizard = page
          .getByTestId("add-device-toggle")
          .element() as HTMLButtonElement;
        try {
          if (sameTurn) {
            (manage.element() as HTMLButtonElement).click();
            if (newer) newWizard.click();
            ctx.router.history.back();
          } else {
            await manage.click();
            await expect.element(dialog).not.toBeInTheDocument();
            await expect
              .poll(() => ctx.router.state.location.pathname)
              .toBe("/access");
            if (newer) await page.getByTestId("add-device-toggle").click();
            ctx.router.history.back();
          }
          await expect
            .poll(() => ctx.router.state.location.pathname)
            .toBe("/devices");
          if (newer) {
            await expect
              .element(page.getByTestId("add-device-options"))
              .toBeVisible();
            await page.getByTestId("add-client-device").click();
            await page.getByTestId("setup-tags-search").fill("tag:newer");
            await expect
              .element(page.getByTestId("setup-tags-search"))
              .toHaveValue("tag:newer");
            await userEvent.keyboard("{Escape}");
            await expect
              .element(page.getByTestId("tag-return-read-error"))
              .toMatchTextContent(getProductCopy("en-US").tagReturnNewerEdit);
            expect(
              ctx.session.tagLifecycle.getSnapshot().returnTo,
            ).not.toBeNull();
            await page.getByTestId("tag-return-retry").click();
          }
          await expect.element(dialog).toBeVisible();
          if (source === "device") {
            await expect
              .element(page.getByTestId("node-tags-search"))
              .toHaveValue("saved selection filter");
            await expect
              .element(page.getByTestId("node-tags-remove-tag:prod"))
              .toBeVisible();
            await expect
              .element(page.getByTestId("node-tags-remove-tag:legacy"))
              .toBeVisible();
          } else {
            await expect
              .element(page.getByTestId("setup-tags-search"))
              .toHaveValue("tag:uncommitted");
            await expect
              .element(page.getByTestId("setup-ephemeral"))
              .toBeChecked();
          }
          expect(ctx.session.tagLifecycle.getSnapshot().returnTo).toBeNull();
          expect(ctx.writes()).toHaveLength(0);
        } finally {
          loading.resolve();
        }
        await expect.poll(() => ctx.router.state.isLoading).toBe(false);
        expect(ctx.router.state.location.pathname).toBe("/devices");
      },
    );
  }

  test(`${source} keeps its return managing during slow Access loading and restores only after Back`, async () => {
    const loading = Promise.withResolvers<void>();
    const ctx = await setup(undefined, loading.promise);
    if (source === "device") await openTags();
    else {
      await page.getByTestId("add-device-toggle").click();
      await page.getByTestId("add-linux-device").click();
    }
    try {
      await page
        .getByTestId(
          source === "device" ? "node-tags-manage" : "setup-tags-manage",
        )
        .click();
      await expect
        .poll(() => ctx.router.state.location.pathname)
        .toBe("/access");
      await expect.element(page.getByTestId("device-search")).toBeVisible();
      expect(ctx.session.tagLifecycle.getSnapshot().returnTo?.status).toBe(
        "managing",
      );
      await expect
        .element(page.getByTestId("node-tags-dialog"))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByTestId("add-device-dialog"))
        .not.toBeInTheDocument();
    } finally {
      loading.resolve();
    }
    await expect
      .element(page.getByTestId("test-route"))
      .toHaveTextContent("/access");
    ctx.router.history.back();
    await expect
      .element(
        page.getByTestId(
          source === "device" ? "node-tags-dialog" : "add-device-dialog",
        ),
      )
      .toBeVisible();
    expect(ctx.session.tagLifecycle.getSnapshot().returnTo).toBeNull();
    expect(ctx.writes()).toHaveLength(0);
  });
}

test("a same-origin history event cannot restore a departure before navigation is approved", async () => {
  const loading = Promise.withResolvers<void>();
  const approval = Promise.withResolvers<boolean>();
  const ctx = await setup(undefined, loading.promise);
  const unblock = ctx.router.history.block({
    blockerFn: ({ nextLocation }) =>
      nextLocation.pathname === "/access" ? approval.promise : false,
  });
  await openTags();
  try {
    await page.getByTestId("node-tags-manage").click();
    await expect
      .element(page.getByTestId("node-tags-dialog"))
      .not.toBeInTheDocument();
    ctx.router.history.replace(ctx.router.history.location.href);
    await expect.poll(() => ctx.router.state.isLoading).toBe(false);
    expect(ctx.session.tagLifecycle.getSnapshot().returnTo?.status).toBe(
      "managing",
    );
    expect(
      document.querySelector('[data-testid="node-tags-dialog"]'),
    ).toBeNull();
    approval.resolve(false);
    await expect.poll(() => ctx.router.state.location.pathname).toBe("/access");
    ctx.router.history.back();
    await expect.element(page.getByTestId("node-tags-dialog")).toBeVisible();
    expect(ctx.session.tagLifecycle.getSnapshot().returnTo).toBeNull();
    expect(ctx.writes()).toHaveLength(0);
  } finally {
    approval.resolve(false);
    loading.resolve();
    unblock();
  }
});

test("a second setup departure during pending Access supersedes the device slot without changing its origin", async () => {
  const loading = Promise.withResolvers<void>();
  const ctx = await setup(undefined, loading.promise);
  await openTags();
  try {
    await page.getByTestId("node-tags-manage").click();
    await expect
      .element(page.getByTestId("node-tags-dialog"))
      .not.toBeInTheDocument();
    await page.getByTestId("add-device-toggle").click();
    await page.getByTestId("add-client-device").click();
    await page.getByTestId("setup-tags-search").fill("tag:newer-departure");
    await page.getByTestId("setup-tags-manage").click();
    await expect
      .element(page.getByTestId("add-device-dialog"))
      .not.toBeInTheDocument();
    expect(ctx.session.tagLifecycle.getSnapshot().returnTo?.source).toBe(
      "setup",
    );
    await ctx.router.navigate({ to: "/devices" });
    await expect
      .element(page.getByTestId("setup-tags-search"))
      .toHaveValue("tag:newer-departure");
    expect(
      document.querySelector('[data-testid="node-tags-dialog"]'),
    ).toBeNull();
    expect(ctx.session.tagLifecycle.getSnapshot().returnTo).toBeNull();
    expect(ctx.writes()).toHaveLength(0);
  } finally {
    loading.resolve();
  }
});

test.each(["device", "setup"] as const)(
  "a new setup handoff after a %s return read and Forward keeps the original source route",
  async (source) => {
    const loading = Promise.withResolvers<void>();
    const ctx = await setup(undefined, loading.promise);
    if (source === "device") await openTags();
    else {
      await page.getByTestId("add-device-toggle").click();
      await page.getByTestId("add-linux-device").click();
    }
    let finishRead: (() => void) | undefined;
    try {
      await page
        .getByTestId(
          source === "device" ? "node-tags-manage" : "setup-tags-manage",
        )
        .click();
      await expect
        .element(
          page.getByTestId(
            source === "device" ? "node-tags-dialog" : "add-device-dialog",
          ),
        )
        .not.toBeInTheDocument();
      const first = ctx.session.tagLifecycle.getSnapshot().returnTo;
      expect.assert(first);
      const accessHref = ctx.router.history.location.href;
      const policyReads = () =>
        ctx.calls.filter(
          (call) => call.method === "GET" && call.path === "/api/v1/policy",
        ).length;
      const beforeReads = policyReads();
      finishRead = ctx.holdReads();
      ctx.router.history.back();
      await expect.poll(policyReads).toBe(beforeReads + 1);
      await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(true);
      ctx.router.history.forward();
      await expect
        .poll(() => ctx.router.state.location.pathname)
        .toBe("/access");
      finishRead();
      await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
      expect(ctx.session.tagLifecycle.getSnapshot().returnTo?.id).toBe(
        first.id,
      );
      expect(
        document.querySelector('[data-testid="node-tags-dialog"]'),
      ).toBeNull();
      expect(
        document.querySelector('[data-testid="add-device-dialog"]'),
      ).toBeNull();

      await page.getByTestId("add-device-toggle").click();
      await page.getByTestId("add-client-device").click();
      await page.getByTestId("setup-tags-option-tag:prod").click();
      await page.getByTestId("setup-ephemeral").click();
      await page.getByTestId("setup-tags-search").fill("tag:newer-departure");
      await page.getByTestId("setup-tags-manage").click();
      await expect
        .element(page.getByTestId("add-device-dialog"))
        .not.toBeInTheDocument();
      const latest = ctx.session.tagLifecycle.getSnapshot().returnTo;
      expect.assert(latest?.source === "setup");
      expect(latest.id).not.toBe(first.id);
      expect(latest).toMatchObject({
        status: "managing",
        task: "client",
        form: {
          tags: ["tag:prod"],
          tagInput: "tag:newer-departure",
          ephemeral: true,
        },
      });
      expect(ctx.router.history.location.href).toBe(accessHref);
      expect(ctx.writes()).toHaveLength(0);

      ctx.router.history.back();
      await expect
        .poll(() => ctx.router.state.location.pathname)
        .toBe("/devices");
      await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
      await expect
        .element(page.getByTestId("setup-tags-search"))
        .toHaveValue("tag:newer-departure");
      await expect
        .element(page.getByTestId("setup-tags-remove-tag:prod"))
        .toBeVisible();
      await expect.element(page.getByTestId("setup-ephemeral")).toBeChecked();
      expect(policyReads()).toBe(beforeReads + 2);
      expect(
        document.querySelector('[data-testid="setup-tags-remove-tag:server"]'),
      ).toBeNull();
      expect(
        document.querySelector('[data-testid="node-tags-dialog"]'),
      ).toBeNull();
      expect(
        document.querySelector('[data-testid="tag-return-read-error"]'),
      ).toBeNull();
      expect(ctx.session.tagLifecycle.getSnapshot().returnTo).toBeNull();
      expect(ctx.writes()).toHaveLength(0);
    } finally {
      finishRead?.();
      loading.resolve();
    }
  },
);

test("new device editing before pending Back cannot be replaced by the earlier saved set", async () => {
  const loading = Promise.withResolvers<void>();
  const ctx = await setup(undefined, loading.promise);
  await openTags();
  try {
    await page.getByTestId("node-tags-manage").click();
    await expect
      .element(page.getByTestId("node-tags-dialog"))
      .not.toBeInTheDocument();
    await openTags("2");
    await page.getByTestId("node-tags-option-tag:prod").click();
    ctx.router.history.back();
    await expect
      .poll(() => ctx.router.state.location.pathname)
      .toBe("/devices");
    await expect
      .element(page.getByTestId("node-tags-remove-tag:prod"))
      .toBeVisible();
    expect(
      document.querySelector('[data-testid="node-tags-remove-tag:legacy"]'),
    ).toBeNull();
    await userEvent.keyboard("{Escape}");
    await expect
      .element(page.getByTestId("tag-return-read-error"))
      .toMatchTextContent(getProductCopy("en-US").tagReturnNewerEdit);
    await page.getByTestId("tag-return-retry").click();
    await expect
      .element(page.getByTestId("node-tags-remove-tag:legacy"))
      .toBeVisible();
    expect(ctx.session.tagLifecycle.getSnapshot().returnTo).toBeNull();
    expect(ctx.writes()).toHaveLength(0);
  } finally {
    loading.resolve();
  }
});

for (const source of ["device", "setup"] as const) {
  test.each([false, true])(
    `${source} return read respects Forward into pending Access and subsequent Back=%s`,
    async (backAgain) => {
      const loading = Promise.withResolvers<void>();
      const ctx = await setup(undefined, loading.promise);
      if (source === "device") await openTags();
      else {
        await page.getByTestId("add-device-toggle").click();
        await page.getByTestId("add-linux-device").click();
      }
      let finishRead: (() => void) | undefined;
      let finishNewRead: (() => void) | undefined;
      try {
        await page
          .getByTestId(
            source === "device" ? "node-tags-manage" : "setup-tags-manage",
          )
          .click();
        await expect
          .element(
            page.getByTestId(
              source === "device" ? "node-tags-dialog" : "add-device-dialog",
            ),
          )
          .not.toBeInTheDocument();
        const saved = ctx.session.tagLifecycle.getSnapshot().returnTo;
        expect.assert(saved);
        const policyReads = () =>
          ctx.calls.filter(
            (call) => call.method === "GET" && call.path === "/api/v1/policy",
          ).length;
        const beforeReads = policyReads();
        finishRead = ctx.holdReads();
        const refresh = vi.spyOn(ctx.session.snapshot, "refreshSegments");
        ctx.router.history.back();
        await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(true);
        await expect.poll(policyReads).toBe(beforeReads + 1);
        ctx.router.history.forward();
        await expect
          .poll(() => ctx.router.state.location.pathname)
          .toBe("/access");
        if (backAgain) {
          finishNewRead = ctx.holdReads();
          ctx.router.history.back();
          await expect.poll(() => refresh.mock.calls.length).toBe(2);
          await expect.poll(policyReads).toBe(beforeReads + 2);
          finishRead();
          const first = refresh.mock.results[0];
          expect.assert(first?.type === "return");
          expect(await first.value).toBe(false);
          expect(ctx.session.snapshot.isRefreshing).toBe(true);
          expect(ctx.session.tagLifecycle.getSnapshot().returnTo?.id).toBe(
            saved.id,
          );
          expect(
            document.querySelector('[data-testid="tag-return-read-error"]'),
          ).toBeNull();
          expect(
            document.querySelector('[data-testid="node-tags-dialog"]'),
          ).toBeNull();
          expect(
            document.querySelector('[data-testid="add-device-dialog"]'),
          ).toBeNull();
          finishNewRead();
        }
        finishRead();
        await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
        if (!backAgain) {
          expect(ctx.router.state.location.pathname).toBe("/access");
          expect(ctx.session.tagLifecycle.getSnapshot().returnTo?.id).toBe(
            saved.id,
          );
          expect(
            document.querySelector('[data-testid="node-tags-dialog"]'),
          ).toBeNull();
          expect(
            document.querySelector('[data-testid="add-device-dialog"]'),
          ).toBeNull();
          ctx.router.history.back();
        }
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
      } finally {
        finishRead?.();
        finishNewRead?.();
        loading.resolve();
      }
    },
  );
}

test.each(["device", "setup"] as const)(
  "Forward and Back cannot rebase a %s return onto newer wizard edits",
  async (source) => {
    const loading = Promise.withResolvers<void>();
    const ctx = await setup(undefined, loading.promise);
    if (source === "device") await openTags();
    else {
      await page.getByTestId("add-device-toggle").click();
      await page.getByTestId("add-linux-device").click();
    }
    let finishRead: (() => void) | undefined;
    try {
      await page
        .getByTestId(
          source === "device" ? "node-tags-manage" : "setup-tags-manage",
        )
        .click();
      await expect
        .element(
          page.getByTestId(
            source === "device" ? "node-tags-dialog" : "add-device-dialog",
          ),
        )
        .not.toBeInTheDocument();
      const saved = ctx.session.tagLifecycle.getSnapshot().returnTo;
      expect.assert(saved);
      finishRead = ctx.holdReads();
      ctx.router.history.back();
      await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(true);
      ctx.router.history.forward();
      await expect
        .poll(() => ctx.router.state.location.pathname)
        .toBe("/access");
      await page.getByTestId("add-device-toggle").click();
      await page.getByTestId("add-client-device").click();
      await page.getByTestId("setup-tags-search").fill("tag:newer-draft");
      ctx.router.history.back();
      finishRead();
      await expect.poll(() => ctx.session.snapshot.isRefreshing).toBe(false);
      await expect
        .element(page.getByTestId("setup-tags-search"))
        .toHaveValue("tag:newer-draft");
      expect(ctx.session.tagLifecycle.getSnapshot().returnTo?.id).toBe(
        saved.id,
      );
      await userEvent.keyboard("{Escape}");
      await expect
        .element(page.getByTestId("tag-return-read-error"))
        .toMatchTextContent(getProductCopy("en-US").tagReturnNewerEdit);
      await page.getByTestId("tag-return-retry").click();
      await expect
        .element(
          page.getByTestId(
            source === "device"
              ? "node-tags-remove-tag:legacy"
              : "setup-tags-remove-tag:server",
          ),
        )
        .toBeVisible();
      expect(ctx.session.tagLifecycle.getSnapshot().returnTo).toBeNull();
      expect(ctx.writes()).toHaveLength(0);
    } finally {
      finishRead?.();
      loading.resolve();
    }
  },
);
