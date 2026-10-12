import { chromium } from "playwright";
import { checkSession } from "../e2e/session/session";
import { checkStorage } from "../e2e/session/storage";
import { createDeploymentStack } from "./harness/deployment-stack";
import { waitForDockerIpv6 } from "./harness/docker-network";
import { launchNativeBrowser } from "./harness/native-browser";

process.env.NO_PROXY = process.env.no_proxy = "127.0.0.1,localhost";

// The shared session and its storage run in the production build against two real Headscale
// servers. A native Chrome drives freeze/resume and BFCache, which Playwright emulation cannot.
const stack = createDeploymentStack("headscale-session");

async function main() {
  await stack.prepare();
  const a = await stack.startHeadscale("a");
  const b = await stack.startHeadscale("b");
  const { origin } = await stack.start("/");
  await waitForDockerIpv6(stack.networkId);
  const browser = await chromium.launch({ headless: true });
  stack.onCleanup(() => browser.close());
  const native = await launchNativeBrowser(stack.temporary);
  stack.onCleanup(() => native.dispose());
  await checkSession(native.browser, origin, { a, b });
  await native.dispose();
  await checkStorage(browser, origin, a, stack.temporary);
}

try {
  await main();
} catch (error) {
  const diagnostic = error instanceof Error ? error.stack || error.message : String(error);
  console.error(stack.redact(diagnostic));
  process.exitCode = 1;
} finally {
  await stack.cleanup();
}
