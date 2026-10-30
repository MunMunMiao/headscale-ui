import "fake-indexeddb/auto";
import type { FetchHandle } from "@defjs/core";
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { normalizeHeadscaleNode, normalizePreAuthKey } from "@/api/contracts";
import AccessPolicyReview from "@/components/policy/AccessPolicyReview";
import AccessTagMaintenance from "@/components/policy/AccessTagMaintenance";
import type { Session } from "@/composables/session-context";
import { createMutation } from "@/composables/useMutation";
import { parsePolicy } from "@/domain/policy-designer";
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

const baseline = {
  groups: { "group:ops": ["alice@"] },
  tagOwners: { "tag:server": ["alice@", "group:ops"] },
  acls: [{ action: "accept", src: ["group:ops"], dst: ["tag:server:22"] }],
};
const node = (id: string, tags: string[]) =>
  normalizeHeadscaleNode({ id, name: `node-${id}`, tags });
const key = (id: string, aclTags: string[]) =>
  normalizePreAuthKey({ id, key: "", aclTags, reusable: true });

let restoreBrowserHistory: (() => void) | undefined;
async function renderWithBrowserHistory(session: Session) {
  const original = { href: window.location.href, state: window.history.state };
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}#/access`,
  );
  const history = createHashHistory({ window });
  restoreBrowserHistory = () => {
    history.destroy();
    window.history.replaceState(original.state, "", original.href);
  };
  const root = createRootRoute({ component: Outlet });
  const children = ["/access", "/devices", "/members", "/invites"].map((path) =>
    createRoute({
      getParentRoute: () => root,
      path,
      component: () => (path === "/access" ? <AccessPage /> : <p>{path}</p>),
    }),
  );
  const router = createRouter({
    routeTree: root.addChildren(children),
    history,
  });
  await router.load();
  const rendered = await render(
    <SessionTestProviders session={session}>
      <RouterProvider router={router} />
    </SessionTestProviders>,
  );
  return { ...rendered, router };
}

async function setup(
  initial: object | string = baseline,
  prepareContext?: (session: Session) => void,
  browserHistory = false,
  initialPolicyRead?: Promise<void>,
) {
  let policy = typeof initial === "string" ? initial : JSON.stringify(initial);
  let nodes = [node("1", ["tag:observed", "tag:extra"])];
  let preAuthKeys = [
    key("key-1", ["tag:key-only"]),
    key("key-2", ["tag:1abc"]),
  ];
  let failedPath = "";
  let writeFailure = "";
  let writeDelay: Promise<void> | undefined;
  let readDelay: { path: string; promise: Promise<void> } | undefined;
  const reads: string[] = [];
  const writes: string[] = [];
  const checks: string[] = [];
  const stoppedKeys: { action: "expire" | "delete"; id: string }[] = [];
  const transport: FetchHandle = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method === "PUT" && path === "/api/v1/policy") {
      const body = (await request.json()) as { policy: string };
      writes.push(body.policy);
      if (writeDelay) await writeDelay;
      if (writeFailure)
        return Response.json({ message: writeFailure }, { status: 500 });
      policy = body.policy;
      return Response.json({ policy });
    }
    if (request.method === "POST" && path === "/api/v1/policy/check") {
      checks.push(((await request.json()) as { policy: string }).policy);
      return Response.json({});
    }
    if (
      (request.method === "POST" && path === "/api/v1/preauthkey/expire") ||
      (request.method === "DELETE" && path === "/api/v1/preauthkey")
    ) {
      const action = request.method === "POST" ? "expire" : "delete";
      const id =
        action === "expire"
          ? ((await request.json()) as { id: string }).id
          : new URL(request.url).searchParams.get("id");
      if (!id) throw new Error("Missing key id");
      stoppedKeys.push({ action, id });
      preAuthKeys =
        action === "delete"
          ? preAuthKeys.filter((entry) => entry.id !== id)
          : preAuthKeys.map((entry) =>
              entry.id === id
                ? { ...entry, expiration: "2000-01-01T00:00:00Z" }
                : entry,
            );
      throw new TypeError("key stop response lost");
    }
    if (request.method !== "GET")
      throw new Error(`Unexpected ${request.method} ${path}`);
    reads.push(path);
    if (readDelay?.path === path) await readDelay.promise;
    if (path === failedPath)
      return Response.json({ message: "source unavailable" }, { status: 503 });
    const values: Record<string, unknown> = {
      "/api/v1/health": { databaseConnectivity: true, serverReachable: true },
      "/version": { version: "0.29.4" },
      "/api/v1/user": {
        users: [
          { id: "1", name: "alice" },
          { id: "2", name: "bob" },
        ],
      },
      "/api/v1/node": { nodes },
      "/api/v1/preauthkey": { preAuthKeys },
      "/api/v1/apikey": { apiKeys: [] },
      "/api/v1/policy": { policy },
    };
    if (!(path in values)) throw new Error(`Unexpected GET ${path}`);
    return Response.json(values[path]);
  };
  const session = await prepareTestSession(transport);
  await setLocale("en-US");
  // Keep the centrally owned, not-yet-compiled catalog out of behavioral RED results.
  const messages = {
    "common.notifications": "Notifications",
    "product.feedbackRefreshFailed": "Could not refresh data",
    "product.policyInventoryUnknownTitle": "Required sources are unverified",
  };
  i18n.load("en-US", messages);
  getLocaleI18n("en-US").load("en-US", messages);
  await authenticateTestSession(session);
  if (initialPolicyRead)
    readDelay = { path: "/api/v1/policy", promise: initialPolicyRead };
  const view = browserHistory
    ? await renderWithBrowserHistory(session)
    : await renderSessionPage(session, <AccessPage />, "/access");
  if (initialPolicyRead) {
    await expect
      .poll(() => session.snapshot.getSnapshot().segmentStatus.fabric)
      .toBe("ready");
  } else {
    await expect.poll(() => session.snapshot.getSnapshot().isReady).toBe(true);
    await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
  }
  prepareContext?.(session);
  return {
    session,
    ...view,
    reads,
    writes,
    checks,
    stoppedKeys,
    setPolicy: (text: string) => {
      policy = text;
    },
    setNodes: (next: typeof nodes) => {
      nodes = next;
    },
    setKeys: (next: typeof preAuthKeys) => {
      preAuthKeys = next;
    },
    failRead: (path: string) => {
      failedPath = path;
    },
    failWrite: (message: string) => {
      writeFailure = message;
    },
    holdWrite: (delay: Promise<void> | undefined) => {
      writeDelay = delay;
    },
    holdRead: (path: string, promise: Promise<void>) => {
      readDelay = { path, promise };
    },
  };
}

afterEach(async () => {
  if (restoreBrowserHistory) {
    await cleanup();
    restoreBrowserHistory();
    restoreBrowserHistory = undefined;
  }
  vi.restoreAllMocks();
  await setLocale("en-US");
  await page.viewport(1280, 720);
});

test("issue12: observed names do not become undeclared access sources", async () => {
  const fixture = await setup({
    groups: { "group:ops": ["alice@"] },
    tagOwners: {
      "tag:server": ["group:ops"],
      "tag:app": [],
      "tag:legacy,name": [],
    },
    acls: [],
  });
  await page.getByTestId("tag-open-tag:server").click();
  await page.getByTestId("tag-add-accessor-trigger").click();
  await expect
    .element(page.getByTestId("tag-add-accessor-option-tag:app"))
    .toBeVisible();
  for (const tag of [
    "tag:observed",
    "tag:extra",
    "tag:key-only",
    "tag:1abc",
    "tag:legacy,name",
  ]) {
    await expect
      .element(page.getByTestId(`tag-add-accessor-option-${tag}`))
      .not.toBeInTheDocument();
  }
  await page.getByTestId("tag-add-accessor-option-tag:app").click();
  expect(fixture.session.policy.policyPayload?.tagOwners).toEqual({
    "tag:server": ["group:ops"],
    "tag:app": [],
    "tag:legacy,name": [],
  });
  expect(fixture.writes).toEqual([]);
});

test("issue12: source declarations follow the draft rather than the saved inventory", async () => {
  const fixture = await setup({
    groups: { "group:ops": ["alice@"] },
    tagOwners: { "tag:server": ["group:ops"], "tag:app": [] },
    acls: [],
  });
  const saved = fixture.session.snapshot.getSnapshot().snapshot.policy?.policy;
  expect(saved).toBeDefined();
  expect(JSON.parse(saved ?? "{}").tagOwners).toHaveProperty("tag:app");
  fixture.session.policy.commitState(
    parsePolicy(
      JSON.stringify({
        groups: { "group:ops": ["alice@"] },
        tagOwners: { "tag:server": ["group:ops"], "tag:fresh": [] },
        acls: [],
      }),
    ),
  );
  await page.getByTestId("tag-open-tag:server").click();
  await page.getByTestId("tag-add-accessor-trigger").click();
  await expect
    .element(page.getByTestId("tag-add-accessor-option-tag:fresh"))
    .toBeVisible();
  await expect
    .element(page.getByTestId("tag-add-accessor-option-tag:app"))
    .not.toBeInTheDocument();
  expect(fixture.writes).toEqual([]);
});

test.each(["", "   "])(
  "review M3: a blank maintenance query %j cannot create an invisible active draft",
  async (maintenance) => {
    const fixture = await setup();
    const environment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    try {
      await act(() =>
        fixture.router.navigate({ to: "/access", search: { maintenance } }),
      );
    } finally {
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", environment);
    }
    await expect
      .poll(() => fixture.session.drafts.hasActiveDrafts())
      .toBe(false);
    await expect
      .element(page.getByTestId("tag-maintenance-dialog"))
      .not.toBeInTheDocument();
    expect(
      fixture.session.drafts.hold({ id: "other", name: "Other server" }),
    ).toBe(false);
    deviceReturn(fixture.session, "tag:server");
    await expect
      .element(page.getByTestId("tag-name-input"))
      .toHaveValue("server");
  },
);

test("usability: a remaining empty tagOwners definition is an explicit retirement blocker", async () => {
  const fixture = await setup({ acls: [], tagOwners: { "tag:unused": [] } });
  await page.getByTestId("tag-maintenance-tag:unused").click();
  await page.getByTestId("tag-maintenance-retire").click();
  await expect
    .element(page.getByTestId("tag-retirement-external"))
    .toBeEnabled();
  await page.getByTestId("tag-retirement-external").click();
  await expect
    .element(page.getByTestId("tag-retirement-blocker-definition"))
    .toMatchTextContent("tagOwners");
  await expect
    .element(page.getByTestId("tag-retirement-blocker-definition"))
    .toMatchTextContent("tag:unused");
  await expect
    .element(page.getByTestId("tag-retirement-blocker-external"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("tag-retirement-blocker-nodes"))
    .not.toBeInTheDocument();
  expect(fixture.writes).toEqual([]);
});

test("usability: maintenance identifies a device by the same management name as its detail", async () => {
  const fixture = await setup();
  fixture.setNodes([
    {
      ...node("1", ["tag:observed"]),
      name: "client-hostname",
      givenName: "managed-router",
    },
  ]);
  await page.getByTestId("tag-maintenance-tag:observed").click();
  await expect
    .element(page.getByTestId("tag-migration-node-1"))
    .toMatchTextContent("managed-router · 1");
});

test("usability: a confirmed publication retires its prior dry-run result", async () => {
  const fixture = await setup();
  fixture.session.policy.commitState(
    parsePolicy('{"acls":[],"tagOwners":{"tag:new":[]}}'),
  );
  await page.getByTestId("check-policy").click();
  await expect.element(page.getByTestId("policy-check-passed")).toBeVisible();
  await page.getByTestId("save-policy").click();
  await page.getByTestId("policy-publication-confirm").click();
  await expect.poll(() => fixture.writes.length).toBe(1);
  await expect.poll(() => fixture.session.policy.isPolicyDirty).toBe(false);
  await expect
    .element(page.getByTestId("policy-check-passed"))
    .not.toBeInTheDocument();
  await expect
    .poll(() => document.querySelectorAll('[data-slot="toast"]').length)
    .toBeLessThanOrEqual(1);
});

test.each([375, 1365])(
  "usability: full policy text is keyboard scrollable with visible initial focus at %spx",
  async (width) => {
    const session = await prepareTestSession();
    await setLocale("en-US");
    await page.viewport(width, 812);
    const raw = JSON.stringify(
      {
        hosts: Object.fromEntries(
          Array.from({ length: 80 }, (_, index) => [
            `host-${index}`,
            `10.0.0.${index}/32`,
          ]),
        ),
      },
      null,
      2,
    );
    await render(
      <SessionTestProviders session={session}>
        <AccessPolicyReview
          original={raw}
          submitted={`${raw}\n`}
          latest={`${raw}\n\n`}
          disabled={false}
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      </SessionTestProviders>,
    );
    const heading = page.getByRole("heading", {
      name: getProductCopy("en-US").policyPublishReview,
      exact: true,
    });
    await expect.element(heading).toHaveFocus();
    await expect
      .poll(() =>
        page
          .getByTestId("policy-publication-review")
          .element()
          .getAnimations({ subtree: true })
          .some((animation) => animation.playState === "running"),
      )
      .toBe(false);
    const initial = document.activeElement;
    expect.assert(initial instanceof HTMLElement);
    const initialRect = initial.getBoundingClientRect();
    expect(initialRect.top).toBeGreaterThanOrEqual(0);
    expect(initialRect.bottom).toBeLessThanOrEqual(812);
    for (const [testId, name] of [
      [
        "policy-publication-original",
        getProductCopy("en-US").policyRawOriginal,
      ],
      [
        "policy-publication-submitted",
        getProductCopy("en-US").policyFullSubmitted,
      ],
      ["policy-publication-current", getProductCopy("en-US").policyRawCurrent],
    ]) {
      const field = page.getByTestId(testId);
      for (
        let step = 0;
        step < 6 && document.activeElement !== field.element();
        ++step
      )
        await userEvent.tab();
      await expect.element(field).toHaveFocus();
      await expect.element(field).toHaveAccessibleName(name);
      const region = field.element();
      expect(region.scrollHeight).toBeGreaterThan(region.clientHeight);
      await userEvent.keyboard("{PageDown}");
      await expect.poll(() => region.scrollTop).toBeGreaterThan(0);
    }
  },
);

test("feedback: each explicit failed inventory refresh reports once even while an old unknown card remains", async () => {
  const fixture = await setup();
  fixture.failRead("/api/v1/preauthkey");
  await page.getByTestId("tag-maintenance-tag:observed").click();
  await expect
    .element(page.getByTestId("tag-maintenance-refresh"))
    .toBeEnabled();
  await expect.element(page.getByTestId("tag-inventory-unknown")).toBeVisible();
  expect(document.querySelectorAll('[data-slot="toast"]')).toHaveLength(0);
  const notifications = page.getByRole("region", {
    name: "Notifications",
    exact: true,
  });
  const readsBefore = fixture.reads.filter(
    (path) => path === "/api/v1/preauthkey",
  ).length;
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByTestId("tag-maintenance-refresh").click();
    await expect
      .element(notifications.getByRole("dialog"))
      .toMatchTextContent("Could not refresh data");
    expect(notifications.getByRole("dialog").elements()).toHaveLength(1);
    await notifications
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect
      .element(notifications.getByRole("dialog"))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByTestId("tag-inventory-unknown"))
      .toBeVisible();
  }
  expect(
    fixture.reads.filter((path) => path === "/api/v1/preauthkey"),
  ).toHaveLength(readsBefore + 2);
  await expect.element(page.getByTestId("tag-migration-node-1")).toBeVisible();
  await page.getByTestId("tag-maintenance-retire").click();
  await expect
    .element(page.getByTestId("tag-retirement-external"))
    .toBeDisabled();
  expect(fixture.writes).toEqual([]);
});

test("feedback: an inventory refresh after an uncertain write reports read failure without locking publication", async () => {
  const fixture = await setup();
  fixture.session.policy.commitState(
    parsePolicy('{"acls":[],"tagOwners":{"tag:server":[]}}'),
  );
  fixture.failWrite("saving policy to database: injected late failure");
  await page.getByTestId("save-policy").click();
  await page.getByTestId("policy-publication-confirm").click();
  await expect.element(page.getByTestId("policy-save-uncertain")).toBeVisible();
  const original = structuredClone(
    fixture.session.feedback.actionOutcome("save-policy"),
  );
  fixture.failRead("/api/v1/policy");
  await page.getByTestId("tag-maintenance-tag:observed").click();
  await expect
    .element(page.getByTestId("tag-maintenance-refresh"))
    .toBeEnabled();
  await page.getByTestId("tag-maintenance-refresh").click();
  const notifications = page.getByRole("region", {
    name: "Notifications",
    exact: true,
  });
  await expect
    .element(notifications.getByRole("dialog"))
    .toMatchTextContent("Could not refresh data");
  await notifications
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect
    .element(notifications.getByRole("dialog"))
    .not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("policy-save-uncertain")).toBeVisible();
  await expect.element(page.getByTestId("save-policy")).toBeEnabled();
  expect(fixture.session.policy.isPolicyDirty).toBe(true);
  expect(fixture.session.feedback.actionOutcome("save-policy")).toEqual(
    original,
  );
  expect(fixture.writes).toHaveLength(1);
});

test("feedback: an explicit removal reread reports failure without clearing its unknown dependency gate", async () => {
  const fixture = await setup();
  fixture.failRead("/api/v1/preauthkey");
  await page.getByTestId("tag-remove-tag:server").click();
  await expect.poll(() => fixture.session.snapshot.isRefreshing).toBe(false);
  const dialog = page.getByTestId("remove-policy-item-dialog");
  const notifications = page.getByRole("region", {
    name: "Notifications",
    exact: true,
  });
  expect(notifications.getByRole("dialog").elements()).toHaveLength(0);
  await dialog
    .getByRole("button", {
      name: getProductCopy("en-US").policyInventoryRefresh,
      exact: true,
    })
    .click();
  await expect
    .element(notifications.getByRole("dialog"))
    .toMatchTextContent("Could not refresh data");
  await notifications
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect
    .element(page.getByTestId("confirm-remove-policy-item"))
    .toBeDisabled();
  expect(dialog.element().textContent).toContain(
    getProductCopy("en-US").policyInventoryUnknown,
  );
  expect(fixture.session.policy.isPolicyDirty).toBe(false);
  expect(fixture.writes).toEqual([]);
});

test("feedback: a removal reread that ends after unmount does not report", async () => {
  const fixture = await setup();
  await page.getByTestId("tag-remove-tag:server").click();
  await expect.poll(() => fixture.session.snapshot.isRefreshing).toBe(false);
  const gate = Promise.withResolvers<void>();
  fixture.holdRead("/api/v1/preauthkey", gate.promise);
  fixture.failRead("/api/v1/preauthkey");
  const add = vi.spyOn(fixture.session.feedback.toastManager, "add");
  await page
    .getByTestId("remove-policy-item-dialog")
    .getByRole("button", {
      name: getProductCopy("en-US").policyInventoryRefresh,
      exact: true,
    })
    .click();
  await cleanup();
  gate.resolve();
  await expect.poll(() => fixture.session.snapshot.isRefreshing).toBe(false);
  expect(add).not.toHaveBeenCalled();
});

test("feedback: an uncertain policy write reports one inline diagnostic without a second banner or toast", async () => {
  const fixture = await setup();
  await page.getByTestId("tag-open-tag:observed").click();
  await page.getByTestId("tag-declare").click();
  await page.getByTestId("tag-detail-close").click();
  fixture.failWrite("saving policy to database: injected late failure");
  await page.getByTestId("save-policy").click();
  await page.getByTestId("policy-publication-confirm").click();
  await expect.element(page.getByTestId("policy-save-uncertain")).toBeVisible();
  const report = page.getByTestId("save-policy-error");
  await expect.element(report).toMatchTextContent("injected late failure");
  expect(report.elements()).toHaveLength(1);
  await expect
    .element(page.getByTestId("dialog-save-policy-error"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("policy-pending-reconciliation"))
    .not.toBeInTheDocument();
  expect(document.querySelectorAll('[data-slot="toast"]')).toHaveLength(0);
  expect(fixture.session.policy.isPolicyDirty).toBe(true);
  expect(fixture.writes).toHaveLength(1);
});

test("review-regression: a late failed write keeps its notice accessible after Maintenance reads newer raw policy", async () => {
  const fixture = await setup();
  await page.getByTestId("tag-open-tag:observed").click();
  await page.getByTestId("tag-declare").click();
  await page.getByTestId("tag-detail-close").click();
  const original = fixture.session.policy.getSnapshot().policyDraft;
  const revision = fixture.session.policy.getSnapshot().editRevision;
  const scope = fixture.session.tagLifecycle.captureScope();
  const latest = `/* external edit during PUT */${original}`;
  const failure = "saving policy to database: injected late failure";
  const pending = Promise.withResolvers<void>();
  fixture.holdWrite(pending.promise);
  fixture.failWrite(failure);
  await page.getByTestId("save-policy").click();
  await expect
    .element(page.getByTestId("policy-publication-original"))
    .toHaveTextContent(original);
  await page.getByTestId("policy-publication-confirm").click();
  await expect.poll(() => fixture.writes.length).toBe(1);
  try {
    expect(fixture.session.policy.isPolicySaving).toBe(true);
    fixture.setPolicy(latest);
    await page.getByTestId("tag-maintenance-tag:observed").click();
    await expect
      .poll(
        () => fixture.session.snapshot.getSnapshot().snapshot.policy?.policy,
      )
      .toBe(latest);
    await expect
      .element(page.getByTestId("tag-maintenance-refresh"))
      .toBeEnabled();
    await userEvent.keyboard("{Escape}");
    await expect
      .element(page.getByTestId("tag-maintenance-dialog"))
      .not.toBeInTheDocument();
    expect(fixture.session.tagLifecycle.isCurrent(scope)).toBe(true);
    expect(fixture.session.policy.getSnapshot()).toMatchObject({
      policyDraft: original,
      editRevision: revision,
      tagDetailOpen: false,
      teamDetailOpen: false,
    });
    expect(fixture.session.policy.isPolicySaving).toBe(true);
    expect(fixture.session.policy.isPolicyDirty).toBe(true);
  } finally {
    pending.resolve();
  }
  await expect.poll(() => fixture.session.policy.isPolicySaving).toBe(false);
  const outcome = structuredClone(
    fixture.session.feedback.actionOutcome("save-policy"),
  );
  expect(outcome?.status).toBe("possibly-applied");
  expect(outcome?.failure?.message).toBe(failure);
  expect(fixture.session.policy.isPolicyDirty).toBe(true);
  expect(fixture.session.policy.getSnapshot().policyDraft).toBe(original);
  expect(fixture.writes).toHaveLength(1);
  const report = page.getByTestId("save-policy-error");
  await expect.element(report).toHaveTextContent(failure);
  await expect.element(report).toBeVisible();
  expect(report.elements()).toHaveLength(1);
  await expect.element(page.getByTestId("policy-save-uncertain")).toBeVisible();
  await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
  await fixture.session.snapshot.refreshSegments(["policy"]);
  await expect.element(page.getByTestId("save-policy")).toBeEnabled();
  await expect.element(page.getByTestId("save-policy-bottom")).toBeEnabled();
  expect(fixture.session.feedback.actionOutcome("save-policy")).toEqual(
    outcome,
  );
  expect(fixture.session.policy.isPolicyDirty).toBe(true);
  expect(fixture.writes).toHaveLength(1);
});

test("feedback: a new publication preread failure replaces the previous uncertain outcome", async () => {
  const fixture = await setup();
  await page.getByTestId("tag-open-tag:observed").click();
  await page.getByTestId("tag-declare").click();
  await page.getByTestId("tag-detail-close").click();
  fixture.failWrite("source unavailable");
  await page.getByTestId("save-policy").click();
  await page.getByTestId("policy-publication-confirm").click();
  await expect.element(page.getByTestId("policy-save-uncertain")).toBeVisible();
  expect(fixture.session.feedback.actionOutcome("save-policy")?.status).toBe(
    "possibly-applied",
  );
  fixture.failRead("/api/v1/policy");
  const preread = Promise.withResolvers<void>();
  fixture.holdRead("/api/v1/policy", preread.promise);
  await page.getByTestId("save-policy").click();
  await page.getByTestId("policy-publication-confirm").click();
  const diagnostic = page.getByTestId("save-policy-error");
  try {
    await expect.poll(() => fixture.session.policy.isPolicySaving).toBe(true);
    await expect.element(diagnostic).not.toBeInTheDocument();
    await expect
      .element(page.getByTestId("policy-save-uncertain"))
      .not.toBeInTheDocument();
  } finally {
    preread.resolve();
  }
  await expect.poll(() => fixture.session.policy.isPolicySaving).toBe(false);
  await expect.element(diagnostic).toHaveTextContent("source unavailable");
  await expect.element(diagnostic).toBeVisible();
  expect(diagnostic.elements()).toHaveLength(1);
  await expect
    .element(page.getByTestId("dialog-save-policy-error"))
    .not.toBeInTheDocument();
  expect(document.querySelectorAll('[data-slot="toast"]')).toHaveLength(0);
  fixture.failRead("");
  await fixture.session.snapshot.refreshSegments(["policy"]);
  expect(
    fixture.session.snapshot.getSnapshot().refreshErrors.policy,
  ).toBeFalsy();
  await expect.element(diagnostic).toBeVisible();
  await fixture.unmount();
  await renderSessionPage(fixture.session, <AccessPage />, "/access");
  await expect.element(diagnostic).toHaveTextContent("source unavailable");
  await expect.element(diagnostic).toBeVisible();
  expect(diagnostic.elements()).toHaveLength(1);
  await expect
    .element(page.getByTestId("dialog-save-policy-error"))
    .not.toBeInTheDocument();
  expect(document.querySelectorAll('[data-slot="toast"]')).toHaveLength(0);
  expect(fixture.session.feedback.actionOutcome("save-policy")?.status).toBe(
    "not-dispatched",
  );
  await expect
    .element(page.getByTestId("policy-save-uncertain"))
    .not.toBeInTheDocument();
  expect(fixture.session.policy.isPolicyDirty).toBe(true);
  await page.getByTestId("save-policy").click();
  await expect
    .element(
      page
        .getByTestId("policy-publication-review")
        .getByText("source unavailable", { exact: true }),
    )
    .toBeVisible();
  await expect
    .element(page.getByTestId("policy-publication-current"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("policy-publication-confirm"))
    .toBeEnabled();
  expect(fixture.writes).toHaveLength(1);
});

test("feedback: a successful read from a retired maintenance view cannot certify inventory or announce failure", async () => {
  const fixture = await setup();
  await fixture.unmount();
  await renderSessionPage(
    fixture.session,
    <AccessTagMaintenance
      tag="tag:server"
      readOnly={false}
      onClose={vi.fn()}
      onEdit={vi.fn()}
      onPrepare={vi.fn()}
    />,
    "/access",
  );
  // The provider restarts after child mount effects; establish this standalone host's current read.
  await expect.poll(() => fixture.session.snapshot.isRefreshing).toBe(false);
  await expect
    .element(page.getByTestId("tag-maintenance-refresh"))
    .toBeEnabled();
  await page.getByTestId("tag-maintenance-refresh").click();
  await expect
    .element(page.getByTestId("tag-inventory-unknown"))
    .not.toBeInTheDocument();
  const pending = Promise.withResolvers<void>();
  fixture.holdRead("/api/v1/user", pending.promise);
  const before = fixture.reads.filter((path) => path === "/api/v1/user").length;
  await page.getByTestId("tag-maintenance-refresh").click();
  await expect
    .poll(() => fixture.reads.filter((path) => path === "/api/v1/user").length)
    .toBeGreaterThan(before);
  fixture.session.drafts.discard();
  pending.resolve();
  await expect
    .element(page.getByTestId("tag-maintenance-refresh"))
    .toBeEnabled();
  await expect.element(page.getByTestId("tag-inventory-unknown")).toBeVisible();
  expect(document.querySelectorAll('[data-slot="toast"]')).toHaveLength(0);
  await page.getByTestId("tag-maintenance-retire").click();
  await expect
    .element(page.getByTestId("tag-retirement-external"))
    .toBeDisabled();
  await page.getByTestId("tag-maintenance-refresh").click();
  await expect
    .element(page.getByTestId("tag-inventory-unknown"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("tag-retirement-external"))
    .toBeEnabled();
  expect(document.querySelectorAll('[data-slot="toast"]')).toHaveLength(0);
  expect(fixture.writes).toEqual([]);
});

// Missing key/reference discovery must not make a dependency look unoccupied or retired.
test("observed names include key-only and non-ACL policy references without treating them as declarations", async () => {
  const fixture = await setup({
    ...baseline,
    ssh: [
      {
        action: "accept",
        src: ["tag:ssh-only"],
        dst: ["tag:server"],
        users: ["root"],
      },
    ],
  });
  expect(
    document.querySelector('[data-testid="tag-card-tag:key-only"]'),
  ).not.toBeNull();
  expect(
    document.querySelector('[data-testid="tag-card-tag:ssh-only"]'),
  ).not.toBeNull();
  expect(fixture.session.policy.policyPayload?.tagOwners).toEqual(
    baseline.tagOwners,
  );
  expect(fixture.writes).toEqual([]);
});

test("creating an observed node name declares an empty owner set instead of rejecting a duplicate", async () => {
  const { session, writes } = await setup();
  await page.getByTestId("new-device-label").click();
  await page.getByTestId("tag-name-input").fill("observed");
  await userEvent.keyboard("{Enter}");
  expect(session.policy.policyPayload?.tagOwners).toHaveProperty(
    "tag:observed",
    [],
  );
  expect(session.snapshot.getSnapshot().snapshot.policy?.policy).not.toContain(
    "tag:observed",
  );
  expect(writes).toEqual([]);
});

test("re-entering an already declared observed name keeps its existing owners and writes nothing", async () => {
  const { session, writes } = await setup({
    ...baseline,
    tagOwners: { ...baseline.tagOwners, "tag:observed": ["alice@"] },
  });
  await page.getByTestId("new-device-label").click();
  await page.getByTestId("tag-name-input").fill("observed");
  await userEvent.keyboard("{Enter}");
  expect(session.policy.policyPayload?.tagOwners).toEqual({
    ...baseline.tagOwners,
    "tag:observed": ["alice@"],
  });
  expect(writes).toEqual([]);
});

test("same-name observed detail can explicitly declare [] without granting network access", async () => {
  const { session, writes } = await setup();
  await page.getByTestId("tag-open-tag:observed").click();
  const declaration = document.querySelector('[data-testid="tag-declare"]');
  expect(declaration).not.toBeNull();
  await page.getByTestId("tag-declare").click();
  expect(session.policy.policyPayload?.tagOwners).toHaveProperty(
    "tag:observed",
    [],
  );
  expect(session.policy.policyPayload?.acls).toEqual(baseline.acls);
  expect(writes).toEqual([]);
});

test("whole-document publication requires reviewing the original raw text and every submitted change", async () => {
  const raw = `{/* keep this operational comment for review */"groups":{"group:ops":["alice@"]},"tagOwners":{"tag:server":[]},"acls":[]}`;
  const { session, writes } = await setup(raw);
  session.policy.commitState(
    parsePolicy(
      '{"groups":{"group:ops":["alice@"]},"tagOwners":{"tag:server":[],"tag:new":[]},"acls":[{"action":"accept","src":["alice@"],"dst":["tag:server:443"]}]}',
    ),
  );
  await page.getByTestId("save-policy").click();
  expect(writes).toEqual([]);
  await expect
    .element(page.getByTestId("policy-publication-review"))
    .toBeVisible();
  expect(
    page.getByTestId("policy-publication-original").element().textContent,
  ).toBe(raw);
  expect(
    page.getByTestId("policy-publication-submitted").element().textContent,
  ).toContain("tag:new");
  expect(
    page.getByTestId("policy-publication-submitted").element().textContent,
  ).toContain("tag:server:443");
  await page.getByTestId("policy-publication-cancel").click();
  expect(session.policy.isPolicyDirty).toBe(true);
  expect(writes).toEqual([]);
});

test("Escape accounts for an invalid unblurred name without publishing or silently dropping it", async () => {
  const { session, writes } = await setup();
  await page.getByTestId("tag-open-tag:server").click();
  await page.getByTestId("tag-name-input").fill("1invalid");
  await userEvent.keyboard("{Escape}");
  expect(session.policy.getSnapshot().tagDetailOpen).toBe(true);
  await expect
    .element(page.getByTestId("unsaved-changes-dialog"))
    .toBeVisible();
  await page.getByTestId("unsaved-changes-save").click();
  expect(writes).toEqual([]);
  await expect.element(page.getByTestId("tag-name-input-error")).toBeVisible();
  expect(session.policy.policyPayload?.tagOwners).toEqual(baseline.tagOwners);
});

test("removing direct ownership keeps and explains remaining group dependencies", async () => {
  const { session, writes } = await setup();
  await page.getByTestId("tag-open-tag:server").click();
  await page.getByTestId("tag-owner-remove-alice@").click();
  expect(session.policy.policyPayload?.tagOwners).toEqual({
    "tag:server": ["group:ops"],
  });
  const dependencies = document.querySelector(
    '[data-testid="tag-owner-dependencies"]',
  );
  expect(dependencies?.textContent ?? "").toContain("group:ops");
  expect(dependencies?.textContent ?? "").toContain("alice@");
  expect(writes).toEqual([]);
});

test("invalid buffered custom ports are not serialized or published", async () => {
  const { session, writes } = await setup();
  await page.getByTestId("tag-open-tag:server").click();
  await page.getByTestId("tag-accessor-custom-group:ops").fill("70000");
  await userEvent.keyboard("{Enter}");
  expect(session.policy.policyPayload?.acls).toEqual(baseline.acls);
  await expect
    .element(page.getByTestId("tag-accessor-custom-group:ops-error"))
    .toBeVisible();
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("unsaved-changes-save").click();
  expect(writes).toEqual([]);
});

test("an uncertain policy write leaves publication available without a manual release or automatic retry", async () => {
  const fixture = await setup();
  fixture.session.policy.commitState(
    parsePolicy('{"acls":[],"tagOwners":{"tag:server":[]}}'),
  );
  fixture.failWrite("saving policy to database: injected late failure");
  await page.getByTestId("save-policy").click();
  await page.getByTestId("policy-publication-confirm").click();
  await expect.poll(() => fixture.writes.length).toBe(1);
  await expect.poll(() => fixture.session.policy.isPolicySaving).toBe(false);
  await expect.element(page.getByTestId("save-policy")).toBeEnabled();
  await expect.element(page.getByTestId("save-policy-bottom")).toBeEnabled();
  await expect
    .element(page.getByTestId("policy-save-uncertain"))
    .toHaveTextContent(getProductCopy("en-US").writeOutcomeVerifyInAccess);
  await expect
    .element(page.getByTestId("policy-pending-release"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("policy-pending-acknowledge"))
    .not.toBeInTheDocument();
  expect(fixture.session.policy.isPolicyDirty).toBe(true);
  await fixture.session.snapshot.refreshSegments(["policy"]);
  expect(fixture.writes).toHaveLength(1);
  fixture.failWrite("");
  await page.getByTestId("save-policy-bottom").click();
  await expect
    .element(page.getByTestId("policy-publication-review"))
    .toBeVisible();
  expect(fixture.writes).toHaveLength(1);
  await page.getByTestId("policy-publication-confirm").click();
  await expect.poll(() => fixture.session.policy.isPolicyDirty).toBe(false);
  expect(fixture.writes).toHaveLength(2);
});

test.each(["replacement", "extra"])(
  "migration shows the full projected tag set after uncertain publication introduces %s",
  async (introduced) => {
    const original = {
      ...baseline,
      tagOwners: {
        ...baseline.tagOwners,
        ...(introduced === "extra" ? { "tag:replacement": [] } : {}),
      },
    };
    const fixture = await setup(original);
    const submitted = JSON.stringify({
      ...original,
      tagOwners: { ...original.tagOwners, [`tag:${introduced}`]: [] },
    });
    fixture.session.policy.commitState(parsePolicy(submitted));
    fixture.failWrite("response lost after policy dispatch");
    await page.getByTestId("save-policy").click();
    await page.getByTestId("policy-publication-confirm").click();
    await expect.poll(() => fixture.session.policy.isPolicySaving).toBe(false);
    expect(fixture.writes).toHaveLength(1);
    const outcome = structuredClone(
      fixture.session.feedback.actionOutcome("save-policy"),
    );
    expect(outcome?.status).toBe("possibly-applied");
    fixture.setPolicy(fixture.writes[0]);
    fixture.setNodes([
      node("1", ["tag:observed", "tag:extra"]),
      node("2", ["tag:observed", "tag:stable"]),
    ]);
    await page.getByTestId("tag-maintenance-tag:observed").click();
    await page.getByTestId("tag-migration-existing").click();
    await page.getByTestId("tag-migration-target").fill("replacement");
    await expect
      .element(page.getByTestId("tag-maintenance-refresh"))
      .toBeEnabled();
    await expect
      .element(page.getByTestId("tag-maintenance-pending"))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByTestId("tag-migration-node-1"))
      .toMatchTextContent("tag:replacement, tag:extra");
    if (introduced === "extra") {
      await expect
        .element(page.getByTestId("tag-migration-node-2"))
        .not.toMatchTextContent(getProductCopy("en-US").policyMigrationPending);
    }
    expect(fixture.session.feedback.actionOutcome("save-policy")).toEqual(
      outcome,
    );
    expect(fixture.writes).toHaveLength(1);
  },
);

test("a key-only occupied migration target cannot be prepared as a new identity", async () => {
  const { session, writes } = await setup();
  expect(
    document.querySelector('[data-testid="tag-maintenance-tag:server"]'),
  ).not.toBeNull();
  await page.getByTestId("tag-maintenance-tag:server").click();
  await page.getByTestId("tag-migration-target").fill("key-only");
  await expect
    .element(page.getByTestId("tag-migration-prepare"))
    .toBeDisabled();
  expect(session.policy.policyPayload?.tagOwners).toEqual(baseline.tagOwners);
  expect(writes).toEqual([]);
});

test("ordinary policy rename cannot bypass current key usage and requires an explicit external review for unused names", async () => {
  const fixture = await setup();
  fixture.setKeys([key("live-key", ["tag:server"])]);
  await page.getByTestId("tag-open-tag:server").click();
  await page.getByTestId("tag-name-input").fill("renamed");
  await userEvent.keyboard("{Enter}");
  expect(fixture.session.policy.policyPayload?.tagOwners).toHaveProperty(
    "tag:server",
  );
  expect(fixture.session.policy.policyPayload?.tagOwners).not.toHaveProperty(
    "tag:renamed",
  );
  expect(
    fixture.reads.filter((path) => path === "/api/v1/preauthkey").length,
  ).toBeGreaterThan(1);
  expect(fixture.writes).toEqual([]);
});

test("team membership changes locate client-owner dependencies separately from network access", async () => {
  const { session, writes } = await setup({
    ...baseline,
    acls: [],
    tagOwners: { "tag:server": ["group:ops"], "tag:nested": ["tag:server"] },
  });
  await page.getByTestId("team-card-group:ops").click();
  await page.getByTestId("team-member-remove-alice@").click();
  const dependencies = document.querySelector(
    '[data-testid="team-owner-dependencies"]',
  );
  expect(dependencies?.textContent ?? "").toContain("tag:server");
  expect(dependencies?.textContent ?? "").toContain("tag:nested");
  expect(session.policy.policyPayload?.tagOwners).toEqual({
    "tag:server": ["group:ops"],
    "tag:nested": ["tag:server"],
  });
  expect(writes).toEqual([]);
});

function deviceReturn(session: Session, managedTag: string) {
  session.tagLifecycle.saveReturn({
    source: "device",
    managedTag,
    nodeId: "1",
    editVersion: 1,
    tags: ["tag:observed", "tag:extra"],
    baseline: {
      nodeId: "1",
      machineKey: null,
      user: null,
      tags: ["tag:observed", "tag:extra"],
    },
  });
}

test("device-origin declaration rejects a policy-only compatible name without silently lowercasing it", async () => {
  const { session, writes } = await setup(baseline, (session) =>
    deviceReturn(session, "tag:Web1"),
  );
  await expect.element(page.getByTestId("tag-name-input")).toHaveValue("Web1");
  await expect.element(page.getByTestId("tag-declare")).toBeDisabled();
  await expect
    .element(page.getByTestId("tag-compatible-replacement"))
    .toBeVisible();
  await expect
    .element(page.getByTestId("tag-detail-dialog"))
    .toMatchTextContent(getProductCopy("en-US").policyManagementIncompatible);
  expect(session.policy.policyPayload?.tagOwners).not.toHaveProperty(
    "tag:Web1",
  );
  expect(session.policy.policyPayload?.tagOwners).not.toHaveProperty(
    "tag:web1",
  );
  expect(writes).toEqual([]);
});

test("ordinary Access declaration still supports policy-compatible case-sensitive names", async () => {
  const { session } = await setup();
  await page.getByTestId("new-device-label").click();
  await page.getByTestId("tag-name-input").fill("Web1");
  await userEvent.keyboard("{Enter}");
  expect(session.policy.policyPayload?.tagOwners).toHaveProperty(
    "tag:Web1",
    [],
  );
  expect(session.policy.policyPayload?.tagOwners).not.toHaveProperty(
    "tag:web1",
  );
});

test("observed definitions distinguish local additions changes and removals from readback", async () => {
  const { session } = await setup();
  session.policy.commitState(
    parsePolicy(
      JSON.stringify({
        ...baseline,
        tagOwners: { "tag:new": [], "tag:server": [] },
      }),
    ),
  );
  await expect
    .element(page.getByTestId("tag-draft-state-tag:new"))
    .toHaveAttribute("data-state", "added");
  await expect
    .element(page.getByTestId("tag-draft-state-tag:server"))
    .toHaveAttribute("data-state", "changed");
  session.policy.commitState(
    parsePolicy(JSON.stringify({ ...baseline, tagOwners: {} })),
  );
  await expect
    .element(page.getByTestId("tag-draft-state-tag:server"))
    .toHaveAttribute("data-state", "removed");
  expect(session.snapshot.getSnapshot().snapshot.policy?.policy).toBe(
    JSON.stringify(baseline),
  );
});

test.each([
  ["", "implicit"],
  ["{}", "implicit"],
  ['{"acls":[]}', "explicit"],
  ['{"grants":[]}', "explicit"],
])(
  "declaring [] preserves and explains the access baseline for %s",
  async (raw, mode) => {
    const { session, writes } = await setup(raw);
    await expect
      .element(page.getByTestId("policy-access-baseline"))
      .toHaveAttribute("data-mode", mode);
    await page.getByTestId("tag-open-tag:observed").click();
    await page.getByTestId("tag-declare").click();
    expect(session.policy.policyPayload?.acls).toEqual(
      mode === "implicit"
        ? [
            {
              action: "accept",
              src: ["0.0.0.0/0", "::/0"],
              dst: ["0.0.0.0/0:*"],
            },
            { action: "accept", src: ["0.0.0.0/0", "::/0"], dst: ["::/0:*"] },
          ]
        : [],
    );
    if (raw.includes("grants"))
      expect(session.policy.policyPayload?.grants).toEqual([]);
    expect(writes).toEqual([]);
  },
);

test("existing-target migration reviews actual full policy and keeps every unrelated tag without merging ACLs or owners", async () => {
  const raw = {
    ...baseline,
    tagOwners: { ...baseline.tagOwners, "tag:target": ["bob@"] },
    ssh: [
      {
        action: "accept",
        src: ["tag:target"],
        dst: ["tag:server"],
        users: ["root"],
      },
    ],
    autoApprovers: { routes: { "10.0.0.0/8": ["tag:target"] } },
  };
  const fixture = await setup(raw);
  fixture.setNodes([node("1", ["tag:server", "tag:extra"])]);
  await page.getByTestId("tag-maintenance-tag:server").click();
  await page.getByTestId("tag-migration-existing").click();
  await page.getByTestId("tag-migration-target").fill("target");
  await expect
    .element(page.getByTestId("tag-migration-node-1"))
    .toMatchTextContent("tag:target, tag:extra");
  expect(
    document.querySelector('[data-testid="tag-maintenance-policy"]')
      ?.textContent ?? "",
  ).toContain("10.0.0.0/8");
  expect(
    page.getByTestId("tag-maintenance-policy").element().textContent,
  ).toContain("root");
  expect(fixture.session.policy.policyPayload?.tagOwners).toEqual(
    raw.tagOwners,
  );
  expect(fixture.session.policy.policyPayload?.acls).toEqual(baseline.acls);
  expect(fixture.writes).toEqual([]);
});

test("a live key-only source cannot retire and expired keys still require external deployment verification", async () => {
  const fixture = await setup();
  await page.getByTestId("tag-maintenance-tag:key-only").click();
  await page.getByTestId("tag-maintenance-retire").click();
  await expect
    .element(page.getByTestId("tag-retirement-external"))
    .toBeEnabled();
  await page.getByTestId("tag-retirement-external").click();
  const copy = getProductCopy("en-US");
  await expect
    .element(page.getByTestId("tag-retirement-result"))
    .toHaveTextContent(copy.policyRetirementBlocked);
  fixture.setKeys([
    normalizePreAuthKey({
      id: "key-1",
      key: "",
      aclTags: ["tag:key-only"],
      expiration: "2000-01-01T00:00:00Z",
      reusable: true,
    }),
  ]);
  await page.getByTestId("tag-maintenance-refresh").click();
  await expect
    .element(page.getByTestId("tag-retirement-external"))
    .not.toBeChecked();
  await expect
    .element(page.getByTestId("tag-retirement-external"))
    .toBeEnabled();
  await expect
    .element(page.getByTestId("tag-retirement-result"))
    .toHaveTextContent(copy.policyRetirementBlocked);
  await page.getByTestId("tag-retirement-external").click();
  await expect
    .element(page.getByTestId("tag-retirement-result"))
    .toHaveTextContent(copy.policyRetirementObserved);
  expect(fixture.writes).toEqual([]);
});

test("maintenance drops a vanished source inventory and still requires a fresh external retirement check", async () => {
  const fixture = await setup();
  await page.getByTestId("tag-maintenance-tag:key-only").click();
  const sourceKey = page.getByTestId("tag-maintenance-key-key-1");
  await expect.element(sourceKey).toBeVisible();
  await page.getByTestId("tag-maintenance-retire").click();
  const external = page.getByTestId("tag-retirement-external");
  await expect.element(external).toBeEnabled();
  await external.click();
  const result = page.getByTestId("tag-retirement-result");
  const copy = getProductCopy("en-US");
  await expect.element(result).toHaveTextContent(copy.policyRetirementBlocked);
  fixture.setKeys([]);
  await page.getByTestId("tag-maintenance-refresh").click();
  await expect.element(external).toBeEnabled();
  await expect.element(sourceKey).not.toBeInTheDocument();
  await expect.element(external).not.toBeChecked();
  await expect.element(result).toHaveTextContent(copy.policyRetirementBlocked);
  await external.click();
  await expect.element(result).toHaveTextContent(copy.policyRetirementObserved);
  expect(fixture.writes).toEqual([]);
  expect(fixture.stoppedKeys).toEqual([]);
});

test("explicit policy-only removal lists live resources but never changes their node or key tags", async () => {
  const fixture = await setup();
  fixture.setNodes([node("1", ["tag:server", "tag:extra"])]);
  fixture.setKeys([key("active-key", ["tag:server"])]);
  await page.getByTestId("tag-remove-tag:server").click();
  await expect
    .element(page.getByTestId("confirm-remove-policy-item"))
    .toBeEnabled();
  await expect
    .element(page.getByTestId("policy-removal-inventory"))
    .toMatchTextContent("active-key");
  await page.getByTestId("confirm-remove-policy-item").click();
  expect(fixture.session.policy.policyPayload?.tagOwners).not.toHaveProperty(
    "tag:server",
  );
  expect(fixture.session.snapshot.getSnapshot().snapshot.nodes[0].tags).toEqual(
    ["tag:server", "tag:extra"],
  );
  expect(
    fixture.session.snapshot.getSnapshot().snapshot.preAuthKeys[0].aclTags,
  ).toEqual(["tag:server"]);
  expect(fixture.writes).toEqual([]);
});

test("matching readback preserves newer local edits and the uncertain outcome without locking publication", async () => {
  const fixture = await setup();
  fixture.session.policy.commitState(
    parsePolicy('{"acls":[],"tagOwners":{"tag:server":[]}}'),
  );
  fixture.failWrite("saving policy to database: injected late failure");
  await page.getByTestId("save-policy").click();
  await page.getByTestId("policy-publication-confirm").click();
  await expect.element(page.getByTestId("policy-save-uncertain")).toBeVisible();
  const original = structuredClone(
    fixture.session.feedback.actionOutcome("save-policy"),
  );
  fixture.setPolicy(fixture.writes[0]);
  fixture.session.policy.commitState(
    parsePolicy('{"acls":[],"tagOwners":{"tag:server":[],"tag:newer":[]}}'),
  );
  await fixture.session.snapshot.refreshSegments(["policy"]);
  await expect.element(page.getByTestId("save-policy")).toBeEnabled();
  expect(fixture.session.feedback.actionOutcome("save-policy")).toEqual(
    original,
  );
  expect(fixture.session.policy.policyPayload?.tagOwners).toHaveProperty(
    "tag:newer",
  );
  expect(fixture.session.policy.isPolicyDirty).toBe(true);
  expect(fixture.writes).toHaveLength(1);
});

test("management return preserves an existing ACL draft and never automatically publishes or applies source inputs", async () => {
  const fixture = await setup(baseline, (session) => {
    session.policy.commitState(
      parsePolicy(
        JSON.stringify({
          ...baseline,
          acls: [{ action: "accept", src: ["bob@"], dst: ["tag:server:443"] }],
        }),
      ),
    );
    deviceReturn(session, "tag:observed");
  });
  await expect
    .element(page.getByTestId("tag-name-input"))
    .toHaveValue("observed");
  await page.getByTestId("tag-declare").click();
  await page.getByTestId("tag-management-return").click();
  await expect
    .poll(() => fixture.router.state.location.pathname)
    .toBe("/devices");
  expect(fixture.session.policy.policyPayload?.acls).toEqual([
    { action: "accept", src: ["bob@"], dst: ["tag:server:443"] },
  ]);
  expect(fixture.session.tagLifecycle.getSnapshot().returnTo?.status).toBe(
    "returning",
  );
  expect(fixture.session.tagLifecycle.getSnapshot().returnTo?.source).toBe(
    "device",
  );
  expect(fixture.writes).toEqual([]);
});

test("an unreadable policy retains a usable return action and read-only inventory without inert owner edit controls", async () => {
  const fixture = await setup('{"acls":[', (session) =>
    deviceReturn(session, "tag:observed"),
  );
  await page.getByTestId("tag-maintenance-tag:observed").click();
  await page.getByTestId("tag-maintenance-stop").click();
  await expect
    .element(page.getByTestId("tag-stop-review-owners"))
    .toBeDisabled();
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("tag-management-return").click();
  await expect
    .poll(() => fixture.router.state.location.pathname)
    .toBe("/devices");
  expect(fixture.writes).toEqual([]);
});

test("ordinary unused rename requires external acknowledgement and rechecks inventory before keeping the draft", async () => {
  const fixture = await setup();
  await page.getByTestId("tag-open-tag:server").click();
  await page.getByTestId("tag-name-input").fill("replacement");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("tag-rename-review")).toBeVisible();
  await expect.element(page.getByTestId("tag-rename-confirm")).toBeDisabled();
  await page.getByTestId("tag-rename-external").click();
  fixture.setKeys([key("late-key", ["tag:server"])]);
  await page.getByTestId("tag-rename-confirm").click();
  await expect.poll(() => fixture.session.snapshot.isRefreshing).toBe(false);
  expect(fixture.session.policy.policyPayload?.tagOwners).toHaveProperty(
    "tag:server",
  );
  expect(fixture.session.policy.policyPayload?.tagOwners).not.toHaveProperty(
    "tag:replacement",
  );
  expect(fixture.writes).toEqual([]);
});

test("a version ABA retires an open publication review even when React observes the same version text", async () => {
  const fixture = await setup();
  fixture.session.policy.commitState(
    parsePolicy('{"acls":[],"tagOwners":{"tag:new":[]}}'),
  );
  await page.getByTestId("save-policy").click();
  await expect
    .element(page.getByTestId("policy-publication-review"))
    .toBeVisible();
  fixture.session.snapshot.applyPatch({ version: { version: "0.29.5" } });
  fixture.session.snapshot.applyPatch({ version: { version: "0.29.4" } });
  await expect
    .element(page.getByTestId("policy-publication-review"))
    .not.toBeInTheDocument();
  expect(fixture.writes).toEqual([]);
  expect(fixture.session.policy.isPolicyDirty).toBe(true);
});

test("generic management return opens the observation list rather than an empty tag editor", async () => {
  const fixture = await setup(baseline, (session) => deviceReturn(session, ""));
  await expect
    .element(page.getByTestId("tag-management-context"))
    .toBeVisible();
  expect(fixture.session.policy.getSnapshot().tagDetailOpen).toBe(false);
  expect(
    page.getByTestId("tag-management-context").element().textContent,
  ).toContain("1");
  await page.getByTestId("tag-open-tag:observed").click();
  await expect
    .element(page.getByTestId("tag-name-input"))
    .toHaveValue("observed");
  expect(fixture.writes).toEqual([]);
});

test("management return cannot drop an invalid buffered name", async () => {
  const fixture = await setup(baseline, (session) =>
    deviceReturn(session, "tag:server"),
  );
  await page.getByTestId("tag-name-input").fill("1invalid");
  await page.getByTestId("tag-management-return").click();
  expect(fixture.router.state.location.pathname).toBe("/access");
  await expect
    .element(page.getByTestId("tag-name-input"))
    .toHaveValue("1invalid");
  await expect.element(page.getByTestId("tag-name-input-error")).toBeVisible();
  expect(fixture.session.tagLifecycle.getSnapshot().returnTo?.status).toBe(
    "managing",
  );
  expect(fixture.writes).toEqual([]);
});

test.each([
  { field: "tag-name-input", value: "1invalid", valid: false },
  { field: "tag-name-input", value: " server ", valid: true },
  { field: "tag-accessor-custom-group:ops", value: "70000", valid: false },
  { field: "tag-accessor-custom-group:ops", value: "8443", valid: true },
])(
  "history back protects unblurred $field ($value) with keep and discard choices",
  async ({ field, value, valid }) => {
    const fixture = await setup(baseline, undefined, true);
    await fixture.router.navigate({ to: "/devices" });
    deviceReturn(fixture.session, "tag:server");
    await fixture.router.navigate({ to: "/access" });
    await page.getByTestId(field).fill(value);
    fixture.router.history.back();
    await expect
      .element(page.getByTestId("unsaved-changes-dialog"))
      .toBeVisible();
    expect(fixture.router.state.location.pathname).toBe("/access");
    expect(fixture.writes).toEqual([]);
    if (!valid) {
      await page.getByTestId("unsaved-changes-keep-editing").click();
      await expect.element(page.getByTestId(field)).toHaveValue(value);
      fixture.router.history.back();
    }
    await page.getByTestId("unsaved-changes-keep-draft").click();
    if (valid) {
      await expect
        .poll(() => fixture.router.state.location.pathname)
        .toBe("/devices");
      if (field.includes("custom"))
        expect(fixture.session.policy.policyPayload?.acls).toEqual([
          { action: "accept", src: ["group:ops"], dst: ["tag:server:22,8443"] },
        ]);
    } else {
      expect(fixture.router.state.location.pathname).toBe("/access");
      await expect.element(page.getByTestId(`${field}-error`)).toBeVisible();
      await expect.element(page.getByTestId(field)).toHaveValue(value);
      fixture.router.history.back();
      await page.getByTestId("unsaved-changes-discard").click();
      await expect
        .poll(() => fixture.router.state.location.pathname)
        .toBe("/devices");
      expect(fixture.session.policy.policyPayload?.acls).toEqual(baseline.acls);
    }
    expect(fixture.writes).toEqual([]);
  },
);

test("an uncertain key creation does not reserve an absent migration identity", async () => {
  const fixture = await setup();
  fixture.setKeys([]);
  fixture.session.feedback.setActionOutcome("create-invite", {
    status: "unknown",
    refresh: "succeeded",
  });
  await page.getByTestId("tag-maintenance-tag:server").click();
  await page.getByTestId("tag-migration-target").fill("replacement");
  await expect.poll(() => fixture.session.snapshot.isRefreshing).toBe(false);
  expect(fixture.session.snapshot.getSnapshot().snapshot.preAuthKeys).toEqual(
    [],
  );
  await expect.element(page.getByTestId("tag-migration-prepare")).toBeEnabled();
  await expect
    .element(page.getByTestId("tag-maintenance-pending"))
    .not.toBeInTheDocument();
  expect(fixture.writes).toEqual([]);
});

test.each(["expirePreAuthKey", "deletePreAuthKey"] as const)(
  "%s response loss leaves retirement based on fresh inventory without a release step or replay",
  async (endpoint) => {
    const fixture = await setup('{"acls":[]}', undefined, true);
    fixture.setNodes([]);
    fixture.setKeys([
      key("pending-key", ["tag:old"]),
      { ...key("old-marker", ["tag:old"]), expiration: "2000-01-01T00:00:00Z" },
    ]);
    expect(
      await fixture.session.snapshot.refreshSegments(["fabric", "identity"]),
    ).toBe(true);
    const result = await createMutation(fixture.session).mutateDetailed(
      "invite-action",
      {
        endpoint,
        input: { id: "pending-key" },
      },
    );
    expect(result.outcome).toMatchObject({
      status: "unknown",
      refresh: "succeeded",
    });
    const observed = fixture.session.snapshot
      .getSnapshot()
      .snapshot.preAuthKeys.find((entry) => entry.id === "pending-key");
    if (endpoint === "deletePreAuthKey") expect(observed).toBeUndefined();
    else expect(observed?.expiration).toBe("2000-01-01T00:00:00Z");
    const outcome = structuredClone(
      fixture.session.feedback.actionOutcome("invite-action"),
    );
    for (let visit = 0; visit < 2; visit++) {
      await page.getByTestId("tag-maintenance-tag:old").click();
      await page.getByTestId("tag-maintenance-retire").click();
      await expect
        .element(page.getByTestId("tag-retirement-external"))
        .toBeEnabled();
      await page.getByTestId("tag-retirement-external").click();
      await expect
        .element(page.getByTestId("tag-retirement-result"))
        .toHaveTextContent(getProductCopy("en-US").policyRetirementObserved);
      await expect
        .element(page.getByTestId("tag-maintenance-pending"))
        .not.toBeInTheDocument();
      await page.getByTestId("maintenance-invites-tag:old").click();
      await expect
        .poll(() => fixture.router.state.location.pathname)
        .toBe("/invites");
      expect(fixture.router.state.location.search).toMatchObject({
        tag: "tag:old",
      });
      await fixture.router.navigate({ to: "/access" });
    }
    expect(fixture.session.feedback.actionOutcome("invite-action")).toEqual(
      outcome,
    );
    expect(fixture.stoppedKeys).toHaveLength(1);
    expect(fixture.writes).toEqual([]);
  },
);

test("an uncertain key stop does not reserve an absent migration target or replay the stop", async () => {
  const fixture = await setup();
  fixture.setKeys([key("pending-key", ["tag:replacement"])]);
  expect(await fixture.session.snapshot.refreshSegments(["identity"])).toBe(
    true,
  );
  const result = await createMutation(fixture.session).mutateDetailed(
    "invite-action",
    {
      endpoint: "deletePreAuthKey",
      input: { id: "pending-key" },
    },
  );
  expect(result.outcome.status).toBe("unknown");
  expect(fixture.session.snapshot.getSnapshot().snapshot.preAuthKeys).toEqual(
    [],
  );
  await page.getByTestId("tag-maintenance-tag:server").click();
  await page.getByTestId("tag-migration-target").fill("replacement");
  await expect
    .element(page.getByTestId("tag-maintenance-refresh"))
    .toBeEnabled();
  await expect.element(page.getByTestId("tag-migration-prepare")).toBeEnabled();
  await expect
    .element(page.getByTestId("tag-maintenance-pending"))
    .not.toBeInTheDocument();
  await page.getByTestId("tag-maintenance-refresh").click();
  await expect.element(page.getByTestId("tag-migration-prepare")).toBeEnabled();
  expect(fixture.stoppedKeys).toHaveLength(1);
  expect(fixture.writes).toEqual([]);
});

test("full-document review preserves and explicitly warns about unmodeled reference locations", async () => {
  const raw = { ...baseline, future: { audience: "tag:server" } };
  const fixture = await setup(raw);
  fixture.session.policy.commitState(
    parsePolicy(
      JSON.stringify({
        ...raw,
        tagOwners: { ...baseline.tagOwners, "tag:new": [] },
      }),
    ),
  );
  await page.getByTestId("save-policy").click();
  expect(
    document.querySelector('[data-testid="policy-publication-unmodeled"]')
      ?.textContent ?? "",
  ).toContain("future");
  expect(
    page.getByTestId("policy-publication-submitted").element().textContent,
  ).toContain('"audience": "tag:server"');
  expect(fixture.writes).toEqual([]);
});

test("a failed dependency read blocks automatic policy removal instead of treating stale resources as zero", async () => {
  const fixture = await setup();
  fixture.failRead("/api/v1/preauthkey");
  await page.getByTestId("tag-remove-tag:server").click();
  await expect.poll(() => fixture.session.snapshot.isRefreshing).toBe(false);
  await expect
    .element(page.getByTestId("confirm-remove-policy-item"))
    .toBeDisabled();
  expect(fixture.session.policy.policyPayload?.tagOwners).toEqual(
    baseline.tagOwners,
  );
  expect(fixture.writes).toEqual([]);
});

test("a fresh migration definition is only a draft and is not an existing server target", async () => {
  const fixture = await setup();
  await page.getByTestId("tag-maintenance-tag:server").click();
  await page.getByTestId("tag-migration-target").fill("replacement");
  await expect.element(page.getByTestId("tag-migration-prepare")).toBeEnabled();
  await page.getByTestId("tag-migration-prepare").click();
  await expect
    .element(page.getByTestId("tag-name-input"))
    .toHaveValue("replacement");
  expect(fixture.session.policy.policyPayload?.tagOwners).toEqual({
    ...baseline.tagOwners,
    "tag:replacement": [],
  });
  expect(fixture.session.policy.policyPayload?.acls).toEqual(baseline.acls);
  await page.getByTestId("tag-detail-close").click();
  await page.getByTestId("tag-maintenance-tag:server").click();
  await page.getByTestId("tag-migration-existing").click();
  await page.getByTestId("tag-migration-target").fill("replacement");
  await expect
    .element(page.getByTestId("tag-migration-target-error"))
    .toBeVisible();
  expect(fixture.session.snapshot.getSnapshot().snapshot.policy?.policy).toBe(
    JSON.stringify(baseline),
  );
  await page.getByTestId("tag-migration-new").click();
  await expect
    .element(page.getByTestId("tag-migration-prepare"))
    .toBeDisabled();
  expect(fixture.writes).toEqual([]);
});

test("stop entrances and existing-target review open the requested owner editor without merging policy", async () => {
  const raw = {
    ...baseline,
    tagOwners: { ...baseline.tagOwners, "tag:target": ["bob@"] },
  };
  const fixture = await setup(raw);
  await page.getByTestId("tag-maintenance-tag:server").click();
  await page.getByTestId("tag-maintenance-stop").click();
  await expect
    .element(page.getByTestId("tag-stop-entrances"))
    .toMatchTextContent("group:ops");
  await page.getByTestId("tag-stop-review-owners").click();
  await expect
    .element(page.getByTestId("tag-name-input"))
    .toHaveValue("server");
  await page.getByTestId("tag-detail-close").click();
  await page.getByTestId("tag-maintenance-tag:server").click();
  await page.getByTestId("tag-maintenance-retire").click();
  await page.getByTestId("tag-maintenance-migrate").click();
  await page.getByTestId("tag-migration-existing").click();
  await page.getByTestId("tag-migration-target").fill("target");
  await page
    .getByTestId("tag-migration-target-inventory")
    .getByRole("button")
    .click();
  await expect
    .element(page.getByTestId("tag-name-input"))
    .toHaveValue("target");
  expect(fixture.session.policy.policyPayload?.tagOwners).toEqual(
    raw.tagOwners,
  );
  expect(fixture.session.policy.policyPayload?.acls).toEqual(raw.acls);
  expect(fixture.writes).toEqual([]);
});

test.each(["node", "invites", "card invites"] as const)(
  "inventory %s links carry the exact non-secret resource destination",
  async (destination) => {
    const fixture = await setup();
    if (destination === "card invites") {
      await page.getByTestId("tag-invites-tag:key-only").click();
    } else {
      await page.getByTestId("tag-maintenance-tag:observed").click();
      if (destination === "node")
        await page.getByTestId("tag-migration-open-node-1").click();
      else await page.getByTestId("maintenance-invites-tag:observed").click();
    }
    await expect
      .poll(() => fixture.router.state.location.pathname)
      .toBe(destination === "node" ? "/devices" : "/invites");
    expect(fixture.router.state.location.search).toMatchObject(
      destination === "node"
        ? {
            node: "1",
            popup: "tags",
            from: "access",
            maintenance: "tag:observed",
          }
        : {
            tag:
              destination === "card invites" ? "tag:key-only" : "tag:observed",
          },
    );
    expect(fixture.writes).toEqual([]);
  },
);

test("a failed maintenance refresh disables fresh-target preparation without erasing old inventory", async () => {
  const fixture = await setup();
  fixture.failRead("/api/v1/preauthkey");
  await page.getByTestId("tag-maintenance-tag:server").click();
  await page.getByTestId("tag-migration-target").fill("replacement");
  await expect
    .element(page.getByTestId("tag-maintenance-refresh"))
    .toBeEnabled();
  await expect
    .element(page.getByTestId("tag-migration-prepare"))
    .toBeDisabled();
  await expect.element(page.getByTestId("tag-inventory-unknown")).toBeVisible();
  expect(
    fixture.session.snapshot.getSnapshot().snapshot.preAuthKeys,
  ).toHaveLength(2);
  expect(fixture.writes).toEqual([]);
});

test("closing maintenance while inventory is pending cannot reopen it or prepare a target", async () => {
  const fixture = await setup();
  const read = Promise.withResolvers<void>();
  fixture.holdRead("/api/v1/preauthkey", read.promise);
  await page.getByTestId("tag-maintenance-tag:server").click();
  await expect
    .element(page.getByTestId("tag-maintenance-refresh"))
    .toBeDisabled();
  await userEvent.keyboard("{Escape}");
  read.resolve();
  await expect.poll(() => fixture.session.snapshot.isRefreshing).toBe(false);
  await expect
    .element(page.getByTestId("tag-maintenance-dialog"))
    .not.toBeInTheDocument();
  expect(fixture.session.policy.policyPayload?.tagOwners).toEqual(
    baseline.tagOwners,
  );
  expect(fixture.writes).toEqual([]);
});

test.each([
  { source: "invite", destination: "/invites" },
  { source: "member-invite", destination: "/members" },
  { source: "setup", destination: "/devices" },
] as const)(
  "$source management returns only to its fixed source route",
  async ({ source, destination }) => {
    const fixture = await setup(baseline, (session) => {
      const form = {
        userId: "1",
        userName: "alice",
        tags: ["tag:server"],
        tagInput: "pending",
        reusable: false,
        ephemeral: false,
        expiration: "2099-01-01T00:00:00Z",
        expirationMode: "preset",
        expiryDays: "7",
      } as const;
      const common = {
        managedTag: "",
        editVersion: 1,
        form: { ...form, tags: [...form.tags] },
      };
      session.tagLifecycle.saveReturn(
        source === "setup"
          ? {
              ...common,
              source,
              task: "server",
              step: "preferences",
              advertiseExitNode: false,
              loginServer: "https://headscale.test",
            }
          : {
              ...common,
              source,
              memberId: source === "member-invite" ? "1" : undefined,
            },
      );
    });
    await expect
      .element(page.getByTestId("tag-management-context"))
      .toBeVisible();
    await page.getByTestId("tag-management-return").click();
    await expect
      .poll(() => fixture.router.state.location.pathname)
      .toBe(destination);
    expect(fixture.session.tagLifecycle.getSnapshot().returnTo?.status).toBe(
      "returning",
    );
    expect(fixture.session.tagLifecycle.getSnapshot().returnTo?.source).toBe(
      source,
    );
    expect(fixture.writes).toEqual([]);
  },
);

test.each([
  { value: "bad name", valid: false },
  { value: " ops ", valid: true },
])(
  "in-app navigation protects the unblurred team name $value",
  async ({ value, valid }) => {
    const fixture = await setup(baseline, undefined, true);
    await page.getByTestId("team-card-group:ops").click();
    await page.getByTestId("team-name-input").fill(value);
    const leaving = fixture.router.navigate({ to: "/members" });
    await expect
      .element(page.getByTestId("unsaved-changes-dialog"))
      .toBeVisible();
    expect(fixture.router.state.location.pathname).toBe("/access");
    await page.getByTestId("unsaved-changes-keep-draft").click();
    if (!valid) {
      await expect
        .element(page.getByTestId("team-name-input-error"))
        .toBeVisible();
      expect(fixture.router.state.location.pathname).toBe("/access");
      void fixture.router.navigate({ to: "/members" });
      await page.getByTestId("unsaved-changes-discard").click();
    }
    await leaving;
    await expect
      .poll(() => fixture.router.state.location.pathname)
      .toBe("/members");
    expect(fixture.session.policy.policyPayload?.groups).toEqual(
      baseline.groups,
    );
    expect(fixture.writes).toEqual([]);
  },
);

test("management return validates a buffered team name before preserving its draft", async () => {
  const fixture = await setup(baseline, (session) => deviceReturn(session, ""));
  await page.getByTestId("team-card-group:ops").click();
  await page.getByTestId("team-name-input").fill("bad name");
  await page.getByTestId("tag-management-return").click();
  expect(fixture.router.state.location.pathname).toBe("/access");
  await expect.element(page.getByTestId("team-name-input-error")).toBeVisible();
  await page.getByTestId("team-name-input").fill("platform");
  await page.getByTestId("tag-management-return").click();
  await expect
    .poll(() => fixture.router.state.location.pathname)
    .toBe("/devices");
  expect(fixture.session.policy.policyPayload?.groups).toHaveProperty(
    "group:platform",
    ["alice@"],
  );
  expect(fixture.writes).toEqual([]);
});

test("device-origin creation validates the unchanged case-sensitive SetTags contract", async () => {
  const fixture = await setup(baseline, (session) => deviceReturn(session, ""));
  await page.getByTestId("new-device-label").click();
  await page.getByTestId("tag-name-input").fill("Web2");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByTestId("tag-name-input-error"))
    .toHaveTextContent(getProductCopy("en-US").policyManagementIncompatible);
  expect(fixture.session.policy.policyPayload?.tagOwners).not.toHaveProperty(
    "tag:Web2",
  );
  expect(fixture.session.policy.policyPayload?.tagOwners).not.toHaveProperty(
    "tag:web2",
  );
  expect(fixture.writes).toEqual([]);
});

test("nonnumeric custom ports remain invalid buffers and cannot be included in publication", async () => {
  const fixture = await setup();
  await page.getByTestId("tag-open-tag:server").click();
  await page.getByTestId("tag-accessor-custom-group:ops").fill("ssh");
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("unsaved-changes-save").click();
  await expect
    .element(page.getByTestId("tag-accessor-custom-group:ops-error"))
    .toBeVisible();
  expect(fixture.session.policy.policyPayload?.acls).toEqual(baseline.acls);
  expect(fixture.writes).toEqual([]);
});

test.each([
  { locale: "en-US", mode: "migrate" },
  { locale: "en-US", mode: "stop" },
  { locale: "en-US", mode: "retire" },
  { locale: "ar", mode: "migrate" },
  { locale: "ar", mode: "stop" },
  { locale: "ar", mode: "retire" },
] as const)(
  "maintenance $mode actions fit a narrow $locale viewport without horizontal clipping",
  async ({ locale, mode }) => {
    await setup();
    await setLocale(locale);
    await page.viewport(375, 812);
    await page.getByTestId("tag-maintenance-tag:server").click();
    await page.getByTestId(`tag-maintenance-${mode}`).click();
    await expect
      .element(page.getByTestId("tag-maintenance-refresh"))
      .toBeEnabled();
    if (mode === "migrate") {
      await page.getByTestId("tag-migration-target").fill("replacement");
      await expect
        .element(page.getByTestId("tag-migration-prepare"))
        .toBeEnabled();
    }
    const dialog = page
      .getByTestId("tag-maintenance-dialog")
      .element() as HTMLElement;
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
  },
);

test.each(["en-US", "ar"] as const)(
  "long publication review remains scrollable and confirmable at 375px in %s",
  async (locale) => {
    const session = await prepareTestSession();
    await setLocale(locale);
    await page.viewport(375, 640);
    const confirm = vi.fn();
    await render(
      <SessionTestProviders session={session}>
        <AccessPolicyReview
          original={JSON.stringify(baseline, null, 2)}
          submitted={JSON.stringify(
            { ...baseline, hosts: { office: "10.0.0.0/8" } },
            null,
            2,
          )}
          issues={["future.audience"]}
          disabled={false}
          onConfirm={confirm}
          onCancel={vi.fn()}
        />
      </SessionTestProviders>,
    );
    const dialog = page.getByTestId("policy-publication-review").element();
    await expect
      .poll(() =>
        dialog
          .getAnimations({ subtree: true })
          .some((animation) => animation.playState === "running"),
      )
      .toBe(false);
    const rect = dialog.getBoundingClientRect();
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
    await page.getByTestId("policy-publication-confirm").click();
    expect(confirm).toHaveBeenCalledOnce();
  },
);

function ReviewHarness() {
  const [open, setOpen] = useState(true);
  return open ? (
    <AccessPolicyReview
      original="{/* original */}"
      submitted='{"acls":[]}'
      disabled={false}
      onConfirm={() => setOpen(false)}
      onCancel={() => setOpen(false)}
    />
  ) : (
    <p data-testid="publication-closed">Review closed</p>
  );
}

test("standalone publication review accepts no reference issues and closes only by explicit cancellation", async () => {
  const session = await prepareTestSession();
  await setLocale("en-US");
  await render(
    <SessionTestProviders session={session}>
      <ReviewHarness />
    </SessionTestProviders>,
  );
  await expect
    .element(page.getByTestId("policy-publication-review"))
    .toBeVisible();
  expect(
    page.getByTestId("policy-publication-original").element().textContent,
  ).toBe("{/* original */}");
  await expect
    .element(page.getByTestId("policy-publication-unmodeled"))
    .not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("publication-closed")).toBeVisible();
});

test("an incompatible observed name opens replacement maintenance rather than declaring or normalizing itself", async () => {
  const fixture = await setup();
  await page.getByTestId("tag-open-tag:1abc").click();
  await page.getByTestId("tag-compatible-replacement").click();
  await expect
    .element(page.getByTestId("tag-maintenance-dialog"))
    .toBeVisible();
  await expect
    .element(page.getByTestId("tag-maintenance-dialog"))
    .toMatchTextContent("tag:1abc");
  expect(fixture.session.policy.policyPayload?.tagOwners).toEqual(
    baseline.tagOwners,
  );
  expect(fixture.writes).toEqual([]);
});

test.each([
  "failed source",
  "occupied target",
  "remote raw change",
  "unknown key registration",
] as const)(
  "ordinary rename fails closed for %s without overwriting the local definition",
  async (condition) => {
    const fixture = await setup();
    if (condition === "failed source") fixture.failRead("/api/v1/preauthkey");
    if (condition === "remote raw change")
      fixture.setPolicy(`/* remote */${JSON.stringify(baseline)}`);
    if (condition === "unknown key registration")
      fixture.setKeys([
        normalizePreAuthKey({
          id: "unknown-key",
          key: "",
          aclTags: ["tag:server"],
          expiration: "invalid",
          reusable: true,
        }),
      ]);
    await page.getByTestId("tag-open-tag:server").click();
    await page
      .getByTestId("tag-name-input")
      .fill(condition === "occupied target" ? "key-only" : "replacement");
    await userEvent.keyboard("{Enter}");
    await expect
      .element(page.getByTestId("tag-name-input-error"))
      .toBeVisible();
    await expect
      .element(page.getByTestId("tag-rename-review"))
      .not.toBeInTheDocument();
    expect(fixture.session.policy.policyPayload?.tagOwners).toEqual(
      baseline.tagOwners,
    );
    expect(fixture.writes).toEqual([]);
  },
);

test("cancelling the external rename review retains the uncommitted name buffer", async () => {
  const fixture = await setup();
  await page.getByTestId("tag-open-tag:server").click();
  await page.getByTestId("tag-name-input").fill("replacement");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("tag-rename-review")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByTestId("tag-rename-review"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("tag-name-input"))
    .toHaveValue("replacement");
  expect(fixture.session.policy.policyPayload?.tagOwners).toEqual(
    baseline.tagOwners,
  );
  expect(fixture.writes).toEqual([]);
});

test.each(["Escape before focus", "Cancel"] as const)(
  "%s of a rename review keeps the detail draft and does not dismiss its parent",
  async (action) => {
    const fixture = await setup();
    await page.getByTestId("tag-open-tag:server").click();
    await page.getByTestId("tag-name-input").fill("replacement");
    const input = page.getByTestId("tag-name-input").element();
    const originalFocus = HTMLElement.prototype.focus;
    const focus = vi
      .spyOn(HTMLElement.prototype, "focus")
      .mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
        // 保持弹窗已显示、初始焦点尚未交接的真实窗口。
        if (
          action === "Escape before focus" &&
          document.querySelector('[data-testid="tag-rename-review"]')
        )
          return;
        originalFocus.call(this, options);
      });
    try {
      await userEvent.keyboard("{Enter}");
      await expect.element(page.getByTestId("tag-rename-review")).toBeVisible();
      if (action === "Escape before focus") {
        expect(document.activeElement).toBe(input);
        await userEvent.keyboard("{Escape}");
      } else {
        await page.getByTestId("tag-rename-cancel").click();
      }
    } finally {
      focus.mockRestore();
    }
    await expect
      .element(page.getByTestId("tag-rename-review"))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByTestId("unsaved-changes-dialog"))
      .not.toBeInTheDocument();
    await expect.element(page.getByTestId("tag-detail-dialog")).toBeVisible();
    await expect
      .element(page.getByTestId("tag-name-input"))
      .toHaveValue("replacement");
    expect(fixture.session.policy.policyPayload?.tagOwners).toEqual(
      baseline.tagOwners,
    );
    expect(fixture.writes).toEqual([]);
  },
);

test("unmodeled dependencies prevent migration and policy-only removal even after successful source reads", async () => {
  const raw = { ...baseline, future: { audience: "tag:server" } };
  const fixture = await setup(raw);
  await page.getByTestId("tag-maintenance-tag:server").click();
  await page.getByTestId("tag-migration-target").fill("replacement");
  await expect
    .element(page.getByTestId("tag-maintenance-refresh"))
    .toBeEnabled();
  await expect
    .element(page.getByTestId("tag-inventory-unknown"))
    .toMatchTextContent("references");
  await expect
    .element(page.getByTestId("tag-migration-prepare"))
    .toBeDisabled();
  await expect
    .element(page.getByTestId("tag-maintenance-dialog"))
    .toMatchTextContent("future");
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("tag-remove-tag:server").click();
  await expect
    .element(page.getByTestId("policy-removal-refresh"))
    .toBeEnabled();
  await expect
    .element(page.getByTestId("confirm-remove-policy-item"))
    .toBeDisabled();
  expect(fixture.session.policy.policyPayload?.tagOwners).toEqual(
    baseline.tagOwners,
  );
  expect(fixture.writes).toEqual([]);
});

test("key registration status is shown separately from policy removal and becomes unknown after a failed refresh", async () => {
  const fixture = await setup();
  fixture.setKeys([
    normalizePreAuthKey({
      id: "expired",
      key: "",
      aclTags: ["tag:server"],
      expiration: "2000-01-01T00:00:00Z",
      reusable: true,
    }),
    normalizePreAuthKey({
      id: "exhausted",
      key: "",
      aclTags: ["tag:server"],
      used: true,
      reusable: false,
    }),
  ]);
  await page.getByTestId("tag-maintenance-tag:server").click();
  await expect
    .element(page.getByTestId("tag-maintenance-key-exhausted"))
    .toMatchTextContent(getProductCopy("en-US").inviteRegistrationUsed);
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("tag-remove-tag:server").click();
  await expect
    .element(page.getByTestId("confirm-remove-policy-item"))
    .toBeEnabled();
  await expect
    .element(page.getByTestId("policy-removal-inventory"))
    .toMatchTextContent(getProductCopy("en-US").inviteRegistrationExpired);
  await expect
    .element(page.getByTestId("policy-removal-inventory"))
    .toMatchTextContent(getProductCopy("en-US").inviteRegistrationUsed);
  fixture.failRead("/api/v1/preauthkey");
  await page.getByTestId("policy-removal-refresh").click();
  await expect
    .element(page.getByTestId("policy-removal-refresh"))
    .toBeEnabled();
  await expect
    .element(page.getByTestId("confirm-remove-policy-item"))
    .toBeDisabled();
  await expect
    .element(page.getByTestId("policy-removal-inventory"))
    .toMatchTextContent(getProductCopy("en-US").unknown);
  expect(fixture.writes).toEqual([]);
});

test("maintenance opened before the first policy response stays unknown until its own read completes", async () => {
  const read = Promise.withResolvers<void>();
  const fixture = await setup(baseline, undefined, false, read.promise);
  expect(fixture.session.snapshot.getSnapshot().snapshot.policy).toBeNull();
  await page.getByTestId("tag-maintenance-tag:observed").click();
  await expect.element(page.getByTestId("tag-inventory-unknown")).toBeVisible();
  await page.getByTestId("tag-migration-target").fill("replacement");
  await expect
    .element(page.getByTestId("tag-migration-prepare"))
    .toBeDisabled();
  read.resolve();
  await expect
    .element(page.getByTestId("tag-maintenance-refresh"))
    .toBeEnabled();
  await expect.element(page.getByTestId("tag-migration-prepare")).toBeEnabled();
  expect(fixture.session.policy.policyPayload?.tagOwners).toEqual(
    baseline.tagOwners,
  );
  expect(fixture.writes).toEqual([]);
});

test("maintenance renders a key shared by source and target once without exposing its secret", async () => {
  const fixture = await setup({
    ...baseline,
    tagOwners: { ...baseline.tagOwners, "tag:target": [] },
  });
  fixture.setKeys([
    normalizePreAuthKey({
      id: "shared-key",
      key: "sensitive-fixture-marker",
      aclTags: ["tag:server", "tag:target"],
      reusable: true,
    }),
  ]);
  await page.getByTestId("tag-maintenance-tag:server").click();
  await page.getByTestId("tag-migration-target").fill("target");
  await expect
    .element(page.getByTestId("tag-maintenance-key-shared-key"))
    .toBeVisible();
  expect(
    document.querySelectorAll('[data-testid="tag-maintenance-key-shared-key"]'),
  ).toHaveLength(1);
  expect(
    page.getByTestId("tag-maintenance-dialog").element().textContent,
  ).not.toContain("sensitive-fixture-marker");
  expect(fixture.writes).toEqual([]);
});

test("current target-only nodes are observed without claiming migration durability or issuing writes", async () => {
  const fixture = await setup({
    ...baseline,
    tagOwners: { ...baseline.tagOwners, "tag:target": [] },
  });
  fixture.setNodes([node("1", ["tag:target", "tag:extra"])]);
  await page.getByTestId("tag-maintenance-tag:server").click();
  await page.getByTestId("tag-migration-existing").click();
  await page.getByTestId("tag-migration-target").fill("target");
  await expect
    .element(page.getByTestId("tag-migration-node-1"))
    .toMatchTextContent(getProductCopy("en-US").policyMigrationObserved);
  expect(fixture.session.snapshot.getSnapshot().snapshot.nodes[0].tags).toEqual(
    ["tag:target", "tag:extra"],
  );
  expect(fixture.writes).toEqual([]);
});

test("owner cycles and missing groups are explained as dependencies rather than invented grants", async () => {
  const raw = {
    ...baseline,
    tagOwners: {
      "tag:server": ["tag:nested", "group:missing"],
      "tag:nested": ["tag:server"],
    },
  };
  const fixture = await setup(raw);
  await page.getByTestId("tag-open-tag:server").click();
  await expect
    .element(page.getByTestId("tag-owner-dependencies"))
    .toMatchTextContent(getProductCopy("en-US").unknown);
  await expect
    .element(page.getByTestId("tag-owner-dependencies"))
    .toMatchTextContent("group:missing");
  expect(fixture.session.policy.policyPayload?.tagOwners).toEqual(
    raw.tagOwners,
  );
  expect(fixture.session.policy.policyPayload?.acls).toEqual(raw.acls);
  expect(fixture.writes).toEqual([]);
});

test("a publication review of an older local revision cannot submit newer unreviewed edits", async () => {
  const fixture = await setup();
  fixture.session.policy.commitState(
    parsePolicy('{"acls":[],"tagOwners":{"tag:reviewed":[]}}'),
  );
  await page.getByTestId("save-policy").click();
  await expect
    .element(page.getByTestId("policy-publication-submitted"))
    .toMatchTextContent("tag:reviewed");
  fixture.session.policy.commitState(
    parsePolicy('{"acls":[],"tagOwners":{"tag:newer":[]}}'),
  );
  await page.getByTestId("policy-publication-confirm").click();
  await expect
    .element(page.getByTestId("policy-publication-review"))
    .not.toBeInTheDocument();
  const copy = getProductCopy("en-US");
  await expect
    .element(page.getByTestId("policy-save-notice"))
    .toHaveTextContent(copy.feedbackRequestNotSent);
  await expect
    .element(page.getByText(copy.policySavedNewerEdits, { exact: true }))
    .not.toBeInTheDocument();
  expect(fixture.session.policy.isPolicyDirty).toBe(true);
  expect(fixture.session.policy.policyPayload?.tagOwners).toEqual({
    "tag:newer": [],
  });
  expect(fixture.writes).toEqual([]);
});

test.each(["tag", "team"] as const)(
  "keeping an invalid new %s dialog stays in Access and does not create a draft definition",
  async (kind) => {
    const fixture = await setup();
    await page
      .getByTestId(kind === "tag" ? "new-device-label" : "new-team")
      .click();
    await page.getByTestId(`${kind}-name-input`).fill("bad name");
    await userEvent.keyboard("{Escape}");
    await page.getByTestId("unsaved-changes-keep-draft").click();
    await expect
      .element(page.getByTestId(`${kind}-name-input-error`))
      .toBeVisible();
    await userEvent.keyboard("{Escape}");
    await page.getByTestId("unsaved-changes-save").click();
    await expect
      .element(page.getByTestId(`${kind}-name-input-error`))
      .toBeVisible();
    expect(fixture.session.policy.policyPayload?.tagOwners).toEqual(
      baseline.tagOwners,
    );
    expect(fixture.session.policy.policyPayload?.groups).toEqual(
      baseline.groups,
    );
    expect(fixture.writes).toEqual([]);
  },
);

test.each(["publish", "navigate"] as const)(
  "a tag dialog cannot hide an existing IP buffer when choosing to %s",
  async (action) => {
    const raw = {
      ...baseline,
      acls: [
        ...baseline.acls,
        { action: "accept", src: ["10.0.0.0/8"], dst: ["192.168.0.0/16:443"] },
      ],
    };
    const fixture = await setup(raw, undefined, true);
    const rule = fixture.session.policy
      .getSnapshot()
      .policyRules.find((entry) => entry.source === "10.0.0.0/8");
    if (!rule) throw new Error("Missing IP fixture rule");
    await page.getByTestId(`ip-rule-edit-${rule.id}`).click();
    await page.getByTestId(`ip-rule-source-${rule.id}`).fill("10.1.0.0/16");
    await page.getByTestId("tag-open-tag:server").click();
    await page.getByTestId("tag-name-input").fill(" server ");
    if (action === "publish") {
      await userEvent.keyboard("{Escape}");
      await page.getByTestId("unsaved-changes-save").click();
      expect(
        document.querySelector('[data-testid="policy-buffered-error"]'),
      ).not.toBeNull();
      await expect
        .element(page.getByTestId("policy-publication-review"))
        .not.toBeInTheDocument();
    } else {
      void fixture.router.navigate({ to: "/members" });
      await expect
        .element(page.getByTestId("unsaved-changes-dialog"))
        .toBeVisible();
      await expect
        .element(page.getByTestId("tag-name-input"))
        .toHaveValue("server");
      await expect
        .element(page.getByTestId("discard-ip-draft-dialog"))
        .not.toBeInTheDocument();
      await page.getByTestId("unsaved-changes-keep-draft").click();
      await expect
        .element(page.getByTestId("discard-ip-draft-dialog"))
        .toBeVisible();
      expect(fixture.router.state.location.pathname).toBe("/access");
      await page.getByTestId("discard-ip-draft-cancel").click();
      await expect
        .element(page.getByTestId(`ip-rule-source-${rule.id}`))
        .toHaveValue("10.1.0.0/16");
    }
    expect(fixture.session.policy.policyPayload?.acls).toEqual(raw.acls);
    expect(fixture.writes).toEqual([]);
  },
);

test("publishing a normalized but otherwise unchanged name does not create an empty policy operation", async () => {
  const fixture = await setup();
  await page.getByTestId("tag-open-tag:server").click();
  await page.getByTestId("tag-name-input").fill(" server ");
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("unsaved-changes-save").click();
  await expect
    .element(page.getByTestId("tag-name-input"))
    .toHaveValue("server");
  await expect
    .element(page.getByTestId("policy-publication-review"))
    .not.toBeInTheDocument();
  expect(fixture.session.policy.isPolicyDirty).toBe(false);
  expect(fixture.writes).toEqual([]);
});

test("a removed accessor cannot be recreated by its stale service checkbox", async () => {
  const fixture = await setup();
  await page.getByTestId("tag-open-tag:server").click();
  const service = page.getByTestId("tag-accessor-svc-group:ops-web").element();
  const remove = page.getByTestId("tag-accessor-remove-group:ops").element();
  remove.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  service.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  expect(fixture.session.policy.policyPayload?.acls).toEqual([]);
  expect(fixture.writes).toEqual([]);
});

test("a pending all-services confirmation cannot restore an accessor removed by a newer draft", async () => {
  const fixture = await setup();
  await page.getByTestId("tag-open-tag:server").click();
  await page.getByTestId("tag-accessor-svc-group:ops-all").click();
  await expect
    .element(page.getByTestId("high-risk-confirm-dialog"))
    .toBeVisible();
  fixture.session.policy.commitState(
    parsePolicy(JSON.stringify({ ...baseline, acls: [] })),
  );
  await page.getByTestId("high-risk-confirm").click();
  expect(fixture.session.policy.policyPayload?.acls).toEqual([]);
  expect(fixture.writes).toEqual([]);
});

test("an old owner picker cannot declare a newly selected incompatible tag", async () => {
  const fixture = await setup();
  await page.getByTestId("tag-open-tag:server").click();
  await page.getByTestId("tag-add-owner-trigger").click();
  const owner = page.getByTestId("tag-add-owner-option-bob@").element();
  fixture.session.policy.setState({ tagDetailCurrent: "tag:1abc" });
  owner.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  expect(fixture.session.policy.policyPayload?.tagOwners).toEqual(
    baseline.tagOwners,
  );
  expect(fixture.writes).toEqual([]);
});

test("a policy removal callback cannot remove a newly selected target", async () => {
  const raw = {
    ...baseline,
    tagOwners: { ...baseline.tagOwners, "tag:other": [] },
  };
  const fixture = await setup(raw);
  await page.getByTestId("tag-remove-tag:server").click();
  await expect
    .element(page.getByTestId("confirm-remove-policy-item"))
    .toBeEnabled();
  const remove = page.getByTestId("confirm-remove-policy-item").element();
  const other = fixture.session.policy
    .getSnapshot()
    .policyTagOwners.find((entry) => entry.tag === "tag:other");
  if (!other) throw new Error("Missing alternate target");
  fixture.session.policy.setState({
    pendingPolicyRemoval: { kind: "tagOwner", id: other.id, label: "other" },
  });
  remove.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  expect(fixture.session.policy.policyPayload?.tagOwners).toEqual(
    raw.tagOwners,
  );
  expect(fixture.session.policy.getSnapshot().pendingPolicyRemoval?.id).toBe(
    other.id,
  );
  expect(fixture.writes).toEqual([]);
});

test("an old management-return action cannot consume a newer source slot", async () => {
  const fixture = await setup(baseline, (session) =>
    deviceReturn(session, "tag:server"),
  );
  await expect.element(page.getByTestId("tag-management-return")).toBeVisible();
  const back = page.getByTestId("tag-management-return").element();
  back.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  deviceReturn(fixture.session, "tag:observed");
  await expect
    .element(page.getByTestId("tag-name-input"))
    .toHaveValue("observed");
  await userEvent.keyboard("{Tab}");
  expect(fixture.router.state.location.pathname).toBe("/access");
  expect(fixture.session.tagLifecycle.getSnapshot().returnTo?.status).toBe(
    "managing",
  );
  expect(fixture.session.tagLifecycle.getSnapshot().returnTo?.managedTag).toBe(
    "tag:observed",
  );
  expect(fixture.writes).toEqual([]);
});

test("returning with unblurred wildcard ports requires the independent all-services confirmation", async () => {
  const raw = {
    ...baseline,
    acls: [{ action: "accept", src: ["group:ops"], dst: ["tag:server:8443"] }],
  };
  const fixture = await setup(raw, (session) =>
    deviceReturn(session, "tag:server"),
  );
  await page.getByTestId("tag-accessor-custom-group:ops").fill("*");
  page
    .getByTestId("tag-management-return")
    .element()
    .dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  await expect
    .element(page.getByTestId("high-risk-confirm-dialog"))
    .toBeVisible();
  expect(fixture.router.state.location.pathname).toBe("/access");
  expect(fixture.session.tagLifecycle.getSnapshot().returnTo?.status).toBe(
    "managing",
  );
  expect(fixture.session.policy.policyPayload?.acls).toEqual(raw.acls);
  expect(fixture.writes).toEqual([]);
});

test("native Back keeps the tag choice ahead of IP discard after a valid custom-port blur", async () => {
  const ipRule = {
    action: "accept",
    src: ["10.0.0.0/8"],
    dst: ["192.168.0.0/16:443"],
  };
  const fixture = await setup(
    { ...baseline, acls: [...baseline.acls, ipRule] },
    undefined,
    true,
  );
  await fixture.router.navigate({ to: "/devices" });
  deviceReturn(fixture.session, "");
  await fixture.router.navigate({ to: "/access" });
  const rule = fixture.session.policy
    .getSnapshot()
    .policyRules.find((entry) => entry.source === "10.0.0.0/8");
  if (!rule) throw new Error("Missing IP fixture rule");
  await page.getByTestId(`ip-rule-edit-${rule.id}`).click();
  await page.getByTestId(`ip-rule-source-${rule.id}`).fill("10.1.0.0/16");
  await page.getByTestId("tag-open-tag:server").click();
  await page.getByTestId("tag-accessor-custom-group:ops").fill("8443");
  fixture.router.history.back();
  await expect
    .element(page.getByTestId("unsaved-changes-dialog"))
    .toBeVisible();
  await expect
    .poll(() => fixture.session.policy.policyPayload?.acls)
    .toContainEqual({
      action: "accept",
      src: ["group:ops"],
      dst: ["tag:server:22,8443"],
    });
  await expect
    .element(page.getByTestId("discard-ip-draft-dialog"))
    .not.toBeInTheDocument();
  expect(fixture.router.state.location.pathname).toBe("/access");
  await page.getByTestId("unsaved-changes-keep-draft").click();
  await expect
    .element(page.getByTestId("discard-ip-draft-dialog"))
    .toBeVisible();
  expect(fixture.router.state.location.pathname).toBe("/access");
  await page.getByTestId("discard-ip-draft-confirm").click();
  await expect
    .poll(() => fixture.router.state.location.pathname)
    .toBe("/devices");
  expect(fixture.session.policy.policyPayload?.acls).toContainEqual(ipRule);
  expect(fixture.session.policy.policyPayload?.acls).toContainEqual({
    action: "accept",
    src: ["group:ops"],
    dst: ["tag:server:22,8443"],
  });
  expect(fixture.session.policy.isPolicyDirty).toBe(true);
  expect(fixture.writes).toEqual([]);
});

test("publication cannot skip an all-services decision that was cancelled while retaining its input", async () => {
  const raw = {
    ...baseline,
    acls: [{ action: "accept", src: ["group:ops"], dst: ["tag:server:8443"] }],
  };
  const fixture = await setup(raw);
  await page.getByTestId("tag-open-tag:server").click();
  await page.getByTestId("tag-accessor-custom-group:ops").fill("*");
  await userEvent.keyboard("{Tab}");
  await expect
    .element(page.getByTestId("high-risk-confirm-dialog"))
    .toBeVisible();
  await page.getByTestId("high-risk-cancel").click();
  await expect
    .element(page.getByTestId("high-risk-confirm-dialog"))
    .not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("unsaved-changes-save").click();
  await expect
    .element(page.getByTestId("high-risk-confirm-dialog"))
    .toBeVisible();
  await expect
    .element(page.getByTestId("policy-publication-review"))
    .not.toBeInTheDocument();
  expect(fixture.session.policy.policyPayload?.acls).toEqual(raw.acls);
  expect(fixture.writes).toEqual([]);
});

test("Escape during a rename re-read cannot apply the retired confirmation", async () => {
  const fixture = await setup();
  await page.getByTestId("tag-open-tag:server").click();
  await page.getByTestId("tag-name-input").fill("replacement");
  await userEvent.keyboard("{Enter}");
  await page.getByTestId("tag-rename-external").click();
  const read = Promise.withResolvers<void>();
  fixture.holdRead("/api/v1/policy", read.promise);
  await page.getByTestId("tag-rename-confirm").click();
  await expect.element(page.getByTestId("tag-rename-confirm")).toBeDisabled();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("tag-rename-review")).toBeVisible();
  read.resolve();
  await expect
    .element(page.getByTestId("tag-rename-review"))
    .not.toBeInTheDocument();
  expect(fixture.session.policy.policyPayload?.tagOwners).toEqual(
    baseline.tagOwners,
  );
  expect(fixture.session.policy.policyPayload?.tagOwners).not.toHaveProperty(
    "tag:replacement",
  );
  expect(fixture.writes).toEqual([]);
});

test("a frozen rename review cannot replace a newer policy draft", async () => {
  const fixture = await setup();
  await page.getByTestId("tag-open-tag:server").click();
  await page.getByTestId("tag-name-input").fill("replacement");
  await userEvent.keyboard("{Enter}");
  await page.getByTestId("tag-rename-external").click();
  const newer = {
    ...baseline,
    acls: [{ action: "accept", src: ["bob@"], dst: ["tag:server:443"] }],
  };
  fixture.session.policy.commitState(parsePolicy(JSON.stringify(newer)));
  await page.getByTestId("tag-rename-confirm").click();
  await expect
    .element(page.getByTestId("tag-rename-review"))
    .not.toBeInTheDocument();
  expect(fixture.session.policy.policyPayload?.tagOwners).toEqual(
    baseline.tagOwners,
  );
  expect(fixture.session.policy.policyPayload?.acls).toEqual(newer.acls);
  expect(fixture.writes).toEqual([]);
});

test("a publication click already in flight cannot open a review while another save owns the draft", async () => {
  const fixture = await setup();
  fixture.session.policy.commitState(
    parsePolicy('{"acls":[],"tagOwners":{"tag:new":[]}}'),
  );
  const publish = page.getByTestId("save-policy");
  await expect.element(publish).toBeEnabled();
  const button = publish.element() as HTMLButtonElement;
  const ticket = fixture.session.policy.beginSave(
    fixture.session.policy.policyDesignerState,
  );
  expect.assert(ticket);
  try {
    expect(button.disabled).toBe(false);
    button.click();
    await expect.element(publish).toBeDisabled();
    await expect
      .element(page.getByTestId("policy-publication-review"))
      .not.toBeInTheDocument();
    expect(
      fixture.session.policy.getSnapshot().pendingPolicySave?.operationId,
    ).toBe(ticket.operationId);
    expect(fixture.writes).toEqual([]);
  } finally {
    fixture.session.policy.finishSave(ticket.operationId);
  }
  await expect.element(publish).toBeEnabled();
  await publish.click();
  await expect
    .element(page.getByTestId("policy-publication-review"))
    .toBeVisible();
  expect(fixture.session.policy.isPolicyDirty).toBe(true);
  expect(fixture.writes).toEqual([]);
});

test("a raw comment change after publication review reopens the full conflict without writing", async () => {
  const fixture = await setup();
  fixture.session.policy.commitState(
    parsePolicy('{"acls":[],"tagOwners":{"tag:new":[]}}'),
  );
  await page.getByTestId("save-policy").click();
  const latest = `/* changed after review */${JSON.stringify(baseline)}`;
  fixture.setPolicy(latest);
  await page.getByTestId("policy-publication-confirm").click();
  await expect
    .element(page.getByTestId("policy-publication-current"))
    .toHaveTextContent(latest);
  await expect
    .element(page.getByTestId("policy-publication-confirm"))
    .toBeDisabled();
  expect(
    page.getByTestId("policy-publication-original").element().textContent,
  ).toBe(JSON.stringify(baseline));
  expect(fixture.session.policy.isPolicyDirty).toBe(true);
  expect(fixture.writes).toEqual([]);
});
