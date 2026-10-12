import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type ParseError, parse as parseJsonc } from "jsonc-parser";
import { type Browser, chromium } from "playwright";
import { createCleanup, docker, root, startHeadscale, waitForHeadscale } from "./harness/docker";
import { waitForDockerIpv6 } from "./harness/docker-network";
import { waitUntil } from "./harness/wait-until";

process.env.NO_PROXY = process.env.no_proxy = "127.0.0.1,localhost";

const owned = `headscale-policy-lifecycle-${process.pid}-${Date.now()}`;
const image = process.env.DEPLOYMENT_IMAGE || owned;
const headscale = `${owned}-headscale`;
const ui = `${owned}-ui`;
const proxy = `${owned}-proxy`;
const networkProbe = `${owned}-network-probe`;
const containers: string[] = [];
const temporary = mkdtempSync(join(tmpdir(), `${owned}-`));
let browser: Browser | undefined;
let build: ReturnType<typeof Bun.spawn> | undefined;
let networkCreated = false;
let volumeCreated = false;
let imageCreated = false;

function headscaleNetworkIdentity(): string {
  const identity = docker(
    "run",
    "--rm",
    "--name",
    networkProbe,
    "--network",
    `container:${headscale}`,
    "--entrypoint",
    "sh",
    image,
    "-c",
    "readlink /proc/self/ns/net; cat /sys/class/net/eth0/iflink",
  );
  assert.match(identity, /^net:\[\d+\]\n\d+$/, "Expected a namespace and host interface identity");
  return identity;
}

const cleanup = createCleanup("Policy lifecycle", [
  async () => {
    if (build && build.exitCode === null) {
      build.kill();
      await build.exited;
    }
  },
  async () => browser?.close(),
  () => {
    if (docker("ps", "-aq", "--filter", `name=^/${networkProbe}$`))
      docker("rm", "-f", networkProbe);
  },
  () => {
    if (containers.length) docker("rm", "-fv", ...containers.toReversed());
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
]);

interface Policy {
  acls: { action: string; src: string[]; dst: string[]; proto?: string }[];
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
  const networkId = docker("network", "create", owned);
  networkCreated = true;
  docker("volume", "create", owned);
  volumeCreated = true;
  // Keep the host interface alive when Headscale restarts while Chrome is open.
  containers.push(ui);
  docker("run", "-d", "--name", ui, "--network", owned, image);
  containers.push(headscale);
  const apiKey = await startHeadscale(headscale, {
    network: `container:${ui}`,
    user: "lifecycle-user",
    volume: owned,
  });

  const config = join(temporary, "proxy.conf");
  await Bun.write(
    config,
    `server {
    listen 80;
    location /api/ { proxy_pass http://${ui}:8080; }
    location = /version { proxy_pass http://${ui}:8080; }
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
    "nginx:1.30.5-alpine",
    "-g",
    "daemon off;",
  );
  const port = docker("port", proxy, "80/tcp").match(/127\.0\.0\.1:(\d+)/)?.[1];
  assert.ok(port, "Lifecycle proxy must publish a loopback port");
  const origin = `http://127.0.0.1:${port}`;
  const profilePassword = "lifecycle-server-password";
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
  const versionResponse = await fetch(`${origin}/version`, {
    headers,
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(versionResponse.status, 200, "Lifecycle proxy must route Headscale version");
  assert.match(versionResponse.headers.get("content-type") ?? "", /^application\/json\b/);
  assert.equal((await versionResponse.json()).version, "v0.29.4");
  const policyUrl = `${origin}/api/v1/policy`;
  async function readPolicy(): Promise<Policy> {
    const response = await fetch(policyUrl, { headers, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, "Headscale policy API read");
    const body = (await response.json()) as { policy: string };
    const errors: ParseError[] = [];
    const policy = parseJsonc(body.policy, errors, { allowTrailingComma: true }) as Policy;
    assert.deepEqual(errors, [], "Headscale must return a syntactically valid policy");
    return policy;
  }
  const openAcl = [{ action: "accept", src: ["*"], dst: ["*:*"], proto: "tcp" }];
  const restrictedAcl = [
    { action: "accept", src: ["lifecycle-user@"], dst: ["100.64.0.2:443"], proto: "tcp" },
  ];
  const seeded = await fetch(policyUrl, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      policy: `{\n// Preserve this protocol restriction through UI edits.\n"acls": ${JSON.stringify(openAcl)},\n}`,
    }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(seeded.status, 200, "Seed wildcard policy on isolated Headscale");
  assert.deepEqual((await readPolicy()).acls, openAcl);

  await waitForDockerIpv6(networkId);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  page.setDefaultTimeout(15000);
  const failures: Array<{ timestamp: number; path: string; status?: number; errorText?: string }> =
    [];
  page.on("response", (response) => {
    if (response.status() >= 400)
      failures.push({
        timestamp: Date.now(),
        path: new URL(response.url()).pathname,
        status: response.status(),
      });
  });
  page.on("requestfailed", (request) =>
    failures.push({
      timestamp: Date.now(),
      path: new URL(request.url()).pathname,
      errorText: request.failure()?.errorText,
    }),
  );
  const element = (id: string) => page.locator(`[data-testid="${id}"]`);
  const prefix = (id: string) => page.locator(`[data-testid^="${id}"]`).first();
  const click = async (id: string) => {
    await element(id).waitFor({ state: "visible", timeout: 15000 });
    await element(id).click();
  };
  const openAccess = async () => {
    await click("section-access");
    await element("save-policy").waitFor({ state: "visible", timeout: 15000 });
  };
  const expectNoWildcard = async () => {
    assert.equal(
      (await element("open-access-banner").count()) > 0,
      false,
      "Wildcard access must not return",
    );
  };
  const expectRestricted = async (checkpoint: string) => {
    await element("ip-rules-section").waitFor({ state: "visible", timeout: 15000 });
    assert.equal(await page.locator('[data-testid^="ip-rule-edit-"]').count(), 1, checkpoint);
    const text = await element("ip-rules-section").innerText();
    for (const value of ["lifecycle-user@", "100.64.0.2", "443"])
      assert.ok(text.includes(value), `${checkpoint}: ${value}`);
    await expectNoWildcard();
    assert.deepEqual((await readPolicy()).acls, restrictedAcl, checkpoint);
    console.log(`PASS ${checkpoint}`);
  };
  const emptyState = () =>
    page.evaluate(() => ({
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
      await element("resource-access-empty").waitFor({ state: "visible", timeout: 15000 });
      await expectNoWildcard();
      assert.equal((await element("ip-rules-section").count()) > 0, false, "No phantom ACL rows");
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
    try {
      await waitUntil(
        async () => {
          if ((await element("save-policy-error").count()) > 0) {
            throw new Error(`UI save failed: ${await element("save-policy-error").innerText()}`);
          }
          return isDeepStrictEqual((await readPolicy()).acls, expected);
        },
        { timeout: 15000, timeoutMsg: "Browser policy save did not reach Headscale" },
      );
    } catch (error) {
      console.error(
        "FAIL persisted ACL",
        JSON.stringify({ expected, actual: (await readPolicy()).acls }),
      );
      throw error;
    }
    await waitUntil(async () => !((await element("save-policy-dirty-badge").count()) > 0), {
      timeout: 15000,
    });
  };
  const reload = async () => {
    const epoch = await page.evaluate(() => performance.timeOrigin);
    await page.reload();
    await element("section-access")
      .or(element("profile-picker"))
      .first()
      .waitFor({ state: "visible", timeout: 15000 });
    assert.notEqual(
      await page.evaluate(() => performance.timeOrigin),
      epoch,
      "Must reload the whole document",
    );
    if ((await element("section-access").count()) === 0) await unlockProfile();
    await openAccess();
  };
  const unlockProfile = async () => {
    await click("profile-option-Lifecycle");
    await element("unlock-dialog").waitFor({ state: "visible", timeout: 15000 });
    assert.equal(await element("unlock-passphrase").inputValue(), "");
    assert.equal(await element("section-access").count(), 0, "Saved profiles require a password");
    await element("unlock-passphrase").fill(profilePassword);
    await click("unlock-submit");
    await element("section-access").waitFor({ state: "visible", timeout: 15000 });
  };
  const relogin = async () => {
    await click("profile-menu-trigger");
    await click("logout");
    await element("profile-picker").waitFor({ state: "visible", timeout: 15000 });
    assert.equal(new URL(await page.url()).pathname, "/login");
    await unlockProfile();
    await openAccess();
  };

  await page.goto(origin);
  await click("profile-option-new");
  await element("connect-profile-name").fill("Lifecycle");
  await element("connect-server-url").fill(origin);
  await element("connect-api-key").fill(apiKey);
  await element("connect-password").fill(profilePassword);
  await element("connect-password-confirm").fill(profilePassword);
  await click("connect-submit");
  try {
    await unlockProfile();
  } catch (error) {
    try {
      const state = await page.evaluate(
        (expectedOrigin) => ({
          pathname: location.pathname,
          input: {
            nameMatches:
              document.querySelector<HTMLInputElement>('[data-testid="connect-profile-name"]')
                ?.value === "Lifecycle",
            urlMatches:
              document.querySelector<HTMLInputElement>('[data-testid="connect-server-url"]')
                ?.value === expectedOrigin,
            apiKeyCleared:
              document.querySelector<HTMLInputElement>('[data-testid="connect-api-key"]')?.value ===
              "",
            passwordCleared:
              document.querySelector<HTMLInputElement>('[data-testid="connect-password"]')
                ?.value === "",
            unlockPasswordCleared:
              document.querySelector<HTMLInputElement>('[data-testid="unlock-passphrase"]')
                ?.value === "",
          },
          submitDisabled: document.querySelector<HTMLButtonElement>(
            '[data-testid="connect-submit"]',
          )?.disabled,
          connectionDialog: !!document.querySelector('[data-testid="connection-dialog"]'),
          validationDialog: !!document.querySelector('[data-testid="profile-validation-dialog"]'),
          unlockDialog: !!document.querySelector('[data-testid="unlock-dialog"]'),
          errors: ["connect-error", "profile-validation-error", "login-error", "unlock-error"].map(
            (id) => ({
              id,
              text: document.querySelector(`[data-testid="${id}"]`)?.textContent?.trim(),
            }),
          ),
          profileCount: document.querySelectorAll('[data-testid^="profile-option-"]').length,
          resources: performance
            .getEntriesByType("resource")
            .filter(
              (entry) =>
                new URL(entry.name).pathname.startsWith("/api/") ||
                new URL(entry.name).pathname === "/version",
            )
            .map((entry) => ({
              path: new URL(entry.name).pathname,
              status: (entry as PerformanceResourceTiming).responseStatus,
              start: entry.startTime,
              end: (entry as PerformanceResourceTiming).responseEnd,
            })),
        }),
        origin,
      );
      for (const item of state.errors) {
        item.text = item.text?.replaceAll(/https?:\/\/[^\s"'<>]+/gi, (url) => {
          try {
            return new URL(url).pathname;
          } catch {
            return "[URL]";
          }
        });
      }
      console.error(
        "Lifecycle connection failure",
        JSON.stringify({ state, failures })
          .replaceAll(apiKey, "[REDACTED]")
          .replaceAll(profilePassword, "[REDACTED]"),
      );
    } catch {
      console.error("Lifecycle connection diagnostics unavailable");
    }
    throw error;
  }
  await openAccess();
  await element("open-access-banner").waitFor({ state: "visible", timeout: 15000 });
  await element("ip-rules-section").waitFor({ state: "visible", timeout: 15000 });
  assert.equal(
    await page.locator('[data-testid^="ip-rule-edit-"]').count(),
    1,
    "HuJSON ACL is parsed as exactly one editable rule",
  );
  await prefix("ip-rule-edit-").click();
  await prefix("ip-rule-source-").fill("lifecycle-user@");
  await prefix("ip-rule-destination-").fill("100.64.0.2");
  await prefix("ip-rule-ports-").fill("443");
  await prefix("ip-rule-save-").click();
  await save(restrictedAcl);
  await expectRestricted("restricted ACL after save");
  await reload();
  await expectRestricted("restricted ACL after full reload");
  await relogin();
  await expectRestricted("restricted ACL after logout/login");
  console.log(
    "PASS HuJSON ACL visible/editable; source, port and TCP-only restriction survive full reload and logout/login",
  );

  await prefix("ip-rule-remove-").click();
  await save([]);
  await expectEmpty("empty ACL after save");
  await reload();
  await expectEmpty("empty ACL after full reload");
  await relogin();
  await expectEmpty("empty ACL after logout/login");
  const networkIdentity = headscaleNetworkIdentity();
  docker("restart", headscale);
  await waitForHeadscale(headscale);
  assert.equal(
    headscaleNetworkIdentity(),
    networkIdentity,
    "Headscale restart must preserve its network namespace and host interface while Chrome is open",
  );
  console.log("PASS Headscale restart preserves its network namespace and host interface");
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
  await element("tag-card-tag:personal").waitFor({ state: "visible", timeout: 15000 });
  assert.deepEqual((await readPolicy()).acls, restoredAcl);
  console.log("PASS browser can restore configured access from explicit empty ACL and reload it");
} finally {
  await cleanup();
}
