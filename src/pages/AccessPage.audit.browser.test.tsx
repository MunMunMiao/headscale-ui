import "fake-indexeddb/auto";
import type { FetchHandle } from "@defjs/core";
import {
  type AnyRouter,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { HeadscaleUser } from "@/api/contracts";
import { i18n, setLocale } from "@/i18n";
import { getProductCopy } from "@/i18n/product-copy";
import { getLocaleI18n } from "@/i18n/runtime";
import {
  authenticateTestSession,
  prepareTestSession,
  renderSessionPage,
  SessionTestProviders,
} from "@/test/session";
import AccessPage from "./AccessPage";
import AppLayout from "./AppLayout";

const copy = getProductCopy("en-US");
const opsPolicy = {
  groups: { "group:ops": ["alice@"] },
  tagOwners: { "tag:server": ["alice@"] },
  acls: [{ action: "accept", src: ["group:ops"], dst: ["tag:server:22"] }],
};

async function setup(
  initial: Record<string, unknown> = opsPolicy,
  layout = false,
  fileMode = false,
) {
  let policy = JSON.stringify(initial);
  let users: HeadscaleUser[] = [{ id: "1", name: "alice" }];
  let identityFailure = false;
  let identityDelay: Promise<void> | undefined;
  let identityReads = 0;
  let saveRejected = false;
  const writes: Record<string, unknown>[] = [];
  const transport: FetchHandle = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method === "PUT" && path === "/api/v1/policy") {
      const body = (await request.json()) as { policy: string };
      writes.push(JSON.parse(body.policy));
      if (saveRejected)
        return Response.json({ message: "policy rejected" }, { status: 400 });
      policy = body.policy;
      return Response.json(body);
    }
    if (path === "/api/v1/policy" && fileMode)
      return Response.json(
        {
          code: 2,
          message:
            'reading policy from path "": open : no such file or directory',
        },
        { status: 500 },
      );
    if (path === "/api/v1/user") {
      ++identityReads;
      if (identityDelay) await identityDelay;
      if (identityFailure)
        return Response.json(
          { message: "directory unavailable" },
          { status: 500 },
        );
      return Response.json({ users });
    }
    const values: Record<string, unknown> = {
      "/api/v1/health": { databaseConnectivity: true, serverReachable: true },
      "/version": { version: "0.29.4" },
      "/api/v1/node": { nodes: [] },
      "/api/v1/preauthkey": { preAuthKeys: [] },
      "/api/v1/apikey": { apiKeys: [] },
      "/api/v1/policy": { policy },
    };
    if (request.method !== "GET" || !(path in values))
      throw new Error(`Unexpected request: ${request.method} ${path}`);
    return Response.json(values[path]);
  };
  const session = await prepareTestSession(transport);
  await setLocale("en-US");
  const messages = {
    "common.notifications": "Notifications",
    "product.feedbackRefreshFailed": "Could not refresh data",
  };
  i18n.load("en-US", messages);
  getLocaleI18n("en-US").load("en-US", messages);
  await authenticateTestSession(session);
  let router: AnyRouter;
  if (layout) {
    const root = createRootRoute({ component: AppLayout });
    const access = createRoute({
      getParentRoute: () => root,
      path: "/access",
      component: AccessPage,
    });
    const home = createRoute({
      getParentRoute: () => root,
      path: "/home",
      component: () => <p>Home fixture</p>,
    });
    router = createRouter({
      routeTree: root.addChildren([access, home]),
      history: createMemoryHistory({ initialEntries: ["/access"] }),
    });
    await router.load();
    await render(
      <SessionTestProviders session={session}>
        <RouterProvider router={router} />
      </SessionTestProviders>,
    );
  } else {
    ({ router } = await renderSessionPage(session, <AccessPage />, "/access"));
  }
  await expect.poll(() => session.snapshot.getSnapshot().isReady).toBe(true);
  await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
  await expect.element(page.getByTestId("save-policy")).toBeVisible();
  return {
    session,
    writes,
    router,
    setPolicy: (next: Record<string, unknown>) => {
      policy = JSON.stringify(next);
    },
    setUsers: (next: typeof users) => {
      users = next;
    },
    failIdentity: (fail: boolean) => {
      identityFailure = fail;
    },
    holdIdentity: (delay: Promise<void> | undefined) => {
      identityDelay = delay;
    },
    rejectSave: () => {
      saveRejected = true;
    },
    identityReads: () => identityReads,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await page.viewport(1280, 720);
  await setLocale("en-US");
});

test.each([
  {
    name: "provider-owned email does not hide the local account",
    users: [
      { id: "1", name: "local", email: "shared@example.com" },
      { id: "2", name: "provider", providerId: "shared@example.com" },
    ],
    selected: ["shared@example.com"],
    options: ["local@"],
    absent: ["provider@"],
  },
  {
    name: "ambiguous email falls back to unique names",
    users: [
      { id: "1", name: "alice", email: "shared@example.com" },
      { id: "2", name: "bob", email: "shared@example.com" },
    ],
    selected: ["shared@example.com"],
    options: ["alice@", "bob@"],
    absent: ["shared@example.com"],
  },
  {
    name: "trailing-at names remain distinct",
    users: [
      { id: "1", name: "alice" },
      { id: "2", name: "alice@" },
    ],
    selected: [],
    options: ["alice@", "alice@@"],
    absent: [],
  },
])(
  "integrated principal picker: $name",
  async ({ users, selected, options, absent }) => {
    const fixture = await setup({
      groups: { "group:ops": selected },
      acls: [],
    });
    fixture.setUsers(users);
    await fixture.session.snapshot.refreshSegments(["identity"]);
    await page.getByTestId("team-card-group:ops").click();
    await page.getByTestId("team-add-member-trigger").click();
    for (const value of options) {
      await expect
        .element(page.getByTestId(`team-add-member-option-${value}`))
        .toBeVisible();
    }
    for (const value of absent) {
      await expect
        .element(page.getByTestId(`team-add-member-option-${value}`))
        .not.toBeInTheDocument();
    }
    await page.getByTestId(`team-add-member-option-${options[0]}`).click();
    expect(fixture.session.policy.policyPayload?.groups).toEqual({
      "group:ops": [...selected, options[0]],
    });
    expect(fixture.writes).toEqual([]);
  },
);

// If policy success were treated as evidence of a fresh directory, Carol would be cleared.
test.each(["failure", "delay"] as const)(
  "F04: ready layout preserves unverified users after policy success and identity %s",
  async (mode) => {
    const fixture = await setup(opsPolicy, true);
    const { session } = fixture;
    const newPolicy = {
      ...opsPolicy,
      groups: { "group:ops": ["alice@", "carol@", "ghost@", "group:missing"] },
    };
    fixture.setPolicy(newPolicy);
    fixture.setUsers([
      { id: "1", name: "alice" },
      { id: "2", name: "carol" },
    ]);
    const held = Promise.withResolvers<void>();
    if (mode === "failure") fixture.failIdentity(true);
    else fixture.holdIdentity(held.promise);
    const refresh = session.snapshot.refreshSegments(["identity", "policy"]);
    try {
      await expect
        .poll(() => session.policy.policyPayload?.groups)
        .toEqual(newPolicy.groups);
      if (mode === "failure") await refresh;
      expect(session.snapshot.getSnapshot().isReady).toBe(true);
      await page.getByTestId("cleanup-orphan-refs").click();
      await page.getByTestId("cleanup-orphans-confirm").click();
      await expect
        .poll(() => session.policy.policyPayload?.groups)
        .toEqual({ "group:ops": ["alice@", "carol@", "ghost@"] });
      await expect
        .element(page.getByTestId("identity-unverified-notice"))
        .toMatchTextContent(/directory.*refresh/i);
      expect(fixture.writes).toEqual([]);
    } finally {
      held.resolve();
      await refresh;
    }
    fixture.failIdentity(false);
    await session.snapshot.refreshSegments(["identity"]);
    await expect
      .element(page.getByTestId("identity-unverified-notice"))
      .not.toBeInTheDocument();
    await page.getByTestId("cleanup-orphan-refs").click();
    await page.getByTestId("cleanup-orphans-confirm").click();
    await expect
      .poll(() => session.policy.policyPayload?.groups)
      .toEqual({ "group:ops": ["alice@", "carol@"] });
  },
);

test("F04: cleanup rechecks the user directory before removing a previously unknown account", async () => {
  const fixture = await setup(
    { ...opsPolicy, groups: { "group:ops": ["carol@"] } },
    true,
  );
  const reads = fixture.identityReads();
  await page.getByTestId("cleanup-orphan-refs").click();
  fixture.setUsers([
    { id: "1", name: "alice" },
    { id: "2", name: "carol" },
  ]);
  await page.getByTestId("cleanup-orphans-confirm").click();
  // The confirm handler starts the directory recheck and does not return it.
  await expect.poll(() => fixture.identityReads()).toBeGreaterThan(reads);
  await expect
    .element(page.getByTestId("cleanup-orphans-dialog"))
    .not.toBeInTheDocument();
  expect(fixture.session.policy.policyPayload?.groups).toEqual({
    "group:ops": ["carol@"],
  });
  expect(fixture.session.policy.isPolicyDirty).toBe(false);
});

test.each(["context", "session"] as const)(
  "F04: delayed cleanup cannot remove users after its %s is retired",
  async (retirement) => {
    const initial = { ...opsPolicy, groups: { "group:ops": ["ghost@"] } };
    const fixture = await setup(initial);
    const { session } = fixture;
    const reads = fixture.identityReads();
    const held = Promise.withResolvers<void>();
    fixture.holdIdentity(held.promise);
    await page.getByTestId("cleanup-orphan-refs").click();
    await page.getByTestId("cleanup-orphans-confirm").click();
    try {
      await expect.poll(fixture.identityReads).toBeGreaterThan(reads);
      if (retirement === "context")
        await page.getByTestId("team-card-group:ops").click();
      else {
        fixture.holdIdentity(undefined);
        await authenticateTestSession(session, "https://other.invalid");
        await expect
          .poll(() => session.auth.getSessionSnapshot()?.profile?.baseUrl)
          .toBe("https://other.invalid");
      }
    } finally {
      held.resolve();
    }
    await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
    expect(session.policy.policyPayload?.groups).toEqual(initial.groups);
    expect(session.policy.isPolicyDirty).toBe(false);
    expect(fixture.writes).toEqual([]);
  },
);

test("feedback: a cleanup directory read failure reports once and preserves unverified references", async () => {
  const initial = { ...opsPolicy, groups: { "group:ops": ["ghost@"] } };
  const fixture = await setup(initial);
  await page.getByTestId("cleanup-orphan-refs").click();
  fixture.failIdentity(true);
  await page.getByTestId("cleanup-orphans-confirm").click();
  await expect
    .element(page.getByTestId("identity-unverified-notice"))
    .toMatchTextContent(/directory.*refresh/i);
  await expect.poll(() => fixture.session.snapshot.isRefreshing).toBe(false);
  expect(fixture.session.policy.policyPayload?.groups).toEqual(initial.groups);
  expect(fixture.session.policy.isPolicyDirty).toBe(false);
  const notifications = page.getByRole("region", {
    name: "Notifications",
    exact: true,
  });
  await expect
    .element(notifications.getByRole("dialog"))
    .toMatchTextContent("Could not refresh data");
  expect(notifications.getByRole("dialog").elements()).toHaveLength(1);
  await notifications
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect
    .element(page.getByTestId("identity-unverified-notice"))
    .toBeVisible();
  expect(fixture.writes).toEqual([]);
});

test("file-mode policy remains read-only instead of showing editable deny-all", async () => {
  const { writes } = await setup({}, true, true);
  const notice = page.getByTestId("policy-read-only-notice");
  await expect.element(notice).toBeVisible();
  await expect.element(notice).toMatchTextContent(/file|Headscale/i);
  await expect.element(page.getByTestId("save-policy")).toBeDisabled();
  await expect
    .element(page.getByTestId("save-policy-bottom"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("deny-all-banner"))
    .not.toBeInTheDocument();
  expect(writes).toEqual([]);
});

test.each([{ acls: [], grants: [] }, { grants: [] }])(
  "F22: empty grants warn deny-all without injecting access: %j",
  async (initial) => {
    const { session, writes } = await setup(initial, true);
    await expect
      .element(page.getByTestId("deny-all-banner"))
      .toMatchTextContent(copy.denyAllBannerTitle);
    await expect
      .element(page.getByTestId("grants-preserved-notice"))
      .not.toBeInTheDocument();
    expect(session.policy.policyPayload).toMatchObject({
      acls: [],
      grants: [],
    });
    expect(writes).toEqual([]);
  },
);

test("F12: IP rows and removal preview distinguish protocols and expose unknown restrictions", async () => {
  const { session, writes } = await setup({
    acls: [
      {
        action: "accept",
        src: ["alice@"],
        dst: ["10.0.0.1:22"],
        proto: "tcp",
        srcPosture: ["posture:managed"],
      },
      { action: "accept", src: ["alice@"], dst: ["10.0.0.1:22"], proto: "udp" },
    ],
  });
  const [tcp, udp] = session.policy.policyDesignerState.rules;
  for (const [rule, protocol] of [
    [tcp, "tcp"],
    [udp, "udp"],
  ] as const) {
    const row = page.getByTestId(`ip-rule-${rule.id}`);
    await expect.element(row).toMatchTextContent(protocol);
    await row.getByText("Rule restrictions", { exact: true }).click();
    await expect.element(row).toMatchTextContent(`"proto": "${protocol}"`);
    await page.getByTestId(`ip-rule-remove-${rule.id}`).click();
    await expect
      .element(page.getByTestId("remove-policy-item-dialog"))
      .toMatchTextContent(protocol);
    if (protocol === "tcp")
      await expect
        .element(page.getByTestId("remove-policy-item-dialog"))
        .toMatchTextContent("posture:managed");
    await page.getByTestId("cancel-remove-policy-item").click();
  }
  await page.getByTestId(`ip-rule-edit-${tcp.id}`).click();
  await page.getByTestId(`ip-rule-ports-${tcp.id}`).fill("8443");
  await page.getByTestId(`ip-rule-save-${tcp.id}`).click();
  await page.getByTestId("save-policy").click();
  await page.getByTestId("policy-publication-confirm").click();
  await expect
    .poll(() => writes)
    .toEqual([
      {
        groups: {},
        tagOwners: {},
        acls: [
          {
            action: "accept",
            src: ["alice@"],
            dst: ["10.0.0.1:8443"],
            proto: "tcp",
            srcPosture: ["posture:managed"],
          },
          {
            action: "accept",
            src: ["alice@"],
            dst: ["10.0.0.1:22"],
            proto: "udp",
          },
        ],
      },
    ]);
});

test("F12: tag and team summaries do not call UDP 22 SSH and show each restricted rule", async () => {
  await setup({
    ...opsPolicy,
    acls: [
      {
        action: "accept",
        src: ["group:ops"],
        dst: ["tag:server:22"],
        proto: "udp",
        srcPosture: ["posture:managed"],
      },
    ],
  });
  const card = page.getByTestId("tag-card-tag:server");
  await expect.element(card).toMatchTextContent("udp");
  await expect.element(card).toMatchTextContent("22");
  await expect.element(card).not.toMatchTextContent("SSH");
  await page.getByTestId("tag-open-tag:server").click();
  const row = page.getByTestId("tag-accessor-row-group:ops");
  await row.getByText("Rule restrictions", { exact: true }).click();
  await expect.element(row).toMatchTextContent("posture:managed");
  await expect
    .element(page.getByTestId("tag-accessor-svc-group:ops-ssh"))
    .toBeDisabled();
  await expect
    .element(page.getByTestId("tag-accessor-svc-group:ops-ssh"))
    .not.toBeChecked();
  await page.getByTestId("tag-detail-close").click();
  await page.getByTestId("team-card-group:ops").click();
  await expect
    .element(page.getByTestId("team-access-view"))
    .toMatchTextContent("udp");
  await expect
    .element(page.getByTestId("team-access-view"))
    .not.toMatchTextContent("SSH");
});

test.each([{ proto: 17 }, { srcPosture: ["posture:managed"] }])(
  "F12: keyboard exposes non-TCP restrictions without opening the parent card: %j",
  async (extras) => {
    await setup({
      ...opsPolicy,
      acls: [{ ...opsPolicy.acls[0], ...extras }],
    });
    const card = page.getByTestId("tag-card-tag:server");
    const details = card.element().querySelector("details");
    const summary = details?.querySelector("summary");
    expect(summary).not.toBeNull();
    summary?.focus();
    await userEvent.keyboard("{Enter}");
    expect(details?.open).toBe(true);
    await expect
      .element(page.getByTestId("tag-detail-dialog"))
      .not.toBeInTheDocument();
    const json = details?.querySelector("pre")?.textContent;
    expect(JSON.parse(json ?? "null")).toEqual(extras);
    if ("proto" in extras)
      await expect.element(card).not.toMatchTextContent("SSH");
  },
);

test.each([
  { who: "group:ops", ports: "*", label: "ops" },
  { who: "*", ports: "22,80,443", label: "Anyone" },
  { who: "*", ports: "*", label: "Anyone" },
])(
  "F17: confirmation names real scope $who → tag:server:$ports",
  async ({ who, ports, label }) => {
    const { session } = await setup({
      ...opsPolicy,
      acls: [{ action: "accept", src: [who], dst: ["tag:server:22"] }],
    });
    await page.getByTestId("tag-open-tag:server").click();
    await page
      .getByTestId(`tag-accessor-svc-${who}-${ports === "*" ? "all" : "web"}`)
      .click();
    const dialog = page.getByTestId("high-risk-confirm-dialog");
    await expect.element(dialog).toMatchTextContent(label);
    await expect.element(dialog).toMatchTextContent("tag:server");
    await expect
      .element(dialog)
      .toMatchTextContent(ports === "*" ? "All ports" : "22,80,443");
    if (ports !== "*")
      await expect.element(dialog).not.toMatchTextContent("every service");
    await page.getByTestId("high-risk-confirm").click();
    expect(session.policy.policyPayload?.acls).toEqual([
      { action: "accept", src: [who], dst: [`tag:server:${ports}`] },
    ]);
  },
);

function characterX(element: Element, text: string, index: number) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node && node.textContent !== text) node = walker.nextNode();
  if (!node) throw new Error(`Missing identifier ${text}`);
  const range = document.createRange();
  range.setStart(node, index);
  range.setEnd(node, index + 1);
  return range.getBoundingClientRect().x;
}

test("F18: RTL cards and owner rows keep the suffix after alice without changing text", async () => {
  await setup({
    ...opsPolicy,
    acls: [{ action: "accept", src: ["alice@"], dst: ["tag:server:22"] }],
  });
  await setLocale("ar");
  for (const id of ["team-card-group:ops", "tag-card-tag:server"]) {
    const card = page.getByTestId(id).element();
    expect(characterX(card, "alice@", 5)).toBeGreaterThan(
      characterX(card, "alice@", 0),
    );
  }
  await page.getByTestId("tag-open-tag:server").click();
  const row = page.getByTestId("tag-owner-row-alice@").element();
  expect(characterX(row, "alice@", 5)).toBeGreaterThan(
    characterX(row, "alice@", 0),
  );
  expect(row.querySelector('bdi[dir="auto"]')?.textContent).toBe("alice@");
});

const ipPolicy = {
  acls: [
    { action: "accept", src: ["10.0.0.0/8"], dst: ["192.168.0.0/16:443"] },
    { action: "accept", src: ["10.1.0.0/16"], dst: ["192.168.1.0/24:22"] },
  ],
};

test.each(["row", "add", "leave"] as const)(
  "F11: dirty IP input requires a choice before %s",
  async (target) => {
    const { session, router, writes } = await setup(ipPolicy, true);
    const [first, second] = session.policy.policyDesignerState.rules;
    await page.getByTestId(`ip-rule-edit-${first.id}`).click();
    await page.getByTestId(`ip-rule-ports-${first.id}`).fill("8443");
    const move = async () => {
      if (target === "row")
        await page.getByTestId(`ip-rule-edit-${second.id}`).click();
      else if (target === "add") await page.getByTestId("add-ip-rule").click();
      else
        await page.getByRole("link", { name: "Overview", exact: true }).click();
    };
    await move();
    await expect
      .element(page.getByTestId("discard-ip-draft-dialog"))
      .toBeVisible();
    await page.getByTestId("discard-ip-draft-cancel").click();
    await expect
      .element(page.getByTestId(`ip-rule-ports-${first.id}`))
      .toHaveValue("8443");
    expect(session.policy.policyPayload?.acls).toEqual(ipPolicy.acls);
    await move();
    await page.getByTestId("discard-ip-draft-confirm").click();
    if (target === "leave")
      await expect.poll(() => router.state.location.pathname).toBe("/home");
    else
      await expect
        .element(
          page.getByTestId(
            `ip-rule-source-${target === "add" ? "new" : second.id}`,
          ),
        )
        .toHaveFocus();
    expect(writes).toEqual([]);
  },
);

test("F11: repeated Add preserves text; clean switching and explicit Cancel need no prompt", async () => {
  const { session, router } = await setup(ipPolicy, true);
  const first = session.policy.policyDesignerState.rules[0];
  await page.getByTestId("add-ip-rule").click();
  await page.getByTestId("ip-rule-source-new").fill("10.42.0.0/16");
  await page.getByTestId("add-ip-rule").click();
  await expect
    .element(page.getByTestId("ip-rule-source-new"))
    .toHaveValue("10.42.0.0/16");
  await expect
    .element(page.getByTestId("discard-ip-draft-dialog"))
    .not.toBeInTheDocument();
  await page.getByTestId("ip-rule-cancel-new").click();
  await expect.element(page.getByTestId("add-ip-rule")).toHaveFocus();
  await page.getByTestId(`ip-rule-edit-${first.id}`).click();
  await page.getByTestId("add-ip-rule").click();
  await expect.element(page.getByTestId("ip-rule-source-new")).toHaveFocus();
  await expect
    .element(page.getByTestId("discard-ip-draft-dialog"))
    .not.toBeInTheDocument();
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await expect.poll(() => router.state.location.pathname).toBe("/home");
  expect(session.policy.policyPayload?.acls).toEqual(ipPolicy.acls);
});

test("IP fields retain visible labels after typing", async () => {
  const { session } = await setup(ipPolicy);
  const first = session.policy.policyDesignerState.rules[0];
  await page.getByTestId(`ip-rule-edit-${first.id}`).click();
  for (const field of ["source", "destination", "ports"]) {
    const input = page
      .getByTestId(`ip-rule-${field}-${first.id}`)
      .element() as HTMLInputElement;
    expect(input.labels?.length).toBe(1);
    expect(input.labels?.[0].textContent?.trim()).not.toBe("");
  }
});

test("bottom Save publishes the confirmed global draft and explains normalization", async () => {
  const { session, writes } = await setup(ipPolicy);
  const first = session.policy.policyDesignerState.rules[0];
  await page.getByTestId(`ip-rule-edit-${first.id}`).click();
  await page.getByTestId(`ip-rule-ports-${first.id}`).fill("8443");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByTestId("policy-normalization-notice"))
    .toMatchTextContent(/normalized JSON.*HuJSON comments/);
  await page.getByTestId("save-policy-bottom").click();
  await page.getByTestId("policy-publication-confirm").click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].acls).toEqual([
    { ...ipPolicy.acls[0], dst: ["192.168.0.0/16:8443"] },
    ipPolicy.acls[1],
  ]);
  await expect.element(page.getByTestId("save-policy")).toBeDisabled();
  await expect.element(page.getByTestId("save-policy-bottom")).toBeDisabled();
});

test("feedback: bottom Save reports one persistent failure and retains the policy draft", async () => {
  const fixture = await setup(ipPolicy);
  const first = fixture.session.policy.policyDesignerState.rules[0];
  await page.getByTestId(`ip-rule-edit-${first.id}`).click();
  await page.getByTestId(`ip-rule-ports-${first.id}`).fill("8443");
  await userEvent.keyboard("{Enter}");
  fixture.rejectSave();
  await page.getByTestId("save-policy-bottom").click();
  await page.getByTestId("policy-publication-confirm").click();
  const report = page.getByTestId("save-policy-error");
  await expect.element(report).toBeVisible();
  await expect.element(report).toHaveTextContent("policy rejected");
  expect(report.elements()).toHaveLength(1);
  await expect
    .element(page.getByTestId("policy-save-uncertain"))
    .toHaveTextContent(copy.writeOutcomeVerifyInAccess);
  await expect
    .element(page.getByTestId("policy-pending-reconciliation"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("policy-pending-release"))
    .not.toBeInTheDocument();
  await expect.element(page.getByTestId("save-policy")).toBeEnabled();
  await expect.element(page.getByTestId("save-policy-bottom")).toBeEnabled();
  await expect
    .element(page.getByTestId("dialog-save-policy-error"))
    .not.toBeInTheDocument();
  expect(document.querySelectorAll('[data-slot="toast"]')).toHaveLength(0);
  expect(fixture.session.policy.policyPayload?.acls).toEqual([
    { ...ipPolicy.acls[0], dst: ["192.168.0.0/16:8443"] },
    ipPolicy.acls[1],
  ]);
  expect(fixture.session.policy.isPolicyDirty).toBe(true);
  expect(fixture.writes).toHaveLength(1);
});

test("feedback: a publication conflict has one foreground report and survives closing review", async () => {
  const fixture = await setup(ipPolicy);
  const first = fixture.session.policy.policyDesignerState.rules[0];
  await page.getByTestId(`ip-rule-edit-${first.id}`).click();
  await page.getByTestId(`ip-rule-ports-${first.id}`).fill("8443");
  await userEvent.keyboard("{Enter}");
  await page.getByTestId("save-policy").click();
  const original = page
    .getByTestId("policy-publication-original")
    .element().textContent;
  const submitted = page
    .getByTestId("policy-publication-submitted")
    .element().textContent;
  fixture.setPolicy({ ...ipPolicy, hosts: { changed: "10.99.0.0/16" } });
  await page.getByTestId("policy-publication-confirm").click();
  await expect
    .element(page.getByTestId("policy-publication-current"))
    .toBeVisible();
  const report = page
    .getByTestId("policy-publication-review")
    .getByText(copy.policySaveConflict, { exact: true });
  await expect.element(report).toBeVisible();
  expect(report.elements()).toHaveLength(1);
  await expect
    .element(page.getByTestId("save-policy-error"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("dialog-save-policy-error"))
    .not.toBeInTheDocument();
  expect(
    page.getByTestId("policy-publication-original").element().textContent,
  ).toBe(original);
  expect(
    page.getByTestId("policy-publication-submitted").element().textContent,
  ).toBe(submitted);
  await expect
    .element(page.getByTestId("policy-publication-confirm"))
    .toBeDisabled();
  await page.getByTestId("policy-publication-cancel").click();
  await expect
    .element(page.getByTestId("policy-publication-review"))
    .not.toBeInTheDocument();
  const diagnostic = page.getByTestId("save-policy-error");
  await expect.element(diagnostic).toBeVisible();
  await expect.element(diagnostic).toHaveTextContent(copy.policySaveConflict);
  expect(diagnostic.elements()).toHaveLength(1);
  await expect
    .element(page.getByTestId("dialog-save-policy-error"))
    .not.toBeInTheDocument();
  expect(fixture.session.policy.isPolicyDirty).toBe(true);
  expect(fixture.session.policy.getSnapshot().policyDraft).toBe(original);
  await page.getByTestId("save-policy").click();
  await expect
    .element(page.getByTestId("policy-publication-confirm"))
    .toBeDisabled();
  expect(
    page.getByTestId("policy-publication-original").element().textContent,
  ).toBe(original);
  expect(
    page.getByTestId("policy-publication-submitted").element().textContent,
  ).toBe(submitted);
  expect(fixture.writes).toEqual([]);
});

test.each(["save-policy", "save-policy-bottom"])(
  "observed policy conflicts block %s and explicit discard adopts the observed policy",
  async (saveId) => {
    const fixture = await setup(ipPolicy);
    const first = fixture.session.policy.policyDesignerState.rules[0];
    await page.getByTestId(`ip-rule-edit-${first.id}`).click();
    await page.getByTestId(`ip-rule-ports-${first.id}`).fill("8443");
    await userEvent.keyboard("{Enter}");
    const edited = fixture.session.policy.policyPayload;
    const remote = {
      ...ipPolicy,
      acls: [{ ...ipPolicy.acls[0], dst: ["192.168.0.0/16:443"] }],
    };
    fixture.setPolicy(remote);
    await fixture.session.snapshot.refreshSegments(["policy"]);
    expect(fixture.session.policy.policyPayload).toEqual(edited);
    await page.getByTestId(saveId).click();
    await expect
      .element(page.getByTestId("policy-publication-review"))
      .toBeVisible();
    await expect
      .element(page.getByTestId("policy-publication-confirm"))
      .toBeDisabled();
    expect(
      page.getByTestId("policy-publication-current").element().textContent,
    ).toBe(JSON.stringify(remote));
    expect(
      page.getByTestId("policy-publication-original").element().textContent,
    ).toBe(JSON.stringify(ipPolicy));
    expect(fixture.writes).toEqual([]);
    await page.getByTestId("policy-publication-cancel").click();
    expect(fixture.session.policy.policyPayload).toEqual(edited);
    expect(fixture.session.policy.isPolicyDirty).toBe(true);
    await page.getByTestId("discard-policy-changes").click();
    await page.getByTestId("discard-policy-cancel").click();
    expect(fixture.session.policy.policyPayload).toEqual(edited);
    await page.getByTestId("discard-policy-changes").click();
    await page.getByTestId("discard-policy-confirm").click();
    await expect.poll(() => fixture.session.policy.isPolicyDirty).toBe(false);
    expect(fixture.session.policy.policyPayload?.acls).toEqual(remote.acls);
    await expect
      .element(page.getByTestId("save-policy-error"))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByTestId("bottom-save-policy-error"))
      .not.toBeInTheDocument();
    expect(fixture.writes).toEqual([]);
  },
);

test.each(["en-US", "ar"] as const)(
  "dirty Access toolbar keeps every action inside a 375px viewport in %s",
  async (locale) => {
    const { session } = await setup(ipPolicy, true);
    const first = session.policy.policyDesignerState.rules[0];
    await page.getByTestId(`ip-rule-edit-${first.id}`).click();
    await page.getByTestId(`ip-rule-ports-${first.id}`).fill("8443");
    await userEvent.keyboard("{Enter}");
    await setLocale(locale);
    await page.viewport(375, 812);
    await expect
      .element(page.getByTestId("save-policy-dirty-badge"))
      .toBeVisible();
    for (const id of [
      "save-policy-dirty-badge",
      "discard-policy-changes",
      "check-policy",
      "save-policy",
    ]) {
      const rect = page.getByTestId(id).element().getBoundingClientRect();
      expect(rect.left, `${id} left`).toBeGreaterThanOrEqual(0);
      expect(rect.right, `${id} right`).toBeLessThanOrEqual(window.innerWidth);
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      window.innerWidth,
    );
    await page.getByTestId("save-policy").click();
    await page.getByTestId("policy-publication-confirm").click();
    await expect.poll(() => session.policy.isPolicyDirty).toBe(false);
  },
);

test.each(["en-US", "ar"] as const)(
  "long team dialog title clears the close control at 375px in %s",
  async (locale) => {
    const name =
      "native-a3mt9qdq-global-draft-with-a-deliberately-long-team-title-for-narrow-layout";
    await setup({ groups: { [`group:${name}`]: [] }, acls: [] });
    await setLocale(locale);
    await page.viewport(375, 812);
    await page.getByTestId(`team-card-group:${name}`).click();
    const dialog = page.getByTestId("team-detail-dialog").element();
    await expect
      .poll(() =>
        dialog
          .getAnimations({ subtree: true })
          .some((animation) => animation.playState === "running"),
      )
      .toBe(false);
    const title = dialog.querySelector('[data-slot="dialog-title"]');
    const close = dialog.querySelector('[data-slot="dialog-close"]');
    expect.assert(title && close);
    const control = close.getBoundingClientRect();
    const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (let index = 0; index < (node.textContent?.length ?? 0); ++index) {
        if (!node.textContent?.[index]?.trim()) continue;
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        const glyph = range.getBoundingClientRect();
        if (glyph.top < control.bottom && glyph.bottom > control.top) {
          expect(
            glyph.right <= control.left || glyph.left >= control.right,
            `title glyph ${node.textContent[index]} overlaps close control`,
          ).toBe(true);
        }
      }
    }
    expect(title.textContent).toContain(name);
    await page.getByTestId("team-detail-close").click();
    await expect
      .element(page.getByTestId("team-detail-dialog"))
      .not.toBeInTheDocument();
  },
);

test("F24: named stale-reference help leads to the available detail removal action in Chinese", async () => {
  await setup({ ...opsPolicy, tagOwners: { "tag:server": ["ghost@"] } });
  await setLocale("zh-Hans");
  const label = getProductCopy("zh-Hans").policyReferenceHelp;
  await page
    .getByTestId("tag-card-tag:server")
    .getByRole("button", { name: `${label} ghost@`, exact: true })
    .click();
  const help = page.getByRole("dialog", { name: label, exact: true });
  await expect.element(help).toBeVisible();
  expect(help.element().textContent).toContain("设备标签");
  expect(help.element().textContent).toContain("详情");
  expect(help.element().textContent).not.toContain("✕");
  await userEvent.keyboard("{Escape}");
  await expect.element(help).not.toBeInTheDocument();
  await page.getByTestId("tag-open-tag:server").click();
  await expect
    .element(page.getByTestId("tag-owner-remove-ghost@"))
    .toBeVisible();
});
