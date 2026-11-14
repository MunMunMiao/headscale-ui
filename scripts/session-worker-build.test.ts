import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { expect } from "vitest";
import { requireValue } from "@/test/dom";
import { computeBuildId } from "./build-id.ts";
import {
  runTestCommand,
  test,
  type TestResources,
} from "./harness/test-resources";

const root = fileURLToPath(new URL("..", import.meta.url));
async function buildFixture(
  base: string,
  resources: TestResources,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const creating = mkdtemp(join(tmpdir(), "headscale-session-build-"));
  resources.files.defer(async () =>
    rm(await creating, { recursive: true, force: true }),
  );
  const directory = await creating;
  signal.throwIfAborted();
  const preparing = (async () => {
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
    production: process.env.NODE_ENV === 'production',
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
    production: process.env.NODE_ENV === 'production',
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
  })();
  resources.tasks.defer(() => preparing);
  await preparing;
  signal.throwIfAborted();
  const { code, stdout, stderr } = await runTestCommand(
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
    {
      cwd: root,
      signal,
      tasks: resources.tasks,
      env: { ...process.env, NODE_ENV: "production" },
    },
  );
  expect(code, stdout + stderr).toBe(0);
  return join(directory, "dist");
}

for (const base of ["/", "/nested/ui/"]) {
  test(`Vite emits one stable SharedWorker entry under application base ${base}`, async ({
    resources,
    signal,
  }) => {
    const output = await buildFixture(base, resources, signal);
    expect(await readdir(output, { recursive: true })).toContain(
      "shared-session-worker.js",
    );
    const html = await Bun.file(join(output, "index.html")).text();
    const main = html.match(/src="([^"]+\.js)"/)?.[1];
    expect(main).toBeDefined();
    expect(main?.startsWith(base)).toBe(true);
    const javascript = await Bun.file(
      join(output, requireValue(main).slice(base.length)),
    ).text();
    expect(javascript).toContain(`${base}shared-session-worker.js`);
    // The page reaches the Worker through bridge.ts only: requests.ts and defjs's HTTP pipeline stay out.
    expect(javascript).not.toContain("/api/v1/");
  }, 30_000);
}

test("built module workers report their own URL and the page's build identity", async ({
  resources,
  signal,
}) => {
  const launching = chromium.launch({ headless: true });
  resources.tasks.defer(async () => (await launching).close());
  const browser = await launching;
  signal.throwIfAborted();
  const buildIds: string[] = [];
  for (const base of ["/", "/nested/ui/"]) {
    const output = await buildFixture(base, resources, signal);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (!pathname.startsWith(base))
          return new Response("Not found", { status: 404 });
        const file = Bun.file(
          join(output, pathname.slice(base.length) || "index.html"),
        );
        return (await file.exists())
          ? new Response(file)
          : new Response("Not found", { status: 404 });
      },
    });
    resources.tasks.defer(() => server.stop(true));
    const origin = `http://127.0.0.1:${server.port}`;
    const context = await browser.newContext();
    signal.throwIfAborted();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}${base}`);
    await page.waitForFunction(() =>
      document.body.textContent?.startsWith("{"),
    );
    const result = JSON.parse((await page.textContent("body")) ?? "");
    expect.soft(errors).toEqual([]);
    expect.soft(result.bridgeAvailable).toBe(true);
    expect.soft(result.production).toBe(true);
    expect.soft(result.worker.production).toBe(true);
    expect
      .soft(result.worker.sourceUrl)
      .toBe(`${origin}${base}shared-session-worker.js`);
    expect
      .soft(result.worker.chunkUrl)
      .toEqual(
        expect.stringMatching(
          `${origin}${base}assets/worker-lazy-[a-zA-Z0-9_-]+\\.js$`,
        ),
      );
    expect(await readdir(join(output, "assets"))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^worker-lazy-[a-zA-Z0-9_-]+\.js$/),
      ]),
    );
    expect
      .soft(result.pageBuildId)
      .toEqual(expect.stringMatching(/^[0-9a-f]{32}$/));
    expect.soft(result.worker.buildId).toBe(result.pageBuildId);
    expect.soft(result.worker.chunkBuildId).toBe(result.pageBuildId);
    buildIds.push(result.pageBuildId);
  }
  // The two builds differ only by --base, so the content hash must agree with the host tree.
  expect(buildIds[1]).toBe(buildIds[0]);
  expect(buildIds[0]).toBe(computeBuildId(root));
}, 45_000);
