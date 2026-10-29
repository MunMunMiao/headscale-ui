import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { docker, diagnosticTail } from "../../scripts/harness/docker";
import { waitUntil } from "../../scripts/harness/wait-until";

const metadata = JSON.parse(readFileSync(process.argv[2], "utf8"));
assert.match(metadata.project, /^headscale-tag-lifecycle-\d+-[a-f\d]{8}$/);
assert.equal(metadata.origin, "http://127.0.0.1:4179");
const connection = JSON.parse(readFileSync(metadata.connectionPath, "utf8"));
const headscale = `${metadata.project}-headscale`;
assert.equal(
  docker("inspect", headscale, "--format", '{{ index .Config.Labels "io.headscale-ui.tag-lifecycle" }}'),
  metadata.project,
);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
const page = await context.newPage();
page.setDefaultTimeout(15000);
let paused = false;
const consoleErrors: string[] = [];
page.on("pageerror", error => consoleErrors.push(error.name));
const evidence: Record<string, unknown> = {
  mode: "real served application, normal UI login, temporary native browser context",
  fixtureProject: metadata.project,
  viewport: { width: 1280, height: 900 },
  screenshotsMaskAllCodeElements: true,
};
try {
  await page.goto(metadata.origin);
  await page.getByTestId("profile-option-new").click();
  await page.getByTestId("connect-profile-name").fill("G27 isolated preview");
  await page.getByTestId("connect-server-url").fill(metadata.origin);
  await page.getByTestId("connect-api-key").fill(connection.apiKey);
  await page.getByTestId("connect-password").fill(connection.password);
  await page.getByTestId("connect-password-confirm").fill(connection.password);
  await page.getByTestId("connect-save-unlock").click();
  await page.getByTestId("section-invites").click();
  await page.getByTestId("open-create-invite").click();
  await page.getByTestId("create-invite").click();
  await page.getByTestId("created-invite").waitFor();
  const refresh = page.getByTestId("refresh-auth-keys");
  await waitUntil(() => refresh.isEnabled());
  assert.equal(await page.getByTestId("invite-created-refresh-failed").count(), 0);
  assert.equal(await page.getByTestId("copy-created-invite").isEnabled(), true);
  evidence.creationConfirmed = true;

  docker("pause", headscale);
  paused = true;
  try {
    await refresh.click();
    await waitUntil(() => refresh.isDisabled());
    const pending = {
      refreshPending: await refresh.isDisabled(),
      falseFailureCount: await page.getByTestId("invite-created-refresh-failed").count(),
      keyStillPresent: await page.getByTestId("created-invite").isVisible(),
      copyStillEnabled: await page.getByTestId("copy-created-invite").isEnabled(),
      verificationText: await page.getByTestId("created-invite-status").textContent(),
    };
    assert.equal(pending.falseFailureCount, 0);
    assert.equal(pending.keyStillPresent, true);
    assert.equal(pending.copyStillEnabled, true);
    evidence.pendingRead = pending;
    await page.getByTestId("created-invite").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(import.meta.dir, "G27-读取中不误报失败.png"),
      mask: [page.locator("code")],
    });
  } finally {
    docker("unpause", headscale);
    paused = false;
  }
  await waitUntil(() => refresh.isEnabled());
  assert.equal(await page.getByTestId("invite-created-refresh-failed").count(), 0);
  evidence.afterRead = {
    refreshEnabled: true,
    falseFailureCount: 0,
    keyStillPresent: await page.getByTestId("created-invite").isVisible(),
    unverifiedStatusCount: await page.getByTestId("created-invite-status").count(),
  };
  assert.equal(await page.getByTestId("created-invite-status").count(), 0);
  evidence.pageErrors = consoleErrors;
  assert.equal(consoleErrors.length, 0);
  console.log("PASS real preview: create, pending read without false failure, retained copy, successful recovery");
} catch (error) {
  evidence.failed = true;
  console.error(diagnosticTail(String(error), [connection.apiKey, connection.password]));
  process.exitCode = 1;
} finally {
  if (paused) docker("unpause", headscale);
  await context.close();
  await browser.close();
  evidence.nativeBrowserContextClosed = true;
  writeFileSync(join(import.meta.dir, "g27-preview-evidence.json"), JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
}
