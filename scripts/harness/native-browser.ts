import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { diagnosticTail } from "./docker";
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
    { stdout: "ignore", stderr: "pipe" },
  );
  let stderr = "";
  const stderrReader = child.stderr.getReader();
  const stderrDone = (async () => {
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        // The extra character lets diagnosticTail detect and drop a truncated first line.
        stderr = (stderr + decoder.decode(value, { stream: true })).slice(
          -8193,
        );
      }
    } catch {
      // A broken diagnostic stream must not replace the browser startup failure.
    }
  })();
  let browser: Browser | undefined;
  let disposing: Promise<void> | undefined;
  const dispose = () =>
    (disposing ??= (async () => {
      try {
        await browser?.close();
      } finally {
        child.kill();
        await child.exited;
        try {
          await stderrReader.cancel();
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    })());
  try {
    const activePort = join(directory, "DevToolsActivePort");
    await waitUntil(async () => {
      if (child.exitCode !== null)
        throw new Error(
          "Native Chromium exited before debugging became available",
        );
      return Bun.file(activePort).exists();
    });
    const [port, endpoint] = (await Bun.file(activePort).text())
      .trim()
      .split("\n");
    browser = await chromium.connectOverCDP(
      `ws://127.0.0.1:${port}${endpoint}`,
      {
        noDefaults: true,
        timeout: 10000,
      },
    );
    return { browser, context: browser.contexts()[0], dispose };
  } catch (error) {
    try {
      // CDP can fail while Chromium is still alive: never await an unbounded stderr EOF.
      await Promise.race([stderrDone, Bun.sleep(100)]);
      console.error(
        `Native Chromium stderr:\n${diagnosticTail(stderr) || "stderr unavailable"}`,
      );
    } catch {
      // Diagnostics are best effort; the original error remains authoritative.
    } finally {
      try {
        await dispose();
      } catch {
        try {
          console.error("Native Chromium startup cleanup failed");
        } catch {
          // A broken diagnostic sink cannot replace the original startup error either.
        }
      }
    }
    throw error;
  }
}
