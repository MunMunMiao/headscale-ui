import assert from "node:assert/strict";
import type { Browser, Page } from "playwright";
import {
  LOCALE_META,
  type Locale,
  SUPPORTED_LOCALES,
} from "../../src/i18n/locales";
import { waitUntil } from "../harness/wait-until";

async function selectLocale(page: Page, locale: string) {
  await page.getByTestId("locale-select").click();
  await page.getByTestId(`locale-option-${locale}`).click();
}

/** A failed catalog load is reported through the shared notification surface. */
function languageLoadFailure(page: Page) {
  return page.getByRole("dialog", {
    name: "The language could not be loaded. Please try again.",
    exact: true,
  });
}

async function languageReady(page: Page, locale: string) {
  await page.waitForFunction(
    (expected) => document.documentElement.lang === expected,
    locale,
  );
  await page.getByTestId("locale-pending").waitFor({ state: "hidden" });
  // SharedWorker startup may not emit a page request-finished event.
  await page
    .getByTestId("profile-option-new")
    .and(page.locator(":enabled"))
    .waitFor({ state: "visible" });
}

/** The locale stored by the application itself (no schema version: never upgrades). */
async function persistedLocale(page: Page): Promise<string | undefined> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("headscale-ui");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const request = db
        .transaction("meta", "readonly")
        .objectStore("meta")
        .get("ui-settings");
      return await new Promise<string | undefined>((resolve, reject) => {
        request.onsuccess = () =>
          resolve((request.result as { locale?: string })?.locale);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  });
}

async function openSeeded(
  browser: Browser,
  origin: string,
  base: string,
  locale: Locale,
) {
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const requests: string[] = [];
  const errors: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      pathname.endsWith(".js") &&
      pathname !== `${base}shared-session-worker.js`
    )
      requests.push(pathname);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(`${origin}${base}__locale_seed__`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Locale fixture</title>",
    }),
  );
  await page.goto(`${origin}${base}__locale_seed__`);
  await page.evaluate(async (requestedLocale) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("headscale-ui", 3);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("profiles", { keyPath: "id" });
        request.result.createObjectStore("keys");
        request.result.createObjectStore("meta");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction("meta", "readwrite");
    tx.objectStore("meta").put({ locale: requestedLocale }, "ui-settings");
    tx.objectStore("meta").put(
      { v: 1, keyEpoch: crypto.randomUUID(), profilesRevision: 0 },
      "vault-state",
    );
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  }, locale);
  return { context, page, requests, errors };
}

async function assertServedAssets(
  origin: string,
  base: string,
  files: Iterable<string>,
) {
  for (const file of files) {
    assert.ok(
      file.startsWith(`${base}assets/`),
      `${base}: dynamic assets need the deployment prefix`,
    );
    const response = await fetch(`${origin}${file}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /javascript/);
    assert.match(response.headers.get("cache-control") || "", /immutable/);
  }
}

/** English cold start, runtime switching to every other catalog, and missing-catalog recovery. */
async function checkEnglish(browser: Browser, origin: string, base: string) {
  const { context, page, requests, errors } = await openSeeded(
    browser,
    origin,
    base,
    "en-US",
  );
  try {
    await page.goto(`${origin}${base}login`);
    await languageReady(page, "en-US");
    const files = new Set(requests);
    assert.equal(
      await page.evaluate(() => document.documentElement.dir || "ltr"),
      "ltr",
    );
    await assertServedAssets(origin, base, files);
    const englishText =
      (await page.getByTestId("profile-option-new").textContent()) ?? "";

    // A catalog that fails to load must not lose the draft, the document or the stored locale.
    assert.equal(await persistedLocale(page), "en-US");
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let failed = false;
    const pattern = `${origin}${base}assets/*.js`;
    await page.route(pattern, async (route) => {
      if (failed) return route.continue();
      failed = true;
      await barrier;
      await route.fulfill({
        status: 404,
        contentType: "text/plain",
        body: "Injected missing catalog",
      });
    });
    try {
      await selectLocale(page, "fr-FR");
      await waitUntil(async () => failed, {
        timeoutMsg: "French catalog request did not reach the failure gate",
      });
      await page.getByTestId("profile-option-new").click();
      await page
        .getByTestId("connect-profile-name")
        .fill("Preserve this unsaved draft");
      const timeOrigin = await page.evaluate(() => performance.timeOrigin);
      release();
      await languageLoadFailure(page).waitFor({ state: "attached" });
      assert.equal(
        await page.evaluate(() => document.documentElement.lang),
        "en-US",
      );
      assert.equal(
        await page.evaluate(() => performance.timeOrigin),
        timeOrigin,
      );
      assert.equal(
        await page.getByTestId("connect-profile-name").inputValue(),
        "Preserve this unsaved draft",
      );
      assert.equal(await page.getByTestId("error-screen").count(), 0);
      assert.equal(
        await persistedLocale(page),
        "en-US",
        "a failed switch keeps the stored locale",
      );
      await page.getByTestId("connect-close").click();
      await page.getByTestId("discard-profile-changes").click();
    } finally {
      release();
      await page.unroute(pattern);
    }
    await selectLocale(page, "fr-FR");
    await languageReady(page, "fr-FR");
    await languageLoadFailure(page).waitFor({ state: "hidden", timeout: 6000 });
    await waitUntil(async () => (await persistedLocale(page)) === "fr-FR", {
      timeoutMsg: "the successful retry must store fr-FR",
    });

    // A new locale costs exactly its one catalog; a revisit costs none.
    const loaded = new Set<string>(["en-US", "fr-FR"]);
    for (const next of [
      ...SUPPORTED_LOCALES.slice(1),
      "en-US",
      SUPPORTED_LOCALES[1],
    ]) {
      const before = requests.length;
      await selectLocale(page, next);
      await languageReady(page, next);
      assert.equal(
        requests.length - before,
        loaded.has(next) ? 0 : 1,
        `switch ${next}: request only a missing catalog`,
      );
      loaded.add(next);
    }
    assert.deepEqual(errors, []);
    return { files, englishText };
  } finally {
    await context.close();
  }
}

/** One cold start per locale: its own catalog, its own text, its own direction. */
async function checkCold(
  browser: Browser,
  origin: string,
  base: string,
  locale: Locale,
  english: { files: Set<string>; englishText: string },
  registered: Map<string, Locale>,
) {
  const { context, page, requests, errors } = await openSeeded(
    browser,
    origin,
    base,
    locale,
  );
  try {
    await page.goto(`${origin}${base}login`);
    await languageReady(page, locale);
    assert.equal(
      await page.evaluate(() => document.documentElement.dir || "ltr"),
      LOCALE_META[locale].dir,
      `${locale} direction`,
    );
    const extra = [...new Set(requests)].filter(
      (file) => !english.files.has(file),
    );
    assert.equal(
      extra.length,
      1,
      `${locale} cold start must load exactly its one catalog beyond English`,
    );
    const owner = registered.get(extra[0]);
    assert.equal(
      owner,
      undefined,
      `${locale} catalog ${extra[0]} is already the catalog of ${owner}`,
    );
    registered.set(extra[0], locale);
    assert.notEqual(
      (await page.getByTestId("profile-option-new").textContent()) ?? "",
      english.englishText,
      `${locale} renders translated text`,
    );
    await assertServedAssets(origin, base, new Set(requests));
    assert.deepEqual(errors, [], `${locale} page errors`);
  } finally {
    await context.close();
  }
}

/** A catalog that cannot load at startup falls back to English without losing the stored choice. */
async function checkColdStartFallback(
  browser: Browser,
  origin: string,
  base: string,
  englishFiles: Set<string>,
) {
  const { context, page, errors } = await openSeeded(
    browser,
    origin,
    base,
    "ja-JP",
  );
  const pattern = `${origin}${base}assets/*.js`;
  try {
    await page.route(pattern, (route) =>
      englishFiles.has(new URL(route.request().url()).pathname)
        ? route.continue()
        : route.fulfill({
            status: 404,
            contentType: "text/plain",
            body: "Missing catalog",
          }),
    );
    await page.goto(`${origin}${base}login`);
    await languageLoadFailure(page).waitFor({ state: "attached" });
    assert.equal(
      await page.evaluate(() => document.documentElement.lang),
      "en-US",
    );
    assert.equal(await page.getByTestId("error-screen").count(), 0);
    await page
      .getByTestId("profile-option-new")
      .and(page.locator(":enabled"))
      .waitFor({ state: "visible" });
    assert.equal(
      await persistedLocale(page),
      "ja-JP",
      "startup fallback keeps the stored locale",
    );
    await page.unroute(pattern);
    await page.reload();
    await languageReady(page, "ja-JP");
    assert.equal(await languageLoadFailure(page).count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

export async function checkLocales(
  browser: Browser,
  origin: string,
  base: string,
) {
  const english = await checkEnglish(browser, origin, base);
  const registered = new Map<string, Locale>();
  await Promise.all(
    SUPPORTED_LOCALES.slice(1).map((locale) =>
      checkCold(browser, origin, base, locale, english, registered),
    ),
  );
  await checkColdStartFallback(browser, origin, base, english.files);
  console.log(
    `PASS ${base} catalog cold loads for ${SUPPORTED_LOCALES.length} locales, cache reuse, MIME/cache headers, missing-chunk recovery and draft retention`,
  );
}
