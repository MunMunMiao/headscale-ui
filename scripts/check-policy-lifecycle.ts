import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { remote } from "webdriverio";

process.env.NO_PROXY = process.env.no_proxy = "127.0.0.1,localhost";

const root = fileURLToPath(new URL("..", import.meta.url));
const owned = `headscale-policy-lifecycle-${process.pid}-${Date.now()}`;
const image = process.env.DEPLOYMENT_IMAGE || owned;
const headscale = `${owned}-headscale`;
const ui = `${owned}-ui`;
const proxy = `${owned}-proxy`;
const containers: string[] = [];
const temporary = mkdtempSync(join(tmpdir(), `${owned}-`));
let browser: Awaited<ReturnType<typeof remote>> | undefined;
let build: ReturnType<typeof Bun.spawn> | undefined;
let networkCreated = false;
let volumeCreated = false;
let imageCreated = false;
let cleaned = false;

function docker(...args: string[]): string {
  const result = Bun.spawnSync(["docker", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  assert.equal(result.exitCode, 0, `docker ${args.join(" ")}\n${result.stderr}`);
  return result.stdout.toString().trim();
}

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const action of [
    async () => {
      if (build && build.exitCode === null) {
        build.kill();
        await build.exited;
      }
    },
    async () => browser?.deleteSession(),
    () => {
      if (containers.length) docker("rm", "-fv", ...containers);
    },
    () => {
      if (volumeCreated) docker("volume", "rm", owned);
    },
    () => {
      if (networkCreated) docker("network", "rm", owned);
    },
    () => {
      if (imageCreated || (build && docker("image", "ls", "--quiet", image))) {
        docker("image", "rm", image);
      }
    },
    () => rmSync(temporary, { recursive: true }),
  ]) {
    try {
      await action();
    } catch (error) {
      console.error("Policy lifecycle cleanup failed:", error);
      process.exitCode = 1;
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await cleanup();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

async function waitForHeadscale() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = Bun.spawnSync(["docker", "exec", headscale, "headscale", "health"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode === 0) return;
    await Bun.sleep(200);
  }
  throw new Error("Lifecycle Headscale did not become healthy");
}

interface Policy {
  acls: { action: string; src: string[]; dst: string[] }[];
  tagOwners?: Record<string, string[]>;
}

try {
  if (!process.env.DEPLOYMENT_IMAGE) {
    build = Bun.spawn(["docker", "build", "-t", image, "."], {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    });
    assert.equal(await build.exited, 0, "Docker production UI build failed");
    imageCreated = true;
  }
  docker("network", "create", owned);
  networkCreated = true;
  docker("volume", "create", owned);
  volumeCreated = true;
  containers.push(headscale);
  docker(
    "run",
    "-d",
    "--name",
    headscale,
    "--network",
    owned,
    "-v",
    `${root}/e2e/headscale-config.yaml:/etc/headscale/config.yaml:ro`,
    "-v",
    `${root}/e2e/headscale-derp.yaml:/etc/headscale/derp.yaml:ro`,
    "-v",
    `${owned}:/var/lib/headscale`,
    "headscale/headscale:0.28.0",
    "serve",
  );
  await waitForHeadscale();
  docker("exec", headscale, "headscale", "users", "create", "lifecycle-user");
  const apiKey = docker("exec", headscale, "headscale", "apikeys", "create", "--expiration", "30m");
  assert.ok(apiKey, "Lifecycle API key creation failed");

  containers.push(ui);
  docker("run", "-d", "--name", ui, "--network", owned, image);
  const config = join(temporary, "proxy.conf");
  await Bun.write(
    config,
    `server {
    listen 80;
    location /api/ { proxy_pass http://${headscale}:8080; }
    location / { proxy_pass http://${ui}:80; }
  }\n`,
  );
  containers.push(proxy);
  docker(
    "run",
    "-d",
    "--name",
    proxy,
    "--network",
    owned,
    "-p",
    "127.0.0.1::80",
    "-v",
    `${config}:/etc/nginx/conf.d/default.conf:ro`,
    "--entrypoint",
    "nginx",
    image,
    "-g",
    "daemon off;",
  );
  const port = docker("port", proxy, "80/tcp").match(/127\.0\.0\.1:(\d+)/)?.[1];
  assert.ok(port, "Lifecycle proxy must publish a loopback port");
  const origin = `http://127.0.0.1:${port}`;
  let uiReady = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok) {
        uiReady = true;
        break;
      }
    } catch {
      // The container port can be published before nginx starts listening.
    }
    await Bun.sleep(100);
  }
  assert.ok(uiReady, "Lifecycle production UI did not become ready");
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  const policyUrl = `${origin}/api/v1/policy`;
  async function readPolicy(): Promise<Policy> {
    const response = await fetch(policyUrl, { headers, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, "Headscale policy API read");
    const body = (await response.json()) as { policy: string };
    return JSON.parse(body.policy) as Policy;
  }
  const openAcl = [{ action: "accept", src: ["*"], dst: ["*:*"] }];
  const restrictedAcl = [{ action: "accept", src: ["lifecycle-user@"], dst: ["100.64.0.2:443"] }];
  const seeded = await fetch(policyUrl, {
    method: "PUT",
    headers,
    body: JSON.stringify({ policy: JSON.stringify({ acls: openAcl }) }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(seeded.status, 200, "Seed wildcard policy on isolated Headscale");
  assert.deepEqual((await readPolicy()).acls, openAcl);

  browser = await remote({
    logLevel: "error",
    capabilities: {
      browserName: "chrome",
      "wdio:enforceWebDriverClassic": true,
      "goog:chromeOptions": { args: ["--headless=new", "--window-size=1440,1000"] },
    },
  });
  const page = browser;
  const element = (id: string) => page.$(`[data-testid="${id}"]`);
  const prefix = (id: string) => page.$(`[data-testid^="${id}"]`);
  const click = async (id: string) => {
    await element(id).waitForDisplayed({ timeout: 15000 });
    await element(id).click();
  };
  const openAccess = async () => {
    await click("section-access");
    await element("save-policy").waitForDisplayed({ timeout: 15000 });
  };
  const expectNoWildcard = async () => {
    assert.equal(
      await element("open-access-banner").isExisting(),
      false,
      "Wildcard access must not return",
    );
  };
  const expectRestricted = async (checkpoint: string) => {
    await element("ip-rules-section").waitForDisplayed({ timeout: 15000 });
    assert.equal(await page.$$('[data-testid^="ip-rule-edit-"]').length, 1, checkpoint);
    const text = await element("ip-rules-section").getText();
    for (const value of ["lifecycle-user@", "100.64.0.2", "443"])
      assert.ok(text.includes(value), `${checkpoint}: ${value}`);
    await expectNoWildcard();
    assert.deepEqual((await readPolicy()).acls, restrictedAcl, checkpoint);
    console.log(`PASS ${checkpoint}`);
  };
  const emptyState = () =>
    page.execute(() => ({
      pathname: window.location.pathname,
      empty: !!document.querySelector('[data-testid="resource-access-empty"]'),
      wildcard: !!document.querySelector('[data-testid="open-access-banner"]'),
      rules: document.querySelectorAll('[data-testid^="ip-rule-remove-"]').length,
      policyResponses: performance
        .getEntriesByType("resource")
        .filter((entry) => new URL(entry.name).pathname === "/api/v1/policy")
        .map((entry) => ({
          start: entry.startTime,
          end: (entry as PerformanceResourceTiming).responseEnd,
        })),
    }));
  const expectEmpty = async (checkpoint: string) => {
    try {
      await element("resource-access-empty").waitForDisplayed({ timeout: 15000 });
      await expectNoWildcard();
      assert.equal(await element("ip-rules-section").isExisting(), false, "No phantom ACL rows");
      assert.deepEqual((await readPolicy()).acls, [], "Explicit empty ACL must persist");
    } catch (error) {
      console.error(
        `FAIL ${checkpoint}`,
        JSON.stringify({
          ui: await emptyState(),
          api: (await readPolicy()).acls,
        }),
      );
      throw error;
    }
    console.log(`PASS ${checkpoint}`);
  };
  const save = async (expected: Policy["acls"]) => {
    await click("save-policy");
    await page.waitUntil(
      async () => {
        if (await element("save-policy-error").isExisting()) {
          throw new Error(`UI save failed: ${await element("save-policy-error").getText()}`);
        }
        return JSON.stringify((await readPolicy()).acls) === JSON.stringify(expected);
      },
      { timeout: 15000, timeoutMsg: "Browser policy save did not reach Headscale" },
    );
    await page.waitUntil(async () => !(await element("save-policy-dirty-badge").isExisting()), {
      timeout: 15000,
    });
  };
  const reload = async () => {
    const epoch = await page.execute(() => performance.timeOrigin);
    await page.refresh();
    await element("section-access").waitForDisplayed({ timeout: 15000 });
    assert.notEqual(
      await page.execute(() => performance.timeOrigin),
      epoch,
      "Must reload the whole document",
    );
    await openAccess();
  };
  const relogin = async () => {
    await click("profile-menu-trigger");
    await click("logout");
    await element("profile-picker").waitForDisplayed({ timeout: 15000 });
    assert.equal(new URL(await page.getUrl()).pathname, "/login");
    await click("profile-option-Lifecycle");
    await openAccess();
  };

  await page.url(origin);
  await click("profile-option-new");
  await element("connect-profile-name").setValue("Lifecycle");
  await element("connect-mode").selectByAttribute("value", "real");
  await element("connect-server-url").setValue(origin);
  await element("connect-api-key").setValue(apiKey);
  await click("connect-submit");
  await click("profile-option-Lifecycle");
  await openAccess();
  await element("open-access-banner").waitForDisplayed({ timeout: 15000 });
  await element("ip-rules-section").waitForDisplayed({ timeout: 15000 });
  assert.equal(
    await page.$$('[data-testid^="ip-rule-edit-"]').length,
    1,
    "Wildcard ACL is editable",
  );
  await prefix("ip-rule-edit-").click();
  await prefix("ip-rule-source-").setValue("lifecycle-user@");
  await prefix("ip-rule-destination-").setValue("100.64.0.2");
  await prefix("ip-rule-ports-").setValue("443");
  await prefix("ip-rule-save-").click();
  await save(restrictedAcl);
  await expectRestricted("restricted ACL after save");
  await reload();
  await expectRestricted("restricted ACL after full reload");
  await relogin();
  await expectRestricted("restricted ACL after logout/login");
  console.log(
    "PASS wildcard ACL visible/editable; restricted source and port survive full reload and logout/login",
  );

  await prefix("ip-rule-remove-").click();
  await save([]);
  await expectEmpty("empty ACL after save");
  await reload();
  await expectEmpty("empty ACL after full reload");
  await relogin();
  await expectEmpty("empty ACL after logout/login");
  docker("restart", headscale);
  await waitForHeadscale();
  assert.deepEqual((await readPolicy()).acls, [], "Empty ACL survives Headscale database restart");
  await reload();
  await expectEmpty("empty ACL after Headscale restart and full reload");
  console.log(
    "PASS last ACL deletion persists across full reload, logout/login, and Headscale restart",
  );

  await click("template-apply-self-only");
  const restoredAcl = [{ action: "accept", src: ["*"], dst: ["tag:personal:*"] }];
  await save(restoredAcl);
  assert.deepEqual((await readPolicy()).tagOwners, { "tag:personal": [] });
  await reload();
  await element("tag-card-tag:personal").waitForDisplayed({ timeout: 15000 });
  assert.deepEqual((await readPolicy()).acls, restoredAcl);
  console.log("PASS browser can restore configured access from explicit empty ACL and reload it");
} finally {
  await cleanup();
}
