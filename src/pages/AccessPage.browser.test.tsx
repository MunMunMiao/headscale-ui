import "fake-indexeddb/auto";
import type { FetchHandle } from "@defjs/core";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { setLocale } from "@/i18n";
import { getProductCopy } from "@/i18n/product-copy";
import { expectNetworkTokensLtr } from "@/test/bidi";
import { authenticateTestSession, prepareTestSession, renderSessionPage } from "@/test/session";
import AccessPage from "./AccessPage";

const extensions = {
  hosts: { office: "10.0.0.0/8" },
  ssh: [{ action: "accept", src: ["group:ops"], dst: ["tag:server"], users: ["root"] }],
  autoApprovers: { routes: { "10.0.0.0/8": ["group:ops"] } },
  tests: [{ src: "alice@", accept: ["tag:server:22"] }],
};
function policy() {
  return {
    groups: { "group:ops": ["alice@"] },
    tagOwners: { "tag:server": ["group:ops"] },
    acls: [
      { action: "accept", src: ["group:ops"], dst: ["tag:server:22"] },
      { action: "accept", src: ["*"], dst: ["*:*"] },
    ],
    ...extensions,
  };
}
async function policyBody(request: Request): Promise<{ policy: string }> {
  const body: unknown = await request.json();
  if (
    typeof body === "object" &&
    body !== null &&
    "policy" in body &&
    typeof body.policy === "string"
  )
    return { policy: body.policy };
  throw new Error("Malformed policy request body");
}
const defaultUsers: Record<string, unknown>[] = [
  { id: "1", name: "alice", displayName: "Alice", email: "alice@example.com" },
  { id: "2", name: "bob", displayName: "Bob" },
  { id: "3", name: "tagged-devices" },
];
async function setup(
  initial: Record<string, unknown> | string = policy(),
  users: Record<string, unknown>[] = defaultUsers,
) {
  const writes: { policy: string }[] = [];
  const checks: { policy: string }[] = [];
  const reads: string[] = [];
  let checkFailure = "";
  let failure = "";
  let pending: Promise<void> | undefined;
  let acceptedPolicy: string | undefined;
  const policyText = typeof initial === "string" ? initial : JSON.stringify(initial);
  const transport: FetchHandle = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.method === "POST" && new URL(request.url).pathname === "/api/v1/policy/check") {
      checks.push(await policyBody(request));
      return checkFailure
        ? Response.json({ message: checkFailure }, { status: 400 })
        : Response.json({});
    }
    if (request.method === "GET") {
      reads.push(new URL(request.url).pathname);
      const values: Record<string, unknown> = {
        "/api/v1/health": { databaseConnectivity: true, serverReachable: true },
        "/version": { version: "0.29.4" },
        "/api/v1/user": { users },
        "/api/v1/node": { nodes: [] },
        "/api/v1/preauthkey": { preAuthKeys: [] },
        "/api/v1/apikey": { apiKeys: [] },
        "/api/v1/policy": { policy: policyText },
      };
      return Response.json(values[new URL(request.url).pathname]);
    }
    if (request.method !== "PUT" || new URL(request.url).pathname !== "/api/v1/policy") {
      throw new Error(`Unexpected policy request: ${request.method} ${request.url}`);
    }
    const body = await policyBody(request);
    writes.push(body);
    if (pending) await pending;
    if (failure) return Response.json({ message: failure }, { status: 500 });
    return Response.json(acceptedPolicy === undefined ? body : { policy: acceptedPolicy });
  };
  const session = await prepareTestSession(transport);
  await setLocale("en-US");
  await authenticateTestSession(session);
  const view = await renderSessionPage(session, <AccessPage />, "/access");
  await expect
    .poll(() => session.snapshot.getSnapshot().snapshot.health?.serverReachable)
    .toBe(true);
  await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
  return {
    client: session.client.createClient(),
    session,
    writes,
    checks,
    reads,
    ...view,
    fail: (message: string) => {
      failure = message;
    },
    failCheck: (message: string) => {
      checkFailure = message;
    },
    hold: (promise: Promise<void>) => {
      pending = promise;
    },
    accept: (text: string) => {
      acceptedPolicy = text;
    },
  };
}
afterEach(() => vi.restoreAllMocks());
// A click that runs inside the current task, so no re-render or timer can slip in between.
function domClick(element: Element) {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}
// Removing the focused row makes the dialog take focus back again on the next frame, which
// would close a picker opened before it.
function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}
// An uncaught error in an event handler would otherwise only surface as a run-level failure.
function captureErrors() {
  const errors: unknown[] = [];
  const record = (event: ErrorEvent) => {
    errors.push(event.error);
    event.preventDefault();
  };
  window.addEventListener("error", record);
  return { errors, stop: () => window.removeEventListener("error", record) };
}

test("saving adopts the server accepted policy while preserving a newer local name input", async () => {
  const { session, hold, accept, writes } = await setup();
  const pending = Promise.withResolvers<void>();
  hold(pending.promise);
  const accepted = JSON.stringify({ ...policy(), hosts: { accepted: "10.42.0.0/16" } });
  accept(accepted);
  await page.getByTestId("team-card-group:ops").click();
  await page.getByTestId("team-member-remove-alice@").click();
  await page.getByTestId("team-detail-close").click();
  await page.getByTestId("unsaved-changes-save").click();
  await expect.poll(() => writes.length).toBe(1);
  await page.getByTestId("team-name-input").fill("unsubmitted-name");
  pending.resolve();
  await expect.poll(() => session.feedback.isActionPending("save-policy")).toBe(false);
  expect(session.policy.getSnapshot().policyDraft).toBe(accepted);
  expect(session.snapshot.getSnapshot().snapshot.policy?.policy).toBe(accepted);
  await expect.element(page.getByTestId("team-name-input")).toHaveValue("unsubmitted-name");
  expect(session.policy.getSnapshot().teamDetailOpen).toBe(true);
});

test("save-and-close cannot close an editor with a newer unsubmitted name", async () => {
  const { session, hold, writes } = await setup();
  const pending = Promise.withResolvers<void>();
  hold(pending.promise);
  await page.getByTestId("team-card-group:ops").click();
  await page.getByTestId("team-member-remove-alice@").click();
  await page.getByTestId("team-detail-close").click();
  await page.getByTestId("unsaved-changes-save").click();
  await expect.poll(() => writes.length).toBe(1);
  await page.getByTestId("team-name-input").fill("new-local-name");
  pending.resolve();
  await expect.poll(() => session.feedback.isActionPending("save-policy")).toBe(false);
  expect(session.policy.getSnapshot().teamDetailOpen).toBe(true);
  await expect.element(page.getByTestId("team-name-input")).toHaveValue("new-local-name");
});

test("unreadable policies cannot be saved or replaced with templates and recover after a valid HuJSON refresh", async () => {
  const unreadable = '{"acls":[';
  const { session, writes } = await setup(unreadable);
  await expect.element(page.getByTestId("save-policy")).toBeDisabled();
  await expect.element(page.getByRole("alert")).toMatchTextContent(/policy.+safely/i);
  await expect.element(page.getByTestId("template-apply-small-team")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("empty-create-team")).not.toBeInTheDocument();
  expect(writes).toEqual([]);
  expect(session.policy.getSnapshot().policyDraft).toBe(unreadable);

  session.snapshot.applyPatch({
    policy: { policy: '{/* repaired */ "acls": [], "groups": {"group:repaired": ["alice@",],},}' },
  });
  await expect.element(page.getByTestId("save-policy")).toBeEnabled();
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("team-card-group:repaired")).toBeVisible();
  await page.getByTestId("save-policy").click();
  await expect.poll(() => writes.length).toBe(1);
  expect(JSON.parse(writes[0]?.policy ?? "null")).toMatchObject({
    groups: { "group:repaired": ["alice@"] },
    acls: [],
  });
});

test("editing an IP rule keeps its protocol and posture restrictions in the actual policy request", async () => {
  const { session, writes } = await setup({
    acls: [
      {
        action: "accept",
        src: ["alice@"],
        dst: ["10.0.0.0/8:22"],
        proto: "tcp",
        srcPosture: ["posture:managed"],
      },
    ],
  });
  const rule = session.policy.getSnapshot().policyRules[0];
  if (!rule) throw new Error("Missing restricted IP fixture");
  await page.getByTestId(`ip-rule-edit-${rule.id}`).click();
  await page.getByTestId(`ip-rule-ports-${rule.id}`).fill("443");
  await page.getByTestId(`ip-rule-save-${rule.id}`).click();
  await page.getByTestId("save-policy").click();
  await expect.poll(() => writes.length).toBe(1);
  expect(JSON.parse(writes[0]?.policy ?? "null").acls).toEqual([
    {
      action: "accept",
      src: ["alice@"],
      dst: ["10.0.0.0/8:443"],
      proto: "tcp",
      srcPosture: ["posture:managed"],
    },
  ]);
});

test("tag service controls cannot merge rules with protocol restrictions but explicit removal remains available", async () => {
  const { session, writes } = await setup({
    tagOwners: { "tag:server": ["alice@"] },
    acls: [
      { action: "accept", src: ["alice@"], dst: ["tag:server:22"], proto: "tcp" },
      { action: "accept", src: ["alice@"], dst: ["tag:server:53"], proto: "udp" },
    ],
  });
  await page.getByTestId("tag-card-tag:server").click();
  await expect.element(page.getByTestId("tag-accessor-svc-alice@-web")).toBeDisabled();
  await expect.element(page.getByTestId("tag-accessor-custom-alice@")).toBeDisabled();
  // A disabled control never reports a change, so the handlers never see a read-only accessor.
  domClick(page.getByTestId("tag-accessor-svc-alice@-web").element());
  domClick(page.getByTestId("tag-accessor-svc-alice@-all").element());
  expect(session.policy.isPolicyDirty).toBe(false);
  await expect
    .element(page.getByTestId("tag-accessor-row-alice@"))
    .toMatchTextContent(/additional restrictions/i);
  await page.getByTestId("tag-detail-close").click();
  expect(session.policy.isPolicyDirty).toBe(false);
  await page.getByTestId("save-policy").click();
  await expect.poll(() => writes.length).toBe(1);
  expect(JSON.parse(writes[0]?.policy ?? "null").acls).toEqual([
    { action: "accept", src: ["alice@"], dst: ["tag:server:22"], proto: "tcp" },
    { action: "accept", src: ["alice@"], dst: ["tag:server:53"], proto: "udp" },
  ]);
  await page.getByTestId("tag-card-tag:server").click();
  await page.getByTestId("tag-accessor-remove-alice@").click();
  expect(session.policy.policyPayload?.acls).toEqual([]);
});

test("wildcard and IP rules remain visible, trim edits, and persist deletion with top-level extensions", async () => {
  const { session, writes } = await setup();
  const rule = session.policy.getSnapshot().policyRules.find((entry) => entry.destination === "*");
  if (!rule) throw new Error("Missing wildcard fixture");
  await expect.element(page.getByTestId(`ip-rule-${rule.id}`)).toHaveTextContent("* → * · *");
  await page.getByTestId(`ip-rule-edit-${rule.id}`).click();
  await page.getByTestId(`ip-rule-source-${rule.id}`).fill("  10.0.0.0/8  ");
  await page.getByTestId(`ip-rule-destination-${rule.id}`).fill("  192.168.0.0/16  ");
  await page.getByTestId(`ip-rule-ports-${rule.id}`).fill("  443  ");
  await page.getByTestId(`ip-rule-save-${rule.id}`).click();
  await expect.element(page.getByTestId("save-policy-dirty-badge")).toBeVisible();
  await page.getByTestId("save-policy").click();
  await expect.poll(() => session.policy.isPolicyDirty).toBe(false);
  const saved = JSON.parse(writes[0]?.policy ?? "null");
  expect(saved).toMatchObject(extensions);
  expect(saved.acls).toContainEqual({
    action: "accept",
    src: ["10.0.0.0/8"],
    dst: ["192.168.0.0/16:443"],
  });
  await page.getByTestId(`ip-rule-remove-${rule.id}`).click();
  await expect.element(page.getByTestId("ip-rules-section")).not.toBeInTheDocument();
  await page.getByTestId("save-policy").click();
  await expect.poll(() => writes.length).toBe(2);
  expect(JSON.parse(writes[1]?.policy ?? "null").acls).toEqual([
    { action: "accept", src: ["group:ops"], dst: ["tag:server:22"] },
  ]);
});

test("an old save-and-close response cannot dismiss the next server's editor", async () => {
  const { session, client, hold, writes } = await setup();
  const response = Promise.withResolvers<void>();
  hold(response.promise);
  const saved = vi.spyOn(client, "execute");
  await page.getByTestId("team-card-group:ops").click();
  await page.getByTestId("team-member-remove-alice@").click();
  await page.getByTestId("team-detail-close").click();
  await page.getByTestId("unsaved-changes-save").click();
  await expect.poll(() => writes.length).toBe(1);
  session.snapshot.setAuthorized(false);
  session.policy.load(JSON.stringify(policy()));
  session.policy.setState({ teamDetailOpen: true, teamDetailCurrent: "group:ops" });
  session.snapshot.setAuthorized(true);
  session.feedback.clearAllActionFeedback();
  response.resolve();
  await saved.mock.results[0]?.value;
  await expect.element(page.getByTestId("team-name-input")).toHaveValue("ops");
  await page.getByTestId("team-name-input").fill("new-server");
  expect(session.policy.getSnapshot().teamDetailOpen).toBe(true);
  expect(session.policy.policyPayload?.groups).toEqual({ "group:ops": ["alice@"] });
});

test("an active IP draft survives refreshed metadata and a locale change", async () => {
  const { session } = await setup();
  const rule = session.policy.getSnapshot().policyRules.find((entry) => entry.destination === "*");
  if (!rule) throw new Error("Missing wildcard fixture");
  await page.getByTestId(`ip-rule-edit-${rule.id}`).click();
  await page.getByTestId(`ip-rule-source-${rule.id}`).fill("10.42.0.0/16");
  session.snapshot.applyPatch({
    users: [{ id: "1", name: "alice", displayName: "Alice Updated" }],
  });
  await setLocale("zh-Hans");
  await expect.element(page.getByTestId(`ip-rule-source-${rule.id}`)).toHaveValue("10.42.0.0/16");
  await page.getByTestId(`ip-rule-cancel-${rule.id}`).click();
  expect(session.policy.isPolicyDirty).toBe(false);
});

test("empty policy templates retain extensions and orphan cleanup needs confirmation", async () => {
  const { session } = await setup({ acls: [], ...extensions });
  await expect.element(page.getByTestId("resource-access-empty")).toBeVisible();
  await page.getByTestId("template-apply-small-team").click();
  await expect.element(page.getByTestId("team-card-group:team")).toBeVisible();
  expect(session.policy.policyPayload).toMatchObject(extensions);
  session.policy.load(
    JSON.stringify({
      ...policy(),
      groups: { "group:ops": ["alice@", "former@"] },
      tagOwners: { "tag:server": ["group:ops", "gone@example.com"] },
    }),
  );
  await page.getByTestId("cleanup-orphan-refs").click();
  await page.getByTestId("cleanup-orphans-cancel").click();
  expect(session.policy.isPolicyDirty).toBe(false);
  await page.getByTestId("cleanup-orphan-refs").click();
  await page.getByTestId("cleanup-orphans-confirm").click();
  expect(session.policy.policyPayload?.groups).toEqual({ "group:ops": ["alice@"] });
  expect(session.policy.policyPayload?.tagOwners).toEqual({ "tag:server": ["group:ops"] });
  await expect.element(page.getByTestId("orphan-ref-banner")).not.toBeInTheDocument();
});

test("create team and label, manage tag access and custom ports, rename and remove the label", async () => {
  const { session } = await setup({ acls: [], ...extensions });
  await page.getByTestId("empty-create-team").click();
  await expect.element(page.getByTestId("team-name-confirm")).toBeDisabled();
  await page.getByTestId("team-name-input").fill("support");
  await page.getByTestId("team-name-confirm").click();
  await page.getByTestId("team-add-member-trigger").click();
  await page.getByTestId("team-add-member-option-bob@").click();
  await page.getByTestId("team-detail-close").click();
  await page.getByTestId("unsaved-changes-save").click();
  await expect.element(page.getByTestId("team-detail-dialog")).not.toBeInTheDocument();
  expect(session.policy.policyPayload?.groups).toEqual({ "group:support": ["bob@"] });
  await page.getByTestId("new-device-label").click();
  await page.getByTestId("tag-name-input").fill("database");
  await page.getByTestId("tag-name-confirm").click();
  await page.getByTestId("tag-add-accessor-trigger").click();
  await page.getByTestId("tag-add-accessor-option-group:support").click();
  await page.getByTestId("tag-accessor-svc-group:support-web").click();
  await page.getByTestId("tag-accessor-custom-group:support").fill("5432");
  await userEvent.keyboard("{Enter}");
  expect(session.policy.policyPayload?.acls).toEqual([
    { action: "accept", src: ["group:support"], dst: ["tag:database:22,80,443,5432"] },
  ]);
  await page.getByTestId("tag-accessor-svc-group:support-ssh").click();
  await page.getByTestId("tag-name-input").fill("data-main");
  await userEvent.keyboard("{Enter}");
  expect(session.policy.policyPayload?.acls).toEqual([
    { action: "accept", src: ["group:support"], dst: ["tag:data-main:80,443,5432"] },
  ]);
  await page.getByTestId("tag-accessor-remove-group:support").click();
  await nextFrame();
  await page.getByTestId("tag-add-accessor-trigger").click();
  await page.getByTestId("tag-add-accessor-option-alice@example.com").click();
  await page.getByTestId("tag-accessor-svc-alice@example.com-ssh").click();
  expect(session.policy.policyPayload?.acls).toEqual([]);
  await page.getByTestId("tag-detail-close").click();
  await page.getByTestId("unsaved-changes-save").click();
  await expect.element(page.getByTestId("tag-detail-dialog")).not.toBeInTheDocument();
  await page.getByTestId("tag-remove-tag:data-main").click();
  await page.getByTestId("confirm-remove-policy-item").click();
  expect(session.policy.policyPayload?.tagOwners).toEqual({});
});

test("a device-only label can gain managers, and inline labels can be deleted without an owner entry", async () => {
  const { session } = await setup({
    groups: { "group:ops": ["alice@"] },
    acls: [{ action: "accept", src: ["tag:workstation"], dst: ["tag:router:22"] }],
  });
  session.snapshot.applyPatch({
    nodes: [
      {
        id: "1",
        name: "db-node",
        online: false,
        ipAddresses: [],
        availableRoutes: [],
        approvedRoutes: [],
        subnetRoutes: [],
        tags: ["tag:db"],
        expiry: undefined,
        lastSeen: undefined,
      },
    ],
  });
  await expect
    .element(page.getByTestId("tag-card-tag:db").getByText("1 device", { exact: true }))
    .toBeVisible();
  await page.getByTestId("tag-card-tag:db").click();
  await page.getByTestId("tag-add-owner-trigger").click();
  await page.getByTestId("tag-add-owner-option-bob@").click();
  expect(session.policy.policyPayload?.tagOwners).toEqual({ "tag:db": ["bob@"] });
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("unsaved-changes-keep-editing").click();
  await page.getByTestId("tag-detail-close").click();
  await page.getByTestId("unsaved-changes-discard").click();
  await expect.element(page.getByTestId("tag-detail-dialog")).not.toBeInTheDocument();
  await page.getByTestId("tag-remove-tag:router").click();
  await page.getByTestId("confirm-remove-policy-item").click();
  expect(session.policy.policyPayload?.acls).toEqual([]);
});

test("tag search matches names, accessors and owners and clean dialogs close through Escape or Done", async () => {
  const { session } = await setup({
    groups: { "group:ops": ["alice@", "bob@", "carol@", "dave@", "erin@"] },
    tagOwners: { "tag:server": ["group:ops", "alice@", "bob@", "carol@"], "tag:misc": ["bob@"] },
    acls: [
      { action: "accept", src: ["group:ops", "alice@", "bob@", "ghost@"], dst: ["tag:server:99"] },
      { action: "accept", src: ["tag:server"], dst: ["tag:workstation:3389"] },
      { action: "accept", src: ["*"], dst: ["tag:net:53"] },
    ],
  });
  await page.getByTestId("tag-search").fill("tag:server");
  await expect.element(page.getByTestId("tag-card-tag:server")).toBeVisible();
  await expect.element(page.getByTestId("tag-card-tag:misc")).not.toBeInTheDocument();
  await page.getByTestId("tag-search").fill("group:ops");
  await expect.element(page.getByTestId("tag-card-tag:server")).toBeVisible();
  await page.getByTestId("tag-search").fill("bob@");
  await expect.element(page.getByTestId("tag-card-tag:misc")).toBeVisible();
  await page.getByTestId("tag-search").fill("absent");
  await expect.element(page.getByTestId("tag-card-tag:server")).not.toBeInTheDocument();
  await page.getByTestId("tag-search").fill("");
  await page.getByTestId("tag-card-tag:workstation").click();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("tag-detail-dialog")).not.toBeInTheDocument();
  await page.getByTestId("tag-card-tag:net").click();
  await page.getByTestId("tag-detail-close").click();
  await expect.element(page.getByTestId("tag-detail-dialog")).not.toBeInTheDocument();
  await page.getByTestId("team-card-group:ops").click();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("team-detail-dialog")).not.toBeInTheDocument();
  await page.getByTestId("new-team").click();
  await page.getByTestId("team-detail-close").click();
  expect(session.policy.isPolicyDirty).toBe(false);
});

test("IP edit cancellation and unchanged edits never dirty the policy", async () => {
  const { session } = await setup();
  const rule = session.policy.getSnapshot().policyRules.find((entry) => entry.destination === "*");
  if (!rule) throw new Error("Missing wildcard fixture");
  await page.getByTestId(`ip-rule-edit-${rule.id}`).click();
  await page.getByTestId(`ip-rule-source-${rule.id}`).fill("discarded");
  await userEvent.keyboard("{Escape}");
  await page.getByTestId(`ip-rule-edit-${rule.id}`).click();
  await expect.element(page.getByTestId(`ip-rule-source-${rule.id}`)).toHaveValue("*");
  await page.getByTestId(`ip-rule-save-${rule.id}`).click();
  await expect.element(page.getByTestId(`ip-rule-edit-form-${rule.id}`)).not.toBeInTheDocument();
  expect(session.policy.isPolicyDirty).toBe(false);
});

test("a blank IP rule field keeps the editor open with a localized alert until it is filled", async () => {
  const { session } = await setup();
  const rule = session.policy.getSnapshot().policyRules.find((entry) => entry.destination === "*");
  if (!rule) throw new Error("Missing wildcard fixture");
  const source = page.getByTestId(`ip-rule-source-${rule.id}`);
  await page.getByTestId(`ip-rule-edit-${rule.id}`).click();
  await expect.element(page.getByTestId(`ip-rule-error-${rule.id}`)).not.toBeInTheDocument();
  await source.fill(" ");
  await page.getByTestId(`ip-rule-ports-${rule.id}`).fill("443");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId(`ip-rule-edit-form-${rule.id}`)).toBeVisible();
  await expect
    .element(page.getByTestId(`ip-rule-error-${rule.id}`))
    .toHaveTextContent(getProductCopy("en-US").ipRuleFieldsRequired);
  await expect.element(page.getByRole("alert")).toBeVisible();
  await expect.element(source).toHaveAttribute("aria-invalid", "true");
  await expect.element(source).toHaveAttribute("aria-describedby", `ip-rule-error-${rule.id}`);
  await expect
    .element(page.getByTestId(`ip-rule-destination-${rule.id}`))
    .toHaveAttribute("dir", "ltr");
  expect(session.policy.isPolicyDirty).toBe(false);
  await source.fill("10.0.0.0/8");
  await expect.element(page.getByTestId(`ip-rule-error-${rule.id}`)).not.toBeInTheDocument();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId(`ip-rule-edit-form-${rule.id}`)).not.toBeInTheDocument();
  expect(session.policy.isPolicyDirty).toBe(true);
  expect(session.policy.getSnapshot().policyRules.find((r) => r.id === rule.id)).toMatchObject({
    source: "10.0.0.0/8",
    destination: "*",
    ports: "443",
  });
});

test("team rename updates references, dirty refreshes preserve edits, and discard restores the latest server policy", async () => {
  const { session } = await setup();
  await page.getByTestId("team-card-group:ops").click();
  await page.getByTestId("team-name-input").fill("engineering");
  await userEvent.keyboard("{Enter}");
  expect(session.policy.policyPayload?.acls).toContainEqual({
    action: "accept",
    src: ["group:engineering"],
    dst: ["tag:server:22"],
  });
  session.snapshot.applyPatch({ policy: { policy: '{"acls":[]}' } });
  await expect.element(page.getByTestId("team-name-input")).toHaveValue("engineering");
  await page.getByTestId("team-add-member-trigger").click();
  await page.getByTestId("team-add-member-option-bob@").click();
  expect(session.policy.policyPayload?.groups).toEqual({ "group:engineering": ["alice@", "bob@"] });
  await page.getByTestId("team-member-remove-bob@").click();
  await page.getByTestId("team-detail-close").click();
  await expect.element(page.getByTestId("unsaved-changes-dialog")).toBeVisible();
  await page.getByTestId("unsaved-changes-discard").click();
  await expect.element(page.getByTestId("team-detail-dialog")).not.toBeInTheDocument();
  // The refresh withheld during the edit is applied on discard.
  expect(session.policy.policyPayload?.groups).toEqual({});
  expect(session.policy.policyPayload?.acls).toEqual([]);
  expect(session.policy.isPolicyDirty).toBe(false);
});

test("renaming a team updates every supported identity reference before saving", async () => {
  const { session } = await setup({
    ...policy(),
    grants: [{ src: ["group:ops"], dst: ["group:ops", "tag:server"], ip: ["tcp:22"] }],
    nodeAttrs: [{ target: ["group:ops"], attr: ["group:ops"] }],
    tests: [{ src: "group:ops", accept: ["group:ops:22", "tag:server:443"] }],
    sshTests: [{ src: "group:ops", dst: ["group:ops", "tag:server"], accept: ["group:ops"] }],
  });
  await page.getByTestId("team-card-group:ops").click();
  await page.getByTestId("team-name-input").fill("engineering");
  await userEvent.keyboard("{Enter}");
  expect(session.policy.policyPayload?.tagOwners).toEqual({ "tag:server": ["group:engineering"] });
  expect(session.policy.policyPayload?.ssh).toEqual([
    { action: "accept", src: ["group:engineering"], dst: ["tag:server"], users: ["root"] },
  ]);
  expect(session.policy.policyPayload?.autoApprovers).toEqual({
    routes: { "10.0.0.0/8": ["group:engineering"] },
  });
  expect(session.policy.policyPayload?.grants).toEqual([
    { src: ["group:engineering"], dst: ["group:engineering", "tag:server"], ip: ["tcp:22"] },
  ]);
  expect(session.policy.policyPayload?.nodeAttrs).toEqual([
    { target: ["group:engineering"], attr: ["group:ops"] },
  ]);
  expect(session.policy.policyPayload?.tests).toEqual([
    { src: "group:engineering", accept: ["group:engineering:22", "tag:server:443"] },
  ]);
  expect(session.policy.policyPayload?.sshTests).toEqual([
    { src: "group:engineering", dst: ["group:engineering", "tag:server"], accept: ["group:ops"] },
  ]);
});

test("unknown policy fields block identity edits and keep the original state", async () => {
  const { session, writes } = await setup({ ...policy(), extension: { owner: "group:ops" } });
  const previous = session.policy.policyDesignerState;
  await page.getByTestId("team-card-group:ops").click();
  await page.getByTestId("team-name-input").fill("engineering");
  await userEvent.keyboard("{Enter}");
  expect(session.policy.policyDesignerState).toEqual(previous);
  expect(session.policy.isPolicyDirty).toBe(false);
  expect(writes).toEqual([]);
  await expect
    .element(page.getByTestId("team-policy-reference-error"))
    .toMatchTextContent("extension");
});

test.each([
  { kind: "team", create: "new-team", taken: "ops", invalid: ["bad name", "a,b", "a@b"] },
  { kind: "tag", create: "new-device-label", taken: "server", invalid: ["1bad", "a,b", "a@b"] },
])(
  "creating a $kind rejects invalid and duplicate names and recovers after correction",
  async ({ kind, create, taken, invalid }) => {
    const { session, writes } = await setup();
    const before = session.policy.policyDesignerState;
    await page.getByTestId(create).click();
    for (const name of [...invalid, taken]) {
      await page.getByTestId(`${kind}-name-input`).fill(name);
      await userEvent.keyboard("{Enter}");
      expect(session.policy.policyDesignerState).toEqual(before);
      await expect.element(page.getByTestId(`${kind}-policy-reference-error`)).toBeVisible();
      await expect.element(page.getByTestId(`${kind}-name-input`)).toHaveValue(name);
    }
    expect(writes).toEqual([]);
    await page.getByTestId(`${kind}-name-input`).fill("corrected");
    await userEvent.keyboard("{Enter}");
    await expect
      .element(page.getByTestId(`${kind}-policy-reference-error`))
      .not.toBeInTheDocument();
    expect(session.policy.policyPayload?.[kind === "team" ? "groups" : "tagOwners"]).toHaveProperty(
      `${kind === "team" ? "group" : "tag"}:corrected`,
    );
  },
);

test("unknown fields block both tag rename and removal while preserving input and document", async () => {
  const { session, writes } = await setup({ ...policy(), extension: { owner: "tag:server" } });
  const before = session.policy.policyDesignerState;
  await page.getByTestId("tag-card-tag:server").click();
  await page.getByTestId("tag-name-input").fill("renamed");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByTestId("tag-policy-reference-error"))
    .toMatchTextContent("extension");
  await expect.element(page.getByTestId("tag-name-input")).toHaveValue("renamed");
  expect(session.policy.policyDesignerState).toEqual(before);
  await page.getByTestId("tag-detail-close").click();
  await page.getByTestId("tag-remove-tag:server").click();
  await expect.element(page.getByTestId("confirm-remove-policy-item")).toBeDisabled();
  await expect
    .element(page.getByTestId("remove-policy-item-dialog"))
    .toMatchTextContent("extension");
  expect(session.policy.policyDesignerState).toEqual(before);
  expect(writes).toEqual([]);
});

test("tag deletion previews affected rules and tests and drops a grant whose last via tag was removed", async () => {
  const { session, writes } = await setup({
    ...policy(),
    grants: [{ src: ["group:ops"], dst: ["10.42.0.0/16"], ip: ["*"], via: ["tag:server"] }],
    nodeAttrs: [{ target: ["tag:server"], attr: ["keep"] }],
  });
  await page.getByTestId("tag-remove-tag:server").click();
  await expect
    .element(page.getByTestId("policy-removal-impact"))
    .toHaveTextContent("Affected rules: 4. Affected policy tests: 1.");
  expect(writes).toEqual([]);
  await page.getByTestId("confirm-remove-policy-item").click();
  expect(session.policy.policyPayload).toMatchObject({
    grants: [],
    tests: [],
    nodeAttrs: [],
    ssh: [],
  });
  await page.getByTestId("save-policy").click();
  await expect.poll(() => writes.length).toBe(1);
  expect(JSON.parse(writes[0].policy).grants).toEqual([]);
});

test("save-and-close retains a failed draft and closes only after the retry succeeds", async () => {
  const { session, fail, writes } = await setup();
  await page.getByTestId("team-card-group:ops").click();
  await page.getByTestId("team-member-remove-alice@").click();
  await page.getByTestId("team-detail-close").click();
  fail("Policy rejected");
  await page.getByTestId("unsaved-changes-save").click();
  await expect.poll(() => session.feedback.actionError("save-policy")).toBe("Policy rejected");
  await expect.element(page.getByTestId("team-detail-dialog")).toBeVisible();
  expect(session.policy.isPolicyDirty).toBe(true);
  fail("");
  await page.getByTestId("team-detail-close").click();
  await page.getByTestId("unsaved-changes-save").click();
  await expect.element(page.getByTestId("team-detail-dialog")).not.toBeInTheDocument();
  expect(session.policy.isPolicyDirty).toBe(false);
  expect(writes).toHaveLength(2);
});

test("tag service changes require the existing all-ports confirmation and preserve managers", async () => {
  const { session } = await setup();
  await page.getByTestId("tag-card-tag:server").click();
  await page.getByTestId("tag-accessor-svc-group:ops-all").click();
  await expect.element(page.getByTestId("high-risk-confirm-dialog")).toBeVisible();
  expect(session.policy.policyPayload?.acls).toContainEqual({
    action: "accept",
    src: ["group:ops"],
    dst: ["tag:server:22"],
  });
  await page.getByTestId("high-risk-cancel").click();
  expect(session.policy.isPolicyDirty).toBe(false);
  await page.getByTestId("tag-accessor-svc-group:ops-all").click();
  await page.getByTestId("high-risk-confirm").click();
  expect(session.policy.policyPayload?.acls).toContainEqual({
    action: "accept",
    src: ["group:ops"],
    dst: ["tag:server:*"],
  });
  await page.getByTestId("tag-add-owner-trigger").click();
  await page.getByTestId("tag-add-owner-option-bob@").click();
  expect(session.policy.policyPayload?.tagOwners).toEqual({ "tag:server": ["group:ops", "bob@"] });
  await page.getByTestId("tag-owner-remove-bob@").click();
  await page.getByTestId("tag-detail-close").click();
  await page.getByTestId("unsaved-changes-save").click();
  await expect.element(page.getByTestId("tag-detail-dialog")).not.toBeInTheDocument();
});

test("custom port drafts are retained when the all-ports service is confirmed", async () => {
  await setup({
    groups: { "group:ops": ["alice@"] },
    acls: [{ action: "accept", src: ["group:ops"], dst: ["tag:server:5432"] }],
  });
  await page.getByTestId("tag-card-tag:server").click();
  await expect.element(page.getByTestId("tag-accessor-custom-group:ops")).toHaveValue("5432");
  await page.getByTestId("tag-accessor-svc-group:ops-all").click();
  await page.getByTestId("high-risk-confirm").click();
  await expect.element(page.getByTestId("tag-accessor-custom-group:ops")).toHaveValue("5432");
});

test("team removal is confirmed, removes references, and grants-only policies stay unchanged", async () => {
  const { session, unmount } = await setup();
  await page.getByTestId("team-remove-group:ops").click();
  await page.getByTestId("cancel-remove-policy-item").click();
  expect(session.policy.policyPayload?.groups).toEqual({ "group:ops": ["alice@"] });
  await page.getByTestId("team-remove-group:ops").click();
  await page.getByTestId("confirm-remove-policy-item").click();
  expect(session.policy.policyPayload?.groups).toEqual({});
  expect(session.policy.policyPayload?.acls).toEqual([
    { action: "accept", src: ["*"], dst: ["*:*"] },
  ]);
  await unmount();
  vi.restoreAllMocks();
  const grants = { grants: [{ src: ["*"], dst: ["*"], ip: ["*"] }], ...extensions };
  const next = await setup(grants);
  await expect.element(page.getByTestId("grants-preserved-notice")).toBeVisible();
  await expect.element(page.getByTestId("resource-access-empty")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("ip-rules-section")).not.toBeInTheDocument();
  await page.getByTestId("save-policy").click();
  await expect.poll(() => next.writes.length).toBe(1);
  expect(JSON.parse(next.writes[0]?.policy ?? "null")).toMatchObject(grants);
  expect(JSON.parse(next.writes[0]?.policy ?? "null").acls).toEqual([]);
});

test("empty-state label creation and keyboard team creation preserve the policy draft", async () => {
  const { session } = await setup({ acls: [], ...extensions });
  await page.getByTestId("empty-create-tag").click();
  await page.getByTestId("tag-name-input").fill("fresh");
  await page.getByTestId("tag-name-confirm").click();
  expect(session.policy.policyPayload?.tagOwners).toEqual({ "tag:fresh": [] });
  await page.getByTestId("tag-detail-close").click();
  await page.getByTestId("unsaved-changes-discard").click();
  await page.getByTestId("empty-create-team").click();
  await page.getByTestId("team-name-input").fill("fresh-team");
  await userEvent.keyboard("{Enter}");
  expect(session.policy.policyPayload?.groups).toEqual({ "group:fresh-team": [] });
});

test("an IP-only policy stays editable and stale orphan confirmation closes without changing it", async () => {
  const initial = {
    acls: [{ action: "accept", src: ["10.0.0.0/8"], dst: ["192.168.0.0/16:443"] }],
  };
  const { session } = await setup(initial);
  await expect.element(page.getByTestId("resource-access-empty")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("ip-rules-section")).toBeVisible();
  session.policy.load(JSON.stringify({ ...policy(), groups: { "group:ops": ["former@"] } }));
  await page.getByTestId("cleanup-orphan-refs").click();
  session.policy.load(JSON.stringify(policy()));
  await page.getByTestId("cleanup-orphans-confirm").click();
  await expect.element(page.getByTestId("cleanup-orphans-dialog")).not.toBeInTheDocument();
  expect(session.policy.isPolicyDirty).toBe(false);
});

test("accessor selection offers existing principals and cannot create a wildcard", async () => {
  const { session } = await setup();
  await page.getByTestId("tag-card-tag:server").click();
  await page.getByTestId("tag-add-accessor-trigger").click();
  await page.getByTestId("tag-add-accessor-search").fill("*");
  await expect.element(page.getByTestId("tag-add-accessor-empty")).toBeVisible();
  expect(document.querySelector('[data-testid="tag-add-accessor-create"]')).toBeNull();
  expect(session.policy.isPolicyDirty).toBe(false);
});

test("applying a template replaces the open default rule in the saved policy", async () => {
  const { writes } = await setup({});
  await expect.element(page.getByTestId("open-access-banner")).toBeVisible();
  await page.getByTestId("template-apply-small-team").click();
  await expect.element(page.getByTestId("open-access-banner")).not.toBeInTheDocument();
  await page.getByTestId("save-policy").click();
  await expect.poll(() => writes.length).toBe(1);
  expect(JSON.parse(writes[0]?.policy ?? "null").acls).toEqual([
    { action: "accept", src: ["group:team"], dst: ["tag:shared:22,80,443"] },
  ]);
});

const twoTags = {
  groups: { "group:ops": ["alice@"] },
  tagOwners: { "tag:a": ["group:ops"], "tag:b": ["group:ops"] },
  acls: [
    { action: "accept", src: ["group:ops"], dst: ["tag:a:8080"] },
    { action: "accept", src: ["group:ops"], dst: ["tag:b:9090"] },
  ],
};
const customInput = () => page.getByTestId("tag-accessor-custom-group:ops");

test("custom ports belong to the open label and a plain blur does not rewrite them", async () => {
  const { session } = await setup(twoTags);
  await page.getByTestId("tag-card-tag:a").click();
  await expect.element(customInput()).toHaveValue("8080");
  await page.getByTestId("tag-detail-close").click();
  await page.getByTestId("tag-card-tag:b").click();
  await expect.element(customInput()).toHaveValue("9090");
  await customInput().click();
  await userEvent.tab();
  expect(session.policy.isPolicyDirty).toBe(false);
  expect(session.policy.policyPayload?.acls).toEqual(twoTags.acls);
});

test("discarded custom-port edits do not come back", async () => {
  const { session } = await setup(twoTags);
  await page.getByTestId("tag-card-tag:a").click();
  await customInput().fill("7000");
  await userEvent.keyboard("{Enter}");
  await page.getByTestId("tag-detail-close").click();
  await page.getByTestId("unsaved-changes-discard").click();
  await page.getByTestId("tag-card-tag:a").click();
  await expect.element(customInput()).toHaveValue("8080");
  await customInput().click();
  await userEvent.tab();
  expect(session.policy.isPolicyDirty).toBe(false);
  expect(session.policy.policyPayload?.acls).toEqual(twoTags.acls);
});

test("saved custom-port edits reopen normalized", async () => {
  const { writes } = await setup(twoTags);
  await page.getByTestId("tag-card-tag:a").click();
  await customInput().fill(" 7000 , 7001");
  await userEvent.keyboard("{Enter}");
  await page.getByTestId("tag-detail-close").click();
  await page.getByTestId("unsaved-changes-save").click();
  await expect.poll(() => writes.length).toBe(1);
  await expect.element(page.getByTestId("tag-detail-dialog")).not.toBeInTheDocument();
  expect(JSON.parse(writes[0]?.policy ?? "null").acls).toContainEqual({
    action: "accept",
    src: ["group:ops"],
    dst: ["tag:a:7000,7001"],
  });
  await page.getByTestId("tag-card-tag:a").click();
  await expect.element(customInput()).toHaveValue("7000,7001");
});

test("a removed then re-added accessor starts clean", async () => {
  const { session } = await setup({
    groups: { "group:ops": ["alice@"] },
    acls: [{ action: "accept", src: ["group:ops"], dst: ["tag:server:5432"] }],
  });
  await page.getByTestId("tag-card-tag:server").click();
  await page.getByTestId("tag-accessor-remove-group:ops").click();
  await nextFrame();
  await page.getByTestId("tag-add-accessor-trigger").click();
  await page.getByTestId("tag-add-accessor-option-group:ops").click();
  await expect.element(customInput()).toHaveValue("");
  expect(session.policy.policyPayload?.acls).toEqual([
    { action: "accept", src: ["group:ops"], dst: ["tag:server:22"] },
  ]);
});

const allPorts = {
  groups: { "group:ops": ["alice@"] },
  acls: [{ action: "accept", src: ["group:ops"], dst: ["tag:server:*"] }],
};

test("blurring an unchanged all-ports accessor does not reopen the high-risk confirmation", async () => {
  const { session } = await setup(allPorts);
  await page.getByTestId("tag-card-tag:server").click();
  await customInput().click();
  await userEvent.tab();
  await expect.element(page.getByTestId("high-risk-confirm-dialog")).not.toBeInTheDocument();
  expect(session.policy.isPolicyDirty).toBe(false);
});

test("unchecking all restores the retained custom ports", async () => {
  const { session } = await setup({
    groups: { "group:ops": ["alice@"] },
    acls: [{ action: "accept", src: ["group:ops"], dst: ["tag:server:5432"] }],
  });
  await page.getByTestId("tag-card-tag:server").click();
  await page.getByTestId("tag-accessor-svc-group:ops-all").click();
  await page.getByTestId("high-risk-confirm").click();
  await page.getByTestId("tag-accessor-svc-group:ops-all").click();
  expect(session.policy.policyPayload?.acls).toEqual([
    { action: "accept", src: ["group:ops"], dst: ["tag:server:5432"] },
  ]);
  await expect.element(customInput()).toHaveValue("5432");
});

test("typed text under all is kept but never written", async () => {
  const { session } = await setup(allPorts);
  await page.getByTestId("tag-card-tag:server").click();
  await customInput().fill("7000");
  await userEvent.tab();
  await expect.element(customInput()).toHaveValue("7000");
  expect(session.policy.policyPayload?.acls).toEqual([
    { action: "accept", src: ["group:ops"], dst: ["tag:server:*"] },
  ]);
  await expect.element(page.getByTestId("high-risk-confirm-dialog")).not.toBeInTheDocument();
});

test.each(["en-US", "zh-Hans"] as const)(
  "a save rejected because Headscale reads its policy from a file shows localized copy and keeps the draft in %s",
  async (locale) => {
    const { session, fail, writes } = await setup();
    try {
      if (locale !== "en-US") await setLocale(locale);
      const rule = session.policy
        .getSnapshot()
        .policyRules.find((entry) => entry.destination === "*");
      if (!rule) throw new Error("Missing wildcard fixture");
      await page.getByTestId(`ip-rule-remove-${rule.id}`).click();
      fail("update is disabled for modes other than 'database'");
      await page.getByTestId("save-policy").click();
      await expect
        .poll(() => session.feedback.actionError("save-policy"))
        .toBe(getProductCopy(locale).policyUpdateDisabled);
      expect(session.policy.isPolicyDirty).toBe(true);
      expect(writes).toHaveLength(1);
    } finally {
      await setLocale("en-US");
    }
  },
);

function removeWildcardRule(session: Awaited<ReturnType<typeof setup>>["session"]) {
  const rule = session.policy.getSnapshot().policyRules.find((entry) => entry.destination === "*");
  if (!rule) throw new Error("Missing wildcard fixture");
  return page.getByTestId(`ip-rule-remove-${rule.id}`).click();
}

test("check sends exactly the text Save would send, writes nothing and leaves the draft dirty", async () => {
  const { session, writes, checks, reads } = await setup();
  await removeWildcardRule(session);
  reads.length = 0;
  await page.getByTestId("check-policy").click();
  await expect.element(page.getByTestId("policy-check-passed")).toBeVisible();
  expect(checks).toHaveLength(1);
  expect(writes).toEqual([]);
  expect(reads).toEqual([]);
  expect(session.policy.isPolicyDirty).toBe(true);
  await page.getByTestId("save-policy").click();
  await expect.poll(() => writes.length).toBe(1);
  expect(checks[0]?.policy).toBe(writes[0]?.policy);
});

test("a passed check disappears after the next edit and a failed check shows the server message", async () => {
  const { session, checks, failCheck } = await setup();
  await expect.element(page.getByTestId("policy-check-passed")).not.toBeInTheDocument();
  await page.getByTestId("check-policy").click();
  await expect.element(page.getByTestId("policy-check-passed")).toBeVisible();
  await removeWildcardRule(session);
  await expect.element(page.getByTestId("policy-check-passed")).not.toBeInTheDocument();
  failCheck("policy references an unknown user");
  await page.getByTestId("check-policy").click();
  await expect
    .element(page.getByTestId("check-policy-error"))
    .toMatchTextContent("policy references an unknown user");
  await expect.element(page.getByTestId("policy-check-passed")).not.toBeInTheDocument();
  expect(checks).toHaveLength(2);
});

test("check is disabled while a save is pending and absent for a read-only policy", async () => {
  const { session, hold, writes } = await setup();
  const pending = Promise.withResolvers<void>();
  hold(pending.promise);
  await removeWildcardRule(session);
  await page.getByTestId("save-policy").click();
  await expect.poll(() => writes.length).toBe(1);
  await expect.element(page.getByTestId("check-policy")).toBeDisabled();
  pending.resolve();
  await expect.element(page.getByTestId("check-policy")).toBeEnabled();
  session.snapshot.applyPatch({ policy: { policy: '{"acls":[' } });
  await expect.element(page.getByTestId("policy-read-only-notice")).toBeVisible();
  await expect.element(page.getByTestId("check-policy")).not.toBeInTheDocument();
});

test("a passed check does not survive a server switch", async () => {
  const { session, checks } = await setup();
  const button = await page.getByTestId("check-policy").element();
  const draft = JSON.stringify(session.policy.policyPayload);
  await page.getByTestId("check-policy").click();
  await expect.element(page.getByTestId("policy-check-passed")).toBeVisible();
  // Control: a refresh of the same server keeps the passed line.
  await session.snapshot.refreshSnapshot();
  await expect.element(page.getByTestId("policy-check-passed")).toBeVisible();
  await authenticateTestSession(session, "https://other.invalid");
  await expect
    .poll(() => session.auth.getSessionSnapshot()?.profile?.baseUrl)
    .toBe("https://other.invalid");
  await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
  await expect.element(page.getByTestId("check-policy")).toBeEnabled();
  await expect.element(page.getByTestId("policy-check-passed")).not.toBeInTheDocument();
  // Same node, same draft and no extra check: only the [http] reset effect explains the result.
  expect(page.getByTestId("check-policy").element()).toBe(button);
  expect(JSON.stringify(session.policy.policyPayload)).toBe(draft);
  expect(checks).toHaveLength(1);
});

const k8sPolicy = {
  groups: { "group:ops": ["alice@"] },
  tagOwners: { "tag:k8s_node": ["group:ops"] },
  acls: [{ action: "accept", src: ["group:ops"], dst: ["tag:k8s_node:22"] }],
};

test("a team can be renamed and removed while the policy holds a tag with an underscore", async () => {
  const { session, writes } = await setup(k8sPolicy);
  await page.getByTestId("team-card-group:ops").click();
  await page.getByTestId("team-name-input").fill("eng");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("team-policy-reference-error")).not.toBeInTheDocument();
  expect(session.policy.policyPayload).toMatchObject({
    groups: { "group:eng": ["alice@"] },
    tagOwners: { "tag:k8s_node": ["group:eng"] },
    acls: [{ action: "accept", src: ["group:eng"], dst: ["tag:k8s_node:22"] }],
  });
  await page.getByTestId("team-detail-close").click();
  await page.getByTestId("unsaved-changes-save").click();
  await expect.element(page.getByTestId("team-detail-dialog")).not.toBeInTheDocument();
  expect(writes).toHaveLength(1);
  await page.getByTestId("team-remove-group:eng").click();
  await page.getByTestId("confirm-remove-policy-item").click();
  expect(session.policy.policyPayload).toMatchObject({
    groups: {},
    tagOwners: { "tag:k8s_node": [] },
    acls: [],
  });
});

test("blurring an existing underscore tag is not an edit and its owners can still be added", async () => {
  const { session, writes } = await setup(k8sPolicy);
  await page.getByTestId("tag-card-tag:k8s_node").click();
  await page.getByTestId("tag-name-input").click();
  await userEvent.tab();
  await expect.element(page.getByTestId("tag-policy-reference-error")).not.toBeInTheDocument();
  expect(session.policy.isPolicyDirty).toBe(false);
  await page.getByTestId("tag-add-owner-trigger").click();
  await page.getByTestId("tag-add-owner-option-bob@").click();
  expect(session.policy.policyPayload?.tagOwners).toMatchObject({
    "tag:k8s_node": ["group:ops", "bob@"],
  });
  expect(writes).toEqual([]);
});

test.each([
  { kind: "team", create: "new-team", name: "dev_ops", key: "group:dev_ops", section: "groups" },
  { kind: "team", create: "new-team", name: "研发", key: "group:研发", section: "groups" },
  {
    kind: "tag",
    create: "new-device-label",
    name: "k8s_node",
    key: "tag:k8s_node",
    section: "tagOwners",
  },
  {
    kind: "tag",
    create: "new-device-label",
    name: "ci.runner-2",
    key: "tag:ci.runner-2",
    section: "tagOwners",
  },
] as const)(
  "creating the $kind $name is accepted",
  async ({ kind, create, name, key, section }) => {
    const { session } = await setup();
    await page.getByTestId(create).click();
    await page.getByTestId(`${kind}-name-input`).fill(name);
    await userEvent.keyboard("{Enter}");
    await expect
      .element(page.getByTestId(`${kind}-policy-reference-error`))
      .not.toBeInTheDocument();
    expect(session.policy.policyPayload?.[section]).toHaveProperty(key);
  },
);

function patchNodeTagged(session: Awaited<ReturnType<typeof setup>>["session"], tag: string) {
  session.snapshot.applyPatch({
    nodes: [
      {
        id: "1",
        name: "odd-node",
        online: false,
        ipAddresses: [],
        availableRoutes: [],
        approvedRoutes: [],
        subnetRoutes: [],
        tags: [tag],
        expiry: undefined,
        lastSeen: undefined,
      },
    ],
  });
}

test("a server-valid label the editor cannot define opens without an error and refuses new owners visibly", async () => {
  const { session, writes } = await setup({ groups: { "group:ops": ["alice@"] }, acls: [] });
  patchNodeTagged(session, "tag:a:b");
  await page.getByTestId("tag-card-tag:a:b").click();
  await page.getByTestId("tag-name-input").click();
  await userEvent.tab();
  await expect.element(page.getByTestId("tag-policy-reference-error")).not.toBeInTheDocument();
  const before = session.policy.policyDesignerState;
  await page.getByTestId("tag-add-owner-trigger").click();
  await page.getByTestId("tag-add-owner-option-bob@").click();
  await expect
    .element(page.getByTestId("tag-policy-reference-error"))
    .toHaveTextContent(getProductCopy("en-US").policyReferenceInvalidName);
  expect(session.policy.policyDesignerState).toEqual(before);
  expect(session.policy.isPolicyDirty).toBe(false);
  expect(writes).toEqual([]);
});

test("member and owner edits keep the order of teams and labels in the saved policy", async () => {
  const { session, writes } = await setup({
    groups: { "group:a": ["alice@"], "group:b": ["bob@"] },
    tagOwners: { "tag:a": ["alice@"], "tag:b": ["bob@"] },
    acls: [],
  });
  const cards = () =>
    Array.from(document.querySelectorAll('[data-testid^="team-card-"]')).map((node) =>
      node.getAttribute("data-testid"),
    );
  const order = cards();
  await page.getByTestId("team-card-group:a").click();
  await page.getByTestId("team-add-member-trigger").click();
  await page.getByTestId("team-add-member-option-bob@").click();
  await page.getByTestId("team-detail-close").click();
  await page.getByTestId("unsaved-changes-save").click();
  await expect.element(page.getByTestId("team-detail-dialog")).not.toBeInTheDocument();
  await page.getByTestId("tag-card-tag:a").click();
  await page.getByTestId("tag-add-owner-trigger").click();
  await page.getByTestId("tag-add-owner-option-bob@").click();
  await page.getByTestId("tag-detail-close").click();
  await page.getByTestId("unsaved-changes-save").click();
  await expect.element(page.getByTestId("tag-detail-dialog")).not.toBeInTheDocument();
  expect(writes).toHaveLength(2);
  const saved = JSON.parse(writes[1]?.policy ?? "null");
  expect(Object.keys(saved.groups)).toEqual(["group:a", "group:b"]);
  expect(Object.keys(saved.tagOwners)).toEqual(["tag:a", "tag:b"]);
  expect(saved.groups["group:a"]).toEqual(["alice@", "bob@"]);
  expect(saved.tagOwners["tag:a"]).toEqual(["alice@", "bob@"]);
  expect(cards()).toEqual(order);
  expect(session.policy.isPolicyDirty).toBe(false);
});

test("removing an accessor from a rule with several sources and destinations really removes it", async () => {
  const { session, writes } = await setup({
    groups: { "group:ops": ["alice@"], "group:dev": ["bob@"] },
    acls: [{ action: "accept", src: ["group:ops"], dst: ["10.0.0.0/8:22"] }],
  });
  const id = session.policy.getSnapshot().policyRules[0]?.id;
  await page.getByTestId(`ip-rule-edit-${id}`).click();
  await page.getByTestId(`ip-rule-source-${id}`).fill("group:ops,group:dev");
  await page.getByTestId(`ip-rule-destination-${id}`).fill("tag:server,10.0.0.0/8");
  await page.getByTestId(`ip-rule-save-${id}`).click();
  await page.getByTestId("tag-card-tag:server").click();
  await page.getByTestId("tag-accessor-remove-group:ops").click();
  await expect.element(page.getByTestId("tag-accessor-row-group:ops")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("tag-accessor-row-group:dev")).toBeVisible();
  await page.getByTestId("tag-detail-close").click();
  await page.getByTestId("unsaved-changes-save").click();
  await expect.poll(() => writes.length).toBe(1);
  const pairs = JSON.parse(writes[0]?.policy ?? "null").acls.flatMap(
    (acl: { src: string[]; dst: string[] }) =>
      acl.src.flatMap((src) => acl.dst.map((dst) => `${src} -> ${dst}`)),
  );
  expect(pairs.sort()).toEqual([
    "group:dev -> 10.0.0.0/8:22",
    "group:dev -> tag:server:22",
    "group:ops -> 10.0.0.0/8:22",
  ]);
});

function focusTestId(id: string) {
  const element = page.getByTestId(id).element();
  if (!(element instanceof HTMLElement)) throw new Error(`${id} is not focusable`);
  element.focus();
}

test("cards open from the keyboard through a named button and expose named delete controls", async () => {
  const { session } = await setup();
  await expect.element(page.getByRole("button", { name: "Delete team ops" })).toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Delete device label server" }))
    .toBeInTheDocument();
  focusTestId("team-open-group:ops");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("team-detail-dialog")).toBeVisible();
  expect(session.policy.getSnapshot().teamDetailCurrent).toBe("group:ops");
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("team-detail-dialog")).not.toBeInTheDocument();
  focusTestId("tag-open-tag:server");
  await userEvent.keyboard(" ");
  await expect.element(page.getByTestId("tag-detail-dialog")).toBeVisible();
  expect(session.policy.getSnapshot().tagDetailCurrent).toBe("tag:server");
  await expect.element(page.getByRole("button", { name: "Remove access ops" })).toBeInTheDocument();
});

test("row controls name their subject so repeated rows stay distinguishable", async () => {
  const { session } = await setup({
    groups: { "group:ops": ["alice@", "bob@"] },
    tagOwners: { "tag:server": ["alice@", "bob@"] },
    acls: [{ action: "accept", src: ["group:ops"], dst: ["10.0.0.0/8:22"] }],
  });
  await expect
    .element(page.getByRole("button", { name: "Edit rule group:ops -> 10.0.0.0/8" }))
    .toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Remove group:ops -> 10.0.0.0/8" }))
    .toBeInTheDocument();
  await page.getByTestId("team-card-group:ops").click();
  await expect
    .element(page.getByRole("button", { name: "Remove member alice@" }))
    .toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Remove member bob@" }))
    .toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("tag-card-tag:server").click();
  await expect
    .element(page.getByRole("button", { name: "Remove label manager alice@" }))
    .toBeInTheDocument();
  expect(session.policy.isPolicyDirty).toBe(false);
});

test("reading a dialog without editing it never prompts and keeps page-level edits", async () => {
  const { session } = await setup();
  await removeWildcardRule(session);
  expect(session.policy.isPolicyDirty).toBe(true);
  await page.getByTestId("team-card-group:ops").click();
  await page.getByTestId("team-detail-close").click();
  await expect.element(page.getByTestId("team-detail-dialog")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("unsaved-changes-dialog")).not.toBeInTheDocument();
  expect(session.policy.isPolicyDirty).toBe(true);
  await page.getByTestId("tag-card-tag:server").click();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("tag-detail-dialog")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("unsaved-changes-dialog")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("save-policy-dirty-badge")).toBeVisible();
});

test("closing a dialog without saving reverts only that dialog's edits", async () => {
  const { session } = await setup();
  await removeWildcardRule(session);
  await page.getByTestId("team-card-group:ops").click();
  await page.getByTestId("team-member-remove-alice@").click();
  await page.getByTestId("team-detail-close").click();
  await page.getByTestId("unsaved-changes-discard").click();
  await expect.element(page.getByTestId("team-detail-dialog")).not.toBeInTheDocument();
  expect(session.policy.policyPayload?.groups).toEqual({ "group:ops": ["alice@"] });
  expect(session.policy.policyPayload?.acls).toEqual([
    { action: "accept", src: ["group:ops"], dst: ["tag:server:22"] },
  ]);
  expect(session.policy.isPolicyDirty).toBe(true);
});

test.each(["team", "tag"] as const)(
  "a rejected save-and-close shows the error inside the %s dialog and a retry can close it",
  async (kind) => {
    const { session, fail } = await setup();
    if (kind === "team") {
      await page.getByTestId("team-card-group:ops").click();
      await page.getByTestId("team-member-remove-alice@").click();
    } else {
      await page.getByTestId("tag-card-tag:server").click();
      await page.getByTestId("tag-accessor-remove-group:ops").click();
    }
    await page.getByTestId(`${kind}-detail-close`).click();
    fail("Policy rejected");
    await page.getByTestId("unsaved-changes-save").click();
    await expect
      .element(page.getByTestId(`${kind}-detail-dialog`).getByRole("alert"))
      .toHaveTextContent("Policy rejected");
    await expect.element(page.getByTestId("dialog-save-policy-error")).toBeVisible();
    await expect.element(page.getByTestId("save-policy-error")).not.toBeInTheDocument();
    fail("");
    await page.getByTestId(`${kind}-detail-close`).click();
    await page.getByTestId("unsaved-changes-save").click();
    await expect.element(page.getByTestId(`${kind}-detail-dialog`)).not.toBeInTheDocument();
    expect(session.policy.isPolicyDirty).toBe(false);
  },
);

test.each(["team", "tag"] as const)(
  "Done and Escape are ignored while the policy is being saved and the %s dialog closes afterwards",
  async (kind) => {
    const { session, hold, writes } = await setup();
    const pending = Promise.withResolvers<void>();
    hold(pending.promise);
    if (kind === "team") {
      await page.getByTestId("team-card-group:ops").click();
      await page.getByTestId("team-member-remove-alice@").click();
    } else {
      await page.getByTestId("tag-card-tag:server").click();
      await page.getByTestId("tag-accessor-remove-group:ops").click();
    }
    await page.getByTestId(`${kind}-detail-close`).click();
    await page.getByTestId("unsaved-changes-save").click();
    await expect.poll(() => writes.length).toBe(1);
    await expect.element(page.getByTestId(`${kind}-detail-close`)).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByTestId(`${kind}-detail-dialog`)).toBeVisible();
    await expect.element(page.getByTestId("unsaved-changes-dialog")).not.toBeInTheDocument();
    pending.resolve();
    await expect.element(page.getByTestId(`${kind}-detail-dialog`)).not.toBeInTheDocument();
    expect(session.policy.isPolicyDirty).toBe(false);
  },
);

test("the newer-edits notice lives in the dialog and disappears with the next edit", async () => {
  const { session, hold, writes } = await setup();
  const pending = Promise.withResolvers<void>();
  hold(pending.promise);
  await page.getByTestId("team-card-group:ops").click();
  await page.getByTestId("team-member-remove-alice@").click();
  await page.getByTestId("team-detail-close").click();
  await page.getByTestId("unsaved-changes-save").click();
  await expect.poll(() => writes.length).toBe(1);
  await page.getByTestId("team-add-member-trigger").click();
  await page.getByTestId("team-add-member-option-bob@").click();
  pending.resolve();
  const notice = page.getByTestId("dialog-policy-save-notice");
  await expect.element(notice).toHaveTextContent(getProductCopy("en-US").policySavedNewerEdits);
  await expect.element(page.getByTestId("policy-save-notice")).not.toBeInTheDocument();
  await page.getByTestId("team-member-remove-bob@").click();
  await expect.element(notice).not.toBeInTheDocument();
  await page.getByTestId("team-detail-close").click();
  await expect.element(page.getByTestId("team-detail-dialog")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("policy-save-notice")).not.toBeInTheDocument();
  expect(session.policy.isPolicyDirty).toBe(false);
});

test("custom port fields are labelled, left-to-right and grouped per accessor", async () => {
  await setup(twoTags);
  try {
    await page.getByTestId("tag-card-tag:a").click();
    const input = page.getByRole("textbox", { name: "Custom ports" });
    await expect.element(input).toHaveAttribute("dir", "ltr");
    await expect.element(page.getByRole("group", { name: "ops" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await setLocale("ar");
    await page.getByTestId("tag-card-tag:b").click();
    await expect
      .element(page.getByTestId("tag-accessor-custom-group:ops"))
      .toHaveAttribute("dir", "ltr");
    const field = page.getByTestId("tag-accessor-custom-group:ops").element();
    expect(field instanceof HTMLInputElement && field.labels?.length).toBe(1);
  } finally {
    await setLocale("en-US");
  }
});

test("IP rule addresses stay left-to-right in a right-to-left locale", async () => {
  const { session } = await setup({
    acls: [{ action: "accept", src: ["10.0.0.0/8"], dst: ["::/0:443"] }],
  });
  try {
    await setLocale("ar");
    const rule = session.policy.getSnapshot().policyRules[0];
    if (!rule) throw new Error("Missing IP fixture");
    const row = page.getByTestId(`ip-rule-${rule.id}`).element();
    expect(row.textContent).toContain("::/0");
    expectNetworkTokensLtr(row, 2);
  } finally {
    await setLocale("en-US");
  }
});

test("a rule whose port selector names no service still shows a custom-ports summary", async () => {
  await setup({
    groups: { "group:ops": ["alice@"] },
    tagOwners: { "tag:server": ["alice@"] },
    acls: [{ action: "accept", src: ["group:ops"], dst: ["tag:server:,"] }],
  });
  const custom = getProductCopy("en-US").svcCustomLabel;
  await expect
    .element(page.getByTestId("tag-card-tag:server"))
    .toMatchTextContent(new RegExp(`· ${custom}`));
  await page.getByTestId("team-card-group:ops").click();
  await expect
    .element(page.getByTestId("team-access-row-tag:server"))
    .toMatchTextContent(new RegExp(custom));
});

test("the member picker skips users without a principal and labels the rest by the best name they have", async () => {
  await setup(policy(), [
    ...defaultUsers,
    { id: "4", name: "carol" },
    { id: "5", name: "", email: "dave@example.com" },
    { id: "9", name: "" },
    { id: "10", name: "  " },
  ]);
  await page.getByTestId("team-card-group:ops").click();
  await page.getByTestId("team-add-member-trigger").click();
  const options = Array.from(
    page.getByTestId("team-add-member-list").element().querySelectorAll("[data-testid]"),
    (option) => option.getAttribute("data-testid"),
  );
  expect(options.sort()).toEqual([
    "team-add-member-option-bob@",
    "team-add-member-option-carol@",
    "team-add-member-option-dave@example.com",
  ]);
  await expect
    .element(page.getByTestId("team-add-member-option-carol@"))
    .toHaveTextContent("carol");
  const daveLabel = page
    .getByTestId("team-add-member-option-dave@example.com")
    .element()
    .querySelector(".font-medium");
  expect(daveLabel?.textContent).toBe("dave@example.com");
});

test("a blank label name on Enter or blur is not an edit", async () => {
  const { session } = await setup();
  const before = JSON.stringify(session.policy.policyPayload);
  await page.getByTestId("new-device-label").click();
  await page.getByTestId("tag-name-input").fill("   ");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("tag-policy-reference-error")).not.toBeInTheDocument();
  await page.getByTestId("tag-detail-close").click();
  await expect.element(page.getByTestId("tag-detail-dialog")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("unsaved-changes-dialog")).not.toBeInTheDocument();
  expect(session.policy.isPolicyDirty).toBe(false);
  expect(JSON.stringify(session.policy.policyPayload)).toBe(before);
  // Clearing the name of an existing label is not a rename to an invalid name either.
  await page.getByTestId("tag-card-tag:server").click();
  await page.getByTestId("tag-name-input").fill("");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("tag-policy-reference-error")).not.toBeInTheDocument();
  expect(JSON.stringify(session.policy.policyPayload)).toBe(before);
});

test("a policy group named * cannot be picked as an accessor", async () => {
  const { session } = await setup({ ...policy(), groups: { "group:ops": ["alice@"], "*": [] } });
  await page.getByTestId("tag-card-tag:server").click();
  await page.getByTestId("tag-add-accessor-trigger").click();
  await page.getByTestId("tag-add-accessor-option-*").click();
  expect(session.policy.isPolicyDirty).toBe(false);
  await expect.element(page.getByTestId("high-risk-confirm-dialog")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("tag-accessor-row-*")).not.toBeInTheDocument();
});

test("activating the all-ports confirmation twice while it closes applies the change once", async () => {
  const { session } = await setup();
  await page.getByTestId("tag-card-tag:server").click();
  await page.getByTestId("tag-accessor-svc-group:ops-all").click();
  await expect.element(page.getByTestId("high-risk-confirm-dialog")).toBeVisible();
  const confirm = page.getByTestId("high-risk-confirm").element();
  const { errors, stop } = captureErrors();
  try {
    domClick(confirm);
    // The dialog stays mounted for its exit animation; the second activation sees the cleared action.
    await Promise.resolve();
    domClick(confirm);
  } finally {
    stop();
  }
  expect(errors).toEqual([]);
  expect(session.policy.policyPayload?.acls).toEqual([
    { action: "accept", src: ["*"], dst: ["*:*"] },
    { action: "accept", src: ["group:ops"], dst: ["tag:server:*"] },
  ]);
  await expect.element(page.getByTestId("high-risk-confirm-dialog")).not.toBeInTheDocument();
});

test("reopening the removal dialog before its deferred cleanup keeps the new target", async () => {
  const { session } = await setup();
  await page.getByTestId("tag-remove-tag:server").click();
  const cancel = page.getByTestId("cancel-remove-policy-item").element();
  const removeTeam = page.getByTestId("team-remove-group:ops").element();
  // Both clicks land in one task, so the cleanup deferred by the cancel has not run yet.
  domClick(cancel);
  domClick(removeTeam);
  await expect.element(page.getByTestId("remove-policy-item-dialog")).toMatchTextContent("ops");
  await expect.element(page.getByTestId("confirm-remove-policy-item")).toBeEnabled();
  await page.getByTestId("confirm-remove-policy-item").click();
  expect(session.policy.policyPayload?.groups).toEqual({});
  // Only the team went; the label it owned stays.
  expect(session.policy.policyPayload?.tagOwners).toEqual({ "tag:server": [] });
});

test("discarding after a save made in the open dialog reverts to the saved policy", async () => {
  const { session, hold, writes } = await setup();
  const pending = Promise.withResolvers<void>();
  hold(pending.promise);
  await page.getByTestId("team-card-group:ops").click();
  await page.getByTestId("team-member-remove-alice@").click();
  await page.getByTestId("team-detail-close").click();
  await page.getByTestId("unsaved-changes-save").click();
  await expect.poll(() => writes.length).toBe(1);
  await page.getByTestId("team-add-member-trigger").click();
  await page.getByTestId("team-add-member-option-bob@").click();
  pending.resolve();
  await expect.element(page.getByTestId("dialog-policy-save-notice")).toBeVisible();
  await page.getByTestId("team-detail-close").click();
  await page.getByTestId("unsaved-changes-discard").click();
  await expect.element(page.getByTestId("team-detail-dialog")).not.toBeInTheDocument();
  expect(session.policy.policyPayload?.groups).toEqual({ "group:ops": [] });
  expect(session.policy.isPolicyDirty).toBe(false);
});

test("a failed save-and-close whose dialog changed meanwhile shows the error without a context notice", async () => {
  const { session, fail, hold, writes } = await setup();
  const pending = Promise.withResolvers<void>();
  hold(pending.promise);
  fail("boom");
  await page.getByTestId("team-card-group:ops").click();
  await page.getByTestId("team-member-remove-alice@").click();
  await page.getByTestId("team-detail-close").click();
  await page.getByTestId("unsaved-changes-save").click();
  await expect.poll(() => writes.length).toBe(1);
  await page.getByTestId("team-name-input").fill("other");
  pending.resolve();
  await expect.element(page.getByTestId("dialog-save-policy-error")).toHaveTextContent("boom");
  await expect.element(page.getByTestId("team-detail-dialog")).toBeVisible();
  await expect.element(page.getByTestId("dialog-policy-save-notice")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("unsaved-changes-dialog")).not.toBeInTheDocument();
  expect(session.policy.isPolicyDirty).toBe(true);
});

test("orphan references are marked on label cards and in the label dialog", async () => {
  await setup({
    groups: { "group:ops": ["alice@", "ghost@"] },
    tagOwners: { "tag:server": ["ghost@"] },
    acls: [
      { action: "accept", src: ["ghost@"], dst: ["tag:server:22"] },
      { action: "accept", src: ["alice@"], dst: ["tag:server:80"] },
    ],
  });
  const copy = getProductCopy("en-US");
  const card = page.getByTestId("tag-card-tag:server").element();
  const marked = card.querySelectorAll(`[title="${copy.orphanReferenceTooltip}"]`);
  expect(Array.from(marked, (badge) => badge.textContent?.trim())).toEqual(["ghost@", "ghost@"]);
  expect(Array.from(marked, (badge) => badge.querySelector("svg") !== null)).toEqual([true, true]);
  await page.getByTestId("tag-card-tag:server").click();
  await expect
    .element(page.getByTestId("tag-accessor-row-ghost@"))
    .toMatchTextContent(new RegExp(copy.orphanReferenceBadge));
  await expect
    .element(page.getByTestId("tag-owner-row-ghost@"))
    .toMatchTextContent(new RegExp(copy.orphanReferenceBadge));
  await expect
    .element(page.getByTestId("tag-accessor-row-alice@"))
    .not.toHaveTextContent(copy.orphanReferenceBadge);
});

test("a team the saved policy no longer holds ignores name and member edits", async () => {
  const { session, hold, accept, writes } = await setup();
  const pending = Promise.withResolvers<void>();
  hold(pending.promise);
  accept(JSON.stringify({ ...policy(), groups: {} }));
  await page.getByTestId("team-card-group:ops").click();
  await page.getByTestId("team-member-remove-alice@").click();
  await page.getByTestId("team-detail-close").click();
  await page.getByTestId("unsaved-changes-save").click();
  await expect.poll(() => writes.length).toBe(1);
  await page.getByTestId("team-name-input").fill("renamed");
  pending.resolve();
  await expect.element(page.getByTestId("dialog-policy-save-notice")).toBeVisible();
  const { errors, stop } = captureErrors();
  try {
    await userEvent.keyboard("{Enter}");
    await page.getByTestId("team-add-member-trigger").click();
    await page.getByTestId("team-add-member-option-bob@").click();
  } finally {
    stop();
  }
  expect(errors).toEqual([]);
  await expect.element(page.getByTestId("team-policy-reference-error")).not.toBeInTheDocument();
  expect(session.policy.policyPayload?.groups).toEqual({});
  expect(session.policy.isPolicyDirty).toBe(false);
});
