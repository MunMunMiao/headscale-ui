import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { remote } from "webdriverio";

process.env.NO_PROXY = process.env.no_proxy = "127.0.0.1,localhost";

const root = fileURLToPath(new URL("..", import.meta.url));
const owned = `headscale-deployment-${process.pid}-${Date.now()}`;
const image = process.env.DEPLOYMENT_IMAGE || owned;
const containers: string[] = [];
const temporary = mkdtempSync(join(tmpdir(), `${owned}-`));
let browser: Awaited<ReturnType<typeof remote>> | undefined;
let build: ReturnType<typeof Bun.spawn> | undefined;
let networkCreated = false;
let imageCreated = false;
let cleaned = false;

function docker(...args: string[]): string {
  const result = Bun.spawnSync(["docker", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  assert.equal(result.exitCode, 0, `docker ${args.join(" ")}\n${result.stderr}`);
  return `${result.stdout}${args[0] === "logs" ? result.stderr : ""}`.trim();
}

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  const actions = [
    async () => {
      if (build && build.exitCode === null) {
        build.kill();
        await build.exited;
      }
    },
    async () => {
      await browser?.deleteSession();
    },
    () => {
      if (containers.length) docker("rm", "-f", ...containers);
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
  ];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      console.error("Deployment cleanup failed:", error);
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

async function endpoint(name: string): Promise<string> {
  const port = docker("port", name, "80/tcp").match(/127\.0\.0\.1:(\d+)/)?.[1];
  assert.ok(port, `Missing loopback port: ${name}`);
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fetch(origin, { signal: AbortSignal.timeout(1000) });
      return origin;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error(`Container did not become ready: ${docker("logs", name)}`);
}

async function start(base: string | undefined): Promise<{ name: string; origin: string }> {
  const name = `${owned}-${containers.length}`;
  containers.push(name);
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--network",
    owned,
    "-p",
    "127.0.0.1::80",
    ...(base === undefined ? [] : ["-e", `BASE_PATH=${base}`]),
    image,
  );
  return { name, origin: await endpoint(name) };
}

async function checkHttp(origin: string, base: string) {
  const response = await fetch(`${origin}${base}`);
  assert.equal(response.status, 200, `${base} index`);
  assert.match(response.headers.get("content-type") || "", /text\/html/);
  assert.match(response.headers.get("cache-control") || "", /no-cache/);
  const html = await response.text();
  const links = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(
    links.some((link) => link.endsWith(".js")),
    "index must load JavaScript",
  );
  const assets: string[] = [];
  for (const link of links) {
    assert.ok(link.startsWith(base), `${base}: unprefixed index link ${link}`);
    const asset = await fetch(`${origin}${link}`);
    assert.equal(asset.status, 200, link);
    if (link.startsWith(`${base}assets/`)) {
      assert.match(asset.headers.get("cache-control") || "", /immutable/, link);
    }
    const type = asset.headers.get("content-type") || "";
    assert.match(
      type,
      link.endsWith(".js") ? /javascript/ : link.endsWith(".css") ? /text\/css/ : /image\//,
      link,
    );
    assets.push(
      `${link}:${new Bun.CryptoHasher("sha256").update(await asset.arrayBuffer()).digest("hex")}`,
    );
  }
  for (const path of ["login", "devices", "nested/deep/link", "index.html"]) {
    const deep = await fetch(`${origin}${base}${path}`);
    assert.equal(deep.status, 200, path);
    assert.match(deep.headers.get("cache-control") || "", /no-cache/, path);
    assert.equal(await deep.text(), html, path);
  }
  for (const path of ["assets/missing.js", "assets/missing.css"]) {
    assert.equal((await fetch(`${origin}${base}${path}`)).status, 404, path);
  }
  if (base !== "/") {
    for (const path of ["/", "/login", "/assets/missing.js", `${base.slice(0, -1)}-outside/`]) {
      assert.equal((await fetch(`${origin}${path}`)).status, 404, `outside prefix ${path}`);
    }
    const redirect = await fetch(`${origin}${base.slice(0, -1)}?probe=1&next=%2Fhome`, {
      redirect: "manual",
    });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get("location"), `${base}?probe=1&next=%2Fhome`);
  }
  return [html, ...assets];
}

async function checkBrowser(origin: string, base: string) {
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
  const click = async (id: string) => {
    await element(id).waitForDisplayed({ timeout: 15000 });
    await element(id).click();
  };
  const connect = async () => {
    await click("profile-option-new");
    await element("connect-profile-name").setValue("Probe");
    await element("connect-mode").selectByAttribute("value", "mock");
    await click("connect-submit");
    await click("profile-option-Probe");
    await element("section-home").waitForDisplayed({ timeout: 15000 });
  };
  const security = async () => {
    await click("profile-menu-trigger");
    await click("open-server-settings");
    await click("server-tab-security");
  };
  // Throw before any IDB clear runs; the production clear handler must retain this document.
  const failClear = async (trigger: string, confirm: string) => {
    const before = await page.getUrl();
    const epoch = await page.execute(() => performance.timeOrigin);
    await page.execute(() => {
      IDBObjectStore.prototype.clear = () => {
        throw new Error("deployment injected clear failure");
      };
    });
    await click(trigger);
    await click(confirm);
    await element(trigger).waitForEnabled({ timeout: 10000 });
    await page.waitUntil(
      async () =>
        (await page.$('[role="alert"]').getText()).includes("deployment injected clear failure"),
      { timeout: 10000 },
    );
    assert.equal(await page.getUrl(), before, "failed clear must not navigate");
    assert.equal(
      await page.execute(() => performance.timeOrigin),
      epoch,
      "failed clear must not reload",
    );
    await page.refresh();
  };
  const clear = async (trigger: string, confirm: string, query: string) => {
    const epoch = await page.execute(() => performance.timeOrigin);
    await click(trigger);
    await click(confirm);
    await page.waitUntil(async () => (await page.getUrl()) === `${origin}${base}login${query}`, {
      timeout: 15000,
    });
    await element("profile-option-new").waitForExist({ timeout: 15000 });
    assert.notEqual(
      await page.execute(() => performance.timeOrigin),
      epoch,
      "clear must fully reload",
    );
    assert.equal(
      await element("profile-option-Probe").isExisting(),
      false,
      "saved profile cleared",
    );
    if (query) await element("profiles-cleared-notice").waitForDisplayed();
  };
  try {
    await page.url(`${origin}${base}`);
    await connect();
    for (const section of ["home", "devices", "members", "invites", "routes", "access"]) {
      await click(`section-${section}`);
      await page.waitUntil(
        async () => new URL(await page.getUrl()).pathname === `${base}${section}`,
        { timeout: 10000 },
      );
      assert.ok((await page.$('[data-testid="page-body"]').getText()).length > 0, section);
    }
    await click("section-devices");
    await page.refresh();
    await element("section-devices").waitForDisplayed({ timeout: 15000 });
    assert.equal(new URL(await page.getUrl()).pathname, `${base}devices`);
    await security();
    await failClear("security-clear-all", "security-clear-all-confirm");
    await security();
    await clear("security-clear-all", "security-clear-all-confirm", "");
    await connect();
    await security();
    await click("security-enable-passphrase");
    await click("security-acknowledge");
    await element("security-new-passphrase").setValue("deployment-passphrase");
    await element("security-confirm-passphrase").setValue("deployment-passphrase");
    await click("security-enable-submit");
    await element("security-change-passphrase").waitForDisplayed({ timeout: 15000 });
    await page.refresh();
    await element("unlock-overlay").waitForDisplayed({ timeout: 15000 });
    await failClear("unlock-forgot", "unlock-forgot-confirm");
    await clear("unlock-forgot", "unlock-forgot-confirm", "?cleared=1");
  } finally {
    await page.deleteSession();
    browser = undefined;
  }
}

try {
  if (!process.env.DEPLOYMENT_IMAGE) {
    build = Bun.spawn(["docker", "build", "-t", image, "."], {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    });
    assert.equal(await build.exited, 0, "Docker build failed");
    imageCreated = true;
  }
  docker("network", "create", owned);
  networkCreated = true;
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
    const pristine = docker(
      "exec",
      name,
      "sh",
      "-c",
      "find /opt/headscale-ui/dist -type f -exec sha256sum {} \\; | sort",
    );
    assert.ok(pristine.length > 0);
    if (pristineBuild === undefined) {
      const original = `${owned}-${containers.length}`;
      containers.push(original);
      pristineBuild = docker(
        "run",
        "--name",
        original,
        "--entrypoint",
        "sh",
        image,
        "-c",
        "find /opt/headscale-ui/dist -type f -exec sha256sum {} \\; | sort",
      );
    }
    assert.equal(pristine, pristineBuild, "runtime must preserve original build");
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
    if (value === "/" || value === "/admin/" || value === "/nested/admin/")
      await checkBrowser(restartedOrigin, base);
    console.log(`PASS runtime BASE_PATH=${JSON.stringify(value)} and restart`);
  }
  for (const base of [
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
  ]) {
    const name = `${owned}-${containers.length}`;
    containers.push(name);
    docker("run", "-d", "--name", name, "-e", `BASE_PATH=${base}`, image);
    const wait = Bun.spawn(["docker", "wait", name], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => wait.kill(), 10000);
    try {
      const code = (await new Response(wait.stdout).text()).trim();
      assert.equal(await wait.exited, 0, `invalid BASE_PATH did not terminate: ${base}`);
      assert.notEqual(code, "0", `accepted invalid BASE_PATH ${base}`);
      assert.match(docker("logs", name), /Invalid BASE_PATH/, base);
    } finally {
      clearTimeout(timer);
    }
  }
  const upstream = await start("/admin/");
  const config = join(temporary, "proxy.conf");
  await Bun.write(
    config,
    `server { listen 80; absolute_redirect off; location /admin { proxy_pass http://${upstream.name}:80; } location / { return 404; } }\n`,
  );
  const proxy = `${owned}-${containers.length}`;
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
  const proxyOrigin = await endpoint(proxy);
  await checkHttp(proxyOrigin, "/admin/");
  await checkBrowser(proxyOrigin, "/admin/");
  console.log("PASS invalid BASE_PATH rejection and prefix-preserving reverse proxy");
} finally {
  await cleanup();
}
