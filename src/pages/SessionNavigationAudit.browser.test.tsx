import type { FetchHandle } from "@defjs/core";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { setLocale } from "@/i18n";
import { createApplicationRouter } from "@/router";
import {
  authenticateTestSession,
  prepareTestSession,
  SessionTestProviders,
} from "@/test/session";

const serverA = "https://navigation-a.invalid";
const serverB = "https://navigation-b.invalid";
const password = "isolated-test-password";
const id = (name: string) => page.getByTestId(name);
afterEach(() => vi.restoreAllMocks());

async function setup(pinned = false, popup = false, tagged = false) {
  await page.viewport(1366, 768);
  let rejectOtherServer = false;
  let nodeReadHold: Promise<void> | undefined;
  let targetDeclared = true;
  let sourcePresent = true;
  const writes: string[] = [];
  const transport: FetchHandle = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (rejectOtherServer && url.origin === serverB)
      return Response.json({ message: "candidate refused" }, { status: 403 });
    if (request.method !== "GET") {
      writes.push(`${request.method} ${url.pathname}`);
      throw new Error("Unexpected write in navigation fixture");
    }
    if (url.pathname === "/api/v1/node") await nodeReadHold;
    const name = url.origin === serverA ? "alice" : "bob";
    const user = { id: "1", name, displayName: `${name} on this server` };
    const responses: Record<string, unknown> = {
      "/api/v1/health": { databaseConnectivity: true, serverReachable: true },
      "/version": { version: "0.29.4" },
      "/api/v1/user": { users: [user] },
      "/api/v1/node": {
        nodes: [
          {
            id: "7",
            name: `${name}-device`,
            givenName: `${name}-device`,
            user,
            online: true,
            ipAddresses: ["100.64.0.7"],
            tags: tagged
              ? [...(sourcePresent ? ["tag:old"] : []), "tag:keep"]
              : [],
            approvedRoutes: [],
            availableRoutes: [],
            subnetRoutes: [],
          },
        ],
      },
      "/api/v1/preauthkey": { preAuthKeys: [] },
      "/api/v1/apikey": { apiKeys: [] },
      "/api/v1/policy": {
        policy: tagged
          ? JSON.stringify({
              acls: [],
              tagOwners: {
                "tag:old": [],
                "tag:keep": [],
                ...(targetDeclared ? { "tag:target": [] } : {}),
              },
            })
          : '{"acls":[]}',
      },
    };
    if (!(url.pathname in responses))
      throw new Error(`Unexpected read: ${url.pathname}`);
    return Response.json(responses[url.pathname]);
  };
  const session = await prepareTestSession(transport);
  await setLocale("en-US");
  await authenticateTestSession(session, serverA);
  const original = session.profiles
    .getSnapshot()
    .profiles.find((profile) => profile.baseUrl === serverA);
  expect.assert(original);
  const search = `user=1&node=7&filter=online${popup ? "&popup=node&from=members" : ""}${pinned ? `&profile=${original.id}` : ""}`;
  const router = createApplicationRouter(
    session,
    createMemoryHistory({ initialEntries: [`/devices?${search}`] }),
  );
  await router.load();
  await render(
    <SessionTestProviders session={session}>
      <RouterProvider router={router} />
    </SessionTestProviders>,
  );
  await expect.poll(() => session.snapshot.getSnapshot().isReady).toBe(true);
  await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
  return {
    session,
    router,
    original,
    writes,
    holdNodeReads: () => {
      const gate = Promise.withResolvers<void>();
      nodeReadHold = gate.promise;
      return () => {
        nodeReadHold = undefined;
        gate.resolve();
      };
    },
    removeMigration: (kind: "source" | "target") => {
      if (kind === "source") sourcePresent = false;
      else targetDeclared = false;
    },
    rejectOther: () => {
      rejectOtherServer = true;
    },
  };
}

async function saveOtherProfile(
  session: Awaited<ReturnType<typeof setup>>["session"],
) {
  await session.profiles.loadProfile("__new__");
  session.profiles.setConnectionForm({
    profileName: "Server B",
    baseUrl: serverB,
    apiKey: "isolated-test-key",
    password,
  });
  await session.profiles.addProfile(false);
  const other = session.profiles
    .getSnapshot()
    .profiles.find((profile) => profile.baseUrl === serverB);
  expect.assert(other);
  return other;
}

test.each([
  [false, "continue"],
  [true, "continue"],
  [false, "failed candidate"],
  [true, "failed candidate"],
  [false, "switch"],
  [true, "switch"],
] as const)(
  "the login route preserves navigation ownership (pinned: %s, action: %s)",
  async (pinned, action) => {
    const { session, router, original, rejectOther } = await setup(pinned);
    await saveOtherProfile(session);
    const before = router.state.location.href;
    await router.navigate({ to: "/login", search: { redirect: before } });
    await expect.element(id("login-continue")).toBeVisible();
    expect(session.auth.getSessionSnapshot()?.profile?.id).toBe(original.id);
    if (action !== "continue") {
      if (action === "failed candidate") rejectOther();
      await id("profile-option-Server B").click();
      await id("unlock-passphrase").fill(password);
      await id("unlock-submit").click();
      if (action === "failed candidate") {
        await expect
          .element(id("unlock-error"))
          .toHaveTextContent("candidate refused");
        expect(session.auth.getSessionSnapshot()?.profile?.id).toBe(
          original.id,
        );
        await id("unlock-cancel").click();
      }
    }
    if (action !== "switch") await id("login-continue").click();
    await expect.poll(() => router.state.location.pathname).toBe("/devices");
    if (action === "switch") {
      expect(router.state.location.search).toEqual({ filter: "online" });
      await expect
        .element(id("device-detail-link-7"))
        .toHaveTextContent("bob-device");
    } else {
      expect(router.state.location.href).toBe(before);
      await expect
        .element(id("device-detail-link-7"))
        .toHaveTextContent("alice-device");
    }
  },
);

test.each([false, true])(
  "switching servers never opens B's colliding node from A's URL (pinned: %s)",
  async (pinned) => {
    const { session, router } = await setup(pinned, true);
    await expect
      .element(id("device-detail-dialog"))
      .toMatchTextContent("alice-device");
    await authenticateTestSession(session, serverB);
    await expect
      .poll(() => session.snapshot.getSnapshot().snapshot.users[0]?.name)
      .toBe("bob");
    await expect
      .poll(() => router.state.location.search)
      .toEqual({ filter: "online" });
    await expect.element(id("device-detail-dialog")).not.toBeInTheDocument();
    await expect
      .element(id("device-detail-link-7"))
      .toHaveTextContent("bob-device");
  },
);

test.each([false, true])(
  "logout then password-unlock of B drops A's entity filters (pinned: %s)",
  async (pinned) => {
    const { session, router } = await setup(pinned);
    await saveOtherProfile(session);
    await id("profile-menu-trigger").click();
    await id("logout").click();
    await expect
      .poll(() => session.auth.getSessionSnapshot()?.status)
      .toBe("locked");
    await expect.poll(() => router.state.location.pathname).toBe("/login");
    await id("profile-option-Server B").click();
    await id("unlock-passphrase").fill(password);
    await id("unlock-submit").click();
    await expect.poll(() => router.state.location.pathname).toBe("/devices");
    expect(router.state.location.search).toEqual({ filter: "online" });
    await expect
      .element(id("device-detail-link-7"))
      .toHaveTextContent("bob-device");
  },
);

test.each([false, true])(
  "discarding a stale draft also retires its entity navigation (pinned: %s)",
  async (pinned) => {
    const { session, router } = await setup(pinned);
    await id("machine-actions-trigger-7").click();
    await id("rename-node-action-7").click();
    await id("rename-node-dialog-input").fill("unsaved-a-name");
    await authenticateTestSession(session, serverB);
    await expect.element(id("stale-session-draft-dialog")).toBeVisible();
    await expect
      .element(id("rename-node-dialog-input"))
      .toHaveValue("unsaved-a-name");
    await id("discard-stale-session-draft").click();
    await expect
      .poll(() => router.state.location.search)
      .toEqual({ filter: "online" });
    await expect
      .element(id("rename-node-dialog-input"))
      .not.toBeInTheDocument();
    await expect
      .element(id("device-detail-link-7"))
      .toHaveTextContent("bob-device");
  },
);

test("same-server re-unlock keeps the pinned entity detail", async () => {
  const { session, router, original } = await setup(true, true);
  await expect
    .element(id("device-detail-dialog"))
    .toMatchTextContent("alice-device");
  const before = router.state.location.href;
  expect(await session.profiles.enterProfile(original, password)).toBe(true);
  await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
  expect(router.state.location.href).toBe(before);
  await expect
    .element(id("device-detail-dialog"))
    .toMatchTextContent("alice-device");
});

test("editing the active profile's server address retires even its matching profile pin", async () => {
  const { session, router, original } = await setup(true);
  await session.profiles.loadProfile(original.id);
  session.profiles.setConnectionForm({
    baseUrl: serverB,
    apiKey: "isolated-test-key",
    password,
  });
  await session.profiles.addProfile(true);
  await expect
    .poll(() => session.auth.getSessionSnapshot()?.profile?.baseUrl)
    .toBe(serverB);
  expect(session.auth.getSessionSnapshot()?.profile?.id).toBe(original.id);
  // Editing active credentials briefly locks the session; the initiating page owns continuation.
  await expect.poll(() => router.state.location.pathname).toBe("/login");
  await id("login-continue").click();
  await expect
    .poll(() => router.state.location.search)
    .toEqual({ filter: "online" });
});

test.each(["Continue", "password unlock"])(
  "a malformed redirect safely returns home after %s",
  async (entry) => {
    const { session, router, original } = await setup();
    if (entry === "password unlock") await session.profiles.logout();
    await router.navigate({ to: "/login", search: { redirect: "http://[" } });
    if (entry === "Continue") await id("login-continue").click();
    else {
      await id(`profile-option-${original.name}`).click();
      await id("unlock-passphrase").fill(password);
      await id("unlock-submit").click();
    }
    await expect.poll(() => router.state.location.pathname).toBe("/home");
    expect(router.state.location.search).toEqual({});
    await expect.element(id("unlock-error")).not.toBeInTheDocument();
  },
);

test.each([
  ["node", "tags"],
  ["tags", "node"],
] as const)(
  "review M2: the same node can navigate from %s to %s without keeping the old popup",
  async (first, next) => {
    const fixture = await setup(false, false, true);
    await fixture.router.navigate({
      to: "/devices",
      search: { node: "7", popup: first },
    });
    await expect
      .element(
        id(first === "node" ? "device-detail-dialog" : "node-tags-dialog"),
      )
      .toBeVisible();
    if (first === "tags")
      await expect.element(id("node-tags-confirm")).toBeEnabled();
    await fixture.router.navigate({
      to: "/devices",
      search: { node: "7", popup: next },
    });
    await expect
      .element(
        id(next === "node" ? "device-detail-dialog" : "node-tags-dialog"),
      )
      .toBeVisible();
    await expect
      .element(
        id(first === "node" ? "device-detail-dialog" : "node-tags-dialog"),
      )
      .not.toBeInTheDocument();
    expect(fixture.writes).toEqual([]);
  },
);

test("review M2: ordinary owner filtering is not a new tag-editor intent", async () => {
  const fixture = await setup(false, false, true);
  await fixture.router.navigate({
    to: "/devices",
    search: { node: "7", popup: "tags", user: "1" },
  });
  await expect.element(id("node-tags-confirm")).toBeEnabled();
  const release = fixture.holdNodeReads();
  try {
    await fixture.router.navigate({
      to: "/devices",
      search: { node: "7", popup: "tags", user: "2" },
    });
    await expect.element(id("node-tags-confirm")).toBeEnabled();
    await expect.element(id("node-tags-remove-tag:old")).toBeVisible();
  } finally {
    release();
  }
});

test("review M2: a newer popup intent retains unsent tag edits until explicit cancellation", async () => {
  const fixture = await setup(false, false, true);
  await fixture.router.navigate({
    to: "/devices",
    search: { node: "7", popup: "tags" },
  });
  await expect.element(id("node-tags-confirm")).toBeEnabled();
  await id("node-tags-option-tag:target").click();
  await fixture.router.navigate({
    to: "/devices",
    search: { node: "7", popup: "node" },
  });
  await expect.element(id("node-tags-remove-tag:target")).toBeVisible();
  await expect.element(id("device-detail-dialog")).not.toBeInTheDocument();
  await id("node-tags-cancel").click();
  await expect.element(id("device-detail-dialog")).toBeVisible();
  expect(fixture.session.snapshot.nodeById("7")?.tags).toEqual([
    "tag:old",
    "tag:keep",
  ]);
  expect(fixture.writes).toEqual([]);
});

test("review M2: a retained tag review cannot publish its old confirmation after a new popup intent", async () => {
  const fixture = await setup(false, false, true);
  await fixture.router.navigate({
    to: "/devices",
    search: { node: "7", popup: "tags" },
  });
  await expect.element(id("node-tags-confirm")).toBeEnabled();
  await id("node-tags-option-tag:target").click();
  await id("node-tags-confirm").click();
  await expect.element(id("node-tags-apply")).toBeVisible();
  await fixture.router.navigate({
    to: "/devices",
    search: { node: "7", popup: "node" },
  });
  await expect.element(id("node-tags-remove-tag:target")).toBeVisible();
  await expect.element(id("node-tags-apply")).not.toBeInTheDocument();
  await expect.element(id("device-detail-dialog")).not.toBeInTheDocument();
  expect(fixture.writes).toEqual([]);
});

test("review M2: a blocked popup intent does not erase a confirmation reviewed after that intent", async () => {
  const fixture = await setup(false, false, true);
  await fixture.router.navigate({
    to: "/devices",
    search: { node: "7", popup: "tags" },
  });
  await expect.element(id("node-tags-confirm")).toBeEnabled();
  await id("node-tags-option-tag:target").click();
  await fixture.router.navigate({
    to: "/devices",
    search: { node: "7", popup: "node" },
  });
  await id("node-tags-confirm").click();
  await expect.element(id("node-tags-apply")).toBeVisible();
  expect(fixture.writes).toEqual([]);
});

test("review M2: changed migration parameters are consumed after retaining and cancelling the prior proposal", async () => {
  const fixture = await setup(false, false, true);
  await fixture.router.navigate({
    to: "/devices",
    search: {
      node: "7",
      popup: "tags",
      from: "access",
      maintenance: "tag:old",
      migrateFrom: "tag:old",
      migrateTo: "tag:target",
    },
  });
  await expect.element(id("node-tags-remove-tag:target")).toBeVisible();
  await fixture.router.navigate({
    to: "/devices",
    search: {
      node: "7",
      popup: "tags",
      from: "access",
      maintenance: "tag:old",
      migrateFrom: "tag:old",
      migrateTo: "tag:keep",
    },
  });
  await expect.element(id("node-tags-remove-tag:target")).toBeVisible();
  await id("node-tags-cancel").click();
  await expect.element(id("node-tags-dialog")).toBeVisible();
  await expect
    .element(id("node-tags-remove-tag:target"))
    .not.toBeInTheDocument();
  await expect.element(id("node-tags-remove-tag:old")).not.toBeInTheDocument();
  await expect.element(id("node-tags-remove-tag:keep")).toBeVisible();
  expect(fixture.router.state.location.pathname).toBe("/devices");
  expect(fixture.writes).toEqual([]);
});

test("review M2: a superseded tag read cannot reopen its popup after a same-node detail intent", async () => {
  const fixture = await setup(false, false, true);
  const release = fixture.holdNodeReads();
  await fixture.router.navigate({
    to: "/devices",
    search: {
      node: "7",
      popup: "tags",
      migrateFrom: "tag:old",
      migrateTo: "tag:target",
    },
  });
  await expect.element(id("node-tags-confirm")).toBeDisabled();
  await fixture.router.navigate({
    to: "/devices",
    search: { node: "7", popup: "node" },
  });
  release();
  await expect.element(id("device-detail-dialog")).toBeVisible();
  await expect.element(id("node-tags-dialog")).not.toBeInTheDocument();
  await expect.poll(() => fixture.session.snapshot.isRefreshing).toBe(false);
  expect(fixture.writes).toEqual([]);
});

test("usability: a plain tag-editor intent reviews current tags and returns without invented migration context", async () => {
  const { router } = await setup(false, false, true);
  await router.navigate({
    to: "/devices",
    search: { node: "7", popup: "tags", from: "access" },
  });
  await expect.element(id("node-tags-remove-tag:old")).toBeVisible();
  await expect.element(id("node-tags-remove-tag:keep")).toBeVisible();
  await expect.element(id("node-tags-confirm")).toBeEnabled();
  await id("node-tags-cancel").click();
  await expect.poll(() => router.state.location.pathname).toBe("/access");
  expect(router.state.location.search).toEqual({});
});

test.each(["source", "target"] as const)(
  "usability: a migration with a removed %s cannot silently stage the old target",
  async (kind) => {
    const fixture = await setup(false, false, true);
    await fixture.router.navigate({ to: "/access", search: {} });
    await id("tag-maintenance-tag:old").click();
    await id("tag-migration-existing").click();
    await id("tag-migration-target").fill("target");
    await expect
      .element(id("tag-migration-node-7"))
      .toMatchTextContent("tag:target, tag:keep");
    fixture.removeMigration(kind);
    await id("tag-migration-open-node-7").click();
    await expect.element(id("node-tags-notice")).toMatchTextContent("changed");
    await expect
      .element(id("node-tags-remove-tag:target"))
      .not.toBeInTheDocument();
    await expect.element(id("node-tags-apply")).not.toBeInTheDocument();
  },
);

test("usability: a late migration read cannot overwrite a newer same-page navigation context", async () => {
  const fixture = await setup(false, false, true);
  await fixture.router.navigate({ to: "/access", search: {} });
  await id("tag-maintenance-tag:old").click();
  await id("tag-migration-existing").click();
  await id("tag-migration-target").fill("target");
  await expect
    .element(id("tag-migration-node-7"))
    .toMatchTextContent("tag:target, tag:keep");
  fixture.session.tagLifecycle.saveReturn({
    source: "device",
    managedTag: "",
    editVersion: 1,
    nodeId: "7",
    tags: ["tag:old"],
    baseline: {
      nodeId: "7",
      machineKey: null,
      user: null,
      tags: ["tag:old", "tag:keep"],
    },
  });
  const release = fixture.holdNodeReads();
  await id("tag-migration-open-node-7").click();
  await expect.element(id("node-tags-confirm")).toBeDisabled();
  await fixture.router.navigate({
    to: "/devices",
    search: { ...fixture.router.state.location.search, search: "newer-filter" },
  });
  release();
  await expect.element(id("node-tags-confirm")).toBeEnabled();
  await expect.element(id("node-tags-remove-tag:old")).toBeVisible();
  await expect
    .element(id("node-tags-remove-tag:target"))
    .not.toBeInTheDocument();
  expect(fixture.router.state.location.search.search).toBe("newer-filter");
});

test.each(["invite", "device"] as const)(
  "usability: migration opens full tag editing and retains the %s return draft",
  async (source) => {
    const { session, router, writes } = await setup(false, false, true);
    await router.navigate({ to: "/access", search: {} });
    const saved = session.tagLifecycle.saveReturn(
      source === "device"
        ? {
            source,
            managedTag: "tag:old",
            editVersion: 7,
            nodeId: "7",
            tags: ["tag:old", "tag:keep"],
            baseline: {
              nodeId: "7",
              machineKey: null,
              user: { id: "1", name: "alice" },
              tags: ["tag:old", "tag:keep"],
            },
          }
        : {
            source,
            managedTag: "tag:old",
            editVersion: 7,
            form: {
              userId: "1",
              userName: "alice",
              tags: ["tag:old"],
              tagInput: "keep-input",
              reusable: true,
              ephemeral: false,
              expiration: "2099-01-01T00:00:00Z",
              expirationMode: "custom",
              expiryDays: "7",
            },
          },
    );
    expect.assert(saved);
    await expect.element(id("tag-detail-close")).toBeVisible();
    await id("tag-detail-close").click();
    await id("tag-maintenance-tag:old").click();
    await id("tag-migration-existing").click();
    await id("tag-migration-target").fill("target");
    await expect
      .element(id("tag-migration-node-7"))
      .toMatchTextContent("tag:target, tag:keep");
    await id("tag-migration-open-node-7").click();
    await expect.element(id("node-tags-dialog")).toBeVisible();
    await expect.element(id("node-tags-remove-tag:target")).toBeVisible();
    await expect.element(id("node-tags-remove-tag:keep")).toBeVisible();
    await expect.element(id("node-tags-manage")).not.toBeInTheDocument();
    await expect
      .element(id("node-tags-remove-tag:old"))
      .not.toBeInTheDocument();
    await id("node-tags-confirm").click();
    await expect
      .element(id("node-tags-review"))
      .toMatchTextContent("tag:target");
    await expect.element(id("node-tags-diff")).toMatchTextContent("− tag:old");
    expect(session.snapshot.nodeById("7")?.tags).toEqual([
      "tag:old",
      "tag:keep",
    ]);
    expect(session.tagLifecycle.getSnapshot().returnTo).toEqual(saved);
    await id("node-tags-cancel").click();
    await expect.element(id("tag-maintenance-dialog")).toBeVisible();
    await expect.element(id("tag-migration-target")).toHaveValue("target");
    await expect.element(id("tag-migration-existing")).toBeChecked();
    expect(session.tagLifecycle.getSnapshot().returnTo).toEqual(saved);
    expect(writes).toEqual([]);
  },
);

test("usability: owner drilldown returns to the exact machine filters", async () => {
  const { router } = await setup(true);
  await router.navigate({
    to: "/devices",
    search: { search: "alice-device", filter: "online", user: "1" },
  });
  const before = router.state.location.href;
  await id("device-owner-link-7").click();
  await expect.element(id("user-detail-dialog")).toBeVisible();
  await id("user-detail-dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect.poll(() => router.state.location.href).toBe(before);
  await expect.element(id("device-search")).toHaveValue("alice-device");
  await expect.element(id("device-detail-link-7")).toBeVisible();
});

test("Continue after a held peer unlock uses the previous server's navigation scope", async () => {
  const { session, router } = await setup();
  await id("profile-menu-trigger").click();
  await id("logout").click();
  await expect
    .poll(() => session.auth.getSessionSnapshot()?.status)
    .toBe("locked");
  await expect.poll(() => router.state.location.pathname).toBe("/login");
  session.profiles.setState({ discardedPolicyDraft: true });
  await authenticateTestSession(session, serverB);
  await id("login-continue").click();
  await expect.poll(() => router.state.location.pathname).toBe("/devices");
  expect(router.state.location.search).toEqual({ filter: "online" });
});
