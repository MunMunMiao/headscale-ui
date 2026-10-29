import "fake-indexeddb/auto";
import type { FetchHandle } from "@defjs/core";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { HeadscaleSnapshot } from "@/api/contracts";
import { setLocale } from "@/i18n";
import {
  authenticateTestSession,
  prepareTestSession,
  renderSessionPage,
} from "@/test/session";
import InvitesPage from "./InvitesPage";

const SECRET = "hskey-auth-Ab3_dEf-9hIj-0123456789abcdef0123456789abcdef";
const LISTED = "hskey-auth-Ab3_dEf-9hIj-***";
const alice = { id: "1", name: "alice" };

async function setup(
  path = "/invites",
  tweak?: (backend: HeadscaleSnapshot) => void,
) {
  const backend: HeadscaleSnapshot = {
    health: { databaseConnectivity: true, serverReachable: true },
    version: { version: "0.29.4" },
    users: [alice],
    nodes: [],
    apiKeys: [],
    policy: { policy: '{"acls":[]}' },
    preAuthKeys: [
      {
        id: "1",
        key: LISTED,
        user: alice,
        reusable: false,
        ephemeral: false,
        used: false,
        expiration: "2099-01-01T00:00:00Z",
        aclTags: [],
      },
    ],
  };
  tweak?.(backend);
  let readFailure = false;
  let readHold: Promise<void> | undefined;
  const writes: Array<{ path: string; body: unknown }> = [];
  const transport: FetchHandle = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method === "POST") {
      writes.push({ path, body: await request.json() });
      return Response.json({ message: "Creation refused" }, { status: 400 });
    }
    if (readHold && path === "/api/v1/preauthkey") await readHold;
    if (readFailure && path === "/api/v1/preauthkey") {
      return Response.json(
        { message: "Identity read failed" },
        { status: 500 },
      );
    }
    const reads: Record<string, unknown> = {
      "/api/v1/health": backend.health,
      "/version": backend.version,
      "/api/v1/user": { users: backend.users },
      "/api/v1/node": { nodes: [] },
      "/api/v1/preauthkey": { preAuthKeys: backend.preAuthKeys },
      "/api/v1/apikey": { apiKeys: [] },
      "/api/v1/policy": backend.policy,
    };
    return Response.json(reads[path]);
  };
  const session = await prepareTestSession(transport);
  await setLocale("en-US");
  await authenticateTestSession(session);
  const { router } = await renderSessionPage(session, <InvitesPage />, path);
  await expect.poll(() => session.snapshot.getSnapshot().isReady).toBe(true);
  await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
  session.deviceSetup.setState({ lastCreatedInvite: SECRET });
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  return {
    backend,
    session,
    router,
    writes,
    failReads: (value: boolean) => {
      readFailure = value;
    },
    holdReads: () => {
      let release!: () => void;
      readHold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        readHold = undefined;
        release();
      };
    },
  };
}
afterEach(() => vi.restoreAllMocks());

test.each(["deleted", "expired", "used"])(
  "a successful identity refresh reports a created key as %s without losing the only secret",
  async (kind) => {
    const ctx = await setup();
    if (kind === "deleted") ctx.backend.preAuthKeys = [];
    else {
      const key = ctx.backend.preAuthKeys[0];
      if (!key) throw new Error("Missing fixture key");
      if (kind === "expired") key.expiration = "2000-01-01T00:00:00Z";
      else key.used = true;
    }
    await page.getByTestId("refresh-auth-keys").click();
    await expect
      .element(page.getByTestId("created-invite-status"))
      .toMatchTextContent("no longer usable");
    await expect
      .element(page.getByTestId("created-invite-status"))
      .toBeVisible();
    expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe(
      SECRET,
    );
  },
);

test("a failed refresh reports unknown, not deletion, and a used reusable key remains usable", async () => {
  const ctx = await setup();
  ctx.failReads(true);
  await page.getByTestId("refresh-auth-keys").click();
  await expect
    .poll(() => ctx.session.snapshot.getSnapshot().refreshErrors.identity)
    .toBeTruthy();
  await expect
    .element(page.getByTestId("created-invite-status"))
    .toMatchTextContent("not verified");
  await expect
    .element(page.getByTestId("created-invite-status"))
    .not.toMatchTextContent("no longer usable");
  expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe(SECRET);
  const key = ctx.backend.preAuthKeys[0];
  if (!key) throw new Error("Missing fixture key");
  key.used = true;
  key.reusable = true;
  ctx.failReads(false);
  await page.getByTestId("refresh-auth-keys").click();
  await expect
    .element(page.getByTestId("created-invite-status"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("copy-created-install-command"))
    .toBeEnabled();
  await expect
    .element(page.getByTestId("invite-registration-1"))
    .toHaveTextContent("Available for new registration");
  await page.getByTestId("invite-filter").selectOptions("ready");
  await expect.element(page.getByTestId("invite-1")).not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("invite-count"))
    .toHaveTextContent("0 / 1");
  await page.getByTestId("invite-filter").selectOptions("used");
  await expect
    .element(page.getByTestId("invite-registration-1"))
    .toHaveTextContent("Available for new registration");
  await expect
    .element(page.getByTestId("copy-created-install-command"))
    .toBeEnabled();
});

test("exact tag links include all matching keys without matching prefixes or case variants", async () => {
  const ctx = await setup("/invites?tag=tag%3Aprod", (backend) => {
    const original = backend.preAuthKeys[0];
    if (!original) throw new Error("Missing fixture key");
    backend.preAuthKeys = [
      { ...original, id: "1", aclTags: ["tag:prod"], used: true },
      {
        ...original,
        id: "2",
        aclTags: ["tag:prod"],
        expiration: "2000-01-01T00:00:00Z",
      },
      { ...original, id: "3", aclTags: ["tag:production"] },
      { ...original, id: "4", aclTags: ["tag:Prod"] },
      {
        ...original,
        id: "5",
        aclTags: ["tag:prod"],
        reusable: true,
        used: true,
      },
    ];
  });
  await expect
    .element(page.getByTestId("invite-count"))
    .toMatchTextContent("3 / 5");
  await expect.element(page.getByTestId("invite-1")).toBeVisible();
  await expect.element(page.getByTestId("invite-2")).toBeVisible();
  await expect.element(page.getByTestId("invite-3")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("invite-4")).not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("invite-registration-5"))
    .toHaveTextContent("Available for new registration");
  await page.getByTestId("invite-filter").selectOptions("ready");
  await expect
    .element(page.getByTestId("invite-count"))
    .toMatchTextContent("0 / 5");
  await expect.element(page.getByTestId("invite-5")).not.toBeInTheDocument();
  expect(ctx.router.state.location.search).toMatchObject({
    tag: "tag:prod",
    filter: "ready",
  });
  await page.getByTestId("invite-clear-tag").click();
  expect(ctx.router.state.location.search).not.toHaveProperty("tag");
  await expect
    .element(page.getByTestId("invite-count"))
    .toMatchTextContent("2 / 5");
  await expect.element(page.getByTestId("invite-3")).toBeVisible();
  await expect.element(page.getByTestId("invite-4")).toBeVisible();
  expect(ctx.writes).toEqual([]);
});

test("an unreadable reusable-key expiry remains unknown rather than claiming one-time exhaustion", async () => {
  await setup("/invites", (backend) => {
    const key = backend.preAuthKeys[0];
    if (!key) throw new Error("Missing fixture key");
    key.reusable = true;
    key.used = false;
    key.expiration = "unreadable";
  });
  await expect
    .element(page.getByTestId("invite-status-1"))
    .toHaveTextContent("Unknown");
  await expect
    .element(page.getByTestId("invite-registration-1"))
    .toHaveTextContent("Unknown");
  await page.getByTestId("invite-filter").selectOptions("ready");
  await expect.element(page.getByTestId("invite-1")).not.toBeInTheDocument();
});

test("an in-flight refresh does not claim a missing key is invalid before the identity response", async () => {
  const ctx = await setup();
  ctx.backend.preAuthKeys = [];
  const release = ctx.holdReads();
  try {
    await page.getByTestId("refresh-auth-keys").click();
    await expect
      .element(page.getByTestId("created-invite-status"))
      .toMatchTextContent("not verified");
    await expect
      .element(page.getByTestId("created-invite-status"))
      .not.toMatchTextContent("no longer usable");
    expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe(
      SECRET,
    );
  } finally {
    release();
  }
  await expect
    .element(page.getByTestId("created-invite-status"))
    .toMatchTextContent("no longer usable");
});

test("key result explains one-time visibility and the count shows filtered totals", async () => {
  await setup();
  await expect
    .element(page.getByTestId("created-invite"))
    .toMatchTextContent("cannot be retrieved again");
  const count = page.getByTestId("invite-count");
  await expect.element(count).toHaveTextContent("1 / 1");
  await page.getByTestId("invite-search").fill("missing");
  await expect.element(count).toHaveTextContent("0 / 1");
});

test("the created-key card fits the desktop viewport when revealed", async () => {
  await page.viewport(1024, 600);
  const ctx = await setup();
  ctx.session.deviceSetup.setState({ revealCreatedInvite: true });
  const card = page.getByTestId("created-invite");
  await expect.element(card).toHaveFocus();
  await expect
    .poll(() => {
      const rect = card.element().getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight + 1;
    })
    .toBe(true);
});

test("invalid login URLs hide only the connection command, not the saved key", async () => {
  await setup();
  const field = page.getByTestId("invite-login-server");
  for (const value of ["", "ftp://control.example.test", "https://"]) {
    await field.fill(value);
    await expect.element(field).toHaveAttribute("aria-invalid", "true");
    await expect
      .element(page.getByTestId("invite-login-server-error"))
      .toBeVisible();
    await expect
      .element(page.getByTestId("copy-created-install-command"))
      .not.toBeInTheDocument();
    await expect.element(page.getByTestId("copy-created-invite")).toBeEnabled();
  }
  await field.fill("https://control.example.test");
  await expect
    .element(page.getByTestId("invite-login-server-error"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("copy-created-install-command"))
    .toBeEnabled();
});

test("trims the local command URL on blur and Enter without replacing its one-time secret", async () => {
  const ctx = await setup();
  const field = page.getByTestId("invite-login-server");
  await field.fill("  https://control.example.test/  ");
  await userEvent.tab();
  await expect.element(field).toHaveValue("https://control.example.test/");
  expect(ctx.session.deviceSetup.getSnapshot().loginServer).toBe(
    "https://control.example.test/",
  );
  await field.fill("  http://127.0.0.1:18080/path?x=1  ");
  await userEvent.keyboard("{Enter}");
  await expect.element(field).toHaveValue("http://127.0.0.1:18080/path?x=1");
  expect(ctx.session.deviceSetup.getSnapshot().loginServer).toBe(
    "http://127.0.0.1:18080/path?x=1",
  );
  expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe(SECRET);
  expect(ctx.writes).toEqual([]);
});

test("a stale command draft rejects native submission without trimming or publishing it", async () => {
  const ctx = await setup();
  const field = page.getByTestId("invite-login-server");
  const draft = "  https://old-server.example.test  ";
  await field.fill(draft);
  const form = (field.element() as HTMLInputElement).form;
  expect.assert(form);
  ctx.session.drafts.hold(
    { id: "previous-profile", name: "Previous server" },
    true,
  );
  await expect.element(field).toBeDisabled();
  form.requestSubmit();
  await userEvent.keyboard("{Escape}");
  await expect.element(field).toHaveValue(draft);
  expect(ctx.session.deviceSetup.getSnapshot().loginServer).toBe(draft);
  expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe(SECRET);
  expect(ctx.session.drafts.isCurrent()).toBe(false);
  expect(ctx.writes).toEqual([]);
});

test("an input event already in flight cannot publish a command draft after the session becomes stale", async () => {
  const ctx = await setup();
  const field = page.getByTestId("invite-login-server");
  await field.fill("https://saved.example.test");
  const input = field.element() as HTMLInputElement;
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  expect.assert(setValue);
  // 同一任务内到达已排队的原生输入，React 尚未把失效状态提交为 disabled。
  ctx.session.drafts.hold(
    { id: "previous-profile", name: "Previous server" },
    true,
  );
  expect(input.disabled).toBe(false);
  setValue.call(input, "https://late-input.example.test");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await expect.element(field).toBeDisabled();
  await expect.element(field).toHaveValue("https://late-input.example.test");
  expect(ctx.session.deviceSetup.getSnapshot().loginServer).toBe(
    "https://saved.example.test",
  );
  expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe(SECRET);
  expect(ctx.writes).toEqual([]);
});

test("an external pending creation blocks a close callback before the child receives its busy props", async () => {
  const ctx = await setup();
  await page.getByTestId("open-create-invite").click();
  await expect.element(page.getByTestId("invite-user")).toHaveValue("1");
  const cancel = page
    .getByTestId("cancel-create-invite")
    .element() as HTMLButtonElement;
  const request = Promise.withResolvers<void>();
  const externalAction = ctx.session.feedback.runAction(
    "create-invite",
    () => request.promise,
  );
  cancel.click();
  try {
    await expect
      .element(page.getByTestId("invite-create-dialog"))
      .toBeVisible();
    await expect
      .element(page.getByTestId("create-invite"))
      .toHaveAttribute("aria-busy", "true");
    expect(ctx.writes).toEqual([]);
  } finally {
    request.resolve();
    await externalAction;
  }
  await expect.element(page.getByTestId("cancel-create-invite")).toBeEnabled();
  await page.getByTestId("cancel-create-invite").click();
  await expect
    .element(page.getByTestId("invite-create-dialog"))
    .not.toBeInTheDocument();
  expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe(SECRET);
});

test("an action confirmation already in flight cannot duplicate another pending invitation action", async () => {
  const ctx = await setup();
  await page.getByTestId("invite-actions-trigger-1").click();
  await page.getByTestId("expire-invite-1").click();
  const confirm = page.getByTestId("confirm-invite-action");
  await expect.element(confirm).toBeEnabled();
  const button = confirm.element() as HTMLButtonElement;
  const request = Promise.withResolvers<void>();
  const externalAction = ctx.session.feedback.runAction(
    "invite-action",
    () => request.promise,
  );
  try {
    expect(button.disabled).toBe(false);
    button.click();
    await expect.element(confirm).toBeDisabled();
    await expect
      .element(page.getByTestId("expire-invite-dialog"))
      .toBeVisible();
    expect(ctx.writes).toEqual([]);
    expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe(
      SECRET,
    );
  } finally {
    request.resolve();
    await externalAction;
  }
  await expect.element(confirm).toBeEnabled();
  await page.getByTestId("cancel-invite-action").click();
  await expect
    .element(page.getByTestId("expire-invite-dialog"))
    .not.toBeInTheDocument();
  expect(ctx.writes).toEqual([]);
  expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe(SECRET);
});

test("adopts shared command drafts without reverting a newer one-time secret", async () => {
  const ctx = await setup();
  const field = page.getByTestId("invite-login-server");
  await field.fill("https://edited.example.test");
  const newerSecret = "new-one-time-secret-from-members";
  ctx.session.deviceSetup.setState({
    loginServer: "https://shared.example.test/",
    lastCreatedInvite: newerSecret,
  });
  await expect.element(field).toHaveValue("https://shared.example.test/");
  await expect
    .element(page.getByTestId("created-invite"))
    .toMatchTextContent(newerSecret);
  await field.fill("  https://next.example.test  ");
  await userEvent.tab();
  expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe(
    newerSecret,
  );
  expect(ctx.session.deviceSetup.getSnapshot().loginServer).toBe(
    "https://next.example.test",
  );
});

test("a failed creation keeps the previous one-time secret and the edited key options", async () => {
  const ctx = await setup();
  await page.getByTestId("open-create-invite").click();
  await page.getByTestId("invite-tags-search").fill("  tag:server  ");
  await page.getByTestId("invite-tags-add").click();
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("create-invite-error"))
    .toMatchTextContent("Creation refused");
  await expect
    .element(page.getByTestId("invite-tags-selected"))
    .toMatchTextContent("tag:server");
  await expect.element(page.getByTestId("create-invite")).toBeEnabled();
  await expect.element(page.getByTestId("invite-create-unknown")).toBeVisible();
  await expect
    .element(page.getByTestId("invite-create-verify"))
    .toHaveAttribute("href", "/invites");
  await expect
    .element(page.getByTestId("invite-create-new-operation"))
    .not.toBeInTheDocument();
  expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe(SECRET);
  expect(ctx.writes).toHaveLength(1);
  expect(ctx.writes[0]?.body).toMatchObject({
    user: "1",
    aclTags: ["tag:server"],
  });
});

test("the Auth keys command copies POSIX arguments verbatim and offers installation help", async () => {
  await setup();
  await page
    .getByTestId("invite-login-server")
    .fill("https://hs.example/it's?x=1&y=$(id)");
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await page.getByTestId("copy-created-install-command").click();
  expect(write).toHaveBeenCalledWith(
    `tailscale up --login-server 'https://hs.example/it'\\''s?x=1&y=$(id)' --authkey '${SECRET}'`,
  );
  const card = page.getByTestId("created-invite");
  await expect.element(card).toMatchTextContent("Connection command");
  await expect.element(card).toMatchTextContent("Install Tailscale first");
  await expect
    .element(page.getByTestId("invite-install-docs"))
    .toHaveAttribute("href", "https://tailscale.com/kb/1017/install");
});
