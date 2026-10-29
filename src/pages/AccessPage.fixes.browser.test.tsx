import "fake-indexeddb/auto";
import type { FetchHandle } from "@defjs/core";
import { afterEach, expect, test, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import type { Session } from "@/composables/session-context";
import { i18n, setLocale } from "@/i18n";
import { getProductCopy } from "@/i18n/product-copy";
import { getLocaleI18n, loadLocale } from "@/i18n/runtime";
import {
  authenticateTestSession,
  prepareTestSession,
  renderSessionPage,
} from "@/test/session";
import AccessPage from "./AccessPage";

const copy = getProductCopy("en-US");
const users = [
  { id: "1", name: "alice", displayName: "Alice", email: "alice@example.com" },
  { id: "2", name: "bob", displayName: "Bob" },
];
const opsPolicy = {
  groups: { "group:ops": ["alice@"] },
  tagOwners: { "tag:server": ["group:ops"] },
  acls: [{ action: "accept", src: ["group:ops"], dst: ["tag:server:22"] }],
};

async function setup(initial: Record<string, unknown> | string = opsPolicy) {
  const writes: string[] = [];
  let checkFailure = "";
  let nodes: unknown[] = [];
  let policyText =
    typeof initial === "string" ? initial : JSON.stringify(initial);
  const transport: FetchHandle = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/api/v1/policy/check")
      return checkFailure
        ? Response.json({ message: checkFailure }, { status: 400 })
        : Response.json({});
    if (request.method === "PUT" && path === "/api/v1/policy") {
      const body = (await request.json()) as { policy: string };
      writes.push(body.policy);
      policyText = body.policy;
      return Response.json(body);
    }
    const values: Record<string, unknown> = {
      "/api/v1/health": { databaseConnectivity: true, serverReachable: true },
      "/version": { version: "0.29.4" },
      "/api/v1/user": { users },
      "/api/v1/node": { nodes },
      "/api/v1/preauthkey": { preAuthKeys: [] },
      "/api/v1/apikey": { apiKeys: [] },
      "/api/v1/policy": { policy: policyText },
    };
    if (request.method !== "GET" || !(path in values))
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    return Response.json(values[path]);
  };
  const session = await prepareTestSession(transport);
  await setLocale("en-US");
  // The central catalog is compiled separately; test the real help behavior, not that handoff.
  const messages = {
    "product.policyReferenceHelp": "About this stale reference",
  };
  i18n.load("en-US", messages);
  getLocaleI18n("en-US").load("en-US", messages);
  await authenticateTestSession(session);
  await renderSessionPage(session, <AccessPage />, "/access");
  await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
  await expect.element(page.getByTestId("save-policy")).toBeVisible();
  return {
    session,
    writes,
    setNodes: (next: unknown[]) => {
      nodes = next;
    },
    failCheck: (message: string) => {
      checkFailure = message;
    },
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await page.viewport(1280, 720);
  await setLocale("en-US");
});

function tagNodes(session: Session, ...tags: string[][]) {
  session.snapshot.applyPatch({
    nodes: tags.map((nodeTags, index) => ({
      id: String(index + 1),
      name: `node-${index + 1}`,
      online: false,
      ipAddresses: [],
      availableRoutes: [],
      approvedRoutes: [],
      subnetRoutes: [],
      tags: nodeTags,
      expiry: undefined,
      lastSeen: undefined,
    })),
  });
}
function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}
const acls = (session: Session) => session.policy.policyPayload?.acls;

test.each([
  ["card accessor", "ghost-accessor@"],
  ["card owner", "ghost-owner@"],
  ["tag accessor", "ghost-accessor@"],
  ["tag owner", "ghost-owner@"],
  ["team member", "ghost-member@"],
  ["RTL card owner", "ghost-owner@"],
] as const)(
  "feedback: %s help supports keyboard and native touch without changing the draft",
  async (location, identity) => {
    // Establish mobile geometry before rendering a modal, rather than sampling during its reflow.
    await page.viewport(375, 812);
    await cdp().send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 1,
    });
    const { session, writes } = await setup({
      groups: { "group:ops": ["ghost-member@", "ghost-accessor@"] },
      tagOwners: { "tag:server": ["ghost-owner@"] },
      acls: [
        { action: "accept", src: ["ghost-accessor@"], dst: ["tag:server:22"] },
      ],
    });
    const locale = location.startsWith("RTL") ? "ar" : "en-US";
    if (locale === "ar") {
      await loadLocale(locale);
      getLocaleI18n(locale).load(locale, {
        "product.policyReferenceHelp": "About this stale reference",
      });
      await setLocale(locale);
    }
    if (location.startsWith("tag"))
      await page.getByTestId("tag-open-tag:server").click();
    if (location.startsWith("team"))
      await page.getByTestId("team-card-group:ops").click();
    const trigger = page.getByRole("button", {
      name: `About this stale reference ${identity}`,
      exact: true,
    });
    await expect.element(trigger).toBeVisible();
    for (
      let index = 0;
      index < 60 && document.activeElement !== trigger.element();
      index++
    )
      await userEvent.keyboard("{Tab}");
    await expect.element(trigger).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    const help = page.getByRole("dialog", {
      name: "About this stale reference",
      exact: true,
    });
    await expect.element(help).toBeVisible();
    expect(help.element().textContent).toContain(
      getProductCopy(locale).orphanReferenceTooltip,
    );
    await userEvent.keyboard("{Escape}");
    await expect.element(help).not.toBeInTheDocument();
    await expect.element(trigger).toHaveFocus();

    trigger.element().scrollIntoView({ block: "center" });
    await nextFrame();
    const touchEvents: string[] = [];
    for (const type of ["pointerdown", "pointerup", "click"]) {
      trigger
        .element()
        .addEventListener(
          type,
          (event) =>
            touchEvents.push(`${type}:${(event as PointerEvent).pointerType}`),
          { once: true },
        );
    }
    const rect = trigger.element().getBoundingClientRect();
    const frame = (
      window.frameElement as HTMLElement | null
    )?.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    expect(
      trigger.element().contains(hit),
      `help hit target: ${hit?.outerHTML}`,
    ).toBe(true);
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
    expect(touchEvents).toEqual([
      "pointerdown:touch",
      "pointerup:touch",
      "click:touch",
    ]);
    await expect.element(help).toBeVisible();
    await help
      .getByText(getProductCopy(locale).orphanReferenceTooltip, { exact: true })
      .click();
    const helpRect = help.element().getBoundingClientRect();
    expect(helpRect.left).toBeGreaterThanOrEqual(0);
    expect(helpRect.right).toBeLessThanOrEqual(window.innerWidth);
    expect(session.policy.getSnapshot().tagDetailOpen).toBe(
      location.startsWith("tag"),
    );
    expect(session.policy.getSnapshot().teamDetailOpen).toBe(
      location.startsWith("team"),
    );
    expect(session.policy.isPolicyDirty).toBe(false);
    expect(writes).toEqual([]);
  },
);

test("a template that replaces the implicit allow-all asks first and names the consequence", async () => {
  const { session } = await setup("");
  await page.getByTestId("template-apply-small-team").click();
  const dialog = page.getByTestId("template-confirm-dialog");
  await expect.element(dialog).toBeVisible();
  await expect.element(dialog).toMatchTextContent(/0\.0\.0\.0\/0/);
  await expect.element(dialog).toMatchTextContent(/untagged/i);
  await page.getByTestId("template-confirm-cancel").click();
  expect(session.policy.isPolicyDirty).toBe(false);
  await page.getByTestId("template-apply-small-team").click();
  await page.getByTestId("template-confirm-apply").click();
  expect(acls(session)).toEqual([
    { action: "accept", src: ["group:team"], dst: ["tag:shared:22,80,443"] },
  ]);
  await expect
    .element(page.getByTestId("team-empty-warning-group:team"))
    .toHaveTextContent(copy.emptyTeamWarning);
});

test("activating the template confirmation twice while it closes applies the template once", async () => {
  const { session } = await setup("");
  await page.getByTestId("template-apply-small-team").click();
  const confirm = page.getByTestId("template-confirm-apply").element();
  confirm.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  // The dialog stays mounted for its exit animation; the second activation sees no template.
  await Promise.resolve();
  confirm.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  await expect
    .element(page.getByTestId("template-confirm-dialog"))
    .not.toBeInTheDocument();
  expect(
    session.policy.getSnapshot().policyGroups.map((group) => group.name),
  ).toEqual(["group:team"]);
});

test("a template that removes no rule applies without a confirmation", async () => {
  const { session } = await setup({ acls: [] });
  await page.getByTestId("template-apply-self-only").click();
  await expect
    .element(page.getByTestId("template-confirm-dialog"))
    .not.toBeInTheDocument();
  expect(acls(session)).toEqual([
    { action: "accept", src: ["*"], dst: ["tag:personal:*"] },
  ]);
});

test("the IP rule section is always offered and can add an allow-all rule", async () => {
  const { session } = await setup();
  const section = page.getByTestId("ip-rules-section");
  await expect.element(section).toBeVisible();
  await expect.element(section).toMatchTextContent(copy.noIpRules);
  await page.getByTestId("add-ip-rule").click();
  await expect.element(page.getByTestId("ip-rule-source-new")).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByTestId("ip-rule-source-new-error"))
    .toHaveTextContent(copy.ipRuleFieldsRequired);
  expect(session.policy.isPolicyDirty).toBe(false);
  await page.getByTestId("ip-rule-source-new").fill("*");
  await page.getByTestId("ip-rule-destination-new").fill("*");
  await page.getByTestId("ip-rule-ports-new").fill("*");
  await page.getByTestId("ip-rule-save-new").click();
  await expect
    .element(page.getByTestId("ip-rule-edit-form-new"))
    .not.toBeInTheDocument();
  await expect.element(page.getByTestId("add-ip-rule")).toHaveFocus();
  expect(acls(session)).toEqual([
    { action: "accept", src: ["group:ops"], dst: ["tag:server:22"] },
    { action: "accept", src: ["*"], dst: ["*:*"] },
  ]);
  await expect.element(page.getByTestId("open-access-banner")).toBeVisible();
  await page.getByTestId("add-ip-rule").click();
  await page.getByTestId("ip-rule-cancel-new").click();
  await expect.element(page.getByTestId("add-ip-rule")).toHaveFocus();
});

test("deleting an IP rule asks for confirmation and states the consequence", async () => {
  const { session } = await setup({
    acls: [
      { action: "accept", src: ["10.0.0.0/8"], dst: ["192.168.0.0/16:443"] },
    ],
  });
  const rule = session.policy.getSnapshot().policyRules[0];
  if (!rule) throw new Error("Missing IP fixture");
  await page.getByTestId(`ip-rule-remove-${rule.id}`).click();
  const dialog = page.getByTestId("remove-policy-item-dialog");
  await expect
    .element(dialog)
    .toMatchTextContent("10.0.0.0/8 → 192.168.0.0/16 · 443");
  await expect
    .element(page.getByTestId("policy-removal-consequence"))
    .toHaveTextContent(copy.removeIpRuleConsequence);
  await expect
    .element(page.getByTestId("policy-removal-impact"))
    .not.toBeInTheDocument();
  await page.getByTestId("cancel-remove-policy-item").click();
  expect(session.policy.isPolicyDirty).toBe(false);
  await page.getByTestId(`ip-rule-remove-${rule.id}`).click();
  await page.getByTestId("confirm-remove-policy-item").click();
  expect(acls(session)).toEqual([]);
  await expect.element(page.getByTestId("deny-all-banner")).toBeVisible();
});

test("page edits can be discarded after a confirmation and Save needs an edit", async () => {
  const { session, writes } = await setup();
  await expect.element(page.getByTestId("save-policy")).toBeDisabled();
  await expect
    .element(page.getByTestId("discard-policy-changes"))
    .not.toBeInTheDocument();
  await page.getByTestId("team-remove-group:ops").click();
  await page.getByTestId("confirm-remove-policy-item").click();
  await expect.element(page.getByTestId("save-policy")).toBeEnabled();
  await page.getByTestId("discard-policy-changes").click();
  await expect.element(page.getByTestId("discard-policy-dialog")).toBeVisible();
  await page.getByTestId("discard-policy-cancel").click();
  expect(session.policy.isPolicyDirty).toBe(true);
  await page.getByTestId("discard-policy-changes").click();
  await page.getByTestId("discard-policy-confirm").click();
  expect(session.policy.isPolicyDirty).toBe(false);
  expect(session.policy.policyPayload).toMatchObject(opsPolicy);
  await expect.element(page.getByTestId("team-card-group:ops")).toBeVisible();
  await expect.element(page.getByTestId("save-policy")).toBeDisabled();
  expect(writes).toEqual([]);
});

test("without a server policy Save stays disabled until an edit", async () => {
  await setup("");
  await expect.element(page.getByTestId("save-policy")).toBeDisabled();
  await page.getByTestId("template-apply-self-only").click();
  await page.getByTestId("template-confirm-apply").click();
  await expect.element(page.getByTestId("save-policy")).toBeEnabled();
});

test("a policy without ACLs or grants warns that nothing is allowed", async () => {
  await setup({ acls: [] });
  const banner = page.getByTestId("deny-all-banner");
  await expect.element(banner).toMatchTextContent(copy.denyAllBannerTitle);
  await expect
    .element(page.getByTestId("open-access-banner"))
    .not.toBeInTheDocument();
});

test("a grants-only policy does not show the deny-all warning", async () => {
  await setup({ grants: [{ src: ["*"], dst: ["*"], ip: ["*"] }] });
  await expect
    .element(page.getByTestId("grants-preserved-notice"))
    .toBeVisible();
  await expect
    .element(page.getByTestId("deny-all-banner"))
    .not.toBeInTheDocument();
});

test.each(["team", "tag"] as const)(
  "Done keeps %s dialog edits in the page draft without a prompt",
  async (kind) => {
    const { session } = await setup();
    if (kind === "team") {
      await page.getByTestId("team-card-group:ops").click();
      await page.getByTestId("team-member-remove-alice@").click();
    } else {
      await page.getByTestId("tag-open-tag:server").click();
      await page.getByTestId("tag-accessor-remove-group:ops").click();
    }
    const hint = page.getByTestId(`${kind}-dialog-unsaved-hint`);
    await expect.element(hint).toHaveTextContent(copy.dialogChangesKeptHint);
    await page.getByTestId(`${kind}-detail-close`).click();
    await expect
      .element(page.getByTestId(`${kind}-detail-dialog`))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByTestId("unsaved-changes-dialog"))
      .not.toBeInTheDocument();
    expect(session.policy.isPolicyDirty).toBe(true);
    await expect
      .element(page.getByTestId("save-policy-dirty-badge"))
      .toBeVisible();
  },
);

test("dismissing a dialog with edits offers cancel, discard and save with honest copy", async () => {
  const { session } = await setup();
  await page.getByTestId("team-card-group:ops").click();
  await page.getByTestId("team-member-remove-alice@").click();
  await userEvent.keyboard("{Escape}");
  const guard = page.getByTestId("unsaved-changes-dialog");
  await expect.element(guard).toMatchTextContent(copy.dialogUnsavedChangesBody);
  await expect
    .element(page.getByTestId("unsaved-changes-discard"))
    .toHaveTextContent(copy.discardDialogChanges);
  await page.getByTestId("unsaved-changes-keep-editing").click();
  await expect.element(page.getByTestId("team-detail-dialog")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("unsaved-changes-discard").click();
  await expect
    .element(page.getByTestId("team-detail-dialog"))
    .not.toBeInTheDocument();
  expect(session.policy.isPolicyDirty).toBe(false);
});

test("deleting a label still on devices says the devices keep the tag", async () => {
  const { session, setNodes } = await setup();
  tagNodes(session, ["tag:server"], ["tag:server"]);
  setNodes(session.snapshot.getSnapshot().snapshot.nodes);
  await page.getByTestId("tag-remove-tag:server").click();
  await expect
    .element(page.getByTestId("policy-removal-devices"))
    .toMatchTextContent(/2 devices carry this label.+keep the tag/);
});

test("a label that only comes from devices cannot be renamed or deleted and says why", async () => {
  const { session } = await setup();
  tagNodes(session, ["tag:legacy"]);
  const card = page.getByTestId("tag-card-tag:legacy");
  await expect.element(card).toMatchTextContent(copy.deviceOnlyLabelBadge);
  await expect
    .element(page.getByTestId("tag-remove-tag:legacy"))
    .not.toBeInTheDocument();
  await page.getByTestId("tag-open-tag:legacy").click();
  await expect
    .element(page.getByTestId("tag-name-input"))
    .toHaveAttribute("readonly");
  await expect
    .element(page.getByTestId("tag-device-only-hint"))
    .toHaveTextContent(copy.policyDeclareTag);
  await expect
    .element(page.getByTestId("tag-name-confirm"))
    .not.toBeInTheDocument();
  await page.getByTestId("tag-add-owner-trigger").click();
  await page.getByTestId("tag-add-owner-option-bob@").click();
  await expect
    .element(page.getByTestId("tag-device-only-hint"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("tag-name-input"))
    .not.toHaveAttribute("readonly");
  expect(session.policy.policyPayload?.tagOwners).toMatchObject({
    "tag:legacy": ["bob@"],
  });
});

test.each([
  {
    kind: "team",
    create: "new-team",
    taken: "ops",
    message: copy.teamNameInvalid,
  },
  {
    kind: "tag",
    create: "new-device-label",
    taken: "server",
    message: copy.labelNameInvalid,
  },
])(
  "the $kind name validates on submission and then clears errors while typing",
  async ({ kind, create, taken, message }) => {
    await setup();
    await page.getByTestId(create).click();
    const input = page.getByTestId(`${kind}-name-input`);
    const error = page.getByTestId(`${kind}-name-input-error`);
    await input.fill("bad name");
    await expect.element(error).not.toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    await expect.element(error).toHaveTextContent(message);
    await expect.element(input).toHaveAttribute("aria-invalid", "true");
    await expect
      .element(page.getByTestId(`${kind}-name-confirm`))
      .toBeDisabled();
    await input.fill("fine");
    await expect.element(error).not.toBeInTheDocument();
    await input.fill(taken);
    await expect
      .element(error)
      .toHaveTextContent(copy.policyReferenceNameConflict);
    await input.fill(`${taken}-2`);
    await expect.element(error).not.toBeInTheDocument();
  },
);

test("a rename error disappears as soon as the name changes", async () => {
  const { session } = await setup({
    ...opsPolicy,
    extension: { owner: "group:ops" },
  });
  await page.getByTestId("team-card-group:ops").click();
  await page.getByTestId("team-name-input").fill("engineering");
  await userEvent.keyboard("{Enter}");
  const error = page.getByTestId("team-name-input-error");
  await expect.element(error).toMatchTextContent("extension");
  await page.getByTestId("team-name-input").fill("engineering2");
  await expect.element(error).not.toBeInTheDocument();
  expect(session.policy.isPolicyDirty).toBe(false);
});

test("IP rule edits normalize ports and reject a destination that already has a port", async () => {
  const { session } = await setup({
    acls: [
      { action: "accept", src: ["10.0.0.0/8"], dst: ["192.168.0.0/16:443"] },
    ],
  });
  const rule = session.policy.getSnapshot().policyRules[0];
  if (!rule) throw new Error("Missing IP fixture");
  await page.getByTestId(`ip-rule-edit-${rule.id}`).click();
  const destination = page.getByTestId(`ip-rule-destination-${rule.id}`);
  await destination.fill("10.0.0.1:22");
  await page.getByTestId(`ip-rule-save-${rule.id}`).click();
  await expect
    .element(page.getByTestId(`ip-rule-destination-${rule.id}-error`))
    .toHaveTextContent(copy.ipRuleDestinationHasPort);
  await expect.element(destination).toHaveAttribute("aria-invalid", "true");
  await expect
    .element(page.getByTestId(`ip-rule-source-${rule.id}`))
    .not.toHaveAttribute("aria-invalid", "true");
  expect(session.policy.isPolicyDirty).toBe(false);
  await destination.fill("10.0.0.1");
  await page.getByTestId(`ip-rule-ports-${rule.id}`).fill(" 22 , 80,");
  await page.getByTestId(`ip-rule-save-${rule.id}`).click();
  expect(acls(session)).toEqual([
    { action: "accept", src: ["10.0.0.0/8"], dst: ["10.0.0.1:22,80"] },
  ]);
});

test("IP rule editing moves focus in and back and names every field", async () => {
  const { session } = await setup({
    acls: [
      { action: "accept", src: ["10.0.0.0/8"], dst: ["192.168.0.0/16:443"] },
    ],
  });
  const rule = session.policy.getSnapshot().policyRules[0];
  if (!rule) throw new Error("Missing IP fixture");
  await page.getByTestId(`ip-rule-edit-${rule.id}`).click();
  await expect
    .element(page.getByTestId(`ip-rule-source-${rule.id}`))
    .toHaveFocus();
  for (const name of [
    copy.ipRuleSourcePlaceholder,
    copy.ipRuleDestinationPlaceholder,
    copy.ipRulePortsPlaceholder,
  ])
    await expect
      .element(page.getByRole("textbox", { name, exact: true }))
      .toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByTestId(`ip-rule-edit-${rule.id}`))
    .toHaveFocus();
  await page.getByTestId(`ip-rule-edit-${rule.id}`).click();
  await page.getByTestId(`ip-rule-ports-${rule.id}`).fill("8443");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByTestId(`ip-rule-edit-${rule.id}`))
    .toHaveFocus();
});

test("switching the edited IP rule keeps focus in the newly opened editor", async () => {
  const { session } = await setup({
    acls: [
      { action: "accept", src: ["10.0.0.0/8"], dst: ["192.168.0.0/16:443"] },
      { action: "accept", src: ["10.1.0.0/16"], dst: ["192.168.1.0/24:22"] },
    ],
  });
  const [first, second] = session.policy.getSnapshot().policyRules;
  if (!first || !second) throw new Error("Missing IP fixtures");
  await page.getByTestId(`ip-rule-edit-${second.id}`).click();
  await expect
    .element(page.getByTestId(`ip-rule-source-${second.id}`))
    .toHaveFocus();
  await page.getByTestId(`ip-rule-edit-${first.id}`).click();
  await expect
    .element(page.getByTestId(`ip-rule-source-${first.id}`))
    .toHaveFocus();
});

test("a rename onto a name the policy already uses is refused on submission", async () => {
  await setup({
    ...opsPolicy,
    groups: { "group:ops": ["alice@"], "group:dev": ["bob@"] },
  });
  await page.getByTestId("team-card-group:ops").click();
  await page.getByTestId("team-name-input").fill("dev");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByTestId("team-name-input-error"))
    .toHaveTextContent(copy.policyReferenceNameConflict);
});

test("a failed check disappears once the draft changes", async () => {
  const { failCheck } = await setup();
  failCheck("policy references an unknown user");
  await page.getByTestId("check-policy").click();
  await expect.element(page.getByTestId("check-policy-error")).toBeVisible();
  await page.getByTestId("team-remove-group:ops").click();
  await page.getByTestId("confirm-remove-policy-item").click();
  await expect
    .element(page.getByTestId("check-policy-error"))
    .not.toBeInTheDocument();
});

test("device tags stay visible while the policy is still empty", async () => {
  const { session } = await setup("");
  tagNodes(session, ["tag:server"]);
  await expect.element(page.getByTestId("resource-access-empty")).toBeVisible();
  await expect
    .element(page.getByTestId("tag-card-tag:server"))
    .toMatchTextContent(/1 device/);
});

test("tag search is named, has no-result feedback and can be cleared", async () => {
  await setup();
  const search = page.getByRole("searchbox", { name: copy.searchDeviceLabels });
  await search.fill("zzz");
  await expect
    .element(page.getByTestId("tag-search-empty"))
    .toMatchTextContent(copy.noDeviceLabelsMatch);
  await page.getByTestId("tag-search-clear").click();
  await expect.element(search).toHaveValue("");
  await expect.element(page.getByTestId("tag-card-tag:server")).toBeVisible();
  await expect
    .element(page.getByTestId("tag-search-empty"))
    .not.toBeInTheDocument();
});

test("card overflow uses localized counts and stale references offer help", async () => {
  await setup({
    groups: { "group:ops": ["alice@", "bob@", "c@", "d@", "e@"] },
    tagOwners: { "tag:server": ["alice@", "bob@", "c@", "d@"] },
    acls: [
      {
        action: "accept",
        src: ["alice@", "bob@", "ghost@", "d@"],
        dst: ["tag:server:22"],
      },
    ],
  });
  await expect
    .element(page.getByTestId("team-card-group:ops"))
    .toMatchTextContent("+1 more");
  const card = page.getByTestId("tag-card-tag:server");
  await expect.element(card).toMatchTextContent(/\+1 more.*\+1 more/);
  await expect.element(card.getByText("ghost@", { exact: true })).toBeVisible();
  const help = card.getByRole("button", {
    name: `${getProductCopy("en-US").policyReferenceHelp} c@`,
    exact: true,
  });
  await expect.element(help).toBeVisible();
  await help.click();
  await expect
    .element(page.getByText(copy.orphanReferenceTooltip, { exact: true }))
    .toBeVisible();
});

test.each([
  { kind: "team", card: "team-card-group:ops", value: "ops" },
  { kind: "tag", card: "tag-open-tag:server", value: "server" },
])(
  "the $kind name trims on Enter without dirtying an unchanged identity",
  async ({ kind, card, value }) => {
    const { session, writes } = await setup();
    await page.getByTestId(card).click();
    const input = page.getByTestId(`${kind}-name-input`);
    await input.fill(`  ${value}  `);
    await userEvent.keyboard("{Enter}");
    await expect.element(input).toHaveValue(value);
    expect(session.policy.isPolicyDirty).toBe(false);
    expect(writes).toEqual([]);
  },
);

test("custom port text under all ports trims on blur without rewriting the ACL", async () => {
  const initial = {
    ...opsPolicy,
    acls: [{ action: "accept", src: ["group:ops"], dst: ["tag:server:*"] }],
  };
  const { session, writes } = await setup(initial);
  await page.getByTestId("tag-open-tag:server").click();
  const input = page.getByTestId("tag-accessor-custom-group:ops");
  await input.fill("  7000 ,  7001  ");
  await userEvent.tab();
  await expect.element(input).toHaveValue("7000 ,  7001");
  expect(acls(session)).toEqual(initial.acls);
  expect(session.policy.isPolicyDirty).toBe(false);
  expect(writes).toEqual([]);
});

test("IP draft fields trim on blur but keep internal list spacing until local submission", async () => {
  const { session, writes } = await setup();
  await page.getByTestId("add-ip-rule").click();
  const source = page.getByTestId("ip-rule-source-new");
  const destination = page.getByTestId("ip-rule-destination-new");
  const ports = page.getByTestId("ip-rule-ports-new");
  await source.fill("  alice@,  group:ops  ");
  await destination.fill("  10.0.0.1  ");
  await ports.fill("  22 ,  80  ");
  await userEvent.tab();
  await expect.element(source).toHaveValue("alice@,  group:ops");
  await expect.element(destination).toHaveValue("10.0.0.1");
  await expect.element(ports).toHaveValue("22 ,  80");
  expect(session.policy.isPolicyDirty).toBe(false);
  await ports.click();
  await userEvent.keyboard("{Enter}");
  expect(acls(session)).toEqual([
    opsPolicy.acls[0],
    { action: "accept", src: ["alice@", "group:ops"], dst: ["10.0.0.1:22,80"] },
  ]);
  expect(writes).toEqual([]);
});

test("an IME Enter keeps the IP draft open until the composition has ended", async () => {
  const { session } = await setup();
  await page.getByTestId("add-ip-rule").click();
  await page.getByTestId("ip-rule-source-new").fill("alice@");
  await page.getByTestId("ip-rule-destination-new").fill("10.0.0.1");
  const ports = page.getByTestId("ip-rule-ports-new");
  await ports.fill(" 443 ");
  ports.element().dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  await expect.element(page.getByTestId("ip-rule-edit-form-new")).toBeVisible();
  expect(session.policy.isPolicyDirty).toBe(false);
  await userEvent.keyboard("{Enter}");
  expect(acls(session)).toContainEqual({
    action: "accept",
    src: ["alice@"],
    dst: ["10.0.0.1:443"],
  });
});

test("a team without members says so in its dialog", async () => {
  await setup({ groups: { "group:empty": [] }, acls: [] });
  await expect
    .element(page.getByTestId("team-empty-warning-group:empty"))
    .toHaveTextContent(copy.emptyTeamWarning);
  await page.getByTestId("team-card-group:empty").click();
  await expect
    .element(page.getByTestId("team-members-section"))
    .toMatchTextContent(copy.noPolicyGroupMembers);
  await nextFrame();
});
