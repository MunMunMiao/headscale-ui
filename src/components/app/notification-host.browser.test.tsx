import type { FetchHandle } from "@defjs/core";
import { afterEach, expect, test, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useSession } from "@/composables/session-context";
import {
  type NotificationOperation,
  useActionFeedback,
} from "@/composables/useActionFeedback";
import { i18n, setLocale } from "@/i18n";
import { commonDescriptors, productDescriptors } from "@/i18n/descriptors";
import {
  authenticateTestSession,
  prepareTestSession,
  SessionTestProviders,
} from "@/test/session";
import { snapshotFixture } from "@/test-utils/headscale.test";

const notifications = () =>
  page.getByRole("region", { name: "Notifications", exact: true });
const notification = () => notifications().getByRole("dialog");
const closeNotification = () =>
  notifications().getByRole("button", { name: "Close", exact: true });

afterEach(async () => {
  vi.restoreAllMocks();
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await page.viewport(1280, 720);
});

function Controls() {
  const session = useSession();
  const feedback = useActionFeedback();
  const reportFailure = () => {
    const isCurrent = session.snapshot.captureSession();
    session.feedback.beginNotification({ isCurrent }).publishMutation({
      status: "pre-rejected",
      refresh: "not-requested",
      failure: { kind: "api", message: "raw-http-secret-canary" },
    });
  };
  const connect = async () => {
    await session.profiles.loadProfile("__new__");
    session.profiles.setConnectionForm({
      profileName: "Notification fixture",
      baseUrl: "https://notification.invalid",
      apiKey: "isolated-notification-test-key",
      password: "isolated-test-password",
    });
    const ticket = session.profiles.authorizationGeneration + 1;
    const form = session.profiles.connectionFormGeneration;
    const operation = session.feedback.beginNotification({
      isCurrent: () =>
        ticket === session.profiles.authorizationGeneration &&
        form === session.profiles.connectionFormGeneration,
    });
    await session.profiles.addProfile(true);
    if (session.auth.getSessionSnapshot()?.status === "unlocked")
      operation.publish({ tone: "success", title: "common.updatedProfile" });
  };
  const unlock = async () => {
    const profile = session.profiles.getSnapshot().profiles[0];
    if (!profile) return;
    const ticket = session.profiles.authorizationGeneration + 1;
    const operation = session.feedback.beginNotification({
      isCurrent: () => ticket === session.profiles.authorizationGeneration,
    });
    if (await session.profiles.enterProfile(profile, "isolated-test-password"))
      operation.publish({ tone: "success", title: "common.updatedProfile" });
  };
  return (
    <>
      <output data-testid="business-feedback">
        {feedback.actionError("save-policy")}
      </output>
      <Button type="button" onClick={reportFailure}>
        Report failure
      </Button>
      <Button type="button" onClick={() => void connect()}>
        Connect fixture
      </Button>
      <Button type="button" onClick={() => void unlock()}>
        Unlock fixture
      </Button>
      <Dialog>
        <DialogTrigger render={<Button type="button" />}>
          Open form
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Connection form</DialogTitle>
          <DialogDescription>
            Keep this form open while reviewing feedback.
          </DialogDescription>
          <label>
            Profile name
            <input defaultValue="Unsubmitted input" />
          </label>
          <Button type="button" onClick={reportFailure}>
            Report form failure
          </Button>
          <AlertDialog>
            <AlertDialogTrigger render={<Button type="button" />}>
              Review action
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogTitle>Confirm action</AlertDialogTitle>
              <AlertDialogDescription>
                This confirmation must not close with its toast.
              </AlertDialogDescription>
              <Button type="button" onClick={reportFailure}>
                Report review failure
              </Button>
              <AlertDialogCancel>Cancel review</AlertDialogCancel>
            </AlertDialogContent>
          </AlertDialog>
        </DialogContent>
      </Dialog>
    </>
  );
}

async function setup() {
  const fixture = snapshotFixture();
  const transport: FetchHandle = async (input, init) => {
    const request = new Request(input, init);
    const values: Record<string, unknown> = {
      "/api/v1/health": fixture.health,
      "/version": fixture.version,
      "/api/v1/user": { users: fixture.users },
      "/api/v1/node": { nodes: fixture.nodes },
      "/api/v1/preauthkey": { preAuthKeys: fixture.preAuthKeys },
      "/api/v1/apikey": { apiKeys: fixture.apiKeys },
      "/api/v1/policy": fixture.policy,
    };
    return Response.json(values[new URL(request.url).pathname]);
  };
  const session = await prepareTestSession(transport);
  i18n.activate("en-US");
  // The coordinator owns catalog extraction. Missing new catalog entries are not a behavior RED.
  i18n.load("en-US", {
    [commonDescriptors.notifications.id]: "Notifications",
    [productDescriptors.feedbackRequestRejected.id]: "Request rejected",
  });
  await render(
    <SessionTestProviders session={session}>
      <Controls />
    </SessionTestProviders>,
  );
  return session;
}

async function setupRefreshes() {
  const session = await setup();
  await authenticateTestSession(session);
  await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
  return session;
}

test("adjacent successful user refreshes share one visible row without merging operation publications", async () => {
  const session = await setupRefreshes();
  const add = vi.spyOn(session.feedback.toastManager, "add");
  const outcome = { status: "unknown", refresh: "failed" } as const;
  session.feedback.setActionOutcome("save-policy", outcome);
  const before = session.feedback.getSnapshot();

  await session.snapshot.refreshByUser();
  await expect.element(notification()).toHaveAccessibleName("Data updated");
  await userEvent.keyboard("{F6}");
  await session.snapshot.refreshByUser();

  await expect.poll(() => notification().elements().length).toBe(1);
  await expect.element(notification()).toHaveAccessibleName("Data updated");
  expect(add).toHaveBeenCalledTimes(2);
  expect(new Set(add.mock.calls.map(([toast]) => toast.id)).size).toBe(2);
  expect(session.feedback.getSnapshot()).toBe(before);
});

test.each([
  { status: "pre-rejected", title: "Request rejected" },
  { status: "unknown", title: "Response unknown" },
  { status: "possibly-applied", title: "The change may have been applied" },
] as const)(
  "refresh success does not merge across an intervening $status result, even after it closes",
  async ({ status, title }) => {
    const session = await setupRefreshes();
    await session.snapshot.refreshByUser();
    session.feedback
      .beginNotification({ isCurrent: session.snapshot.captureSession() })
      .publishMutation({ status, refresh: "not-requested" });
    await session.snapshot.refreshByUser();

    await expect.poll(() => notification().elements().length).toBe(3);
    const barrier = notifications().getByRole("dialog", {
      name: title,
      exact: true,
    });
    await expect.element(barrier).toBeVisible();
    await barrier.getByRole("button", { name: "Close", exact: true }).click();
    await expect.element(barrier).not.toBeInTheDocument();
    await expect.poll(() => notification().elements().length).toBe(2);
  },
);

test.each([
  {
    status: "confirmed",
    refresh: "succeeded",
    title: "Data updated",
  },
  { status: "confirmed", refresh: "failed", title: "Data updated" },
  { status: "unknown", refresh: "failed", title: "Response unknown" },
  {
    status: "possibly-applied",
    refresh: "failed",
    title: "The change may have been applied",
  },
] as const)(
  "$status/$refresh writes keep their own visible results, including an identical refresh title",
  async ({ status, refresh, title }) => {
    const session = await setupRefreshes();
    const outcome = { status, refresh };
    session.feedback.setActionOutcome("rename-node", outcome);
    session.feedback.setActionOutcome("save-policy", outcome);
    for (let index = 0; index < 2; index++)
      session.feedback
        .beginNotification({ isCurrent: session.snapshot.captureSession() })
        .publishMutation(outcome, "product.dataRefreshed");

    await expect.poll(() => notification().elements().length).toBe(2);
    for (const toast of notification().elements())
      expect(toast).toHaveAccessibleName(title);
    expect(session.feedback.actionOutcome("rename-node")).toBe(outcome);
    expect(session.feedback.actionOutcome("save-policy")).toBe(outcome);
  },
);

test.each(["pointer", "toast Escape", "viewport Escape"] as const)(
  "%s dismissal retires every member of a merged refresh row without reviving hidden messages",
  async (input) => {
    const session = await setupRefreshes();
    for (let index = 0; index < 4; index++)
      await session.snapshot.refreshByUser();
    await expect.poll(() => notification().elements().length).toBe(1);

    if (input === "pointer") await closeNotification().click();
    else {
      await userEvent.keyboard("{F6}");
      if (input === "toast Escape") await userEvent.keyboard("{Tab}");
      await userEvent.keyboard("{Escape}");
    }
    await expect.element(notification()).not.toBeInTheDocument();
    await expect
      .poll(() => document.querySelectorAll('[data-slot="toast"]').length)
      .toBe(0);

    session.feedback
      .beginNotification({ isCurrent: session.snapshot.captureSession() })
      .publishMutation({ status: "pre-rejected", refresh: "not-requested" });
    await expect
      .element(notification())
      .toHaveAccessibleName("Request rejected");
    await session.snapshot.refreshByUser();
    await expect.poll(() => notification().elements().length).toBe(2);
  },
);

test("merged refresh members do not consume another result's visible slot or dismiss it", async () => {
  const session = await setupRefreshes();
  session.feedback
    .beginNotification({ isCurrent: session.snapshot.captureSession() })
    .publishMutation({ status: "pre-rejected", refresh: "not-requested" });
  for (let index = 0; index < 4; index++)
    await session.snapshot.refreshByUser();
  await expect.poll(() => notification().elements().length).toBe(2);
  const failure = notifications().getByRole("dialog", {
    name: "Request rejected",
    exact: true,
  });
  await expect.element(failure).toBeVisible();
  await notifications()
    .getByRole("dialog", { name: "Data updated", exact: true })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect.element(notification()).toHaveAccessibleName("Request rejected");
});

test.each(["Enter", "Escape"] as const)(
  "%s on an older error restores keyboard focus to the visible refresh representative, not a hidden member",
  async (key) => {
    const session = await setupRefreshes();
    await page
      .getByRole("button", { name: "Report failure", exact: true })
      .click();
    for (let index = 0; index < 4; index++)
      await session.snapshot.refreshByUser();
    await expect.poll(() => notification().elements().length).toBe(2);
    const failure = notifications().getByRole("dialog", {
      name: "Request rejected",
      exact: true,
    });
    const refresh = notifications().getByRole("dialog", {
      name: "Data updated",
      exact: true,
    });
    await userEvent.keyboard("{F6}{Tab}{Tab}{Tab}{Tab}");
    await expect
      .element(failure.getByRole("button", { name: "Close", exact: true }))
      .toHaveFocus();
    await userEvent.keyboard(`{${key}}`);
    await expect.element(failure).not.toBeInTheDocument();
    expect(refresh.element()).toHaveFocus();
  },
);

test("an unfocused error timing out does not move focus from the modal input to a refresh representative", async () => {
  const session = await setupRefreshes();
  const timers: Array<() => void> = [];
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    handler: () => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    if (ms === 4000) timers.push(handler);
    return realSetTimeout(handler, ms, ...args);
  }) as typeof setTimeout);
  await page
    .getByRole("button", { name: "Report failure", exact: true })
    .click();
  for (let index = 0; index < 4; index++)
    await session.snapshot.refreshByUser();
  await expect.poll(() => notification().elements().length).toBe(2);
  await page.getByRole("button", { name: "Open form", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Profile name" });
  await input.fill("Keep my focus and draft");
  await expect.element(input).toHaveFocus();
  const timeout = timers[0];
  expect.assert(timeout);
  timeout();
  await expect
    .element(
      notifications().getByRole("dialog", {
        name: "Request rejected",
        exact: true,
      }),
    )
    .not.toBeInTheDocument();
  await expect.element(input).toHaveFocus();
  await expect.element(input).toHaveValue("Keep my focus and draft");
  await expect
    .element(page.getByRole("dialog", { name: "Connection form", exact: true }))
    .toBeVisible();
  await expect
    .element(
      notifications().getByRole("dialog", {
        name: "Data updated",
        exact: true,
      }),
    )
    .toBeVisible();
});

test("a new session never inherits a previous session's merged refresh row", async () => {
  const session = await setupRefreshes();
  const old = session.feedback.beginNotification({
    isCurrent: session.snapshot.captureSession(),
  });
  await session.snapshot.refreshByUser();
  await session.snapshot.refreshByUser();
  await expect.poll(() => notification().elements().length).toBe(1);
  await session.profiles.logout();
  await expect.element(notification()).not.toBeInTheDocument();
  expect(old.publish({ tone: "success", title: "product.dataRefreshed" })).toBe(
    false,
  );

  await authenticateTestSession(session);
  await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
  await session.snapshot.refreshByUser();
  await expect.element(notification()).toHaveAccessibleName("Data updated");
  await closeNotification().click();
  await expect.element(notification()).not.toBeInTheDocument();
});

test("the root host covers locked/login consumers and never renders raw failure text", async () => {
  const session = await setup();
  expect(session.client.getSnapshot().identity).toBeNull();
  await page
    .getByRole("button", { name: "Report failure", exact: true })
    .click();
  await expect.element(notification()).toHaveAccessibleName("Request rejected");
  expect(document.body.textContent).not.toContain("raw-http-secret-canary");
  await closeNotification().click();
  await expect.element(notification()).not.toBeInTheDocument();
});

test("a real modal keeps a readable and keyboard-operable toast above its backdrop", async () => {
  await setup();
  await page.getByRole("button", { name: "Open form", exact: true }).click();
  const report = page.getByRole("button", {
    name: "Report form failure",
    exact: true,
  });
  await report.click();
  await expect.element(notification()).toBeVisible();
  const close = closeNotification().element();
  const rect = close.getBoundingClientRect();
  expect(
    close.contains(
      document.elementFromPoint(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
      ),
    ),
  ).toBe(true);
  await userEvent.keyboard("{F6}");
  await expect.element(notifications()).toHaveFocus();
  await userEvent.keyboard("{Tab}{Tab}");
  await expect.element(closeNotification()).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(notification()).not.toBeInTheDocument();
  await expect.element(report).toHaveFocus();
  await expect
    .element(page.getByRole("dialog", { name: "Connection form", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("textbox", { name: "Profile name" }))
    .toHaveValue("Unsubmitted input");
});

test("Escape dismisses only the focused toast, then its nested confirmation, then its parent form", async () => {
  await setup();
  await page.getByRole("button", { name: "Open form", exact: true }).click();
  await page
    .getByRole("button", { name: "Review action", exact: true })
    .click();
  const report = page.getByRole("button", {
    name: "Report review failure",
    exact: true,
  });
  await report.click();
  await expect.element(notification()).toBeVisible();
  await userEvent.keyboard("{F6}{Tab}");
  await expect.element(notification()).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(notification()).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("alertdialog", { name: "Confirm action" }))
    .toBeVisible();
  await expect.element(report).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("alertdialog", { name: "Confirm action" }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Review action", exact: true }))
    .toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("button", { name: "Open form", exact: true }))
    .toHaveFocus();
});

test("notifications retain the existing four-second timeout without clearing business evidence", async () => {
  const session = await setup();
  session.feedback.setState({
    actionErrors: { "save-policy": { message: "file-mode-blocker" } },
  });
  session.feedback.setActionOutcome("save-policy", {
    status: "unknown",
    refresh: "failed",
  });
  const before = session.feedback.getSnapshot();
  const timers: { handler: () => void; ms?: number }[] = [];
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    handler: () => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    timers.push({ handler, ms });
    return realSetTimeout(handler, ms, ...args);
  }) as typeof setTimeout);
  await page
    .getByRole("button", { name: "Report failure", exact: true })
    .click();
  await expect.element(notification()).toBeVisible();
  await expect.poll(() => timers.some((timer) => timer.ms === 4000)).toBe(true);
  const timer = timers.find((entry) => entry.ms === 4000);
  expect.assert(timer);
  timer.handler();
  await expect.element(notification()).not.toBeInTheDocument();
  expect(session.feedback.getSnapshot()).toBe(before);
  await expect
    .element(page.getByTestId("business-feedback"))
    .toHaveTextContent("file-mode-blocker");
});

test("a valid connection and re-unlock keep their new result, while old scopes stay silent", async () => {
  const session = await setup();
  let old: NotificationOperation = session.feedback.beginNotification({
    isCurrent: session.snapshot.captureSession(),
  });
  await page
    .getByRole("button", { name: "Connect fixture", exact: true })
    .click();
  await expect.element(notification()).toHaveAccessibleName("Updated");
  expect(session.auth.getSessionSnapshot()?.status).toBe("unlocked");
  expect(old.publish({ tone: "error", title: "common.operationFailed" })).toBe(
    false,
  );
  old = session.feedback.beginNotification({
    isCurrent: session.snapshot.captureSession(),
  });
  await session.profiles.logout();
  await expect.element(notification()).not.toBeInTheDocument();
  await page
    .getByRole("button", { name: "Unlock fixture", exact: true })
    .click();
  await expect.element(notification()).toHaveAccessibleName("Updated");
  expect(old.publish({ tone: "error", title: "common.operationFailed" })).toBe(
    false,
  );
  expect(notifications().getByRole("dialog").elements()).toHaveLength(1);
});

test("the root host keeps all limited toast data non-secret at a narrow RTL viewport", async () => {
  await setup();
  await page.viewport(375, 812);
  await setLocale("ar");
  i18n.load("ar", { [commonDescriptors.notifications.id]: "Notifications" });
  try {
    for (let index = 0; index < 4; index++)
      await page
        .getByRole("button", { name: "Report failure", exact: true })
        .click();
    await expect.element(notification().first()).toBeVisible();
    const rect = notifications().element().getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
    expect(
      document.querySelectorAll('[data-slot="toast"]:not([inert])'),
    ).toHaveLength(3);
    expect(document.body.textContent).not.toContain("raw-http-secret-canary");
  } finally {
    await setLocale("en-US");
  }
});

test.each(["pointer", "touch"] as const)(
  "%s dismissal preserves the real modal, its draft and uncertain-result feedback",
  async (input) => {
    const session = await setup();
    await page
      .getByRole("button", { name: "Connect fixture", exact: true })
      .click();
    await expect.element(notification()).toHaveAccessibleName("Updated");
    await closeNotification().click();
    await expect.element(notification()).not.toBeInTheDocument();
    await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
    const outcome = { status: "unknown", refresh: "failed" } as const;
    session.feedback.setActionOutcome("node-tags", outcome);
    await page.getByRole("button", { name: "Open form", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Profile name" })
      .fill("Keep my unsubmitted draft");
    await page
      .getByRole("button", { name: "Report form failure", exact: true })
      .click();
    await expect.element(notification()).toBeVisible();
    if (input === "pointer") {
      await closeNotification().click();
    } else {
      await cdp().send("Emulation.setTouchEmulationEnabled", {
        enabled: true,
        maxTouchPoints: 1,
      });
      const close = closeNotification().element();
      const pointerTypes: string[] = [];
      close.addEventListener(
        "pointerdown",
        (event) => pointerTypes.push((event as PointerEvent).pointerType),
        { once: true },
      );
      const rect = close.getBoundingClientRect();
      const frame = (
        window.frameElement as HTMLElement | null
      )?.getBoundingClientRect();
      await cdp().send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [
          {
            x: (frame?.left ?? 0) + rect.left + rect.width / 2,
            y: (frame?.top ?? 0) + rect.top + rect.height / 2,
          },
        ],
      });
      await cdp().send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      expect(pointerTypes).toEqual(["touch"]);
    }
    await expect.element(notification()).not.toBeInTheDocument();
    await expect
      .element(
        page.getByRole("dialog", { name: "Connection form", exact: true }),
      )
      .toBeVisible();
    await expect
      .element(page.getByRole("textbox", { name: "Profile name" }))
      .toHaveValue("Keep my unsubmitted draft");
    expect(session.feedback.actionOutcome("node-tags")).toEqual(outcome);
  },
);

test("Escape from the notification viewport closes its first toast and returns focus", async () => {
  const session = await setup();
  // Exercise the renderer's optional Base UI metadata, without supplying any diagnostic data.
  session.feedback.toastManager.add({
    title: "Adapter notification",
    priority: "low",
  });
  await expect
    .element(notification())
    .toHaveAccessibleName("Adapter notification");
  await userEvent.tab();
  await expect
    .element(page.getByRole("button", { name: "Report failure", exact: true }))
    .toHaveFocus();
  await userEvent.keyboard("{F6}");
  await expect.element(notifications()).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(notification()).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Report failure", exact: true }))
    .toHaveFocus();
});

test("Escape in an ending or empty notification viewport never dismisses the underlying modal", async () => {
  const session = await setup();
  await page.getByRole("button", { name: "Open form", exact: true }).click();
  for (let index = 0; index < 4; index++)
    await page
      .getByRole("button", { name: "Report form failure", exact: true })
      .click();
  await expect
    .poll(() => document.querySelectorAll('[data-slot="toast"]').length)
    .toBe(4);
  await Promise.all(
    document
      .getAnimations()
      .map((animation) => animation.finished.catch(() => {})),
  );
  // Hold the actual exit lifecycle, including the overflow item, while sending a real Escape.
  for (const toast of document.querySelectorAll<HTMLElement>(
    '[data-slot="toast"]',
  ))
    toast.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 1000 }).pause();
  session.feedback.toastManager.close();
  await expect
    .poll(
      () =>
        document.querySelectorAll('[data-slot="toast"][data-ending-style]')
          .length,
    )
    .toBe(4);
  expect(
    document.querySelectorAll(
      '[data-slot="toast"][data-limited][data-ending-style]',
    ),
  ).toHaveLength(1);
  const ending = document.getAnimations();
  for (const animation of ending) animation.pause();
  notifications().element().focus();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("dialog", { name: "Connection form", exact: true }))
    .toBeVisible();
  for (const animation of ending) animation.finish();
  await expect.element(notification()).not.toBeInTheDocument();
  notifications().element().focus();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("dialog", { name: "Connection form", exact: true }))
    .toBeVisible();
});
