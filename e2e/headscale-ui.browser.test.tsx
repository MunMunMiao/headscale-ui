import type { Infer } from "@defjs/core";
import { createBrowserHistory, RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { SessionProviders } from "@/AppProviders";
import { type apiKey, normalizeHeadscaleNode } from "@/api/contracts";
import * as endpoints from "@/api/requests";
import { type Execute, readHealth, readPolicy } from "@/api/snapshot";
import { prepareApplication, resetUnreadableVault } from "@/bootstrap";
import ErrorScreen from "@/components/ErrorScreen";
import { createSession, type Session } from "@/composables/session-context";
import type { ActionFeedbackKey } from "@/composables/useActionFeedback";
import { listedApiKeyPrefix } from "@/domain/api-key";
import { policyPrincipalForUser } from "@/domain/principal";
import { i18n, LOCALE_META, SUPPORTED_LOCALES, t } from "@/i18n";
import { getProductCopy } from "@/i18n/product-copy";
import {
  CANARY_KEY_ID,
  deriveKeyFromPassword,
  encryptProfileKey,
} from "@/lib/api-key-crypto";
import {
  __resetForTest as resetIdbCache,
  STORE_KEYS,
  STORE_META,
  STORE_PROFILES,
} from "@/lib/idb";
import type { ProfileSummary, VaultVersion } from "@/lib/profile-storage";
import { settingsStorageTestingHandle } from "@/lib/settings-storage";
import { VAULT_STATE_KEY, VaultDataError } from "@/lib/vault-state";
import { createApplicationRouter } from "@/router";
import type { ApiCommand, ApiOutput, EndpointName } from "@/session/protocol";
import { ApiError } from "@/session/types";
import { expectNetworkTokensLtr } from "@/test/bidi";
import {
  encryptLegacyKey,
  legacySalt,
  makeLegacyCanary,
} from "@/test-utils/legacy-vault";
import { idbDelete, idbGet, idbGetAll, idbPut } from "@/test-utils/storage";
import type { NetworkGateState } from "../scripts/harness/session-network";
import type { NetworkOperationCall, OperationId } from "./network-observations";
import { E2E_REQUIREMENTS } from "./requirements";
import "@/styles/globals.css";
import policyFixture from "./headscale-policy.hujson?raw";

declare module "vitest/browser" {
  interface BrowserCommands {
    headscaleOperationCalls(): Promise<NetworkOperationCall[]>;
    clearHeadscaleOperationCalls(): Promise<void>;
    interceptHeadscaleRequest(
      method: string,
      pathPattern: string,
      failure?: string | { responseBody: unknown } | { rawBody: string },
    ): Promise<void>;
    headscaleRequestCaptured(): Promise<boolean>;
    headscaleGateState(): Promise<NetworkGateState | null>;
    releaseHeadscaleRequest(): Promise<void>;
    startNetworkDiagnostics(): Promise<void>;
    reportNetworkFailures(failedTest?: string): Promise<void>;
    resetHeadscaleFixture(blankPolicy?: boolean): Promise<void>;
    seedHeadscalePolicyFixture(policy: string): Promise<void>;
    readHeadscaleFixturePolicy(): Promise<string>;
    writeHeadscaleFixturePolicy(policy: string): Promise<void>;
    emulateColorScheme(scheme: "light" | "dark" | "reset"): Promise<void>;
  }
}

let activeSession: Session;
const caseSessions = new Set<Session>();

/** Publishes reads and writes through the page bridge under the session the page has adopted now. */
function adopted(): { read: Execute; write: Execute } {
  const identity = session().client.getSnapshot().identity;
  if (!identity) throw new ApiError({ kind: "locked" });
  const bridge = session().auth;
  return {
    read: (command, options) => bridge.read(identity, command, options),
    write: (command, options) => bridge.write(identity, command, options),
  };
}

async function request<K extends EndpointName>(
  execute: Execute,
  command: ApiCommand<K>,
): Promise<ApiOutput<K>> {
  const result = await execute(command);
  if (!result.ok) throw new ApiError(result.error);
  return result.value;
}

async function expectHeadscaleGate(upstreamRequests = 1) {
  // The gate captures only after the Headscale response arrives; policy writes can exceed the 1 s poll default.
  await expect
    .poll(() => commands.headscaleGateState(), { timeout: 10_000 })
    .toMatchObject({
      hits: 1,
      upstreamRequests,
      captured: true,
    });
}

/** Key-mode TagField: type a legal tag and add it. The selected set is the value, not the search box. */
async function addKeyTag(fieldId: string, tag: string) {
  await page.getByTestId(`${fieldId}-search`).fill(tag);
  await expect.element(page.getByTestId(`${fieldId}-add`)).toBeEnabled();
  await page.getByTestId(`${fieldId}-add`).click();
  await expect
    .element(page.getByTestId(`${fieldId}-remove-${tag}`))
    .toBeVisible();
}

/** The selected fieldset owns the tag set. Count and remove buttons must match exactly. */
async function expectTagSelection(fieldId: string, tags: readonly string[]) {
  const selected = page.getByTestId(`${fieldId}-selected`);
  await expect
    .element(selected)
    .toMatchTextContent(
      `${getProductCopy("en-US").tagSelection} (${tags.length})`,
    );
  for (const tag of tags)
    await expect
      .element(page.getByTestId(`${fieldId}-remove-${tag}`))
      .toBeVisible();
  expect(
    document.querySelectorAll(`[data-testid^="${fieldId}-remove-"]`),
  ).toHaveLength(tags.length);
}

async function selectDeclaredDeviceTag(tag: string) {
  const option = page.getByTestId(`node-tags-option-${tag}`);
  await expect.element(option).toBeVisible();
  await expect.element(option).toBeEnabled();
  await option.click();
  await expect
    .element(page.getByTestId(`node-tags-remove-${tag}`))
    .toBeVisible();
}

/**
 * Whole-document publication is a separate confirmation from the edit that opened it.
 * The review must show both texts before the write, and it closes before the response returns.
 */
async function confirmPolicyPublication() {
  await expect
    .element(page.getByTestId("policy-publication-review"), { timeout: 30_000 })
    .toBeVisible();
  const original =
    document.querySelector('[data-testid="policy-publication-original"]')
      ?.textContent ?? "";
  const submitted =
    document.querySelector('[data-testid="policy-publication-submitted"]')
      ?.textContent ?? "";
  expect(submitted.trim().length).toBeGreaterThan(0);
  expect(submitted).not.toBe(original);
  const setsBefore = await operationCount("policy.set");
  await expect
    .element(page.getByTestId("policy-publication-confirm"))
    .toBeEnabled();
  await page.getByTestId("policy-publication-confirm").click();
  await expect
    .poll(
      () => document.querySelector('[data-testid="policy-publication-review"]'),
      {
        timeout: 30_000,
      },
    )
    .toBeNull();
  // The review closes before the pre-read returns. The write itself is the completion signal.
  await expect
    .poll(async () => await operationCount("policy.set"), { timeout: 30_000 })
    .toBeGreaterThan(setsBefore);
}

/** Registration options use the user id. The label still names the account. */
async function selectNamedRegistrationUser(name: string) {
  await expect
    .poll(() =>
      [
        ...document.querySelectorAll<HTMLOptionElement>(
          '[data-testid="pending-registration-user"] option',
        ),
      ].some(
        (option) =>
          option.value !== "" && option.textContent?.includes(`(${name} ·`),
      ),
    )
    .toBe(true);
  const option = [
    ...document.querySelectorAll<HTMLOptionElement>(
      '[data-testid="pending-registration-user"] option',
    ),
  ].find(
    (item) => item.value !== "" && item.textContent?.includes(`(${name} ·`),
  );
  const value = option?.value ?? "";
  expect(value).not.toBe("");
  await page.getByTestId("pending-registration-user").selectOptions(value);
  await expect
    .element(page.getByTestId("pending-registration-user"))
    .toHaveValue(value);
  return value;
}

/** Registration stays disabled until the public server and the request source are both confirmed. */
async function confirmDeviceRegistration(server: string) {
  await page.getByTestId("restore-login-server").fill(server);
  await page.getByTestId("restore-server-confirm").click();
  await expect
    .element(page.getByTestId("restore-source-confirm"))
    .toBeEnabled();
  await page.getByTestId("restore-source-confirm").click();
  await expect.element(page.getByTestId("register-pending-node")).toBeEnabled();
}

function session(): Session {
  if (!activeSession)
    throw new Error("E2E application session has not been prepared");
  return activeSession;
}

const headscaleApiKey = import.meta.env.VITE_HEADSCALE_E2E_API_KEY;
const headscaleFileModeApiKey = import.meta.env
  .VITE_HEADSCALE_E2E_FILE_MODE_API_KEY;

function storedProfiles(): ProfileSummary[] {
  return session().profiles.getSnapshot().profiles;
}

/**
 * Mirrors the legacy `storedProfilesString()` assertion shape so existing
 * `.toContain("Office")` checks keep working after the IDB migration. Returns a JSON-serialised
 * blob of profile names + baseUrls drawn from the Worker profile projection, plus a sentinel
 * for the "no profiles saved" case.
 */
function storedProfilesString(): string | null {
  const profiles = storedProfiles();
  if (profiles.length === 0) return null;
  return JSON.stringify(
    profiles.map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      scope: p.scope,
    })),
  );
}

function currentProfileId(): string | null {
  return session().auth.getSessionSnapshot()?.profile?.id ?? null;
}

function visibleText(testId: string): string | null {
  return (
    document
      .querySelector<HTMLElement>(`[data-testid="${testId}"]`)
      ?.textContent?.trim() ?? null
  );
}

async function readIdbSetting(key: string): Promise<string | null> {
  const raw = await idbGet<Record<string, string>>(STORE_META, "ui-settings");
  return raw && typeof raw === "object" && typeof raw[key] === "string"
    ? raw[key]
    : null;
}

async function prepareCaseSession() {
  const prepared = createSession(await prepareApplication());
  caseSessions.add(prepared);
  expect(prepared.auth.getSnapshot().status).toMatch(/^ready-/);
  return prepared;
}

async function resetCaseStorage() {
  const auth = session().auth;
  const locked = await auth.lock(auth.getSessionSnapshot()?.identity ?? null);
  expect(locked.ok).toBe(true);
  const listing = await auth.listProfiles();
  if (!listing.ok)
    throw new Error(`Fixture profile listing failed: ${listing.error.kind}`);
  const reset = await auth.resetStorage(listing.value.version);
  expect(reset.ok).toBe(true);
  expect(auth.getSessionSnapshot()?.status).toBe("locked");
  const empty = await auth.listProfiles();
  expect(empty.ok && empty.value.profiles).toEqual([]);
  expect(await idbGetAll(STORE_PROFILES)).toEqual([]);
}

afterEach(async ({ task }) => {
  await commands.releaseHeadscaleRequest();
  await cleanup();
  try {
    await resetCaseStorage();
  } finally {
    for (const prepared of caseSessions) prepared.auth.dispose();
    caseSessions.clear();
    resetIdbCache();
    try {
      await commands.reportNetworkFailures(
        task.result?.state === "fail" ? task.name : undefined,
      );
    } catch {
      console.error("E2E network diagnostics unavailable");
    }
  }
});

beforeEach(async () => {
  await page.viewport(1366, 768);
  await cleanup();
  document.body.replaceChildren();
  await commands.startNetworkDiagnostics();
  localStorage.clear();
  sessionStorage.clear();
  resetIdbCache();
  settingsStorageTestingHandle.reset();
  activeSession = await prepareCaseSession();
  await resetCaseStorage();
  i18n.activate("en-US");
  document.documentElement.lang = "en-US";
  document.documentElement.dir = "ltr";
  await commands.clearHeadscaleOperationCalls();
  if (headscaleApiKey) await commands.resetHeadscaleFixture();
}, 60_000);

/**
 * Historical/invalid records are test fixtures. Writing a record never grants a session;
 * all valid connections use the save/unlock UI and production Worker protocol.
 */
async function seedProfileInIdb(
  plain: {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    updatedAt: string;
  },
  opts: {
    legacyDevice?: boolean;
    legacyPassword?: string;
    active?: boolean;
  } = {},
): Promise<void> {
  const version = await idbGet<VaultVersion>(STORE_META, VAULT_STATE_KEY);
  if (!version)
    throw new Error("Profile fixture requires initialized vault metadata");
  const credentialVersion = crypto.randomUUID();
  let apiKey: unknown;
  if (opts.legacyDevice) {
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plain.apiKey),
    );
    const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
    apiKey = {
      v: 1,
      scheme: "device",
      iv: base64(iv),
      ct: base64(new Uint8Array(ciphertext)),
    };
    await idbPut(STORE_KEYS, key, "device-key");
  } else if (opts.legacyPassword) {
    const salt = legacySalt();
    const key = await deriveKeyFromPassword(opts.legacyPassword, salt);
    apiKey = await encryptLegacyKey(plain.apiKey, key, "password");
    await idbPut(
      STORE_META,
      await makeLegacyCanary(key, salt, 310_000),
      CANARY_KEY_ID,
    );
  } else {
    apiKey = await encryptProfileKey({
      apiKey: plain.apiKey,
      password: profilePassword(plain.name),
      profileId: plain.id,
      canonicalBaseUrl: plain.baseUrl,
      credentialVersion,
    });
  }
  await idbPut(STORE_PROFILES, {
    id: plain.id,
    name: plain.name,
    baseUrl: plain.baseUrl,
    apiKey,
    keyEpoch: version.keyEpoch,
    ...(!opts.legacyDevice && !opts.legacyPassword
      ? { credentialVersion }
      : {}),
    updatedAt: plain.updatedAt,
    scope: "persistent",
  });
  if (opts.active) {
    await idbPut(
      STORE_META,
      { profileId: plain.id, operationId: crypto.randomUUID() },
      "active-profile-id",
    );
  }
  // Bootstrap reads fresh metadata through Worker. Close only the page-side fixture connection.
  resetIdbCache();
}

async function renderLogin(path = "/") {
  activeSession = await prepareCaseSession();
  window.history.pushState({}, "", path);
  const testRouter = createApplicationRouter(session(), createBrowserHistory());
  const rendered = await render(
    <SessionProviders session={session()}>
      <RouterProvider router={testRouter} />
    </SessionProviders>,
  );
  await testRouter.load();
  return rendered;
}

type HeadscaleTarget = "main" | "file-mode";

function dockerSettings(target: HeadscaleTarget = "main") {
  if (target === "file-mode") {
    if (!headscaleFileModeApiKey)
      throw new Error("VITE_HEADSCALE_E2E_FILE_MODE_API_KEY is required");
    return {
      apiKey: headscaleFileModeApiKey,
      baseUrl: `${window.location.origin}/__headscale-e2e-file-mode`,
    };
  }
  if (!headscaleApiKey)
    throw new Error("VITE_HEADSCALE_E2E_API_KEY is required");
  return {
    apiKey: headscaleApiKey,
    baseUrl: `${window.location.origin}/__headscale-e2e`,
  };
}

async function fillConnection(target: HeadscaleTarget = "main") {
  const settings = dockerSettings(target);
  await page.getByTestId("connect-server-url").fill(settings.baseUrl);
  await page.getByTestId("connect-api-key").fill(settings.apiKey);
  const name =
    document.querySelector<HTMLInputElement>(
      '[data-testid="connect-profile-name"]',
    )?.value ?? "Docker Headscale";
  await page.getByTestId("connect-password").fill(profilePassword(name));
  await page
    .getByTestId("connect-password-confirm")
    .fill(profilePassword(name));
}

function profilePassword(name: string) {
  return `headscale-fixture:${name}:independent-password`;
}

async function unlockProfile(name: string, password = profilePassword(name)) {
  await page.getByTestId(`profile-option-${name}`).click();
  await expect.element(page.getByTestId("unlock-dialog")).toBeVisible();
  await page.getByTestId("unlock-passphrase").fill(password);
  await page.getByTestId("unlock-submit").click();
  await expect
    .poll(() => session().auth.getSessionSnapshot()?.status)
    .toBe("unlocked");
}

async function connectWithDefaults() {
  const dialog = document.querySelector(
    '[data-testid="connection-dialog"][data-open]',
  );
  if (!dialog) await page.getByTestId("profile-option-new").click();
  await expect
    .element(page.getByTestId("connect-password-confirm"))
    .toBeVisible();
  await page.getByTestId("connect-profile-name").fill("Docker Headscale");
  await fillConnection();
  await page.getByTestId("connect-save-unlock").click();
  await expect.element(page.getByTestId("profile-menu-trigger")).toBeVisible();
}

async function connectToDockerHeadscale(profileName: string) {
  await commands.seedHeadscalePolicyFixture(policyFixture);
  await page.getByTestId("profile-option-new").click();
  await page.getByTestId("connect-profile-name").fill(profileName);
  await fillConnection();
  await page.getByTestId("connect-submit").click();
  await expect
    .element(page.getByTestId(`profile-option-${profileName}`))
    .toBeVisible();
  await unlockProfile(profileName);
  await expect.element(page.getByTestId("section-home")).toBeVisible();
}

async function openCreateMemberDialog() {
  await page.getByTestId("open-create-member").click();
  await expect.element(page.getByTestId("member-create-dialog")).toBeVisible();
}

function expectNoHorizontalOverflow() {
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
    window.innerWidth,
  );
}

function expectDialogFitsViewport(testId: string) {
  const dialog = document.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  expect(dialog).toBeTruthy();
  const rect = (dialog as HTMLElement).getBoundingClientRect();
  expect(rect.top).toBeGreaterThanOrEqual(0);
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.height).toBeLessThanOrEqual(window.innerHeight);
  expect(rect.width).toBeLessThanOrEqual(window.innerWidth);
}

function expectDialogUsableInViewport(testId: string) {
  const dialog = document.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  expect(dialog).toBeTruthy();
  expectDialogFitsViewport(testId);
  const overflowX = getComputedStyle(dialog as HTMLElement).overflowX;
  if (
    (dialog as HTMLElement).scrollWidth >
    (dialog as HTMLElement).clientWidth + 1
  ) {
    expect(overflowX).toMatch(/^(clip|hidden)$/);
  }

  const overflowY = getComputedStyle(dialog as HTMLElement).overflowY;
  if (
    (dialog as HTMLElement).scrollHeight >
    (dialog as HTMLElement).clientHeight + 1
  ) {
    expect(overflowY).toMatch(/^(auto|scroll)$/);
  }

  const close = (dialog as HTMLElement).querySelector<HTMLElement>(
    '[data-slot="dialog-close"]',
  );
  if (close) {
    const closeRect = close.getBoundingClientRect();
    expect(closeRect.top).toBeGreaterThanOrEqual(0);
    expect(closeRect.right).toBeLessThanOrEqual(window.innerWidth);
  }
}

function expectLayerFitsViewport(selector: string) {
  const layer = document.querySelector<HTMLElement>(selector);
  expect(layer).toBeTruthy();
  const rect = (layer as HTMLElement).getBoundingClientRect();
  expect(rect.top).toBeGreaterThanOrEqual(0);
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.height).toBeLessThanOrEqual(window.innerHeight);
  expect(rect.width).toBeLessThanOrEqual(window.innerWidth);
}

function expectTestIdFitsViewport(testId: string) {
  const element = document.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  expect(element).toBeTruthy();
  const rect = (element as HTMLElement).getBoundingClientRect();
  expect(rect.top).toBeGreaterThanOrEqual(0);
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
  expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
}

function expectTestIdAboveTestId(testId: string, boundaryTestId: string) {
  const element = document.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  const boundary = document.querySelector<HTMLElement>(
    `[data-testid="${boundaryTestId}"]`,
  );
  expect(element).toBeTruthy();
  expect(boundary).toBeTruthy();
  const rect = (element as HTMLElement).getBoundingClientRect();
  const boundaryRect = (boundary as HTMLElement).getBoundingClientRect();
  expect(rect.bottom).toBeLessThanOrEqual(boundaryRect.top);
}

function expectTestIdNetworkTokensLtr(testId: string, minimum = 1) {
  const root = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  expect(root).toBeTruthy();
  if (root) expectNetworkTokensLtr(root, minimum);
}

function expectOverviewStatsCompactGrid() {
  const stats = document.querySelector<HTMLElement>(
    '[data-testid="overview-stats"]',
  );
  expect(stats).toBeTruthy();
  const cards = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid^="overview-stat-"]'),
  );
  expect(cards).toHaveLength(5);

  const statsRect = (stats as HTMLElement).getBoundingClientRect();
  const firstRect = cards[0]?.getBoundingClientRect();
  const secondRect = cards[1]?.getBoundingClientRect();
  expect(firstRect).toBeTruthy();
  expect(secondRect).toBeTruthy();
  expect(
    Math.abs((firstRect as DOMRect).top - (secondRect as DOMRect).top),
  ).toBeLessThan(2);
  expect((secondRect as DOMRect).left).toBeGreaterThan(
    (firstRect as DOMRect).left,
  );
  expect(statsRect.height).toBeLessThanOrEqual(170);

  const recentHeading = document.querySelector<HTMLElement>(
    '[data-testid="recent-devices-heading"]',
  );
  expect(recentHeading).toBeTruthy();
  expect(
    (recentHeading as HTMLElement).getBoundingClientRect().top,
  ).toBeLessThan(window.innerHeight);
}

async function captureResponsiveScreenshot(name: string) {
  await page.screenshot({
    path: `__screenshots__/responsive-review/${name}.png`,
  });
}

function expectConnectionFormGridLayout() {
  const fields = [
    "connect-profile-name",
    "connect-server-url",
    "connect-api-key",
  ].map((testId) =>
    document.querySelector<HTMLElement>(`[data-testid="${testId}"]`),
  );
  expect(fields.every(Boolean)).toBe(true);
  const [name, url, key] = fields.map((field) =>
    (field as HTMLElement).getBoundingClientRect(),
  );
  expect(Math.abs(name.width - url.width)).toBeLessThan(2);
  expect(Math.abs(key.width - url.width)).toBeLessThan(2);
  expect(Math.abs(name.left - url.left)).toBeLessThan(2);
  expect(Math.abs(key.left - url.left)).toBeLessThan(2);
}

function expectDialogHasNoInternalScrollbar(testId: string) {
  const dialog = document.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  expect(dialog).toBeTruthy();
  expect((dialog as HTMLElement).scrollHeight).toBeLessThanOrEqual(
    (dialog as HTMLElement).clientHeight + 1,
  );
}

function expectTextAlignsToStart(element: HTMLElement) {
  expect(getComputedStyle(element).textAlign).toMatch(
    document.documentElement.dir === "rtl"
      ? /^(right|start)$/
      : /^(left|start)$/,
  );
}

function expectPointerCursor(testId: string) {
  const element = document.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  expect(element).toBeTruthy();
  expect(getComputedStyle(element as HTMLElement).cursor).toBe("pointer");
}

function preventNextClickDefault(testId: string) {
  document
    .querySelector<HTMLElement>(`[data-testid="${testId}"]`)
    ?.addEventListener("click", (event) => event.preventDefault(), {
      once: true,
    });
}

const interactiveCursorSelectors = [
  "a[href]",
  "button:not(:disabled):not([aria-disabled='true'])",
  "select:not(:disabled)",
  "input[type='button']:not(:disabled)",
  "input[type='checkbox']:not(:disabled)",
  "input[type='color']:not(:disabled)",
  "input[type='date']:not(:disabled)",
  "input[type='datetime-local']:not(:disabled)",
  "input[type='file']:not(:disabled)",
  "input[type='month']:not(:disabled)",
  "input[type='radio']:not(:disabled)",
  "input[type='reset']:not(:disabled)",
  "input[type='submit']:not(:disabled)",
  "input[type='time']:not(:disabled)",
  "input[type='week']:not(:disabled)",
  "label[for]",
  "summary",
  "[role='button']:not([aria-disabled='true'])",
  "[role='checkbox']:not([aria-disabled='true'])",
  "[role='menuitem']:not([data-disabled])",
  "[role='menuitemcheckbox']:not([data-disabled])",
  "[role='menuitemradio']:not([data-disabled])",
  "[role='option']:not([aria-disabled='true'])",
  "[role='radio']:not([aria-disabled='true'])",
  "[role='switch']:not([aria-disabled='true'])",
  "[role='tab']:not([disabled])",
];

function isVisibleCursorTarget(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== "none" &&
    style.visibility !== "hidden"
  );
}

function describeCursorTarget(element: HTMLElement) {
  return [
    element.tagName.toLowerCase(),
    element.dataset.testid ? `[data-testid="${element.dataset.testid}"]` : "",
    element.getAttribute("role")
      ? `[role="${element.getAttribute("role")}"]`
      : "",
    element.id ? `#${element.id}` : "",
  ].join("");
}

function expectVisibleInteractiveElementsUsePointer() {
  const offenders = Array.from(
    document.querySelectorAll<HTMLElement>(
      interactiveCursorSelectors.join(","),
    ),
  )
    .filter(isVisibleCursorTarget)
    .filter((element) => getComputedStyle(element).pointerEvents !== "none")
    .filter((element) => getComputedStyle(element).cursor !== "pointer")
    .map(
      (element) =>
        `${describeCursorTarget(element)} -> ${getComputedStyle(element).cursor}`,
    );

  expect(offenders).toEqual([]);
}

function expectDialogMirrorsInlineEnd(testId: string) {
  const dialog = document.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  const close = dialog?.querySelector<HTMLElement>(
    '[data-slot="dialog-close"]',
  );
  const header = dialog?.querySelector<HTMLElement>(
    '[data-slot="dialog-header"]',
  );
  expect(dialog).toBeTruthy();
  expect(close).toBeTruthy();
  expect(header).toBeTruthy();
  expectTextAlignsToStart(header as HTMLElement);

  const dialogRect = (dialog as HTMLElement).getBoundingClientRect();
  const closeRect = (close as HTMLElement).getBoundingClientRect();
  const distanceToLeft = Math.abs(closeRect.left - dialogRect.left);
  const distanceToRight = Math.abs(dialogRect.right - closeRect.right);
  if (document.documentElement.dir === "rtl") {
    expect(distanceToLeft).toBeLessThan(distanceToRight);
  } else {
    expect(distanceToRight).toBeLessThan(distanceToLeft);
  }
}

function expectNativeSelectIconMirrorsInlineEnd(testId: string) {
  const select = document.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  const wrapper = select?.closest<HTMLElement>(
    '[data-slot="native-select-wrapper"]',
  );
  const icon = wrapper?.querySelector<HTMLElement>(
    '[data-slot="native-select-icon"]',
  );
  expect(wrapper).toBeTruthy();
  expect(icon).toBeTruthy();

  const wrapperRect = (wrapper as HTMLElement).getBoundingClientRect();
  const iconRect = (icon as HTMLElement).getBoundingClientRect();
  const distanceToLeft = Math.abs(iconRect.left - wrapperRect.left);
  const distanceToRight = Math.abs(wrapperRect.right - iconRect.right);
  if (document.documentElement.dir === "rtl") {
    expect(distanceToLeft).toBeLessThan(distanceToRight);
  } else {
    expect(distanceToRight).toBeLessThan(distanceToLeft);
  }
}

function expectSwitchThumbMirrorsCurrentState(testId: string) {
  const switchRoot = document.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  const thumb = switchRoot?.querySelector<HTMLElement>(
    '[data-slot="switch-thumb"]',
  );
  expect(switchRoot).toBeTruthy();
  expect(thumb).toBeTruthy();

  const rootRect = (switchRoot as HTMLElement).getBoundingClientRect();
  const thumbRect = (thumb as HTMLElement).getBoundingClientRect();
  const thumbCenter = thumbRect.left + thumbRect.width / 2;
  const rootCenter = rootRect.left + rootRect.width / 2;
  const checked =
    (switchRoot as HTMLElement).getAttribute("aria-checked") === "true";
  if (document.documentElement.dir === "rtl" && checked) {
    expect(thumbCenter).toBeLessThan(rootCenter);
  } else if (document.documentElement.dir === "rtl") {
    expect(thumbCenter).toBeGreaterThan(rootCenter);
  } else if (checked) {
    expect(thumbCenter).toBeGreaterThan(rootCenter);
  } else {
    expect(thumbCenter).toBeLessThan(rootCenter);
  }
}

function visibleSectionLinks() {
  return Array.from(
    document.querySelectorAll<HTMLAnchorElement>('a[data-testid^="section-"]'),
  ).filter((element) => element.getBoundingClientRect().width > 0);
}

function expectResponsiveTabMenu() {
  const links = visibleSectionLinks();
  expect(links.length).toBeGreaterThan(1);
  expect(document.querySelector('[data-testid="section-select"]')).toBeNull();
  const rects = links.map((link) => link.getBoundingClientRect());
  for (let index = 1; index < rects.length; index += 1) {
    expect(Math.abs(rects[index].top - rects[0].top)).toBeLessThan(2);
  }
}

function testIdRect(testId: string) {
  const element = document.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  expect(element).toBeTruthy();
  return (element as HTMLElement).getBoundingClientRect();
}

function expectAuthKeyDateTimePickerClosed() {
  const picker = document.querySelector<HTMLElement>(
    '[data-slot="date-time-picker"]',
  );
  expect(picker).toBeTruthy();
  expectNoHorizontalOverflow();

  expect(getComputedStyle(picker as HTMLElement).display).toBe("grid");
  expect(testIdRect("invite-expiration").width).toBeGreaterThan(0);
  expect(
    document.querySelector('[data-testid="invite-expiration-hour"]'),
  ).toBeNull();
  expect(
    document.querySelector('[data-testid="invite-expiration-minute"]'),
  ).toBeNull();
}

function expectAuthKeyTimePickerPopover() {
  const timePicker = document.querySelector<HTMLElement>(
    '[data-slot="time-picker"]',
  );
  const calendar = document.querySelector<HTMLElement>(
    '[data-slot="calendar"]',
  );
  const popover = document.querySelector<HTMLElement>(
    '[data-slot="popover-content"]',
  );
  expect(timePicker).toBeTruthy();
  expect(calendar).toBeTruthy();
  expect(popover).toBeTruthy();
  expectNoHorizontalOverflow();

  const orderedSlots = Array.from(
    (popover as HTMLElement).querySelectorAll<HTMLElement>(
      '[data-slot="calendar"], [data-slot="time-picker"]',
    ),
  ).map((element) => element.dataset.slot);
  expect(orderedSlots).toEqual(["calendar", "time-picker"]);
  const popoverRect = (popover as HTMLElement).getBoundingClientRect();
  const timeRect = (timePicker as HTMLElement).getBoundingClientRect();
  expect(timeRect.bottom).toBeLessThanOrEqual(popoverRect.bottom + 1);
  expect(
    document.querySelector<HTMLElement>(
      '[data-testid="invite-expiration-time-label"]',
    ),
  ).toBeTruthy();
  const hourRect = testIdRect("invite-expiration-hour");
  const minuteRect = testIdRect("invite-expiration-minute");
  expect(Math.abs(hourRect.top - minuteRect.top)).toBeLessThan(2);
  expect(hourRect.right).toBeLessThanOrEqual(minuteRect.left);
  expect(
    document.querySelectorAll(
      'input[type="time"], input[type="datetime-local"]',
    ).length,
  ).toBe(0);
}

function expectAppHeader() {
  const header = document.querySelector<HTMLElement>(
    '[data-testid="app-header"]',
  );
  const primaryRow = document.querySelector<HTMLElement>(
    '[data-testid="header-primary-row"]',
  );
  const navigation = document.querySelector<HTMLElement>(
    '[data-testid="header-navigation"]',
  );
  const pageBody = document.querySelector<HTMLElement>(
    '[data-testid="page-body"]',
  );
  expect(header?.getBoundingClientRect().width).toBe(
    document.documentElement.clientWidth,
  );
  expect(primaryRow).toBeTruthy();
  expect(navigation).toBeTruthy();
  expect(navigation?.querySelectorAll("a[href]")).toHaveLength(6);
  expect(primaryRow?.parentElement?.className).toContain("container");
  expect(pageBody?.className).toContain("container");
  expect(pageBody?.className).toContain("mx-auto");
  expect(
    document.querySelector<HTMLElement>('[data-testid="app-logo"]')
      ?.textContent,
  ).toContain("Headscale UI");
  expect(
    document.querySelector<SVGElement>('[data-testid="app-logo"] svg'),
  ).toBeTruthy();
  const githubLink = document.querySelector<HTMLElement>(
    '[data-testid="github-repository-link"]',
  );
  const profileTrigger = document.querySelector<HTMLElement>(
    '[data-testid="profile-menu-trigger"]',
  );
  expect(githubLink).toBeTruthy();
  expect(profileTrigger).toBeTruthy();
  expect(githubLink?.getAttribute("href")).toBe(
    "https://github.com/MunMunMiao/headscale-ui",
  );
  expect(
    githubLink?.compareDocumentPosition(profileTrigger as HTMLElement),
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(
    document.querySelector<HTMLElement>('[data-testid="current-server"]'),
  ).toBeNull();
  expect(navigation?.getAttribute("dir")).toBe(document.documentElement.dir);

  const headerRect = header?.getBoundingClientRect();
  const primaryRect = primaryRow?.getBoundingClientRect();
  const navigationRect = navigation?.getBoundingClientRect();
  const headerStyle = getComputedStyle(header as HTMLElement);
  const pageSurfaceStyle = getComputedStyle(document.body);
  expect(headerStyle.borderBottomWidth).toBe("0px");
  expect(headerStyle.boxShadow).not.toBe("none");
  expect(headerStyle.backgroundColor).not.toBe(
    pageSurfaceStyle.backgroundColor,
  );
  expect(primaryRect?.top ?? 0).toBeGreaterThanOrEqual(
    (headerRect?.top ?? 0) - 1,
  );
  expect(navigationRect?.top ?? 0).toBeGreaterThanOrEqual(
    (primaryRect?.bottom ?? 0) - 1,
  );
  expect(navigationRect?.top ?? 0).toBeLessThanOrEqual(
    (primaryRect?.bottom ?? 0) + 1,
  );
  expect(navigationRect?.bottom ?? 0).toBeLessThanOrEqual(
    (headerRect?.bottom ?? 0) + 1,
  );
  expect(getComputedStyle(navigation as HTMLElement).borderTopWidth).toBe(
    "0px",
  );

  const activeTab = navigation?.querySelector<HTMLElement>(
    '[aria-current="page"]',
  );
  expect(activeTab).toBeTruthy();
  expect(activeTab?.className).toContain("text-primary");
}

async function expectMachinesWorkbench() {
  await expect.element(page.getByTestId("machines-workbench")).toBeVisible();
  await expect.element(page.getByTestId("device-1")).toBeVisible();
  expect(
    document.querySelector<HTMLElement>('[data-testid="machines-workbench"]'),
  ).toBeTruthy();
  expect(
    document.querySelector<HTMLElement>('[data-testid="machine-toolbar"]'),
  ).toBeTruthy();
  expect(
    document.querySelector<HTMLElement>('[data-testid="machine-list"]'),
  ).toBeTruthy();
  expect(
    document.querySelector<HTMLElement>('[data-testid="device-1"]'),
  ).toBeTruthy();
  expect(
    document.querySelector('[data-testid="device-1"]')?.closest("table"),
  ).toBeTruthy();
  expect(
    document
      .querySelector('[data-testid="device-search"]')
      ?.closest('[data-testid="machine-list"]'),
  ).toBeNull();
  expect(
    document
      .querySelector('[data-testid="device-search"]')
      ?.closest('[data-testid="machine-toolbar"]'),
  ).toBeTruthy();
  const deviceIpBadges = document.querySelectorAll<HTMLElement>(
    '[data-testid^="device-ip-1-"]',
  );
  expect(deviceIpBadges).toHaveLength(2);
  expect(deviceIpBadges[0]?.textContent).toContain("100.64.0.1");
  expect(deviceIpBadges[0]?.className).toContain("font-mono");
  const deviceTag = document.querySelector<HTMLElement>(
    '[data-testid="device-tag-2-0"]',
  );
  const deviceStatus = document.querySelector<HTMLElement>(
    '[data-testid="device-status-1"]',
  );
  const offlineStatus = document.querySelector<HTMLElement>(
    '[data-testid="device-status-2"]',
  );
  const expiredStatus = document.querySelector<HTMLElement>(
    '[data-testid="device-status-3"]',
  );
  expect(deviceTag).toBeTruthy();
  expect(deviceStatus).toBeTruthy();
  expect(offlineStatus).toBeTruthy();
  expect(expiredStatus).toBeTruthy();
  expect(deviceTag?.className).toContain("bg-cyan-50");
  expect(deviceTag?.className).not.toBe(deviceStatus?.className);
  expect(deviceStatus?.textContent).toContain("Online");
  expect(deviceStatus?.className).toContain("emerald");
  expect(offlineStatus?.textContent).toContain("Offline");
  expect(offlineStatus?.className).toContain("slate");
  expect(expiredStatus?.textContent).toContain("Expired");
  expect(expiredStatus?.className).toContain("rose");
  expect(deviceStatus?.className).not.toBe(offlineStatus?.className);
  expect(deviceStatus?.className).not.toBe(expiredStatus?.className);
  expect(offlineStatus?.className).not.toBe(expiredStatus?.className);
  expect(document.querySelector('[data-testid="device-tag-3-0"]')).toBeNull();
  expect(
    document.querySelector('[data-testid="device-pending-routes-1"]'),
  ).toBeNull();
  const pendingRouteBadges = document.querySelectorAll<HTMLElement>(
    '[data-testid^="device-pending-route-2-"]',
  );
  const approvedRouteBadge = document.querySelector<HTMLElement>(
    '[data-testid="device-approved-route-2-0"]',
  );
  expect(pendingRouteBadges).toHaveLength(2);
  expect(pendingRouteBadges[0]?.textContent).toContain("0.0.0.0/0");
  expect(pendingRouteBadges[0]?.className).toContain("rose");
  expect(approvedRouteBadge?.textContent).toContain("10.42.0.0/16");
  expect(approvedRouteBadge?.className).toContain("emerald");
  expect(pendingRouteBadges[0]?.className).not.toBe(
    approvedRouteBadge?.className,
  );
  const deviceTableText =
    document.querySelector('[data-testid="machine-list"]')?.textContent ?? "";
  expect(deviceTableText).not.toMatch(
    /No tags|无标签|No pending routes|无待审路由/,
  );
}

function expectRecentDeviceStatusColors() {
  const recentOnline = document.querySelector<HTMLElement>(
    '[data-testid="recent-device-status-1"]',
  );
  const recentOffline = document.querySelector<HTMLElement>(
    '[data-testid="recent-device-status-2"]',
  );
  const recentExpired = document.querySelector<HTMLElement>(
    '[data-testid="recent-device-status-3"]',
  );
  expect(recentOnline?.textContent).toContain("Online");
  expect(recentOnline?.className).toContain("emerald");
  expect(recentOffline?.textContent).toContain("Offline");
  expect(recentOffline?.className).toContain("slate");
  expect(recentExpired?.textContent).toContain("Expired");
  expect(recentExpired?.className).toContain("rose");
}

/** Index of the approved-route badge that shows `route`, read from its `route-approved-<node>-<index>` id. */
function approvedRouteIndex(nodeId: string, route: string) {
  const badge = Array.from(
    document.querySelectorAll<HTMLElement>(
      `[data-testid^="route-approved-${nodeId}-"]`,
    ),
  ).find((element) => element.textContent?.trim() === route);
  expect(badge, `approved route badge ${route}`).toBeTruthy();
  return badge?.dataset.testid?.split("-").at(-1) ?? "";
}

async function approvedRoutesOf(nodeId: string) {
  return [
    ...normalizeHeadscaleNode(
      (
        await request(adopted().read, {
          endpoint: "getNode",
          input: { nodeId },
        })
      ).node,
    ).approvedRoutes,
  ].sort();
}

async function operationCount(id: string) {
  return (
    (await commands.headscaleOperationCalls())?.filter((call) => call.id === id)
      .length ?? 0
  );
}

async function expectUiOperationDelta(
  operationId: OperationId,
  countBeforeUiAction: number,
  observedOperationIds: Set<OperationId>,
) {
  await expect
    .poll(async () => await operationCount(operationId))
    .toBeGreaterThan(countBeforeUiAction);
  observedOperationIds.add(operationId);
}

async function observeApiContract<T>(
  operationId: OperationId,
  observedOperationIds: Set<OperationId>,
  request: () => Promise<T>,
) {
  const response = await request();
  observedOperationIds.add(operationId);
  return response;
}

function lastElementByTestIdPrefix(prefix: string) {
  const elements = Array.from(
    document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`),
  );
  const element = elements.at(-1);
  expect(element).toBeTruthy();
  return element as HTMLElement;
}

async function clickLastByTestIdPrefix(prefix: string) {
  await page.elementLocator(lastElementByTestIdPrefix(prefix)).click();
}

async function inputLastByTestIdPrefix(prefix: string, value: string) {
  const testId = lastElementByTestIdPrefix(prefix).dataset.testid;
  expect(testId).toBeTruthy();
  await page.getByTestId(testId as string).fill(value);
}

async function expectPolicyRemovalDialog() {
  await expect
    .element(page.getByTestId("remove-policy-item-dialog"))
    .toBeVisible();
  const confirm = document.querySelector<HTMLElement>(
    '[data-testid="confirm-remove-policy-item"]',
  );
  expect(confirm?.className).toContain("bg-destructive");
}

async function expectPolicyRemovalDialogClosed() {
  await expect
    .poll(() =>
      document.querySelector('[data-testid="remove-policy-item-dialog"]'),
    )
    .toBeNull();
}

async function waitForActionFinished(key: ActionFeedbackKey) {
  const feedback = session().feedback;
  // A mutation and its snapshot refresh each have a 15-second HTTP deadline.
  await expect
    .poll(() => feedback.isActionPending(key), { timeout: 30_000 })
    .toBe(false);
  expect(feedback.actionError(key)).toBe("");
  expect(feedback.getSnapshot().lastError).toBe("");
}

async function latestSavedPolicy() {
  await waitForActionFinished("save-policy");
  const policyCall = (await commands.headscaleOperationCalls())
    ?.filter((call) => call.id === "policy.set")
    .at(-1);
  expect(policyCall).toBeTruthy();
  const payload = policyCall?.payload as { policy?: string };
  expect(typeof payload.policy).toBe("string");
  const expected = JSON.parse(payload.policy ?? "{}");
  const client = adopted();
  let persisted: unknown;
  await expect
    .poll(async () => {
      persisted = JSON.parse((await readPolicy(client.read)).policy);
      return persisted;
    })
    .toEqual(expected);
  return persisted as {
    acls?: Array<{ action: string; src: string[]; dst: string[] }>;
    groups?: Record<string, string[]>;
    tagOwners?: Record<string, string[]>;
    ssh?: unknown;
  };
}

function expectNoRawPolicyEditor() {
  const labels = document.querySelector<HTMLElement>(
    '[data-testid="device-labels-section"]',
  );
  const teams = document.querySelector<HTMLElement>(
    '[data-testid="teams-section"]',
  );
  expect(labels ?? teams).toBeTruthy();
  for (const root of [labels, teams]) {
    expect(root?.querySelector("textarea")).toBeNull();
    expect(root?.querySelector('[contenteditable="true"]')).toBeNull();
    expect(root?.querySelector(".cm-editor, .monaco-editor")).toBeNull();
  }
}

async function clickDomTestId(testId: string) {
  const element = document.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  expect(element).toBeTruthy();
  if (element) await page.elementLocator(element).click();
}

function visibleDomTestId(testId: string) {
  const elements = Array.from(
    document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
  );
  const visible = elements.find((element) => {
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  expect(visible).toBeTruthy();
  return visible as HTMLElement;
}

async function clickVisibleDomTestId(testId: string) {
  await expect.element(page.getByTestId(testId)).toBeVisible();
  await page.elementLocator(visibleDomTestId(testId)).click();
}

async function selectDomTab(testId: string) {
  await expect.element(page.getByTestId(testId)).toBeVisible();
  await page.getByTestId(testId).click();
  await expect
    .element(page.getByTestId(testId))
    .toHaveAttribute("aria-selected", "true");
}

function inputDomTestId(testId: string, value: string) {
  const element = visibleDomTestId(testId) as HTMLInputElement;
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

async function selectDomTestId(testId: string, value: string) {
  const element = document.querySelector<HTMLSelectElement>(
    `[data-testid="${testId}"]`,
  );
  expect(element).toBeTruthy();
  if (!element) {
    return;
  }
  await page.elementLocator(element).selectOptions(value);
}

function stubDownloads() {
  const downloads: string[] = [];
  const objectTypes: string[] = [];
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalAnchorClick = HTMLAnchorElement.prototype.click;

  URL.createObjectURL = ((blob: Blob) => {
    objectTypes.push(blob.type);
    return `blob:headscale-ui-${objectTypes.length}`;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
  HTMLAnchorElement.prototype.click = function clickAnchor() {
    downloads.push(this.download);
  };

  return {
    downloads,
    objectTypes,
    restore() {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
      HTMLAnchorElement.prototype.click = originalAnchorClick;
    },
  };
}

function stubClipboard() {
  const writes: string[] = [];
  const ownDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const prototypeDescriptor = Object.getOwnPropertyDescriptor(
    Navigator.prototype,
    "clipboard",
  );

  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        writes.push(value);
      },
    },
  });

  return {
    writes,
    restore() {
      if (ownDescriptor) {
        Object.defineProperty(navigator, "clipboard", ownDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
      if (prototypeDescriptor) {
        Object.defineProperty(
          Navigator.prototype,
          "clipboard",
          prototypeDescriptor,
        );
      }
    },
  };
}

async function openProfileMenu() {
  const menu = document.querySelector<HTMLElement>(
    '[data-testid="profile-menu"]',
  );
  if (!menu || menu.getBoundingClientRect().width === 0) {
    await clickVisibleDomTestId("profile-menu-trigger");
  }
  await expect.element(page.getByTestId("profile-menu")).toBeVisible();
}

async function closeProfileMenu() {
  const submenu = document.querySelector<HTMLElement>(
    '[data-slot="dropdown-menu-sub-content"][data-open]',
  );
  if (submenu) {
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => submenu.isConnected).toBe(false);
  }
  const menu = document.querySelector<HTMLElement>(
    '[data-testid="profile-menu"]',
  );
  if (menu?.hasAttribute("data-open")) {
    await userEvent.keyboard("{Escape}");
  }
  await expect
    .element(page.getByTestId("profile-menu"))
    .not.toBeInTheDocument();
}

async function closeLayerWithEscape(testId: string) {
  const layer = document.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  const closeButton = layer?.querySelector<HTMLButtonElement>(
    '[data-slot="dialog-close"]',
  );
  if (closeButton) {
    closeButton.click();
  } else {
    await userEvent.keyboard("{Escape}");
  }
  await expect
    .poll(() => document.querySelector(`[data-testid="${testId}"]`))
    .toBeNull();
}

async function clickDialogOverlay() {
  const overlay = document.querySelector<HTMLElement>(
    '[data-slot="dialog-overlay"]',
  );
  expect(overlay).toBeTruthy();
  for (const event of [
    new PointerEvent("pointerdown", {
      bubbles: true,
      composed: true,
      pointerId: 1,
    }),
    new PointerEvent("pointerup", {
      bubbles: true,
      composed: true,
      pointerId: 1,
    }),
    new MouseEvent("click", { bubbles: true, composed: true }),
  ]) {
    overlay?.dispatchEvent(event);
  }
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function chooseProfileMenuOption(testId: string) {
  await openProfileMenu();
  if (testId.startsWith("locale-option-")) {
    await clickDomTestId("language-menu-trigger");
  }
  if (testId.startsWith("theme-option-")) {
    await clickDomTestId("theme-menu-trigger");
  }
  await expect.element(page.getByTestId(testId)).toBeVisible();
  await expect
    .element(page.getByTestId(testId))
    .toHaveAttribute("role", "menuitemradio");
  await clickDomTestId(testId);
  await closeProfileMenu();
}

/** Re-opens the preference menu and asserts the radio item reports the active choice. */
async function expectProfileMenuRadioChecked(testId: string) {
  await openProfileMenu();
  if (testId.startsWith("locale-option-")) {
    await clickDomTestId("language-menu-trigger");
  }
  if (testId.startsWith("theme-option-")) {
    await clickDomTestId("theme-menu-trigger");
  }
  await expect
    .element(page.getByTestId(testId))
    .toHaveAttribute("aria-checked", "true");
  await closeProfileMenu();
}

async function selectSectionTab(section: string) {
  // Primary navigation is a list of links: the current page is aria-current, not aria-selected.
  await expect.element(page.getByTestId(`section-${section}`)).toBeVisible();
  await page.getByTestId(`section-${section}`).click();
  await expect
    .element(page.getByTestId(`section-${section}`))
    .toHaveAttribute("aria-current", "page");
  await expect
    .poll(() => window.location.pathname.endsWith(`/${section}`), {
      timeout: 2000,
    })
    .toBe(true);
}

async function confirmDeleteProfile(name: string) {
  await page.getByTestId(`delete-profile-${name}`).click();
  await expect.element(page.getByTestId("delete-profile-dialog")).toBeVisible();
  await page.getByTestId("confirm-delete-profile").click();
}

test("keeps requested test viewports inside the browser content area", async () => {
  for (const [width, height] of [
    [1366, 768],
    [390, 640],
    [360, 568],
  ]) {
    await page.viewport(width, height);
    await expect.poll(() => window.innerWidth).toBe(width);
    await expect.poll(() => window.innerHeight).toBe(height);
    expect(window.top?.innerWidth).toBeGreaterThanOrEqual(width);
    expect(window.top?.innerHeight).toBeGreaterThanOrEqual(height);
  }
});

test("keeps native clicks targeted when preceding layers unmount", async () => {
  const precedingLayer = document.createElement("div");
  const targetLayer = document.createElement("div");
  const button = document.createElement("button");
  const testId = 'provider:target-"quoted"';
  button.dataset.testid = testId;
  button.textContent = "Native click target";
  let clicks = 0;
  button.addEventListener("click", () => clicks++);
  targetLayer.append(button);
  document.body.append(precedingLayer, targetLayer);

  // Resolve the official provider's element locator before the preceding dialog exits.
  const resolved = page.elementLocator(button);
  precedingLayer.remove();
  await resolved.click();
  expect(clicks).toBe(1);

  const hiddenDuplicate = button.cloneNode(true) as HTMLButtonElement;
  hiddenDuplicate.hidden = true;
  const scope = document.createElement("div");
  scope.dataset.testid = "provider-target-scope";
  scope.append(button);
  document.body.append(hiddenDuplicate, scope);
  await page.getByTestId("provider-target-scope").getByTestId(testId).click();
  expect(clicks).toBe(2);
});

test("requires connection details for a new profile", async () => {
  await renderLogin();
  await page.getByTestId("profile-option-new").click();
  await expect
    .element(page.getByTestId("connect-profile-name"))
    .toHaveValue("");
  await expect.element(page.getByTestId("connect-server-url")).toHaveValue("");
  await expect.element(page.getByTestId("connect-api-key")).toHaveValue("");
  await page.getByTestId("connect-submit").click();
  expect(storedProfiles()).toEqual([]);
  expect(currentProfileId()).toBeNull();
  expect(document.querySelector('[data-testid="section-home"]')).toBeNull();

  // 首次提交后随输入复检；缺少密码时显示字段错误，并保留已输入的 API key。
  await page.getByTestId("connect-server-url").fill(dockerSettings().baseUrl);
  await page.getByTestId("connect-api-key").fill(dockerSettings().apiKey);
  await expect.element(page.getByTestId("connect-submit")).toBeDisabled();
  await expect
    .poll(() => visibleText("connect-password-error"))
    .toBe(t("serverPasswordRequired"));
  await expect
    .element(page.getByTestId("connect-api-key"))
    .toHaveValue(dockerSettings().apiKey);
  expect(storedProfiles()).toEqual([]);
});

test("renders bootstrap error recovery actions", async () => {
  let reloads = 0;
  await render(
    <ErrorScreen
      error={new Error("IndexedDB unavailable")}
      reloadPage={() => {
        reloads += 1;
      }}
    />,
  );

  await expect.element(page.getByTestId("error-screen")).toBeVisible();
  await page.getByTestId("error-reload").click();
  expect(reloads).toBe(1);

  expect(document.querySelector('[data-testid="error-reset"]')).toBeNull();
});

test("resets an unreadable vault only through the shared session", async () => {
  const rendered = await renderLogin();
  await connectWithDefaults();
  expect(storedProfiles()).toHaveLength(1);
  expect(session().auth.getSessionSnapshot()?.status).toBe("unlocked");
  await rendered.unmount();

  // The vault state record is the only integrity anchor; without it the stored profiles are unreadable.
  await idbDelete(STORE_META, VAULT_STATE_KEY);
  expect(await idbGet(STORE_META, VAULT_STATE_KEY)).toBeUndefined();
  let reloads = 0;
  await render(
    <ErrorScreen
      error={new VaultDataError()}
      onReset={resetUnreadableVault}
      reloadPage={() => {
        reloads += 1;
      }}
    />,
  );

  await page.getByTestId("error-reset").click();
  await expect.element(page.getByTestId("error-reset-confirm")).toBeVisible();
  await page.getByTestId("error-reset-cancel").click();
  await expect.element(page.getByTestId("error-reset")).toBeVisible();
  // Cancelling must not touch storage or the running session.
  expect(await idbGetAll(STORE_PROFILES)).toHaveLength(1);
  expect(await idbGet(STORE_META, VAULT_STATE_KEY)).toBeUndefined();
  expect(session().auth.getSessionSnapshot()?.status).toBe("unlocked");
  expect(reloads).toBe(0);

  await page.getByTestId("error-reset").click();
  await page.getByTestId("error-reset-confirm").click();
  await expect.poll(() => reloads).toBe(1);
  expect(await idbGetAll(STORE_PROFILES)).toEqual([]);
  expect(await idbGetAll(STORE_KEYS)).toEqual([]);
  expect(await idbGet<VaultVersion>(STORE_META, VAULT_STATE_KEY)).toMatchObject(
    {
      keyEpoch: expect.any(String),
      profilesRevision: expect.any(Number),
    },
  );
  // The reset went through the shared Worker, which locked the session it was holding.
  await expect
    .poll(() => session().auth.getSessionSnapshot()?.status)
    .toBe("locked");
});

test("unlocks encrypted profiles and exposes forgotten-passphrase recovery", async () => {
  await renderLogin("/login?redirect=/home");
  await page.getByTestId("profile-option-new").click();
  await page.getByTestId("connect-profile-name").fill("Password recovery");
  await fillConnection();
  await page.getByTestId("connect-submit").click();
  await expect
    .element(page.getByTestId("profile-option-Password recovery"))
    .toBeVisible();
  await commands.clearHeadscaleOperationCalls();
  await page.getByTestId("profile-option-Password recovery").click();
  await expect.element(page.getByTestId("unlock-dialog")).toBeVisible();
  expect(await commands.headscaleOperationCalls()).toEqual([]);
  await page.getByTestId("unlock-cancel").click();
  await expect
    .element(page.getByTestId("unlock-dialog"))
    .not.toBeInTheDocument();
  expect(session().auth.getSessionSnapshot()?.status).toBe("locked");
  await page.getByTestId("profile-option-Password recovery").click();
  await page.getByTestId("unlock-passphrase").fill("wrong horse");
  await page.getByTestId("unlock-submit").click();
  await expect.element(page.getByTestId("unlock-error")).toBeVisible();
  await expect.element(page.getByTestId("unlock-passphrase")).toHaveValue("");
  expect(await commands.headscaleOperationCalls()).toEqual([]);
  expect(storedProfiles()).toHaveLength(1);

  await expect
    .element(page.getByTestId("unlock-dialog"))
    .not.toMatchTextContent("Clear all saved profiles");
  await page.getByTestId("unlock-cancel").click();
  await page.getByTestId("login-clear-all").click();
  await page.getByTestId("login-clear-all-cancel").click();
  expect(storedProfiles()).toHaveLength(1);
  await page.getByTestId("profile-option-Password recovery").click();
  await page
    .getByTestId("unlock-passphrase")
    .fill(profilePassword("Password recovery"));
  await page.getByTestId("unlock-submit").click();
  await expect.element(page.getByTestId("section-home")).toBeVisible();
  expect(session().auth.getSessionSnapshot()?.profile?.name).toBe(
    "Password recovery",
  );
});

test("manages multiple saved connection profiles and supports logout", async () => {
  const rendered = await renderLogin();

  await page.getByTestId("profile-option-new").click();
  await expect.element(page.getByTestId("connect-form")).toBeVisible();
  await page.getByTestId("connect-profile-name").fill("Office");
  await fillConnection();
  await page.getByTestId("connect-remember").click();
  await page.getByTestId("connect-remember").click();
  await page.getByTestId("connect-submit").click();
  await expect.poll(() => storedProfilesString()).toContain("Office");
  const officeProfile = storedProfiles().find(
    (profile) => profile.name === "Office",
  );
  expect(officeProfile?.id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  await expect.element(page.getByTestId("profile-row-Office")).toBeVisible();
  await page.getByTestId("edit-profile-Office").click();
  await expect.element(page.getByTestId("connection-dialog")).toBeVisible();
  await expect
    .element(page.getByTestId("connect-profile-name"))
    .toHaveValue("Office");
  await page.getByTestId("connect-profile-name").fill("HQ");
  await page.getByTestId("connect-submit").click();
  await expect.poll(() => storedProfilesString()).toContain("HQ");
  await expect.poll(() => storedProfilesString()).not.toContain("Office");
  const hqProfile = storedProfiles().find((profile) => profile.name === "HQ");
  expect(hqProfile).toBeTruthy();
  await expect.element(page.getByTestId("profile-row-HQ")).toBeVisible();

  await page.getByTestId("profile-option-new").click();
  await expect.element(page.getByTestId("connection-dialog")).toBeVisible();
  await page.getByTestId("connect-profile-name").fill("Lab");
  await fillConnection();
  await page.getByTestId("connect-submit").click();
  await expect.poll(() => storedProfilesString()).toContain("HQ");
  await expect.poll(() => storedProfilesString()).toContain("Lab");
  const labProfile = storedProfiles().find((profile) => profile.name === "Lab");
  expect(labProfile).toBeTruthy();

  await unlockProfile("HQ", profilePassword("Office"));
  await expect.element(page.getByTestId("section-home")).toBeVisible();
  await expect
    .element(page.getByTestId("recent-device-status-1"))
    .toBeVisible();
  // The newest-four slice only shows every node while the fixture has exactly three of them.
  expect(
    session()
      .snapshot.getSnapshot()
      .snapshot.nodes.map((node) => node.id),
  ).toEqual(["1", "2", "3"]);
  // Newest first: ordered by node id, descending.
  expect(
    Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="recent-device-"]'),
    )
      .map((element) => element.dataset.testid ?? "")
      .filter((testId) => /^recent-device-\d+$/.test(testId)),
  ).toEqual(["recent-device-3", "recent-device-2", "recent-device-1"]);
  expectRecentDeviceStatusColors();
  await openProfileMenu();
  await expect
    .element(page.getByTestId("profile-menu"))
    .toMatchTextContent("HQ");
  expect(document.querySelector('[data-testid="current-server"]')).toBeNull();
  await closeProfileMenu();
  await expect.poll(() => window.location.pathname).toBe("/home");
  await expect.element(page.getByTestId("section-devices")).toBeVisible();
  await page.getByTestId("section-devices").click();
  await expect.poll(() => window.location.pathname).toBe("/devices");
  await expectMachinesWorkbench();

  const profileRoute = window.location.pathname;
  await rendered.unmount();
  await renderLogin(profileRoute);
  await expect.element(page.getByTestId("section-devices")).toBeVisible();
  await openProfileMenu();
  await expect
    .element(page.getByTestId("profile-menu"))
    .toMatchTextContent("HQ");
  await closeProfileMenu();

  expect(document.querySelector("#server-url")).toBeNull();
  expect(document.querySelector("#api-key")).toBeNull();
  expect(currentProfileId()).toBeTruthy();

  await page.getByTestId("profile-menu-trigger").click();
  await openProfileMenu();
  await page.getByTestId("logout").click();
  await expect.element(page.getByTestId("profile-picker")).toBeVisible();
  await commands.clearHeadscaleOperationCalls();
  await new Promise((resolve) => window.setTimeout(resolve, 5200));
  expect(await commands.headscaleOperationCalls()).toEqual([]);
  expect(window.location.pathname).toBe("/login");
  expect(currentProfileId()).toBeNull();
  await expect.poll(() => storedProfilesString()).toContain("HQ");

  await page.getByTestId("delete-profile-HQ").click();
  await expect.element(page.getByTestId("delete-profile-dialog")).toBeVisible();
  await expect
    .element(page.getByTestId("delete-profile-dialog"))
    .toMatchTextContent("HQ");
  await page.getByTestId("cancel-delete-profile").click();
  await expect.poll(() => storedProfilesString()).toContain("HQ");
  await confirmDeleteProfile("HQ");
  await expect.poll(() => storedProfilesString()).not.toContain("HQ");
  await expect.poll(() => storedProfilesString()).toContain("Lab");
  await confirmDeleteProfile("Lab");
  await expect.poll(() => storedProfilesString()).toBeNull();
});

test("does not flash the login form while restoring a profile route", async () => {
  const rendered = await renderLogin();
  await connectWithDefaults();
  const identity = session().auth.getSessionSnapshot()?.identity;
  await expect.poll(() => session().snapshot.isRefreshing).toBe(false);
  await rendered.unmount();
  await renderLogin("/devices");
  expect(session().auth.getSessionSnapshot()?.identity).toEqual(identity);
  expect(document.querySelector('[data-testid="connect-form"]')).toBeNull();
  await expect.element(page.getByTestId("section-devices")).toBeVisible();
  await expectMachinesWorkbench();
  expect(window.location.pathname).toBe("/devices");
});

test("waits for the authenticated policy before exposing editors on a cold restore", async () => {
  const rendered = await renderLogin();
  await connectWithDefaults();
  await expect.poll(() => session().snapshot.isRefreshing).toBe(false);
  const identity = session().auth.getSessionSnapshot()?.identity;
  await commands.writeHeadscaleFixturePolicy('{"acls":[]}');
  await rendered.unmount();
  await commands.interceptHeadscaleRequest("GET", "^/api/v1/policy$");
  try {
    await renderLogin("/access");
    expect(session().auth.getSessionSnapshot()?.identity).toEqual(identity);
    await expectHeadscaleGate();
    expect(document.querySelector('[data-testid="save-policy"]')).toBeNull();
    expect(document.querySelector('[data-testid="app-header"]')).toBeNull();
    expect(
      document.querySelector('[data-testid="open-access-banner"]'),
    ).toBeNull();
    await expect.element(page.getByTestId("session-loading")).toBeVisible();

    await commands.releaseHeadscaleRequest();
    await expect.element(page.getByTestId("save-policy")).toBeVisible();
    await expect
      .element(page.getByTestId("resource-access-empty"))
      .toBeVisible();
    expect(
      document.querySelector('[data-testid="session-loading"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="open-access-banner"]'),
    ).toBeNull();
    await page.getByTestId("template-apply-self-only").click();
    await expect
      .element(page.getByTestId("save-policy-dirty-badge"))
      .toBeVisible();
  } finally {
    await commands.releaseHeadscaleRequest();
    await expect
      .poll(() => session().snapshot.getSnapshot().isAuthorized)
      .toBe(true);
  }
});

test("retries a failed initial snapshot without exposing a partial authenticated page", async () => {
  const rendered = await renderLogin();
  await connectWithDefaults();
  await expect.poll(() => session().snapshot.isRefreshing).toBe(false);
  const identity = session().auth.getSessionSnapshot()?.identity;
  await rendered.unmount();
  await commands.clearHeadscaleOperationCalls();
  await commands.interceptHeadscaleRequest(
    "GET",
    "^/api/v1/policy$",
    "Initial policy unavailable",
  );
  try {
    await renderLogin("/access");
    await expectHeadscaleGate(0);
    await expect
      .element(page.getByTestId("initial-snapshot-error"))
      .toBeVisible();
    await expect
      .element(page.getByTestId("retry-initial-snapshot"))
      .toBeEnabled();
    expect(session().auth.getSessionSnapshot()?.identity).toEqual(identity);
    expect(document.querySelector('[data-testid="app-header"]')).toBeNull();
    expect(document.querySelector('[data-testid="save-policy"]')).toBeNull();
    await commands.releaseHeadscaleRequest();
    await commands.interceptHeadscaleRequest("GET", "^/api/v1/policy$");
    await page.getByTestId("retry-initial-snapshot").click();
    await expectHeadscaleGate(1);
    expect(document.querySelector('[data-testid="app-header"]')).toBeNull();
    expect(document.querySelector('[data-testid="save-policy"]')).toBeNull();
    await commands.releaseHeadscaleRequest();
    await expect.element(page.getByTestId("save-policy")).toBeVisible();
    expect(
      document.querySelector('[data-testid="initial-snapshot-error"]'),
    ).toBeNull();
    expect(session().auth.getSessionSnapshot()?.identity).toEqual(identity);
    expect(await operationCount("policy.set")).toBe(0);
  } finally {
    await commands.releaseHeadscaleRequest();
  }
});

test("leaves a failed initial snapshot through log out", async () => {
  const rendered = await renderLogin();
  await connectWithDefaults();
  await expect.poll(() => session().snapshot.isRefreshing).toBe(false);
  await rendered.unmount();
  await commands.clearHeadscaleOperationCalls();
  await commands.interceptHeadscaleRequest(
    "GET",
    "^/api/v1/policy$",
    "Initial policy unavailable",
  );
  let headerSeen = false;
  const watcher = new MutationObserver(() => {
    if (document.querySelector('[data-testid="app-header"]')) headerSeen = true;
  });
  watcher.observe(document.body, { childList: true, subtree: true });
  try {
    await renderLogin("/access");
    await expectHeadscaleGate(0);
    await expect
      .element(page.getByTestId("initial-snapshot-error"))
      .toBeVisible();
    await expect
      .element(page.getByTestId("retry-initial-snapshot"))
      .toBeEnabled();
    expect(session().auth.getSessionSnapshot()?.status).toBe("unlocked");

    await page.getByTestId("initial-snapshot-logout").click();
    await expect.element(page.getByTestId("profile-picker")).toBeVisible();
    await expect
      .poll(() => session().auth.getSessionSnapshot()?.status)
      .toBe("locked");
    expect(currentProfileId()).toBeNull();
    await expect.poll(() => window.location.pathname).toBe("/login");
    expect(
      document.querySelector('[data-testid="initial-snapshot-error"]'),
    ).toBeNull();
    expect(headerSeen).toBe(false);
    expect(document.querySelector('[data-testid="app-header"]')).toBeNull();
    expect(await operationCount("policy.set")).toBe(0);
  } finally {
    watcher.disconnect();
    await commands.releaseHeadscaleRequest();
  }
});

test("keeps the dashboard usable when the server version is unreadable or unsupported", async () => {
  const rendered = await renderLogin();
  await connectWithDefaults();
  await expect.poll(() => session().snapshot.isRefreshing).toBe(false);
  await expect
    .element(page.getByTestId("recent-device-status-1"))
    .toBeVisible();
  const nodeCount = session().snapshot.getSnapshot().snapshot.nodes.length;
  expect(nodeCount).toBeGreaterThan(0);

  // Holds the /version answer, then replaces what reaches the Worker, and refreshes the fabric segment.
  async function refreshWithVersionReply(
    reply: { rawBody: string } | { responseBody: unknown },
  ) {
    await commands.interceptHeadscaleRequest("GET", "^/version$", reply);
    const refreshing = session().snapshot.refreshSegments(["fabric"]);
    try {
      await expectHeadscaleGate();
      await commands.releaseHeadscaleRequest();
      await refreshing;
    } finally {
      await commands.releaseHeadscaleRequest();
      await refreshing;
    }
  }
  const warning = () =>
    document.querySelector('[data-testid="server-version-warning"]');
  const fabricError = () =>
    document.querySelector('[data-testid="feedback-status-error"]');

  // An unreadable reply (a proxy error page) is optional metadata: nodes still load, nothing is announced.
  await refreshWithVersionReply({ rawBody: "<html>" });
  expect(session().snapshot.getSnapshot().snapshot.nodes).toHaveLength(
    nodeCount,
  );
  expect(session().snapshot.getSnapshot().refreshErrors).toEqual({});
  await expect
    .element(page.getByTestId("recent-device-status-1"))
    .toBeVisible();
  expect(fabricError()).toBeNull();
  expect(warning()).toBeNull();

  // An unsupported series only produces a notice; the dashboard keeps working.
  await refreshWithVersionReply({ responseBody: { version: "v0.28.5" } });
  await expect
    .element(page.getByTestId("server-version-warning"))
    .toMatchTextContent("0.28.5");
  expect(fabricError()).toBeNull();
  await expect
    .element(page.getByTestId("recent-device-status-1"))
    .toBeVisible();

  // The server (v0.29.6+dirty) removes the notice again.
  await session().snapshot.refreshSegments(["fabric"]);
  await expect.poll(warning).toBeNull();
  expect(session().snapshot.getSnapshot().snapshot.version?.version).toBe(
    "v0.29.6+dirty",
  );

  // A cold load whose /version request fails must still reach the dashboard.
  await rendered.unmount();
  await commands.interceptHeadscaleRequest(
    "GET",
    "^/version$",
    "Version unavailable",
  );
  try {
    await renderLogin("/home");
    await expectHeadscaleGate(0);
    await expect.element(page.getByTestId("app-header")).toBeVisible();
    await expect
      .element(page.getByTestId("recent-device-status-1"))
      .toBeVisible();
    expect(
      document.querySelector('[data-testid="initial-snapshot-error"]'),
    ).toBeNull();
    expect(fabricError()).toBeNull();
    expect(warning()).toBeNull();
  } finally {
    await commands.releaseHeadscaleRequest();
  }
});

test("redirects unknown profile routes back to login", async () => {
  const rendered = await renderLogin();
  await connectWithDefaults();
  const identity = session().auth.getSessionSnapshot()?.identity;
  const profileId = currentProfileId();
  await rendered.unmount();
  await renderLogin("/00000000-0000-4000-8000-000000000000/devices");

  await expect.element(page.getByTestId("profile-picker")).toBeVisible();
  await expect.poll(() => window.location.pathname).toBe("/login");
  expect(document.querySelector('[data-testid="section-devices"]')).toBeNull();
  expect(currentProfileId()).toBe(profileId);
  expect(session().auth.getSessionSnapshot()?.identity).toEqual(identity);
});

test("unlocks a saved profile from a deep link pinned to another profile", async () => {
  // The redirect keeps the path but drops the foreign profile id and hash; the matching-?profile=
  // legacy-device test below guards against stripping too much.
  const rendered = await renderLogin();
  await connectWithDefaults();
  await openProfileMenu();
  await page.getByTestId("logout").click();
  await expect.element(page.getByTestId("profile-picker")).toBeVisible();
  expect(currentProfileId()).toBeNull();
  await rendered.unmount();

  await renderLogin("/devices?profile=profile-missing");
  await expect.element(page.getByTestId("profile-picker")).toBeVisible();
  expect(session().auth.getSessionSnapshot()?.status).toBe("locked");
  await unlockProfile("Docker Headscale");
  await expect.element(page.getByTestId("section-devices")).toBeVisible();
  await expect.poll(() => window.location.pathname).toBe("/devices");
  expect(new URLSearchParams(window.location.search).has("profile")).toBe(
    false,
  );
});

test("validates saved profile credentials before restoring a route", async () => {
  await seedProfileInIdb(
    {
      id: "profile-offline",
      name: "Offline",
      baseUrl: "ftp://127.0.0.1",
      apiKey: "offline-api-key",
      updatedAt: "2026-05-04T00:00:00.000Z",
    },
    { active: true },
  );

  await renderLogin("/devices");

  await expect.element(page.getByTestId("profile-picker")).toBeVisible();
  await expect.poll(() => window.location.pathname).toBe("/login");
  expect(await commands.headscaleOperationCalls()).toEqual([]);
  expect(session().auth.getSessionSnapshot()?.status).toBe("locked");
  await page.getByTestId("profile-option-Offline").click();
  await page.getByTestId("unlock-passphrase").fill(profilePassword("Offline"));
  await page.getByTestId("unlock-submit").click();
  await expect.element(page.getByTestId("unlock-error")).toBeVisible();
  expect(await commands.headscaleOperationCalls()).toEqual([]);
  expect(await idbGet(STORE_PROFILES, "profile-offline")).toBeTruthy();
  expect(document.querySelector('[data-testid="section-devices"]')).toBeNull();
  expect(currentProfileId()).toBeNull();
});

test("migrates a legacy device profile before unlocking its Headscale connection", async () => {
  await seedProfileInIdb(
    {
      id: "profile-legacy-device",
      name: "Legacy device",
      ...dockerSettings(),
      updatedAt: "2026-05-04T00:00:00.000Z",
    },
    { legacyDevice: true, active: true },
  );
  const original = await idbGet(STORE_PROFILES, "profile-legacy-device");
  await renderLogin("/devices?profile=profile-legacy-device");
  await expect
    .element(page.getByTestId("profile-option-Legacy device"))
    .toBeVisible();
  expect(session().auth.getSessionSnapshot()?.status).toBe("locked");
  expect(await commands.headscaleOperationCalls()).toEqual([]);
  expect(await idbGet(STORE_PROFILES, "profile-legacy-device")).toEqual(
    original,
  );
  await page.getByTestId("profile-option-Legacy device").click();
  await expect.element(page.getByTestId("unlock-dialog")).toBeVisible();
  await page
    .getByTestId("migration-new-password")
    .fill(profilePassword("Legacy device"));
  await page
    .getByTestId("migration-confirm-password")
    .fill(profilePassword("Legacy device"));
  await page.getByTestId("migration-submit").click();
  await expect.element(page.getByTestId("section-devices")).toBeVisible();
  await expectMachinesWorkbench();
  expect(currentProfileId()).toBe("profile-legacy-device");
  const upgraded = await idbGet<{
    apiKey: { v: number; scheme: string };
    credentialVersion: string;
  }>(STORE_PROFILES, "profile-legacy-device");
  expect(upgraded).toMatchObject({
    id: "profile-legacy-device",
    name: "Legacy device",
    scope: "persistent",
    apiKey: { v: 2, scheme: "password" },
  });
  expect(upgraded?.credentialVersion).toBeTypeOf("string");
  expect(upgraded).not.toEqual(original);
  expect(JSON.stringify(upgraded).includes(dockerSettings().apiKey)).toBe(
    false,
  );
});

test("migrates a legacy password profile with its old password before using a new server password", async () => {
  const name = "Legacy password";
  await seedProfileInIdb(
    {
      id: "profile-legacy-password",
      name,
      ...dockerSettings(),
      updatedAt: "2026-05-04T00:00:00.000Z",
    },
    { legacyPassword: "previous shared password" },
  );
  const original = await idbGet(STORE_PROFILES, "profile-legacy-password");
  await renderLogin();
  await page.getByTestId("profile-option-Legacy password").click();
  await page
    .getByTestId("migration-current-password")
    .fill("wrong shared password");
  await page.getByTestId("migration-new-password").fill(profilePassword(name));
  await page
    .getByTestId("migration-confirm-password")
    .fill(profilePassword(name));
  await page.getByTestId("migration-submit").click();
  await expect.element(page.getByTestId("unlock-error")).toBeVisible();
  expect(await commands.headscaleOperationCalls()).toEqual([]);
  expect(await idbGet(STORE_PROFILES, "profile-legacy-password")).toEqual(
    original,
  );
  await page
    .getByTestId("migration-current-password")
    .fill("previous shared password");
  await page.getByTestId("migration-new-password").fill(profilePassword(name));
  await page
    .getByTestId("migration-confirm-password")
    .fill(profilePassword(name));
  await page.getByTestId("migration-submit").click();
  await expect.element(page.getByTestId("section-home")).toBeVisible();
  expect(currentProfileId()).toBe("profile-legacy-password");
  expect(await idbGet(STORE_PROFILES, "profile-legacy-password")).toMatchObject(
    {
      apiKey: { v: 2, scheme: "password" },
    },
  );
});

test("requires explicit discard of an ordinary draft when the shared server changes", async () => {
  await renderLogin();
  await page.getByTestId("profile-option-new").click();
  await page.getByTestId("connect-profile-name").fill("Second server profile");
  await fillConnection();
  await page.getByTestId("connect-submit").click();
  await expect
    .element(page.getByTestId("profile-option-Second server profile"))
    .toBeVisible();
  const second = storedProfiles().find(
    (profile) => profile.name === "Second server profile",
  );
  if (!second) throw new Error("Missing second saved fixture profile");
  await connectWithDefaults();
  await page.getByTestId("section-members").click();
  await page.getByTestId("open-create-member").click();
  await page.getByTestId("member-name").fill("unsubmitted-original-member");
  await commands.clearHeadscaleOperationCalls();
  expect(
    await session().profiles.enterProfile(second, profilePassword(second.name)),
  ).toBe(true);
  await expect
    .element(page.getByTestId("stale-session-draft-dialog"))
    .toBeVisible();
  await expect
    .element(page.getByTestId("member-name"))
    .toHaveValue("unsubmitted-original-member");
  expect(
    (await commands.headscaleOperationCalls()).filter(
      (call) => call.id === "user.create",
    ),
  ).toEqual([]);
  await page.getByTestId("discard-stale-session-draft").click();
  await expect
    .element(page.getByTestId("stale-session-draft-dialog"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("member-create-dialog"))
    .not.toBeInTheDocument();
  await page.getByTestId("open-create-member").click();
  await expect.element(page.getByTestId("member-name")).toHaveValue("");
  expect(currentProfileId()).toBe(second.id);
});

test("preserves unreadable encrypted profiles without issuing authenticated requests", async () => {
  await seedProfileInIdb({
    id: "profile-unreadable",
    name: "Unreadable",
    ...dockerSettings(),
    updatedAt: "2026-05-04T00:00:00.000Z",
  });
  const original = await idbGet<Record<string, unknown>>(
    STORE_PROFILES,
    "profile-unreadable",
  );
  const unreadable = {
    ...original,
    apiKey: { v: 2, scheme: "password", ct: "invalid-ciphertext" },
  };
  await idbPut(STORE_PROFILES, unreadable);
  await renderLogin();
  await expect
    .element(page.getByTestId("profile-row-Unreadable"))
    .toBeVisible();
  await expect
    .element(page.getByTestId("profile-badge-corrupted-Unreadable"))
    .toBeVisible();
  expect(
    storedProfiles().find((profile) => profile.id === "profile-unreadable")
      ?.credentialKind,
  ).toBe("unreadable");
  await page.getByTestId("profile-option-Unreadable").click();
  await expect.element(page.getByTestId("connection-dialog")).toBeVisible();
  await expect.element(page.getByTestId("connect-api-key")).toHaveValue("");
  await expect.element(page.getByTestId("connect-password")).toHaveValue("");
  expect(session().auth.getSessionSnapshot()?.status).toBe("locked");
  expect(await commands.headscaleOperationCalls()).toEqual([]);
  expect(await idbGet(STORE_PROFILES, "profile-unreadable")).toEqual(
    unreadable,
  );
});

test.each(["connect-submit", "connect-save-unlock"])(
  "an unreachable %s stays in the original form until a corrected explicit retry",
  async (button) => {
    await renderLogin();
    await page.getByTestId("profile-option-new").click();
    await page.getByTestId("connect-profile-name").fill("Retry server");
    await page.getByTestId("connect-server-url").fill("http://127.0.0.1:1");
    await page.getByTestId("connect-api-key").fill("offline-api-key");
    await page
      .getByTestId("connect-password")
      .fill(profilePassword("Retry server"));
    await page
      .getByTestId("connect-password-confirm")
      .fill(profilePassword("Retry server"));
    await page.getByTestId(button).click();

    await expect.element(page.getByTestId("connect-error")).toBeVisible();
    await expect
      .poll(() => visibleText("connect-error"))
      .toBe(t("requestUnreachable"));
    await expect.element(page.getByTestId("connect-form")).toBeVisible();
    await expect
      .element(page.getByTestId("profile-validation-dialog"))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByTestId("connect-profile-name"))
      .toHaveValue("Retry server");
    for (const id of [
      "connect-api-key",
      "connect-password",
      "connect-password-confirm",
    ])
      await expect.element(page.getByTestId(id)).toHaveValue("");
    expect(storedProfiles()).toEqual([]);
    expect(currentProfileId()).toBeNull();
    expect(window.location.pathname).toBe("/login");

    await fillConnection();
    expect(storedProfiles()).toEqual([]);
    await page.getByTestId(button).click();
    await expect
      .element(page.getByTestId("connection-dialog"))
      .not.toBeInTheDocument();
    await expect.poll(() => storedProfiles().length).toBe(1);
    if (button === "connect-save-unlock") {
      await expect
        .element(page.getByTestId("profile-menu-trigger"))
        .toBeVisible();
      expect(session().auth.getSessionSnapshot()?.status).toBe("unlocked");
    } else {
      await expect
        .element(page.getByTestId("profile-row-Retry server"))
        .toBeVisible();
      expect(currentProfileId()).toBeNull();
      expect(window.location.pathname).toBe("/login");
    }
  },
);

test("explains a rejected API key in the original connection form", async () => {
  // The container answers a plausible but unissued key with the plain-text 401
  // "Unauthorized" of app.go. An expired key takes the identical path, so no separate expiry
  // fixture is needed. Fails when the 401 surfaces the raw "JSON media type" decode error.
  const rejectedKey = `hskey-api-0000000000000000-${"x".repeat(64)}`;
  const fillRejectedConnection = async () => {
    await page.getByTestId("profile-option-new").click();
    await page.getByTestId("connect-profile-name").fill("Rejected");
    await page.getByTestId("connect-server-url").fill(dockerSettings().baseUrl);
    await page.getByTestId("connect-api-key").fill(rejectedKey);
    await page
      .getByTestId("connect-password")
      .fill(profilePassword("Rejected"));
    await page
      .getByTestId("connect-password-confirm")
      .fill(profilePassword("Rejected"));
    await page.getByTestId("connect-submit").click();
    await expect.element(page.getByTestId("connect-error")).toBeVisible();
    await expect
      .element(page.getByTestId("profile-validation-dialog"))
      .not.toBeInTheDocument();
  };
  await renderLogin();

  await fillRejectedConnection();
  await expect
    .poll(() => visibleText("connect-error"))
    .toBe(getProductCopy("en-US").errorRequestFailed);
  expect(visibleText("connect-error")).not.toMatch(/media type/i);
  expect(currentProfileId()).toBeNull();
  expect(
    document.querySelector('[data-testid="profile-option-Rejected"]'),
  ).toBeNull();
  expect(storedProfilesString()).toBeNull();

  await expect.element(page.getByTestId("connect-form")).toBeVisible();
  await page.getByTestId("connect-close").click();
  await page.getByTestId("discard-profile-changes").click();
  await expect
    .poll(() => document.querySelector('[data-testid="connection-dialog"]'))
    .toBeNull();

  await page.getByTestId("locale-select").click();
  await page.getByTestId("locale-option-zh-Hans").click();
  await expect.poll(() => document.documentElement.lang).toBe("zh-Hans");
  await fillRejectedConnection();
  await expect
    .poll(() => visibleText("connect-error"))
    .toBe(getProductCopy("zh-Hans").errorRequestFailed);
  expect(visibleText("connect-error")).not.toMatch(/media type/i);
  expect(currentProfileId()).toBeNull();
  expect(
    document.querySelector('[data-testid="profile-option-Rejected"]'),
  ).toBeNull();
  expect(storedProfilesString()).toBeNull();
});

test("opens the dashboard when Headscale reads its policy from a file without a path", async () => {
  // The file-mode container (policy.mode=file, no path) answers GET /policy with a 500
  // `reading policy from path "":`. Fails when profile validation or the initial snapshot
  // treats that answer as a broken connection: profile-menu-trigger never appears.
  const copy = getProductCopy("en-US");
  await renderLogin();
  await page.getByTestId("profile-option-new").click();
  await expect
    .element(page.getByTestId("connect-password-confirm"))
    .toBeVisible();
  await page.getByTestId("connect-profile-name").fill("Docker file mode");
  await fillConnection("file-mode");
  await page.getByTestId("connect-save-unlock").click();

  await expect.element(page.getByTestId("profile-menu-trigger")).toBeVisible();
  await expect.element(page.getByTestId("app-header")).toBeVisible();
  expect(document.querySelector('[data-testid="session-loading"]')).toBeNull();
  expect(
    document.querySelector('[data-testid="initial-snapshot-error"]'),
  ).toBeNull();

  await selectSectionTab("access");
  await expect
    .element(page.getByTestId("policy-read-only-notice"))
    .toBeVisible();
  await expect
    .poll(() => visibleText("policy-read-only-notice"))
    .toBe(copy.policyFileModeNoPath);
  await expect.element(page.getByTestId("save-policy")).toBeDisabled();
  expect(document.querySelector('[data-testid="teams-section"]')).toBeNull();

  await selectSectionTab("members");
  await expect
    .element(page.getByTestId("members-policy-read-only"))
    .toBeVisible();
  await expect
    .poll(() => visibleText("members-policy-read-only"))
    .toBe(copy.policyFileModeNoPath);
});

test("stores non-remembered profiles in session storage", async () => {
  await renderLogin();

  await page.getByTestId("profile-option-new").click();
  await page.getByTestId("connect-profile-name").fill("Temporary");
  await fillConnection();
  await page.getByTestId("connect-remember").click();
  await page.getByTestId("connect-submit").click();

  // Temporary rows remain encrypted in IndexedDB and are visible only to their owner.
  await expect.poll(() => storedProfilesString()).toContain("Temporary");
  const sessionProfile = storedProfiles().find((p) => p.name === "Temporary");
  expect(sessionProfile).toBeDefined();
  expect(sessionProfile?.scope).toBe("session");
  expect(currentProfileId()).toBeNull();
  await expect.element(page.getByTestId("profile-row-Temporary")).toBeVisible();
});

test("refreshes data on every section change and repeated dialog open", async () => {
  await renderLogin();
  await connectWithDefaults();
  const snapshot = session().snapshot;
  // Counts observe dispatch, not completion. Finish each read before the next action can supersede it.
  async function finishRefresh() {
    await expect.poll(() => snapshot.isRefreshing).toBe(false);
    expect(snapshot.getSnapshot().refreshErrors).toEqual({});
    expect(snapshot.getSnapshot().segmentStatus).toEqual({
      identity: "ready",
      fabric: "ready",
      policy: "ready",
    });
  }
  await finishRefresh();
  await commands.clearHeadscaleOperationCalls();
  await commands.interceptHeadscaleRequest("GET", "^/api/v1/node$");
  try {
    await selectSectionTab("devices");
    await expect
      .poll(async () => await operationCount("node.list"))
      .toBeGreaterThan(0);
    await expectHeadscaleGate();
    // A real dispatched read can still be held: its count must not stand in for fresh data.
    expect(snapshot.isRefreshing).toBe(true);
    expect(snapshot.getSnapshot().segmentStatus.fabric).toBe("loading");
  } finally {
    await commands.releaseHeadscaleRequest();
  }
  await finishRefresh();
  const afterDevices = await operationCount("node.list");
  await page.getByTestId("refresh-machines").click();
  await expect
    .poll(async () => await operationCount("node.list"))
    .toBeGreaterThan(afterDevices);
  await finishRefresh();
  const afterMachineRefresh = await operationCount("node.list");

  await selectSectionTab("members");
  await expect
    .poll(async () => await operationCount("node.list"))
    .toBeGreaterThan(afterMachineRefresh);
  await finishRefresh();
  const afterMembers = await operationCount("node.list");
  const beforeUserRefresh = await operationCount("user.list");
  await page.getByTestId("refresh-users").click();
  await expect
    .poll(async () => await operationCount("user.list"))
    .toBeGreaterThan(beforeUserRefresh);
  await finishRefresh();

  await page.getByTestId("member-detail-link-alice").click();
  await expect.element(page.getByTestId("user-detail-dialog")).toBeVisible();
  await expect
    .poll(async () => await operationCount("node.list"))
    .toBeGreaterThan(afterMembers);
  await finishRefresh();
  const afterFirstUserDialog = await operationCount("node.list");
  await closeLayerWithEscape("user-detail-dialog");

  await page.getByTestId("member-detail-link-alice").click();
  await expect.element(page.getByTestId("user-detail-dialog")).toBeVisible();
  await expect
    .poll(async () => await operationCount("node.list"))
    .toBeGreaterThan(afterFirstUserDialog);
  await finishRefresh();
  const afterSecondUserDialog = await operationCount("node.list");
  await closeLayerWithEscape("user-detail-dialog");

  await selectSectionTab("invites");
  await expect
    .poll(async () => await operationCount("node.list"))
    .toBeGreaterThan(afterSecondUserDialog);
  await finishRefresh();
  const afterInvites = await operationCount("node.list");
  const beforeInviteRefresh = await operationCount("preauthkey.list");
  await page.getByTestId("refresh-auth-keys").click();
  await expect
    .poll(async () => await operationCount("preauthkey.list"))
    .toBeGreaterThan(beforeInviteRefresh);
  await finishRefresh();

  const usersBeforeFirstInviteDialog = await operationCount("user.list");
  await page.getByTestId("open-create-invite").click();
  await expect.element(page.getByTestId("invite-create-dialog")).toBeVisible();
  // The invite dialog refreshes the identity segment, which includes users and keys, not nodes.
  await expect
    .poll(async () => await operationCount("user.list"))
    .toBeGreaterThan(usersBeforeFirstInviteDialog);
  await finishRefresh();
  expect(await operationCount("node.list")).toBe(afterInvites);
  const afterFirstInviteDialog = await operationCount("user.list");
  await page.getByTestId("cancel-create-invite").click();
  await expect
    .element(page.getByTestId("invite-create-dialog"))
    .not.toBeInTheDocument();

  await page.getByTestId("open-create-invite").click();
  await expect.element(page.getByTestId("invite-create-dialog")).toBeVisible();
  await expect
    .poll(async () => await operationCount("user.list"))
    .toBeGreaterThan(afterFirstInviteDialog);
  await finishRefresh();
  const nodesBeforeRoutes = await operationCount("node.list");
  await page.getByTestId("cancel-create-invite").click();
  await expect
    .element(page.getByTestId("invite-create-dialog"))
    .not.toBeInTheDocument();

  await selectSectionTab("routes");
  await expect
    .poll(async () => await operationCount("node.list"))
    .toBeGreaterThan(nodesBeforeRoutes);
  await finishRefresh();
  const afterRoutes = await operationCount("node.list");
  await page.getByTestId("refresh-routes").click();
  await expect
    .poll(async () => await operationCount("node.list"))
    .toBeGreaterThan(afterRoutes);
  await finishRefresh();
});

test("supports language and theme selectors before login", async () => {
  await renderLogin();

  await expect
    .element(page.getByTestId("github-repository-link"))
    .toHaveAttribute("href", "https://github.com/MunMunMiao/headscale-ui");
  expectPointerCursor("github-repository-link");
  preventNextClickDefault("github-repository-link");
  await page.getByTestId("github-repository-link").click();

  await page.getByTestId("profile-option-new").click();
  expectConnectionFormGridLayout();
  const connectionHeader = document.querySelector<HTMLElement>(
    '[data-testid="connection-dialog"] [data-slot="dialog-header"]',
  );
  expect(connectionHeader?.querySelector("svg")).toBeNull();
  expect(
    document.querySelector(
      '[data-testid="connection-dialog"] [data-slot="dialog-close"]',
    ),
  ).toBeNull();
  expectDialogHasNoInternalScrollbar("connection-dialog");
  expect(document.querySelector('[data-testid="save-profile"]')).toBeNull();
  await expect
    .element(page.getByTestId("connect-submit"))
    .toHaveTextContent("Save profile");
  await expect
    .element(page.getByTestId("connect-close"))
    .toHaveTextContent("Close");
  await expect
    .element(page.getByTestId("api-key-guide"))
    .not.toBeInTheDocument();
  await page
    .getByRole("button", { name: t("apiKeyGuideTitle"), exact: true })
    .click();
  await expect
    .element(page.getByTestId("api-key-guide"))
    .toMatchTextContent("headscale apikeys create --expiration 90d");
  await expect
    .element(page.getByTestId("api-key-docs-link"))
    .toHaveAttribute("href", "https://docs.headscale.org/ref/remote-cli/");
  await page.getByTestId("api-key-command-copy").click();
  await closeLayerWithEscape("api-key-guide");
  await closeLayerWithEscape("connection-dialog");

  await page.getByTestId("locale-select").click();
  await page.getByTestId("locale-option-zh-Hans").click();
  await expect.poll(() => document.documentElement.lang).toBe("zh-Hans");
  await page.getByTestId("profile-option-new").click();
  await expect
    .element(page.getByTestId("connect-submit"))
    .toHaveTextContent("保存配置");
  await closeLayerWithEscape("connection-dialog");

  await page.getByTestId("theme-select").click();
  await expect
    .element(page.getByTestId("theme-option-dark"))
    .toHaveAttribute("role", "menuitemradio");
  await page.getByTestId("theme-option-dark").click();
  await expect
    .poll(() => document.documentElement.classList.contains("dark"))
    .toBe(true);
  await expect.poll(() => readIdbSetting("theme")).toBe("dark");

  await page.getByTestId("theme-select").click();
  await expect
    .element(page.getByTestId("theme-option-dark"))
    .toHaveAttribute("aria-checked", "true");
  await page.getByTestId("theme-option-auto").click();
  await expect.poll(() => readIdbSetting("theme")).toBe("auto");
});

test("requires explicit confirmation before closing a dirty add profile dialog", async () => {
  await renderLogin();

  await page.getByTestId("profile-option-new").click();
  await expect.element(page.getByTestId("connection-dialog")).toBeVisible();
  expect(
    document.querySelector(
      '[data-testid="connection-dialog"] [data-slot="dialog-close"]',
    ),
  ).toBeNull();

  await clickDialogOverlay();
  await expect.element(page.getByTestId("connection-dialog")).toBeVisible();

  await page.getByTestId("connect-close").click();
  await expect
    .poll(() => document.querySelector('[data-testid="connection-dialog"]'))
    .toBeNull();

  await page.getByTestId("profile-option-new").click();
  await page.getByTestId("connect-profile-name").fill("Dirty profile");
  await clickDialogOverlay();
  await expect.element(page.getByTestId("connection-dialog")).toBeVisible();
  expect(
    document.querySelector('[data-testid="discard-profile-changes-dialog"]'),
  ).toBeNull();

  await page.getByTestId("connect-close").click();
  await expect
    .element(page.getByTestId("discard-profile-changes-dialog"))
    .toBeVisible();
  await page.getByTestId("keep-editing-profile").click();
  await expect.element(page.getByTestId("connection-dialog")).toBeVisible();

  await page.getByTestId("connect-close").click();
  await page.getByTestId("discard-profile-changes").click();
  await expect
    .poll(() => document.querySelector('[data-testid="connection-dialog"]'))
    .toBeNull();
});

test("keeps the add profile dialog inside a short mobile viewport", async () => {
  await page.viewport(390, 640);
  await renderLogin();

  await page.getByTestId("profile-option-new").click();
  await expect.element(page.getByTestId("connection-dialog")).toBeVisible();
  expectDialogUsableInViewport("connection-dialog");
  expectTestIdFitsViewport("connect-api-key");
  expectTestIdAboveTestId("connect-api-key", "connect-footer");
  expectTestIdFitsViewport("connect-submit");
  expectNoHorizontalOverflow();
});

test("keeps core dialogs usable on a short mobile viewport", async () => {
  await page.viewport(360, 568);
  await renderLogin();

  await page.getByTestId("profile-option-new").click();
  await expect.element(page.getByTestId("connection-dialog")).toBeVisible();
  expectDialogUsableInViewport("connection-dialog");
  expectTestIdFitsViewport("connect-api-key");
  expectTestIdAboveTestId("connect-api-key", "connect-footer");
  expectTestIdFitsViewport("connect-submit");
  await captureResponsiveScreenshot("add-server-360x568");
  await closeLayerWithEscape("connection-dialog");

  await connectWithDefaults();

  await selectSectionTab("members");
  await openCreateMemberDialog();
  expectDialogUsableInViewport("member-create-dialog");
  await closeLayerWithEscape("member-create-dialog");

  await selectSectionTab("invites");
  await page.getByTestId("open-create-invite").click();
  await expect.element(page.getByTestId("invite-create-dialog")).toBeVisible();
  expectDialogUsableInViewport("invite-create-dialog");
  await page.getByTestId("invite-expiration").click();
  expectLayerFitsViewport('[data-slot="popover-content"]');
  await captureResponsiveScreenshot("auth-key-date-picker-360x568");
  await userEvent.keyboard("{Escape}");
  await closeLayerWithEscape("invite-create-dialog");

  await selectSectionTab("devices");
  await page.getByTestId("add-device-toggle").click();
  await expect.element(page.getByTestId("add-device-dialog")).toBeVisible();
  expectDialogUsableInViewport("add-device-dialog");
  await captureResponsiveScreenshot("add-device-360x568");
  await closeLayerWithEscape("add-device-dialog");

  await selectSectionTab("access");
  await page.getByTestId("new-team").click();
  await expect.element(page.getByTestId("team-detail-dialog")).toBeVisible();
  expectDialogUsableInViewport("team-detail-dialog");
  await captureResponsiveScreenshot("team-detail-360x568");
  await closeLayerWithEscape("team-detail-dialog");

  await page.getByTestId("new-device-label").click();
  await expect.element(page.getByTestId("tag-detail-dialog")).toBeVisible();
  expectDialogUsableInViewport("tag-detail-dialog");
  await closeLayerWithEscape("tag-detail-dialog");

  // Force the unsaved-changes AlertDialog onto the 360px viewport — its three
  // stacked buttons (keep editing / discard / save and close) must all fit.
  await page.getByTestId("team-open-group:ops").click();
  await expect.element(page.getByTestId("team-detail-dialog")).toBeVisible();
  const memberToRemove = document.querySelector(
    '[data-testid^="team-member-remove-"]',
  ) as HTMLElement | null;
  expect(memberToRemove).not.toBeNull();
  memberToRemove?.click();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByTestId("unsaved-changes-dialog"))
    .toBeVisible();
  expectDialogUsableInViewport("unsaved-changes-dialog");
  expectTestIdFitsViewport("unsaved-changes-keep-editing");
  expectTestIdFitsViewport("unsaved-changes-discard");
  expectTestIdFitsViewport("unsaved-changes-save");
  await captureResponsiveScreenshot("unsaved-changes-360x568");
  await page.getByTestId("unsaved-changes-discard").click();

  expectNoHorizontalOverflow();
});

test("keeps mobile overview statistics dense", async () => {
  await page.viewport(360, 568);
  await renderLogin();
  await connectWithDefaults();

  await expect.element(page.getByTestId("section-home")).toBeVisible();
  expectOverviewStatsCompactGrid();
  expectNoHorizontalOverflow();
  await captureResponsiveScreenshot("home-overview-360x568");
});

test("uses pointer cursors for buttons, links, menus and tabs", async () => {
  await renderLogin();

  expectPointerCursor("profile-option-new");
  expectVisibleInteractiveElementsUsePointer();
  await page.getByTestId("profile-option-new").click();
  await expect.element(page.getByTestId("connect-form")).toBeVisible();
  await page
    .getByRole("button", { name: t("apiKeyGuideTitle"), exact: true })
    .click();
  await expect.element(page.getByTestId("api-key-guide")).toBeVisible();
  expectPointerCursor("api-key-docs-link");
  expectVisibleInteractiveElementsUsePointer();
  await closeLayerWithEscape("api-key-guide");
  expectPointerCursor("connect-submit");
  expectVisibleInteractiveElementsUsePointer();

  await connectWithDefaults();
  expectPointerCursor("github-repository-link");
  preventNextClickDefault("github-repository-link");
  await page.getByTestId("github-repository-link").click();
  expectPointerCursor("profile-menu-trigger");
  expectPointerCursor("section-devices");
  expectVisibleInteractiveElementsUsePointer();

  await openProfileMenu();
  expectPointerCursor("language-menu-trigger");
  expectVisibleInteractiveElementsUsePointer();
  await clickDomTestId("language-menu-trigger");
  await expect.element(page.getByTestId("locale-option-zh-Hans")).toBeVisible();
  expectPointerCursor("locale-option-zh-Hans");
  expectVisibleInteractiveElementsUsePointer();
  await closeProfileMenu();
});

test("supports consumer-friendly tailnet management flows", async () => {
  await commands.clearHeadscaleOperationCalls();

  await renderLogin();
  await page.getByTestId("profile-option-new").click();
  await expect.element(page.getByTestId("connect-form")).toBeVisible();
  await connectWithDefaults();
  expectAppHeader();
  expectResponsiveTabMenu();

  await page.getByTestId("section-members").click();
  await openCreateMemberDialog();
  await page.getByTestId("member-name").fill("dana");
  await page.getByTestId("member-display").fill("Dana");
  await page.getByTestId("member-email").fill("dana@example.test");
  await page.getByTestId("create-member").click();
  await expect.element(page.getByTestId("member-dana")).toBeVisible();

  await page.getByTestId("section-invites").click();
  await page.getByTestId("open-create-invite").click();
  await addKeyTag("invite-tags", "tag:workstation");
  await page.getByTestId("create-invite").click();
  await expect.element(page.getByTestId("created-invite")).toBeVisible();

  await page.getByTestId("section-devices").click();
  await expectMachinesWorkbench();
  await page.getByTestId("device-owner-link-1").click();
  await expect
    .element(page.getByTestId("user-detail-dialog"))
    .toMatchTextContent("Alice Ops");
  await closeLayerWithEscape("user-detail-dialog");
  await page.getByTestId("device-detail-link-1").click();
  await expect.element(page.getByTestId("device-detail-dialog")).toBeVisible();
  await expect
    .element(page.getByTestId("device-detail-status-1"))
    .toHaveTextContent("Online");
  await page.getByTestId("device-detail-owner-1").click();
  await expect.element(page.getByTestId("user-detail-dialog")).toBeVisible();
  await expect
    .element(page.getByTestId("user-detail-device-1"))
    .toMatchTextContent("alice-laptop");
  await page.getByTestId("user-detail-device-1").click();
  await expect
    .element(page.getByTestId("device-detail-dialog"))
    .toMatchTextContent("alice-laptop");
  await closeLayerWithEscape("device-detail-dialog");
  await page.getByTestId("device-detail-link-2").click();
  await expect
    .element(page.getByTestId("device-detail-dialog"))
    .toMatchTextContent("edge-router");
  await closeLayerWithEscape("device-detail-dialog");
  await page.getByTestId("section-devices").click();
  await page.getByTestId("machine-filter").selectOptions("routes");
  await page.getByTestId("device-pending-routes-2").click();
  await expect.element(page.getByTestId("route-node-2")).toBeVisible();
  expect(window.location.pathname.endsWith("/routes")).toBe(true);
  await page.getByTestId("section-devices").click();
  await page.getByTestId("machine-filter").selectOptions("all");
  expect(
    document.querySelector('[data-testid="machine-actions-1"]'),
  ).toBeNull();
  await clickVisibleDomTestId("machine-actions-trigger-1");
  await expect
    .element(page.getByTestId("machine-actions-menu-1"))
    .toBeVisible();
  await clickVisibleDomTestId("view-node-details-action-1");
  await expect
    .element(page.getByTestId("device-detail-dialog"))
    .toMatchTextContent("alice-laptop");
  await closeLayerWithEscape("device-detail-dialog");
  await clickVisibleDomTestId("machine-actions-trigger-2");
  await expect
    .element(page.getByTestId("machine-actions-menu-2"))
    .toBeVisible();
  await clickVisibleDomTestId("view-node-routes-action-2");
  await expect.element(page.getByTestId("route-node-2")).toBeVisible();
  expect(window.location.pathname.endsWith("/routes")).toBe(true);
});

test("supports consumer-friendly machine rename and exact tag updates", async () => {
  await renderLogin();
  await connectWithDefaults();
  await page.getByTestId("section-devices").click();
  await clickVisibleDomTestId("machine-actions-trigger-1");
  await expect
    .element(page.getByTestId("machine-actions-menu-1"))
    .toBeVisible();
  expect(document.querySelector('[data-testid="rename-node-1"]')).toBeNull();
  await clickVisibleDomTestId("rename-node-action-1");
  await expect.element(page.getByTestId("rename-node-dialog")).toBeVisible();
  await page.getByTestId("rename-node-cancel").click();
  await clickVisibleDomTestId("machine-actions-trigger-1");
  await clickVisibleDomTestId("rename-node-action-1");
  await expect.element(page.getByTestId("rename-node-dialog")).toBeVisible();
  await page.getByTestId("rename-node-dialog-input").fill("alice-main");
  await page.getByTestId("rename-node-confirm").click();
  await expect
    .element(page.getByTestId("device-1"))
    .toMatchTextContent("alice-main");
  await clickVisibleDomTestId("machine-actions-trigger-1");
  await expect
    .element(page.getByTestId("machine-actions-menu-1"))
    .toBeVisible();
  await clickVisibleDomTestId("edit-node-tags-action-1");
  await expect.element(page.getByTestId("node-tags-dialog")).toBeVisible();
  await selectDeclaredDeviceTag("tag:workstation");
  await selectDeclaredDeviceTag("tag:laptop");
  await page.getByTestId("node-tags-cancel").click();
  // Another administrator changes the tags while the dialog is closed: the next open shows the server's tags,
  // not the cancelled selection.
  await request(adopted().write, {
    endpoint: "setTags",
    input: { nodeId: "1", tags: ["tag:workstation"] },
  });
  await clickVisibleDomTestId("machine-actions-trigger-1");
  await clickVisibleDomTestId("edit-node-tags-action-1");
  await expect.element(page.getByTestId("node-tags-dialog")).toBeVisible();
  await expect
    .poll(
      () =>
        document.querySelector('[data-testid="node-tags-selected"]')
          ?.textContent ?? "",
    )
    .toContain("tag:workstation");
  expect(
    document.querySelector('[data-testid="node-tags-selected"]')?.textContent ??
      "",
  ).not.toContain("tag:laptop");
  await expect
    .element(page.getByTestId("node-tags-remove-tag:workstation"))
    .toBeEnabled();
  await page.getByTestId("node-tags-remove-tag:workstation").click();
  await selectDeclaredDeviceTag("tag:laptop");
  await expectTagSelection("node-tags", ["tag:laptop"]);
  await page.getByTestId("node-tags-confirm").click();
  await expect.element(page.getByTestId("node-tags-review")).toBeVisible();
  await expect.element(page.getByTestId("node-tags-apply")).toBeEnabled();
  await page.getByTestId("node-tags-apply").click();
  await expect
    .poll(async () =>
      (await commands.headscaleOperationCalls())?.some(
        (call) => call.id === "node.setTags",
      ),
    )
    .toBe(true);
  await waitForActionFinished("node-tags");
  await expect.element(page.getByTestId("node-tags-result")).toBeVisible();
  await page.getByTestId("node-tags-cancel").click();
  await expect
    .element(page.getByTestId("node-tags-dialog"))
    .not.toBeInTheDocument();
  await expect
    .poll(
      async () =>
        normalizeHeadscaleNode(
          (
            await request(adopted().read, {
              endpoint: "getNode",
              input: { nodeId: "1" },
            })
          ).node,
        ).tags,
    )
    .toEqual(["tag:laptop"]);
});

test("supports consumer-friendly route approval and revocation", async () => {
  await renderLogin();
  await connectWithDefaults();
  await commands.clearHeadscaleOperationCalls();
  await page.getByTestId("section-routes").click();
  await expect.element(page.getByTestId("route-node-3")).toBeVisible();
  await page.getByTestId("route-user-link-3").click();
  await expect.element(page.getByTestId("member-charlie")).toBeVisible();
  await page.getByTestId("section-routes").click();
  await expect
    .poll(() =>
      Array.from(
        document.querySelectorAll('[data-testid^="route-available-2-"]'),
        (route) => route.textContent?.trim(),
      ).sort(),
    )
    .toEqual(["0.0.0.0/0", "10.42.0.0/16", "::/0"]);
  await expect
    .element(page.getByTestId("route-approved-2-0"))
    .toHaveTextContent("10.42.0.0/16");
  expect(
    document.querySelector('[data-testid="pending-routes-list-2"]'),
  ).toBeTruthy();
  await expect
    .element(page.getByTestId("pending-route-2-0"))
    .toMatchTextContent("0.0.0.0/0");
  await expect
    .element(page.getByTestId("pending-route-value-2-0"))
    .toHaveTextContent("0.0.0.0/0");
  await page.getByTestId("approve-route-2-0").click();
  await expect.element(page.getByTestId("approve-route-dialog")).toBeVisible();
  await expect
    .element(page.getByTestId("approve-route-target"))
    .toHaveTextContent("0.0.0.0/0");
  expect(
    (await commands.headscaleOperationCalls())?.some(
      (call) => call.id === "node.setApprovedRoutes",
    ),
  ).toBe(false);
  await page.getByTestId("approve-route-cancel").click();
  expect(
    (await commands.headscaleOperationCalls())?.some(
      (call) => call.id === "node.setApprovedRoutes",
    ),
  ).toBe(false);
  await page.getByTestId("approve-route-2-0").click();
  await expect.element(page.getByTestId("approve-route-dialog")).toBeVisible();
  await page.getByTestId("approve-route-confirm").click();
  await expect
    .poll(async () =>
      (await commands.headscaleOperationCalls())?.some(
        (call) => call.id === "node.setApprovedRoutes",
      ),
    )
    .toBe(true);
  const routeApprovalCall = (await commands.headscaleOperationCalls())?.find(
    (call) => call.id === "node.setApprovedRoutes",
  );
  const routeApprovalPayload = routeApprovalCall?.payload as {
    routes?: string[];
  };
  expect(routeApprovalCall?.url).toBe("/api/v1/node/2/approve_routes");
  expect(routeApprovalPayload.routes).toEqual(["10.42.0.0/16", "0.0.0.0/0"]);
  expect(routeApprovalPayload.routes).not.toContain("::/0");
  await waitForActionFinished("approve-route");
  await expect
    .element(page.getByTestId("approve-route-dialog"))
    .not.toBeInTheDocument();
  expect(
    normalizeHeadscaleNode(
      (
        await request(adopted().read, {
          endpoint: "getNode",
          input: { nodeId: "2" },
        })
      ).node,
    ).approvedRoutes.sort(),
  ).toEqual(["0.0.0.0/0", "10.42.0.0/16", "::/0"]);

  // Exit routes are revoked as a pair: the dialog names both prefixes and the write removes both.
  // The auto-approved 10.42.0.0/16 is never revoked here.
  await page
    .getByTestId(`revoke-route-2-${approvedRouteIndex("2", "0.0.0.0/0")}`)
    .click();
  await expect.element(page.getByTestId("revoke-route-dialog")).toBeVisible();
  await expect.element(page.getByTestId("revoke-route-target-1")).toBeVisible();
  expect(
    document.querySelector('[data-testid="revoke-route-target-2"]'),
  ).toBeNull();
  expect(
    [0, 1].map((index) => visibleText(`revoke-route-target-${index}`)).sort(),
  ).toEqual(["0.0.0.0/0", "::/0"]);
  await page.getByTestId("revoke-route-confirm").click();
  await waitForActionFinished("revoke-route");
  await expect
    .element(page.getByTestId("revoke-route-dialog"))
    .not.toBeInTheDocument();
  await expect.poll(() => approvedRoutesOf("2")).toEqual(["10.42.0.0/16"]);
  await expect
    .poll(() =>
      Array.from(
        document.querySelectorAll('[data-testid^="pending-route-value-2-"]'),
        (route) => route.textContent?.trim(),
      ).sort(),
    )
    .toEqual(["0.0.0.0/0", "::/0"]);

  // An approved route the node no longer advertises can still be revoked, down to the empty set.
  await request(adopted().write, {
    endpoint: "setApprovedRoutes",
    input: { nodeId: "3", routes: ["192.168.99.0/24"] },
  });
  await page.getByTestId("refresh-routes").click();
  await expect
    .poll(() =>
      document
        .querySelector('[data-testid="route-approved-3-0"]')
        ?.textContent?.trim(),
    )
    .toBe("192.168.99.0/24");
  await page.getByTestId("revoke-route-3-0").click();
  await expect.element(page.getByTestId("revoke-route-dialog")).toBeVisible();
  await page.getByTestId("revoke-route-confirm").click();
  await waitForActionFinished("revoke-route");
  await expect.poll(() => approvedRoutesOf("3")).toEqual([]);

  expect(document.body.textContent).not.toContain("/api/v1/node");
  expect(document.querySelector('[data-testid="run-operation"]')).toBeNull();
}, 30000);

test("covers dashboard refresh, machine filters, exports and machine lifecycle actions", async () => {
  await renderLogin();
  await connectWithDefaults();
  await commands.clearHeadscaleOperationCalls();

  await page.getByTestId("refresh-data").click();
  await expect
    .poll(async () =>
      (await commands.headscaleOperationCalls())?.some(
        (call) => call.id === "health.check",
      ),
    )
    .toBe(true);
  expect(
    document.querySelector('[data-testid="header-server-signal"]'),
  ).toBeNull();
  expect(
    document.querySelector('[data-testid="overview-health-metrics"]'),
  ).toBeNull();
  expect(
    document.querySelector('[data-testid="overview-server-health"]'),
  ).toBeNull();
  expect(
    document.querySelector('[data-testid="overview-server-reachability"]'),
  ).toBeNull();
  expect(
    document.querySelector('[data-testid="overview-database-health"]'),
  ).toBeNull();
  await expect
    .poll(
      () =>
        document.querySelector<HTMLButtonElement>(
          '[data-testid="refresh-data"]',
        )?.disabled ?? true,
    )
    .toBe(false);
  await commands.clearHeadscaleOperationCalls();
  await new Promise((resolve) => window.setTimeout(resolve, 5200));
  expect(
    (await commands.headscaleOperationCalls())?.filter(
      (call) => call.id === "health.check",
    ).length ?? 0,
  ).toBe(0);

  await page.getByTestId("section-devices").click();
  await expectMachinesWorkbench();
  await page.getByTestId("device-search").fill("edge");
  expect(document.querySelector('[data-testid="device-1"]')).toBeNull();
  await page.getByTestId("machine-filter").selectOptions("routes");
  await expect.element(page.getByTestId("device-2")).toBeVisible();
  await page.getByTestId("clear-machine-filters").click();
  await expectMachinesWorkbench();

  // The status filters partition the table exactly like the status badges do.
  const listedDevices = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="device-"]'),
    )
      .map((element) => element.dataset.testid ?? "")
      .filter((testId) => /^device-\d+$/.test(testId))
      .sort();
  let filteredDeviceCount = 0;
  for (const [filter, expected] of [
    ["online", ["device-1"]],
    ["offline", ["device-2"]],
    ["expired", ["device-3"]],
  ] as const) {
    await page.getByTestId("machine-filter").selectOptions(filter);
    await expect.poll(listedDevices).toEqual(expected);
    filteredDeviceCount += listedDevices().length;
  }
  await page.getByTestId("machine-filter").selectOptions("all");
  await expect
    .poll(listedDevices)
    .toEqual(["device-1", "device-2", "device-3"]);
  expect(filteredDeviceCount).toBe(3);

  const downloadStub = stubDownloads();
  try {
    await page.getByTestId("export-machines").click();
    expect(downloadStub.downloads).toContain("headscale-machines.csv");
    expect(downloadStub.objectTypes).toContain("text/csv;charset=utf-8");
  } finally {
    downloadStub.restore();
  }

  const phoneExpiry = async () =>
    normalizeHeadscaleNode(
      (
        await request(adopted().read, {
          endpoint: "getNode",
          input: { nodeId: "3" },
        })
      ).node,
    ).expiry;
  // The seeded phone is already expired, so its menu offers only "Disable expiry"; disabling first
  // makes it expirable again for the expire flow below.
  const expiredMenu = await (async () => {
    await clickVisibleDomTestId("machine-actions-trigger-3");
    await expect
      .element(page.getByTestId("machine-actions-menu-3"))
      .toBeVisible();
    const offersExpire =
      document.querySelector('[data-testid="expire-node-action-3"]') !== null;
    await userEvent.keyboard("{Escape}");
    return offersExpire;
  })();
  expect(expiredMenu).toBe(false);
  // Disabling the expiry is a separate dialog and a separate write.
  const deviceCopy = getProductCopy("en-US");
  const expiresBeforeDisable = await operationCount("node.expire");
  await clickVisibleDomTestId("machine-actions-trigger-3");
  await clickVisibleDomTestId("disable-expiry-node-action-3");
  await expect.element(page.getByTestId("expire-node-dialog")).toBeVisible();
  await expect
    .element(page.getByTestId("expire-node-dialog"))
    .toMatchTextContent(deviceCopy.disableExpiryTitle);
  await page.getByTestId("expire-node-cancel").click();
  await expect
    .element(page.getByTestId("expire-node-dialog"))
    .not.toBeInTheDocument();
  expect(await operationCount("node.expire")).toBe(expiresBeforeDisable);
  await clickVisibleDomTestId("machine-actions-trigger-3");
  await clickVisibleDomTestId("disable-expiry-node-action-3");
  await expect.element(page.getByTestId("expire-node-dialog")).toBeVisible();
  await page.getByTestId("expire-node-confirm").click();
  await expect
    .poll(() => operationCount("node.expire"))
    .toBe(expiresBeforeDisable + 1);
  await waitForActionFinished("expire-node");
  await expect
    .element(page.getByTestId("expire-node-dialog"))
    .not.toBeInTheDocument();
  expect(await phoneExpiry()).toBeUndefined();
  await expect
    .element(page.getByTestId("device-3"))
    .toMatchTextContent(`${deviceCopy.expires}: ${deviceCopy.never}`);
  await expect.poll(() => visibleText("device-status-3")).toBe("Offline");
  await page.getByTestId("machine-filter").selectOptions("expired");
  await expect.poll(listedDevices).toEqual([]);
  await page.getByTestId("machine-filter").selectOptions("all");
  await clickVisibleDomTestId("machine-actions-trigger-3");
  await expect
    .element(page.getByTestId("machine-actions-menu-3"))
    .toBeVisible();
  const expireCallsBefore =
    (await commands.headscaleOperationCalls())?.filter(
      (call) => call.id === "node.expire",
    ).length ?? 0;
  await clickVisibleDomTestId("expire-node-action-3");
  await expect.element(page.getByTestId("expire-node-dialog")).toBeVisible();
  expect(
    (await commands.headscaleOperationCalls())?.filter(
      (call) => call.id === "node.expire",
    ).length,
  ).toBe(expireCallsBefore);
  await page.getByTestId("expire-node-cancel").click();
  expect(
    (await commands.headscaleOperationCalls())?.filter(
      (call) => call.id === "node.expire",
    ).length,
  ).toBe(expireCallsBefore);
  await clickVisibleDomTestId("machine-actions-trigger-3");
  await clickVisibleDomTestId("expire-node-action-3");
  await expect.element(page.getByTestId("expire-node-dialog")).toBeVisible();
  const expireStartedAt = Date.now();
  await page.getByTestId("expire-node-confirm").click();
  await expect
    .poll(async () =>
      (await commands.headscaleOperationCalls())?.some(
        (call) => call.id === "node.expire",
      ),
    )
    .toBe(true);
  await waitForActionFinished("expire-node");
  await expect
    .element(page.getByTestId("expire-node-dialog"))
    .not.toBeInTheDocument();
  // The request carries no client-chosen expiry (the recorder keeps only the path, so the server stamp is the
  // evidence): Headscale stamps "now", which is also what the badge and the Expired filter must report.
  await expect
    .poll(async () => {
      const expiry = Date.parse((await phoneExpiry()) ?? "");
      return expiry >= expireStartedAt - 5_000 && expiry <= Date.now() + 5_000;
    })
    .toBe(true);
  await expect.poll(() => visibleText("device-status-3")).toBe("Expired");
  await page.getByTestId("machine-filter").selectOptions("expired");
  await expect.poll(listedDevices).toEqual(["device-3"]);
  await page.getByTestId("machine-filter").selectOptions("all");

  await clickVisibleDomTestId("machine-actions-trigger-3");
  await expect
    .element(page.getByTestId("machine-actions-menu-3"))
    .toBeVisible();
  const deleteCallsBefore =
    (await commands.headscaleOperationCalls())?.filter(
      (call) => call.id === "node.delete",
    ).length ?? 0;
  await clickVisibleDomTestId("remove-node-action-3");
  await expect.element(page.getByTestId("remove-node-dialog")).toBeVisible();
  expect(
    (await commands.headscaleOperationCalls())?.filter(
      (call) => call.id === "node.delete",
    ).length,
  ).toBe(deleteCallsBefore);
  await page.getByTestId("remove-node-cancel").click();
  expect(
    (await commands.headscaleOperationCalls())?.filter(
      (call) => call.id === "node.delete",
    ).length,
  ).toBe(deleteCallsBefore);
  await clickVisibleDomTestId("machine-actions-trigger-3");
  await clickVisibleDomTestId("remove-node-action-3");
  await expect.element(page.getByTestId("remove-node-dialog")).toBeVisible();
  await page.getByTestId("remove-node-confirm").click();
  await expect
    .poll(async () =>
      (await commands.headscaleOperationCalls())?.some(
        (call) => call.id === "node.delete",
      ),
    )
    .toBe(true);
  await waitForActionFinished("remove-node");
  await expect
    .element(page.getByTestId("remove-node-dialog"))
    .not.toBeInTheDocument();
  await expect.element(page.getByTestId("device-3")).not.toBeInTheDocument();
  expect(
    (
      (await request(adopted().read, { endpoint: "listNodes", input: {} }))
        .nodes ?? []
    ).some((node) => node.id === "3"),
  ).toBe(false);
});

test("refuses to delete a member who still owns machines before any write", async () => {
  await renderLogin();
  await connectWithDefaults();
  const client = adopted();

  await page.getByTestId("section-members").click();
  await expect.element(page.getByTestId("user-table")).toBeVisible();
  await clickVisibleDomTestId("member-actions-trigger-alice");
  await clickVisibleDomTestId("delete-member-alice");
  await expect.element(page.getByTestId("delete-member-dialog")).toBeVisible();
  await expect
    .element(page.getByTestId("delete-member-policy-impact"))
    .toBeVisible();
  // Guards against a vacuous pass: cleanup is on by default and alice is referenced by the policy.
  await expect
    .element(page.getByTestId("delete-member-cleanup-policy"))
    .toHaveAttribute("aria-checked", "true");
  expect(
    document.querySelectorAll('[data-testid="delete-member-policy-impact"] li')
      .length,
  ).toBeGreaterThan(0);

  const policyBefore = (await request(client.read, { endpoint: "getPolicy" }))
    .policy;
  const policySetsBefore = await operationCount("policy.set");
  const userDeletesBefore = await operationCount("user.delete");
  // Headscale refuses to delete a user that owns nodes ("user not empty"), so the dialog names the
  // machines and keeps the confirmation disabled instead of sending a request that must fail.
  await expect.element(page.getByTestId("delete-member-devices")).toBeVisible();
  await expect
    .element(page.getByTestId("confirm-delete-member"))
    .toBeDisabled();
  await expect.element(page.getByTestId("member-alice")).toBeVisible();
  expect(await operationCount("user.delete")).toBe(userDeletesBefore);
  expect(await operationCount("policy.set")).toBe(policySetsBefore);
  expect((await request(client.read, { endpoint: "getPolicy" })).policy).toBe(
    policyBefore,
  );
});

test("deletes a node-less referenced member before cleaning its policy references", async () => {
  // Proves on the server what delete-first relies on: Headscale accepts DELETE of a user that
  // the policy still references, and accepts the follow-up PUT that removes the references.
  await renderLogin();
  await connectWithDefaults();
  const client = adopted();

  await request(client.write, {
    endpoint: "createUser",
    input: { name: "ghost" },
  });
  const current = JSON.parse(
    (await request(client.read, { endpoint: "getPolicy" })).policy,
  );
  await request(client.write, {
    endpoint: "setPolicy",
    input: {
      policy: JSON.stringify({
        ...current,
        groups: { ...current.groups, "group:ghosts": ["ghost@"] },
        tagOwners: { ...current.tagOwners, "tag:ghost": ["ghost@"] },
        // Not only groups and tag owners: the strict rewrite must also reach acls and ssh.
        acls: [
          ...(current.acls ?? []),
          { action: "accept", src: ["ghost@"], dst: ["tag:server:22"] },
        ],
        ssh: [
          ...(current.ssh ?? []),
          {
            action: "accept",
            src: ["ghost@"],
            dst: ["tag:server"],
            users: ["root"],
          },
        ],
      }),
    },
  });
  await session().snapshot.refreshSegments(["identity", "policy"]);
  await commands.clearHeadscaleOperationCalls();

  await page.getByTestId("section-members").click();
  await expect.element(page.getByTestId("member-ghost")).toBeVisible();
  await clickVisibleDomTestId("member-actions-trigger-ghost");
  await clickVisibleDomTestId("delete-member-ghost");
  await expect.element(page.getByTestId("delete-member-dialog")).toBeVisible();
  const cleanupOption = page.getByTestId("delete-member-cleanup-policy");
  await expect.element(cleanupOption).toHaveAttribute("aria-checked", "true");
  await clickVisibleDomTestId("delete-member-cleanup-policy");
  await expect.element(cleanupOption).toHaveAttribute("aria-checked", "false");
  await clickVisibleDomTestId("delete-member-cleanup-policy");
  await expect.element(cleanupOption).toHaveAttribute("aria-checked", "true");
  expect(
    document.querySelectorAll('[data-testid="delete-member-policy-impact"] li')
      .length,
  ).toBeGreaterThan(0);
  expect(
    document.querySelectorAll('[data-testid="delete-member-policy-section"]')
      .length,
  ).toBeGreaterThan(0);
  await page.getByTestId("confirm-delete-member").click();
  await confirmPolicyPublication();
  // The dialog closes only after the delete and the cleanup PUT both succeeded.
  await expect
    .poll(
      () => document.querySelector('[data-testid="delete-member-dialog"]'),
      {
        timeout: 30_000,
      },
    )
    .toBeNull();
  await expect
    .element(page.getByTestId("member-ghost"))
    .not.toBeInTheDocument();

  const calls = (await commands.headscaleOperationCalls()) ?? [];
  const lastIndexOf = (id: OperationId) =>
    calls.map((call) => call.id).lastIndexOf(id);
  expect(lastIndexOf("user.delete")).toBeGreaterThanOrEqual(0);
  expect(lastIndexOf("user.delete")).toBeLessThan(lastIndexOf("policy.set"));

  const users =
    (await request(client.read, { endpoint: "listUsers", input: {} })).users ??
    [];
  expect(users.some((user) => user.name === "ghost")).toBe(false);
  const persisted = (await request(client.read, { endpoint: "getPolicy" }))
    .policy;
  expect(persisted).not.toContain("ghost@");
  const saved = JSON.parse(persisted);
  expect(saved.groups["group:ops"]).toEqual(["alice@example.com"]);
  expect(saved.tagOwners["tag:server"]).toEqual(["alice@example.com"]);
  // The rules that only mentioned ghost@ are gone; every other rule stays.
  expect(saved.acls ?? []).toHaveLength((current.acls ?? []).length);
  expect(saved.ssh ?? []).toHaveLength((current.ssh ?? []).length);
});

test("renames a referenced member and updates its policy references", async () => {
  // Measures on the server what rename-first relies on: the rename is accepted while the
  // policy still uses the old name, a group listing both names is tolerated, and the one
  // follow-up PUT that retargets the references is accepted.
  await renderLogin();
  await connectWithDefaults();
  const client = adopted();

  await request(client.write, {
    endpoint: "createUser",
    input: { name: "renamer" },
  });
  const current = JSON.parse(
    (await request(client.read, { endpoint: "getPolicy" })).policy,
  );
  await request(client.write, {
    endpoint: "setPolicy",
    input: {
      policy: JSON.stringify({
        ...current,
        groups: {
          ...current.groups,
          "group:renamers": ["renamer@", "renamer-new@"],
        },
        acls: [
          ...(current.acls ?? []),
          { action: "accept", src: ["renamer@"], dst: ["tag:server:22"] },
        ],
      }),
    },
  });
  await session().snapshot.refreshSegments(["identity", "policy"]);
  await commands.clearHeadscaleOperationCalls();

  await page.getByTestId("section-members").click();
  await expect.element(page.getByTestId("member-renamer")).toBeVisible();
  await clickVisibleDomTestId("member-actions-trigger-renamer");
  await clickVisibleDomTestId("rename-member-renamer");
  await expect.element(page.getByTestId("rename-member-dialog")).toBeVisible();
  await expect
    .element(page.getByTestId("rename-member-policy-impact"))
    .toBeVisible();
  inputDomTestId("rename-member-name", "renamer-new");
  const updateOption = page.getByTestId("rename-member-update-policy");
  await expect.element(updateOption).toHaveAttribute("aria-checked", "true");
  await clickVisibleDomTestId("rename-member-update-policy");
  await expect.element(updateOption).toHaveAttribute("aria-checked", "false");
  await clickVisibleDomTestId("rename-member-update-policy");
  await expect.element(updateOption).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("confirm-rename-member").click();
  await confirmPolicyPublication();
  await expect
    .poll(
      () => document.querySelector('[data-testid="rename-member-dialog"]'),
      {
        timeout: 30_000,
      },
    )
    .toBeNull();
  await expect.element(page.getByTestId("member-renamer-new")).toBeVisible();

  const calls = (await commands.headscaleOperationCalls()) ?? [];
  const ids = calls.map((call) => call.id);
  expect(ids.lastIndexOf("user.rename")).toBeGreaterThanOrEqual(0);
  expect(ids.lastIndexOf("user.rename")).toBeLessThan(
    ids.lastIndexOf("policy.set"),
  );

  const users =
    (await request(client.read, { endpoint: "listUsers", input: {} })).users ??
    [];
  expect(users.some((user) => user.name === "renamer-new")).toBe(true);
  expect(users.some((user) => user.name === "renamer")).toBe(false);
  const persisted = (await request(client.read, { endpoint: "getPolicy" }))
    .policy;
  expect(persisted).toContain("renamer-new@");
  expect(persisted).not.toContain("renamer@");
  const saved = JSON.parse(persisted);
  expect(saved.groups["group:ops"]).toEqual(["alice@example.com"]);
  expect(saved.groups["group:renamers"]).toEqual(["renamer-new@"]);
});

test("recovers a failed snapshot refresh without losing the current data", async () => {
  await renderLogin();
  await connectWithDefaults();

  await commands.interceptHeadscaleRequest(
    "GET",
    "^/api/v1/node$",
    "temporary snapshot failure",
  );

  try {
    await expect
      .element(page.getByTestId("recent-device-status-1"))
      .toBeVisible();
    await page.getByTestId("refresh-data").click();
    await expect
      .element(page.getByTestId("feedback-status-error"))
      .toBeVisible();
    await expectHeadscaleGate(0);
    await expect
      .element(page.getByTestId("recent-device-status-1"))
      .toBeVisible();
    await expect
      .poll(
        () =>
          document.querySelector<HTMLButtonElement>(
            '[data-testid="refresh-data"]',
          )?.disabled ?? true,
      )
      .toBe(false);

    await page.getByTestId("refresh-data").click();
    await expect
      .element(page.getByTestId("feedback-status-error"))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByTestId("recent-device-status-1"))
      .toBeVisible();
  } finally {
    await commands.releaseHeadscaleRequest();
  }
});

test("keeps the newest identity fabric and policy after older responses are released", async () => {
  await renderLogin();
  await connectWithDefaults();
  await expect.poll(() => session().snapshot.isRefreshing).toBe(false);
  const client = adopted();
  for (const segment of ["identity", "fabric", "policy"] as const) {
    const path =
      segment === "identity"
        ? "user"
        : segment === "fabric"
          ? "node"
          : "policy";
    await commands.interceptHeadscaleRequest("GET", `^/api/v1/${path}$`);
    const older = session().snapshot.refreshSegments([segment]);
    try {
      await expectHeadscaleGate();
      if (segment === "identity")
        await request(client.write, {
          endpoint: "createUser",
          input: { name: "newest-response-user" },
        });
      if (segment === "fabric")
        await request(client.write, {
          endpoint: "renameNode",
          input: { nodeId: "1", newName: "newest-response-node" },
        });
      if (segment === "policy") {
        const current = JSON.parse((await readPolicy(client.read)).policy);
        await request(client.write, {
          endpoint: "setPolicy",
          input: {
            policy: JSON.stringify({
              ...current,
              hosts: { newest: "10.88.0.1" },
            }),
          },
        });
      }
      await session().snapshot.refreshSegments([segment]);
      const newest = session().snapshot.getSnapshot().snapshot;
      if (segment === "identity")
        expect(
          newest.users.some((user) => user.name === "newest-response-user"),
        ).toBe(true);
      if (segment === "fabric")
        expect(newest.nodes.find((node) => node.id === "1")?.givenName).toBe(
          "newest-response-node",
        );
      if (segment === "policy")
        expect(JSON.parse(newest.policy?.policy ?? "{}").hosts).toEqual({
          newest: "10.88.0.1",
        });
      await commands.releaseHeadscaleRequest();
      await older;
      expect(session().snapshot.getSnapshot().snapshot).toEqual(newest);
      expect(session().snapshot.getSnapshot().refreshErrors).toEqual({});
      expect(session().snapshot.isRefreshing).toBe(false);
    } finally {
      await commands.releaseHeadscaleRequest();
      await older;
    }
  }
});

test("retains current data and online health when a refresh response violates its contract", async () => {
  await renderLogin();
  await connectWithDefaults();
  await expect.poll(() => session().snapshot.isRefreshing).toBe(false);
  const previous = session().snapshot.getSnapshot().snapshot;
  await commands.interceptHeadscaleRequest("GET", "^/api/v1/node$", {
    responseBody: { nodes: "invalid-array" },
  });
  const refreshing = session().snapshot.refreshSegments(["fabric"]);
  try {
    await expectHeadscaleGate();
    await commands.releaseHeadscaleRequest();
    await refreshing;
    expect(session().snapshot.getSnapshot().snapshot.nodes).toEqual(
      previous.nodes,
    );
    expect(
      session().snapshot.getSnapshot().snapshot.health?.serverReachable,
    ).toBe(true);
    expect(session().snapshot.getSnapshot().refreshErrors.fabric).toBeTruthy();
    expect(session().feedback.getSnapshot().lastError).toBe("");
    await expect
      .element(page.getByTestId("recent-device-status-1"))
      .toBeVisible();
    await page.getByTestId("refresh-data").click();
    await expect.poll(() => session().snapshot.isRefreshing).toBe(false);
    expect(session().snapshot.getSnapshot().refreshErrors).toEqual({});
  } finally {
    await commands.releaseHeadscaleRequest();
    await refreshing;
  }
});

test("does not replay a successful mutation when its following refresh fails", async () => {
  await renderLogin();
  await connectWithDefaults();
  await page.getByTestId("section-members").click();
  await expect.poll(() => session().snapshot.isRefreshing).toBe(false);
  await openCreateMemberDialog();
  await page
    .getByTestId("member-name")
    .fill("committed-before-refresh-failure");
  await commands.interceptHeadscaleRequest("POST", "^/api/v1/user$");
  const createsBefore = await operationCount("user.create");
  try {
    await page.getByTestId("create-member").click();
    await expectHeadscaleGate();
    expect(await operationCount("user.create")).toBe(createsBefore + 1);
    // Replacing the gate releases the captured POST reply, after the fresh-identity preflight.
    await commands.interceptHeadscaleRequest("GET", "^/api/v1/user$", {
      responseBody: { users: "invalid-array" },
    });
    await expectHeadscaleGate();
    await commands.releaseHeadscaleRequest();
    await waitForActionFinished("create-member");
    expect(await operationCount("user.create")).toBe(createsBefore + 1);
    expect(
      session().snapshot.getSnapshot().refreshErrors.identity,
    ).toBeTruthy();
    await expect
      .element(page.getByTestId("member-create-dialog"))
      .not.toBeInTheDocument();
    const persisted = await request(adopted().read, {
      endpoint: "listUsers",
      input: { name: "committed-before-refresh-failure" },
    });
    expect(persisted.users?.map((user) => user.name)).toEqual([
      "committed-before-refresh-failure",
    ]);
    await page.getByTestId("refresh-users").click();
    await expect
      .element(page.getByTestId("member-committed-before-refresh-failure"))
      .toBeVisible();
    expect(await operationCount("user.create")).toBe(createsBefore + 1);
    expect(
      session().snapshot.getSnapshot().refreshErrors.identity,
    ).toBeUndefined();
  } finally {
    await commands.releaseHeadscaleRequest();
  }
});

test("reports a committed write whose reply is unusable as unconfirmed and shows the saved result without replaying it", async () => {
  await renderLogin();
  await connectWithDefaults();
  await page.getByTestId("section-members").click();
  await expect.poll(() => session().snapshot.isRefreshing).toBe(false);
  await openCreateMemberDialog();
  await page.getByTestId("member-name").fill("unconfirmed-write");
  // Headscale receives and commits the create; only the reply that reaches the Worker is replaced.
  await commands.interceptHeadscaleRequest("POST", "^/api/v1/user$", {
    responseBody: { user: "not-an-object" },
  });
  const createsBefore = await operationCount("user.create");
  try {
    await page.getByTestId("create-member").click();
    await expectHeadscaleGate();
    await commands.releaseHeadscaleRequest();
    // waitForActionFinished asserts an empty error, which is the opposite of this outcome.
    await expect
      .poll(() => session().feedback.isActionPending("create-member"), {
        timeout: 30_000,
      })
      .toBe(false);
    await expect
      .poll(() => visibleText("create-member-error"))
      .toBe(t("sessionOutcomeUnknown"));
    // The automatic refresh shows what Headscale saved, with no further click.
    await expect
      .element(page.getByTestId("member-unconfirmed-write"))
      .toBeVisible();
    expect(await operationCount("user.create")).toBe(createsBefore + 1);
    await expect
      .element(page.getByTestId("member-create-dialog"))
      .toBeVisible();
    // The open dialog covers the page's refresh button, so refresh the same segment directly.
    await session().snapshot.refreshSegments(["identity"]);
    expect(await operationCount("user.create")).toBe(createsBefore + 1);
  } finally {
    await commands.releaseHeadscaleRequest();
  }
});

test("accepts a policy save without replacing edits made while its response was held", async () => {
  await renderLogin();
  await connectWithDefaults();
  await openAccessSection();
  await page.getByTestId("team-card-group:ops").click();
  await page.getByTestId("team-name-input").fill("submitted-ops");
  await userEvent.keyboard("{Enter}");
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByTestId("unsaved-changes-dialog"))
    .toBeVisible();
  await commands.interceptHeadscaleRequest("PUT", "^/api/v1/policy$");
  const savesBefore = await operationCount("policy.set");
  try {
    await page.getByTestId("unsaved-changes-save").click();
    await confirmPolicyPublication();
    await expectHeadscaleGate();
    await page.getByTestId("team-name-input").fill("newer-committed-ops");
    await userEvent.keyboard("{Enter}");
    await page.getByTestId("team-name-input").fill("newer-local-name");
    await commands.releaseHeadscaleRequest();
    await waitForActionFinished("save-policy");
    await expect.element(page.getByTestId("team-detail-dialog")).toBeVisible();
    await expect
      .element(page.getByTestId("team-name-input"))
      .toHaveValue("newer-local-name");
    const accepted = (await readPolicy(adopted().read)).policy;
    expect(JSON.parse(accepted).groups["group:submitted-ops"]).toEqual([
      "alice@example.com",
    ]);
    expect(session().policy.getSnapshot().policyDraft).toBe(accepted);
    expect(session().policy.policyPayload?.groups).toHaveProperty(
      "group:newer-committed-ops",
    );
    expect(session().policy.isPolicyDirty).toBe(true);
    expect(await operationCount("policy.set")).toBe(savesBefore + 1);
    await userEvent.keyboard("{Enter}");
    expect(session().policy.policyPayload?.groups).toHaveProperty(
      "group:newer-local-name",
    );
    expect(session().policy.isPolicyDirty).toBe(true);
    expect(JSON.parse(accepted).groups).not.toHaveProperty(
      "group:newer-local-name",
    );
  } finally {
    await commands.releaseHeadscaleRequest();
  }
});

test("persists complete group and tag references and restores the accepted Headscale policy", async () => {
  const rendered = await renderLogin();
  await connectWithDefaults();
  const documentFor = (group: string, tag: string) => ({
    groups: { [group]: ["alice@example.com"] },
    tagOwners: {
      "tag:server": [group],
      "tag:workstation": ["alice@example.com"],
      "tag:laptop": ["alice@example.com"],
      // Constant: a tag name with an underscore must survive both renames untouched.
      "tag:k8s_node": ["alice@example.com"],
      [tag]: [group],
    },
    acls: [
      { action: "accept", src: ["*"], dst: ["*:*"] },
      { action: "accept", src: [group], dst: [`${tag}:22`] },
      { action: "accept", src: ["*"], dst: ["tag:k8s_node:22"] },
    ],
    autoApprovers: {
      routes: { "10.42.0.0/16": [group, tag] },
      exitNode: [group, tag],
    },
    ssh: [
      {
        action: "accept",
        src: [group],
        dst: ["tag:server", tag],
        users: ["root"],
      },
    ],
    grants: [
      { src: [group], dst: [tag], ip: ["tcp:443"] },
      { src: [group], dst: ["10.42.0.0/16"], ip: ["*"], via: [tag] },
    ],
    nodeAttrs: [{ target: [group, tag], attr: ["randomize-client-port"] }],
    tests: [{ src: group, accept: ["tag:server:22"] }],
    sshTests: [
      { src: group, dst: ["tag:server"], accept: ["root"], deny: ["nobody"] },
    ],
  });
  await resetDockerPolicy(
    JSON.stringify(documentFor("group:ops", "tag:staged")),
  );
  await openAccessSection();
  const tagWritesBefore = await operationCount("node.setTags");
  const nodesBefore = (
    await request(adopted().read, { endpoint: "listNodes", input: {} })
  ).nodes;
  await page.getByTestId("team-card-group:ops").click();
  await page.getByTestId("team-name-input").fill("renamed-ops");
  await userEvent.keyboard("{Enter}");
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("unsaved-changes-save").click();
  await confirmPolicyPublication();
  await waitForActionFinished("save-policy");
  await expect
    .element(page.getByTestId("team-detail-dialog"))
    .not.toBeInTheDocument();
  expect(JSON.parse((await readPolicy(adopted().read)).policy)).toEqual(
    documentFor("group:renamed-ops", "tag:staged"),
  );
  await page.getByTestId("tag-open-tag:staged").click();
  await expect.element(page.getByTestId("tag-detail-dialog")).toBeVisible();
  await page.getByTestId("tag-name-input").fill("planned_v2");
  await userEvent.keyboard("{Enter}");
  // A policy-only rename stays out of the draft until the operator acknowledges the limited scope.
  await expect.element(page.getByTestId("tag-rename-review")).toBeVisible();
  await expect
    .element(page.getByTestId("tag-rename-review"))
    .toMatchTextContent("tag:staged");
  await expect
    .element(page.getByTestId("tag-rename-review"))
    .toMatchTextContent("tag:planned_v2");
  await expect.element(page.getByTestId("tag-rename-confirm")).toBeDisabled();
  await page.getByTestId("tag-rename-external").click();
  await expect.element(page.getByTestId("tag-rename-confirm")).toBeEnabled();
  await page.getByTestId("tag-rename-confirm").click();
  await expect
    .element(page.getByTestId("tag-rename-review"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("tag-name-input"))
    .toHaveValue("planned_v2");
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("unsaved-changes-save").click();
  await confirmPolicyPublication();
  await waitForActionFinished("save-policy");
  const accepted = documentFor("group:renamed-ops", "tag:planned_v2");
  expect(JSON.parse((await readPolicy(adopted().read)).policy)).toEqual(
    accepted,
  );
  expect(await operationCount("node.setTags")).toBe(tagWritesBefore);
  const nodesAfter = (
    await request(adopted().read, { endpoint: "listNodes", input: {} })
  ).nodes;
  expect(nodesAfter?.map((node) => ({ id: node.id, tags: node.tags }))).toEqual(
    nodesBefore?.map((node) => ({ id: node.id, tags: node.tags })),
  );
  await rendered.unmount();
  await renderLogin("/access");
  await expect
    .element(page.getByTestId("team-card-group:renamed-ops"))
    .toBeVisible();
  await expect
    .element(page.getByTestId("tag-card-tag:planned_v2"))
    .toBeVisible();
  expect(session().policy.policyPayload).toEqual(accepted);
  expect(session().policy.isPolicyDirty).toBe(false);
}, 90_000);

test("preserves a failed mutation and succeeds when retried", async () => {
  await renderLogin();
  await connectWithDefaults();

  await page.getByTestId("section-members").click();
  await openCreateMemberDialog();
  await page.getByTestId("member-name").fill("retry-user");
  await page.getByTestId("create-member").click();
  await expect.element(page.getByTestId("member-retry-user")).toBeVisible();

  await commands.interceptHeadscaleRequest(
    "POST",
    "^/api/v1/user/[^/]+/rename/",
    "temporary rename failure",
  );

  try {
    await clickVisibleDomTestId("member-actions-trigger-retry-user");
    await clickVisibleDomTestId("rename-member-retry-user");
    await page.getByTestId("rename-member-name").fill("retry-user-renamed");
    await clickVisibleDomTestId("confirm-rename-member");

    await expect.element(page.getByTestId("rename-member-error")).toBeVisible();
    await expectHeadscaleGate(0);
    await expect
      .element(page.getByTestId("rename-member-dialog"))
      .toBeVisible();
    await expect.element(page.getByTestId("member-retry-user")).toBeVisible();
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="confirm-rename-member"]',
      )?.disabled,
    ).toBe(false);

    await clickVisibleDomTestId("confirm-rename-member");
    await expect
      .element(page.getByTestId("member-retry-user-renamed"))
      .toBeVisible();
    await expect
      .poll(() =>
        document.querySelector('[data-testid="rename-member-dialog"]'),
      )
      .toBeNull();
  } finally {
    await commands.releaseHeadscaleRequest();
  }
});

test("covers the empty machine state and add-first-device flow", async () => {
  await renderLogin();
  await connectWithDefaults();

  await page.getByTestId("section-devices").click();
  for (const nodeId of ["1", "2", "3"]) {
    await page.getByTestId(`machine-actions-trigger-${nodeId}`).click();
    await page.getByTestId(`remove-node-action-${nodeId}`).click();
    await expect.element(page.getByTestId("remove-node-dialog")).toBeVisible();
    await page.getByTestId("remove-node-confirm").click();
    await expect
      .element(page.getByTestId("remove-node-dialog"))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByTestId(`device-${nodeId}`))
      .not.toBeInTheDocument();
    expect(
      (
        (await request(adopted().read, { endpoint: "listNodes", input: {} }))
          .nodes ?? []
      ).some((node) => node.id === nodeId),
    ).toBe(false);
  }

  await expect.element(page.getByTestId("machines-empty")).toBeVisible();
  await page.getByTestId("add-first-device").click();
  await expect.element(page.getByTestId("add-device-dialog")).toBeVisible();
  await expect.element(page.getByTestId("add-device-stepper")).toBeVisible();
  await expect.element(page.getByTestId("device-setup-flow")).toBeVisible();
  await expect.element(page.getByTestId("setup-device-step")).toBeVisible();
  await expectTagSelection("setup-tags", []);
});

test("renames a machine reached from a user detail navigation", async () => {
  await renderLogin();
  await connectWithDefaults();

  await page.getByTestId("section-members").click();
  await page.getByTestId("member-detail-link-alice").click();
  await expect
    .element(page.getByTestId("user-detail-dialog"))
    .toMatchTextContent("Alice Ops");
  await page.getByTestId("user-detail-device-1").click();
  await expect
    .element(page.getByTestId("device-detail-dialog"))
    .toMatchTextContent("alice-laptop");
  await closeLayerWithEscape("device-detail-dialog");

  await selectSectionTab("members");
  await expect
    .element(page.getByTestId("member-actions-trigger-alice"))
    .toBeVisible();
  await clickVisibleDomTestId("member-actions-trigger-alice");
  await clickVisibleDomTestId("view-member-machines-alice");
  // "View machines" filters by the exact owner ID, not by a free-text search that could match others.
  await expect.element(page.getByTestId("owner-filter-chip")).toBeVisible();
  await expect.element(page.getByTestId("device-search")).toHaveValue("");
  await clickVisibleDomTestId("machine-actions-trigger-1");
  await clickVisibleDomTestId("edit-node-tags-action-1");
  await expect.element(page.getByTestId("node-tags-dialog")).toBeVisible();
  await page.getByTestId("node-tags-cancel").click();
  await clickVisibleDomTestId("machine-actions-trigger-1");
  await clickVisibleDomTestId("rename-node-action-1");
  await expect.element(page.getByTestId("rename-node-dialog")).toBeVisible();
  await page.getByTestId("rename-node-dialog-input").fill("alice-from-user");
  await page.getByTestId("rename-node-confirm").click();
  await expect
    .element(page.getByTestId("device-1"))
    .toMatchTextContent("alice-from-user");
});

test("preserves an edited rename while its opening refresh completes", async () => {
  await renderLogin();
  await connectWithDefaults();
  await page.getByTestId("section-devices").click();
  await expect.poll(() => session().snapshot.isRefreshing).toBe(false);
  await commands.interceptHeadscaleRequest("GET", "^/api/v1/node$");
  try {
    await clickVisibleDomTestId("machine-actions-trigger-1");
    await clickVisibleDomTestId("rename-node-action-1");
    await expect.element(page.getByTestId("rename-node-dialog")).toBeVisible();
    await expectHeadscaleGate();
    await page
      .getByTestId("rename-node-dialog-input")
      .fill("alice-delayed-rename");
    await commands.releaseHeadscaleRequest();
    await expect.poll(() => session().snapshot.isRefreshing).toBe(false);
    await expect
      .element(page.getByTestId("rename-node-dialog-input"))
      .toHaveValue("alice-delayed-rename");
    await page.getByTestId("rename-node-confirm").click();
    await expect
      .element(page.getByTestId("device-1"))
      .toMatchTextContent("alice-delayed-rename");
    expect(
      normalizeHeadscaleNode(
        (
          await request(adopted().read, {
            endpoint: "getNode",
            input: { nodeId: "1" },
          })
        ).node,
      ).givenName,
    ).toBe("alice-delayed-rename");
  } finally {
    await commands.releaseHeadscaleRequest();
  }
});

test("preserves member group and tag selections while a policy refresh is pending", async () => {
  await renderLogin();
  await connectWithDefaults();
  await page.getByTestId("section-members").click();
  await expect.element(page.getByTestId("member-charlie")).toBeVisible();
  await expect.poll(() => session().snapshot.isRefreshing).toBe(false);
  for (const kind of ["groups", "tags"]) {
    await commands.interceptHeadscaleRequest("GET", "^/api/v1/policy$");
    const refreshing = session().snapshot.refreshSegments(["policy"]);
    try {
      await expectHeadscaleGate();
      await clickDomTestId("member-actions-trigger-charlie");
      await clickVisibleDomTestId(`assign-member-${kind}-charlie`);
      const prefix = `assign-user-${kind}`;
      await expect.element(page.getByTestId(`${prefix}-dialog`)).toBeVisible();
      const option = lastElementByTestIdPrefix(`${prefix}-option-`);
      const optionId = option.dataset.testid as string;
      await clickLastByTestIdPrefix(`assign-user-${kind}-option-`);
      await expect.element(page.getByTestId(`${prefix}-apply`)).toBeEnabled();
      const selected = option
        .querySelector('[role="checkbox"]')
        ?.getAttribute("aria-checked");
      expect(selected).toBeTruthy();

      await commands.releaseHeadscaleRequest();
      await refreshing;
      await expect.element(page.getByTestId(`${prefix}-apply`)).toBeEnabled();
      expect(
        document
          .querySelector(`[data-testid="${optionId}"] [role="checkbox"]`)
          ?.getAttribute("aria-checked"),
      ).toBe(selected);
      const beforeSave = await operationCount("policy.set");
      await page.getByTestId(`assign-user-${kind}-apply`).click();
      await confirmPolicyPublication();
      await expect
        .poll(async () => await operationCount("policy.set"))
        .toBe(beforeSave + 1);
      await waitForActionFinished(
        kind === "groups" ? "assign-user-groups" : "assign-user-tags",
      );
      await expect
        .poll(() => document.querySelector(`[data-testid="${prefix}-dialog"]`))
        .toBeNull();
    } finally {
      await commands.releaseHeadscaleRequest();
      await refreshing;
    }
  }
});

test("covers user filters, user export and member deletion", async () => {
  await renderLogin();
  await connectWithDefaults();

  await page.getByTestId("section-members").click();
  await expect.element(page.getByTestId("member-alice")).toBeVisible();
  expect(
    document.querySelector('[data-testid="member-alice"]')?.closest("table"),
  ).toBeTruthy();
  expect(
    document
      .querySelector('[data-testid="user-search"]')
      ?.closest('[data-testid="user-table"]'),
  ).toBeNull();
  expect(
    document
      .querySelector('[data-testid="user-search"]')
      ?.closest('[data-testid="user-toolbar"]'),
  ).toBeTruthy();
  inputDomTestId("user-search", "charlie");
  await expect.element(page.getByTestId("member-charlie")).toBeVisible();
  await expect
    .element(page.getByTestId("member-auth-source-charlie"))
    .toHaveTextContent("-");
  const memberDeviceTags = document.querySelector<HTMLElement>(
    '[data-testid="member-device-tags-charlie"]',
  );
  expect(memberDeviceTags).toBeTruthy();
  expect(getComputedStyle(memberDeviceTags as HTMLElement).display).toBe(
    "grid",
  );
  await expect
    .element(page.getByTestId("member-device-tag-charlie-3"))
    .toMatchTextContent("old-phone");
  await page.getByTestId("member-device-tag-charlie-3").click();
  await expect
    .element(page.getByTestId("device-detail-dialog"))
    .toMatchTextContent("old-phone");
  await closeLayerWithEscape("device-detail-dialog");
  await page.getByTestId("member-detail-link-charlie").click();
  await expect
    .element(page.getByTestId("user-detail-dialog"))
    .toMatchTextContent("Charlie");
  await expect
    .element(page.getByTestId("user-detail-dialog"))
    .toMatchTextContent("Auth source: -");
  await closeLayerWithEscape("user-detail-dialog");
  await clickDomTestId("member-actions-trigger-charlie");
  await clickVisibleDomTestId("assign-member-groups-charlie");
  await expect
    .element(page.getByTestId("assign-user-groups-dialog"))
    .toBeVisible();
  await page.getByTestId("assign-user-groups-cancel").click();
  await clickDomTestId("member-actions-trigger-charlie");
  await clickVisibleDomTestId("assign-member-tags-charlie");
  await expect
    .element(page.getByTestId("assign-user-tags-dialog"))
    .toBeVisible();
  await page.getByTestId("assign-user-tags-cancel").click();
  await clickDomTestId("member-actions-trigger-charlie");
  await clickVisibleDomTestId("view-member-details-charlie");
  await expect
    .element(page.getByTestId("user-detail-dialog"))
    .toMatchTextContent("Charlie");
  await closeLayerWithEscape("user-detail-dialog");
  await clickDomTestId("member-actions-trigger-charlie");
  await clickVisibleDomTestId("create-invite-for-member-charlie");
  await expect.element(page.getByTestId("invite-create-dialog")).toBeVisible();
  await expect.element(page.getByTestId("invite-user")).toHaveValue("3");
  await page.getByTestId("cancel-create-invite").click();
  await clickDomTestId("member-actions-trigger-charlie");
  await clickVisibleDomTestId("view-member-machines-charlie");
  await expect.element(page.getByTestId("owner-filter-chip")).toBeVisible();
  await expect.element(page.getByTestId("device-3")).toBeVisible();
  await page.getByTestId("section-members").click();
  await expect.element(page.getByTestId("member-alice")).toBeVisible();
  inputDomTestId("user-search", "charlie");
  await expect
    .poll(() => document.querySelector('[data-testid="member-alice"]'))
    .toBeNull();
  inputDomTestId("user-search", "");
  await expect.element(page.getByTestId("member-charlie")).toBeVisible();

  const downloadStub = stubDownloads();
  try {
    await page.getByTestId("export-users").click();
    expect(downloadStub.downloads).toContain("headscale-users.csv");
  } finally {
    downloadStub.restore();
  }

  // Headscale has no user roles, so there is no role filter; a search that matches nobody is the
  // "no match" state, and exporting an empty table is disabled.
  expect(document.querySelector('[data-testid="user-filter"]')).toBeNull();
  inputDomTestId("user-search", "no-such-user");
  expect(
    document.querySelector('[data-testid="member-tagged-devices"]'),
  ).toBeNull();
  await expect
    .element(page.getByTestId("user-table"))
    .toMatchTextContent("No users match");
  expect(document.querySelector('[data-testid="member-charlie"]')).toBeNull();
  await expect.element(page.getByTestId("export-users")).toBeDisabled();

  inputDomTestId("user-search", "");
  await openCreateMemberDialog();
  await page.getByTestId("member-name").fill("erin");
  await page.getByTestId("member-display").fill("Erin");
  await page.getByTestId("member-email").fill("erin@example.test");
  await page.getByTestId("create-member").click();
  await expect.element(page.getByTestId("member-erin")).toBeVisible();
  await clickVisibleDomTestId("member-actions-trigger-erin");
  await clickVisibleDomTestId("rename-member-erin");
  await expect.element(page.getByTestId("rename-member-dialog")).toBeVisible();
  await expect.element(page.getByTestId("rename-member-name")).toBeVisible();
  inputDomTestId("rename-member-name", "erin-admin");
  await clickVisibleDomTestId("rename-member-cancel");
  await expect
    .poll(() => document.querySelector('[data-testid="rename-member-dialog"]'))
    .toBeNull();
  await expect
    .element(page.getByTestId("member-actions-trigger-erin"))
    .toBeVisible();
  await clickVisibleDomTestId("member-actions-trigger-erin");
  await clickVisibleDomTestId("rename-member-erin");
  await expect.element(page.getByTestId("rename-member-dialog")).toBeVisible();
  await expect.element(page.getByTestId("rename-member-name")).toBeVisible();
  inputDomTestId("rename-member-name", "erin-admin");
  await clickVisibleDomTestId("confirm-rename-member");
  await expect.element(page.getByTestId("member-erin-admin")).toBeVisible();
  await clickVisibleDomTestId("member-actions-trigger-erin-admin");
  await clickVisibleDomTestId("delete-member-erin-admin");
  await expect.element(page.getByTestId("delete-member-dialog")).toBeVisible();
  await clickVisibleDomTestId("cancel-delete-member");
  await expect
    .poll(() => document.querySelector('[data-testid="delete-member-dialog"]'))
    .toBeNull();
  await expect
    .element(page.getByTestId("member-actions-trigger-erin-admin"))
    .toBeVisible();
  await clickVisibleDomTestId("member-actions-trigger-erin-admin");
  await clickVisibleDomTestId("delete-member-erin-admin");
  await expect.element(page.getByTestId("delete-member-dialog")).toBeVisible();
  await clickVisibleDomTestId("confirm-delete-member");
  await waitForActionFinished("delete-member");
  await expect
    .element(page.getByTestId("delete-member-dialog"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("member-erin-admin"))
    .not.toBeInTheDocument();
  await openCreateMemberDialog();
  await page.getByTestId("member-name").fill("erin");
  await page.getByTestId("create-member").click();
  await expect.element(page.getByTestId("member-erin")).toBeVisible();
  await clickVisibleDomTestId("member-actions-trigger-erin");
  await clickVisibleDomTestId("delete-member-erin");
  await expect.element(page.getByTestId("delete-member-dialog")).toBeVisible();
  await clickVisibleDomTestId("confirm-delete-member");
  await waitForActionFinished("delete-member");
  await expect
    .element(page.getByTestId("delete-member-dialog"))
    .not.toBeInTheDocument();
  await expect.element(page.getByTestId("member-erin")).not.toBeInTheDocument();
});

test("preserves edited auth-key options while its opening refresh completes", async () => {
  await renderLogin();
  await connectWithDefaults();
  expect(
    (
      (await request(adopted().read, { endpoint: "listPreAuthKeys" }))
        .preAuthKeys ?? []
    ).map((key) => key.id),
  ).toEqual(["1", "2", "3"]);
  expect(
    session()
      .snapshot.getSnapshot()
      .snapshot.preAuthKeys.map((key) => key.id),
  ).toEqual(["1", "2", "3"]);
  await page.getByTestId("section-invites").click();
  await expect.element(page.getByTestId("invite-1")).toBeVisible();
  await expect.poll(() => session().snapshot.isRefreshing).toBe(false);
  await commands.interceptHeadscaleRequest("GET", "^/api/v1/user$");
  try {
    await page.getByTestId("open-create-invite").click();
    await expect
      .element(page.getByTestId("invite-create-dialog"))
      .toBeVisible();
    await expectHeadscaleGate();
    await page.getByTestId("invite-user").selectOptions("3");
    await addKeyTag("invite-tags", "tag:server");
    await page.getByTestId("invite-reusable").click();
    await page.getByTestId("invite-ephemeral").click();
    await commands.releaseHeadscaleRequest();
    await expect.poll(() => session().snapshot.isRefreshing).toBe(false);
    await expect.element(page.getByTestId("invite-user")).toHaveValue("3");
    await expectTagSelection("invite-tags", ["tag:server"]);
    // The generic dialog defaults to a single-use key, so the click above made it reusable.
    await expect
      .element(page.getByTestId("invite-reusable"))
      .toHaveAttribute("aria-checked", "true");
    await expect
      .element(page.getByTestId("invite-ephemeral"))
      .toHaveAttribute("aria-checked", "true");
    await page.getByTestId("create-invite").click();
    await expect.element(page.getByTestId("created-invite")).toBeVisible();
    const createdKey = (
      (await request(adopted().read, { endpoint: "listPreAuthKeys" }))
        .preAuthKeys ?? []
    ).find(
      (key) => key.user?.id === "3" && key.aclTags?.includes("tag:server"),
    );
    expect(createdKey).toMatchObject({ reusable: true, ephemeral: true });
  } finally {
    await commands.releaseHeadscaleRequest();
  }
});

test("keeps the one-time auth key after creating an invite from a member", async () => {
  // Fails when a member-created invite navigates to /invites without handing the one-time key
  // over: Headscale returns the plaintext only in the create response, so the card would show
  // nothing or a masked list row.
  const observedOperationIds = new Set<OperationId>();
  await renderLogin();
  await connectWithDefaults();
  await commands.clearHeadscaleOperationCalls();

  await page.getByTestId("section-members").click();
  await expect.element(page.getByTestId("member-charlie")).toBeVisible();
  await clickDomTestId("member-actions-trigger-charlie");
  await clickVisibleDomTestId("create-invite-for-member-charlie");
  await expect.element(page.getByTestId("invite-create-dialog")).toBeVisible();
  await expect.element(page.getByTestId("invite-user")).toHaveValue("3");
  await addKeyTag("invite-tags", "tag:workstation");
  await page.getByTestId("create-invite").click();

  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  await expect
    .poll(() => window.location.pathname.endsWith("/invites"))
    .toBe(true);
  const codes = document.querySelectorAll<HTMLElement>(
    '[data-testid="created-invite"] code',
  );
  const shownKey = codes[0]?.textContent?.trim() ?? "";
  expect(shownKey).not.toBe("");
  expect(shownKey).not.toContain("*");
  expect(codes[1]?.textContent).toContain("--login-server");
  expect(codes[1]?.textContent?.includes(`--authkey '${shownKey}'`)).toBe(true);
  await expectUiOperationDelta("preauthkey.create", 0, observedOperationIds);

  const rows =
    (await request(adopted().read, { endpoint: "listPreAuthKeys" }))
      .preAuthKeys ?? [];
  const created = rows.reduce((newest, row) =>
    Number(row.id) > Number(newest.id) ? row : newest,
  );
  expect(created.user?.id).toBe("3");
  // Premise guard: on Headscale 0.29.4 the plaintext exists only in the create response, the list
  // returns a masked value. If the first Docker run shows no masking, drop only this line.
  expect(created.key).not.toBe(shownKey);
});

test("creates a tagged auth key without an owner", async () => {
  await renderLogin();
  await connectWithDefaults();
  const copy = getProductCopy("en-US");
  const client = adopted();
  const idsBefore = new Set(
    (
      (await request(client.read, { endpoint: "listPreAuthKeys" }))
        .preAuthKeys ?? []
    ).map((key) => key.id),
  );

  await page.getByTestId("section-invites").click();
  await expect.element(page.getByTestId("invite-1")).toBeVisible();
  await expect.poll(() => session().snapshot.isRefreshing).toBe(false);
  await page.getByTestId("open-create-invite").click();
  await expect.element(page.getByTestId("invite-create-dialog")).toBeVisible();
  await page.getByTestId("invite-user").selectOptions(copy.inviteNoOwner);
  await expect.element(page.getByTestId("invite-user")).toHaveValue("");

  // No owner and no tags would be a key that cannot join anything: rejected before any request.
  const createsBefore = await operationCount("preauthkey.create");
  await page.getByTestId("create-invite").click();
  await expect.element(page.getByTestId("invite-tags-error")).toBeVisible();
  expect(visibleText("invite-tags-error")).toBe(copy.inviteTagsRequired);
  expect(await operationCount("preauthkey.create")).toBe(createsBefore);

  await addKeyTag("invite-tags", "tag:server");
  await expect
    .element(page.getByTestId("invite-tags-error"))
    .not.toBeInTheDocument();
  await page.getByTestId("create-invite").click();
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  expect(await operationCount("preauthkey.create")).toBe(createsBefore + 1);

  // The server holds a key that has the tag and no owner; the UI sent no user to make that so.
  const created = (
    (await request(client.read, { endpoint: "listPreAuthKeys" })).preAuthKeys ??
    []
  ).find((key) => !idsBefore.has(key.id));
  expect(created).toBeTruthy();
  expect(created?.aclTags).toEqual(["tag:server"]);
  expect(created?.user ?? null).toBeNull();
  await expect
    .element(page.getByTestId(`invite-${created?.id}`))
    .toMatchTextContent(copy.inviteNoOwner);
  expect(
    document.querySelector(`[data-testid="invite-owner-link-${created?.id}"]`),
  ).toBeNull();
  await expect
    .element(page.getByTestId(`invite-tag-${created?.id}-0`))
    .toHaveTextContent("tag:server");
});

/**
 * Picks June 1st 00:00 of `year` in the open auth-key expiration popover. React Day Picker month
 * values use the native zero-based month index. The Year dropdown only navigates the calendar,
 * so the day cell click is what selects the date.
 */
async function pickJuneFirst(year: number) {
  await page
    .getByRole("combobox", { name: "Choose the Month" })
    .selectOptions("5");
  await page
    .getByRole("combobox", { name: "Choose the Year" })
    .selectOptions(String(year));
  await expect
    .poll(
      () =>
        document.querySelector<HTMLElement>('[data-slot="calendar"]')
          ?.textContent,
    )
    .toContain(String(year));
  const juneFirst = Array.from(
    document.querySelectorAll<HTMLElement>('[data-slot="calendar"] button'),
  ).find(
    (element) =>
      element.textContent?.trim() === "1" &&
      !element.closest('[data-outside="true"]') &&
      element.getBoundingClientRect().width > 0,
  );
  expect(juneFirst).toBeTruthy();
  if (juneFirst) await page.elementLocator(juneFirst).click();
  await selectDomTestId("invite-expiration-hour", "00");
  await selectDomTestId("invite-expiration-minute", "00");
}

test("covers auth-key filters, expiration and deletion", async () => {
  await renderLogin();
  await connectWithDefaults();
  await commands.clearHeadscaleOperationCalls();

  await page.getByTestId("section-invites").click();
  await expect.element(page.getByTestId("invite-table")).toBeVisible();
  await expect.element(page.getByTestId("invite-1")).toBeVisible();
  expect(
    document.querySelector('[data-testid="invite-1"]')?.closest("table"),
  ).toBeTruthy();
  await page.getByTestId("invite-owner-link-1").click();
  await expect
    .element(page.getByTestId("user-detail-dialog"))
    .toMatchTextContent("Alice Ops");
  await clickLastByTestIdPrefix("remove-user-policy-reference-");
  await page.getByTestId("confirm-remove-user-policy-reference").click();
  await confirmPolicyPublication();
  await closeLayerWithEscape("user-detail-dialog");
  expect(
    document
      .querySelector('[data-testid="invite-search"]')
      ?.closest('[data-testid="invite-toolbar"]'),
  ).toBeTruthy();
  expect(
    document
      .querySelector('[data-testid="invite-search"]')
      ?.closest('[data-testid="invite-table"]'),
  ).toBeNull();
  expect(
    document
      .querySelector<HTMLElement>('[data-testid="invite-toolbar"]')
      ?.getBoundingClientRect().height ?? 0,
  ).toBeLessThanOrEqual(60);
  expect(
    document
      .querySelector<HTMLElement>('[data-testid="invite-filter"]')
      ?.getBoundingClientRect().height ?? 0,
  ).toBeGreaterThanOrEqual(36);
  expect(
    document
      .querySelector<HTMLElement>('[data-testid="invite-1"]')
      ?.getBoundingClientRect().height ?? 0,
  ).toBeLessThanOrEqual(88);
  expect(
    document.querySelector<HTMLElement>('[data-testid="invite-status-1"]')
      ?.className,
  ).toContain("emerald");
  expect(
    document.querySelector<HTMLElement>('[data-testid="invite-status-2"]')
      ?.className,
  ).toContain("rose");
  expect(
    document.querySelector<HTMLElement>('[data-testid="invite-kind-1"]')
      ?.className,
  ).toContain("teal");
  expect(
    document.querySelector<HTMLElement>('[data-testid="invite-kind-2"]')
      ?.className,
  ).toContain("violet");
  expect(
    document.querySelector<HTMLElement>('[data-testid="invite-ephemeral-2"]')
      ?.className,
  ).toContain("amber");
  expect(
    document.querySelector<HTMLElement>('[data-testid="invite-tag-1-0"]')
      ?.className,
  ).toContain("cyan");
  expect(document.querySelector('[data-testid="invite-tag-2-0"]')).toBeNull();
  expect(
    document.querySelector('[data-testid="invite-2"]')?.textContent,
  ).not.toMatch(/No tags|无标签/);
  // Expiration outranks a used one-time key, so a used key past its expiration reads Expired.
  // Untagged keys show no tags. The used filter still matches key.used, independently of that label.
  expect(visibleText("invite-status-2")).toBe(
    getProductCopy("en-US").expiredOnly,
  );
  expect(visibleText("invite-tags-2")).toBe("");
  expect(visibleText("invite-tags-3")).toBe("");
  inputDomTestId("invite-search", "alice");
  await expect.element(page.getByTestId("invite-1")).toBeVisible();
  await expect
    .poll(() => document.querySelector('[data-testid="invite-2"]'))
    .toBeNull();
  inputDomTestId("invite-search", "");
  inputDomTestId("invite-search", "tag:server");
  await expect.element(page.getByTestId("invite-1")).toBeVisible();
  await expect
    .poll(() => document.querySelector('[data-testid="invite-2"]'))
    .toBeNull();
  inputDomTestId("invite-search", "");
  await selectDomTestId("invite-filter", "used");
  await expect.element(page.getByTestId("invite-2")).toBeVisible();
  expect(document.querySelector('[data-testid="invite-1"]')).toBeNull();
  await selectDomTestId("invite-filter", "tagged");
  await expect.element(page.getByTestId("invite-1")).toBeVisible();
  await expect
    .poll(() => document.querySelector('[data-testid="invite-2"]'))
    .toBeNull();

  await selectDomTestId("invite-filter", "all");
  await page.getByTestId("open-create-invite").click();
  await expect.element(page.getByTestId("invite-create-dialog")).toBeVisible();
  await page.getByTestId("invite-user").selectOptions("3");
  expect(
    document.querySelector<HTMLElement>('[data-testid="invite-expiration"]')
      ?.tagName,
  ).toBe("BUTTON");
  expectAuthKeyDateTimePickerClosed();
  await page.viewport(500, 768);
  expectAuthKeyDateTimePickerClosed();
  await page.getByTestId("invite-expiration").click();
  await expect
    .poll(
      () =>
        document.querySelectorAll<HTMLElement>('[data-slot="calendar"] select')
          .length,
    )
    .toBe(2);
  expectAuthKeyTimePickerPopover();
  await page.viewport(1366, 768);
  expectAuthKeyTimePickerPopover();
  // Negative step first: the untouched default is relative, so a past pick must be rejected by
  // the dialog before any request reaches the Worker. Fails when a past expiration is
  // submitted (Headscale would accept it silently).
  const keyCreatesBeforeRejectedPick =
    await operationCount("preauthkey.create");
  await pickJuneFirst(new Date().getFullYear() - 1);
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByTestId("invite-expiration-hour"))
    .not.toBeInTheDocument();
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("invite-expiration-error"))
    .toBeVisible();
  await expect.element(page.getByTestId("invite-create-dialog")).toBeVisible();
  expect(await operationCount("preauthkey.create")).toBe(
    keyCreatesBeforeRejectedPick,
  );

  const expirationYear = new Date().getFullYear() + 1;
  await page.getByTestId("invite-expiration").click();
  await expect
    .poll(
      () =>
        document.querySelectorAll<HTMLElement>('[data-slot="calendar"] select')
          .length,
    )
    .toBe(2);
  await pickJuneFirst(expirationYear);
  await expect
    .element(page.getByTestId("invite-expiration"))
    .toMatchTextContent(`Jun 1, ${expirationYear}`);
  await expect
    .element(page.getByTestId("invite-expiration"))
    .toMatchTextContent("12:00 AM");
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByTestId("invite-expiration-hour"))
    .not.toBeInTheDocument();
  expectAuthKeyDateTimePickerClosed();
  await addKeyTag("invite-tags", "tag:mobile");
  await page.getByTestId("invite-reusable").click();
  await page.getByTestId("invite-ephemeral").click();
  await page.getByTestId("create-invite").click();
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  await expect
    .poll(async () =>
      (await commands.headscaleOperationCalls())?.some(
        (call) => call.id === "preauthkey.create",
      ),
    )
    .toBe(true);
  const createdPayload = (await commands.headscaleOperationCalls())
    ?.filter((call) => call.id === "preauthkey.create")
    .at(-1)?.payload as { expiration?: string } | undefined;
  expect(createdPayload?.expiration).toBe(
    new Date(`${expirationYear}-06-01T00:00`).toISOString(),
  );
  await expect
    .poll(async () => {
      const key = (
        (await request(adopted().read, { endpoint: "listPreAuthKeys" }))
          .preAuthKeys ?? []
      ).find((key) => key.aclTags?.includes("tag:mobile"));
      return Date.parse(key?.expiration ?? "");
    })
    .toBe(new Date(`${expirationYear}-06-01T00:00`).getTime());

  await clickVisibleDomTestId("invite-actions-trigger-1");
  await clickVisibleDomTestId("expire-invite-1");
  await expect.element(page.getByTestId("expire-invite-dialog")).toBeVisible();
  await clickVisibleDomTestId("cancel-invite-action");
  await clickVisibleDomTestId("invite-actions-trigger-1");
  await clickVisibleDomTestId("expire-invite-1");
  await expect.element(page.getByTestId("expire-invite-dialog")).toBeVisible();
  await clickVisibleDomTestId("confirm-invite-action");
  await expect
    .poll(async () =>
      (await commands.headscaleOperationCalls())?.some(
        (call) => call.id === "preauthkey.expire",
      ),
    )
    .toBe(true);
  await waitForActionFinished("invite-action");
  await expect
    .element(page.getByTestId("expire-invite-dialog"))
    .not.toBeInTheDocument();
  // An unused key that was expired reads Expired, not the "Disconnected"-style unused label.
  await expect
    .poll(() => visibleText("invite-status-1"))
    .toBe(getProductCopy("en-US").expiredOnly);
  expect(
    document.querySelector<HTMLElement>('[data-testid="invite-status-1"]')
      ?.className,
  ).toContain("rose");
  await clickVisibleDomTestId("invite-actions-trigger-2");
  await clickVisibleDomTestId("delete-invite-2");
  await expect.element(page.getByTestId("delete-invite-dialog")).toBeVisible();
  await clickVisibleDomTestId("confirm-invite-action");
  await expect
    .poll(async () =>
      (await commands.headscaleOperationCalls())?.some(
        (call) => call.id === "preauthkey.delete",
      ),
    )
    .toBe(true);
  await waitForActionFinished("invite-action");
  await expect
    .element(page.getByTestId("delete-invite-dialog"))
    .not.toBeInTheDocument();
  await expect.element(page.getByTestId("invite-2")).not.toBeInTheDocument();
});

async function resetDockerPolicy(policyJson: string) {
  if (policyJson)
    await request(adopted().write, {
      endpoint: "setPolicy",
      input: { policy: policyJson },
    });
  else await commands.resetHeadscaleFixture(true);
  const { refreshSnapshot } = session().snapshot;
  await refreshSnapshot();
}

async function openAccessSection() {
  await page.getByTestId("section-access").click();
  // Wait for either the populated layout or the empty-state layout to render.
  await expect
    .poll(
      () =>
        document.querySelector('[data-testid="teams-section"]') ||
        document.querySelector('[data-testid="resource-access-empty"]'),
    )
    .toBeTruthy();
}

test("issue12: publishes, edits and removes directed label access with public readback", async () => {
  await renderLogin();
  await connectWithDefaults();
  const baseline = {
    groups: {},
    tagOwners: { "tag:app": [], "tag:db": [] },
    acls: [],
  };
  await resetDockerPolicy(JSON.stringify(baseline));
  await openAccessSection();
  await commands.clearHeadscaleOperationCalls();

  await page.getByTestId("tag-open-tag:db").click();
  await page.getByTestId("tag-add-accessor-trigger").click();
  await page.getByTestId("tag-add-accessor-option-tag:app").click();
  await page.getByTestId("tag-accessor-custom-tag:app").fill("5432");
  await userEvent.keyboard("{Enter}");
  await page.getByTestId("tag-accessor-svc-tag:app-ssh").click();
  await page.getByTestId("tag-detail-close").click();
  expect(await operationCount("policy.set")).toBe(0);
  await page.getByTestId("save-policy").click();
  expect(await operationCount("policy.set")).toBe(0);
  await confirmPolicyPublication();
  expect(await latestSavedPolicy()).toEqual({
    groups: {},
    tagOwners: { "tag:app": [], "tag:db": [] },
    acls: [{ action: "accept", src: ["tag:app"], dst: ["tag:db:5432"] }],
  });
  expect(await operationCount("policy.set")).toBe(1);

  await session().snapshot.refreshSegments(["policy"]);
  await page.getByTestId("tag-open-tag:db").click();
  await expect
    .element(page.getByTestId("tag-accessor-row-tag:app"))
    .toBeVisible();
  await expect
    .element(page.getByTestId("tag-accessor-custom-tag:app"))
    .toHaveValue("5432");
  await expect
    .element(page.getByTestId("tag-accessor-svc-tag:app-ssh"))
    .not.toBeChecked();
  await page.getByTestId("tag-accessor-custom-tag:app").fill("8443");
  await userEvent.keyboard("{Enter}");
  await page.getByTestId("tag-detail-close").click();
  await page.getByTestId("save-policy").click();
  expect(await operationCount("policy.set")).toBe(1);
  await confirmPolicyPublication();
  expect(await latestSavedPolicy()).toEqual({
    groups: {},
    tagOwners: { "tag:app": [], "tag:db": [] },
    acls: [{ action: "accept", src: ["tag:app"], dst: ["tag:db:8443"] }],
  });
  expect(await operationCount("policy.set")).toBe(2);

  await session().snapshot.refreshSegments(["policy"]);
  await page.getByTestId("tag-open-tag:db").click();
  await page.getByTestId("tag-accessor-remove-tag:app").click();
  await page.getByTestId("tag-detail-close").click();
  await page.getByTestId("save-policy").click();
  expect(await operationCount("policy.set")).toBe(2);
  await confirmPolicyPublication();
  expect(await latestSavedPolicy()).toEqual({
    groups: {},
    tagOwners: { "tag:app": [], "tag:db": [] },
    acls: [],
  });
  expect(await operationCount("policy.set")).toBe(3);
  await session().snapshot.refreshSegments(["policy"]);
  await page.getByTestId("tag-open-tag:db").click();
  await expect
    .element(page.getByTestId("tag-accessor-row-tag:app"))
    .not.toBeInTheDocument();
});

test("renders initial Docker policy with team/tag cards and risk banners", async () => {
  await renderLogin();
  await connectWithDefaults();
  await openAccessSection();

  await expect.element(page.getByTestId("team-card-group:ops")).toBeVisible();
  await expect.element(page.getByTestId("tag-card-tag:server")).toBeVisible();
  await expect
    .element(page.getByTestId("tag-card-tag:workstation"))
    .toBeVisible();

  await expect.element(page.getByTestId("open-access-banner")).toBeVisible();
  expect(
    document.querySelector('[data-testid="orphan-ref-banner"]'),
  ).toBeNull();

  expect(
    document.querySelector('[data-testid="resource-access-empty"]'),
  ).toBeNull();
  expectNoRawPolicyEditor();
});

test("clean up orphan refs banner: cancel keeps them, confirm strips them", async () => {
  await renderLogin();
  await connectWithDefaults();
  await resetDockerPolicy(
    JSON.stringify({
      groups: { "group:ops": ["alice@", "ghost@"] },
      tagOwners: { "tag:server": ["alice@", "ghost@"] },
      acls: [
        {
          action: "accept",
          src: ["group:ops", "alice@"],
          dst: ["tag:server:80", "tag:server:443"],
        },
      ],
    }),
  );
  await openAccessSection();
  await commands.clearHeadscaleOperationCalls();

  await expect.element(page.getByTestId("orphan-ref-banner")).toBeVisible();
  await page.getByTestId("cleanup-orphan-refs").click();
  await expect
    .element(page.getByTestId("cleanup-orphans-dialog"))
    .toBeVisible();

  // Cancel keeps the orphan banner around.
  await page.getByTestId("cleanup-orphans-cancel").click();
  await expect.element(page.getByTestId("orphan-ref-banner")).toBeVisible();

  // Confirm wipes the references; banner disappears once state is clean.
  await page.getByTestId("cleanup-orphan-refs").click();
  await page.getByTestId("cleanup-orphans-confirm").click();
  await expect
    .poll(() => document.querySelector('[data-testid="orphan-ref-banner"]'))
    .toBeNull();

  await page.getByTestId("save-policy").click();
  await confirmPolicyPublication();
  await expect
    .poll(async () =>
      (await commands.headscaleOperationCalls())?.some(
        (call) => call.id === "policy.set",
      ),
    )
    .toBe(true);

  const saved = await latestSavedPolicy();
  expect(saved.groups?.["group:ops"]).toEqual(["alice@"]);
  expect(saved.tagOwners?.["tag:server"]).toEqual(["alice@"]);
  expect(saved.acls?.flatMap((rule) => rule.dst).sort()).toEqual([
    "tag:server:443",
    "tag:server:80",
  ]);
});

test("unsaved-changes dialog covers cancel, discard and save-and-close paths", async () => {
  await renderLogin();
  await connectWithDefaults();
  await openAccessSection();
  await commands.clearHeadscaleOperationCalls();

  // Open team detail; clean state — Escape closes silently.
  await page.getByTestId("team-card-group:ops").click();
  await expect.element(page.getByTestId("team-detail-dialog")).toBeVisible();

  // Make it dirty by removing an existing member. The fixture policy must give
  // group:ops at least one member — fail loudly if that ever changes.
  const memberRow = document.querySelector(
    '[data-testid^="team-member-remove-"]',
  ) as HTMLElement | null;
  expect(memberRow).not.toBeNull();
  memberRow?.click();

  // Escape now triggers the unsaved-changes confirm.
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByTestId("unsaved-changes-dialog"))
    .toBeVisible();

  // Keep-editing returns to the team dialog with edits intact.
  await page.getByTestId("unsaved-changes-keep-editing").click();
  await expect
    .poll(() =>
      document.querySelector('[data-testid="unsaved-changes-dialog"]'),
    )
    .toBeNull();
  await expect.element(page.getByTestId("team-detail-dialog")).toBeVisible();

  // Escape again, this time discard. The global unsaved badge must vanish
  // along with the dialog — that's the contract of "Close without saving".
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByTestId("unsaved-changes-dialog"))
    .toBeVisible();
  await page.getByTestId("unsaved-changes-discard").click();
  await expect
    .poll(() => document.querySelector('[data-testid="team-detail-dialog"]'))
    .toBeNull();
  await expect
    .poll(() =>
      document.querySelector('[data-testid="save-policy-dirty-badge"]'),
    )
    .toBeNull();

  // Reopen — discard should have restored the original state, so the member
  // row is back. Dirty it again, this time use save-and-close.
  await page.getByTestId("team-card-group:ops").click();
  await expect.element(page.getByTestId("team-detail-dialog")).toBeVisible();
  const memberRow2 = document.querySelector(
    '[data-testid^="team-member-remove-"]',
  ) as HTMLElement | null;
  expect(memberRow2).not.toBeNull();
  memberRow2?.click();
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("unsaved-changes-save").click();
  await confirmPolicyPublication();
  await expect
    .poll(async () =>
      (await commands.headscaleOperationCalls())?.some(
        (call) => call.id === "policy.set",
      ),
    )
    .toBe(true);
  await latestSavedPolicy();
});

test("creates a team, adds a member, saves and reopens it", async () => {
  await renderLogin();
  await connectWithDefaults();
  await openAccessSection();
  await commands.clearHeadscaleOperationCalls();

  await page.getByTestId("new-team").click();
  await expect.element(page.getByTestId("team-detail-dialog")).toBeVisible();

  inputDomTestId("team-name-input", "dev");
  await page.getByTestId("team-name-confirm").click();
  await expect.element(page.getByTestId("team-members-section")).toBeVisible();

  await clickVisibleDomTestId("team-add-member-trigger");
  await expect
    .element(page.getByTestId("team-add-member-content"))
    .toBeVisible();
  inputDomTestId("team-add-member-search", "zzz-no-match");
  await expect.element(page.getByTestId("team-add-member-empty")).toBeVisible();
  expect(
    document.querySelector(
      '[data-testid="team-add-member-option-alice@example.com"]',
    ),
  ).toBeNull();
  inputDomTestId("team-add-member-search", "alice");
  await clickVisibleDomTestId("team-add-member-option-alice@example.com");
  await expect
    .element(page.getByTestId("team-member-row-alice@example.com"))
    .toBeVisible();

  // Dialog is dirty (a member was added) — "Done" routes through the unsaved-
  // changes confirm. Save-and-close publishes the whole policy after review.
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByTestId("unsaved-changes-dialog"))
    .toBeVisible();
  await page.getByTestId("unsaved-changes-save").click();
  await confirmPolicyPublication();
  await expect
    .poll(async () =>
      (await commands.headscaleOperationCalls())?.some(
        (call) => call.id === "policy.set",
      ),
    )
    .toBe(true);
  await expect.element(page.getByTestId("team-card-group:dev")).toBeVisible();

  const saved = await latestSavedPolicy();
  expect(saved.groups?.["group:dev"]).toEqual(["alice@example.com"]);

  await page.getByTestId("team-card-group:dev").click();
  await expect.element(page.getByTestId("team-detail-dialog")).toBeVisible();
  await expect
    .element(page.getByTestId("team-member-row-alice@example.com"))
    .toBeVisible();
  await page.getByTestId("team-member-remove-alice@example.com").click();
  await expect
    .poll(() =>
      document.querySelector(
        '[data-testid="team-member-row-alice@example.com"]',
      ),
    )
    .toBeNull();
  // Removing the member made the dialog dirty again. Discard returns to the
  // last saved state, and the global "unsaved" badge must disappear with it.
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByTestId("unsaved-changes-dialog"))
    .toBeVisible();
  await page.getByTestId("unsaved-changes-discard").click();
  await expect
    .poll(() =>
      document.querySelector('[data-testid="save-policy-dirty-badge"]'),
    )
    .toBeNull();
});

test("creates a device label with an accessor + label manager and saves the rule", async () => {
  await renderLogin();
  await connectWithDefaults();
  await openAccessSection();
  await commands.clearHeadscaleOperationCalls();

  await page.getByTestId("new-device-label").click();
  await expect.element(page.getByTestId("tag-detail-dialog")).toBeVisible();
  inputDomTestId("tag-name-input", "db");
  await page.getByTestId("tag-name-confirm").click();
  await expect.element(page.getByTestId("tag-accessors-section")).toBeVisible();
  await expect.element(page.getByTestId("tag-owners-section")).toBeVisible();

  await clickVisibleDomTestId("tag-add-accessor-trigger");
  await expect
    .element(page.getByTestId("tag-add-accessor-content"))
    .toBeVisible();
  inputDomTestId("tag-add-accessor-search", "zzz-no-match");
  await expect
    .element(page.getByTestId("tag-add-accessor-empty"))
    .toBeVisible();
  expect(
    document.querySelector('[data-testid="tag-add-accessor-option-group:ops"]'),
  ).toBeNull();
  inputDomTestId("tag-add-accessor-search", "ops");
  await clickVisibleDomTestId("tag-add-accessor-option-group:ops");
  await expect
    .element(page.getByTestId("tag-accessor-row-group:ops"))
    .toBeVisible();

  await clickDomTestId("tag-accessor-svc-group:ops-web");
  // Custom-port input commits on blur — use the page-level fill helper which
  // focuses/types/blurs in a way the framework can drive end-to-end.
  await page.getByTestId("tag-accessor-custom-group:ops").fill("8080");
  // Force commit by also pressing Enter (handler is bound on both blur + Enter).
  await userEvent.keyboard("{Enter}");

  await clickVisibleDomTestId("tag-add-owner-trigger");
  await expect.element(page.getByTestId("tag-add-owner-content")).toBeVisible();
  inputDomTestId("tag-add-owner-search", "zzz-no-match");
  await expect.element(page.getByTestId("tag-add-owner-empty")).toBeVisible();
  expect(
    document.querySelector('[data-testid="tag-add-owner-option-group:ops"]'),
  ).toBeNull();
  inputDomTestId("tag-add-owner-search", "ops");
  await page.getByTestId("tag-add-owner-option-group:ops").click();
  await expect
    .element(page.getByTestId("tag-owner-row-group:ops"))
    .toBeVisible();

  // Tag dialog is dirty — close routes through the unsaved-changes confirm.
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByTestId("unsaved-changes-dialog"))
    .toBeVisible();
  await page.getByTestId("unsaved-changes-save").click();
  await confirmPolicyPublication();
  await expect
    .poll(async () =>
      (await commands.headscaleOperationCalls())?.some(
        (call) => call.id === "policy.set",
      ),
    )
    .toBe(true);
  await expect.element(page.getByTestId("tag-card-tag:db")).toBeVisible();

  const saved = await latestSavedPolicy();
  expect(saved.tagOwners?.["tag:db"]).toEqual(["group:ops"]);
  const dbRule = saved.acls?.find(
    (r: { src: string[]; dst: string[] }) =>
      r.src?.[0] === "group:ops" && r.dst?.[0]?.startsWith("tag:db:"),
  );
  expect(dbRule).toBeTruthy();
  const portsString = dbRule?.dst?.[0]?.split(":").at(-1) ?? "";
  expect(portsString).toContain("22");
  expect(portsString).toContain("80");
  expect(portsString).toContain("443");
  expect(portsString).toContain("8080");
});

test("saves a no-email CLI user as a device-label manager with name@", async () => {
  await commands.clearHeadscaleOperationCalls();
  await renderLogin();
  await connectWithDefaults();

  await page.getByTestId("section-members").click();
  await openCreateMemberDialog();
  await page.getByTestId("member-name").fill("test-user");
  await page.getByTestId("create-member").click();
  await expect.element(page.getByTestId("member-test-user")).toBeVisible();
  expect(
    document.querySelector('[data-testid="member-tagged-devices"]'),
  ).toBeNull();

  const created = (
    (await request(adopted().read, { endpoint: "listUsers", input: {} }))
      .users ?? []
  ).find((user) => user.name === "test-user");
  expect(created).toBeTruthy();
  if (!created) throw new Error("Headscale user test-user was not created");
  expect((created.email ?? "").trim()).toBe("");
  const principal = policyPrincipalForUser(created);

  await openAccessSection();
  await commands.clearHeadscaleOperationCalls();
  await page.getByTestId("new-device-label").click();
  await expect.element(page.getByTestId("tag-detail-dialog")).toBeVisible();
  inputDomTestId("tag-name-input", "issue7");
  await page.getByTestId("tag-name-confirm").click();
  await expect.element(page.getByTestId("tag-owners-section")).toBeVisible();

  await clickVisibleDomTestId("tag-add-owner-trigger");
  await expect.element(page.getByTestId("tag-add-owner-content")).toBeVisible();
  expect(
    document.querySelector(
      '[data-testid="tag-add-owner-option-tagged-devices"]',
    ),
  ).toBeNull();
  expect(
    document.querySelector(
      '[data-testid="tag-add-owner-option-tagged-devices@"]',
    ),
  ).toBeNull();
  await page.getByTestId(`tag-add-owner-option-${principal}`).click();
  await expect
    .element(page.getByTestId(`tag-owner-row-${principal}`))
    .toBeVisible();

  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByTestId("unsaved-changes-dialog"))
    .toBeVisible();
  await page.getByTestId("unsaved-changes-save").click();
  await confirmPolicyPublication();
  await expect
    .poll(async () =>
      (await commands.headscaleOperationCalls())?.some(
        (call) => call.id === "policy.set",
      ),
    )
    .toBe(true);

  const saved = await latestSavedPolicy();
  expect(saved.tagOwners?.["tag:issue7"]).toEqual([principal]);
  const owners = Object.values(saved.tagOwners ?? {}).flat();
  const members = Object.values(saved.groups ?? {}).flat();
  expect(owners).not.toContain("tagged-devices");
  expect(owners).not.toContain("tagged-devices@");
  expect(members).not.toContain("tagged-devices");
  expect(members).not.toContain("tagged-devices@");
});

test("removes an accessor row from a tag detail dialog", async () => {
  await renderLogin();
  await connectWithDefaults();
  await openAccessSection();

  // Set up a fresh tag with one accessor so we have something to remove.
  await page.getByTestId("new-device-label").click();
  inputDomTestId("tag-name-input", "scratch");
  await page.getByTestId("tag-name-confirm").click();
  await clickVisibleDomTestId("tag-add-accessor-trigger");
  await clickVisibleDomTestId("tag-add-accessor-option-group:ops");
  await expect
    .element(page.getByTestId("tag-accessor-row-group:ops"))
    .toBeVisible();

  await page.getByTestId("tag-accessor-remove-group:ops").click();
  await expect
    .poll(() =>
      document.querySelector('[data-testid="tag-accessor-row-group:ops"]'),
    )
    .toBeNull();
  // The dialog can be re-portaled after removing the accessor; re-query the close button.
  await expect.element(page.getByTestId("tag-detail-dialog")).toBeVisible();
  // Dirty (we created a tag + removed an accessor) — discard to return to baseline.
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("unsaved-changes-discard").click();
});

test("removes a tag owner and saves the cleanup", async () => {
  await renderLogin();
  await connectWithDefaults();
  await openAccessSection();
  await commands.clearHeadscaleOperationCalls();

  await page.getByTestId("tag-open-tag:server").click();
  await expect.element(page.getByTestId("tag-detail-dialog")).toBeVisible();
  await expect
    .element(page.getByTestId("tag-owner-row-alice@example.com"))
    .toBeVisible();
  await page.getByTestId("tag-owner-remove-alice@example.com").click();
  await expect
    .poll(() =>
      document.querySelector('[data-testid="tag-owner-row-alice@example.com"]'),
    )
    .toBeNull();
  // Dialog is dirty — close routes through the unsaved-changes confirm.
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("unsaved-changes-save").click();
  await confirmPolicyPublication();
  await expect
    .poll(async () =>
      (await commands.headscaleOperationCalls())?.some(
        (call) => call.id === "policy.set",
      ),
    )
    .toBe(true);

  const saved = await latestSavedPolicy();
  const stillHasOwner =
    saved.tagOwners?.["tag:server"]?.includes?.("alice@example.com") ?? false;
  expect(stillHasOwner).toBe(false);
});

test("cancels then confirms removal of a team", async () => {
  await renderLogin();
  await connectWithDefaults();
  await openAccessSection();

  await page.getByTestId("team-remove-group:ops").click();
  await expectPolicyRemovalDialog();
  await page.getByTestId("cancel-remove-policy-item").click();
  await expectPolicyRemovalDialogClosed();
  await expect.element(page.getByTestId("team-card-group:ops")).toBeVisible();

  await page.getByTestId("team-remove-group:ops").click();
  await expectPolicyRemovalDialog();
  await page.getByTestId("confirm-remove-policy-item").click();
  await expectPolicyRemovalDialogClosed();
  await expect
    .poll(() => document.querySelector('[data-testid="team-card-group:ops"]'))
    .toBeNull();
});

test("removes a device label and its policy entries via the card trash button", async () => {
  await renderLogin();
  await connectWithDefaults();
  await openAccessSection();
  await commands.clearHeadscaleOperationCalls();

  await page.getByTestId("tag-remove-tag:server").click();
  await expectPolicyRemovalDialog();
  await page.getByTestId("confirm-remove-policy-item").click();
  await expectPolicyRemovalDialogClosed();

  // tag:server is also referenced by a fixture node, so the card may still
  // render — but the saved policy must no longer contain its tagOwner entry.
  await page.getByTestId("save-policy").click();
  await confirmPolicyPublication();
  await expect
    .poll(async () =>
      (await commands.headscaleOperationCalls())?.some(
        (call) => call.id === "policy.set",
      ),
    )
    .toBe(true);
  const saved = await latestSavedPolicy();
  expect(saved.tagOwners?.["tag:server"]).toBeUndefined();
});

test("filters device labels via the search input", async () => {
  await renderLogin();
  await connectWithDefaults();
  await openAccessSection();

  inputDomTestId("tag-search", "server");
  await expect.element(page.getByTestId("tag-card-tag:server")).toBeVisible();
  await expect
    .poll(() =>
      document.querySelector('[data-testid="tag-card-tag:workstation"]'),
    )
    .toBeNull();

  inputDomTestId("tag-search", "");
  await expect
    .element(page.getByTestId("tag-card-tag:workstation"))
    .toBeVisible();
});

test("high-risk confirm appears when a service expands to all", async () => {
  await renderLogin();
  await connectWithDefaults();
  await openAccessSection();

  await page.getByTestId("tag-open-tag:workstation").click();
  await expect.element(page.getByTestId("tag-detail-dialog")).toBeVisible();
  await clickVisibleDomTestId("tag-add-accessor-trigger");
  await clickVisibleDomTestId("tag-add-accessor-option-group:ops");
  await expect
    .element(page.getByTestId("tag-accessor-row-group:ops"))
    .toBeVisible();

  await clickDomTestId("tag-accessor-svc-group:ops-all");
  await expect
    .element(page.getByTestId("high-risk-confirm-dialog"))
    .toBeVisible();
  await page.getByTestId("high-risk-cancel").click();
  await expect
    .poll(
      () =>
        document.querySelector('[data-testid="high-risk-confirm-dialog"]') ===
        null,
    )
    .toBe(true);
  // Adding the accessor made the dialog dirty — discard to clean up.
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("unsaved-changes-discard").click();
});

test("empty state renders templates and applies one", async () => {
  await renderLogin();
  await connectWithDefaults();
  await resetDockerPolicy("");
  await openAccessSection();

  await expect.element(page.getByTestId("resource-access-empty")).toBeVisible();
  await expect
    .element(page.getByTestId("template-card-self-only"))
    .toBeVisible();
  await expect
    .element(page.getByTestId("template-card-small-team"))
    .toBeVisible();
  await expect
    .element(page.getByTestId("template-card-split-env"))
    .toBeVisible();

  await page.getByTestId("empty-create-team").click();
  await expect.element(page.getByTestId("team-detail-dialog")).toBeVisible();
  await page.getByTestId("team-detail-close").click();

  await page.getByTestId("empty-create-tag").click();
  await expect.element(page.getByTestId("tag-detail-dialog")).toBeVisible();
  await page.getByTestId("tag-detail-close").click();

  await page.getByTestId("template-apply-small-team").click();
  // The template replaces the implicit allow-all, so it asks first.
  await expect
    .element(page.getByTestId("template-confirm-dialog"))
    .toBeVisible();
  await page.getByTestId("template-confirm-apply").click();
  await expect.element(page.getByTestId("team-card-group:team")).toBeVisible();
  await expect.element(page.getByTestId("tag-card-tag:shared")).toBeVisible();
  expect(
    document.querySelector('[data-testid="resource-access-empty"]'),
  ).toBeNull();
});

test("applying a template replaces the open default rule in the saved Headscale policy", async () => {
  // Fails when the injected open default (*->*:* and its IPv6 twin) survives the template: the
  // saved policy would still let every source reach every destination.
  // Assumption confirmed only by the Docker run: Headscale 0.29.4 accepts an empty
  // group:team together with a tagOwner for tag:shared.
  const observedOperationIds = new Set<OperationId>();
  await renderLogin();
  await connectWithDefaults();
  await resetDockerPolicy("");
  await openAccessSection();
  await commands.clearHeadscaleOperationCalls();

  await expect.element(page.getByTestId("resource-access-empty")).toBeVisible();
  await page.getByTestId("template-apply-small-team").click();
  await expect
    .element(page.getByTestId("template-confirm-removed"))
    .toMatchTextContent("*");
  await page.getByTestId("template-confirm-apply").click();
  await expect.element(page.getByTestId("team-card-group:team")).toBeVisible();
  await expect
    .element(page.getByTestId("open-access-banner"))
    .not.toBeInTheDocument();
  await page.getByTestId("save-policy").click();
  await confirmPolicyPublication();

  const saved = await latestSavedPolicy();
  await expectUiOperationDelta("policy.set", 0, observedOperationIds);
  expect(saved.acls).toEqual([
    { action: "accept", src: ["group:team"], dst: ["tag:shared:22,80,443"] },
  ]);
  const savedAcls = JSON.stringify(saved.acls);
  expect(savedAcls).not.toContain("0.0.0.0/0");
  expect(savedAcls).not.toContain("::/0");

  await resetDockerPolicy("");
});

test("blank policy: edits still trigger the unsaved-changes guard", async () => {
  // Regression guard: `isPolicyDirty` used to short-circuit to `false` whenever
  // `policyDraft` was an empty string, so on a fresh Headscale instance the
  // user could add a team, hit Close, and walk away with the edits silently
  // discarded. After the fix, an empty draft must still participate in dirty
  // detection.
  await renderLogin();
  await connectWithDefaults();
  await resetDockerPolicy("");
  await openAccessSection();

  await expect.element(page.getByTestId("resource-access-empty")).toBeVisible();

  await page.getByTestId("empty-create-team").click();
  await expect.element(page.getByTestId("team-detail-dialog")).toBeVisible();
  inputDomTestId("team-name-input", "ops");
  await page.getByTestId("team-name-confirm").click();
  await expect.element(page.getByTestId("team-members-section")).toBeVisible();

  // Closing the dirty dialog must now route through the unsaved-changes guard.
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByTestId("unsaved-changes-dialog"))
    .toBeVisible();
  await page.getByTestId("unsaved-changes-discard").click();
  await expect
    .poll(() =>
      document.querySelector('[data-testid="save-policy-dirty-badge"]'),
    )
    .toBeNull();
});

test("IP-only rules collapse into the direct-device section", async () => {
  await renderLogin();
  await connectWithDefaults();
  await resetDockerPolicy(
    JSON.stringify({
      acls: [
        { action: "accept", src: ["alice@example.com"], dst: ["10.0.0.1:22"] },
      ],
      groups: {},
      tagOwners: {},
    }),
  );
  await openAccessSection();

  await expect.element(page.getByTestId("ip-rules-section")).toBeVisible();
  expect(document.querySelector('[data-testid^="ip-rule-"]')).toBeTruthy();
  await clickLastByTestIdPrefix("ip-rule-edit-");
  await expect
    .poll(() => document.querySelector('[data-testid^="ip-rule-source-"]'))
    .toBeTruthy();
  await inputLastByTestIdPrefix("ip-rule-source-", "bob@example.com");
  await inputLastByTestIdPrefix("ip-rule-destination-", "10.0.0.2");
  await inputLastByTestIdPrefix("ip-rule-ports-", "443");
  await clickLastByTestIdPrefix("ip-rule-cancel-");
  await expect
    .poll(() => document.querySelector('[data-testid^="ip-rule-edit-form-"]'))
    .toBeNull();
  await clickLastByTestIdPrefix("ip-rule-edit-");
  await expect
    .poll(() => document.querySelector('[data-testid^="ip-rule-source-"]'))
    .toBeTruthy();
  await inputLastByTestIdPrefix("ip-rule-source-", "bob@example.com");
  await inputLastByTestIdPrefix("ip-rule-destination-", "10.0.0.2");
  await inputLastByTestIdPrefix("ip-rule-ports-", "443");
  await clickLastByTestIdPrefix("ip-rule-save-");
  await expect
    .element(page.getByTestId("ip-rules-section"))
    .toMatchTextContent("bob@example.com");
  await clickLastByTestIdPrefix("ip-rule-remove-");
  await page.getByTestId("confirm-remove-policy-item").click();
  await expect
    .poll(() => document.querySelectorAll('[data-testid^="ip-rule-"]').length)
    .toBe(0);
});

test("mobile save button posts a policy update", async () => {
  await renderLogin();
  await connectWithDefaults();
  await page.viewport(360, 768);
  await openAccessSection();
  await commands.clearHeadscaleOperationCalls();

  // Save is disabled on a clean draft, so make an edit first (the fixture is reset per test).
  await expect.element(page.getByTestId("save-policy")).toBeDisabled();
  await clickLastByTestIdPrefix("ip-rule-remove-");
  await page.getByTestId("confirm-remove-policy-item").click();
  await page.getByTestId("save-policy").click();
  await confirmPolicyPublication();
  await expect
    .poll(async () =>
      (await commands.headscaleOperationCalls())?.some(
        (call) => call.id === "policy.set",
      ),
    )
    .toBe(true);
  await latestSavedPolicy();
});

test("does not expose a settings page", async () => {
  await renderLogin();
  await connectWithDefaults();

  expect(document.querySelector('[data-testid="section-settings"]')).toBeNull();
  expect(document.querySelector('[data-testid^="settings-"]')).toBeNull();
  expect(document.querySelector('[data-testid="api-key-1"]')).toBeNull();
});

test("covers server settings API keys and maintenance actions", async () => {
  await renderLogin();
  await connectWithDefaults();
  const fixtureKeys =
    (await request(adopted().read, { endpoint: "listApiKeys" })).apiKeys ?? [];
  const livePrefix = fixtureKeys.find((key) => key.id === "2")?.prefix;
  const oldPrefix = fixtureKeys.find((key) => key.id === "3")?.prefix;
  expect(livePrefix).toBeTruthy();
  expect(oldPrefix).toBeTruthy();
  // The prefix Headscale lists for the session's own key must match what the UI derives from the key itself.
  const sessionPrefix = listedApiKeyPrefix(dockerSettings().apiKey);
  expect(sessionPrefix).toBeTruthy();
  expect(
    fixtureKeys.filter((key) => key.prefix === sessionPrefix),
  ).toHaveLength(1);
  await commands.clearHeadscaleOperationCalls();
  const clipboard = stubClipboard();

  try {
    await openProfileMenu();
    await page.getByTestId("open-server-settings").click();
    await expect
      .element(page.getByTestId("server-settings-dialog"))
      .toBeVisible();
    await selectDomTab("server-tab-api-keys");
    await expect.element(page.getByTestId("api-key-table")).toBeVisible();
    // Only the session's own key carries the marker.
    await expect
      .element(page.getByTestId(`api-key-current-${sessionPrefix}`))
      .toBeVisible();
    expect(
      document
        .querySelector(`[data-testid="api-key-row-${sessionPrefix}"]`)
        ?.contains(
          document.querySelector(
            `[data-testid="api-key-current-${sessionPrefix}"]`,
          ),
        ),
    ).toBe(true);
    expect(
      document.querySelectorAll('[data-testid^="api-key-current-"]'),
    ).toHaveLength(1);
    expect(
      document.querySelector(`[data-testid="api-key-current-${livePrefix}"]`),
    ).toBeNull();
    expect(
      document.querySelector(`[data-testid="api-key-current-${oldPrefix}"]`),
    ).toBeNull();
    const apiKeyListsBeforeRefresh = await operationCount("apikey.list");
    await clickVisibleDomTestId("refresh-api-keys");
    await expect
      .poll(async () => await operationCount("apikey.list"))
      .toBeGreaterThan(apiKeyListsBeforeRefresh);
    await clickVisibleDomTestId("api-key-expiration");
    await userEvent.keyboard("{Escape}");
    await clickVisibleDomTestId("create-api-key-confirm");
    await expect.element(page.getByTestId("created-api-key")).toBeVisible();
    await clickVisibleDomTestId("copy-created-api-key");
    const copiedApiKey = document
      .querySelector('[data-testid="created-api-key"] code')
      ?.textContent?.trim();
    expect(
      Boolean(copiedApiKey && clipboard.writes.includes(copiedApiKey)),
    ).toBe(true);
    await expect
      .poll(async () =>
        (await commands.headscaleOperationCalls())?.some(
          (call) => call.id === "apikey.create",
        ),
      )
      .toBe(true);

    await expect
      .poll(() => visibleText(`api-key-status-${livePrefix}`))
      .toBe(getProductCopy("en-US").statusActive);
    expect(
      document.querySelector<HTMLElement>(
        `[data-testid="api-key-status-${livePrefix}"]`,
      )?.className,
    ).toContain("emerald");

    // Expiring the key this session authenticates with needs an explicit acknowledgement. The dialog is
    // cancelled: the shared session key must never be expired by a test.
    await clickVisibleDomTestId(`api-key-actions-trigger-${sessionPrefix}`);
    await clickVisibleDomTestId(`expire-api-key-${sessionPrefix}`);
    await expect
      .element(page.getByTestId("expire-api-key-dialog"))
      .toBeVisible();
    await expect
      .element(page.getByTestId("api-key-current-warning"))
      .toBeVisible();
    await expect
      .element(page.getByTestId("confirm-api-key-action"))
      .toBeDisabled();
    await clickVisibleDomTestId("api-key-current-ack");
    await expect
      .element(page.getByTestId("confirm-api-key-action"))
      .toBeEnabled();
    await clickVisibleDomTestId("cancel-api-key-action");
    await expect
      .poll(() =>
        document.querySelector('[data-testid="expire-api-key-dialog"]'),
      )
      .toBeNull();
    expect(await operationCount("apikey.expire")).toBe(0);

    await clickVisibleDomTestId(`api-key-actions-trigger-${livePrefix}`);
    await clickVisibleDomTestId(`expire-api-key-${livePrefix}`);
    await expect
      .element(page.getByTestId("expire-api-key-dialog"))
      .toBeVisible();
    // Other keys need no acknowledgement.
    expect(
      document.querySelector('[data-testid="api-key-current-warning"]'),
    ).toBeNull();
    await clickVisibleDomTestId("cancel-api-key-action");
    await expect
      .poll(() =>
        document.querySelector('[data-testid="expire-api-key-dialog"]'),
      )
      .toBeNull();
    await clickVisibleDomTestId(`api-key-actions-trigger-${livePrefix}`);
    await clickVisibleDomTestId(`expire-api-key-${livePrefix}`);
    await expect
      .element(page.getByTestId("expire-api-key-dialog"))
      .toBeVisible();
    await clickVisibleDomTestId("confirm-api-key-action");
    await waitForActionFinished("api-key-action");
    await expect
      .poll(async () =>
        (await commands.headscaleOperationCalls())?.some(
          (call) => call.id === "apikey.expire",
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        document.querySelector('[data-testid="expire-api-key-dialog"]'),
      )
      .toBeNull();
    await expect
      .poll(async () => {
        const key = (
          (await request(adopted().read, { endpoint: "listApiKeys" }))
            .apiKeys ?? []
        ).find((candidate) => candidate.prefix === livePrefix);
        return Boolean(
          key?.expiration && Date.parse(key.expiration) <= Date.now() + 5_000,
        );
      })
      .toBe(true);
    await expect
      .poll(() => visibleText(`api-key-status-${livePrefix}`))
      .toBe(getProductCopy("en-US").expiredOnly);
    expect(
      document.querySelector<HTMLElement>(
        `[data-testid="api-key-status-${livePrefix}"]`,
      )?.className,
    ).toContain("rose");

    await clickVisibleDomTestId(`api-key-actions-trigger-${oldPrefix}`);
    await clickVisibleDomTestId(`delete-api-key-${oldPrefix}`);
    await expect
      .element(page.getByTestId("delete-api-key-dialog"))
      .toBeVisible();
    await clickVisibleDomTestId("confirm-api-key-action");
    await waitForActionFinished("api-key-action");
    await expect
      .poll(() =>
        document.querySelector('[data-testid="delete-api-key-dialog"]'),
      )
      .toBeNull();
    await expect
      .poll(async () =>
        (await commands.headscaleOperationCalls())?.some(
          (call) => call.id === "apikey.delete",
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        document.querySelector(`[data-testid="api-key-row-${oldPrefix}"]`),
      )
      .toBeNull();

    await selectDomTab("server-tab-maintenance");
    await expect
      .element(page.getByTestId("server-maintenance-settings"))
      .toBeVisible();
    await page.getByTestId("open-backfill-node-ips").click();
    await expect
      .element(page.getByTestId("backfill-node-ips-dialog"))
      .toBeVisible();
    await page.getByTestId("cancel-backfill-node-ips").click();
    await page.getByTestId("open-backfill-node-ips").click();
    await page.getByTestId("backfill-node-ips-confirmed").click();
    await page.getByTestId("confirm-backfill-node-ips").click();
    await expect
      .poll(async () =>
        (await commands.headscaleOperationCalls())?.some(
          (call) => call.id === "node.backfillIps",
        ),
      )
      .toBe(true);
    await expect
      .poll(
        async () =>
          (await commands.headscaleOperationCalls())
            ?.filter((call) => call.id === "node.backfillIps")
            .at(-1)?.payload,
      )
      .toEqual({ confirmed: true });
    await expect
      .element(page.getByTestId("backfill-node-ips-result"))
      .toBeVisible();

    await selectDomTab("server-tab-security");
    await expect.element(page.getByTestId("security-settings")).toBeVisible();
    expect(
      document.querySelector('[data-testid="security-enable-passphrase"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="security-disable-passphrase"]'),
    ).toBeNull();
    await page.getByTestId("security-change-passphrase").click();
    await page.getByTestId("security-change-cancel").click();
    await page.getByTestId("security-change-passphrase").click();
    await page
      .getByTestId("security-current-passphrase")
      .fill(profilePassword("Docker Headscale"));
    await page.getByTestId("security-change-new-passphrase").fill("beta-pass");
    await page
      .getByTestId("security-change-confirm-passphrase")
      .fill("beta-pass");
    await page.getByTestId("security-change-submit").click();
    await expect.element(page.getByTestId("profile-picker")).toBeVisible();
    expect(session().auth.getSessionSnapshot()?.status).toBe("locked");
    await commands.clearHeadscaleOperationCalls();
    await page.getByTestId("profile-option-Docker Headscale").click();
    await page
      .getByTestId("unlock-passphrase")
      .fill(profilePassword("Docker Headscale"));
    await page.getByTestId("unlock-submit").click();
    await expect.element(page.getByTestId("unlock-error")).toBeVisible();
    expect(await commands.headscaleOperationCalls()).toEqual([]);
    await page.getByTestId("unlock-passphrase").fill("beta-pass");
    await page.getByTestId("unlock-submit").click();
    await expect.element(page.getByTestId("section-home")).toBeVisible();
    await openProfileMenu();
    await page.getByTestId("open-server-settings").click();
    await expect
      .element(page.getByTestId("server-settings-dialog"))
      .toBeVisible();
    await selectDomTab("server-tab-security");
    await page.getByTestId("security-clear-all").click();
    await page.getByTestId("security-clear-all-cancel").click();
  } finally {
    clipboard.restore();
  }
});

test("encrypts API keys at rest", async () => {
  await renderLogin();

  await page.getByTestId("profile-option-new").click();
  await expect.element(page.getByTestId("connect-form")).toBeVisible();
  await page.getByTestId("connect-profile-name").fill("Secure");
  await fillConnection();
  await page.getByTestId("connect-submit").click();
  await expect.element(page.getByTestId("profile-row-Secure")).toBeVisible();

  // IndexedDB row exists with an encrypted ApiKeySecret, never the raw bearer token.
  const idbProfiles = await idbGetAll(STORE_PROFILES);
  expect(idbProfiles).toHaveLength(1);
  const stored = idbProfiles[0] as {
    credentialVersion: string;
    apiKey: { v: number; scheme: string; iv: string; ct: string };
  };
  expect(stored.apiKey).toBeTypeOf("object");
  expect(stored.apiKey.v).toBe(2);
  expect(stored.apiKey.scheme).toBe("password");
  expect(typeof stored.apiKey.iv).toBe("string");
  expect(typeof stored.apiKey.ct).toBe("string");
  const version = await idbGet<VaultVersion>(STORE_META, VAULT_STATE_KEY);
  expect(stored).toMatchObject({ keyEpoch: version?.keyEpoch });
  expect(stored.credentialVersion).toBeTypeOf("string");
  expect(JSON.stringify(stored).includes(dockerSettings().apiKey)).toBe(false);
  expect(JSON.stringify(stored).includes(profilePassword("Secure"))).toBe(
    false,
  );
  await unlockProfile("Secure");
  await expect.element(page.getByTestId("section-home")).toBeVisible();
});

test("covers task navigation and the client-device setup branch", async () => {
  await renderLogin();
  await connectWithDefaults();
  const registrationKey = "hskey-authreq-abcdefghijklmnopqrstuvwx";
  await request(adopted().write, {
    endpoint: "debugCreateNode",
    input: {
      user: "alice",
      key: registrationKey,
      name: "pending-browser-device",
      routes: [],
    },
  });

  expect(document.body.textContent).not.toContain("Quick actions");
  expect(document.querySelector('[data-testid="quick-invite"]')).toBeNull();
  expect(document.querySelector('[data-testid="quick-devices"]')).toBeNull();
  expect(document.querySelector('[data-testid="quick-routes"]')).toBeNull();

  await page.getByTestId("section-members").click();
  expect(
    document.querySelector('[data-testid="invite-users-task"]'),
  ).toBeNull();
  expect(
    document.querySelector('[data-testid="review-routes-task"]'),
  ).toBeNull();
  await openCreateMemberDialog();
  await page.getByTestId("cancel-create-member").click();
  await page.getByTestId("section-routes").click();
  await expect.element(page.getByTestId("route-node-2")).toBeVisible();
  await page.getByTestId("route-machine-link-2").click();
  await expect
    .element(page.getByTestId("device-search"))
    .toHaveValue("edge-router");
  await expect.element(page.getByTestId("device-2")).toBeVisible();
  await page.getByTestId("section-routes").click();
  expect(
    document.querySelector('[data-testid="route-user-link-2"]'),
  ).toBeNull();
  const routeNodeText =
    document.querySelector('[data-testid="route-node-2"]')?.textContent ?? "";
  expect(routeNodeText).not.toContain("tagged-devices");
  expect(routeNodeText).not.toMatch(/managed by tags/i);

  await page.getByTestId("section-devices").click();
  await page.getByTestId("add-device-toggle").click();
  await expect.element(page.getByTestId("add-device-dialog")).toBeVisible();
  expect(
    document.querySelector('[data-testid="add-device-stepper"]'),
  ).toBeNull();
  await expect.element(page.getByTestId("add-device-options")).toBeVisible();
  await page.getByTestId("add-pending-node").click();
  await expect
    .element(page.getByTestId("pending-registration-flow"))
    .toBeVisible();
  await page.getByTestId("add-device-prev").click();
  await expect.element(page.getByTestId("add-device-options")).toBeVisible();
  await page.getByTestId("add-pending-node").click();
  await expect
    .element(page.getByTestId("pending-registration-flow"))
    .toBeVisible();
  await selectNamedRegistrationUser("alice");
  await expect.element(page.getByTestId("pending-node-key")).toHaveValue("");
  await page.getByTestId("pending-node-key").fill(registrationKey);
  await confirmDeviceRegistration("https://headscale.example");
  const authRegistrationsBeforeClick = await operationCount("auth.register");
  await page.getByTestId("register-pending-node").click();
  await expect
    .poll(
      async () =>
        (await operationCount("auth.register")) > authRegistrationsBeforeClick,
    )
    .toBe(true);
  await expect
    .element(page.getByTestId("registration-result"))
    .toMatchTextContent("pending-browser-device");
  // The node belongs to the user the select showed when Register was pressed.
  expect(
    (
      (await request(adopted().read, { endpoint: "listNodes", input: {} }))
        .nodes ?? []
    ).find(
      (node) =>
        node.givenName === "pending-browser-device" ||
        node.name === "pending-browser-device",
    )?.user?.name,
  ).toBe("alice");
  await page.getByTestId("add-device-finish").click();
  await page.getByTestId("add-device-toggle").click();
  await expect.element(page.getByTestId("add-device-options")).toBeVisible();
  await page.getByTestId("add-client-device").click();
  await expect.element(page.getByTestId("device-setup-flow")).toBeVisible();
  expect(
    document
      .querySelector('[data-testid="device-setup-flow"]')
      ?.closest('[data-testid="add-device-dialog"]'),
  ).toBeTruthy();
  await expect.element(page.getByTestId("setup-device-step")).toBeVisible();
  await expectTagSelection("setup-tags", []);
  // A personal client is not ephemeral by default: Headscale would delete it after it goes offline.
  await expect.element(page.getByTestId("setup-ephemeral")).not.toBeChecked();
  await clickDomTestId("setup-ephemeral");
  await expect.element(page.getByTestId("setup-ephemeral")).toBeChecked();
  await clickDomTestId("setup-ephemeral");
  await expect.element(page.getByTestId("setup-ephemeral")).not.toBeChecked();
  await clickDomTestId("setup-exit-node");
  await clickDomTestId("setup-tags-enabled");
  await expectTagSelection("setup-tags", ["tag:server"]);
  await page.getByTestId("setup-tags-remove-tag:server").click();
  await addKeyTag("setup-tags", "tag:client");
  await expectTagSelection("setup-tags", ["tag:client"]);
  await page.getByTestId("add-device-next").click();
  await expect.element(page.getByTestId("setup-auth-key-step")).toBeVisible();
  await expect.element(page.getByTestId("setup-reusable")).not.toBeChecked();
  await clickDomTestId("setup-reusable");
  await expect.element(page.getByTestId("setup-reusable")).toBeChecked();
  await page.getByTestId("setup-expiration-increment").click();
  await expect.element(page.getByTestId("setup-expiration")).toHaveValue("8");
  await page.getByTestId("setup-expiration-decrement").click();
  await expect.element(page.getByTestId("setup-expiration")).toHaveValue("7");
  await page.getByTestId("setup-expiration").fill("12");
  await expect.element(page.getByTestId("setup-expiration")).toHaveValue("12");
  await page.getByTestId("add-device-step-preferences").click();
  await expect.element(page.getByTestId("setup-device-step")).toBeVisible();
  await expectTagSelection("setup-tags", ["tag:client"]);
  await page.getByTestId("setup-tags-manage").click();
  await expect.element(page.getByTestId("device-labels-section")).toBeVisible();
});

test("copies generated auth keys and install commands", async () => {
  await renderLogin();
  await connectWithDefaults();
  const clipboard = stubClipboard();

  try {
    await page.getByTestId("section-invites").click();
    await page.getByTestId("open-create-invite").click();
    await page.getByTestId("create-invite").click();
    await expect.element(page.getByTestId("created-invite")).toBeVisible();
    const generatedKey = document
      .querySelector('[data-testid="created-invite"] code')
      ?.textContent?.trim();
    expect(generatedKey).toBeTruthy();
    await page.getByTestId("copy-created-invite").click();
    await page.getByTestId("copy-created-install-command").click();
    // 登录控制端点与 API 地址可以不同，并且跨页面保留；这里只生成文本，不访问该域名。
    await page
      .getByTestId("invite-login-server")
      .fill("https://control.example.test/");
    await page.getByTestId("copy-created-install-command").click();
    expect(
      clipboard.writes.includes(
        `tailscale up --login-server 'https://control.example.test' --authkey '${generatedKey}'`,
      ),
    ).toBe(true);

    await page.getByTestId("section-devices").click();
    await page.getByTestId("add-device-toggle").click();
    await expect.element(page.getByTestId("discard-key-dialog")).toBeVisible();
    await page.getByTestId("discard-key-cancel").click();
    expect(
      session().deviceSetup.getSnapshot().lastCreatedInvite === generatedKey,
    ).toBe(true);
    await page.getByTestId("add-device-toggle").click();
    await page.getByTestId("discard-key-confirm").click();
    await expect.element(page.getByTestId("add-device-dialog")).toBeVisible();
    await page.getByTestId("add-linux-device").click();
    // The exit-node switch drives the generated command.
    await clickDomTestId("setup-exit-node");
    await page.getByTestId("add-device-next").click();
    await page.getByTestId("add-device-next").click();
    // Generating creates the key directly from the wizard's options (no second create dialog).
    await page.getByTestId("generate-install-script").click();
    await expect
      .element(page.getByTestId("setup-login-server"))
      .toHaveValue("https://control.example.test/");
    await page.getByTestId("setup-login-server").fill(dockerSettings().baseUrl);
    // Fails when the wizard command lacks --login-server (it only joined the default control server).
    await expect
      .element(page.getByTestId("created-invite"))
      .toMatchTextContent(
        `tailscale up --login-server '${dockerSettings().baseUrl}'`,
      );
    await expect
      .element(page.getByTestId("created-invite"))
      .toMatchTextContent("--advertise-exit-node");
    await page.getByTestId("copy-setup-install-command").click();

    const setupKey = document
      .querySelector('[data-testid="created-invite"] code')
      ?.textContent?.trim();
    // Two different generated keys; equal or missing keys would make the clipboard checks vacuous.
    expect(setupKey).toBeTruthy();
    expect(setupKey).not.toBe(generatedKey);
    expect(
      Boolean(generatedKey && clipboard.writes.includes(generatedKey)),
    ).toBe(true);
    const expectedCommand = (key: string | undefined, suffix = "") =>
      `tailscale up --login-server '${dockerSettings().baseUrl}' --authkey '${key}'${suffix}`;
    expect(clipboard.writes.includes(expectedCommand(generatedKey))).toBe(true);
    expect(
      clipboard.writes.includes(
        expectedCommand(setupKey, " --advertise-exit-node"),
      ),
    ).toBe(true);
    expect(
      clipboard.writes.filter((value) => value.includes("tailscale up")).length,
    ).toBe(3);
  } finally {
    clipboard.restore();
  }
});

test("keeps every core function usable on mobile", async () => {
  await page.viewport(390, 844);
  await renderLogin();
  await page.getByTestId("profile-option-new").click();
  await expect.element(page.getByTestId("connect-form")).toBeVisible();
  expectNoHorizontalOverflow();

  await connectWithDefaults();
  await expect.element(page.getByTestId("profile-menu-trigger")).toBeVisible();
  expectAppHeader();
  expectResponsiveTabMenu();
  expectNoHorizontalOverflow();

  for (const section of [
    "devices",
    "members",
    "invites",
    "routes",
    "access",
  ] as const) {
    await selectSectionTab(section);
    expectNoHorizontalOverflow();
  }

  await selectSectionTab("members");
  await openCreateMemberDialog();
  await page.getByTestId("member-name").fill("mobile");
  await page.getByTestId("create-member").click();
  await expect.element(page.getByTestId("member-mobile")).toBeVisible();
  await clickVisibleDomTestId("member-actions-trigger-mobile-mobile");
  await clickVisibleDomTestId("rename-member-mobile-mobile");
  await expect.element(page.getByTestId("rename-member-dialog")).toBeVisible();
  await page.getByTestId("rename-member-cancel").click();
  await expect
    .poll(() => document.querySelector('[data-testid="rename-member-dialog"]'))
    .toBeNull();
  await expect
    .element(page.getByTestId("member-actions-trigger-mobile-mobile"))
    .toBeVisible();
  await clickVisibleDomTestId("member-actions-trigger-mobile-mobile");
  await clickVisibleDomTestId("view-member-details-mobile-mobile");
  await expect
    .element(page.getByTestId("user-detail-dialog"))
    .toMatchTextContent("mobile");
  await closeLayerWithEscape("user-detail-dialog");
  await clickVisibleDomTestId("member-actions-trigger-mobile-mobile");
  await clickVisibleDomTestId("view-member-machines-mobile-mobile");
  await expect.element(page.getByTestId("owner-filter-chip")).toBeVisible();
  await selectSectionTab("members");
  await clickVisibleDomTestId("member-actions-trigger-mobile-mobile");
  await clickVisibleDomTestId("create-invite-for-member-mobile-mobile");
  await expect.element(page.getByTestId("invite-create-dialog")).toBeVisible();
  await page.getByTestId("cancel-create-invite").click();
  await expect.element(page.getByTestId("member-mobile")).toBeVisible();
  await clickVisibleDomTestId("member-actions-trigger-mobile-mobile");
  await clickVisibleDomTestId("delete-member-mobile-mobile");
  await expect.element(page.getByTestId("delete-member-dialog")).toBeVisible();
  await page.getByTestId("confirm-delete-member").click();
  await waitForActionFinished("delete-member");
  await expect
    .poll(() => document.querySelector('[data-testid="delete-member-dialog"]'))
    .toBeNull();
  await expect
    .poll(() => document.querySelector('[data-testid="member-mobile"]'))
    .toBeNull();
  expectNoHorizontalOverflow();

  inputDomTestId("user-search", "charlie");
  await expect.element(page.getByTestId("member-charlie")).toBeVisible();
  await clickVisibleDomTestId("member-actions-trigger-mobile-charlie");
  await clickVisibleDomTestId("assign-member-groups-mobile-charlie");
  await expect
    .element(page.getByTestId("assign-user-groups-dialog"))
    .toBeVisible();
  await clickVisibleDomTestId("assign-user-groups-cancel");
  await expect
    .poll(() =>
      document.querySelector('[data-testid="assign-user-groups-dialog"]'),
    )
    .toBeNull();
  await expect
    .element(page.getByTestId("member-actions-trigger-mobile-charlie"))
    .toBeVisible();
  await clickVisibleDomTestId("member-actions-trigger-mobile-charlie");
  await clickVisibleDomTestId("assign-member-tags-mobile-charlie");
  await expect
    .element(page.getByTestId("assign-user-tags-dialog"))
    .toBeVisible();
  await clickVisibleDomTestId("assign-user-tags-cancel");
  inputDomTestId("user-search", "");

  await selectSectionTab("invites");
  await page.getByTestId("open-create-invite").click();
  await addKeyTag("invite-tags", "tag:mobile");
  await page.getByTestId("invite-ephemeral").click();
  await page.getByTestId("create-invite").click();
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  expectNoHorizontalOverflow();

  await selectSectionTab("devices");
  if (document.querySelector('[data-testid="clear-machine-filters"]')) {
    await clickDomTestId("clear-machine-filters");
  }
  await expect.element(page.getByTestId("device-1")).toBeVisible();
  await expectMachinesWorkbench();
  await page.getByTestId("device-search").fill("alice");
  await clickDomTestId("machine-actions-trigger-mobile-1");
  await clickVisibleDomTestId("view-node-details-action-mobile-1");
  await expect
    .element(page.getByTestId("device-detail-dialog"))
    .toMatchTextContent("alice-laptop");
  await closeLayerWithEscape("device-detail-dialog");
  await page.getByTestId("device-search").fill("edge");
  await clickDomTestId("machine-actions-trigger-mobile-2");
  await clickVisibleDomTestId("view-node-routes-action-mobile-2");
  await expect.element(page.getByTestId("route-node-2")).toBeVisible();
  await selectSectionTab("devices");
  await page.getByTestId("device-search").fill("alice");
  await clickDomTestId("machine-actions-trigger-mobile-1");
  await clickVisibleDomTestId("expire-node-action-mobile-1");
  await expect.element(page.getByTestId("expire-node-dialog")).toBeVisible();
  await page.getByTestId("expire-node-cancel").click();
  // Expire and then disable the expiry again, which leaves the node as later steps expect it.
  await clickDomTestId("machine-actions-trigger-mobile-1");
  await clickVisibleDomTestId("expire-node-action-mobile-1");
  await page.getByTestId("expire-node-confirm").click();
  await waitForActionFinished("expire-node");
  await expect
    .element(page.getByTestId("expire-node-dialog"))
    .not.toBeInTheDocument();
  const mobileExpiresBeforeDisable = await operationCount("node.expire");
  await clickDomTestId("machine-actions-trigger-mobile-1");
  await clickVisibleDomTestId("disable-expiry-node-action-mobile-1");
  await expect.element(page.getByTestId("expire-node-dialog")).toBeVisible();
  await page.getByTestId("expire-node-confirm").click();
  await waitForActionFinished("expire-node");
  await expect
    .element(page.getByTestId("expire-node-dialog"))
    .not.toBeInTheDocument();
  expect(await operationCount("node.expire")).toBe(
    mobileExpiresBeforeDisable + 1,
  );
  await clickDomTestId("machine-actions-trigger-mobile-1");
  await clickVisibleDomTestId("remove-node-action-mobile-1");
  await expect.element(page.getByTestId("remove-node-dialog")).toBeVisible();
  await page.getByTestId("remove-node-cancel").click();
  await clickDomTestId("machine-actions-trigger-mobile-1");
  await expect
    .element(page.getByTestId("machine-actions-menu-mobile-1"))
    .toBeVisible();
  await clickVisibleDomTestId("rename-node-action-mobile-1");
  await expect.element(page.getByTestId("rename-node-dialog")).toBeVisible();
  await page.getByTestId("rename-node-dialog-input").fill("alice-phone");
  await clickDomTestId("rename-node-confirm");
  await waitForActionFinished("rename-node");
  await expect
    .poll(() => document.querySelector('[data-testid="rename-node-dialog"]'))
    .toBeNull();
  await expect
    .element(page.getByTestId("device-1"))
    .toMatchTextContent("alice-phone");
  await clickDomTestId("machine-actions-trigger-mobile-1");
  await expect
    .element(page.getByTestId("machine-actions-menu-mobile-1"))
    .toBeVisible();
  await clickVisibleDomTestId("edit-node-tags-action-mobile-1");
  await expect.element(page.getByTestId("node-tags-dialog")).toBeVisible();
  await page.getByTestId("node-tags-cancel").click();
  expectNoHorizontalOverflow();

  await selectSectionTab("routes");
  await page.getByTestId("approve-routes-2").click();
  await expect.element(page.getByTestId("approve-routes-dialog")).toBeVisible();
  await expect
    .element(page.getByTestId("approve-routes-target-0"))
    .toBeVisible();
  await page.getByTestId("approve-routes-cancel").click();
  expect(
    (await commands.headscaleOperationCalls())?.some(
      (call) => call.id === "node.setApprovedRoutes",
    ),
  ).toBe(false);
  await page.getByTestId("approve-routes-2").click();
  await expect.element(page.getByTestId("approve-routes-dialog")).toBeVisible();
  await page.getByTestId("approve-routes-confirm").click();
  await waitForActionFinished("approve-routes");
  await expect
    .poll(() => document.querySelector('[data-testid="approve-routes-dialog"]'))
    .toBeNull();
  await expect
    .poll(async () =>
      (await commands.headscaleOperationCalls())?.some(
        (call) => call.id === "node.setApprovedRoutes",
      ),
    )
    .toBe(true);
  await expect
    .poll(
      () =>
        document.querySelectorAll('[data-testid^="pending-route-2-"]').length,
    )
    .toBe(0);
  expect(
    document.querySelector('[data-testid="pending-routes-list-2"]'),
  ).toBeNull();
  await expect
    .poll(() =>
      Array.from(
        document.querySelectorAll('[data-testid^="route-approved-2-"]'),
        (route) => route.textContent?.trim(),
      ).sort(),
    )
    .toEqual(["0.0.0.0/0", "10.42.0.0/16", "::/0"]);
  expectNoHorizontalOverflow();

  await selectSectionTab("access");
  await expect.element(page.getByTestId("teams-section")).toBeVisible();
  await expect.element(page.getByTestId("device-labels-section")).toBeVisible();
  await commands.clearHeadscaleOperationCalls();
  // 未修改策略时不可保存；通过移动端新增规则后，再验证真实的策略写入。
  await expect.element(page.getByTestId("save-policy")).toBeDisabled();
  await page.getByTestId("add-ip-rule").click();
  await page.getByTestId("ip-rule-source-new").fill("*");
  await page.getByTestId("ip-rule-destination-new").fill("100.64.0.99");
  await page.getByTestId("ip-rule-ports-new").fill("443");
  await page.getByTestId("ip-rule-save-new").click();
  await expect.element(page.getByTestId("save-policy")).toBeEnabled();
  await page.getByTestId("save-policy").click();
  await confirmPolicyPublication();
  expect((await latestSavedPolicy()).acls).toContainEqual({
    action: "accept",
    src: ["*"],
    dst: ["100.64.0.99:443"],
  });
  await expect
    .poll(async () =>
      (await commands.headscaleOperationCalls())?.some(
        (call) => call.id === "policy.set",
      ),
    )
    .toBe(true);
  expectNoHorizontalOverflow();
});

test("defaults to English and switches through every supported BCP47 locale", async () => {
  await renderLogin();

  const loginLocales = new Set<string>();
  for (const code of SUPPORTED_LOCALES) {
    await page.getByTestId("locale-select").click();
    await expect
      .element(page.getByTestId(`locale-option-${code}`))
      .toBeVisible();
    await page.getByTestId(`locale-option-${code}`).click();
    await expect.poll(() => document.documentElement.lang).toBe(code);
    await expect
      .poll(() => document.documentElement.dir)
      .toBe(LOCALE_META[code].dir);
    await expect.poll(() => readIdbSetting("locale")).toBe(code);
    loginLocales.add(code);
  }
  expect([...loginLocales]).toEqual([...SUPPORTED_LOCALES]);

  await page.getByTestId("locale-select").click();
  await page.getByTestId("locale-option-en-US").click();
  await expect.poll(() => readIdbSetting("locale")).toBe("en-US");
  await connectWithDefaults();

  expect(document.documentElement.lang).toBe("en-US");
  await expect.element(page.getByTestId("section-devices")).toBeVisible();

  await chooseProfileMenuOption("locale-option-zh-Hans");
  await expectProfileMenuRadioChecked("locale-option-zh-Hans");
  await expect
    .element(page.getByTestId("section-devices"))
    .toHaveTextContent("设备");
  await page.getByTestId("section-members").click();
  await expect.element(page.getByTestId("member-devices-header")).toBeVisible();
  expect(
    document
      .querySelector('[data-testid="member-devices-header"]')
      ?.textContent?.trim(),
  ).toBe("设备");
  expect(
    document.querySelector('[data-testid="user-table"]')?.textContent,
  ).not.toContain("台设备");
  inputDomTestId("user-search", "no-such-user");
  expect(
    document.querySelector('[data-testid="member-tagged-devices"]'),
  ).toBeNull();
  await expect
    .element(page.getByTestId("user-table"))
    .toMatchTextContent("没有匹配筛选条件的用户");

  await chooseProfileMenuOption("locale-option-zh-Hant-TW");
  await expect.poll(() => document.documentElement.lang).toBe("zh-Hant-TW");
  await expect.poll(() => document.documentElement.dir).toBe("ltr");
  await expect
    .element(page.getByTestId("section-devices"))
    .toHaveTextContent("裝置");
  expect(
    document
      .querySelector('[data-testid="member-devices-header"]')
      ?.textContent?.trim(),
  ).toBe("裝置");
  await expect
    .element(page.getByTestId("user-table"))
    .toMatchTextContent("沒有相符篩選條件的使用者");
  inputDomTestId("user-search", "");

  const appLocales = new Set<string>();
  for (const code of SUPPORTED_LOCALES) {
    await chooseProfileMenuOption(`locale-option-${code}`);
    await expect.poll(() => document.documentElement.lang).toBe(code);
    await expect
      .poll(() => document.documentElement.dir)
      .toBe(LOCALE_META[code].dir);
    await expect.poll(() => readIdbSetting("locale")).toBe(code);

    for (const section of [
      "home",
      "devices",
      "members",
      "invites",
      "routes",
      "access",
    ] as const) {
      await selectSectionTab(section);
      await expect
        .element(page.getByTestId(`section-${section}`))
        .toHaveTextContent(getProductCopy(code).nav[section]);

      if (section === "home") {
        expect(
          document
            .querySelector('[data-testid="refresh-data"]')
            ?.getAttribute("title"),
        ).toBe(getProductCopy(code).refreshData);
      } else if (section === "devices") {
        await expect
          .element(page.getByTestId("add-device-toggle"))
          .toHaveTextContent(getProductCopy(code).addDevice);
      } else if (section === "members") {
        await expect
          .element(page.getByTestId("open-create-member"))
          .toHaveTextContent(getProductCopy(code).addMember);
      } else if (section === "invites") {
        await expect
          .element(page.getByTestId("open-create-invite"))
          .toHaveTextContent(getProductCopy(code).createInvite);
      } else if (section === "routes") {
        await expect
          .element(page.getByTestId("approve-routes-2"))
          .toHaveTextContent(getProductCopy(code).approveAll);
      } else {
        await expect
          .element(page.getByTestId("save-policy"))
          .toHaveTextContent(getProductCopy(code).policyPublishAll);
      }
    }

    await selectSectionTab("members");
    await openCreateMemberDialog();
    await expect
      .element(page.getByTestId("member-create-dialog"))
      .toMatchTextContent(getProductCopy(code).createMember);
    await page.getByTestId("cancel-create-member").click();
    await expect
      .poll(() =>
        document.querySelector('[data-testid="member-create-dialog"]'),
      )
      .toBeNull();
    appLocales.add(code);
  }
  expect([...appLocales]).toEqual([...SUPPORTED_LOCALES]);

  await expect
    .element(page.getByTestId("section-devices"))
    .toHaveTextContent("الأجهزة");
  expect(document.documentElement.dir).toBe("rtl");

  await page.getByTestId("section-invites").click();
  await page.getByTestId("open-create-invite").click();
  await expect.element(page.getByTestId("invite-create-dialog")).toBeVisible();
  await page.getByTestId("invite-expiration").click();
  await expect
    .element(page.getByTestId("invite-expiration-time-label"))
    .toHaveTextContent("الوقت");

  const arabicHour = new Intl.NumberFormat("ar", {
    minimumIntegerDigits: 2,
    useGrouping: false,
  }).format(7);
  const hourSelect = document.querySelector<HTMLSelectElement>(
    '[data-testid="invite-expiration-hour"]',
  );
  expect(
    hourSelect?.querySelector('option[value="07"]')?.textContent?.trim(),
  ).toBe(arabicHour);
  expectNoHorizontalOverflow();
}, 120_000);

test("adapts every main page and shared controls for Arabic RTL", async () => {
  await renderLogin();

  await page.getByTestId("locale-select").click();
  await page.getByTestId("locale-option-ar").click();
  await expect.poll(() => document.documentElement.lang).toBe("ar");
  await expect.poll(() => document.documentElement.dir).toBe("rtl");
  await expect.element(page.getByTestId("profile-picker")).toBeVisible();
  expectNoHorizontalOverflow();

  await page.getByTestId("profile-option-new").click();
  await expect.element(page.getByTestId("connection-dialog")).toBeVisible();
  const connectionHeader = document.querySelector<HTMLElement>(
    '[data-testid="connection-dialog"] [data-slot="dialog-header"]',
  );
  expect(connectionHeader).toBeTruthy();
  expectTextAlignsToStart(connectionHeader as HTMLElement);
  expect(
    document.querySelector(
      '[data-testid="connection-dialog"] [data-slot="dialog-close"]',
    ),
  ).toBeNull();
  await closeLayerWithEscape("connection-dialog");

  await connectWithDefaults();
  expectAppHeader();
  expectResponsiveTabMenu();
  expectNoHorizontalOverflow();

  await selectSectionTab("home");
  await expect.element(page.getByTestId("refresh-data")).toBeVisible();
  expect(
    document
      .querySelector('[data-testid="refresh-data"]')
      ?.getAttribute("title"),
  ).toBe("تحديث البيانات");
  await expect
    .element(page.getByTestId("section-home"))
    .toHaveTextContent("نظرة عامة");
  expectNoHorizontalOverflow();

  await selectSectionTab("devices");
  await expect.element(page.getByTestId("machines-workbench")).toBeVisible();
  await expect.element(page.getByTestId("machine-list")).toBeVisible();
  const deviceCell = document.querySelector<HTMLElement>(
    '[data-testid="machine-list"] td',
  );
  expect(deviceCell).toBeTruthy();
  expectTextAlignsToStart(deviceCell as HTMLElement);
  expect(
    document
      .querySelector('[data-testid^="device-owner-link-"] bdi')
      ?.getAttribute("dir"),
  ).toBe("auto");
  expect(
    document
      .querySelector('[data-testid^="device-pending-route-"] bdi')
      ?.getAttribute("dir"),
  ).toBe("ltr");
  expectNativeSelectIconMirrorsInlineEnd("machine-filter");
  // Addresses and CIDRs keep left-to-right order inside the right-to-left page ("0/::" symptom).
  expectTestIdNetworkTokensLtr("machine-list");
  await page.getByTestId("device-detail-link-1").click();
  await expect.element(page.getByTestId("device-detail-dialog")).toBeVisible();
  expectTestIdNetworkTokensLtr("device-detail-dialog");
  await expect
    .element(
      page
        .getByTestId("device-detail-dialog")
        .getByRole("button", { name: "إغلاق" }),
    )
    .toBeVisible();
  expectDialogMirrorsInlineEnd("device-detail-dialog");
  await closeLayerWithEscape("device-detail-dialog");
  await page.getByTestId("add-device-toggle").click();
  await expect.element(page.getByTestId("add-device-dialog")).toBeVisible();
  expectDialogMirrorsInlineEnd("add-device-dialog");
  await page.getByTestId("add-client-device").click();
  await expect.element(page.getByTestId("device-setup-flow")).toBeVisible();
  expectDialogMirrorsInlineEnd("add-device-dialog");
  await page.getByTestId("add-device-next").click();
  await expect.element(page.getByTestId("setup-auth-key-step")).toBeVisible();
  expectSwitchThumbMirrorsCurrentState("setup-reusable");
  await page.getByTestId("setup-reusable").click();
  await expect.element(page.getByTestId("setup-reusable")).toBeChecked();
  expectSwitchThumbMirrorsCurrentState("setup-reusable");
  await closeLayerWithEscape("add-device-dialog");
  expectNoHorizontalOverflow();

  await selectSectionTab("members");
  await expect.element(page.getByTestId("user-table")).toBeVisible();
  await page.getByTestId("open-create-member").click();
  await expect.element(page.getByTestId("member-create-dialog")).toBeVisible();
  expectDialogMirrorsInlineEnd("member-create-dialog");
  await closeLayerWithEscape("member-create-dialog");
  expectNoHorizontalOverflow();

  await selectSectionTab("invites");
  await expect.element(page.getByTestId("invite-table")).toBeVisible();
  expect(
    document
      .querySelector('[data-testid="invite-table"] code')
      ?.getAttribute("dir"),
  ).toBe("ltr");
  expectNativeSelectIconMirrorsInlineEnd("invite-filter");
  await page.getByTestId("open-create-invite").click();
  await expect.element(page.getByTestId("invite-create-dialog")).toBeVisible();
  expectDialogMirrorsInlineEnd("invite-create-dialog");
  await page.getByTestId("invite-expiration").click();
  expectNativeSelectIconMirrorsInlineEnd("invite-expiration-hour");
  expectNoHorizontalOverflow();
  await closeLayerWithEscape("invite-create-dialog");

  await selectSectionTab("routes");
  await expect.element(page.getByTestId("route-node-2")).toBeVisible();
  // Node 2 advertises 10.42.0.0/16, 0.0.0.0/0 and ::/0 on the fixture.
  expectTestIdNetworkTokensLtr("route-node-2", 3);
  await page.getByTestId("approve-route-2-0").click();
  await expect.element(page.getByTestId("approve-route-dialog")).toBeVisible();
  const alertHeader = document.querySelector<HTMLElement>(
    '[data-slot="alert-dialog-header"]',
  );
  expect(alertHeader).toBeTruthy();
  expectTextAlignsToStart(alertHeader as HTMLElement);
  await page.getByTestId("approve-route-cancel").click();
  await expect
    .element(page.getByTestId("approve-route-dialog"))
    .not.toBeInTheDocument();
  // The revoke dialog mirrors too and fits a phone; it is cancelled, never confirmed.
  await page
    .getByTestId(`revoke-route-2-${approvedRouteIndex("2", "10.42.0.0/16")}`)
    .click();
  await expect.element(page.getByTestId("revoke-route-dialog")).toBeVisible();
  const revokeHeader = document.querySelector<HTMLElement>(
    '[data-testid="revoke-route-dialog"] [data-slot="alert-dialog-header"]',
  );
  expect(revokeHeader).toBeTruthy();
  expectTextAlignsToStart(revokeHeader as HTMLElement);
  expectTestIdNetworkTokensLtr("revoke-route-dialog");
  await page.viewport(390, 844);
  expectDialogFitsViewport("revoke-route-dialog");
  expectNoHorizontalOverflow();
  await page.getByTestId("revoke-route-cancel").click();
  await expect
    .element(page.getByTestId("revoke-route-dialog"))
    .not.toBeInTheDocument();
  await page.viewport(1366, 768);
  expectNoHorizontalOverflow();

  await selectSectionTab("access");
  await expect.element(page.getByTestId("device-labels-section")).toBeVisible();
  await page.getByTestId("new-device-label").click();
  await expect.element(page.getByTestId("tag-detail-dialog")).toBeVisible();
  expectDialogMirrorsInlineEnd("tag-detail-dialog");
  await closeLayerWithEscape("tag-detail-dialog");
  expectNoHorizontalOverflow();

  await page.viewport(390, 844);
  expectResponsiveTabMenu();
  for (const section of [
    "home",
    "devices",
    "members",
    "invites",
    "routes",
    "access",
  ] as const) {
    await selectSectionTab(section);
    expectNoHorizontalOverflow();
  }
});

test("mirrors the access policy workspace in Arabic", async () => {
  await renderLogin();
  await connectWithDefaults();

  await chooseProfileMenuOption("locale-option-ar");
  await selectSectionTab("access");
  await expect.element(page.getByTestId("teams-section")).toBeVisible();
  await expect.element(page.getByTestId("device-labels-section")).toBeVisible();

  expect(document.documentElement.lang).toBe("ar");
  expect(document.documentElement.dir).toBe("rtl");

  const teams = document.querySelector<HTMLElement>(
    '[data-testid="teams-section"]',
  );
  const labels = document.querySelector<HTMLElement>(
    '[data-testid="device-labels-section"]',
  );
  expect(teams).toBeTruthy();
  expect(labels).toBeTruthy();

  const teamsRect = teams?.getBoundingClientRect();
  const labelsRect = labels?.getBoundingClientRect();
  expect(teamsRect?.bottom ?? 0).toBeLessThanOrEqual(
    (labelsRect?.top ?? 0) + 1,
  );
  expect(
    Math.abs((teamsRect?.left ?? 0) - (labelsRect?.left ?? 0)),
  ).toBeLessThan(2);
  expect(
    Math.abs((teamsRect?.right ?? 0) - (labelsRect?.right ?? 0)),
  ).toBeLessThan(2);
  expectNoHorizontalOverflow();

  await page.viewport(390, 844);
  await expect.element(page.getByTestId("device-labels-section")).toBeVisible();
  expectNoHorizontalOverflow();
});

test("supports light, dark and system theme modes", async () => {
  await renderLogin();
  await connectWithDefaults();

  const systemDark = () =>
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = () => document.documentElement.classList.contains("dark");
  try {
    for (const [mode, scheme, expectDark] of [
      ["dark", "light", true],
      ["light", "dark", false],
      ["auto", "dark", true],
    ] as const) {
      await commands.emulateColorScheme(scheme);
      // Proves the emulation reached this frame: the system preference really is the opposite of the mode.
      await expect.poll(systemDark).toBe(scheme === "dark");
      await chooseProfileMenuOption(`theme-option-${mode}`);
      await expect.poll(() => readIdbSetting("theme")).toBe(mode);
      await expect.poll(isDark).toBe(expectDark);
      await expectProfileMenuRadioChecked(`theme-option-${mode}`);
    }

    // Still in system mode: the page must follow later operating-system changes.
    await commands.emulateColorScheme("light");
    await expect.poll(isDark).toBe(false);
    await commands.emulateColorScheme("dark");
    await expect.poll(isDark).toBe(true);
  } finally {
    await commands.emulateColorScheme("reset");
  }
});

test("uses a Tailscale-style add device setup dialog", async () => {
  await renderLogin();
  await connectWithDefaults();

  await page.getByTestId("section-devices").click();
  await expectMachinesWorkbench();
  await page.getByTestId("add-device-toggle").click();
  await expect.element(page.getByTestId("add-device-dialog")).toBeVisible();
  expect(
    document.querySelector('[data-testid="add-device-stepper"]'),
  ).toBeNull();
  await expect.element(page.getByTestId("add-device-options")).toBeVisible();
  await page.getByTestId("add-linux-device").click();

  await expect.element(page.getByTestId("device-setup-flow")).toBeVisible();
  await expect.element(page.getByTestId("add-device-stepper")).toBeVisible();
  expect(
    document
      .querySelector('[data-testid="device-setup-flow"]')
      ?.closest('[data-testid="add-device-dialog"]'),
  ).toBeTruthy();
  await expect.element(page.getByTestId("setup-device-step")).toBeVisible();
  await expectTagSelection("setup-tags", ["tag:server"]);
  expect(
    document.querySelector('[data-testid="setup-auth-key-step"]'),
  ).toBeNull();
  await page.getByTestId("add-device-next").click();
  await expect.element(page.getByTestId("setup-auth-key-step")).toBeVisible();
  await expect.element(page.getByTestId("setup-reusable")).toBeChecked();
  await page.getByTestId("add-device-next").click();
  await expect.element(page.getByTestId("setup-generate-step")).toBeVisible();

  await page.getByTestId("generate-install-script").click();
  await expect
    .element(page.getByTestId("created-invite"))
    .toMatchTextContent(
      `tailscale up --login-server '${dockerSettings().baseUrl}'`,
    );

  await page.getByTestId("add-device-finish").click();
  await expectMachinesWorkbench();
});

test("exercises every supported Headscale v0.29.4 REST operation with deterministic readback", async () => {
  await renderLogin();
  await commands.clearHeadscaleOperationCalls();
  await connectToDockerHeadscale("Docker REST lifecycle");

  const requiredUiOperationIds = E2E_REQUIREMENTS.flatMap((requirement) =>
    requirement.kind === "rest" && requirement.driver === "ui"
      ? [requirement.operationId]
      : [],
  );
  const requiredApiContractOperationIds = E2E_REQUIREMENTS.flatMap(
    (requirement) =>
      requirement.kind === "rest" && requirement.driver === "api-contract"
        ? [requirement.operationId]
        : [],
  );
  const observedUiOperationIds = new Set<OperationId>();
  const observedApiContractOperationIds = new Set<OperationId>();

  await expectUiOperationDelta("health.check", 0, observedUiOperationIds);
  await expectUiOperationDelta("version.get", 0, observedUiOperationIds);
  await expectUiOperationDelta("user.list", 0, observedUiOperationIds);
  await expectUiOperationDelta("node.list", 0, observedUiOperationIds);
  await expectUiOperationDelta("policy.get", 0, observedUiOperationIds);
  await expectUiOperationDelta("apikey.list", 0, observedUiOperationIds);

  const client = adopted();
  const health = await readHealth(client.read);
  expect(health.databaseConnectivity).toBe(true);
  const version = await request(client.read, { endpoint: "version" });
  expect(version.version).toBe("v0.29.6+dirty");

  await selectSectionTab("members");
  await openCreateMemberDialog();
  await page.getByTestId("member-name").fill("e2e-user");
  await page.getByTestId("member-display").fill("E2E User");
  await page.getByTestId("member-email").fill("operator@example.test");
  const userCreatesBeforeCreate = await operationCount("user.create");
  await page.getByTestId("create-member").click();
  await waitForActionFinished("create-member");
  await expect.element(page.getByTestId("member-e2e-user")).toBeVisible();
  await expectUiOperationDelta(
    "user.create",
    userCreatesBeforeCreate,
    observedUiOperationIds,
  );

  const createdUsers = await request(client.read, {
    endpoint: "listUsers",
    input: { name: "e2e-user" },
  });
  expect(createdUsers.users ?? []).toHaveLength(1);
  const lifecycleUser = (createdUsers.users ?? [])[0];
  expect(lifecycleUser?.displayName).toBe("E2E User");
  expect(lifecycleUser?.email).toBe("operator@example.test");
  expect(lifecycleUser?.id).toBeTruthy();

  await clickVisibleDomTestId("member-actions-trigger-e2e-user");
  await clickVisibleDomTestId("rename-member-e2e-user");
  await expect.element(page.getByTestId("rename-member-dialog")).toBeVisible();
  inputDomTestId("rename-member-name", "e2e-user-renamed");
  const userRenamesBeforeRename = await operationCount("user.rename");
  await clickVisibleDomTestId("confirm-rename-member");
  await expect
    .element(page.getByTestId("member-e2e-user-renamed"))
    .toBeVisible();
  await expectUiOperationDelta(
    "user.rename",
    userRenamesBeforeRename,
    observedUiOperationIds,
  );
  const renamedUsers = await request(client.read, {
    endpoint: "listUsers",
    input: { id: lifecycleUser?.id ?? "" },
  });
  expect((renamedUsers.users ?? [])[0]?.name).toBe("e2e-user-renamed");

  const preAuthKeyListsBeforeInvites = await operationCount("preauthkey.list");
  await selectSectionTab("invites");
  await expectUiOperationDelta(
    "preauthkey.list",
    preAuthKeyListsBeforeInvites,
    observedUiOperationIds,
  );
  const preAuthKeyIdsBefore = new Set(
    (
      (await request(client.read, { endpoint: "listPreAuthKeys" }))
        .preAuthKeys ?? []
    ).map((key) => key.id),
  );
  const userListsBeforeInviteDialog = await operationCount("user.list");
  await page.getByTestId("open-create-invite").click();
  await expect.element(page.getByTestId("invite-create-dialog")).toBeVisible();
  await expect
    .poll(async () => await operationCount("user.list"))
    .toBeGreaterThan(userListsBeforeInviteDialog);
  await expect
    .poll(() => session().snapshot.getSnapshot().refreshSnapshotInFlight)
    .toBe(0);
  await page.getByTestId("invite-user").selectOptions(lifecycleUser?.id ?? "");
  await expect
    .element(page.getByTestId("invite-user"))
    .toHaveValue(lifecycleUser?.id ?? "");
  await expectTagSelection("invite-tags", []);
  const preAuthKeyCreatesBeforeCreate =
    await operationCount("preauthkey.create");
  await page.getByTestId("create-invite").click();
  await expect.element(page.getByTestId("created-invite")).toBeVisible();
  await expectUiOperationDelta(
    "preauthkey.create",
    preAuthKeyCreatesBeforeCreate,
    observedUiOperationIds,
  );

  const createdPreAuthKeys = (
    (await request(client.read, { endpoint: "listPreAuthKeys" })).preAuthKeys ??
    []
  ).filter((key) => !preAuthKeyIdsBefore.has(key.id));
  expect(createdPreAuthKeys).toHaveLength(1);
  const lifecyclePreAuthKey = createdPreAuthKeys[0];
  expect(lifecyclePreAuthKey?.user?.id).toBe(lifecycleUser?.id);
  expect(lifecyclePreAuthKey?.aclTags).toEqual([]);
  await expect
    .element(page.getByTestId(`invite-${lifecyclePreAuthKey?.id}`))
    .toBeVisible();

  await clickVisibleDomTestId(
    `invite-actions-trigger-${lifecyclePreAuthKey?.id}`,
  );
  await clickVisibleDomTestId(`expire-invite-${lifecyclePreAuthKey?.id}`);
  await expect.element(page.getByTestId("expire-invite-dialog")).toBeVisible();
  const preAuthKeyExpiresBeforeExpire =
    await operationCount("preauthkey.expire");
  await clickVisibleDomTestId("confirm-invite-action");
  await waitForActionFinished("invite-action");
  await expectUiOperationDelta(
    "preauthkey.expire",
    preAuthKeyExpiresBeforeExpire,
    observedUiOperationIds,
  );
  await expect
    .poll(async () => {
      const key = (
        (await request(client.read, { endpoint: "listPreAuthKeys" }))
          .preAuthKeys ?? []
      ).find((candidate) => candidate.id === lifecyclePreAuthKey?.id);
      return Boolean(
        key?.expiration && Date.parse(key.expiration) <= Date.now() + 5_000,
      );
    })
    .toBe(true);
  await expect
    .poll(() => document.querySelector('[data-testid="expire-invite-dialog"]'))
    .toBeNull();
  await expect
    .poll(() => session().snapshot.getSnapshot().refreshSnapshotInFlight)
    .toBe(0);

  await clickVisibleDomTestId(
    `invite-actions-trigger-${lifecyclePreAuthKey?.id}`,
  );
  await clickVisibleDomTestId(`delete-invite-${lifecyclePreAuthKey?.id}`);
  await expect.element(page.getByTestId("delete-invite-dialog")).toBeVisible();
  const preAuthKeyDeletesBeforeDelete =
    await operationCount("preauthkey.delete");
  await clickVisibleDomTestId("confirm-invite-action");
  await waitForActionFinished("invite-action");
  await expect
    .poll(() => document.querySelector('[data-testid="delete-invite-dialog"]'))
    .toBeNull();
  await expectUiOperationDelta(
    "preauthkey.delete",
    preAuthKeyDeletesBeforeDelete,
    observedUiOperationIds,
  );
  await expect
    .poll(async () =>
      (
        (await request(client.read, { endpoint: "listPreAuthKeys" }))
          .preAuthKeys ?? []
      ).some((candidate) => candidate.id === lifecyclePreAuthKey?.id),
    )
    .toBe(false);

  await selectSectionTab("members");
  await clickVisibleDomTestId("member-actions-trigger-e2e-user-renamed");
  await clickVisibleDomTestId("delete-member-e2e-user-renamed");
  await expect.element(page.getByTestId("delete-member-dialog")).toBeVisible();
  const userDeletesBeforeDelete = await operationCount("user.delete");
  await clickVisibleDomTestId("confirm-delete-member");
  await waitForActionFinished("delete-member");
  await expect
    .poll(() => document.querySelector('[data-testid="delete-member-dialog"]'))
    .toBeNull();
  await expectUiOperationDelta(
    "user.delete",
    userDeletesBeforeDelete,
    observedUiOperationIds,
  );
  await expect
    .poll(
      async () =>
        (
          (
            await request(client.read, {
              endpoint: "listUsers",
              input: { id: lifecycleUser?.id ?? "" },
            })
          ).users ?? []
        ).length,
    )
    .toBe(0);
  await expect
    .poll(() => session().snapshot.getSnapshot().refreshSnapshotInFlight)
    .toBe(0);
  await expect
    .poll(() =>
      document.querySelector('[data-testid="member-e2e-user-renamed"]'),
    )
    .toBeNull();

  const adminUser = ((
    await request(client.read, {
      endpoint: "listUsers",
      input: { name: "admin-test" },
    })
  ).users ?? [])[0];
  expect(adminUser?.name).toBe("admin-test");
  const registrationKey = "hskey-authreq-abcdefghijklmnopqrstuvwx";
  const debugNode = await observeApiContract(
    "node.debugCreate",
    observedApiContractOperationIds,
    () =>
      request(client.write, {
        endpoint: "debugCreateNode",
        input: {
          user: "admin-test",
          key: registrationKey,
          name: "e2e-router",
          routes: ["10.99.0.0/24"],
        },
      }),
  );
  expect(debugNode.node.name).toBe("e2e-router");
  // Three more pending entries, one per remaining auth operation. Never send an SSH-check id to
  // auth.register or node.register on this shared fixture: Headscale may panic on it (unverified).
  const approveKey = "hskey-authreq-cdefghijklmnopqrstuvwxyz";
  const rejectKey = "hskey-authreq-defghijklmnopqrstuvwxyz0";
  const legacyKey = "hskey-authreq-bcdefghijklmnopqrstuvwxy";
  const unknownKey = "hskey-authreq-zzzzzzzzzzzzzzzzzzzzzzzz";
  for (const [key, name] of [
    [approveKey, "e2e-approve"],
    [rejectKey, "e2e-reject"],
    [legacyKey, "e2e-legacy"],
  ] as const) {
    await observeApiContract(
      "node.debugCreate",
      observedApiContractOperationIds,
      () =>
        request(client.write, {
          endpoint: "debugCreateNode",
          input: { user: "admin-test", key, name },
        }),
    );
  }

  await selectSectionTab("devices");
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("add-pending-node").click();
  await expect
    .element(page.getByTestId("pending-registration-flow"))
    .toBeVisible();
  await selectNamedRegistrationUser("admin-test");
  // The option value is the user id. The owner readback below proves the registration used that account.
  // The full link Headscale prints is accepted and reduced to the bare id.
  await page
    .getByTestId("pending-node-key")
    .fill(`http://127.0.0.1:8080/register/${registrationKey}`);
  await confirmDeviceRegistration("http://127.0.0.1:8080");
  const authRegistrationsBeforeRegister = await operationCount("auth.register");
  await page.getByTestId("register-pending-node").click();
  await expect
    .element(page.getByTestId("registration-result"))
    .toMatchTextContent("e2e-router");
  await expectUiOperationDelta(
    "auth.register",
    authRegistrationsBeforeRegister,
    observedUiOperationIds,
  );
  await page.getByTestId("add-device-finish").click();

  const registeredNodes = (
    (
      await request(client.read, {
        endpoint: "listNodes",
        input: { user: adminUser?.name ?? "" },
      })
    ).nodes ?? []
  ).filter(
    (node) => node.name === "e2e-router" || node.givenName === "e2e-router",
  );
  expect(registeredNodes).toHaveLength(1);
  const lifecycleNode = registeredNodes[0];
  expect(lifecycleNode?.user?.id).toBe(adminUser?.id);
  const nodeReadback = await observeApiContract(
    "node.get",
    observedApiContractOperationIds,
    () =>
      request(client.read, {
        endpoint: "getNode",
        input: { nodeId: lifecycleNode?.id ?? "" },
      }),
  );
  expect(nodeReadback.node.id).toBe(lifecycleNode?.id);
  await expect
    .element(page.getByTestId(`device-${lifecycleNode?.id}`))
    .toBeVisible();

  const authCopy = getProductCopy("en-US");
  await page.getByTestId("add-device-toggle").click();
  await page.getByTestId("add-pending-node").click();
  await expect
    .element(page.getByTestId("pending-registration-flow"))
    .toBeVisible();
  await page.getByTestId("pending-registration-kind").selectOptions("ssh");
  await expect.element(page.getByTestId("approve-ssh-check")).toBeVisible();

  await page
    .getByTestId("pending-node-key")
    .fill(`http://127.0.0.1:8080/auth/${approveKey}`);
  const authApprovalsBeforeApprove = await operationCount("auth.approve");
  await page.getByTestId("approve-ssh-check").click();
  await expect.element(page.getByTestId("ssh-check-result")).toBeVisible();
  await expect
    .poll(() => visibleText("ssh-check-result"))
    .toBe(authCopy.sshCheckApproved);
  await expectUiOperationDelta(
    "auth.approve",
    authApprovalsBeforeApprove,
    observedUiOperationIds,
  );

  await page.getByTestId("pending-node-key").fill(rejectKey);
  const authRejectionsBeforeReject = await operationCount("auth.reject");
  await page.getByTestId("reject-ssh-check").click();
  await expect
    .poll(() => visibleText("ssh-check-result"))
    .toBe(authCopy.sshCheckRejected);
  await expectUiOperationDelta(
    "auth.reject",
    authRejectionsBeforeReject,
    observedUiOperationIds,
  );

  // A well-formed id nobody is waiting on: Headscale answers with an error the dialog must show.
  await page.getByTestId("pending-node-key").fill(unknownKey);
  const authApprovalsBeforeUnknown = await operationCount("auth.approve");
  await page.getByTestId("approve-ssh-check").click();
  await expect
    .element(page.getByTestId("approve-ssh-check-error"))
    .toBeVisible();
  await expectUiOperationDelta(
    "auth.approve",
    authApprovalsBeforeUnknown,
    observedUiOperationIds,
  );
  await expect
    .poll(() => visibleText("approve-ssh-check-error"))
    .toMatch(/no pending auth session/i);
  expect(document.querySelector('[data-testid="ssh-check-result"]')).toBeNull();

  // A registration link in SSH mode is blocked before any request is sent.
  await page
    .getByTestId("pending-node-key")
    .fill(`http://127.0.0.1:8080/register/${approveKey}`);
  await expect
    .poll(() => visibleText("pending-node-key-error"))
    .toBe(authCopy.authRequestIsRegistration);
  await expect.element(page.getByTestId("approve-ssh-check")).toBeDisabled();
  await expect.element(page.getByTestId("reject-ssh-check")).toBeDisabled();
  // That nothing is sent is asserted in DevicesMembers.browser.test.tsx: 'a registration link in SSH
  // mode is blocked...' and 'invalid request text disables every action and sends nothing'.
  await closeLayerWithEscape("add-device-dialog");

  // node.register stays an API-only compatibility endpoint; the UI now registers through
  // auth.register. Remove the legacy node afterwards so later node assertions are unaffected.
  const legacyNode = await observeApiContract(
    "node.register",
    observedApiContractOperationIds,
    () =>
      request(client.write, {
        endpoint: "registerNode",
        input: { user: "admin-test", key: legacyKey },
      }),
  );
  expect(legacyNode.node.name).toBe("e2e-legacy");
  await request(client.write, {
    endpoint: "deleteNode",
    input: { nodeId: legacyNode.node.id },
  });

  await clickVisibleDomTestId(`machine-actions-trigger-${lifecycleNode?.id}`);
  await clickVisibleDomTestId(`rename-node-action-${lifecycleNode?.id}`);
  await expect.element(page.getByTestId("rename-node-dialog")).toBeVisible();
  inputDomTestId("rename-node-dialog-input", "e2e-router-main");
  const nodeRenamesBeforeRename = await operationCount("node.rename");
  await clickVisibleDomTestId("rename-node-confirm");
  await waitForActionFinished("rename-node");
  await expectUiOperationDelta(
    "node.rename",
    nodeRenamesBeforeRename,
    observedUiOperationIds,
  );
  await expect
    .poll(
      async () =>
        normalizeHeadscaleNode(
          (
            await request(client.read, {
              endpoint: "getNode",
              input: { nodeId: lifecycleNode?.id ?? "" },
            })
          ).node,
        ).givenName,
    )
    .toBe("e2e-router-main");
  await expect
    .poll(() => document.querySelector('[data-testid="rename-node-dialog"]'))
    .toBeNull();
  await expect
    .poll(() => session().snapshot.getSnapshot().refreshSnapshotInFlight)
    .toBe(0);
  await expect
    .poll(() =>
      document
        .querySelector(`[data-testid="device-${lifecycleNode?.id}"]`)
        ?.textContent?.includes("e2e-router-main"),
    )
    .toBe(true);

  await clickVisibleDomTestId(`machine-actions-trigger-${lifecycleNode?.id}`);
  await clickVisibleDomTestId(`edit-node-tags-action-${lifecycleNode?.id}`);
  await expect.element(page.getByTestId("node-tags-dialog")).toBeVisible();
  await selectDeclaredDeviceTag("tag:test-01");
  const nodeSetTagsBeforeSave = await operationCount("node.setTags");
  // A personal device becomes tag-owned only after the operator acknowledges the identity change.
  await expect
    .element(page.getByTestId("node-tags-owner-warning"))
    .toBeVisible();
  await page.getByTestId("node-tags-confirm").click();
  await expect.element(page.getByTestId("node-tags-review")).toBeVisible();
  await expect.element(page.getByTestId("node-tags-apply")).toBeDisabled();
  expect(await operationCount("node.setTags")).toBe(nodeSetTagsBeforeSave);
  await page.getByTestId("node-tags-acknowledge").click();
  await expect.element(page.getByTestId("node-tags-apply")).toBeEnabled();
  await clickVisibleDomTestId("node-tags-apply");
  await waitForActionFinished("node-tags");
  await expect.element(page.getByTestId("node-tags-result")).toBeVisible();
  await page.getByTestId("node-tags-cancel").click();
  await expectUiOperationDelta(
    "node.setTags",
    nodeSetTagsBeforeSave,
    observedUiOperationIds,
  );
  await expect
    .poll(
      async () =>
        normalizeHeadscaleNode(
          (
            await request(client.read, {
              endpoint: "getNode",
              input: { nodeId: lifecycleNode?.id ?? "" },
            })
          ).node,
        ).tags,
    )
    .toEqual(["tag:test-01"]);
  await expect
    .poll(() => document.querySelector('[data-testid="node-tags-dialog"]'))
    .toBeNull();

  // In Headscale 0.29, advertised routes come from a live client's Hostinfo, not debug registration.
  const routeNode = normalizeHeadscaleNode(
    (
      await request(client.read, {
        endpoint: "getNode",
        input: { nodeId: "2" },
      })
    ).node,
  );
  expect(routeNode.givenName).toBe("edge-router");
  expect([...routeNode.availableRoutes].sort()).toEqual([
    "0.0.0.0/0",
    "10.42.0.0/16",
    "::/0",
  ]);
  await selectSectionTab("routes");
  await expect
    .element(page.getByTestId(`route-node-${routeNode.id}`))
    .toBeVisible();
  // Another administrator approves a route the node never advertised while this page is open and not refreshed.
  // Approve all must write from the live approved set instead of the stale list, so the extra route survives.
  // This call is a precondition through the API client, not a UI operation.
  await request(client.write, {
    endpoint: "setApprovedRoutes",
    input: {
      nodeId: routeNode.id,
      routes: ["10.42.0.0/16", "172.16.0.0/12"],
    },
  });
  await page.getByTestId(`approve-routes-${routeNode.id}`).click();
  await expect
    .element(page.getByTestId("approve-routes-dialog"))
    .toMatchTextContent("edge-router");
  const routeApprovalsBeforeApprove = await operationCount(
    "node.setApprovedRoutes",
  );
  await clickVisibleDomTestId("approve-routes-confirm");
  await waitForActionFinished("approve-routes");
  await expectUiOperationDelta(
    "node.setApprovedRoutes",
    routeApprovalsBeforeApprove,
    observedUiOperationIds,
  );
  await expect
    .poll(() => approvedRoutesOf(routeNode.id))
    .toEqual(["0.0.0.0/0", "10.42.0.0/16", "172.16.0.0/12", "::/0"]);
  await expect
    .poll(() => document.querySelector('[data-testid="approve-routes-dialog"]'))
    .toBeNull();

  // Revoking the stray route: cancel sends nothing, confirm writes the remaining three.
  await expect
    .poll(() =>
      Array.from(
        document.querySelectorAll(
          `[data-testid^="route-approved-${routeNode.id}-"]`,
        ),
        (route) => route.textContent?.trim(),
      ).sort(),
    )
    .toEqual(["0.0.0.0/0", "10.42.0.0/16", "172.16.0.0/12", "::/0"]);
  const routeWritesBeforeRevoke = await operationCount(
    "node.setApprovedRoutes",
  );
  const strayRevokeButton = () =>
    page.getByTestId(
      `revoke-route-${routeNode.id}-${approvedRouteIndex(routeNode.id, "172.16.0.0/12")}`,
    );
  await strayRevokeButton().click();
  await expect.element(page.getByTestId("revoke-route-dialog")).toBeVisible();
  expect(visibleText("revoke-route-target-0")).toBe("172.16.0.0/12");
  await page.getByTestId("revoke-route-cancel").click();
  await expect
    .element(page.getByTestId("revoke-route-dialog"))
    .not.toBeInTheDocument();
  expect(await operationCount("node.setApprovedRoutes")).toBe(
    routeWritesBeforeRevoke,
  );
  await strayRevokeButton().click();
  await expect.element(page.getByTestId("revoke-route-dialog")).toBeVisible();
  await page.getByTestId("revoke-route-confirm").click();
  await waitForActionFinished("revoke-route");
  await expectUiOperationDelta(
    "node.setApprovedRoutes",
    routeWritesBeforeRevoke,
    observedUiOperationIds,
  );
  await expect
    .poll(() => approvedRoutesOf(routeNode.id))
    .toEqual(["0.0.0.0/0", "10.42.0.0/16", "::/0"]);
  await expect
    .element(page.getByTestId("revoke-route-dialog"))
    .not.toBeInTheDocument();

  await openAccessSection();
  await expect.element(page.getByTestId("save-policy")).toBeDisabled();
  await page.getByTestId("add-ip-rule").click();
  await page.getByTestId("ip-rule-source-new").fill("group:test-01");
  await page.getByTestId("ip-rule-destination-new").fill("100.64.0.99");
  await page.getByTestId("ip-rule-ports-new").fill("443");
  await page.getByTestId("ip-rule-save-new").click();
  // Check is a dry run: the very payload that Save accepts below passes, and nothing is written.
  const policyChecksBeforeCheck = await operationCount("policy.check");
  const policySetsBeforeCheck = await operationCount("policy.set");
  await page.getByTestId("check-policy").click();
  await expect.element(page.getByTestId("policy-check-passed")).toBeVisible();
  await expectUiOperationDelta(
    "policy.check",
    policyChecksBeforeCheck,
    observedUiOperationIds,
  );
  expect(await operationCount("policy.set")).toBe(policySetsBeforeCheck);
  expect(
    document.querySelector('[data-testid="check-policy-error"]'),
  ).toBeNull();
  const policySetsBeforeSave = await operationCount("policy.set");
  await page.getByTestId("save-policy").click();
  await confirmPolicyPublication();
  await latestSavedPolicy();
  await expectUiOperationDelta(
    "policy.set",
    policySetsBeforeSave,
    observedUiOperationIds,
  );
  const persistedPolicy = JSON.parse((await readPolicy(client.read)).policy);
  expect(persistedPolicy.groups["group:test-01"]).toContain("admin-test@");
  expect(persistedPolicy.acls).toContainEqual({
    action: "accept",
    src: ["group:test-01"],
    dst: ["100.64.0.99:443"],
  });

  const apiKeyIdsBefore = new Set(
    (
      (await request(client.read, { endpoint: "listApiKeys" })).apiKeys ?? []
    ).map((key) => key.id),
  );
  await openProfileMenu();
  await page.getByTestId("open-server-settings").click();
  await expect
    .element(page.getByTestId("server-settings-dialog"))
    .toBeVisible();
  await selectDomTab("server-tab-api-keys");
  const apiKeyCreatesBeforeCreate = await operationCount("apikey.create");
  await clickVisibleDomTestId("create-api-key-confirm");
  await waitForActionFinished("api-key-create");
  await expect.element(page.getByTestId("created-api-key")).toBeVisible();
  await expectUiOperationDelta(
    "apikey.create",
    apiKeyCreatesBeforeCreate,
    observedUiOperationIds,
  );

  let lifecycleApiKey: Infer<typeof apiKey> | undefined;
  await expect
    .poll(async () => {
      lifecycleApiKey = (
        (await request(client.read, { endpoint: "listApiKeys" })).apiKeys ?? []
      ).find((key) => !apiKeyIdsBefore.has(key.id));
      return Boolean(lifecycleApiKey);
    })
    .toBe(true);
  expect(lifecycleApiKey?.prefix).toBeTruthy();
  // The dialog was confirmed untouched, so the server must hold the 90-day default.
  // Fails when the key keeps a stale absolute date or none at all.
  const lifecycleApiKeyExpiration = Date.parse(
    lifecycleApiKey?.expiration ?? "",
  );
  expect(lifecycleApiKeyExpiration).toBeGreaterThanOrEqual(
    Date.now() + 89 * 86_400_000,
  );
  expect(lifecycleApiKeyExpiration).toBeLessThanOrEqual(
    Date.now() + 91 * 86_400_000,
  );

  await clickVisibleDomTestId(
    `api-key-actions-trigger-${lifecycleApiKey?.prefix}`,
  );
  await clickVisibleDomTestId(`expire-api-key-${lifecycleApiKey?.prefix}`);
  await expect.element(page.getByTestId("expire-api-key-dialog")).toBeVisible();
  const apiKeyExpiresBeforeExpire = await operationCount("apikey.expire");
  await clickVisibleDomTestId("confirm-api-key-action");
  await waitForActionFinished("api-key-action");
  await expectUiOperationDelta(
    "apikey.expire",
    apiKeyExpiresBeforeExpire,
    observedUiOperationIds,
  );
  await expect
    .poll(async () => {
      const key = (
        (await request(client.read, { endpoint: "listApiKeys" })).apiKeys ?? []
      ).find((candidate) => candidate.id === lifecycleApiKey?.id);
      return Boolean(
        key?.expiration && Date.parse(key.expiration) <= Date.now() + 5_000,
      );
    })
    .toBe(true);
  await expect
    .poll(() => document.querySelector('[data-testid="expire-api-key-dialog"]'))
    .toBeNull();
  await expect
    .poll(() => session().snapshot.getSnapshot().refreshSnapshotInFlight)
    .toBe(0);

  await clickVisibleDomTestId(
    `api-key-actions-trigger-${lifecycleApiKey?.prefix}`,
  );
  await clickVisibleDomTestId(`delete-api-key-${lifecycleApiKey?.prefix}`);
  await expect.element(page.getByTestId("delete-api-key-dialog")).toBeVisible();
  const apiKeyDeletesBeforeDelete = await operationCount("apikey.delete");
  await clickVisibleDomTestId("confirm-api-key-action");
  await waitForActionFinished("api-key-action");
  await expect
    .poll(() => document.querySelector('[data-testid="delete-api-key-dialog"]'))
    .toBeNull();
  await expectUiOperationDelta(
    "apikey.delete",
    apiKeyDeletesBeforeDelete,
    observedUiOperationIds,
  );
  await expect
    .poll(async () =>
      (
        (await request(client.read, { endpoint: "listApiKeys" })).apiKeys ?? []
      ).some((candidate) => candidate.id === lifecycleApiKey?.id),
    )
    .toBe(false);

  await selectDomTab("server-tab-maintenance");
  await page.getByTestId("open-backfill-node-ips").click();
  await expect
    .element(page.getByTestId("backfill-node-ips-dialog"))
    .toBeVisible();
  await page.getByTestId("backfill-node-ips-confirmed").click();
  const nodeBackfillsBeforeBackfill = await operationCount("node.backfillIps");
  await clickVisibleDomTestId("confirm-backfill-node-ips");
  await expect
    .element(page.getByTestId("backfill-node-ips-result"))
    .toBeVisible();
  await expectUiOperationDelta(
    "node.backfillIps",
    nodeBackfillsBeforeBackfill,
    observedUiOperationIds,
  );
  await expect
    .poll(
      async () =>
        (await commands.headscaleOperationCalls())
          ?.filter((call) => call.id === "node.backfillIps")
          .at(-1)?.payload,
    )
    .toEqual({ confirmed: true });
  await closeLayerWithEscape("server-settings-dialog");

  await selectSectionTab("devices");
  await clickVisibleDomTestId(`machine-actions-trigger-${lifecycleNode?.id}`);
  await clickVisibleDomTestId(`expire-node-action-${lifecycleNode?.id}`);
  await expect
    .element(page.getByTestId("expire-node-dialog"))
    .toMatchTextContent("e2e-router-main");
  const nodeExpiry = async () =>
    normalizeHeadscaleNode(
      (
        await request(client.read, {
          endpoint: "getNode",
          input: { nodeId: lifecycleNode?.id ?? "" },
        })
      ).node,
    ).expiry;
  // Guards against a vacuous pass: the node must not already be expired before the click.
  const expiryBefore = await nodeExpiry();
  expect(!expiryBefore || Date.parse(expiryBefore) > Date.now() + 5_000).toBe(
    true,
  );
  // Holds whether upstream sends the zero timestamp or omits the field: a node that never expires is not Expired.
  expect(visibleText(`device-status-${lifecycleNode?.id}`)).not.toBe("Expired");
  const nodeExpiresBeforeExpire = await operationCount("node.expire");
  await clickVisibleDomTestId("expire-node-confirm");
  await waitForActionFinished("expire-node");
  await expectUiOperationDelta(
    "node.expire",
    nodeExpiresBeforeExpire,
    observedUiOperationIds,
  );
  await expect
    .poll(async () => {
      const expiry = await nodeExpiry();
      return Boolean(expiry && Date.parse(expiry) <= Date.now() + 5_000);
    })
    .toBe(true);
  await expect
    .poll(() => document.querySelector('[data-testid="expire-node-dialog"]'))
    .toBeNull();
  await expect
    .poll(() => session().snapshot.getSnapshot().refreshSnapshotInFlight)
    .toBe(0);
  await expect
    .poll(() => visibleText(`device-status-${lifecycleNode?.id}`))
    .toBe("Expired");
  await page.getByTestId("machine-filter").selectOptions("expired");
  await expect
    .element(page.getByTestId(`device-${lifecycleNode?.id}`))
    .toBeVisible();
  await page.getByTestId("machine-filter").selectOptions("all");

  await clickVisibleDomTestId(`machine-actions-trigger-${lifecycleNode?.id}`);
  await clickVisibleDomTestId(`remove-node-action-${lifecycleNode?.id}`);
  await expect
    .element(page.getByTestId("remove-node-dialog"))
    .toMatchTextContent("e2e-router-main");
  const nodeDeletesBeforeDelete = await operationCount("node.delete");
  await clickVisibleDomTestId("remove-node-confirm");
  await waitForActionFinished("remove-node");
  await expect
    .poll(() => document.querySelector('[data-testid="remove-node-dialog"]'))
    .toBeNull();
  await expectUiOperationDelta(
    "node.delete",
    nodeDeletesBeforeDelete,
    observedUiOperationIds,
  );
  await expect
    .poll(async () =>
      (
        (await request(client.read, { endpoint: "listNodes", input: {} }))
          .nodes ?? []
      ).some((node) => node.id === lifecycleNode?.id),
    )
    .toBe(false);
  await expect
    .poll(() => session().snapshot.getSnapshot().refreshSnapshotInFlight)
    .toBe(0);
  await expect
    .poll(() =>
      document.querySelector(`[data-testid="device-${lifecycleNode?.id}"]`),
    )
    .toBeNull();

  expect(
    requiredUiOperationIds.filter(
      (operationId) => !observedUiOperationIds.has(operationId),
    ),
  ).toEqual([]);
  expect(
    requiredApiContractOperationIds.filter(
      (operationId) => !observedApiContractOperationIds.has(operationId),
    ),
  ).toEqual([]);
  expect(
    requiredUiOperationIds.length + requiredApiContractOperationIds.length,
  ).toBe(Object.keys(endpoints).length);
}, 120_000);

test("keeps policy cards mounted when unchanged server policy is refreshed", async () => {
  await renderLogin();
  await connectToDockerHeadscale("Docker policy refresh");
  await openAccessSection();
  const snapshot = session().snapshot;
  await expect.poll(() => snapshot.isRefreshing).toBe(false);
  const policyText = snapshot.getSnapshot().snapshot.policy?.policy;
  const card = visibleDomTestId("team-card-group:test-01");

  await snapshot.refreshSnapshot();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  expect(session().feedback.getSnapshot().lastError).toBe("");
  expect(snapshot.getSnapshot().snapshot.policy?.policy).toBe(policyText);
  expect(card.isConnected).toBe(true);
  expect(visibleDomTestId("team-card-group:test-01")).toBe(card);
  await page.getByTestId("team-card-group:test-01").click();
  await expect
    .element(page.getByTestId("team-member-row-admin-test@"))
    .toBeVisible();
});

test("cleans only true orphan references against Headscale v0.29.4", async () => {
  await renderLogin();
  await connectToDockerHeadscale("Docker orphan cleanup");
  await openAccessSection();
  await commands.clearHeadscaleOperationCalls();

  await expect.element(page.getByTestId("orphan-ref-banner")).toBeVisible();
  await page.getByTestId("team-card-group:test-01").click();
  await expect
    .element(page.getByTestId("team-member-row-admin-test@"))
    .toBeVisible();
  await expect
    .element(page.getByTestId("team-member-row-deleted-test@"))
    .toBeVisible();
  const validRow = document.querySelector<HTMLElement>(
    '[data-testid="team-member-row-admin-test@"]',
  );
  const orphanRow = document.querySelector<HTMLElement>(
    '[data-testid="team-member-row-deleted-test@"]',
  );
  expect(validRow).toBeTruthy();
  expect(orphanRow).toBeTruthy();
  const orphanCopy = getProductCopy("en-US");
  expect(validRow?.querySelector("[title]")).toBeNull();
  expect(orphanRow?.querySelector("[title]")).toBeNull();
  expect(validRow?.textContent ?? "").not.toContain(
    orphanCopy.orphanReferenceBadge,
  );
  expect(orphanRow?.textContent ?? "").toContain(
    orphanCopy.orphanReferenceBadge,
  );
  await page
    .getByRole("button", {
      name: `${orphanCopy.policyReferenceHelp} deleted-test@`,
      exact: true,
    })
    .click();
  await expect
    .element(page.getByText(orphanCopy.orphanReferenceTooltip, { exact: true }))
    .toBeVisible();
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("team-detail-close").click();

  await page.getByTestId("cleanup-orphan-refs").click();
  await page.getByTestId("cleanup-orphans-confirm").click();
  await page.getByTestId("save-policy").click();
  await confirmPolicyPublication();
  await expect
    .poll(async () =>
      (await commands.headscaleOperationCalls())?.some(
        (call) => call.id === "policy.set",
      ),
    )
    .toBe(true);

  const submitted = await latestSavedPolicy();
  expect(submitted.groups?.["group:test-01"]).toEqual(["admin-test@"]);
  expect(submitted.tagOwners?.["tag:test-01"]).toEqual(["admin-test@"]);
  expect(submitted.acls?.flatMap((rule) => rule.dst).sort()).toEqual([
    "tag:test-01:80",
    "tag:test-02:22",
  ]);

  await expect
    .poll(async () => {
      return !(await commands.readHeadscaleFixturePolicy()).includes(
        "deleted-test@",
      );
    })
    .toBe(true);

  const persistedText = await commands.readHeadscaleFixturePolicy();
  const persisted = JSON.parse(persistedText);
  expect(persisted.groups["group:test-01"]).toEqual(["admin-test@"]);
  expect(persisted.tagOwners["tag:test-01"]).toEqual(["admin-test@"]);
  expect(persistedText).not.toContain("deleted-test@");
});

test("saves a live CLI user without email as a device-label manager against Headscale", async () => {
  await renderLogin();
  await connectToDockerHeadscale("Docker issue 7 tag owner");

  await page.getByTestId("section-members").click();
  await openCreateMemberDialog();
  await page.getByTestId("member-name").fill("issue7-live");
  await page.getByTestId("create-member").click();
  await expect.element(page.getByTestId("member-issue7-live")).toBeVisible();

  await openAccessSection();
  await commands.clearHeadscaleOperationCalls();
  await page.getByTestId("new-device-label").click();
  await expect.element(page.getByTestId("tag-detail-dialog")).toBeVisible();
  inputDomTestId("tag-name-input", "issue7-live");
  await page.getByTestId("tag-name-confirm").click();
  await expect.element(page.getByTestId("tag-owners-section")).toBeVisible();

  await clickVisibleDomTestId("tag-add-owner-trigger");
  await expect.element(page.getByTestId("tag-add-owner-content")).toBeVisible();
  await expect
    .element(page.getByTestId("tag-add-owner-option-issue7-live@"))
    .toBeVisible();
  await page.getByTestId("tag-add-owner-option-issue7-live@").click();
  await expect
    .element(page.getByTestId("tag-owner-row-issue7-live@"))
    .toBeVisible();

  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByTestId("unsaved-changes-dialog"))
    .toBeVisible();
  await page.getByTestId("unsaved-changes-save").click();
  await confirmPolicyPublication();
  await expect
    .poll(async () =>
      (await commands.headscaleOperationCalls())?.some(
        (call) => call.id === "policy.set",
      ),
    )
    .toBe(true);

  const saved = await latestSavedPolicy();
  expect(saved.tagOwners?.["tag:issue7-live"]).toEqual(["issue7-live@"]);
  expect(saved.tagOwners?.["tag:issue7-live"]).not.toContain("issue7-live");

  await expect
    .poll(async () => {
      const persisted = JSON.parse(
        await commands.readHeadscaleFixturePolicy(),
      ) as {
        tagOwners?: Record<string, string[]>;
      };
      return (
        persisted.tagOwners?.["tag:issue7-live"]?.join(",") === "issue7-live@"
      );
    })
    .toBe(true);
}, 120_000);

// Persistence across a Headscale restart is covered by scripts/check-policy-lifecycle.ts.
test("deletes the wildcard allow-all rule and keeps empty ACLs after saving and refreshing from Headscale", async () => {
  await renderLogin();
  await connectToDockerHeadscale("Docker issue 10 wildcard rule");
  const original = await commands.readHeadscaleFixturePolicy();

  try {
    for (const releaseAt of ["inline-edit", "before-save", "after-save"]) {
      await page.getByTestId("section-home").click();
      await expect.poll(() => session().snapshot.isRefreshing).toBe(false);
      await commands.writeHeadscaleFixturePolicy(
        JSON.stringify({
          acls: [{ action: "accept", src: ["*"], dst: ["*:*"] }],
        }),
      );
      await session().snapshot.refreshSnapshot();

      await commands.interceptHeadscaleRequest("GET", "^/api/v1/policy$");

      try {
        await openAccessSection();
        await expectHeadscaleGate();
        expect(session().snapshot.isRefreshing).toBe(true);
        await expect
          .element(page.getByTestId("open-access-banner"))
          .toBeVisible();
        await expect
          .element(page.getByTestId("ip-rules-section"))
          .toBeVisible();
        expect(
          document.querySelectorAll('[data-testid^="ip-rule-remove-"]'),
        ).toHaveLength(1);

        if (releaseAt === "inline-edit") {
          await clickLastByTestIdPrefix("ip-rule-edit-");
          await expect
            .poll(() =>
              document.querySelector('[data-testid^="ip-rule-source-"]'),
            )
            .toBeTruthy();
          await inputLastByTestIdPrefix("ip-rule-source-", "*");
          await inputLastByTestIdPrefix("ip-rule-destination-", "100.64.0.99");
          await inputLastByTestIdPrefix("ip-rule-ports-", "443");
          await commands.releaseHeadscaleRequest();
          await expect.poll(() => session().snapshot.isRefreshing).toBe(false);
          for (const [field, expected] of [
            ["source", "*"],
            ["destination", "100.64.0.99"],
            ["ports", "443"],
          ]) {
            expect(
              document.querySelector<HTMLInputElement>(
                `[data-testid^="ip-rule-${field}-"]`,
              )?.value,
            ).toBe(expected);
          }
          await clickLastByTestIdPrefix("ip-rule-save-");
          await expect
            .element(page.getByTestId("save-policy-dirty-badge"))
            .toBeVisible();
        }

        await clickLastByTestIdPrefix("ip-rule-remove-");
        await page.getByTestId("confirm-remove-policy-item").click();
        await expect
          .poll(() =>
            document.querySelector('[data-testid="open-access-banner"]'),
          )
          .toBeNull();
        await expect
          .element(page.getByTestId("save-policy-dirty-badge"))
          .toBeVisible();

        if (releaseAt === "before-save") {
          await commands.releaseHeadscaleRequest();
          await expect.poll(() => session().snapshot.isRefreshing).toBe(false);
          // The IP rule section stays available (with "Add rule"); only the removed rule is gone.
          expect(
            document.querySelectorAll('[data-testid^="ip-rule-remove-"]'),
          ).toHaveLength(0);
          await expect
            .element(page.getByTestId("save-policy-dirty-badge"))
            .toBeVisible();
        }

        const policySetsBeforeSave = await operationCount("policy.set");
        await page.getByTestId("save-policy").click();
        await confirmPolicyPublication();
        await expect
          .poll(async () => await operationCount("policy.set"))
          .toBe(policySetsBeforeSave + 1);
        expect((await latestSavedPolicy()).acls).toEqual([]);
        // A clean draft has nothing to save.
        await expect.element(page.getByTestId("save-policy")).toBeDisabled();
        expect(
          document.querySelector('[data-testid="save-policy-error"]'),
        ).toBeNull();
        await expect
          .poll(() =>
            document.querySelector('[data-testid="save-policy-dirty-badge"]'),
          )
          .toBeNull();

        await commands.releaseHeadscaleRequest();
        await expect.poll(() => session().snapshot.isRefreshing).toBe(false);
        expect(
          document.querySelectorAll('[data-testid^="ip-rule-remove-"]'),
        ).toHaveLength(0);
        expect(
          document.querySelector('[data-testid="open-access-banner"]'),
        ).toBeNull();
        expect(
          document.querySelector('[data-testid="save-policy-dirty-badge"]'),
        ).toBeNull();

        await expect
          .poll(async () => {
            return (
              JSON.parse(await commands.readHeadscaleFixturePolicy()) as {
                acls?: unknown[];
              }
            ).acls;
          })
          .toEqual([]);
        await session().snapshot.refreshSnapshot();
        await expect
          .poll(
            () =>
              document.querySelectorAll('[data-testid^="ip-rule-remove-"]')
                .length,
          )
          .toBe(0);
        expect(
          document.querySelector('[data-testid="open-access-banner"]'),
        ).toBeNull();
      } finally {
        await commands.releaseHeadscaleRequest();
        await expect.poll(() => session().snapshot.isRefreshing).toBe(false);
      }
    }
  } finally {
    await commands.writeHeadscaleFixturePolicy(original);
  }
}, 120_000);
