import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type ParseError, parse as parseJsonc } from "jsonc-parser";
import { type Browser, chromium } from "playwright";
import {
  createCleanup,
  docker,
  root,
  startHeadscale,
  waitForHeadscale,
} from "./harness/docker";
import { waitForDockerIpv6 } from "./harness/docker-network";
import { countPolicyWrites } from "./harness/policy-publication-count";
import { waitUntil } from "./harness/wait-until";

process.env.NO_PROXY = process.env.no_proxy = "127.0.0.1,localhost";

const faultArguments = process.argv.slice(2);
const faultFlag = faultArguments[0];
if (
  faultArguments.length > 1 ||
  (faultFlag !== undefined &&
    faultFlag !== "--inject-policy-put=between-publications" &&
    faultFlag !== "--inject-policy-put=after-final-publication")
) {
  throw new Error("Unsupported policy lifecycle fault argument");
}

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
let logFollower: ReturnType<typeof Bun.spawn> | undefined;
let followedLogs:
  | [
      PromiseSettledResult<string>,
      PromiseSettledResult<string>,
      PromiseSettledResult<number>,
    ]
  | undefined;
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
  assert.match(
    identity,
    /^net:\[\d+\]\n\d+$/,
    "Expected a namespace and host interface identity",
  );
  return identity;
}

const cleanup = createCleanup("Policy lifecycle", [
  async () => {
    if (!logFollower) return;
    const forced =
      logFollower.exitCode === null && logFollower.signalCode === null;
    if (forced) logFollower.kill("SIGKILL");
    await waitUntil(async () => followedLogs !== undefined, {
      timeout: 5000,
      timeoutMsg: "Owned proxy log follower cleanup did not finish",
    });
    assert.ok(followedLogs, "The owned log follower must finish");
    const [stdout, stderr, exited] = followedLogs;
    assert.ok(
      stdout.status === "fulfilled" && stderr.status === "fulfilled",
      "The owned follower's stream reads must finish without errors",
    );
    assert.ok(
      exited.status === "fulfilled",
      "The owned log follower must report its exit",
    );
    console.log(
      JSON.stringify({
        kind: "policy-publication-count",
        stage: "log-follower-closed",
        forced,
        exitCode: exited.value,
        signalCode: logFollower.signalCode,
      }),
    );
  },
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
    "nginx:1.30.6-alpine",
    "-g",
    "daemon off;",
  );
  // Start before any requests; EOF is only authoritative after a normal proxy shutdown.
  const follower = Bun.spawn(["docker", "logs", "--follow", proxy], {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  logFollower = follower;
  void Promise.allSettled([
    new Response(follower.stdout).text(),
    new Response(follower.stderr).text(),
    follower.exited,
  ]).then((results) => {
    followedLogs = results;
  });
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
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  const versionResponse = await fetch(`${origin}/version`, {
    headers,
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(
    versionResponse.status,
    200,
    "Lifecycle proxy must route Headscale version",
  );
  assert.match(
    versionResponse.headers.get("content-type") ?? "",
    /^application\/json\b/,
  );
  assert.equal((await versionResponse.json()).version, "v0.29.6+dirty");
  const policyUrl = `${origin}/api/v1/policy`;
  async function readPolicy(): Promise<Policy> {
    const response = await fetch(policyUrl, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200, "Headscale policy API read");
    const body = (await response.json()) as { policy: string };
    const errors: ParseError[] = [];
    const policy = parseJsonc(body.policy, errors, {
      allowTrailingComma: true,
    }) as Policy;
    assert.deepEqual(
      errors,
      [],
      "Headscale must return a syntactically valid policy",
    );
    return policy;
  }
  const openAcl = [
    { action: "accept", src: ["*"], dst: ["*:*"], proto: "tcp" },
  ];
  const restrictedAcl = [
    {
      action: "accept",
      src: ["lifecycle-user@"],
      dst: ["100.64.0.2:443"],
      proto: "tcp",
    },
  ];
  const seeded = await fetch(policyUrl, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      policy: `{\n// Preserve this protocol restriction through UI edits.\n"acls": ${JSON.stringify(openAcl)},\n}`,
    }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(
    seeded.status,
    200,
    "Seed wildcard policy on isolated Headscale",
  );
  assert.deepEqual((await readPolicy()).acls, openAcl);

  await waitForDockerIpv6(networkId);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1366, height: 768 },
  });
  page.setDefaultTimeout(15000);
  const failures: Array<{
    timestamp: number;
    path: string;
    status?: number;
    errorText?: string;
  }> = [];
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
    await element("ip-rules-section").waitFor({
      state: "visible",
      timeout: 15000,
    });
    assert.equal(
      await page.locator('[data-testid^="ip-rule-edit-"]').count(),
      1,
      checkpoint,
    );
    const text = (await element("ip-rules-section").textContent()) ?? "";
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
      rules: document.querySelectorAll('[data-testid^="ip-rule-remove-"]')
        .length,
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
      await element("resource-access-empty").waitFor({
        state: "visible",
        timeout: 15000,
      });
      await expectNoWildcard();
      // The IP rule section always renders (with "Add rule"); an empty ACL has no rule rows in it.
      assert.equal((await emptyState()).rules, 0, "No phantom ACL rows");
      assert.deepEqual(
        (await readPolicy()).acls,
        [],
        "Explicit empty ACL must persist",
      );
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
  // Proxy access logs also observe SharedWorker requests, without retaining their credentials.
  const policyWriteCount = () => countPolicyWrites(docker("logs", proxy));
  // Only the completed seed and explicit confirmation clicks advance this expectation.
  let expectedPolicyWrites = 1;
  const assertPolicyWriteCount = (
    checkpoint: string,
    message: string,
    observed = policyWriteCount(),
  ) => {
    if (observed !== expectedPolicyWrites) {
      console.log(
        JSON.stringify({
          kind: "policy-publication-count",
          stage: "count-rejected",
          checkpoint,
          expected: expectedPolicyWrites,
          observed,
        }),
      );
    }
    assert.equal(
      observed,
      expectedPolicyWrites,
      `POLICY_PUBLICATION_COUNT_MISMATCH: ${message}`,
    );
  };
  assertPolicyWriteCount(
    "seed",
    "The proxy must observe the fixture's seed policy PUT",
  );
  const save = async (expected: Policy["acls"]) => {
    assertPolicyWriteCount(
      "before-review",
      "No policy PUT between explicit confirmations",
    );
    const original = await readPolicy();
    await click("save-policy");
    await element("policy-publication-review").waitFor({ state: "visible" });
    const errors: ParseError[] = [];
    assert.deepEqual(
      parseJsonc(
        (await element("policy-publication-original").textContent()) ?? "",
        errors,
        {
          allowTrailingComma: true,
        },
      ),
      original,
      "Publication review must show the complete original policy",
    );
    assert.deepEqual(
      errors,
      [],
      "Publication review must retain valid original HuJSON",
    );
    const submitted = JSON.parse(
      (await element("policy-publication-submitted").textContent()) ?? "",
    );
    assert.deepEqual(
      submitted.acls,
      expected,
      "Review the requested ACL before publishing",
    );
    assert.deepEqual(
      await readPolicy(),
      original,
      "Opening review must not publish the draft",
    );
    assertPolicyWriteCount("review", "No policy PUT before confirmation");
    await click("policy-publication-confirm");
    expectedPolicyWrites += 1;
    try {
      await waitUntil(
        async () => {
          if ((await element("save-policy-error").count()) > 0) {
            throw new Error(
              `UI save failed: ${(await element("save-policy-error").textContent()) ?? ""}`,
            );
          }
          return isDeepStrictEqual((await readPolicy()).acls, expected);
        },
        {
          timeout: 15000,
          timeoutMsg: "Browser policy save did not reach Headscale",
        },
      );
    } catch (error) {
      console.error(
        "FAIL persisted ACL",
        JSON.stringify({ expected, actual: (await readPolicy()).acls }),
      );
      throw error;
    }
    await waitUntil(
      async () => !((await element("save-policy-dirty-badge").count()) > 0),
      {
        timeout: 15000,
      },
    );
    assert.deepEqual(
      await readPolicy(),
      submitted,
      "Publish exactly the complete reviewed policy",
    );
    // Docker's log stream can lag a completed HTTP response; wait for visibility, not another PUT.
    await waitUntil(async () => policyWriteCount() >= expectedPolicyWrites, {
      timeout: 5000,
    });
    assertPolicyWriteCount("after-confirm", "Exactly one confirmed policy PUT");
    console.log(
      "PASS complete policy review: no PUT before confirmation, exactly one after",
    );
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
    await element("unlock-dialog").waitFor({
      state: "visible",
      timeout: 15000,
    });
    assert.equal(await element("unlock-passphrase").inputValue(), "");
    assert.equal(
      await element("section-access").count(),
      0,
      "Saved profiles require a password",
    );
    await element("unlock-passphrase").fill(profilePassword);
    await click("unlock-submit");
    await element("section-access").waitFor({
      state: "visible",
      timeout: 15000,
    });
  };
  const relogin = async () => {
    await click("profile-menu-trigger");
    await click("logout");
    await element("profile-picker").waitFor({
      state: "visible",
      timeout: 15000,
    });
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
              document.querySelector<HTMLInputElement>(
                '[data-testid="connect-profile-name"]',
              )?.value === "Lifecycle",
            urlMatches:
              document.querySelector<HTMLInputElement>(
                '[data-testid="connect-server-url"]',
              )?.value === expectedOrigin,
            apiKeyCleared:
              document.querySelector<HTMLInputElement>(
                '[data-testid="connect-api-key"]',
              )?.value === "",
            passwordCleared:
              document.querySelector<HTMLInputElement>(
                '[data-testid="connect-password"]',
              )?.value === "",
            unlockPasswordCleared:
              document.querySelector<HTMLInputElement>(
                '[data-testid="unlock-passphrase"]',
              )?.value === "",
          },
          submitDisabled: document.querySelector<HTMLButtonElement>(
            '[data-testid="connect-submit"]',
          )?.disabled,
          connectionDialog: !!document.querySelector(
            '[data-testid="connection-dialog"]',
          ),
          unlockDialog: !!document.querySelector(
            '[data-testid="unlock-dialog"]',
          ),
          errors: ["connect-error", "login-error", "unlock-error"].map(
            (id) => ({
              id,
              text: document
                .querySelector(`[data-testid="${id}"]`)
                ?.textContent?.trim(),
            }),
          ),
          profileCount: document.querySelectorAll(
            '[data-testid^="profile-option-"]',
          ).length,
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
  await element("open-access-banner").waitFor({
    state: "visible",
    timeout: 15000,
  });
  await element("ip-rules-section").waitFor({
    state: "visible",
    timeout: 15000,
  });
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

  async function injectExtraPolicyWrite(
    point: "between-publications" | "after-final-publication",
  ) {
    if (faultFlag !== `--inject-policy-put=${point}`) return;
    const readRaw = async () => {
      const response = await fetch(policyUrl, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(
        response.status,
        200,
        "Read the owned fixture's raw policy for injection",
      );
      const { policy } = (await response.json()) as { policy: string };
      assert.equal(
        typeof policy,
        "string",
        "Injection needs the complete raw policy string",
      );
      return policy;
    };
    const raw = await readRaw();
    const before = policyWriteCount();
    const extra = await fetch(policyUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({ policy: raw }),
      signal: AbortSignal.timeout(5000),
    });
    await extra.arrayBuffer();
    assert.equal(
      extra.status,
      200,
      "The extra PUT must reach this process's owned fixture",
    );
    assert.ok(
      (await readRaw()) === raw,
      "Injection must not change the complete raw policy",
    );
    // An injection barrier, not the verifier's expected count: make the extra record visible
    // before the next publication can absorb it into the existing observed baseline.
    await waitUntil(async () => policyWriteCount() >= before + 1, {
      timeout: 5000,
      timeoutMsg: "The injected policy PUT did not become observable",
    });
    const after = policyWriteCount();
    assert.equal(
      after,
      before + 1,
      "The fault must add exactly one observable PUT",
    );
    console.log(
      JSON.stringify({
        kind: "policy-publication-count",
        stage: "fault-complete",
        point,
        before,
        after,
        rawUnchanged: true,
      }),
    );
  }
  await injectExtraPolicyWrite("between-publications");

  await prefix("ip-rule-remove-").click();
  await click("confirm-remove-policy-item");
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
  console.log(
    "PASS Headscale restart preserves its network namespace and host interface",
  );
  assert.deepEqual(
    (await readPolicy()).acls,
    [],
    "Empty ACL survives Headscale database restart",
  );
  await reload();
  await expectEmpty("empty ACL after Headscale restart and full reload");
  console.log(
    "PASS last ACL deletion persists across full reload, logout/login, and Headscale restart",
  );

  await click("template-apply-self-only");
  const restoredAcl = [
    { action: "accept", src: ["*"], dst: ["tag:personal:*"] },
  ];
  await save(restoredAcl);
  assert.deepEqual((await readPolicy()).tagOwners, { "tag:personal": [] });
  await reload();
  await element("tag-card-tag:personal").waitFor({
    state: "visible",
    timeout: 15000,
  });
  assert.deepEqual((await readPolicy()).acls, restoredAcl);
  console.log(
    "PASS browser can restore configured access from explicit empty ACL and reload it",
  );
  await injectExtraPolicyWrite("after-final-publication");

  // End every request producer, gracefully finish accepted proxy requests, then require both EOFs.
  await browser.close();
  browser = undefined;
  assert.ok(
    follower.exitCode === null && follower.signalCode === null,
    "The log follower must stay attached until proxy shutdown",
  );
  const stopped = Bun.spawnSync(
    ["docker", "stop", "--signal", "SIGQUIT", "--timeout", "5", proxy],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10000,
      killSignal: "SIGKILL",
    },
  );
  assert.equal(
    stopped.exitCode,
    0,
    "The owned proxy must complete its graceful stop",
  );
  const state = Bun.spawnSync(
    [
      "docker",
      "inspect",
      "--format",
      "{{.State.Running}} {{.State.ExitCode}} {{.State.OOMKilled}}",
      proxy,
    ],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
      killSignal: "SIGKILL",
    },
  );
  assert.equal(state.exitCode, 0, "Inspect the stopped owned proxy");
  assert.equal(
    state.stdout.toString().trim(),
    "false 0 false",
    "The proxy must exit normally",
  );
  await waitUntil(async () => followedLogs !== undefined, {
    timeout: 5000,
    timeoutMsg: "Proxy log follower did not reach exit and both stream EOFs",
  });
  assert.ok(followedLogs, "Proxy log collection must finish");
  const [stdout, stderr, exited] = followedLogs;
  assert.ok(
    stdout.status === "fulfilled",
    "Proxy stdout must reach EOF without a stream failure",
  );
  assert.ok(
    stderr.status === "fulfilled",
    "Proxy stderr must reach EOF without a stream failure",
  );
  assert.ok(
    exited.status === "fulfilled",
    "Proxy log follower must report its exit status",
  );
  assert.equal(exited.value, 0, "Proxy log follower must exit normally");
  const finalCount = countPolicyWrites(`${stdout.value}\n${stderr.value}`);
  console.log(
    JSON.stringify({
      kind: "policy-publication-count",
      stage: "logs-drained",
      proxyExitCode: 0,
      followerExitCode: exited.value,
      stdoutEof: true,
      stderrEof: true,
      expected: expectedPolicyWrites,
      observed: finalCount,
    }),
  );
  assertPolicyWriteCount(
    "final-drain",
    "Seed plus every explicit confirmation, after EOF",
    finalCount,
  );
  console.log(
    "PASS final policy PUT total after normal proxy exit and both log stream EOFs",
  );
} finally {
  await cleanup();
}
