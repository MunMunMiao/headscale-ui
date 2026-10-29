import "fake-indexeddb/auto";
import type { FetchHandle } from "@defjs/core";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { ActionFeedbackKey } from "@/composables/useActionFeedback";
import { setLocale } from "@/i18n";
import {
  authenticateTestSession,
  prepareTestSession,
  renderSessionPage,
} from "@/test/session";
import AccessPage from "./AccessPage";
import DevicesPage from "./DevicesPage";
import InvitesPage from "./InvitesPage";
import MembersPage from "./MembersPage";
import RoutesPage from "./RoutesPage";

const serverA = "https://draft-a.invalid";
const serverB = "https://draft-b.invalid";

type Intercept = (request: Request) => Promise<Response> | undefined;

async function setup(element: ReactNode, path: string, intercept?: Intercept) {
  await page.viewport(1366, 768);
  const calls: { origin: string; method: string; path: string }[] = [];
  const transport: FetchHandle = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    calls.push({
      origin: url.origin,
      method: request.method,
      path: url.pathname,
    });
    const intercepted = intercept?.(request);
    if (intercepted) return intercepted;
    const isA = url.origin === serverA;
    const user = {
      id: isA ? "1" : "9",
      name: isA ? "alice" : "charlie",
      displayName: isA ? "Alice from A" : "Charlie from B",
    };
    if (request.method !== "GET")
      return Response.json(
        { message: "A stale draft reached HTTP" },
        { status: 500 },
      );
    const responses: Record<string, unknown> = {
      "/api/v1/health": { databaseConnectivity: true, serverReachable: true },
      "/version": { version: "0.29.4" },
      "/api/v1/user": { users: [user] },
      "/api/v1/node": {
        nodes: [
          {
            id: "1",
            name: isA ? "edge-a" : "edge-b",
            givenName: isA ? "edge-a" : "edge-b",
            user,
            online: true,
            ipAddresses: ["100.64.0.1"],
            tags: [],
            approvedRoutes: [isA ? "192.168.9.0/24" : "192.168.8.0/24"],
            availableRoutes: [isA ? "10.42.0.0/16" : "10.99.0.0/16"],
            subnetRoutes: [],
          },
        ],
      },
      "/api/v1/preauthkey": { preAuthKeys: [] },
      "/api/v1/apikey": { apiKeys: [] },
      "/api/v1/policy": {
        policy: JSON.stringify({
          groups: { [isA ? "group:ops" : "group:other"]: [`${user.name}@`] },
          acls: [],
        }),
      },
    };
    if (!(url.pathname in responses))
      throw new Error(`Unexpected fixture path: ${url.pathname}`);
    return Response.json(responses[url.pathname]);
  };
  const session = await prepareTestSession(transport);
  await setLocale("en-US");
  await authenticateTestSession(session, serverA);
  const originalProfile = session.profiles
    .getSnapshot()
    .profiles.find((profile) => profile.baseUrl === serverA);
  if (!originalProfile) throw new Error("Missing original profile");
  await renderSessionPage(session, element, path);
  await expect
    .poll(() => session.snapshot.getSnapshot().snapshot.users[0]?.name)
    .toBe("alice");
  await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
  return {
    session,
    calls,
    async reunlock() {
      expect(
        await session.profiles.enterProfile(
          originalProfile,
          "isolated-test-password",
        ),
      ).toBe(true);
      await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
    },
    async switchServer() {
      await authenticateTestSession(session, serverB);
      await expect
        .poll(() => session.auth.getSessionSnapshot()?.profile?.baseUrl)
        .toBe(serverB);
      await expect
        .poll(() => session.snapshot.getSnapshot().snapshot.users[0]?.name)
        .toBe("charlie");
      await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
      expect(
        calls.some(
          (call) => call.origin === serverB && call.path === "/api/v1/user",
        ),
      ).toBe(true);
    },
    async expectNoStaleWrite(action: ActionFeedbackKey) {
      await expect
        .poll(() => session.feedback.isActionPending(action))
        .toBe(false);
      await session.auth.check();
      expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
      expect(session.drafts.getSnapshot().stale).not.toBeNull();
    },
  };
}

afterEach(() => vi.restoreAllMocks());

test("keeps an edited device name and refuses to rename the same node id on another server", async () => {
  const { switchServer, expectNoStaleWrite } = await setup(
    <DevicesPage />,
    "/devices",
  );
  await page.getByTestId("machine-actions-trigger-1").click();
  await page.getByTestId("rename-node-action-1").click();
  await page
    .getByTestId("rename-node-dialog-input")
    .fill("a-only-device-draft");
  await switchServer();
  await expect
    .element(page.getByTestId("rename-node-dialog-input"))
    .toHaveValue("a-only-device-draft");
  await page.getByTestId("rename-node-confirm").click();
  await expectNoStaleWrite("rename-node");
  await expect
    .element(page.getByTestId("rename-node-dialog-input"))
    .toHaveValue("a-only-device-draft");
});

test("a same-server re-unlock keeps the rename dialog draft and the write goes to the same server", async () => {
  const { session, calls, reunlock } = await setup(<DevicesPage />, "/devices");
  await page.getByTestId("machine-actions-trigger-1").click();
  await page.getByTestId("rename-node-action-1").click();
  await page.getByTestId("rename-node-dialog-input").fill("same-server-draft");
  const identity = session.client.getSnapshot().identity;
  await reunlock();
  expect(session.client.getSnapshot().identity).not.toEqual(identity);
  expect(session.drafts.getSnapshot().stale).toBeNull();
  await expect
    .element(page.getByTestId("rename-node-dialog-input"))
    .toHaveValue("same-server-draft");
  await page.getByTestId("rename-node-confirm").click();
  await expect
    .poll(() => session.feedback.isActionPending("rename-node"))
    .toBe(false);
  expect(calls.filter((call) => call.method !== "GET")).toEqual([
    {
      origin: serverA,
      method: "POST",
      path: "/api/v1/node/1/rename/same-server-draft",
    },
  ]);
});

test("an open-time refresh settling after a server switch leaves the rename draft alone", async () => {
  let hold = false;
  const gate = Promise.withResolvers<Response>();
  const { session, switchServer } = await setup(
    <DevicesPage />,
    "/devices",
    (request) => {
      if (!hold || new URL(request.url).pathname !== "/api/v1/node")
        return undefined;
      request.signal.addEventListener(
        "abort",
        () => gate.reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
      return gate.promise;
    },
  );
  await page.getByTestId("machine-actions-trigger-1").click();
  hold = true;
  await page.getByTestId("rename-node-action-1").click();
  await page.getByTestId("rename-node-dialog-input").fill("held-draft");
  hold = false;
  await switchServer();
  await expect
    .element(page.getByTestId("rename-node-dialog-input"))
    .toHaveValue("held-draft");
  expect(session.drafts.getSnapshot().stale).not.toBeNull();
  await expect.element(page.getByTestId("rename-node-confirm")).toBeVisible();
});

test("retains the pending registration owner while clearing its secret on a server switch", async () => {
  const { session, switchServer } = await setup(<DevicesPage />, "/devices");
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("add-pending-node").click();
  await page.getByTestId("pending-registration-user").selectOptions("1");
  await page
    .getByTestId("pending-node-key")
    .fill("isolated-registration-secret");
  await switchServer();
  await expect
    .element(page.getByTestId("pending-registration-user"))
    .toHaveValue("1");
  await expect
    .element(page.getByTestId("pending-registration-user"))
    .toHaveTextContent("Choose a target userAlice from A (alice · 1)");
  await expect.element(page.getByTestId("pending-node-key")).toHaveValue("");
  expect(session.drafts.getSnapshot().stale).not.toBeNull();
});

test("keeps the SSH check type but clears the request id and decision on a server switch", async () => {
  const authId = "hskey-authreq-a1B2c3D4e5F6g7H8i9J0k1L2";
  const { session, switchServer, expectNoStaleWrite } = await setup(
    <DevicesPage />,
    "/devices",
  );
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("add-pending-node").click();
  await page.getByTestId("pending-registration-kind").selectOptions("ssh");
  await page.getByTestId("pending-node-key").fill(authId);
  session.deviceSetup.setState({ lastAuthDecision: "approved" });
  await switchServer();
  await expect
    .element(page.getByTestId("pending-registration-kind"))
    .toHaveValue("ssh");
  await expect.element(page.getByTestId("pending-node-key")).toHaveValue("");
  await expect
    .element(page.getByTestId("ssh-check-result"))
    .not.toBeInTheDocument();
  expect(session.deviceSetup.getSnapshot().lastAuthDecision).toBeNull();
  await page.getByTestId("pending-node-key").fill(authId);
  await page.getByTestId("approve-ssh-check").click();
  await expectNoStaleWrite("approve-auth-request");
  await expect
    .element(page.getByTestId("ssh-check-result"))
    .not.toBeInTheDocument();
});

// Cancelling the create dialog discards its input, so only an open dialog carries a draft.
test("retains an open member draft across a server switch", async () => {
  const { switchServer, expectNoStaleWrite } = await setup(
    <MembersPage />,
    "/members",
  );
  await page.getByTestId("open-create-member").click();
  await page.getByTestId("member-name").fill("a-only-member");
  await page.getByTestId("member-display").fill("Unsubmitted A display name");
  await page.getByTestId("member-email").fill("a-only@example.test");
  await switchServer();
  await expect
    .element(page.getByTestId("member-name"))
    .toHaveValue("a-only-member");
  await expect
    .element(page.getByTestId("member-display"))
    .toHaveValue("Unsubmitted A display name");
  await expect
    .element(page.getByTestId("member-email"))
    .toHaveValue("a-only@example.test");
  await page.getByTestId("create-member").click();
  await expectNoStaleWrite("create-member");
});

test.each(["invites", "members"])(
  "retains invitation inputs and the original owner options on %s while another server refreshes",
  async (route) => {
    const element = route === "invites" ? <InvitesPage /> : <MembersPage />;
    const { switchServer, expectNoStaleWrite } = await setup(
      element,
      `/${route}`,
    );
    if (route === "invites")
      await page.getByTestId("open-create-invite").click();
    else {
      await page.getByTestId("member-actions-trigger-alice").click();
      await page.getByTestId("create-invite-for-member-alice").click();
    }
    await page.getByTestId("invite-tags-search").fill("tag:a-only-draft");
    await page.getByTestId("invite-tags-add").click();
    const wasReusable =
      page
        .getByTestId("invite-reusable")
        .element()
        .getAttribute("aria-checked") === "true";
    await page.getByTestId("invite-reusable").click();
    await switchServer();
    await expect.element(page.getByTestId("invite-user")).toHaveValue("1");
    await expect
      .element(page.getByTestId("invite-user"))
      .toMatchTextContent("Alice from A");
    await expect
      .element(page.getByTestId("invite-user"))
      .not.toMatchTextContent("Charlie from B");
    await expect
      .element(page.getByTestId("invite-tags-selected"))
      .toMatchTextContent("tag:a-only-draft");
    await expect
      .element(page.getByTestId("invite-reusable"))
      .toHaveAttribute("aria-checked", String(!wasReusable));
    await expect.element(page.getByTestId("create-invite")).toBeDisabled();
    const form = page.getByTestId("invite-form").element();
    expect.assert(form instanceof HTMLFormElement);
    form.requestSubmit();
    await expectNoStaleWrite("create-invite");
  },
);

test("retains the device wizard key options and the original owner options while another server refreshes", async () => {
  const { switchServer, expectNoStaleWrite } = await setup(
    <DevicesPage />,
    "/devices",
  );
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("add-linux-device").click();
  await page.getByTestId("setup-tags-remove-tag:server").click();
  await page.getByTestId("setup-tags-search").fill("tag:a-only-draft");
  await page.getByTestId("setup-tags-add").click();
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("setup-reusable").click();
  await switchServer();
  await expect.element(page.getByTestId("setup-owner")).toHaveValue("1");
  await expect
    .element(page.getByTestId("setup-owner"))
    .toMatchTextContent("Alice from A");
  await expect
    .element(page.getByTestId("setup-owner"))
    .not.toMatchTextContent("Charlie from B");
  await expect
    .element(page.getByTestId("setup-reusable"))
    .toHaveAttribute("aria-checked", "false");
  await page.getByTestId("add-device-prev").click();
  await expect
    .element(page.getByTestId("setup-tags-remove-tag:a-only-draft"))
    .toBeVisible();
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("add-device-next").click();
  await expect
    .element(page.getByTestId("generate-install-script"))
    .toBeDisabled();
  await expect.element(page.getByTestId("setup-generate-error")).toBeVisible();
  await expectNoStaleWrite("create-invite");
});

test("retains a route confirmation target and refuses to approve it on another server", async () => {
  const { switchServer, expectNoStaleWrite } = await setup(
    <RoutesPage />,
    "/routes",
  );
  await page.getByTestId("approve-route-1-0").click();
  await switchServer();
  await expect
    .element(page.getByTestId("approve-route-target"))
    .toHaveTextContent("10.42.0.0/16");
  await page.getByTestId("approve-route-confirm").click();
  await expectNoStaleWrite("approve-route");
  await expect.element(page.getByTestId("approve-route-dialog")).toBeVisible();
});

test("retains the Approve all dialog and refuses to approve its routes on another server", async () => {
  const { switchServer, expectNoStaleWrite } = await setup(
    <RoutesPage />,
    "/routes",
  );
  await page.getByTestId("approve-routes-1").click();
  await switchServer();
  await expect
    .element(page.getByTestId("approve-routes-target-0"))
    .toHaveTextContent("10.42.0.0/16");
  await page.getByTestId("approve-routes-confirm").click();
  await expectNoStaleWrite("approve-routes");
  await expect.element(page.getByTestId("approve-routes-dialog")).toBeVisible();
});

test("retains a revoke confirmation and refuses to revoke the route on another server", async () => {
  const { switchServer, expectNoStaleWrite } = await setup(
    <RoutesPage />,
    "/routes",
  );
  await page.getByTestId("revoke-route-1-0").click();
  await switchServer();
  await expect
    .element(page.getByTestId("revoke-route-target-0"))
    .toHaveTextContent("192.168.9.0/24");
  await page.getByTestId("revoke-route-confirm").click();
  await expectNoStaleWrite("revoke-route");
  await expect.element(page.getByTestId("revoke-route-dialog")).toBeVisible();
});

test("retains an unsubmitted policy name and blocks saving the old policy to another server", async () => {
  const { switchServer, expectNoStaleWrite } = await setup(
    <AccessPage />,
    "/access",
  );
  await page.getByTestId("team-card-group:ops").click();
  await page.getByTestId("team-name-input").fill("a-only-team-draft");
  await switchServer();
  await expect
    .element(page.getByTestId("team-name-input"))
    .toHaveValue("a-only-team-draft");
  await userEvent.keyboard("{Enter}");
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("unsaved-changes-save").click();
  await expectNoStaleWrite("save-policy");
  await expect
    .element(page.getByTestId("team-name-input"))
    .toHaveValue("a-only-team-draft");
});
