import { createBrowserHistory, RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { SessionProviders } from "@/AppProviders";
import { prepareApplication } from "@/bootstrap";
import { createSession, type Session } from "@/composables/session-context";
import { i18n } from "@/i18n";
import { getProductCopy } from "@/i18n/product-copy";
import { __resetForTest as resetIdbCache } from "@/lib/idb";
import { settingsStorageTestingHandle } from "@/lib/settings-storage";
import { createApplicationRouter } from "@/router";
import type {
  NetworkGateOptions,
  NetworkGateState,
  NetworkObservation,
} from "../scripts/harness/session-network";
import type { DurableNode, TagNode } from "../scripts/harness/tag-lifecycle";
import type { NetworkOperationCall } from "./network-observations";
import "@/styles/globals.css";

interface FixtureSnapshot {
  nodes: TagNode[];
  keys: {
    id: string;
    aclTags: string[];
    used: boolean;
    reusable: boolean;
    ephemeral: boolean;
    expiration: string;
  }[];
  policy: string;
}
declare module "vitest/browser" {
  interface BrowserCommands {
    tagFixtureReset(): Promise<void>;
    tagFixtureConnection(): Promise<{ apiKey: string }>;
    tagFixtureSecondServer(
      matchingNodeId: string,
    ): Promise<{ baseUrl: string; apiKey: string }>;
    tagFixtureSecondSnapshot(): Promise<{
      nodes: TagNode[];
      calls: NetworkOperationCall[];
    }>;
    tagFixtureSeedPolicy(policy: string): Promise<void>;
    tagFixtureCreateNode(
      name: string,
      tags: string[],
      ephemeral?: boolean,
      routes?: string[],
    ): Promise<{ nodeId: string; keyId: string; machineKey: string }>;
    tagFixtureRegisterKey(
      name: string,
      key: string,
    ): Promise<{ nodeId: string; machineKey: string }>;
    tagFixtureSnapshot(): Promise<FixtureSnapshot>;
    tagFixtureDurableNode(id: string): Promise<DurableNode>;
    tagFixtureLogin(
      name: string,
      routes?: string[],
    ): Promise<{ authId: string; url: string; loginServer: string }>;
    tagFixtureFinishLogin(name: string): Promise<number>;
    tagFixtureStopClient(name: string): Promise<void>;
    tagFixtureRestart(clearFaults?: boolean): Promise<void>;
    tagFixtureInjectFailure(
      point: "node-tags" | "auth-register",
      id: string,
    ): Promise<void>;
    tagFixtureConcurrentKey(
      tags: string[],
      expiration: string,
      user?: string,
    ): Promise<{ id: string }>;
    tagFixtureSetTags(id: string, tags: string[]): Promise<void>;
    tagNetworkIntercept(options: NetworkGateOptions): Promise<void>;
    tagNetworkState(): Promise<NetworkGateState | null>;
    tagNetworkRelease(): Promise<void>;
    tagNetworkCalls(): Promise<NetworkOperationCall[]>;
    tagNetworkObservations(): Promise<NetworkObservation[]>;
    tagNetworkClear(): Promise<void>;
  }
}
let session: Session;
const allow = [{ action: "accept", src: ["*"], dst: ["*:*"] }];
const password = "tag-lifecycle-fixture-password";
async function resetStorage() {
  await session.auth.lock(session.auth.getSessionSnapshot()?.identity ?? null);
  const profiles = await session.auth.listProfiles();
  if (!profiles.ok) throw new Error("Fixture profile listing failed");
  const reset = await session.auth.resetStorage(profiles.value.version);
  expect(reset.ok).toBe(true);
}
beforeEach(async () => {
  await cleanup();
  document.body.replaceChildren();
  await page.viewport(1366, 768);
  localStorage.clear();
  sessionStorage.clear();
  resetIdbCache();
  settingsStorageTestingHandle.reset();
  session = createSession(await prepareApplication());
  await resetStorage();
  session.auth.dispose();
  session = createSession(await prepareApplication());
  i18n.activate("en-US");
  document.documentElement.lang = "en-US";
  document.documentElement.dir = "ltr";
  await commands.tagFixtureReset();
});
afterEach(async () => {
  await commands.tagNetworkRelease();
  await cleanup();
  if (session) {
    await resetStorage();
    session.auth.dispose();
  }
  resetIdbCache();
});
async function connect() {
  window.history.pushState({}, "", "/login");
  const router = createApplicationRouter(session, createBrowserHistory());
  await render(
    <SessionProviders session={session}>
      <RouterProvider router={router} />
    </SessionProviders>,
  );
  await router.load();
  const connection = await commands.tagFixtureConnection();
  await page.getByTestId("profile-option-new").click();
  await page.getByTestId("connect-profile-name").fill("Tag lifecycle fixture");
  await page
    .getByTestId("connect-server-url")
    .fill(`${window.location.origin}/__headscale-tag-lifecycle`);
  await page.getByTestId("connect-api-key").fill(connection.apiKey);
  await page.getByTestId("connect-password").fill(password);
  await page.getByTestId("connect-password-confirm").fill(password);
  await page.getByTestId("connect-save-unlock").click();
  await expect.element(page.getByTestId("section-home")).toBeVisible();
  await commands.tagNetworkClear();
}
async function editTags(id: string) {
  await page.getByTestId("section-devices").click();
  await page.getByTestId(`machine-actions-trigger-${id}`).click();
  await page.getByTestId(`edit-node-tags-action-${id}`).click();
  await expect.element(page.getByTestId("node-tags-dialog")).toBeVisible();
}
async function confirmTags(personal = false) {
  await page.getByTestId("node-tags-confirm").click();
  await expect.element(page.getByTestId("node-tags-apply")).toBeVisible();
  if (personal) await page.getByTestId("node-tags-acknowledge").click();
  await page.getByTestId("node-tags-apply").click();
  try {
    await expect.element(page.getByTestId("node-tags-result")).toBeVisible();
  } catch (error) {
    try {
      const observations = await commands.tagNetworkObservations();
      console.error(
        "标签提交尚未完成，HTTP 观测状态：",
        observations.map(({ method, path, status }) => ({
          method,
          path,
          status: status ?? null,
        })),
      );
    } catch {
      console.error("无法读取标签提交的 HTTP 观测状态。");
    }
    throw error;
  }
}
async function confirmKeyAction(action: "expire" | "delete") {
  await page.getByTestId("confirm-invite-action").click();
  await expect
    .element(page.getByTestId(`${action}-invite-dialog`))
    .not.toBeInTheDocument();
}
async function publishPolicy() {
  const completed = (await commands.tagNetworkObservations()).filter(
    (entry) =>
      entry.method === "PUT" &&
      entry.path === "/api/v1/policy" &&
      entry.status === 200,
  ).length;
  await page.getByTestId("save-policy").click();
  await expect
    .element(page.getByTestId("policy-publication-review"))
    .toBeVisible();
  await page.getByTestId("policy-publication-confirm").click();
  await expect
    .poll(
      async () =>
        (await commands.tagNetworkObservations()).filter(
          (entry) =>
            entry.method === "PUT" &&
            entry.path === "/api/v1/policy" &&
            entry.status === 200,
        ).length,
      { timeout: 10_000 },
    )
    .toBe(completed + 1);
  await expect
    .element(page.getByTestId("policy-publication-review"))
    .not.toBeInTheDocument();
}
async function writeCount(operation = "node.setTags") {
  return (await commands.tagNetworkCalls()).filter(
    (call) => call.id === operation,
  ).length;
}
async function liveNode(id: string) {
  return (await commands.tagFixtureSnapshot()).nodes.find(
    (node) => node.id === id,
  );
}

test("G01: UI blocks a duplicate email, then one corrected create leaves the public user and policy unchanged", async () => {
  await connect();
  const identity = session.client.getSnapshot().identity;
  expect.assert(identity);
  const owner = await session.auth.write(identity, {
    endpoint: "createUser",
    input: {
      name: "g01-owner",
      displayName: "",
      email: "g01-owner@example.test",
    },
  });
  expect.assert(owner.ok);
  const original = (await commands.tagFixtureSnapshot()).policy;
  await page.getByTestId("section-members").click();
  await expect.element(page.getByTestId("member-g01-owner")).toBeVisible();
  await commands.tagNetworkClear();
  await page.getByTestId("open-create-member").click();
  await page.getByTestId("member-name").fill("g01-copy");
  await page.getByTestId("member-email").fill("g01-owner@example.test");
  await page.getByTestId("create-member").click();
  await expect
    .element(page.getByTestId("member-email"))
    .toHaveAttribute("aria-invalid", "true");
  await expect.element(page.getByTestId("member-email-error")).toBeVisible();
  const dangerousUiCreates = await writeCount("user.create");
  expect(dangerousUiCreates).toBe(0);
  expect(await session.snapshot.refreshSegments(["identity"])).toBe(true);
  expect(
    session.snapshot
      .getSnapshot()
      .snapshot.users.some((user) => user.name === "g01-copy"),
  ).toBe(false);
  expect((await commands.tagFixtureSnapshot()).policy).toBe(original);

  await page.getByTestId("member-email").fill("g01-unique@example.test");
  await expect
    .element(page.getByTestId("member-email-error"))
    .not.toBeInTheDocument();
  await page.getByTestId("create-member").click();
  await expect.element(page.getByTestId("member-g01-copy")).toBeVisible();
  const safeUiCreates = await writeCount("user.create");
  expect(safeUiCreates).toBe(1);
  expect(
    session.snapshot
      .getSnapshot()
      .snapshot.users.find((user) => user.name === "g01-copy")?.email,
  ).toBe("g01-unique@example.test");
  expect((await commands.tagFixtureSnapshot()).policy).toBe(original);
});

async function expectAuthInputCleared(input: HTMLInputElement) {
  await expect.poll(() => input.value === "").toBe(true);
}

test("G02 empty-request assertion reports only a boolean when input is retained", async () => {
  const input = document.createElement("input");
  const sentinel = "NON_SECRET_G02_ASSERTION_SENTINEL";
  input.value = sentinel;
  let failure: unknown;
  try {
    await expectAuthInputCleared(input);
  } catch (error) {
    failure = error;
  }
  expect.assert(failure instanceof Error);
  const diagnostic = [
    failure.message,
    failure.cause instanceof Error ? failure.cause.message : "",
  ].join("\n");
  expect(diagnostic.includes(sentinel)).toBe(false);
  expect(diagnostic.includes("expected false to be true")).toBe(true);
  input.value = "";
  await expectAuthInputCleared(input);
});

// These are complete UI flows; only client-side terminal operations and fixture setup use commands.
test.each(["control", "changed-tags", "external-person"])(
  "G02 real recovery %s: replace tags, reauthenticate from the same editor and approve only the reviewed baseline",
  async (scenario) => {
    await commands.tagFixtureSeedPolicy(
      JSON.stringify({
        acls: allow,
        tagOwners: { "tag:server": [], "tag:audit": [] },
      }),
    );
    const target = await commands.tagFixtureCreateNode("g02-device", [
      "tag:server",
      "tag:audit",
    ]);
    await connect();
    const initial = await liveNode(target.nodeId);
    expect(initial !== undefined).toBe(true);
    const evidence: object[] = [];
    async function capture(phase: string) {
      const current = await liveNode(target.nodeId);
      const local = session.snapshot.nodeById(target.nodeId);
      const scope = session.tagLifecycle.captureScope();
      const baseline = (node: typeof current | typeof local) => ({
        nodeId: node?.id,
        sameMachine: node?.machineKey === initial?.machineKey,
        sameNodeKey: node?.nodeKey === initial?.nodeKey,
        user: node?.user ? { id: node.user.id, name: node.user.name } : null,
        tags: node?.tags,
      });
      evidence.push({
        phase,
        backend: baseline(current),
        snapshot: baseline(local),
        approvedResponse: baseline(
          session.deviceSetup.getSnapshot().lastRegisteredNode ?? undefined,
        ),
        reads: (await commands.tagNetworkObservations())
          .filter((call) => call.method === "GET")
          .map(({ path, status }) => ({ path, status })),
        scope: {
          generation: scope?.generation,
          version: scope?.version,
          versionFresh: scope?.versionFresh,
          viewEpoch: scope?.viewEpoch,
        },
        approvals: await writeCount("auth.register"),
      });
    }
    await capture("before-tag-replacement");
    await editTags(target.nodeId);
    await page.getByTestId("node-tags-remove-tag:audit").click();
    await confirmTags();
    await capture("confirmed-replacement-and-GET");
    await page.getByTestId("node-tags-restore").click();
    await expect
      .element(page.getByTestId("restore-personal-dialog"))
      .toBeVisible();
    const input = page
      .getByTestId("restore-auth-id")
      .element() as HTMLInputElement;
    expect(input.id).toBe("pending-node-key");
    expect(getComputedStyle(input).webkitTextFillColor).toBe(
      "rgba(0, 0, 0, 0)",
    );
    const request = await commands.tagFixtureLogin("g02-device");
    await capture("keyless-reauth-before-approval");
    await page.getByTestId("restore-user").selectOptions("2");
    await page.getByTestId("restore-login-server").fill(request.loginServer);
    await page.getByTestId("restore-server-confirm").click();
    await page.getByTestId("restore-backup-confirm").click();
    await page.getByTestId("restore-auth-id").fill(request.url);
    await page.getByTestId("restore-source-confirm").click();
    if (scenario === "changed-tags") {
      // A real concurrent API write, not a fabricated response to the UI's GET.
      await commands.tagFixtureSetTags(target.nodeId, [
        "tag:server",
        "tag:audit",
      ]);
      await capture("external-tag-change-before-approval");
    } else if (scenario === "external-person") {
      const identity = session.client.getSnapshot().identity;
      expect(identity !== null).toBe(true);
      if (!identity) throw new Error("Expected owned fixture identity");
      const changed = await session.auth.write(identity, {
        endpoint: "authRegister",
        input: { user: "alice", authId: request.authId },
      });
      expect(changed.ok).toBe(true);
      await capture("external-personal-registration-before-UI-approval");
    }
    await page.getByTestId("restore-personal-confirm").click();
    await expect
      .poll(
        () =>
          Boolean(
            document.querySelector(
              '[data-testid="restore-result"], [data-testid="restore-safety-error"]',
            ),
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
    await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
    await capture("approval-pre-read-and-dispatch");
    console.info("G02 real sequence", scenario, JSON.stringify(evidence));
    if (scenario === "external-person") {
      // One registration was sent by the independent API operation, never by this UI flow.
      expect(await writeCount("auth.register")).toBe(1);
      await page.getByTestId("restore-readonly-check").click();
      await expect
        .element(page.getByTestId("restore-result"))
        .toHaveTextContent(getProductCopy("en-US").tagObservedConflict);
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
        page
          .getByTestId("pending-registration-flow")
          .element() as HTMLFormElement
      ).requestSubmit();
      expect(await writeCount("auth.register")).toBe(1);
      expect((await liveNode(target.nodeId))?.user?.name).toBe("alice");
      await capture("external-person-observation-without-UI-dispatch");
      console.info(
        "G02 external identity refusal",
        JSON.stringify(evidence.at(-1)),
      );
      return;
    }
    if (scenario === "changed-tags") {
      expect(await writeCount("auth.register")).toBe(0);
      expect(input.value.length > 0).toBe(true);
      // Controlled stale confirmations reproduce the loop, not its unknown historical cause.
      for (let attempt = 2; attempt <= 3; attempt++) {
        await page.getByTestId("restore-source-confirm").click();
        await page.getByTestId("restore-personal-confirm").click();
        await expect
          .element(page.getByTestId("restore-source-confirm"))
          .not.toBeChecked();
        await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
        expect(await writeCount("auth.register")).toBe(0);
        expect(input.value.length > 0).toBe(true);
      }
      await capture("three-stale-confirmations-without-dispatch");
      console.info(
        "G02 controlled confirmation loop",
        JSON.stringify(evidence.at(-1)),
      );
      // Business contract: a blocked, unconsumed request has a visible way to rereview.
      expect(
        Boolean(
          document.querySelector('[data-testid="restore-readonly-check"]'),
        ),
      ).toBe(true);
      await page.getByTestId("restore-readonly-check").click();
      await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
      expect(await writeCount("auth.register")).toBe(0);
      for (const name of ["server", "backup", "source"]) {
        await expect
          .element(page.getByTestId(`restore-${name}-confirm`))
          .not.toBeChecked();
        await page.getByTestId(`restore-${name}-confirm`).click();
      }
      await expect
        .element(page.getByTestId("restore-baseline"))
        .toMatchTextContent(/tagged-devices.*2147455555/);
      await expect
        .element(page.getByTestId("restore-baseline"))
        .toMatchTextContent(/tag:audit/);
      await expect
        .element(page.getByTestId("restore-baseline"))
        .toMatchTextContent(/tag:server/);
      await page.getByTestId("restore-personal-confirm").click();
      await expect
        .poll(() => writeCount("auth.register"), { timeout: 10_000 })
        .toBe(1);
    }
    expect(await writeCount("auth.register")).toBe(1);
    // The client must finish its pending login so the approved node exists. Its exit code is not the GUI result.
    await commands.tagFixtureFinishLogin("g02-device");
    await expect
      .poll(async () => {
        const node = await liveNode(target.nodeId);
        return {
          sameMachine: node?.machineKey === target.machineKey,
          user: node?.user?.name,
          tags: node?.tags,
        };
      })
      .toEqual({ sameMachine: true, user: "bob", tags: [] });
    await expectAuthInputCleared(
      page.getByTestId("restore-auth-id").element() as HTMLInputElement,
    );
    await expect
      .element(page.getByTestId("restore-result"))
      .toHaveTextContent(getProductCopy("en-US").restoreIdentityObserved);
    expect(await writeCount("auth.register")).toBe(1);
    expect(
      JSON.stringify(session.tagLifecycle.getSnapshot()).includes(
        request.authId,
      ),
    ).toBe(false);
    await capture("verified-public-identity");
    console.info(
      "G02 completed recovery",
      scenario,
      JSON.stringify(evidence.at(-1)),
    );
  },
);

test("main chain 1 / A01,A04,A06,A10: declare in Access, return without writing, then explicitly convert the personal device", async () => {
  const target = await commands.tagFixtureCreateNode("return-device", []);
  await commands.tagFixtureConcurrentKey(
    ["tag:declare-return"],
    new Date(Date.now() + 3_600_000).toISOString(),
  );
  await connect();
  await editTags(target.nodeId);
  await page.getByTestId("node-tags-search").fill("tag:declare-return");
  await userEvent.keyboard("{Enter}");
  expect(await writeCount()).toBe(0);
  await page.getByTestId("node-tags-manage").click();
  await expect.element(page.getByTestId("tag-management-return")).toBeVisible();
  await page.getByTestId("tag-open-tag:declare-return").click();
  await page.getByTestId("tag-declare").click();
  await page.getByTestId("tag-detail-close").click();
  expect(await writeCount("policy.set")).toBe(0);
  expect(
    JSON.parse((await commands.tagFixtureSnapshot()).policy).tagOwners?.[
      "tag:declare-return"
    ],
  ).toBeUndefined();
  await publishPolicy();
  expect(
    JSON.parse((await commands.tagFixtureSnapshot()).policy).tagOwners[
      "tag:declare-return"
    ],
  ).toEqual([]);
  expect((await liveNode(target.nodeId))?.tags).toEqual([]);
  await page.getByTestId("tag-management-return").click();
  await expect.element(page.getByTestId("node-tags-dialog")).toBeVisible();
  expect(await writeCount()).toBe(0);
  await page.getByTestId("node-tags-option-tag:declare-return").click();
  const ownerLink = () =>
    document.querySelector(
      `[data-testid="device-owner-link-${target.nodeId}"]`,
    );
  expect(ownerLink()?.textContent ?? "").toContain("alice");
  await expect
    .element(page.getByTestId("node-tags-owner-warning"))
    .toMatchTextContent("alice");
  await confirmTags(true);
  await expect
    .poll(() => liveNode(target.nodeId))
    .toMatchObject({
      tags: ["tag:declare-return"],
      user: { name: "tagged-devices" },
    });
  expect(await writeCount()).toBe(1);
  await expect.poll(() => ownerLink()).toBeNull();
  await expect
    .element(page.getByTestId("node-tags-owner-warning"))
    .not.toBeInTheDocument();
});

test("main chain 2 / A15,A16,A17,A28: create a key, register that tagged device, migrate the exact tag set, retire the key, then publish scoped policy cleanup", async () => {
  const retainedOwners = {
    "tag:target": ["bob@"],
    "tag:extra": [],
  };
  await commands.tagFixtureSeedPolicy(
    JSON.stringify({
      acls: allow,
      tagOwners: { "tag:old": [], ...retainedOwners },
    }),
  );
  await connect();
  await page.getByTestId("section-invites").click();
  await page.getByTestId("open-create-invite").click();
  for (const tag of ["tag:old", "tag:target", "tag:extra"])
    await page.getByTestId(`invite-tags-option-${tag}`).click();
  await page.getByTestId("invite-reusable").click();
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("invite-created-not-joined"))
    .toBeVisible();
  expect((await commands.tagFixtureSnapshot()).nodes).toHaveLength(0);
  const secret =
    document
      .querySelector('[data-testid="created-invite"] code')
      ?.textContent?.trim() ?? "";
  expect(Boolean(secret)).toBe(true);
  const registered = await commands.tagFixtureRegisterKey(
    "key-migration-device",
    secret,
  );
  const keyId = (await commands.tagFixtureSnapshot()).keys[0].id;
  await editTags(registered.nodeId);
  await page.getByTestId("node-tags-remove-tag:old").click();
  await confirmTags();
  await expect
    .poll(() => liveNode(registered.nodeId))
    .toMatchObject({ tags: ["tag:extra", "tag:target"] });
  expect(await writeCount()).toBe(1);
  await page.getByTestId("node-tags-cancel").click();
  await page.getByTestId("section-invites").click();
  await page.getByTestId(`invite-actions-trigger-${keyId}`).click();
  await page.getByTestId(`expire-invite-${keyId}`).click();
  await confirmKeyAction("expire");
  await expect
    .poll(async () =>
      Date.parse(
        (await commands.tagFixtureSnapshot()).keys.find(
          (key) => key.id === keyId,
        )?.expiration ?? "",
      ),
    )
    .toBeLessThanOrEqual(Date.now() + 5_000);
  expect((await liveNode(registered.nodeId))?.tags).toEqual([
    "tag:extra",
    "tag:target",
  ]);
  await page.getByTestId(`invite-actions-trigger-${keyId}`).click();
  await page.getByTestId(`delete-invite-${keyId}`).click();
  await confirmKeyAction("delete");
  await expect
    .poll(async () =>
      (await commands.tagFixtureSnapshot()).keys.find(
        (key) => key.id === keyId,
      ),
    )
    .toBeUndefined();
  await page.getByTestId("section-access").click();
  await page.getByTestId("tag-remove-tag:old").click();
  await page.getByTestId("confirm-remove-policy-item").click();
  await publishPolicy();
  const current = await commands.tagFixtureSnapshot();
  expect(JSON.parse(current.policy).tagOwners).toEqual(retainedOwners);
  expect(current.keys.some((key) => key.aclTags.includes("tag:old"))).toBe(
    false,
  );
  expect(
    current.nodes.find((node) => node.id === registered.nodeId)?.tags,
  ).toEqual(["tag:extra", "tag:target"]);
  expect(await writeCount()).toBe(1);
}, 120_000);

test("main chain 3 / A21: GUI restores an ephemeral device once and the public API keeps its machine, owner, and cleared tags", async () => {
  await commands.tagFixtureSeedPolicy(
    JSON.stringify({ acls: allow, tagOwners: { "tag:temporary": [] } }),
  );
  const restored = await commands.tagFixtureCreateNode(
    "restore-ephemeral",
    ["tag:temporary"],
    true,
  );
  await connect();
  await page.getByTestId("section-devices").click();
  await page.getByTestId(`machine-actions-trigger-${restored.nodeId}`).click();
  await page.getByTestId(`restore-personal-action-${restored.nodeId}`).click();
  await expect
    .element(page.getByTestId("restore-personal-dialog"))
    .toBeVisible();
  const request = await commands.tagFixtureLogin("restore-ephemeral");
  await page.getByTestId("restore-user").selectOptions("1");
  await page.getByTestId("restore-login-server").fill(request.loginServer);
  await page.getByTestId("restore-server-confirm").click();
  await page.getByTestId("restore-backup-confirm").click();
  await page.getByTestId("restore-auth-id").fill(request.url);
  if (
    !document.querySelector<HTMLButtonElement>(
      '[data-testid="restore-personal-confirm"]',
    )?.disabled
  )
    await page.getByTestId("restore-personal-confirm").click();
  expect(await writeCount("auth.register")).toBe(0);
  // The request was obtained from this fixture's target client terminal, not from domain matching.
  await page.getByTestId("restore-source-confirm").click();
  await page.getByTestId("restore-personal-confirm").click();
  // Same as G02: wait out the fixture login without treating its exit code as success.
  await commands.tagFixtureFinishLogin("restore-ephemeral");
  await expect
    .poll(() => liveNode(restored.nodeId))
    .toMatchObject({
      machineKey: restored.machineKey,
      tags: [],
      user: { name: "alice" },
    });
  expect(await writeCount("auth.register")).toBe(1);
}, 180_000);

async function taggedDraft(name: string) {
  await commands.tagFixtureSeedPolicy(
    JSON.stringify({
      acls: allow,
      tagOwners: { "tag:old": [], "tag:next": [], "tag:extra": [] },
    }),
  );
  const target = await commands.tagFixtureCreateNode(name, ["tag:old"]);
  await connect();
  await editTags(target.nodeId);
  await page.getByTestId("node-tags-option-tag:next").click();
  await page.getByTestId("node-tags-remove-tag:old").click();
  return target;
}
async function reviewTagDraft() {
  await page.getByTestId("node-tags-confirm").click();
  await expect.element(page.getByTestId("node-tags-apply")).toBeVisible();
}
async function captured(upstreamRequests = 1) {
  await expect
    .poll(() => commands.tagNetworkState(), { timeout: 10_000 })
    .toMatchObject({ captured: true, hits: 1, upstreamRequests });
}
test("A07: a failed fresh read sends no SetTags and retry reviews the remote full-set change", async () => {
  const target = await taggedDraft("read-failure-device");
  await commands.tagFixtureSetTags(target.nodeId, ["tag:old", "tag:extra"]);
  await commands.tagNetworkIntercept({
    method: "GET",
    pathPattern: "^/api/v1/node$",
    failure: "fresh read unavailable",
  });
  await page.getByTestId("node-tags-confirm").click();
  await expect.element(page.getByTestId("node-tags-read-error")).toBeVisible();
  await captured(0);
  expect(await writeCount()).toBe(0);
  expect((await liveNode(target.nodeId))?.tags).toEqual([
    "tag:extra",
    "tag:old",
  ]);
  await commands.tagNetworkRelease();
  await page.getByTestId("node-tags-confirm").click();
  await expect.element(page.getByTestId("node-tags-notice")).toBeVisible();
  expect(document.querySelector('[data-testid="node-tags-apply"]')).toBeNull();
  expect(await writeCount()).toBe(0);
});

test("A11: a network-intercepted never-forwarded write leaves real storage unchanged and is not automatically retried", async () => {
  const target = await taggedDraft("never-forwarded-device");
  await reviewTagDraft();
  await commands.tagNetworkIntercept({
    method: "POST",
    pathPattern: `/api/v1/node/${target.nodeId}/tags$`,
    failure: "not forwarded by fixture",
  });
  await page.getByTestId("node-tags-apply").click();
  await captured(0);
  await expect
    .element(page.getByTestId("node-tags-error"))
    .toMatchTextContent(getProductCopy("en-US").writeOutcomeVerifyInDevices);
  await expect.element(page.getByTestId("node-tags-confirm")).toBeEnabled();
  await expect
    .element(page.getByTestId("node-tags-unresolved"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("node-tags-release"))
    .not.toBeInTheDocument();
  expect((await liveNode(target.nodeId))?.tags).toEqual(["tag:old"]);
  expect(await writeCount()).toBe(1);
  expect(
    (await commands.tagNetworkObservations()).filter(
      (entry) => entry.method === "POST" && entry.path.endsWith("/tags"),
    ),
  ).toMatchObject([{ upstreamRequests: 0 }]);
  // Only the fixture proves non-delivery; the application must keep the HTTP failure uncertain.
  expect(["unknown", "possibly-applied"]).toContain(
    session.feedback.actionOutcome("node-tags")?.status,
  );
  await page.getByTestId("node-tags-reread").click();
  await expect.element(page.getByTestId("node-tags-confirm")).toBeEnabled();
  expect(await writeCount()).toBe(1);
});

test("A11/A16/A34: lost response stays uncertain across matching readback and maintenance reopen without blocking or replaying", async () => {
  const target = await taggedDraft("lost-response-device");
  await reviewTagDraft();
  await commands.tagNetworkIntercept({
    method: "POST",
    pathPattern: `/api/v1/node/${target.nodeId}/tags$`,
    failure: { drop: true },
  });
  await page.getByTestId("node-tags-apply").click();
  await captured();
  await commands.tagNetworkRelease();
  await expect
    .element(page.getByTestId("node-tags-error"))
    .toMatchTextContent(getProductCopy("en-US").writeOutcomeVerifyInDevices);
  const original = structuredClone(session.feedback.actionOutcome("node-tags"));
  expect(original?.status).toBe("unknown");
  await page.getByTestId("node-tags-reread").click();
  await expect.element(page.getByTestId("node-tags-confirm")).toBeEnabled();
  expect(session.snapshot.nodeById(target.nodeId)?.tags).toEqual(["tag:next"]);
  expect(session.feedback.actionOutcome("node-tags")).toEqual(original);
  await expect
    .element(page.getByTestId("node-tags-result"))
    .not.toBeInTheDocument();
  expect(await writeCount()).toBe(1);
  await page.getByTestId("node-tags-verify").click();
  await expect
    .element(page.getByTestId("node-tags-dialog"))
    .not.toBeInTheDocument();
  await page.getByTestId("section-access").click();
  await page.getByTestId("tag-maintenance-tag:old").click();
  await expect
    .element(page.getByTestId("tag-maintenance-pending"))
    .not.toBeInTheDocument();
  await page.getByTestId("tag-migration-existing").click();
  await page.getByTestId("tag-migration-target").fill("tag:next");
  await expect
    .element(page.getByTestId(`tag-migration-node-${target.nodeId}`))
    .toBeVisible();
  await userEvent.keyboard("{Escape}");
  await editTags(target.nodeId);
  await expect
    .element(page.getByTestId("node-tags-error"))
    .toMatchTextContent(getProductCopy("en-US").writeOutcomeVerifyInDevices);
  await expect.element(page.getByTestId("node-tags-confirm")).toBeEnabled();
  await expect
    .element(page.getByTestId("node-tags-release"))
    .not.toBeInTheDocument();
  expect(await writeCount()).toBe(1);
});

test("A11: confirmed 200 followed by a failed GET remains confirmed with a separate refresh warning", async () => {
  const target = await taggedDraft("confirmed-refresh-device");
  await reviewTagDraft();
  await commands.tagNetworkIntercept({
    method: "POST",
    pathPattern: `/api/v1/node/${target.nodeId}/tags$`,
  });
  await page.getByTestId("node-tags-apply").click();
  await captured();
  // Installing the next gate releases the captured write and then intercepts its post-write read.
  await commands.tagNetworkIntercept({
    method: "GET",
    pathPattern: "^/api/v1/node$",
    failure: "post-write read unavailable",
  });
  await captured(0);
  await expect.element(page.getByTestId("node-tags-result")).toBeVisible();
  await expect
    .poll(
      () =>
        document.querySelector('[data-testid="node-tags-result"]')?.textContent,
    )
    .toMatch(/list refresh failed/);
  expect(session.feedback.actionOutcome("node-tags")?.status).toBe("confirmed");
  expect((await liveNode(target.nodeId))?.tags).toEqual(["tag:next"]);
  expect(await writeCount()).toBe(1);
  expect(
    (await commands.tagNetworkObservations()).filter(
      (entry) => entry.method === "POST" && entry.path.endsWith("/tags"),
    ),
  ).toMatchObject([{ upstreamRequests: 1, status: 200 }]);
});

test.each(["slow-success", "failed-read"] as const)(
  "G27 real inventory %s: preserve the confirmed key through reads without recreating it",
  async (scenario) => {
    await connect();
    await page.getByTestId("section-invites").click();
    await page.getByTestId("open-create-invite").click();
    await page.getByTestId("invite-user").selectOptions("1");
    await commands.tagNetworkIntercept({
      method: "POST",
      pathPattern: "^/api/v1/preauthkey$",
    });
    await page.getByTestId("create-invite").click();
    await captured();
    const creation = (await commands.tagNetworkObservations()).find(
      (call) => call.method === "POST" && call.path === "/api/v1/preauthkey",
    );
    expect(creation).toMatchObject({ status: 200, upstreamRequests: 1 });
    expect(await writeCount("preauthkey.create")).toBe(1);
    const inventory = (await commands.tagFixtureSnapshot()).keys;
    expect(inventory).toHaveLength(1);
    const keyId = inventory[0]?.id;
    expect(keyId !== undefined).toBe(true);
    if (scenario === "failed-read") {
      // Replacing the captured POST gate releases its real success only after GET failure is armed.
      await commands.tagNetworkIntercept({
        method: "GET",
        pathPattern: "^/api/v1/preauthkey$",
        failure: "G27 injected inventory read unavailable",
      });
      await captured(0);
    } else {
      await commands.tagNetworkRelease();
    }
    await expect
      .poll(
        () =>
          document.querySelector('[data-testid="invite-create-dialog"]') ===
          null,
      )
      .toBe(true);
    const secret = session.deviceSetup.getSnapshot().lastCreatedInvite;
    expect(secret.length > 0).toBe(true);
    expect(session.feedback.actionOutcome("create-invite")).toMatchObject({
      status: "confirmed",
      refresh: scenario === "failed-read" ? "failed" : "succeeded",
    });
    let duringRead: object;
    if (scenario === "failed-read") {
      await expect
        .element(page.getByTestId("invite-created-refresh-failed"))
        .toMatchTextContent(
          "Do not create another key just to refresh the list.",
        );
      const failure = (await commands.tagNetworkObservations()).find(
        (call) =>
          call.method === "GET" &&
          call.path === "/api/v1/preauthkey" &&
          call.status === 503,
      );
      expect(failure).toMatchObject({ status: 503, upstreamRequests: 0 });
      duringRead = {
        injected: true,
        readStatus: failure?.status,
        upstreamRequests: failure?.upstreamRequests,
        identityStatus: session.snapshot.getSnapshot().segmentStatus.identity,
        warningVisible:
          document.querySelector(
            '[data-testid="invite-created-refresh-failed"]',
          ) !== null,
      };
      expect(
        session.deviceSetup.getSnapshot().lastCreatedInvite === secret,
      ).toBe(true);
      expect(
        (page.getByTestId("copy-created-invite").element() as HTMLButtonElement)
          .disabled,
      ).toBe(false);
      expect(await writeCount("preauthkey.create")).toBe(1);
      await commands.tagNetworkRelease();
      await page.getByTestId("refresh-auth-keys").click();
    } else {
      await commands.tagNetworkIntercept({
        method: "GET",
        pathPattern: "^/api/v1/preauthkey$",
      });
      await page.getByTestId("refresh-auth-keys").click();
      try {
        await captured();
        expect(session.snapshot.getSnapshot().segmentStatus.identity).toBe(
          "loading",
        );
        expect(
          session.snapshot.getSnapshot().refreshErrors.identity,
        ).toBeUndefined();
        await expect
          .element(page.getByTestId("created-invite-status"))
          .toMatchTextContent("not verified");
        expect(
          (page.getByTestId("refresh-auth-keys").element() as HTMLButtonElement)
            .disabled,
        ).toBe(true);
        expect(
          (
            page
              .getByTestId("copy-created-invite")
              .element() as HTMLButtonElement
          ).disabled,
        ).toBe(false);
        expect(
          document.querySelector(
            '[data-testid="invite-created-refresh-failed"]',
          ) === null,
        ).toBe(true);
        expect(
          session.deviceSetup.getSnapshot().lastCreatedInvite === secret,
        ).toBe(true);
        expect(await writeCount("preauthkey.create")).toBe(1);
        duringRead = {
          injected: false,
          identityStatus: session.snapshot.getSnapshot().segmentStatus.identity,
          warningVisible: false,
        };
      } finally {
        await commands.tagNetworkRelease();
      }
    }
    await expect
      .poll(() => session.snapshot.getSnapshot().segmentStatus.identity)
      .toBe("ready");
    await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
    expect(
      session.snapshot.getSnapshot().refreshErrors.identity,
    ).toBeUndefined();
    expect(
      document.querySelector(
        '[data-testid="invite-created-refresh-failed"]',
      ) === null,
    ).toBe(true);
    expect(
      document.querySelector('[data-testid="created-invite-status"]') === null,
    ).toBe(true);
    expect(session.deviceSetup.getSnapshot().lastCreatedInvite === secret).toBe(
      true,
    );
    expect(
      session.snapshot
        .getSnapshot()
        .snapshot.preAuthKeys.some((key) => key.id === keyId),
    ).toBe(true);
    expect(await writeCount("preauthkey.create")).toBe(1);
    console.info(
      "G27 real inventory evidence",
      scenario,
      JSON.stringify({
        creation: {
          status: creation?.status,
          upstreamRequests: creation?.upstreamRequests,
        },
        duringRead,
        identityStatus: session.snapshot.getSnapshot().segmentStatus.identity,
        secretRetained:
          session.deviceSetup.getSnapshot().lastCreatedInvite === secret,
        creationRequests: await writeCount("preauthkey.create"),
      }),
    );
  },
);

test("A33: lost create response plus an identical concurrent key is inventory only, never claimed or revoked; a new operation needs a separate click", async () => {
  await commands.tagFixtureSeedPolicy(
    JSON.stringify({ acls: allow, tagOwners: { "tag:unknown-create": [] } }),
  );
  await connect();
  await page.getByTestId("section-invites").click();
  await page.getByTestId("open-create-invite").click();
  await page.getByTestId("invite-tags-option-tag:unknown-create").click();
  await page.getByTestId("invite-reusable").click();
  const selectedUser = document.querySelector<HTMLSelectElement>(
    '[data-testid="invite-user"]',
  )?.value;
  expect(selectedUser).toBeDefined();
  await commands.tagNetworkIntercept({
    method: "POST",
    pathPattern: "^/api/v1/preauthkey$",
    failure: { drop: true },
  });
  await page.getByTestId("create-invite").click();
  await captured();
  const expiration = (await commands.tagNetworkCalls()).find(
    (call) => call.id === "preauthkey.create",
  )?.payload?.expiration;
  if (!expiration) throw new Error("Expected the observed creation expiration");
  await commands.tagFixtureConcurrentKey(
    ["tag:unknown-create"],
    expiration,
    selectedUser,
  );
  await commands.tagNetworkRelease();
  await expect.element(page.getByTestId("invite-create-unknown")).toBeVisible();
  await page.getByTestId("invite-create-verify").click();
  await expect
    .element(page.getByTestId("invite-create-dialog"))
    .not.toBeInTheDocument();
  await page.getByTestId("refresh-auth-keys").click();
  await expect.element(page.getByTestId("refresh-auth-keys")).toBeEnabled();
  const inventory = (await commands.tagFixtureSnapshot()).keys;
  expect(inventory).toHaveLength(2);
  expect(new Set(inventory.map((key) => key.id)).size).toBe(2);
  for (const key of inventory) {
    expect(key).toMatchObject({
      aclTags: ["tag:unknown-create"],
      reusable: true,
      ephemeral: false,
      user: { id: selectedUser },
    });
    expect(Date.parse(key.expiration)).toBe(Date.parse(expiration));
  }
  expect(
    document.querySelector('[data-testid="created-invite"] code'),
  ).toBeNull();
  expect(await writeCount("preauthkey.create")).toBe(1);
  expect(await writeCount("preauthkey.expire")).toBe(0);
  expect(await writeCount("preauthkey.delete")).toBe(0);
  await page.getByTestId("open-create-invite").click();
  expect(await writeCount("preauthkey.create")).toBe(1);
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("invite-created-not-joined"))
    .toBeVisible();
  expect(await writeCount("preauthkey.create")).toBe(2);
  expect((await commands.tagFixtureSnapshot()).keys).toHaveLength(3);
});

test.each(["expire", "delete"] as const)(
  "A16/A17: the %s completion barrier waits for its held response before continuing",
  async (action) => {
    const target = await commands.tagFixtureConcurrentKey(
      ["tag:held-stop"],
      new Date(Date.now() + 3_600_000).toISOString(),
    );
    await connect();
    await page.getByTestId("section-invites").click();
    await page.getByTestId(`invite-actions-trigger-${target.id}`).click();
    await page.getByTestId(`${action}-invite-${target.id}`).click();
    await commands.tagNetworkIntercept({
      method: action === "expire" ? "POST" : "DELETE",
      pathPattern: `^/api/v1/preauthkey${action === "expire" ? "/expire" : ""}$`,
    });
    let completed = false;
    const confirmation = confirmKeyAction(action).then(() => {
      completed = true;
    });
    try {
      await captured();
      await expect
        .element(page.getByTestId("confirm-invite-action"))
        .toBeDisabled();
      expect(completed).toBe(false);
    } finally {
      await commands.tagNetworkRelease();
      await confirmation;
    }
    expect(completed).toBe(true);
    expect(session.feedback.actionOutcome("invite-action")?.status).toBe(
      "confirmed",
    );
    expect(await writeCount(`preauthkey.${action}`)).toBe(1);
    const key = (await commands.tagFixtureSnapshot()).keys.find(
      (item) => item.id === target.id,
    );
    if (action === "expire") {
      expect(key).toBeDefined();
      expect(Date.parse(key?.expiration ?? "")).toBeLessThanOrEqual(Date.now());
    } else expect(key).toBeUndefined();
  },
);

test.each(["expire", "delete"] as const)(
  "A16/A17/A34: a lost %s response keeps a list-verification notice while fresh retirement inventory remains available, without replaying or touching another key",
  async (action) => {
    const tag = `tag:stop-${action}`;
    await commands.tagFixtureSeedPolicy(JSON.stringify({ acls: allow }));
    const target = await commands.tagFixtureConcurrentKey(
      [tag],
      new Date(Date.now() + 3_600_000).toISOString(),
    );
    // An expired real key keeps the observed tag visible after deletion without an available entry.
    const witness = await commands.tagFixtureConcurrentKey(
      [tag],
      "2000-01-01T00:00:00Z",
    );
    const before = (await commands.tagFixtureSnapshot()).keys.find(
      (key) => key.id === witness.id,
    );
    expect(before).toBeDefined();
    await connect();
    await page.getByTestId("section-invites").click();
    await page.getByTestId(`invite-actions-trigger-${target.id}`).click();
    await page.getByTestId(`${action}-invite-${target.id}`).click();
    const method = action === "expire" ? "POST" : "DELETE";
    const path = `/api/v1/preauthkey${action === "expire" ? "/expire" : ""}`;
    await commands.tagNetworkIntercept({
      method,
      pathPattern: `^${path}$`,
      failure: { drop: true },
    });
    await page.getByTestId("confirm-invite-action").click();
    await captured();
    await commands.tagNetworkRelease();
    // A dropped response may remain pending until the transport timeout; wait for its notice.
    await expect
      .poll(() => session.feedback.actionOutcome("invite-action")?.status, {
        timeout: 20_000,
      })
      .toBe("unknown");
    await expect
      .element(page.getByTestId("invite-stop-notice"))
      .toMatchTextContent(getProductCopy("en-US").inviteStopUnresolved);
    await expect
      .element(page.getByTestId("confirm-invite-action"))
      .toBeEnabled();
    const originalOutcome = structuredClone(
      session.feedback.actionOutcome("invite-action"),
    );
    expect(
      /hskey-auth-|hskey-authreq-|tskey-/.test(JSON.stringify(originalOutcome)),
      "Stop diagnostics must not retain a credential or authentication URL",
    ).toBe(false);
    await page.getByTestId("invite-stop-verify").click();
    await expect
      .element(page.getByTestId("confirm-invite-action"))
      .not.toBeInTheDocument();
    await page.getByTestId("refresh-auth-keys").click();
    await expect.element(page.getByTestId("refresh-auth-keys")).toBeEnabled();
    expect(session.feedback.actionOutcome("invite-action")).toEqual(
      originalOutcome,
    );
    const observed = await commands.tagFixtureSnapshot();
    const stopped = observed.keys.find((key) => key.id === target.id);
    if (action === "expire") {
      expect(stopped).toBeDefined();
      expect(Date.parse(stopped?.expiration ?? "")).toBeLessThanOrEqual(
        Date.now(),
      );
    } else expect(stopped).toBeUndefined();
    expect(observed.keys.find((key) => key.id === witness.id)).toEqual(before);
    if (action === "expire")
      await expect
        .element(page.getByTestId(`invite-${target.id}`))
        .toBeVisible();
    else
      await expect
        .element(page.getByTestId(`invite-${target.id}`))
        .not.toBeInTheDocument();
    const oneWrite = async () => {
      expect(
        (await commands.tagNetworkCalls()).filter(
          (call) => call.method !== "GET",
        ),
      ).toMatchObject([{ id: `preauthkey.${action}` }]);
      expect(
        (await commands.tagNetworkObservations()).filter(
          (entry) => entry.method === method && entry.path === path,
        ),
      ).toMatchObject([{ upstreamRequests: 1 }]);
    };
    const openRetirement = async () => {
      await page.getByTestId("section-access").click();
      await page.getByTestId(`tag-maintenance-${tag}`).click();
      await page.getByTestId("tag-maintenance-retire").click();
      await expect
        .element(page.getByTestId("tag-retirement-external"))
        .toBeEnabled();
      await page.getByTestId("tag-retirement-external").click();
    };
    await openRetirement();
    await expect
      .element(page.getByTestId("tag-maintenance-pending"))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByTestId("tag-retirement-result"))
      .toHaveTextContent(getProductCopy("en-US").policyRetirementObserved);
    await oneWrite();
    await page.getByTestId(`maintenance-invites-${tag}`).click();
    await expect.poll(() => window.location.pathname).toBe("/invites");
    expect(new URLSearchParams(window.location.search).get("tag")).toBe(tag);
    await expect.element(page.getByTestId("invite-stop-notice")).toBeVisible();
    await page.getByTestId("refresh-auth-keys").click();
    await expect.element(page.getByTestId("refresh-auth-keys")).toBeEnabled();
    expect(session.feedback.actionOutcome("invite-action")).toEqual(
      originalOutcome,
    );
    await openRetirement();
    await expect
      .element(page.getByTestId("tag-maintenance-pending"))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByTestId("tag-retirement-result"))
      .toHaveTextContent(getProductCopy("en-US").policyRetirementObserved);
    expect((await commands.tagFixtureSnapshot()).keys).toEqual(observed.keys);
    await oneWrite();
  },
);

test("A24/A34: a real node-persistence HTTP400 with matching memory never becomes success; restart exposes the durable old tags", async () => {
  const target = await taggedDraft("ui-late-node");
  await commands.tagFixtureStopClient("ui-late-node");
  await commands.tagFixtureInjectFailure("node-tags", target.nodeId);
  await reviewTagDraft();
  await page.getByTestId("node-tags-apply").click();
  await expect
    .element(page.getByTestId("node-tags-error"))
    .toMatchTextContent(getProductCopy("en-US").writeOutcomeVerifyInDevices);
  const original = structuredClone(session.feedback.actionOutcome("node-tags"));
  expect(original).toMatchObject({
    status: "possibly-applied",
    failure: { status: 400 },
  });
  await expect.element(page.getByTestId("node-tags-confirm")).toBeEnabled();
  await expect
    .element(page.getByTestId("node-tags-result"))
    .not.toBeInTheDocument();
  expect((await liveNode(target.nodeId))?.tags).toEqual(["tag:next"]);
  expect(
    JSON.parse(
      (await commands.tagFixtureDurableNode(target.nodeId)).tags ?? "[]",
    ),
  ).toEqual(["tag:old"]);
  await page.getByTestId("node-tags-reread").click();
  await expect.element(page.getByTestId("node-tags-confirm")).toBeEnabled();
  expect(session.snapshot.nodeById(target.nodeId)?.tags).toEqual(["tag:next"]);
  expect(session.feedback.actionOutcome("node-tags")).toEqual(original);
  await expect
    .element(page.getByTestId("node-tags-result"))
    .not.toBeInTheDocument();
  await commands.tagFixtureRestart(true);
  expect((await liveNode(target.nodeId))?.tags).toEqual(["tag:old"]);
  await page.getByTestId("node-tags-cancel").click();
  await editTags(target.nodeId);
  await expect
    .element(page.getByTestId("node-tags-error"))
    .toMatchTextContent(getProductCopy("en-US").writeOutcomeVerifyInDevices);
  await expect
    .element(page.getByTestId("node-tags-release"))
    .not.toBeInTheDocument();
  await expect.element(page.getByTestId("node-tags-confirm")).toBeEnabled();
  expect(session.feedback.actionOutcome("node-tags")).toEqual(original);
  expect(await writeCount()).toBe(1);
});

test("A30: real AuthRegister failure after consumption does not replay the request or claim restored completion", async () => {
  const route = "10.77.0.0/24";
  await commands.tagFixtureSeedPolicy(
    JSON.stringify({
      acls: allow,
      tagOwners: { "tag:restore-late": [] },
      autoApprovers: { routes: { [route]: ["alice@"] } },
    }),
  );
  const target = await commands.tagFixtureCreateNode(
    "ui-late-auth",
    ["tag:restore-late"],
    true,
    [route],
  );
  await connect();
  await page.getByTestId("section-devices").click();
  await page.getByTestId(`machine-actions-trigger-${target.nodeId}`).click();
  await page.getByTestId(`restore-personal-action-${target.nodeId}`).click();
  await commands.tagFixtureInjectFailure("auth-register", target.nodeId);
  const request = await commands.tagFixtureLogin("ui-late-auth", [route]);
  await page.getByTestId("restore-user").selectOptions("1");
  await page.getByTestId("restore-login-server").fill(request.loginServer);
  await page.getByTestId("restore-server-confirm").click();
  await page.getByTestId("restore-backup-confirm").click();
  await page.getByTestId("restore-auth-id").fill(request.url);
  await page.getByTestId("restore-source-confirm").click();
  await page.getByTestId("restore-personal-confirm").click();
  await expect
    .element(page.getByTestId("register-pending-node-error"))
    .toMatchTextContent(getProductCopy("en-US").writeOutcomeVerifyInDevices);
  const original = structuredClone(
    session.feedback.actionOutcome("register-pending-node"),
  );
  expect(original).toMatchObject({
    status: "possibly-applied",
    failure: { status: 500 },
  });
  await expect.element(page.getByTestId("restore-auth-id")).toHaveValue("");
  await expect
    .element(page.getByTestId("restore-personal-confirm"))
    .toBeDisabled();
  expect(await commands.tagFixtureFinishLogin("ui-late-auth")).toBe(0);
  expect((await liveNode(target.nodeId))?.tags).toEqual([]);
  expect(
    (await commands.tagFixtureDurableNode(target.nodeId)).auth_key_id,
  ).toBeNull();
  expect(document.querySelector('[data-testid="restore-result"]')).toBeNull();
  await expect
    .element(page.getByTestId("restore-unresolved"))
    .not.toBeInTheDocument();
  await page.getByTestId("restore-readonly-check").click();
  await expect
    .element(page.getByTestId("restore-readonly-check"))
    .toBeEnabled();
  expect(session.snapshot.nodeById(target.nodeId)).toMatchObject({
    machineKey: target.machineKey,
    tags: [],
    user: { name: "alice" },
  });
  expect(session.feedback.actionOutcome("register-pending-node")).toEqual(
    original,
  );
  await expect
    .element(page.getByTestId("register-pending-node-error"))
    .toMatchTextContent(getProductCopy("en-US").writeOutcomeVerifyInDevices);
  await expect.element(page.getByTestId("restore-auth-id")).toHaveValue("");
  await expect
    .element(page.getByTestId("restore-personal-confirm"))
    .toBeDisabled();
  expect(await writeCount("auth.register")).toBe(1);
  await page.getByTestId("register-pending-node-verify").click();
  await expect
    .element(page.getByTestId("add-device-dialog"))
    .not.toBeInTheDocument();
  expect(await writeCount("auth.register")).toBe(1);
  await commands.tagFixtureStopClient("ui-late-auth");
  await commands.tagFixtureRestart(true);
  expect(await liveNode(target.nodeId)).toMatchObject({
    machineKey: target.machineKey,
    tags: [],
    user: { name: "alice" },
  });
  expect(
    (await commands.tagNetworkObservations()).filter(
      (entry) =>
        entry.method === "POST" && entry.path === "/api/v1/auth/register",
    ),
  ).toMatchObject([{ status: 500, upstreamRequests: 1 }]);
});

async function lockSession() {
  const result = await session.auth.lock(
    session.auth.getSessionSnapshot()?.identity ?? null,
  );
  expect(result.ok).toBe(true);
  await expect.element(page.getByTestId("profile-option-new")).toBeVisible();
}
async function unlockFixture() {
  await page.getByTestId("profile-option-Tag lifecycle fixture").click();
  await page.getByTestId("unlock-passphrase").fill(password);
  await page.getByTestId("unlock-submit").click();
  await expect.element(page.getByTestId("section-home")).toBeVisible();
}

test.each(["read", "write"] as const)(
  "A19: a held %s response cannot revive confirmation after locking and same-server unlock",
  async (kind) => {
    const target = await taggedDraft(`same-session-${kind}`);
    if (kind === "write") await reviewTagDraft();
    await commands.tagNetworkIntercept({
      method: kind === "read" ? "GET" : "POST",
      pathPattern:
        kind === "read"
          ? "^/api/v1/node$"
          : `/api/v1/node/${target.nodeId}/tags$`,
    });
    await page
      .getByTestId(kind === "read" ? "node-tags-confirm" : "node-tags-apply")
      .click();
    await captured();
    const old = session.tagLifecycle.captureScope();
    await lockSession();
    await commands.tagNetworkRelease();
    await unlockFixture();
    expect(session.tagLifecycle.isCurrent(old)).toBe(false);
    expect(
      document.querySelector('[data-testid="node-tags-apply"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="node-tags-result"]'),
    ).toBeNull();
    expect(await writeCount()).toBe(kind === "write" ? 1 : 0);
    expect((await liveNode(target.nodeId))?.tags).toEqual(
      kind === "write" ? ["tag:next"] : ["tag:old"],
    );
  },
);

test("A19: A to B to A with the same node ID never applies a held A completion to server B", async () => {
  const target = await taggedDraft("server-a-device");
  const alternate = await commands.tagFixtureSecondServer(target.nodeId);
  expect((await commands.tagFixtureSecondSnapshot()).nodes[0].id).toBe(
    target.nodeId,
  );
  await reviewTagDraft();
  await commands.tagNetworkIntercept({
    method: "POST",
    pathPattern: `/api/v1/node/${target.nodeId}/tags$`,
  });
  await page.getByTestId("node-tags-apply").click();
  await captured();
  const old = session.tagLifecycle.captureScope();
  await lockSession();
  await page.getByTestId("profile-option-new").click();
  await page.getByTestId("connect-profile-name").fill("Tag alternate fixture");
  await page.getByTestId("connect-server-url").fill(alternate.baseUrl);
  await page.getByTestId("connect-api-key").fill(alternate.apiKey);
  await page.getByTestId("connect-password").fill(password);
  await page.getByTestId("connect-password-confirm").fill(password);
  await page.getByTestId("connect-save-unlock").click();
  await expect.element(page.getByTestId("section-home")).toBeVisible();
  await commands.tagNetworkRelease();
  await page.getByTestId("section-devices").click();
  await expect
    .poll(() => session.snapshot.nodeById(target.nodeId)?.name)
    .toBe("other-server-device");
  expect(session.snapshot.nodeById(target.nodeId)?.tags).toEqual(["tag:old"]);
  expect(document.querySelector('[data-testid="node-tags-result"]')).toBeNull();
  expect(session.feedback.actionOutcome("node-tags")).toBeUndefined();
  expect(
    (await commands.tagFixtureSecondSnapshot()).calls.filter(
      (call) => call.id === "node.setTags",
    ),
  ).toHaveLength(0);
  await lockSession();
  await unlockFixture();
  expect(session.tagLifecycle.isCurrent(old)).toBe(false);
  expect(document.querySelector('[data-testid="node-tags-apply"]')).toBeNull();
  expect(await writeCount()).toBe(1);
  expect((await liveNode(target.nodeId))?.tags).toEqual(["tag:next"]);
});

test("A32: a comment-only remote policy change is read before publication and cannot be overwritten by a tag-only confirmation", async () => {
  const original = JSON.stringify({ acls: allow });
  await commands.tagFixtureSeedPolicy(original);
  await commands.tagFixtureConcurrentKey(
    ["tag:policy-race"],
    new Date(Date.now() + 3_600_000).toISOString(),
  );
  await connect();
  await page.getByTestId("section-access").click();
  await page.getByTestId("tag-open-tag:policy-race").click();
  await page.getByTestId("tag-declare").click();
  await page.getByTestId("tag-detail-close").click();
  await page.getByTestId("save-policy").click();
  await expect
    .element(page.getByTestId("policy-publication-review"))
    .toBeVisible();
  const remote = `{\n// externally reviewed comment\n"acls":${JSON.stringify(allow)}\n}`;
  await commands.tagFixtureSeedPolicy(remote);
  await page.getByTestId("policy-publication-confirm").click();
  await expect
    .poll(
      () =>
        document.querySelector('[data-testid="policy-publication-current"]')
          ?.textContent,
    )
    .toContain("externally reviewed comment");
  await expect
    .element(page.getByTestId("policy-publication-confirm"))
    .toBeDisabled();
  expect(await writeCount("policy.set")).toBe(0);
  expect((await commands.tagFixtureSnapshot()).policy).toBe(remote);
});
