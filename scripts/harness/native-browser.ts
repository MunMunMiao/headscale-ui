import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { waitUntil } from "./wait-until";

/** Playwright's normal focus emulation prevents native hidden/freeze transitions. */
export async function launchNativeBrowser(parent = tmpdir()) {
  const directory = mkdtempSync(join(parent, "headscale-native-browser-"));
  const child = Bun.spawn(
    [
      chromium.executablePath(),
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${directory}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--no-proxy-server",
      "--use-mock-keychain",
      "--password-store=basic",
      "--disable-features=HttpsUpgrades",
      "--no-sandbox",
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  let browser: Browser | undefined;
  let disposing: Promise<void> | undefined;
  const dispose = () =>
    (disposing ??= (async () => {
      try {
        await browser?.close();
      } finally {
        child.kill();
        await child.exited;
        rmSync(directory, { recursive: true, force: true });
      }
    })());
  try {
    const activePort = join(directory, "DevToolsActivePort");
    await waitUntil(async () => {
      if (child.exitCode !== null)
        throw new Error("Native Chromium exited before debugging became available");
      return Bun.file(activePort).exists();
    });
    const [port, endpoint] = (await Bun.file(activePort).text()).trim().split("\n");
    browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${endpoint}`, {
      noDefaults: true,
      timeout: 10000,
    });
    return { browser, context: browser.contexts()[0], dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
