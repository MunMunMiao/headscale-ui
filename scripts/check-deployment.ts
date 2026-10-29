import assert from "node:assert/strict";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { checkVaultRecovery } from "../e2e/session/storage";
import { assertSecurityHeaders } from "./deployment/headers";
import { checkLocales } from "./deployment/locales";
import {
  createDeploymentStack,
  type DeploymentConnection,
} from "./harness/deployment-stack";
import { docker } from "./harness/docker";
import { waitForDockerIpv6 } from "./harness/docker-network";
import { evaluateSharedWorker } from "./harness/shared-worker-probe";
import { waitUntil } from "./harness/wait-until";

process.env.NO_PROXY = process.env.no_proxy = "127.0.0.1,localhost";

const stack = createDeploymentStack("headscale-deployment");
const { endpoint, start, temporary } = stack;
let browser: Browser | undefined;
stack.onCleanup(() => browser?.close());

async function assertIdentity(url: string, label: string, compressible = true) {
  const plain = await fetch(url, {
    headers: { "Accept-Encoding": "identity" },
  });
  assert.equal(
    plain.headers.get("content-encoding"),
    null,
    `${label}: identity encoding`,
  );
  if (compressible)
    assert.match(
      plain.headers.get("vary") || "",
      /Accept-Encoding/i,
      `${label}: identity Vary`,
    );
}

async function checkHttp(origin: string, base: string) {
  const response = await fetch(`${origin}${base}`);
  assert.equal(response.status, 200, `${base} index`);
  assert.match(response.headers.get("content-type") || "", /text\/html/);
  assert.match(response.headers.get("cache-control") || "", /no-cache/);
  assertSecurityHeaders(response, `${base} index`);
  assert.match(
    response.headers.get("vary") || "",
    /Accept-Encoding/i,
    `${base} index Vary`,
  );
  await assertIdentity(`${origin}${base}`, `${base} index`);
  const html = await response.text();
  assert.match(
    html,
    /<html[^>]*\slang="en-US"/,
    `${base} index declares the default language`,
  );
  const links = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.ok(
    links.some((link) => link.endsWith(".js")),
    "index must load JavaScript",
  );
  const assets: string[] = [];
  for (const link of links) {
    assert.ok(link.startsWith(base), `${base}: unprefixed index link ${link}`);
    const asset = await fetch(`${origin}${link}`);
    assert.equal(asset.status, 200, link);
    assertSecurityHeaders(asset, link);
    if (link.startsWith(`${base}assets/`)) {
      assert.match(asset.headers.get("cache-control") || "", /immutable/, link);
    }
    const type = asset.headers.get("content-type") || "";
    assert.match(
      type,
      link.endsWith(".js")
        ? /javascript/
        : link.endsWith(".css")
          ? /text\/css/
          : /image\//,
      link,
    );
    const content = await asset.arrayBuffer();
    if (/\.(js|css)$/.test(link)) {
      // 与 nginx 的 gzip_min_length 256 一致；更小的资源没有压缩变体，不需要 Vary。
      const compressible = content.byteLength >= 256;
      if (compressible)
        assert.match(
          asset.headers.get("vary") || "",
          /Accept-Encoding/i,
          `${link} Vary`,
        );
      else
        assert.equal(
          asset.headers.get("content-encoding"),
          null,
          `${link}: small asset encoding`,
        );
      await assertIdentity(`${origin}${link}`, link, compressible);
    }
    assets.push(
      `${link}:${new Bun.CryptoHasher("sha256").update(content).digest("hex")}`,
    );
  }
  const worker = await fetch(`${origin}${base}shared-session-worker.js`);
  assert.equal(worker.status, 200, "stable SharedWorker entry");
  assert.match(worker.headers.get("content-type") || "", /javascript/);
  assert.match(worker.headers.get("cache-control") || "", /no-cache/);
  // The Worker's own response CSP governs its fetches, and users supply the Headscale URL.
  assertSecurityHeaders(worker, "Worker entry", "http: https:");
  const etag = worker.headers.get("etag");
  assert.ok(etag, "Worker entry has a revalidation token");
  const revalidated = await fetch(`${origin}${base}shared-session-worker.js`, {
    headers: { "If-None-Match": etag },
  });
  assert.equal(revalidated.status, 304);
  assertSecurityHeaders(revalidated, "Worker entry 304", "http: https:");
  assets.push(
    `worker:${new Bun.CryptoHasher("sha256").update(await worker.arrayBuffer()).digest("hex")}`,
  );
  for (const path of ["login", "devices", "nested/deep/link", "index.html"]) {
    const deep = await fetch(`${origin}${base}${path}`);
    assert.equal(deep.status, 200, path);
    assert.match(deep.headers.get("cache-control") || "", /no-cache/, path);
    assertSecurityHeaders(deep, path);
    assert.equal(await deep.text(), html, path);
  }
  for (const path of ["assets/missing.js", "assets/missing.css"]) {
    const missing = await fetch(`${origin}${base}${path}`);
    assert.equal(missing.status, 404, path);
    assertSecurityHeaders(missing, `missing ${path}`);
  }
  if (base !== "/") {
    for (const path of [
      "/",
      "/login",
      "/assets/missing.js",
      `${base.slice(0, -1)}-outside/`,
    ]) {
      assert.equal(
        (await fetch(`${origin}${path}`)).status,
        404,
        `outside prefix ${path}`,
      );
    }
    const redirect = await fetch(
      `${origin}${base.slice(0, -1)}?probe=1&next=%2Fhome`,
      {
        redirect: "manual",
      },
    );
    assert.equal(redirect.status, 308);
    assertSecurityHeaders(redirect, "308 redirect");
    assert.equal(
      redirect.headers.get("location"),
      `${base}?probe=1&next=%2Fhome`,
    );
  }
  return [html, ...assets];
}

async function checkBrowser(
  origin: string,
  base: string,
  connection: DeploymentConnection,
) {
  await waitForDockerIpv6(stack.networkId);
  browser = await chromium.launch({ headless: true });
  await checkLocales(browser, origin, base);
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const pageErrors: string[] = [];
  page
    .context()
    .on("page", (peer) =>
      peer.on("pageerror", (error) => pageErrors.push(error.message)),
    );
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const cspMessages: string[] = [];
  page.on("console", (message) => {
    if (/Content[ -]Security[ -]Policy/.test(message.text()))
      cspMessages.push(message.text());
  });
  const element = (id: string) => page.locator(`[data-testid="${id}"]`);
  const click = async (id: string) => {
    await element(id).waitFor({ state: "visible", timeout: 15000 });
    await element(id).click();
  };
  const connect = async () => {
    await click("profile-option-new");
    await element("connect-profile-name").fill("Probe");
    await element("connect-server-url").fill(connection.baseUrl);
    await element("connect-api-key").fill(connection.apiKey);
    await element("connect-password").fill("deployment-passphrase");
    await element("connect-password-confirm").fill("deployment-passphrase");
    await click("connect-save-unlock");
    await element("section-home").waitFor({ state: "visible", timeout: 15000 });
  };
  const checkCsp = async () => {
    const result = await page.evaluate(async () => {
      const violated: string[] = [];
      document.addEventListener("securitypolicyviolation", (event) =>
        violated.push(event.violatedDirective),
      );
      const script = document.createElement("script");
      script.textContent = "window.__cspProbe = true";
      document.head.append(script);
      await fetch("http://127.0.0.1:9").catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { violated, executed: "__cspProbe" in window };
    });
    assert.equal(result.executed, false, "injected inline script must not run");
    assert.ok(
      result.violated.some((directive) => directive.startsWith("script-src")),
      `inline script must violate script-src: ${result.violated}`,
    );
    assert.ok(
      result.violated.some((directive) => directive.startsWith("connect-src")),
      `foreign page fetch must violate connect-src: ${result.violated}`,
    );
    // The Worker runs under its own response CSP, which allows only http: and https: fetches.
    assert.equal(
      await evaluateSharedWorker<string>(
        page,
        workerUrl,
        `fetch("data:text/plain,probe").then(() => "allowed", () => "blocked")`,
      ),
      "blocked",
      "Worker fetch must obey the Worker response CSP",
    );
    // Headscale unlock above is the positive evidence; the probes' own console noise is expected.
    cspMessages.length = 0;
  };
  const security = async () => {
    await click("profile-menu-trigger");
    await click("open-server-settings");
    await click("server-tab-security");
  };
  const workerUrl = `${origin}${base}shared-session-worker.js`;
  const unlock = async () => {
    await click("profile-option-Probe");
    await element("unlock-passphrase").fill("deployment-passphrase");
    await click("unlock-submit");
    await element("section-home").waitFor({ state: "visible" });
  };
  // The operation runs in the Worker; a page prototype patch would prove nothing.
  const failClear = async (trigger: string, confirm: string) => {
    const epoch = await page.evaluate(() => performance.timeOrigin);
    await evaluateSharedWorker(
      page,
      workerUrl,
      `self.__clearProbe = { original: IDBObjectStore.prototype.clear, hits: 0 }; IDBObjectStore.prototype.clear = function () { self.__clearProbe.hits++; throw new Error("deployment clear failure"); }; true`,
    );
    try {
      await click(trigger);
      await click(confirm);
      await element("profile-option-Probe").waitFor({ state: "visible" });
      await element("login-error").waitFor({ state: "visible" });
      assert.match(
        (await element("login-error").textContent()) ?? "",
        /save|storage|failed|data/i,
      );
      assert.ok(
        (await evaluateSharedWorker<number>(
          page,
          workerUrl,
          "self.__clearProbe.hits",
        )) > 0,
        "native Worker clear fault was exercised",
      );
      assert.equal(
        await page.evaluate(() => performance.timeOrigin),
        epoch,
        "failed clear must not reload",
      );
      assert.equal(
        await element("section-home").count(),
        0,
        "failed reset still locks the session",
      );
    } finally {
      await evaluateSharedWorker(
        page,
        workerUrl,
        "IDBObjectStore.prototype.clear = self.__clearProbe.original; delete self.__clearProbe; true",
      );
    }
  };
  const clear = async (trigger: string, confirm: string, query: string) => {
    const epoch = await page.evaluate(() => performance.timeOrigin);
    await click(trigger);
    await click(confirm);
    await waitUntil(
      async () => (await page.url()) === `${origin}${base}login${query}`,
      {
        timeout: 15000,
      },
    );
    await element("profile-option-new").waitFor({
      state: "attached",
      timeout: 15000,
    });
    assert.notEqual(
      await page.evaluate(() => performance.timeOrigin),
      epoch,
      "clear must fully reload",
    );
    assert.equal(
      (await element("profile-option-Probe").count()) > 0,
      false,
      "saved profile cleared",
    );
    if (query)
      await element("profiles-cleared-notice").waitFor({ state: "visible" });
  };
  // Each section's stable, always-present element once its data has loaded.
  const ready: Record<string, string> = {
    home: '[data-testid="overview-stats"]',
    devices:
      '[data-testid="machines-empty"], [data-testid="machine-table-shell"]',
    members: '[data-testid="user-table-shell"]',
    invites: '[data-testid="invite-table-shell"]',
    routes: '[data-testid="refresh-routes"]',
    access: '[data-testid="check-policy"]',
  };
  try {
    await page.goto(`${origin}${base}`);
    await connect();
    await checkCsp();
    for (const section of Object.keys(ready)) {
      await click(`section-${section}`);
      await waitUntil(
        async () => new URL(await page.url()).pathname === `${base}${section}`,
        {
          timeout: 10000,
        },
      );
      await page
        .locator(ready[section])
        .first()
        .waitFor({ state: "visible", timeout: 15000 });
      assert.equal(
        await page
          .locator(
            `
            [data-testid="error-screen"],
            [data-testid="page-body"] :is(
              [data-testid="action-error"],
              [data-testid="feedback-status-error"],
              [data-testid="locale-error"],
              [data-testid="theme-error"],
              [data-testid="settings-error"],
              [data-slot="notice"][data-tone="error"]
            )
          `,
          )
          .count(),
        0,
        `${section} shows an error instead of its content`,
      );
      if (section === "members") {
        await waitUntil(
          async () =>
            (
              (await page.locator('[data-testid="page-body"]').textContent()) ??
              ""
            ).includes(connection.user),
          {
            timeout: 15000,
            timeoutMsg: "UI must read the seeded user from Headscale",
          },
        );
      }
    }
    await click("section-devices");
    const peer = await page.context().newPage();
    await peer.goto(`${origin}${base}home`);
    await peer.getByTestId("section-home").waitFor({ state: "visible" });
    await page.reload();
    await element("section-devices").waitFor({
      state: "visible",
      timeout: 15000,
    });
    await peer.close();
    assert.equal(new URL(await page.url()).pathname, `${base}devices`);
    await security();
    await failClear("security-clear-all", "security-clear-all-confirm");
    await unlock();
    await security();
    await clear("security-clear-all", "security-clear-all-confirm", "");
    await connect();
    await security();
    await page.keyboard.press("Escape");
    await click("profile-menu-trigger");
    await click("logout");
    await click("profile-option-Probe");
    await element("unlock-dialog").waitFor({ state: "visible" });
    assert.equal(await element("unlock-forgot").count(), 0);
    await click("unlock-cancel");
    await failClear("login-clear-all", "login-clear-all-confirm");
    await clear("login-clear-all", "login-clear-all-confirm", "?cleared=1");
    if (base !== "/")
      await checkVaultRecovery(browser, origin, base, connection);
    assert.deepEqual(
      pageErrors,
      [],
      "deployment pages have no unhandled browser errors",
    );
    assert.deepEqual(
      cspMessages,
      [],
      "the application itself triggers no CSP violation",
    );
  } finally {
    await browser.close();
    browser = undefined;
  }
}

async function main() {
  await stack.prepare();
  const connection = await stack.startHeadscale("a");
  let pristineBuild: string | undefined;
  for (const value of [
    "/admin",
    undefined,
    "",
    "/",
    "/admin/",
    "/nested/admin/",
    "/A-z_0.~/",
    "/index.html/",
  ]) {
    const base = value ? `${value.replace(/\/$/, "")}/` : "/";
    const { name, origin } = await start(value);
    const before = await checkHttp(origin, base);
    docker("exec", name, "rm", `/usr/share/headscale-ui${base}favicon.svg`);
    assert.equal(
      (await fetch(`${origin}${base}favicon.svg`)).status,
      404,
      "missing favicon must not return HTML",
    );
    docker(
      "exec",
      name,
      "rm",
      `/usr/share/headscale-ui${base}shared-session-worker.js`,
    );
    assert.equal(
      (await fetch(`${origin}${base}shared-session-worker.js`)).status,
      404,
      "missing Worker entry must not fall back to HTML",
    );
    const pristine = docker(
      "exec",
      name,
      "sh",
      "-c",
      "find /opt/headscale-ui/dist -type f -exec sha256sum {} \\; | sort",
    );
    assert.ok(pristine.length > 0);
    if (pristineBuild === undefined) {
      const original = stack.reserveName();
      pristineBuild = docker(
        "run",
        "--name",
        original,
        "--entrypoint",
        "sh",
        stack.image,
        "-c",
        "find /opt/headscale-ui/dist -type f -exec sha256sum {} \\; | sort",
      );
    }
    assert.equal(
      pristine,
      pristineBuild,
      "runtime must preserve original build",
    );
    docker("restart", name);
    const restartedOrigin = await endpoint(name);
    assert.deepEqual(
      await checkHttp(restartedOrigin, base),
      before,
      "restart changes rendered assets",
    );
    assert.equal(
      docker(
        "exec",
        name,
        "sh",
        "-c",
        "find /opt/headscale-ui/dist -type f -exec sha256sum {} \\; | sort",
      ),
      pristine,
    );
    await checkBrowser(restartedOrigin, base, connection);
    console.log(`PASS runtime BASE_PATH=${JSON.stringify(value)} and restart`);
  }
  const invalid: [string, string][] = [
    "https://example.com/admin",
    "admin",
    "/a/../b",
    "/./",
    "/a//b",
    "/a b",
    "/a?b",
    "/a#b",
    "/a%20b",
    "/__HEADSCALE_UI_BASE__/",
  ].map((value): [string, string] => ["BASE_PATH", value]);
  const rejected = async (flags: string[], pattern: RegExp, label: string) => {
    const name = stack.reserveName();
    docker("run", "-d", "--name", name, ...flags, stack.image);
    const wait = Bun.spawn(["docker", "wait", name], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => wait.kill(), 10000);
    try {
      const code = (await new Response(wait.stdout).text()).trim();
      assert.equal(await wait.exited, 0, `${label} did not terminate`);
      assert.notEqual(code, "0", `accepted ${label}`);
      assert.match(docker("logs", name), pattern, label);
    } finally {
      clearTimeout(timer);
    }
  };
  for (const [variable, value] of invalid) {
    await rejected(
      ["-e", `${variable}=${value}`],
      new RegExp(`Invalid ${variable}`),
      `invalid ${variable} ${JSON.stringify(value)}`,
    );
  }
  const upstream = await start("/admin/");
  const config = join(temporary, "proxy.conf");
  await Bun.write(
    config,
    `server { listen 80; absolute_redirect off; location /admin { proxy_pass http://${upstream.name}:80; } location / { return 404; } }\n`,
  );
  const proxyOrigin = await stack.startProxy(config);
  await checkHttp(proxyOrigin, "/admin/");
  await checkBrowser(proxyOrigin, "/admin/", connection);
  console.log(
    "PASS invalid BASE_PATH rejection and prefix-preserving reverse proxy",
  );
}

try {
  await main();
} catch (error) {
  const diagnostic =
    error instanceof Error ? error.stack || error.message : String(error);
  console.error(stack.redact(diagnostic));
  process.exitCode = 1;
} finally {
  await stack.cleanup();
}
