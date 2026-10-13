import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { afterEach, expect, test } from "vitest";
import { computeBuildId } from "./build-id.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporary: string[] = [];
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function buildFixture(base: string) {
  const directory = await mkdtemp(join(tmpdir(), "headscale-session-build-"));
  temporary.push(directory);
  await Bun.write(
    join(directory, "index.html"),
    '<!doctype html><html><body><script type="module" src="/main.ts"></script></body></html>',
  );
  await Bun.write(
    join(directory, "main.ts"),
    `import { createSessionBridge } from ${JSON.stringify(join(root, "src/session/bridge.ts"))};
const worker = new SharedWorker(new URL('./worker.ts', import.meta.url), {
  type: 'module', name: 'headscale-ui-session',
});
worker.port.onmessage = ({ data }) => {
  document.body.textContent = JSON.stringify({
    bridgeAvailable: typeof createSessionBridge === 'function',
    pageBuildId: typeof __HEADSCALE_UI_BUILD_ID__ === 'string' ? __HEADSCALE_UI_BUILD_ID__ : null,
    worker: data,
  });
};
worker.port.start();
`,
  );
  await Bun.write(
    join(directory, "worker.ts"),
    `self.onconnect = async ({ ports: [port] }) => {
  const { chunkBuildId, chunkUrl } = await import('./worker-lazy');
  port.postMessage({
    buildId: typeof __HEADSCALE_UI_BUILD_ID__ === 'string' ? __HEADSCALE_UI_BUILD_ID__ : null,
    chunkBuildId,
    chunkUrl,
    sourceUrl: import.meta.url ?? null,
  });
};
`,
  );
  await Bun.write(
    join(directory, "worker-lazy.ts"),
    "export const chunkBuildId = __HEADSCALE_UI_BUILD_ID__; export const chunkUrl = import.meta.url;\n",
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "--bun",
      "vite",
      "build",
      directory,
      "--config",
      join(root, "vite.config.ts"),
      "--base",
      base,
      "--logLevel",
      "warn",
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, stdout + stderr).toBe(0);
  return join(directory, "dist");
}

test.each(["/", "/nested/ui/"])(
  "Vite emits one stable SharedWorker entry under application base %s",
  async (base) => {
    const output = await buildFixture(base);
    expect(await readdir(output, { recursive: true })).toContain("shared-session-worker.js");
    const html = await Bun.file(join(output, "index.html")).text();
    const main = html.match(/src="([^"]+\.js)"/)?.[1];
    expect(main).toBeDefined();
    expect(main?.startsWith(base)).toBe(true);
    const javascript = await Bun.file(join(output, (main as string).slice(base.length))).text();
    expect(javascript).toContain(`${base}shared-session-worker.js`);
    // The page reaches the Worker through bridge.ts only: requests.ts and defjs's HTTP pipeline stay out.
    expect(javascript).not.toContain("/api/v1/");
  },
  30_000,
);

test("built module workers report their own URL and the page's build identity", async () => {
  const browser = await chromium.launch({ headless: true });
  cleanups.push(() => browser.close());
  const buildIds: string[] = [];
  for (const base of ["/", "/nested/ui/"]) {
    const output = await buildFixture(base);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (!pathname.startsWith(base)) return new Response("Not found", { status: 404 });
        const file = Bun.file(join(output, pathname.slice(base.length) || "index.html"));
        return (await file.exists())
          ? new Response(file)
          : new Response("Not found", { status: 404 });
      },
    });
    cleanups.push(() => server.stop(true));
    const origin = `http://127.0.0.1:${server.port}`;
    const context = await browser.newContext();
    cleanups.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}${base}`);
    await page.waitForFunction(() => document.body.textContent?.startsWith("{"));
    const result = JSON.parse((await page.textContent("body")) ?? "");
    expect.soft(errors).toEqual([]);
    expect.soft(result.bridgeAvailable).toBe(true);
    expect.soft(result.worker.sourceUrl).toBe(`${origin}${base}shared-session-worker.js`);
    expect
      .soft(result.worker.chunkUrl)
      .toEqual(expect.stringMatching(`${origin}${base}assets/worker-lazy-[a-zA-Z0-9_-]+\\.js$`));
    expect(await readdir(join(output, "assets"))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^worker-lazy-[a-zA-Z0-9_-]+\.js$/)]),
    );
    expect.soft(result.pageBuildId).toEqual(expect.stringMatching(/^[0-9a-f]{32}$/));
    expect.soft(result.worker.buildId).toBe(result.pageBuildId);
    expect.soft(result.worker.chunkBuildId).toBe(result.pageBuildId);
    buildIds.push(result.pageBuildId);
  }
  // The two builds differ only by --base, so the content hash must agree with the host tree.
  expect(buildIds[1]).toBe(buildIds[0]);
  expect(buildIds[0]).toBe(computeBuildId(root));
}, 45_000);
