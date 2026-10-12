import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { evaluateSharedWorker } from "../../scripts/harness/shared-worker-probe";
import { waitUntil } from "../../scripts/harness/wait-until";

type Connection = { baseUrl: string; apiKey: string };
type AbortRequest = { store: string; operation: "put" | "delete" | "clear"; profileName?: string };
type WorkerProbe = {
  crypto?: {
    held: number;
    released: number;
    installed: boolean;
    release(index: number): void;
    restore(): void;
  };
  abort?: { injected: number; installed: boolean; restore(): void };
};
type ProbeGlobal = typeof globalThis & { deploymentStorageProbe?: WorkerProbe };
type LegacyWindow = Window & {
  deploymentLegacyDb?: IDBDatabase;
  deploymentVersionChange?: boolean;
  deploymentUpgradeAborts?: number;
  deploymentMigrationAborts?: number;
};
const password = "deployment-server-password";
const patchedContexts = new WeakSet<BrowserContext>();
const workerUrl = (origin: string) => `${origin}/shared-session-worker.js`;

function collectBrowserErrors(context: BrowserContext) {
  const errors: string[] = [];
  const watchPage = (page: Page) => {
    page.setDefaultTimeout(15000);
    page.on("pageerror", (error) => errors.push(error.message));
  };
  context.pages().forEach(watchPage);
  context.on("page", watchPage);
  context.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText;
    if (failure !== "net::ERR_ABORTED")
      errors.push(`${request.method()} ${new URL(request.url()).pathname}: ${failure}`);
  });
  return errors;
}

async function workerCall<T, A>(
  page: Page,
  origin: string,
  fn: (argument: A) => T,
  argument: A,
): Promise<T> {
  patchedContexts.add(page.context());
  return evaluateSharedWorker<T>(
    page,
    workerUrl(origin),
    `(${fn.toString()})(${JSON.stringify(argument)})`,
  );
}

function installCryptoGate() {
  const scope = globalThis as ProbeGlobal;
  scope.deploymentStorageProbe ??= {};
  const probe = scope.deploymentStorageProbe;
  if (probe.crypto?.installed) throw new Error("A crypto gate is already installed");
  const original = crypto.subtle.encrypt;
  const pending: Array<{ release(): void; released: boolean }> = [];
  const state = {
    held: 0,
    released: 0,
    installed: true,
    release(index: number) {
      const entry = pending[index];
      if (!entry) throw new Error("Missing crypto operation");
      if (!entry.released) {
        entry.released = true;
        ++state.released;
        entry.release();
      }
    },
    restore() {
      Object.defineProperty(crypto.subtle, "encrypt", { configurable: true, value: original });
      state.installed = false;
      pending.forEach((_entry, index) => {
        state.release(index);
      });
    },
  };
  probe.crypto = state;
  Object.defineProperty(crypto.subtle, "encrypt", {
    configurable: true,
    async value(...args: Parameters<SubtleCrypto["encrypt"]>) {
      const result = await Reflect.apply(original, crypto.subtle, args);
      if (!state.installed) return result;
      const barrier = Promise.withResolvers<void>();
      pending.push({ release: () => barrier.resolve(), released: false });
      ++state.held;
      await barrier.promise;
      return result;
    },
  });
  return true;
}

function installAbort(target: AbortRequest) {
  const scope = globalThis as ProbeGlobal;
  scope.deploymentStorageProbe ??= {};
  const probe = scope.deploymentStorageProbe;
  if (probe.abort?.installed) throw new Error("An IDB fault is already installed");
  const original = IDBObjectStore.prototype[target.operation];
  const state = {
    injected: 0,
    installed: true,
    restore() {
      Object.defineProperty(IDBObjectStore.prototype, target.operation, {
        configurable: true,
        writable: true,
        value: original,
      });
      state.installed = false;
    },
  };
  probe.abort = state;
  Object.defineProperty(IDBObjectStore.prototype, target.operation, {
    configurable: true,
    writable: true,
    value(this: IDBObjectStore, ...args: unknown[]) {
      const request = Reflect.apply(original, this, args) as IDBRequest;
      if (
        this.name === target.store &&
        (!target.profileName || (args[0] as { name?: string })?.name === target.profileName)
      ) {
        state.restore();
        request.addEventListener(
          "success",
          () => {
            ++state.injected;
            request.transaction?.abort();
          },
          { once: true },
        );
      }
      return request;
    },
  });
  return true;
}

async function holdCrypto(page: Page, origin: string) {
  assert.equal(await workerCall(page, origin, installCryptoGate, undefined), true);
}
async function waitForCrypto(page: Page, origin: string, count: number) {
  await waitUntil(
    async () =>
      (await workerCall(
        page,
        origin,
        () => (globalThis as ProbeGlobal).deploymentStorageProbe?.crypto?.held ?? 0,
        undefined,
      )) === count,
    { timeoutMsg: `Worker crypto gate did not hold ${count} operations` },
  );
}
async function releaseCrypto(page: Page, origin: string, index: number) {
  await workerCall(
    page,
    origin,
    (index: number) => {
      (globalThis as ProbeGlobal).deploymentStorageProbe?.crypto?.release(index);
      return true;
    },
    index,
  );
}
async function restoreWorker(page: Page, origin: string) {
  const restored = await workerCall(
    page,
    origin,
    () => {
      const probe = (globalThis as ProbeGlobal).deploymentStorageProbe;
      probe?.crypto?.restore();
      probe?.abort?.restore();
      return {
        crypto:
          !probe?.crypto?.installed &&
          (probe?.crypto?.held ?? 0) === (probe?.crypto?.released ?? 0),
        idb: !probe?.abort?.installed,
      };
    },
    undefined,
  );
  assert.deepEqual(
    restored,
    { crypto: true, idb: true },
    "all Worker faults must be released and restored",
  );
}
async function abortNext(page: Page, origin: string, target: AbortRequest) {
  assert.equal(await workerCall(page, origin, installAbort, target), true);
}
async function assertAborted(page: Page, origin: string) {
  const state = await workerCall(
    page,
    origin,
    () => {
      const abort = (globalThis as ProbeGlobal).deploymentStorageProbe?.abort;
      return { injected: abort?.injected, installed: abort?.installed };
    },
    undefined,
  );
  assert.deepEqual(
    state,
    { injected: 1, installed: false },
    "the actual Worker request must succeed, then abort its transaction exactly once",
  );
}

async function fillProfile(
  page: Page,
  connection: Connection,
  name: string,
  remember: boolean,
  secret = password,
) {
  await page.getByTestId("profile-option-new").click();
  await page.getByTestId("connect-profile-name").fill(name);
  await page.getByTestId("connect-server-url").fill(connection.baseUrl);
  await page.getByTestId("connect-api-key").fill(connection.apiKey);
  await page.getByTestId("connect-password").fill(secret);
  await page.getByTestId("connect-password-confirm").fill(secret);
  const checkbox = page.getByTestId("connect-remember");
  if ((await checkbox.getAttribute("aria-checked")) === String(!remember)) await checkbox.click();
}
async function saveProfile(
  page: Page,
  connection: Connection,
  name: string,
  remember = true,
  secret = password,
) {
  await fillProfile(page, connection, name, remember, secret);
  await page.getByTestId("connect-submit").click();
  await page.getByTestId(`profile-option-${name}`).waitFor({ state: "visible" });
}
async function unlock(page: Page, secret = password) {
  await page.getByTestId("unlock-dialog").waitFor({ state: "visible" });
  await page.getByTestId("unlock-passphrase").fill(secret);
  await page.getByTestId("unlock-submit").click();
}
async function login(page: Page, name: string, secret = password) {
  await page.getByTestId(`profile-option-${name}`).click();
  await unlock(page, secret);
  await page.getByTestId("section-home").waitFor({ state: "visible" });
}
async function expectProfile(page: Page, name: string) {
  await page.getByTestId("profile-menu-trigger").click();
  assert.ok(
    (await page.getByTestId("profile-menu").innerText()).includes(name),
    `active profile should be ${name}`,
  );
  await page.keyboard.press("Escape");
}
async function security(page: Page) {
  await page.getByTestId("profile-menu-trigger").click();
  await page.getByTestId("open-server-settings").click();
  await page.getByTestId("server-tab-security").click();
}
async function changePassword(page: Page, previous: string, next: string) {
  await page.getByTestId("security-change-passphrase").click();
  await fillPasswordChange(page, previous, next);
  await page.getByTestId("security-change-submit").click();
}
async function fillPasswordChange(page: Page, previous: string, next: string) {
  await page.getByTestId("security-current-passphrase").fill(previous);
  await page.getByTestId("security-change-new-passphrase").fill(next);
  await page.getByTestId("security-change-confirm-passphrase").fill(next);
}
async function logout(page: Page) {
  await page.getByTestId("profile-menu-trigger").click();
  await page.getByTestId("logout").click();
  await page.getByTestId("profile-option-new").waitFor({ state: "visible" });
}
async function loggedInPair(context: BrowserContext, origin: string, connection: Connection) {
  const a = await context.newPage();
  await a.goto(`${origin}/login`);
  await saveProfile(a, connection, "Shared");
  await login(a, "Shared");
  const b = await context.newPage();
  await b.goto(`${origin}/home`);
  await b.getByTestId("section-home").waitFor({ state: "visible" });
  return { a, b };
}

async function vaultSnapshot(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("headscale-ui");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const tx = db.transaction(["profiles", "keys", "meta"], "readonly");
      const profiles = tx.objectStore("profiles").getAll();
      const meta = tx.objectStore("meta").getAll();
      const metaKeys = tx.objectStore("meta").getAllKeys();
      const keys = tx.objectStore("keys").getAllKeys();
      const version = tx.objectStore("meta").get("vault-state");
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      const digest = async (value: unknown) =>
        Array.from(
          new Uint8Array(
            await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))),
          ),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
      const active: Record<string, unknown> = {};
      metaKeys.result.forEach((key, index) => {
        if (String(key).startsWith("active-profile")) active[String(key)] = meta.result[index];
      });
      return {
        databaseVersion: db.version,
        version: version.result,
        active,
        keys: keys.result,
        metaKeys: metaKeys.result,
        fingerprint: await digest({
          profiles: profiles.result,
          meta: meta.result,
          keys: keys.result,
          metaKeys: metaKeys.result,
        }),
        profiles: await Promise.all(
          profiles.result.map(async (row) => ({
            id: row.id as string,
            name: row.name as string,
            scope: row.scope as string,
            ownerTabId: row.ownerTabId as string | undefined,
            secretVersion: row.apiKey?.v as number | undefined,
            keyEpoch: row.keyEpoch as string | undefined,
            fingerprint: await digest(row),
            // The row without the migration-owned key epoch: legacy fields must survive untouched.
            core: await digest({ ...row, keyEpoch: undefined }),
          })),
        ),
      };
    } finally {
      db.close();
    }
  });
}

async function credentialMatches(page: Page, connection: Connection, name: string, secret: string) {
  return page.evaluate(
    async ({ expected, name, password }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("headscale-ui");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = db.transaction(["profiles", "keys", "meta"], "readonly");
      const request = tx.objectStore("profiles").getAll();
      const device = tx.objectStore("keys").get("device-key");
      const canary = tx.objectStore("meta").get("password-canary");
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      db.close();
      const row = request.result.find((item) => item.name === name);
      if (!row || ![1, 2].includes(row.apiKey?.v)) return false;
      const bytes = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
      const legacy = row.apiKey.v === 1;
      if (legacy && row.apiKey.scheme === "device") {
        try {
          const plain = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: bytes(row.apiKey.iv) },
            device.result,
            bytes(row.apiKey.ct),
          );
          return new TextDecoder().decode(plain) === expected;
        } catch {
          return false;
        }
      }
      const kdf = legacy ? canary.result : row.apiKey.kdf;
      const imported = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(password),
        "PBKDF2",
        false,
        ["deriveKey"],
      );
      const key = await crypto.subtle.deriveKey(
        {
          name: "PBKDF2",
          hash: "SHA-256",
          salt: bytes(kdf.salt),
          iterations: kdf.iterations,
        },
        imported,
        { name: "AES-GCM", length: 256 },
        false,
        ["decrypt"],
      );
      try {
        if (legacy) {
          const proof = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: bytes(canary.result.iv) },
            key,
            bytes(canary.result.ct),
          );
          if (new TextDecoder().decode(proof) !== "headscale-ui:canary:v1") return false;
        }
        const parameters: AesGcmParams = { name: "AES-GCM", iv: bytes(row.apiKey.iv) };
        if (!legacy)
          parameters.additionalData = new TextEncoder().encode(
            JSON.stringify(["headscale-ui/profile", 2, row.id, row.baseUrl, row.credentialVersion]),
          );
        const plain = await crypto.subtle.decrypt(parameters, key, bytes(row.apiKey.ct));
        return new TextDecoder().decode(plain) === expected;
      } catch {
        return false;
      }
    },
    { expected: connection.apiKey, name, password: secret },
  );
}

async function activeDiagnostics(page: Page) {
  return page.evaluate(() => ({
    path: location.pathname,
    owner: sessionStorage.getItem("headscale-ui-tab-id"),
    visible: [...document.querySelectorAll<HTMLElement>("[data-testid]")]
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => element.dataset.testid),
    alertCount: document.querySelectorAll('[role="alert"]').length,
  }));
}
async function storageCase(
  browser: Browser,
  origin: string,
  label: string,
  run: (context: BrowserContext) => Promise<void>,
) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const errors = collectBrowserErrors(context);
  let failure: unknown;
  try {
    await run(context);
    assert.deepEqual(errors, [], `${label}: unhandled page errors or network failures`);
  } catch (error) {
    failure = error;
    console.error(label, JSON.stringify(await Promise.all(context.pages().map(activeDiagnostics))));
  } finally {
    try {
      const page = context.pages().find((candidate) => !candidate.isClosed());
      if (page && patchedContexts.has(context)) await restoreWorker(page, origin);
    } catch (error) {
      failure = failure
        ? new AggregateError([failure, error], `${label}: verification and cleanup failed`)
        : error;
    }
    await context.close();
  }
  if (failure) throw failure;
  console.log(`PASS ${label}`);
}

async function checkOwnership(browser: Browser, origin: string, connection: Connection) {
  await storageCase(
    browser,
    origin,
    "independent profile passwords, owner visibility, shared authorization and global logout",
    async (context) => {
      const a = await context.newPage();
      const b = await context.newPage();
      await Promise.all([a.goto(`${origin}/login`), b.goto(`${origin}/login`)]);
      await saveProfile(a, connection, "Session A", false, "password-A");
      await saveProfile(b, connection, "Persistent B", true, "password-B");
      const initial = await vaultSnapshot(a);
      assert.equal(initial.profiles.length, 2);
      assert.deepEqual(initial.keys, [], "new password profiles must not create a device key");
      assert.ok(await credentialMatches(a, connection, "Session A", "password-A"));
      assert.ok(await credentialMatches(b, connection, "Persistent B", "password-B"));
      assert.equal(await credentialMatches(a, connection, "Session A", "password-B"), false);
      const ownerA = await a.evaluate(() => sessionStorage.getItem("headscale-ui-tab-id"));
      const ownerB = await b.evaluate(() => sessionStorage.getItem("headscale-ui-tab-id"));
      assert.ok(ownerA && ownerB && ownerA !== ownerB);
      assert.equal(await b.getByTestId("profile-option-Session A").count(), 0);
      await login(a, "Session A", "password-A");
      await b.goto(`${origin}/home`);
      await b.getByTestId("section-home").waitFor();
      await expectProfile(b, "Session A");
      await security(b);
      assert.equal(
        await b.getByTestId("security-change-passphrase").count(),
        0,
        "a foreign temporary row is not exposed by the security form",
      );
      await b.goto(`${origin}/login`);
      assert.equal(await b.getByTestId("profile-option-Session A").count(), 0);
      await login(b, "Persistent B", "password-B");
      await expectProfile(a, "Persistent B");
      await a.reload();
      await a.getByTestId("section-home").waitFor();
      assert.equal(await a.evaluate(() => sessionStorage.getItem("headscale-ui-tab-id")), ownerA);
      await expectProfile(a, "Persistent B");

      const opened = context.waitForEvent("page");
      await a.evaluate((url) => {
        window.open(url, "_blank");
      }, `${origin}/home`);
      const copied = await opened;
      await copied.getByTestId("section-home").waitFor();
      assert.equal(
        await copied.evaluate(() => sessionStorage.getItem("headscale-ui-tab-id")),
        ownerA,
      );
      const independentOpened = context.waitForEvent("page");
      await a.evaluate((url) => {
        window.open(url, "_blank", "noopener");
      }, `${origin}/home`);
      const independent = await independentOpened;
      await independent.getByTestId("section-home").waitFor();
      assert.notEqual(
        await independent.evaluate(() => sessionStorage.getItem("headscale-ui-tab-id")),
        ownerA,
      );
      await expectProfile(copied, "Persistent B");
      await expectProfile(independent, "Persistent B");

      const beforeA = (await vaultSnapshot(a)).profiles.find(
        (row) => row.name === "Session A",
      )?.fingerprint;
      await security(b);
      await changePassword(b, "password-B", "password-B-new");
      await Promise.all(
        [a, b, copied, independent].map((page) => page.getByTestId("profile-option-new").waitFor()),
      );
      const changed = await vaultSnapshot(a);
      assert.equal(changed.profiles.find((row) => row.name === "Session A")?.fingerprint, beforeA);
      assert.ok(await credentialMatches(a, connection, "Session A", "password-A"));
      assert.equal(await credentialMatches(a, connection, "Persistent B", "password-B"), false);
      assert.ok(await credentialMatches(a, connection, "Persistent B", "password-B-new"));
      assert.equal(await independent.getByTestId("profile-option-Session A").count(), 0);
      await copied.getByTestId("profile-option-Session A").waitFor();
      await b.getByTestId("profile-option-Persistent B").click();
      await unlock(b, "password-B");
      await b.getByTestId("unlock-error").waitFor();
      assert.equal(await b.getByTestId("unlock-passphrase").inputValue(), "");
      await unlock(b, "password-B-new");
      await b.getByTestId("section-home").waitFor();
      await a.goto(`${origin}/home`);
      await a.getByTestId("section-home").waitFor();
      await logout(b);
      await a.getByTestId("profile-option-new").waitFor();
      await a.reload();
      await a.getByTestId("profile-option-new").waitFor();
      assert.equal(
        await a.getByTestId("section-home").count(),
        0,
        "saved references cannot reauthorize a locked Worker",
      );
      await a.close();
      await copied.close();
      const fresh = await context.newPage();
      await fresh.goto(`${origin}/login`);
      await fresh.getByTestId("profile-option-new").waitFor();
      assert.equal(await fresh.getByTestId("profile-option-Session A").count(), 0);
      assert.ok(
        (await vaultSnapshot(fresh)).profiles.some((row) => row.name === "Session A"),
        "foreign hydration must not delete another owner's temporary row",
      );
      const isolated = await browser.newContext();
      try {
        const page = await isolated.newPage();
        await page.goto(`${origin}/login`);
        await page.getByTestId("profile-option-new").waitFor();
        assert.deepEqual((await vaultSnapshot(page)).profiles, []);
      } finally {
        await isolated.close();
      }
    },
  );
}

async function checkWriteRaces(browser: Browser, origin: string, connection: Connection) {
  await storageCase(
    browser,
    origin,
    "two native Worker password changes admit one CAS winner",
    async (context) => {
      const { a, b } = await loggedInPair(context, origin, connection);
      await Promise.all([security(a), security(b)]);
      await holdCrypto(a, origin);
      await changePassword(a, password, "winner-password");
      await waitForCrypto(a, origin, 1);
      await changePassword(b, password, "loser-password");
      await waitForCrypto(a, origin, 2);
      await releaseCrypto(a, origin, 0);
      await a.getByTestId("profile-option-new").waitFor();
      await releaseCrypto(a, origin, 1);
      await b.getByTestId("login-error").waitFor();
      assert.ok(await credentialMatches(a, connection, "Shared", "winner-password"));
      assert.equal(await credentialMatches(a, connection, "Shared", "loser-password"), false);
      assert.equal((await vaultSnapshot(a)).profiles.length, 1);
      await restoreWorker(a, origin);
      await login(b, "Shared", "winner-password");
    },
  );
  await storageCase(
    browser,
    origin,
    "new profile commit rejects an older password change and permits explicit retry",
    async (context) => {
      const { a, b } = await loggedInPair(context, origin, connection);
      await b.goto(`${origin}/login`);
      await security(a);
      await holdCrypto(a, origin);
      await changePassword(a, password, "retry-password");
      await waitForCrypto(a, origin, 1);
      await fillProfile(b, connection, "Added first", false);
      await b.getByTestId("connect-submit").click();
      await waitForCrypto(a, origin, 2);
      await releaseCrypto(a, origin, 1);
      await b.getByTestId("profile-option-Added first").waitFor();
      await releaseCrypto(a, origin, 0);
      await a.getByTestId("security-error").waitFor();
      assert.equal(await a.getByTestId("security-current-passphrase").inputValue(), "");
      assert.equal((await vaultSnapshot(a)).profiles.length, 2);
      assert.ok(await credentialMatches(a, connection, "Shared", password));
      await restoreWorker(a, origin);
      await fillPasswordChange(a, password, "retry-password");
      await a.getByTestId("security-change-submit").click();
      await a.getByTestId("profile-option-new").waitFor();
      assert.ok(await credentialMatches(a, connection, "Shared", "retry-password"));
      assert.ok(await credentialMatches(a, connection, "Added first", password));
    },
  );
  await storageCase(
    browser,
    origin,
    "credential change rejects a delayed encrypted save without resurrecting its row",
    async (context) => {
      const { a, b } = await loggedInPair(context, origin, connection);
      await b.goto(`${origin}/login`);
      await fillProfile(b, connection, "Late profile", false);
      await holdCrypto(a, origin);
      await b.getByTestId("connect-submit").click();
      await waitForCrypto(a, origin, 1);
      await security(a);
      await changePassword(a, password, "changed-password");
      await waitForCrypto(a, origin, 2);
      await releaseCrypto(a, origin, 1);
      await a.getByTestId("profile-option-new").waitFor();
      await releaseCrypto(a, origin, 0);
      await b.getByTestId("connect-error").waitFor();
      assert.equal(await b.getByTestId("connect-profile-name").inputValue(), "Late profile");
      assert.equal(await b.getByTestId("connect-api-key").inputValue(), "");
      assert.equal(await b.getByTestId("connect-password").inputValue(), "");
      assert.equal((await vaultSnapshot(a)).profiles.length, 1);
      assert.ok(await credentialMatches(a, connection, "Shared", "changed-password"));
    },
  );
  await storageCase(
    browser,
    origin,
    "reset cancels a delayed Worker save and prevents pre-reset ciphertext returning",
    async (context) => {
      const { a, b } = await loggedInPair(context, origin, connection);
      await b.goto(`${origin}/login`);
      await fillProfile(b, connection, "Must not return", true);
      await holdCrypto(a, origin);
      await b.getByTestId("connect-submit").click();
      await waitForCrypto(a, origin, 1);
      await security(a);
      await a.getByTestId("security-clear-all").click();
      await a.getByTestId("security-clear-all-confirm").click();
      await a.getByTestId("profile-option-new").waitFor();
      await releaseCrypto(b, origin, 0);
      await waitUntil(async () => (await vaultSnapshot(b)).profiles.length === 0);
      await b.reload();
      await b.getByTestId("profile-option-new").waitFor();
      const after = await vaultSnapshot(b);
      assert.equal(after.profiles.length, 0);
      assert.equal(after.version.profilesRevision, 0);
      assert.deepEqual(after.keys, []);
    },
  );
  await storageCase(
    browser,
    origin,
    "two distinct native saves retain the loser draft and require fresh secrets for retry",
    async (context) => {
      const a = await context.newPage();
      const b = await context.newPage();
      await Promise.all([a.goto(`${origin}/login`), b.goto(`${origin}/login`)]);
      await Promise.all([
        fillProfile(a, connection, "First", true),
        fillProfile(b, connection, "Second", true),
      ]);
      await holdCrypto(a, origin);
      await a.getByTestId("connect-submit").click();
      await waitForCrypto(a, origin, 1);
      await b.getByTestId("connect-submit").click();
      await waitForCrypto(a, origin, 2);
      await releaseCrypto(a, origin, 0);
      await a.getByTestId("profile-option-First").waitFor();
      await releaseCrypto(a, origin, 1);
      await b.getByTestId("connect-error").waitFor();
      assert.equal(await b.getByTestId("connect-profile-name").inputValue(), "Second");
      assert.equal(await b.getByTestId("connect-api-key").inputValue(), "");
      assert.equal(await b.getByTestId("connect-password").inputValue(), "");
      await restoreWorker(a, origin);
      await b.getByTestId("connect-api-key").fill(connection.apiKey);
      await b.getByTestId("connect-password").fill(password);
      await b.getByTestId("connect-password-confirm").fill(password);
      await b.getByTestId("connect-submit").click();
      await b.getByTestId("profile-option-Second").waitFor();
      assert.deepEqual((await vaultSnapshot(b)).profiles.map((row) => row.name).sort(), [
        "First",
        "Second",
      ]);
      assert.ok(await credentialMatches(b, connection, "First", password));
      assert.ok(await credentialMatches(b, connection, "Second", password));
    },
  );
}

async function checkTransactionAborts(browser: Browser, origin: string, connection: Connection) {
  await storageCase(
    browser,
    origin,
    "Worker request success then abort preserves save/delete/change/reset records and locks reset",
    async (context) => {
      const page = await context.newPage();
      await page.goto(`${origin}/login`);
      await saveProfile(page, connection, "Retained");
      const keeper = await context.newPage();
      await keeper.goto(`${origin}/login`);
      await keeper.getByTestId("profile-option-Retained").waitFor();
      const before = await vaultSnapshot(page);
      await abortNext(page, origin, {
        store: "profiles",
        operation: "put",
        profileName: "Aborted save",
      });
      await fillProfile(page, connection, "Aborted save", true);
      await page.getByTestId("connect-submit").click();
      await page.getByTestId("connect-error").waitFor();
      await assertAborted(page, origin);
      assert.equal(await page.getByTestId("connect-profile-name").inputValue(), "Aborted save");
      assert.equal(await page.getByTestId("connect-api-key").inputValue(), "");
      assert.equal((await vaultSnapshot(page)).fingerprint, before.fingerprint);
      await page.reload();
      await page.getByTestId("profile-option-Retained").waitFor();
      await abortNext(page, origin, { store: "profiles", operation: "delete" });
      await page.getByTestId("delete-profile-Retained").click();
      await page.getByTestId("confirm-delete-profile").click();
      await page.getByTestId("delete-profile-error").waitFor();
      await assertAborted(page, origin);
      assert.equal((await vaultSnapshot(page)).fingerprint, before.fingerprint);
      await page.getByTestId("cancel-delete-profile").click();
      await login(page, "Retained");
      assert.equal(
        (await vaultSnapshot(page)).fingerprint,
        before.fingerprint,
        "unlock must not persist a new authorization reference",
      );
      await security(page);
      await abortNext(page, origin, {
        store: "profiles",
        operation: "put",
        profileName: "Retained",
      });
      await changePassword(page, password, "aborted-password");
      await page.getByTestId("security-error").waitFor();
      await assertAborted(page, origin);
      assert.equal((await vaultSnapshot(page)).fingerprint, before.fingerprint);
      assert.equal(await page.getByTestId("security-current-passphrase").inputValue(), "");
      assert.ok(await credentialMatches(page, connection, "Retained", password));
      await page.getByTestId("security-change-cancel").click();
      await abortNext(page, origin, { store: "profiles", operation: "clear" });
      const timeOrigin = await page.evaluate(() => performance.timeOrigin);
      await page.getByTestId("security-clear-all").click();
      await page.getByTestId("security-clear-all-confirm").click();
      await page.getByTestId("profile-option-new").waitFor();
      await page.getByTestId("login-error").waitFor();
      await assertAborted(page, origin);
      assert.equal((await vaultSnapshot(page)).fingerprint, before.fingerprint);
      assert.equal(
        await page.evaluate(() => performance.timeOrigin),
        timeOrigin,
        "aborted reset must retain its document",
      );
      await page.reload();
      await page.getByTestId("profile-option-Retained").waitFor();
      assert.equal(await page.getByTestId("section-home").count(), 0);
      assert.ok(await credentialMatches(page, connection, "Retained", password));
    },
  );
}

async function checkRestoredSession(origin: string, connection: Connection, scratch: string) {
  const directory = mkdtempSync(join(scratch, "headscale-session-restore-"));
  let context: BrowserContext | undefined;
  try {
    const options = {
      headless: true,
      channel: "chromium",
      args: ["--restore-last-session"],
      timeout: 20000,
    };
    context = await chromium.launchPersistentContext(directory, options);
    const errors = collectBrowserErrors(context);
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${origin}/login`);
    await saveProfile(page, connection, "Restored session", false);
    await login(page, "Restored session");
    const owner = await page.evaluate(() => sessionStorage.getItem("headscale-ui-tab-id"));
    assert.ok(owner);
    const before = await vaultSnapshot(page);
    assert.deepEqual(errors, []);
    await context.close();
    context = await chromium.launchPersistentContext(directory, options);
    const restoredErrors = collectBrowserErrors(context);
    await waitUntil(
      async () => context?.pages().some((candidate) => candidate.url().startsWith(origin)) ?? false,
    );
    const restored = context.pages().find((candidate) => candidate.url().startsWith(origin));
    assert.ok(restored, "Chromium must restore the original page session");
    await restored.getByTestId("profile-option-Restored session").waitFor();
    assert.equal(
      await restored.evaluate(() => sessionStorage.getItem("headscale-ui-tab-id")),
      owner,
    );
    assert.equal(
      await restored.getByTestId("section-home").count(),
      0,
      "a new Worker cannot recover plaintext authorization after process restart",
    );
    assert.equal((await vaultSnapshot(restored)).fingerprint, before.fingerprint);
    await login(restored, "Restored session");
    assert.ok(await credentialMatches(restored, connection, "Restored session", password));
    assert.deepEqual(restoredErrors, []);
    console.log(
      "PASS native Chromium process restart preserves owner and encrypted row but requires fresh unlock",
    );
  } finally {
    await context?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Schema 1 is the original database: no key epochs, no vault-state, a plain active-profile id. */
async function seedLegacy(page: Page, origin: string, connection: Connection, schema = 2) {
  await page.route(`${origin}/__legacy_probe__`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Legacy database fixture</title>",
    }),
  );
  await page.goto(`${origin}/__legacy_probe__`);
  await page.evaluate(
    async ({ baseUrl, apiKey, schema }) => {
      const base64 = (value: Uint8Array) => btoa(String.fromCharCode(...value));
      const deviceKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]);
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const imported = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode("legacy-passphrase"),
        "PBKDF2",
        false,
        ["deriveKey"],
      );
      const passwordKey = await crypto.subtle.deriveKey(
        { name: "PBKDF2", hash: "SHA-256", salt, iterations: 310000 },
        imported,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
      const encrypt = async (plain: string, key: CryptoKey) => {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = new Uint8Array(
          await crypto.subtle.encrypt(
            { name: "AES-GCM", iv },
            key,
            new TextEncoder().encode(plain),
          ),
        );
        return { v: 1, iv: base64(iv), ct: base64(ct) };
      };
      const keyEpoch = crypto.randomUUID();
      const profiles = [
        {
          id: "legacy-persistent",
          name: "Legacy persistent",
          baseUrl,
          keyEpoch,
          updatedAt: "2026-10-10T00:00:00Z",
          scope: "persistent",
          apiKey: { ...(await encrypt(apiKey, deviceKey)), scheme: "device" },
          legacyMarker: { preserved: true },
        },
        {
          id: "legacy-session",
          name: "Legacy hidden session",
          baseUrl,
          keyEpoch,
          updatedAt: "2026-10-10T00:00:00Z",
          scope: "session",
          ownerTabId: "legacy-owner",
          apiKey: { ...(await encrypt(apiKey, passwordKey)), scheme: "password" },
          legacyMarker: [1, 2, 3],
        },
        {
          id: "legacy-other-device",
          name: "Legacy other device",
          baseUrl,
          keyEpoch,
          updatedAt: "2026-10-10T00:00:00Z",
          scope: "persistent",
          apiKey: { ...(await encrypt(apiKey, deviceKey)), scheme: "device" },
        },
        {
          id: "legacy-unknown",
          name: "Unknown credential",
          baseUrl,
          keyEpoch,
          scope: "persistent",
          apiKey: { v: 99, unknown: true },
          future: { untouched: true },
        },
      ];
      if (schema === 1)
        for (const profile of profiles) delete (profile as { keyEpoch?: string }).keyEpoch;
      const canary = {
        ...(await encrypt("headscale-ui:canary:v1", passwordKey)),
        salt: base64(salt),
        iterations: 310000,
      };
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("headscale-ui", schema);
        request.onupgradeneeded = () => {
          request.result.createObjectStore("profiles", { keyPath: "id" });
          request.result.createObjectStore("keys");
          request.result.createObjectStore("meta");
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = db.transaction(["profiles", "keys", "meta"], "readwrite");
      for (const profile of profiles) tx.objectStore("profiles").put(profile);
      tx.objectStore("keys").put(deviceKey, "device-key");
      tx.objectStore("meta").put(canary, "password-canary");
      if (schema === 2)
        tx.objectStore("meta").put({ v: 1, keyEpoch, profilesRevision: 4 }, "vault-state");
      tx.objectStore("meta").put({ locale: "en-US", theme: "dark" }, "ui-settings");
      tx.objectStore("meta").put({ future: ["preserve"] }, "legacy-extra");
      tx.objectStore("meta").put(
        schema === 1
          ? "legacy-persistent"
          : { profileId: "legacy-persistent", operationId: "old-reference" },
        "active-profile-id",
      );
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      const target = window as LegacyWindow;
      target.deploymentLegacyDb = db;
      db.onversionchange = () => {
        target.deploymentVersionChange = true;
      };
    },
    { baseUrl: connection.baseUrl, apiKey: connection.apiKey, schema },
  );
}
/** Page-realm fault: the first v3 open aborts its version-change transaction once per tab. */
async function abortFirstUpgrade(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("deployment-aborted-upgrade")) return;
    sessionStorage.setItem("deployment-aborted-upgrade", "1");
    const originalOpen = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (name: string, version?: number) {
      const request = originalOpen.call(this, name, version);
      if (name === "headscale-ui" && version === 3)
        request.addEventListener(
          "upgradeneeded",
          () => {
            (window as LegacyWindow).deploymentUpgradeAborts =
              ((window as LegacyWindow).deploymentUpgradeAborts ?? 0) + 1;
            IDBFactory.prototype.open = originalOpen;
            request.transaction?.abort();
          },
          { once: true },
        );
      return request;
    };
  });
}
async function migrate(page: Page, next = password) {
  await page.getByTestId("migration-new-password").fill(next);
  await page.getByTestId("migration-confirm-password").fill(next);
  await page.getByTestId("migration-submit").click();
}

async function checkDatabaseUpgrade(browser: Browser, origin: string, connection: Connection) {
  await storageCase(
    browser,
    origin,
    "native v2 blocker closes, v3 preserves raw rows, and old open(2) is fenced",
    async (context) => {
      const old = await context.newPage();
      await seedLegacy(old, origin, connection);
      const original = await vaultSnapshot(old);
      const current = await context.newPage();
      await current.goto(`${origin}/home`);
      await old.waitForFunction(() => (window as LegacyWindow).deploymentVersionChange);
      await current.getByTestId("error-screen").waitFor();
      assert.equal(await current.getByTestId("error-reset").count(), 0);
      await old.close();
      await current.getByTestId("profile-option-Legacy persistent").waitFor();
      const upgraded = await vaultSnapshot(current);
      assert.equal(upgraded.databaseVersion, 3);
      assert.equal(upgraded.fingerprint, original.fingerprint);
      assert.equal(await current.getByTestId("section-home").count(), 0);
      assert.equal(await current.getByTestId("profile-option-Legacy hidden session").count(), 0);
      const oldOpenResult = await current.evaluate(
        () =>
          new Promise<string>((resolve) => {
            const request = indexedDB.open("headscale-ui", 2);
            request.onerror = () => resolve(request.error?.name ?? "unknown");
            request.onsuccess = () => {
              request.result.close();
              resolve("opened");
            };
          }),
      );
      assert.equal(oldOpenResult, "VersionError");
      await current.getByTestId("profile-option-Legacy persistent").click();
      await migrate(current);
      await current.getByTestId("section-home").waitFor();
      const migrated = await vaultSnapshot(current);
      for (const name of ["Legacy hidden session", "Legacy other device", "Unknown credential"])
        assert.equal(
          migrated.profiles.find((row) => row.name === name)?.fingerprint,
          original.profiles.find((row) => row.name === name)?.fingerprint,
        );
      assert.ok(migrated.keys.includes("device-key"));
      assert.ok(migrated.metaKeys.includes("password-canary"));
      assert.ok(await credentialMatches(current, connection, "Legacy persistent", password));
      assert.ok(
        await credentialMatches(current, connection, "Legacy hidden session", "legacy-passphrase"),
      );
      assert.ok(await credentialMatches(current, connection, "Legacy other device", ""));
    },
  );
  await storageCase(
    browser,
    origin,
    "aborted v2 to v3 version bump keeps records",
    async (context) => {
      const old = await context.newPage();
      await seedLegacy(old, origin, connection);
      const original = await vaultSnapshot(old);
      await old.close();
      const current = await context.newPage();
      await abortFirstUpgrade(current);
      await current.goto(`${origin}/home`);
      await current.getByTestId("error-screen").waitFor();
      assert.equal(
        await current.evaluate(() => (window as LegacyWindow).deploymentUpgradeAborts),
        1,
        "the actual bootstrap settings upgrade must reach the native fault",
      );
      assert.deepEqual(await vaultSnapshot(current), original);
      assert.equal(await current.getByTestId("error-reset").count(), 0);
      await current.getByTestId("error-reload").click();
      await current.getByTestId("profile-option-Legacy persistent").waitFor();
      const upgraded = await vaultSnapshot(current);
      assert.equal(upgraded.databaseVersion, 3);
      assert.equal(upgraded.fingerprint, original.fingerprint);
    },
  );
  await storageCase(
    browser,
    origin,
    "real v1 to v3 migration aborts atomically",
    async (context) => {
      const old = await context.newPage();
      await seedLegacy(old, origin, connection, 1);
      const original = await vaultSnapshot(old);
      assert.equal(original.databaseVersion, 1);
      assert.equal(original.version, undefined, "a v1 database has no vault-state");
      assert.ok(original.profiles.every((row) => row.keyEpoch === undefined));
      await old.close();
      const current = await context.newPage();
      // Abort after the vault-state write and the first rewritten profile: the real migration order.
      await current.addInitScript(() => {
        if (sessionStorage.getItem("deployment-aborted-migration")) return;
        sessionStorage.setItem("deployment-aborted-migration", "1");
        const original = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (
          this: IDBObjectStore,
          ...args: Parameters<IDBObjectStore["put"]>
        ) {
          const request = Reflect.apply(original, this, args) as IDBRequest;
          const value: unknown = args[0];
          if (
            this.name === "profiles" &&
            value !== null &&
            typeof value === "object" &&
            "keyEpoch" in value
          ) {
            IDBObjectStore.prototype.put = original;
            request.addEventListener(
              "success",
              () => {
                (window as LegacyWindow).deploymentMigrationAborts =
                  ((window as LegacyWindow).deploymentMigrationAborts ?? 0) + 1;
                request.transaction?.abort();
              },
              { once: true },
            );
          }
          return request;
        };
      });
      await current.goto(`${origin}/home`);
      await current.getByTestId("error-screen").waitFor();
      assert.equal(
        await current.evaluate(() => (window as LegacyWindow).deploymentMigrationAborts),
        1,
        "the actual v1 migration must reach the mid-migration fault",
      );
      assert.equal(await current.getByTestId("error-reset").count(), 0);
      assert.deepEqual(
        await vaultSnapshot(current),
        original,
        "an aborted migration leaves the version-1 database untouched",
      );
      await current.getByTestId("error-reload").click();
      await current.getByTestId("profile-option-Legacy persistent").waitFor();
      const upgraded = await vaultSnapshot(current);
      assert.equal(upgraded.databaseVersion, 3);
      assert.ok(upgraded.version?.keyEpoch, "migration creates the vault-state");
      for (const row of upgraded.profiles) {
        assert.equal(row.keyEpoch, upgraded.version.keyEpoch, `${row.name} key epoch`);
        assert.equal(
          row.core,
          original.profiles.find((item) => item.id === row.id)?.fingerprint,
          `${row.name} legacy fields survive the migration`,
        );
      }
      assert.deepEqual(
        Object.keys(upgraded.active),
        ["active-profile-id"],
        "the plain active id becomes one reference",
      );
      assert.deepEqual(Object.keys(upgraded.active["active-profile-id"] as object).sort(), [
        "operationId",
        "profileId",
      ]);
      assert.equal(
        (upgraded.active["active-profile-id"] as { profileId: string }).profileId,
        "legacy-persistent",
      );
      assert.ok(upgraded.keys.includes("device-key"));
      assert.ok(upgraded.metaKeys.includes("password-canary"));
    },
  );
  await storageCase(
    browser,
    origin,
    "Worker migration abort retains original legacy row, keys, canary and explicit retry",
    async (context) => {
      const seed = await context.newPage();
      await seedLegacy(seed, origin, connection);
      await seed.close();
      const page = await context.newPage();
      await page.goto(`${origin}/login`);
      await page.getByTestId("profile-option-Legacy persistent").waitFor();
      const before = await vaultSnapshot(page);
      await page.getByTestId("profile-option-Legacy persistent").click();
      await abortNext(page, origin, {
        store: "profiles",
        operation: "put",
        profileName: "Legacy persistent",
      });
      await migrate(page);
      await page.getByTestId("unlock-error").waitFor();
      await assertAborted(page, origin);
      assert.equal((await vaultSnapshot(page)).fingerprint, before.fingerprint);
      assert.equal(await page.getByTestId("migration-new-password").inputValue(), "");
      await migrate(page);
      await page.getByTestId("section-home").waitFor();
      const after = await vaultSnapshot(page);
      assert.equal(after.profiles.length, before.profiles.length);
      assert.ok(after.keys.includes("device-key"));
      assert.ok(after.metaKeys.includes("password-canary"));
      for (const name of ["Legacy hidden session", "Legacy other device", "Unknown credential"])
        assert.equal(
          after.profiles.find((row) => row.name === name)?.fingerprint,
          before.profiles.find((row) => row.name === name)?.fingerprint,
        );
      assert.ok(await credentialMatches(page, connection, "Legacy persistent", password));
      assert.ok(
        await credentialMatches(page, connection, "Legacy hidden session", "legacy-passphrase"),
      );
      assert.ok(await credentialMatches(page, connection, "Legacy other device", ""));
    },
  );
}

async function checkMigrationRaces(browser: Browser, origin: string, connection: Connection) {
  await storageCase(
    browser,
    origin,
    "a concurrent new save fences a delayed legacy migration and permits fresh-password retry",
    async (context) => {
      const seed = await context.newPage();
      await seedLegacy(seed, origin, connection);
      await seed.close();
      const a = await context.newPage();
      const b = await context.newPage();
      await Promise.all([a.goto(`${origin}/login`), b.goto(`${origin}/login`)]);
      await a.getByTestId("profile-option-Legacy persistent").click();
      const before = await vaultSnapshot(a);
      await holdCrypto(a, origin);
      await migrate(a);
      await waitForCrypto(a, origin, 1);
      await fillProfile(b, connection, "Concurrent new server", true);
      await b.getByTestId("connect-submit").click();
      await waitForCrypto(a, origin, 2);
      await releaseCrypto(a, origin, 1);
      await b.getByTestId("profile-option-Concurrent new server").waitFor();
      await releaseCrypto(a, origin, 0);
      await a.getByTestId("unlock-error").waitFor();
      const failed = await vaultSnapshot(a);
      for (const row of before.profiles)
        assert.equal(
          failed.profiles.find((item) => item.id === row.id)?.fingerprint,
          row.fingerprint,
        );
      assert.equal(failed.profiles.length, before.profiles.length + 1);
      assert.equal(await a.getByTestId("migration-new-password").inputValue(), "");
      await restoreWorker(a, origin);
      await migrate(a);
      await a.getByTestId("section-home").waitFor();
      assert.ok(await credentialMatches(a, connection, "Legacy persistent", password));
      assert.ok(await credentialMatches(a, connection, "Concurrent new server", password));
      assert.ok(
        await credentialMatches(a, connection, "Legacy hidden session", "legacy-passphrase"),
      );
    },
  );
  await storageCase(
    browser,
    origin,
    "reset cancels a delayed native legacy migration without restoring old ciphertext",
    async (context) => {
      const seed = await context.newPage();
      await seedLegacy(seed, origin, connection);
      await seed.close();
      const a = await context.newPage();
      const b = await context.newPage();
      await Promise.all([a.goto(`${origin}/login`), b.goto(`${origin}/login`)]);
      await a.getByTestId("profile-option-Legacy persistent").click();
      await b.getByTestId("profile-option-Legacy other device").click();
      await holdCrypto(a, origin);
      await migrate(a);
      await waitForCrypto(a, origin, 1);
      await b.getByTestId("unlock-forgot").click();
      await b.getByTestId("unlock-forgot-confirm").click();
      await b.getByTestId("profile-option-new").waitFor();
      await releaseCrypto(a, origin, 0);
      await a.reload();
      await a.getByTestId("profile-option-new").waitFor();
      const after = await vaultSnapshot(a);
      assert.deepEqual(after.profiles, []);
      assert.deepEqual(after.keys, []);
      assert.equal(after.metaKeys.includes("password-canary"), false);
      assert.equal(after.version.profilesRevision, 0);
      assert.equal(await a.getByTestId("section-home").count(), 0);
    },
  );
}

async function deleteVaultState(page: Page) {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("headscale-ui");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const tx = db.transaction("meta", "readwrite");
      tx.objectStore("meta").delete("vault-state");
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  });
}

/** Startup recovery screens against one deployment path; also run for every sub-path build. */
export async function checkVaultRecovery(
  browser: Browser,
  origin: string,
  base: string,
  connection: Connection,
) {
  const url = (path: string) => `${origin}${base}${path}`;
  await storageCase(
    browser,
    origin,
    `${base} a missing vault-state is repaired only through the confirmed Worker reset`,
    async (context) => {
      const page = await context.newPage();
      await page.goto(url("login"));
      await saveProfile(page, connection, "Vault reset");
      await deleteVaultState(page);
      await page.reload();
      await page.getByTestId("error-screen").waitFor();
      await page.getByTestId("error-reset").click();
      await page.getByTestId("error-reset-confirm").click();
      await page.getByTestId("profile-option-new").waitFor();
      assert.equal(await page.getByTestId("profile-option-Vault reset").count(), 0);
      assert.equal(await page.getByTestId("error-screen").count(), 0);
      const after = await vaultSnapshot(page);
      assert.deepEqual(after.profiles, []);
      assert.equal(after.version.profilesRevision, 0, "a fresh vault-state was recreated");
    },
  );
  await storageCase(
    browser,
    origin,
    `${base} a blocked then aborted upgrade shows the blocker first, then the real error`,
    async (context) => {
      const old = await context.newPage();
      await seedLegacy(old, origin, connection);
      const original = await vaultSnapshot(old);
      const current = await context.newPage();
      await abortFirstUpgrade(current);
      await current.goto(url("home"));
      const screen = current.getByTestId("error-screen");
      await screen.waitFor();
      assert.match(await screen.innerText(), /Close older Headscale UI tabs/);
      await old.close();
      await screen.locator("pre").waitFor();
      assert.doesNotMatch(await screen.innerText(), /Close older Headscale UI tabs/);
      assert.match(await screen.locator("pre").innerText(), /AbortError/);
      assert.equal(await current.getByTestId("error-reset").count(), 0);
      assert.equal(
        await current.evaluate(() => (window as LegacyWindow).deploymentUpgradeAborts),
        1,
      );
      assert.deepEqual(await vaultSnapshot(current), original);
    },
  );
}

export async function checkStorage(
  browser: Browser,
  origin: string,
  connection: Connection,
  scratch: string,
) {
  await checkOwnership(browser, origin, connection);
  await checkWriteRaces(browser, origin, connection);
  await checkTransactionAborts(browser, origin, connection);
  await checkRestoredSession(origin, connection, scratch);
  await checkDatabaseUpgrade(browser, origin, connection);
  await checkMigrationRaces(browser, origin, connection);
  await checkVaultRecovery(browser, origin, "/", connection);
}
