import "fake-indexeddb/auto";
import type { FetchHandle } from "@defjs/core";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { HeadscaleSnapshot } from "@/api/contracts";
import { setLocale, t } from "@/i18n";
import { getProductCopy } from "@/i18n/product-copy";
import { authenticateTestSession, prepareTestSession, renderSessionPage } from "@/test/session";
import DevicesPage from "./DevicesPage";

const copy = getProductCopy("en-US");
const alice = { id: "1", name: "alice", displayName: "Alice", email: "alice@example.com" };
const bob = { id: "2", name: "bob", displayName: "Bob", email: "bob@example.com" };
const AUTH_ID = "hskey-authreq-a1B2c3D4e5F6g7H8i9J0k1L2";

function fixture(): HeadscaleSnapshot {
  return {
    health: { databaseConnectivity: true, serverReachable: true },
    version: { version: "0.29.4" },
    users: [{ ...alice }, { ...bob }, { id: "0", name: "tagged-devices" }],
    apiKeys: [],
    policy: { policy: JSON.stringify({ tagOwners: { "tag:server": ["alice@example.com"] } }) },
    nodes: [
      {
        id: "1",
        name: "edge",
        givenName: "edge-router",
        user: alice,
        online: true,
        lastSeen: "2001-01-01T00:00:00Z",
        ipAddresses: ["100.64.0.1"],
        approvedRoutes: ["10.42.0.0/16"],
        availableRoutes: ["10.42.0.0/16", "0.0.0.0/0"],
        subnetRoutes: [],
        tags: ["tag:server"],
        registerMethod: "REGISTER_METHOD_AUTH_KEY",
      },
      {
        id: "2",
        name: "laptop",
        user: bob,
        online: false,
        lastSeen: "2001-01-01T00:00:00Z",
        ipAddresses: ["100.64.0.2"],
        approvedRoutes: [],
        availableRoutes: [],
        subnetRoutes: [],
        tags: [],
        expiry: "2000-01-01T00:00:00Z",
        registerMethod: "REGISTER_METHOD_CLI",
      },
    ],
    preAuthKeys: [],
  };
}

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

async function setup(search = "", patch: (backend: HeadscaleSnapshot) => void = () => {}) {
  await page.viewport(1366, 768);
  const backend = fixture();
  patch(backend);
  const calls: Call[] = [];
  let failure = "";
  let writeHold: Promise<void> | undefined;
  const transport: FetchHandle = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const raw = await request.clone().text();
    const body = raw ? JSON.parse(raw) : Object.fromEntries(url.searchParams);
    calls.push({ method: request.method, path: url.pathname, body });
    if (writeHold && request.method !== "GET") await writeHold;
    if (failure && request.method !== "GET")
      return Response.json({ message: failure }, { status: 500 });
    if (request.method === "POST" && url.pathname === "/api/v1/preauthkey") {
      const preAuthKey = { id: "9", key: "created-key", used: false, ...body };
      backend.preAuthKeys.push({ ...preAuthKey, user: undefined, key: "masked" });
      return Response.json({ preAuthKey: { ...preAuthKey, user: undefined } });
    }
    if (request.method === "POST" && url.pathname === "/api/v1/auth/register") {
      const node = { ...backend.nodes[1], id: "3", name: "registered", givenName: "registered" };
      backend.nodes.push(node as (typeof backend.nodes)[number]);
      return Response.json({ node });
    }
    if (request.method === "POST" && url.pathname.startsWith("/api/v1/auth/"))
      return Response.json({});
    if (url.pathname.includes("/node/") && request.method !== "GET") {
      const node = backend.nodes.find((n) => n.id === url.pathname.split("/")[4]);
      if (!node) throw new Error("Missing fixture node");
      if (url.pathname.includes("/rename/"))
        node.givenName = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      if (url.pathname.endsWith("/tags")) node.tags = body.tags as string[];
      return Response.json({ node });
    }
    const responses: Record<string, unknown> = {
      "/api/v1/health": backend.health,
      "/version": backend.version,
      "/api/v1/user": { users: backend.users },
      "/api/v1/node": { nodes: backend.nodes },
      "/api/v1/preauthkey": { preAuthKeys: backend.preAuthKeys },
      "/api/v1/apikey": { apiKeys: [] },
      "/api/v1/policy": backend.policy,
    };
    return Response.json(responses[url.pathname]);
  };
  const session = await prepareTestSession(transport);
  await setLocale("en-US");
  await authenticateTestSession(session);
  const rendered = await renderSessionPage(session, <DevicesPage />, `/devices${search}`);
  await expect
    .poll(() => session.snapshot.getSnapshot().snapshot.health?.serverReachable)
    .toBe(true);
  await expect.poll(() => session.snapshot.isRefreshing).toBe(false);
  calls.length = 0;
  return {
    backend,
    calls,
    session,
    ...rendered,
    writes: () => calls.filter((call) => call.method !== "GET"),
    nodeReads: () => calls.filter((call) => call.method === "GET" && call.path === "/api/v1/node"),
    fail: (message: string) => {
      failure = message;
    },
    holdWrites: () => {
      let release!: () => void;
      writeHold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        writeHold = undefined;
        release();
      };
    },
  };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
afterEach(() => vi.restoreAllMocks());

function isOpen(testid: string) {
  return document.querySelector(`[data-testid="${testid}"]`)?.hasAttribute("data-open") === true;
}
async function openWizard(task: "server" | "client") {
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId(task === "server" ? "add-linux-device" : "add-client-device").click();
}
async function toGenerateStep(task: "server" | "client") {
  await openWizard(task);
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("add-device-next").click();
}
async function generateKey(task: "server" | "client" = "client") {
  await toGenerateStep(task);
  await page.getByTestId("generate-install-script").click();
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
}
async function openMenu(id: string, item: string) {
  await page.getByTestId(`machine-actions-trigger-${id}`).click();
  await page.getByTestId(`${item}-action-${id}`).click();
}
function keyWrites(ctx: Ctx) {
  return ctx.writes().filter((call) => call.path === "/api/v1/preauthkey");
}
function expectDays(value: unknown, days: number) {
  const delta = Date.parse(String(value)) - (Date.now() + days * 86_400_000);
  expect(Math.abs(delta)).toBeLessThan(120_000);
}

// Fix 1/6: a client device must survive going offline, and the key is created in the wizard itself.
test("the client preset creates a non-ephemeral single-use key directly from the wizard", async () => {
  const ctx = await setup();
  await openWizard("client");
  await expect
    .element(page.getByTestId("setup-ephemeral"))
    .toHaveAttribute("aria-checked", "false");
  await page.getByTestId("add-device-next").click();
  await expect.element(page.getByTestId("setup-reusable")).toHaveAttribute("aria-checked", "false");
  await expect.element(page.getByTestId("setup-owner")).toHaveValue("1");
  await page.getByTestId("add-device-next").click();
  await expect
    .element(page.getByTestId("generate-install-script"))
    .toHaveTextContent(copy.generateInstallCommand);
  await page.getByTestId("generate-install-script").click();
  await expect.element(page.getByTestId("created-invite")).toMatchTextContent("created-key");
  expect(document.querySelector('[data-testid="invite-create-dialog"]')).toBeNull();
  const [write] = keyWrites(ctx);
  expect(write?.body).toMatchObject({ user: "1", reusable: false, ephemeral: false, aclTags: [] });
  expectDays(write?.body.expiration, 7);
});

test("the server preset creates a reusable tag:server key for the chosen owner", async () => {
  const ctx = await setup();
  await openWizard("server");
  await expect.element(page.getByTestId("setup-tags")).toHaveValue("tag:server");
  await page.getByTestId("add-device-next").click();
  await expect.element(page.getByTestId("setup-reusable")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("setup-owner").selectOptions("2");
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("generate-install-script").click();
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  expect(keyWrites(ctx)[0]?.body).toMatchObject({
    user: "2",
    reusable: true,
    ephemeral: false,
    aclTags: ["tag:server"],
  });
});

// Fix 6: an owner-less key needs tags, and tags are checked before they reach the server.
test("the wizard requires tags for an owner-less key and rejects malformed tags", async () => {
  const ctx = await setup();
  await openWizard("client");
  await page.getByTestId("setup-tags").fill("tag:web db");
  await page.getByTestId("add-device-next").click();
  await expect.element(page.getByTestId("setup-tags-error")).toHaveTextContent(copy.invalidTags);
  await expect.element(page.getByTestId("setup-device-step")).toBeVisible();
  await page.getByTestId("setup-tags").fill("");
  await expect.element(page.getByTestId("setup-tags-error")).not.toBeInTheDocument();
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("setup-owner").selectOptions("");
  await page.getByTestId("add-device-next").click();
  await expect
    .element(page.getByTestId("setup-owner-error"))
    .toHaveTextContent(copy.inviteTagsRequired);
  await expect.element(page.getByTestId("setup-auth-key-step")).toBeVisible();
  await page.getByTestId("add-device-prev").click();
  await page.getByTestId("setup-tags").fill("tag:server tag:web");
  await page.getByTestId("add-device-next").click();
  await expect.element(page.getByTestId("setup-owner-error")).not.toBeInTheDocument();
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("generate-install-script").click();
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  const body = keyWrites(ctx)[0]?.body;
  expect(body).toMatchObject({ aclTags: ["tag:server", "tag:web"] });
  expect(body).not.toHaveProperty("user");
});

test("a rejected key shows the error in the wizard and a held key disables Generate", async () => {
  const ctx = await setup();
  await toGenerateStep("client");
  ctx.fail("Key denied");
  await page.getByTestId("generate-install-script").click();
  await expect.element(page.getByTestId("setup-generate-error")).toMatchTextContent("Key denied");
  await expect.element(page.getByTestId("created-invite")).not.toBeInTheDocument();
  ctx.fail("");
  const release = ctx.holdWrites();
  await page.getByTestId("generate-install-script").click();
  await expect.element(page.getByTestId("generate-install-script")).toBeDisabled();
  await expect.element(page.getByTestId("setup-generate-error")).not.toBeInTheDocument();
  release();
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  expect(keyWrites(ctx)).toHaveLength(2);
});

// Fix 18: a preset tag that no tag owner defines would make every key with it fail.
test("the server preset warns when tag:server has no tag owner", async () => {
  await setup("", (backend) => {
    backend.policy = { policy: JSON.stringify({ tagOwners: { "tag:db": [] } }) };
  });
  await openWizard("server");
  await expect.element(page.getByTestId("setup-tags-undefined")).toMatchTextContent("tag:server");
  await page.getByTestId("setup-tags").fill("tag:db");
  await expect.element(page.getByTestId("setup-tags-undefined")).not.toBeInTheDocument();
  await page.getByTestId("setup-manage-tags").click();
});

test("no undefined-tag hint is shown when the policy defines the tag or cannot be read", async () => {
  const ctx = await setup();
  await openWizard("server");
  await expect.element(page.getByTestId("setup-tags")).toHaveValue("tag:server");
  expect(document.querySelector('[data-testid="setup-tags-undefined"]')).toBeNull();
  ctx.session.snapshot.applyPatch({ policy: { policy: '{"tagOwners":' } });
  await page.getByTestId("setup-tags").fill("tag:other");
  await expect.element(page.getByTestId("setup-tags")).toHaveValue("tag:other");
  expect(document.querySelector('[data-testid="setup-tags-undefined"]')).toBeNull();
  ctx.session.snapshot.applyPatch({ policy: null });
  await page.getByTestId("setup-tags").fill("tag:third");
  await expect.element(page.getByTestId("setup-tags")).toHaveValue("tag:third");
  expect(document.querySelector('[data-testid="setup-tags-undefined"]')).toBeNull();
});

// Fix 4: the days field keeps what is typed and only settles the value when it is left.
test("the key lifetime field accepts typed values and clamps them on blur", async () => {
  const ctx = await setup();
  await openWizard("client");
  await page.getByTestId("add-device-next").click();
  const input = page.getByTestId("setup-expiration");
  await input.click();
  await userEvent.keyboard("{Backspace}");
  await expect.element(input).toHaveValue("");
  await userEvent.keyboard("30");
  await expect.element(input).toHaveValue("30");
  await userEvent.tab();
  await expect.element(input).toHaveValue("30");
  await input.fill("95");
  await expect.element(input).toHaveValue("95");
  await userEvent.tab();
  await expect.element(input).toHaveValue("90");
  await expect.element(page.getByTestId("setup-expiration-increment")).toBeDisabled();
  await input.fill("0");
  await userEvent.tab();
  await expect.element(input).toHaveValue("1");
  await expect.element(page.getByTestId("setup-expiration-decrement")).toBeDisabled();
  await input.fill("abc");
  await userEvent.tab();
  await expect.element(input).toHaveValue("1");
  await page.getByTestId("setup-expiration-increment").click();
  await expect.element(input).toHaveValue("2");
  await input.fill("12");
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("generate-install-script").click();
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  expectDays(keyWrites(ctx)[0]?.body.expiration, 12);
});

test("the day stepper buttons are named and the range hint describes the field", async () => {
  await setup();
  await openWizard("client");
  await page.getByTestId("add-device-next").click();
  await expect
    .element(page.getByRole("button", { name: copy.decreaseDays }))
    .toHaveAttribute("data-testid", "setup-expiration-decrement");
  await expect
    .element(page.getByRole("button", { name: copy.increaseDays }))
    .toHaveAttribute("data-testid", "setup-expiration-increment");
  await expect
    .element(page.getByTestId("setup-expiration"))
    .toHaveAttribute("aria-describedby", "setup-expiration-hint");
  await expect
    .element(page.getByTestId("setup-expiration-hint"))
    .toHaveTextContent(copy.mustBeBetweenDays);
  await page.getByTestId("setup-expiration").click();
  await userEvent.tab();
  await expect.element(page.getByTestId("setup-expiration")).toHaveValue("7");
});

test("the wizard owner falls back when the chosen user disappears or none is visible", async () => {
  const ctx = await setup();
  await openWizard("client");
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("setup-owner").selectOptions("2");
  const users = ctx.session.snapshot.getSnapshot().snapshot.users;
  ctx.session.snapshot.applyPatch({ users: users.filter((user) => user.id !== "2") });
  await expect.element(page.getByTestId("setup-owner")).toHaveValue("1");
  ctx.session.snapshot.applyPatch({ users: [{ id: "0", name: "tagged-devices" }] });
  await expect.element(page.getByTestId("setup-owner")).toHaveValue("");
  await page.getByTestId("add-device-prev").click();
  await page.getByTestId("add-device-prev").click();
  await page.getByTestId("add-client-device").click();
  await page.getByTestId("add-device-next").click();
  await expect.element(page.getByTestId("setup-owner")).toHaveValue("");
});

// Fix 5: a key generated with the previous options must not stay next to the new options.
test("going back from the generate step clears the generated key", async () => {
  const ctx = await setup();
  await generateKey();
  await page.getByTestId("add-device-prev").click();
  expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe("");
  await page.getByTestId("add-device-next").click();
  await expect.element(page.getByTestId("created-invite")).not.toBeInTheDocument();
  await page.getByTestId("generate-install-script").click();
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  await page.getByTestId("add-device-step-preferences").click();
  await page.getByTestId("setup-ephemeral").click();
  expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe("");
  await page.getByTestId("add-device-next").click();
  await page.getByTestId("add-device-next").click();
  await expect.element(page.getByTestId("created-invite")).not.toBeInTheDocument();
});

// Fix 7: the login server may differ from the API address behind a proxy.
test("the login server URL is editable, validated and kept for the session", async () => {
  await setup();
  await generateKey();
  const field = page.getByTestId("setup-login-server");
  await expect.element(field).toHaveValue("https://fixture.invalid");
  await field.fill("https://hs.example.com/");
  await expect
    .element(page.getByTestId("created-invite"))
    .toMatchTextContent("tailscale up --login-server https://hs.example.com --authkey created-key");
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await page.getByTestId("copy-setup-install-command").click();
  expect(write).toHaveBeenCalledWith(
    "tailscale up --login-server https://hs.example.com --authkey created-key",
  );
  await field.fill("ftp://hs.example.com");
  await expect
    .element(page.getByTestId("setup-login-server-error"))
    .toHaveTextContent(t("connectionInvalidUrl"));
  await expect.element(field).toHaveAttribute("aria-invalid", "true");
  await expect.element(page.getByTestId("copy-setup-install-command")).not.toBeInTheDocument();
  await field.fill("not a url");
  await expect.element(page.getByTestId("setup-login-server-error")).toBeVisible();
  await field.fill("http://10.0.0.1:8080");
  await page.getByTestId("add-device-finish").click();
  await generateKey("server");
  await expect.element(page.getByTestId("setup-login-server")).toHaveValue("http://10.0.0.1:8080");
});

// Fix 8: the created key is shown once; dismissing the wizard by accident must not lose it silently.
test("dismissing the wizard with a created key asks first and Done does not", async () => {
  const ctx = await setup();
  await generateKey();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("discard-key-dialog")).toBeVisible();
  await expect
    .element(page.getByTestId("discard-key-dialog"))
    .toMatchTextContent(copy.discardKeyDescription);
  await page.getByTestId("discard-key-cancel").click();
  await expect.element(page.getByTestId("discard-key-dialog")).not.toBeInTheDocument();
  expect(isOpen("add-device-dialog")).toBe(true);
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("discard-key-confirm").click();
  await expect.element(page.getByTestId("add-device-dialog")).not.toBeInTheDocument();
  expect(ctx.session.deviceSetup.getSnapshot().lastCreatedInvite).toBe("");
  await generateKey();
  await page.getByTestId("add-device-finish").click();
  await expect.element(page.getByTestId("add-device-dialog")).not.toBeInTheDocument();
  expect(document.querySelector('[data-testid="discard-key-dialog"]')).toBeNull();
  await openWizard("client");
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("add-device-dialog")).not.toBeInTheDocument();
  expect(document.querySelector('[data-testid="discard-key-dialog"]')).toBeNull();
});

// Fix 9: the device joins after the key is used, so Done reloads the machines.
test("Done reloads the machine list and a registration refreshes it", async () => {
  const ctx = await setup();
  await generateKey();
  const before = ctx.nodeReads().length;
  await page.getByTestId("add-device-finish").click();
  await expect.poll(() => ctx.nodeReads().length).toBeGreaterThan(before);
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("add-pending-node").click();
  await page.getByTestId("pending-node-key").fill(AUTH_ID);
  await page.getByTestId("register-pending-node").click();
  await expect.element(page.getByTestId("registration-result")).toBeVisible();
  await expect.element(page.getByTestId("device-3")).toBeVisible();
});

// Fix 10: an SSH check has no result step; its validation hint is an announced error.
test("the SSH check flow has a single step with Done and an announced validation hint", async () => {
  await setup();
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("add-pending-node").click();
  await expect
    .element(page.getByTestId("add-device-dialog"))
    .toMatchTextContent(copy.pendingRegistrationLead);
  await expect
    .element(page.getByTestId("add-device-dialog"))
    .not.toHaveTextContent(copy.deviceSetupLead);
  await expect.element(page.getByTestId("add-device-next")).toBeVisible();
  await page.getByTestId("pending-registration-kind").selectOptions("ssh");
  await expect.element(page.getByTestId("add-device-next")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("add-device-step-result")).not.toBeInTheDocument();
  await page.getByTestId("pending-node-key").fill("bogus");
  const hint = page.getByTestId("pending-node-key-hint");
  await expect.element(hint).toHaveAttribute("role", "alert");
  await expect.element(hint).toHaveClass(/text-destructive/);
  await page.getByTestId("add-device-finish").click();
  await expect.element(page.getByTestId("add-device-dialog")).not.toBeInTheDocument();
});

test("the client wizard header has one description line", async () => {
  await setup();
  await openWizard("client");
  const description = document.querySelector('[data-testid="add-device-dialog"] p');
  expect(description?.textContent).toBe(copy.deviceSetupLead);
});

// Fix 2: tagging a user-owned machine is one-way and removes its owner.
test("tagging a user-owned machine needs an acknowledgement and Enter submits", async () => {
  const ctx = await setup();
  await openMenu("2", "edit-node-tags");
  const input = page.getByTestId("node-tags-input");
  await expect.element(page.getByTestId("node-tags-confirm")).toBeEnabled();
  await input.fill("tag:web");
  await expect.element(page.getByTestId("node-tags-owner-warning")).toMatchTextContent("Bob");
  await expect.element(page.getByTestId("node-tags-confirm")).toBeDisabled();
  await input.click();
  await userEvent.keyboard("{Enter}");
  expect(ctx.writes()).toEqual([]);
  await page.getByTestId("node-tags-acknowledge").click();
  await expect.element(page.getByTestId("node-tags-confirm")).toBeEnabled();
  await input.click();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("node-tags-dialog")).not.toBeInTheDocument();
  expect(ctx.writes()).toEqual([
    { method: "POST", path: "/api/v1/node/2/tags", body: { tags: ["tag:web"] } },
  ]);
});

test("a tagged machine cannot be saved without tags", async () => {
  const ctx = await setup();
  await openMenu("1", "edit-node-tags");
  await expect.element(page.getByTestId("node-tags-input")).toHaveValue("tag:server");
  await page.getByTestId("node-tags-input").fill("  ");
  await expect
    .element(page.getByTestId("node-tags-required"))
    .toHaveTextContent(copy.tagsRequiredForTaggedNode);
  await expect.element(page.getByTestId("node-tags-confirm")).toBeDisabled();
  expect(document.querySelector('[data-testid="node-tags-owner-warning"]')).toBeNull();
  expect(ctx.writes()).toEqual([]);
});

test("the tagging warning names an unknown owner when the machine has no visible user", async () => {
  await setup("", (backend) => {
    const laptop = backend.nodes[1];
    if (laptop) laptop.user = { id: "0", name: "tagged-devices" };
  });
  await openMenu("2", "edit-node-tags");
  await expect.element(page.getByTestId("node-tags-confirm")).toBeEnabled();
  await page.getByTestId("node-tags-input").fill("tag:web");
  await expect
    .element(page.getByTestId("node-tags-owner-warning"))
    .toMatchTextContent(copy.unknown);
});

test("tags split on commas and spaces and malformed tags are reported without a write", async () => {
  const ctx = await setup();
  await openMenu("1", "edit-node-tags");
  await expect.element(page.getByTestId("node-tags-input")).toHaveValue("tag:server");
  await page.getByTestId("node-tags-input").fill("tag:web db, tag:");
  await page.getByTestId("node-tags-confirm").click();
  await expect.element(page.getByTestId("node-tags-invalid")).toHaveTextContent(copy.invalidTags);
  await expect.element(page.getByTestId("node-tags-input")).toHaveAttribute("aria-invalid", "true");
  expect(ctx.writes()).toEqual([]);
  await page.getByTestId("node-tags-input").fill("tag:web  tag:db,tag:x");
  await expect.element(page.getByTestId("node-tags-invalid")).not.toBeInTheDocument();
  await page.getByTestId("node-tags-confirm").click();
  await expect.element(page.getByTestId("node-tags-dialog")).not.toBeInTheDocument();
  expect(ctx.writes()).toEqual([
    { method: "POST", path: "/api/v1/node/1/tags", body: { tags: ["tag:web", "tag:db", "tag:x"] } },
  ]);
});

// Fix 3: a rename sends a trimmed, valid DNS label and never the old name.
test("rename trims, refuses blank or unchanged names and validates the DNS label", async () => {
  const ctx = await setup();
  await openMenu("2", "rename-node");
  const input = page.getByTestId("rename-node-dialog-input");
  await expect.element(page.getByTestId("rename-node-confirm")).toBeDisabled();
  await input.fill("   ");
  await expect.element(page.getByTestId("rename-node-confirm")).toBeDisabled();
  await input.click();
  await userEvent.keyboard("{Enter}");
  for (const bad of ["Bad Name!", "-edge", "edge-", "a".repeat(64)]) {
    await input.fill(bad);
    await page.getByTestId("rename-node-confirm").click();
    await expect
      .element(page.getByTestId("rename-node-invalid"))
      .toHaveTextContent(copy.invalidMachineName);
    await expect.element(input).toHaveAttribute("aria-invalid", "true");
  }
  await input.fill("x");
  await expect.element(page.getByTestId("rename-node-invalid")).not.toBeInTheDocument();
  expect(ctx.writes()).toEqual([]);
  await input.fill("  New-Host-1  ");
  await page.getByTestId("rename-node-confirm").click();
  await expect.element(page.getByTestId("rename-node-dialog")).not.toBeInTheDocument();
  expect(ctx.writes()).toEqual([
    { method: "POST", path: "/api/v1/node/2/rename/New-Host-1", body: {} },
  ]);
});

test("Enter that confirms an IME composition does not rename", async () => {
  const ctx = await setup();
  await openMenu("2", "rename-node");
  const input = page.getByTestId("rename-node-dialog-input");
  await input.fill("office");
  input
    .element()
    .dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }),
    );
  await expect.element(page.getByTestId("rename-node-dialog")).toBeVisible();
  expect(ctx.writes()).toEqual([]);
  await input.click();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("rename-node-dialog")).not.toBeInTheDocument();
  expect(ctx.writes()).toEqual([
    { method: "POST", path: "/api/v1/node/2/rename/office", body: {} },
  ]);
});

// Fix 11: details speak the user's language and do not rely on colour alone.
test("details localize the register method and group routes by status", async () => {
  const ctx = await setup();
  await page.getByTestId("device-detail-link-1").click();
  const dialog = page.getByTestId("device-detail-dialog");
  await expect
    .element(page.getByTestId("device-detail-register-method-1"))
    .toHaveTextContent(`${copy.registerMethod}: ${copy.registerMethodAuthKey}`);
  await expect.element(dialog).not.toHaveTextContent("REGISTER_METHOD");
  await expect
    .element(page.getByTestId("device-detail-pending-routes-1"))
    .toMatchTextContent(new RegExp(`${copy.pendingRoutes}.*0\\.0\\.0\\.0/0`));
  await expect
    .element(page.getByTestId("device-detail-approved-routes-1"))
    .toMatchTextContent(new RegExp(`${copy.approvedRoutes}.*10\\.42\\.0\\.0/16`));
  await expect.element(dialog).not.toHaveTextContent(copy.lastSeen);
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("device-detail-link-2").click();
  await expect
    .element(page.getByTestId("device-detail-register-method-2"))
    .toHaveTextContent(`${copy.registerMethod}: ${copy.registerMethodCli}`);
  await expect.element(dialog).toMatchTextContent(copy.lastSeen);
  await expect.element(dialog).toMatchTextContent(copy.noRouteValues);
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  for (const [method, label] of [
    ["REGISTER_METHOD_OIDC", copy.registerMethodOidc],
    ["REGISTER_METHOD_UNSPECIFIED", copy.unknown],
  ] as const) {
    // Opening details re-reads the server, so the server copy carries the method.
    ctx.backend.nodes = ctx.backend.nodes.map((node) =>
      node.id === "2" ? { ...node, registerMethod: method } : node,
    );
    await page.getByTestId("device-detail-link-2").click();
    await expect
      .element(page.getByTestId("device-detail-register-method-2"))
      .toHaveTextContent(`${copy.registerMethod}: ${label}`);
    await userEvent.keyboard("{Escape}");
    await expect.element(dialog).not.toBeInTheDocument();
  }
});

test("route chips carry a text status and online machines hide last seen", async () => {
  await setup();
  await expect
    .element(page.getByTestId("device-pending-route-1-0"))
    .toMatchTextContent(
      new RegExp(`0\\.0\\.0\\.0/0.*${copy.routeStatusExit}.*${copy.routeStatusPending}`),
    );
  await expect
    .element(page.getByTestId("device-approved-route-1-0"))
    .toMatchTextContent(new RegExp(`10\\.42\\.0\\.0/16.*${copy.routeStatusApproved}`));
  await expect
    .element(page.getByTestId("device-pending-routes-1"))
    .toHaveAttribute("title", copy.viewRoutes);
  await expect.element(page.getByTestId("device-1")).not.toHaveTextContent(copy.lastSeen);
  await expect.element(page.getByTestId("device-2")).toMatchTextContent(copy.lastSeen);
});

// Fix 12: expiring an expired machine is meaningless, and the menu must fit a short window.
test("an expired machine's menu offers Disable expiry but not Expire", async () => {
  await setup();
  await page.getByTestId("machine-actions-trigger-2").click();
  await expect.element(page.getByTestId("disable-expiry-node-action-2")).toBeVisible();
  expect(document.querySelector('[data-testid="expire-node-action-2"]')).toBeNull();
});

test("a seven-item machine menu fits a 510 px high window without scrolling", async () => {
  await setup("", (backend) => {
    const laptop = backend.nodes[1];
    if (laptop) laptop.expiry = "2099-01-01T00:00:00Z";
  });
  for (const [width, trigger, menuId] of [
    [1366, "machine-actions-trigger-2", "machine-actions-menu-2"],
    [600, "machine-actions-trigger-mobile-2", "machine-actions-menu-mobile-2"],
  ] as const) {
    await page.viewport(width, 510);
    await page.getByTestId(trigger).click();
    const menu = page.getByTestId(menuId);
    await expect.element(menu).toBeVisible();
    expect(menu.element().querySelectorAll('[role="menuitem"]')).toHaveLength(7);
    await expect.poll(() => menu.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(510);
    expect(menu.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    expect(menu.element().scrollHeight).toBeLessThanOrEqual(menu.element().clientHeight + 1);
    await userEvent.keyboard("{Escape}");
    await expect.element(menu).not.toBeInTheDocument();
  }
});

// Fix 13: links carry the machine, filters live in the URL, and an owner link filters exactly.
test("View routes and the pending routes link open the routes page for the machine", async () => {
  const ctx = await setup();
  await openMenu("1", "view-node-routes");
  await expect.poll(() => ctx.router.state.location.pathname).toBe("/routes");
  expect(ctx.router.state.location.search).toEqual({ node: "1" });
  await ctx.unmount();
  const next = await setup();
  await page.getByTestId("device-pending-routes-1").click();
  await expect.poll(() => next.router.state.location.pathname).toBe("/routes");
  expect(next.router.state.location.search).toEqual({ node: "1" });
});

test("search and status filter are written to the URL and restored from it", async () => {
  const ctx = await setup();
  await page.getByTestId("device-search").click();
  await userEvent.keyboard("lap");
  await expect.poll(() => ctx.router.state.location.search).toEqual({ search: "lap" });
  await expect.element(page.getByTestId("device-search")).toHaveValue("lap");
  await page.getByTestId("machine-filter").selectOptions("expired");
  await expect
    .poll(() => ctx.router.state.location.search)
    .toEqual({ search: "lap", filter: "expired" });
  await expect.element(page.getByTestId("device-2")).toBeVisible();
  await page.getByTestId("clear-machine-filters").click();
  await expect.poll(() => ctx.router.state.location.search).toEqual({});
  await ctx.unmount();
  await setup("?filter=expired&search=lap");
  await expect.element(page.getByTestId("machine-filter")).toHaveValue("expired");
  await expect.element(page.getByTestId("device-search")).toHaveValue("lap");
  await expect.element(page.getByTestId("device-1")).not.toBeInTheDocument();
});

test("an unknown filter in the URL lists all machines", async () => {
  await setup("?filter=bogus");
  await expect.element(page.getByTestId("machine-filter")).toHaveValue("all");
  await expect.element(page.getByTestId("device-2")).toBeVisible();
});

test("a ?user= link filters to that owner until its chip or Clear filters removes it", async () => {
  const ctx = await setup("?user=2");
  await expect.element(page.getByTestId("device-2")).toBeVisible();
  await expect.element(page.getByTestId("device-1")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("owner-filter-chip")).toMatchTextContent("Bob");
  await page.getByRole("button", { name: copy.removeOwnerFilter }).click();
  await expect.element(page.getByTestId("device-1")).toBeVisible();
  expect(ctx.router.state.location.search).toEqual({});
  await ctx.unmount();
  const next = await setup("?user=1&search=edge");
  await expect.element(page.getByTestId("device-1")).toBeVisible();
  await page.getByTestId("clear-machine-filters").click();
  await expect.element(page.getByTestId("device-2")).toBeVisible();
  expect(next.router.state.location.search).toEqual({});
  await expect.element(page.getByTestId("owner-filter-chip")).not.toBeInTheDocument();
});

test("a ?user= link for an unknown user shows its id and matches no machine", async () => {
  await setup("?user=77");
  await expect.element(page.getByTestId("owner-filter-chip")).toMatchTextContent("77");
  await expect.element(page.getByTestId("machine-list")).toMatchTextContent(copy.noDevices);
});

// Fix 14: the docs link keeps the console open and the result count is announced.
test("Learn more opens a new tab and the result count is a labelled status", async () => {
  await setup();
  const link = page.getByTestId("install-docs-link");
  await expect.element(link).toHaveAttribute("target", "_blank");
  await expect.element(link).toHaveAttribute("rel", "noreferrer");
  const count = page.getByTestId("machine-count");
  await expect.element(count).toHaveAttribute("role", "status");
  await expect.element(count).toMatchTextContent("Machines shown: 2 of 2");
  await page.getByTestId("device-search").fill("edge");
  await expect.element(count).toMatchTextContent("Machines shown: 1 of 2");
});

// Fix 15: at about 790 px the actions stay reachable without horizontal scrolling.
test("the machine table fits a 790 px wide window with reachable actions", async () => {
  await setup();
  await page.viewport(790, 700);
  await expect.element(page.getByTestId("machine-actions-trigger-mobile-1")).toBeVisible();
  const list = page.getByTestId("machine-list").element();
  const table = list.querySelector("table");
  expect(table?.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
});

// Fix 16: the wizard footer stays reachable in a short window and the stepper keeps one row.
test("the wizard keeps its footer in view and its stepper on one row at 800x510", async () => {
  await setup();
  await page.viewport(800, 510);
  await openWizard("server");
  await expect.element(page.getByTestId("add-device-next")).toBeVisible();
  const next = page.getByTestId("add-device-next").element().getBoundingClientRect();
  expect(next.bottom).toBeLessThanOrEqual(510);
  const tops = Array.from(
    document.querySelectorAll('[data-testid^="add-device-step-"]'),
    (step) => step.getBoundingClientRect().top,
  );
  expect(tops).toHaveLength(3);
  expect(new Set(tops).size).toBe(1);
  const dialog = page.getByTestId("add-device-dialog").element().getBoundingClientRect();
  expect(dialog.left).toBeGreaterThan(0);
  expect(dialog.right).toBeLessThan(800);
});

// Fix 17: the export distinguishes advertised from approved routes.
test("the machine export lists advertised and approved routes separately", async () => {
  let text = async (): Promise<string | undefined> => undefined;
  vi.spyOn(URL, "createObjectURL").mockImplementation((value) => {
    text = () => (value as Blob).text();
    return "blob:fixture";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  await setup();
  await page.getByTestId("device-search").fill("edge");
  await page.getByTestId("export-machines").click();
  // The shell may prefix a byte order mark; only the columns matter here.
  const [header, row] = String(await text())
    .replace(/^﻿/, "")
    .split(/\r?\n/);
  expect(header).toBe(
    '"name","owner","status","addresses","tags","advertisedRoutes","approvedRoutes","lastSeen","expires"',
  );
  expect(row).toContain('"10.42.0.0/16 0.0.0.0/0","10.42.0.0/16"');
});
