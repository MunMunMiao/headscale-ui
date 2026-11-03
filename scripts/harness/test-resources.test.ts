import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fieldOf } from "@/test/dom";
import { root } from "./docker";
import { runTestCommand } from "./test-resources";

async function directory(files: AsyncDisposableStack) {
  const path = await mkdtemp(join(tmpdir(), "headscale-test-resources-"));
  files.defer(() => rm(path, { recursive: true, force: true }));
  return path;
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (fieldOf(error, "code") !== "ESRCH") throw error;
    return false;
  }
}

function stop(pid: number) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (fieldOf(error, "code") !== "ESRCH") throw error;
  }
}

const heldCommand = (ready: string, detached = false) => {
  const naturalExit = JSON.stringify(`${ready}.natural`);
  const descendant = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); setTimeout(async () => { await Bun.write(${naturalExit}, "descendant"); process.exit(); }, 3000);`;
  return `
const descendant = Bun.spawn([process.execPath, "-e", ${JSON.stringify(descendant)}], { detached: ${detached}, stdout: "inherit", stderr: "inherit" });
await Bun.write(${JSON.stringify(ready)}, JSON.stringify({ parent: process.pid, descendant: descendant.pid }));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
setTimeout(async () => { await Bun.write(${naturalExit}, "parent"); process.exit(); }, 3000);
`;
};

test("captures both output streams, the exit status and the supplied environment", async ({
  signal,
}) => {
  await using tasks = new AsyncDisposableStack();
  const listeners = new Map(
    ["SIGINT", "SIGTERM", "exit"].map((event) => [
      event,
      process.listeners(event),
    ]),
  );
  const result = await runTestCommand(
    [
      process.execPath,
      "-e",
      'process.stdout.write(process.env.TEST_RESOURCE_VALUE + "o".repeat(100000)); process.stderr.write("e".repeat(100000)); process.exitCode = 7;',
    ],
    {
      cwd: root,
      signal,
      tasks,
      env: { ...process.env, TEST_RESOURCE_VALUE: "fixture" },
    },
  );
  expect(result.code).toBe(7);
  expect(result.stdout).toBe(`fixture${"o".repeat(100000)}`);
  expect(result.stderr).toBe("e".repeat(100000));
  for (const [event, before] of listeners)
    expect(process.listeners(event)).toEqual(before);
});

test("a cancelled test cannot start another command", async () => {
  await using files = new AsyncDisposableStack();
  await using tasks = new AsyncDisposableStack();
  const path = await directory(files);
  const marker = join(path, "started");
  const controller = new AbortController();
  controller.abort();
  await expect(
    runTestCommand(
      [
        process.execPath,
        "-e",
        `await Bun.write(${JSON.stringify(marker)}, "started")`,
      ],
      { cwd: root, signal: controller.signal, tasks },
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(await Bun.file(marker).exists()).toBe(false);
});

test("a disposed test scope cannot start another command", async ({
  signal,
}) => {
  await using files = new AsyncDisposableStack();
  const tasks = new AsyncDisposableStack();
  await tasks.disposeAsync();
  const path = await directory(files);
  const marker = join(path, "started");
  await expect(
    runTestCommand(
      [
        process.execPath,
        "-e",
        `await Bun.write(${JSON.stringify(marker)}, "started")`,
      ],
      { cwd: root, signal, tasks },
    ),
  ).rejects.toBeInstanceOf(ReferenceError);
  expect(await Bun.file(marker).exists()).toBe(false);
});

test.skipIf(process.platform === "win32").each(["abort", "dispose"] as const)(
  "%s stops the owned process and descendants holding its output pipes",
  async (mode) => {
    await using files = new AsyncDisposableStack();
    await using tasks = new AsyncDisposableStack();
    const path = await directory(files);
    const ready = join(path, "ready.json");
    const controller = new AbortController();
    const outcome = runTestCommand(
      [process.execPath, "-e", heldCommand(ready)],
      { cwd: root, signal: controller.signal, tasks },
    ).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    let owned: { parent: number; descendant: number } | undefined;
    try {
      await expect.poll(() => Bun.file(ready).exists()).toBe(true);
      owned = await Bun.file(ready).json();
      expect.assert(owned);
      if (!owned) throw new Error("Expected owned resources");
      const ownedResources = owned;
      if (mode === "abort") controller.abort();
      else await tasks.disposeAsync();
      await expect
        .poll(
          () =>
            alive(ownedResources.parent) || alive(ownedResources.descendant),
          {
            timeout: 1000,
          },
        )
        .toBe(false);
      const result = await outcome;
      if (mode === "abort")
        expect(result).toMatchObject({ error: { name: "AbortError" } });
      else {
        expect.assert("value" in result);
        expect(result.value.code).not.toBe(0);
      }
    } finally {
      controller.abort();
      if (owned) {
        stop(owned.parent);
        stop(owned.descendant);
      }
      await outcome;
    }
  },
);

test("a real test timeout reclaims commands and files even when another disposer fails", async ({
  signal,
}) => {
  await using files = new AsyncDisposableStack();
  await using tasks = new AsyncDisposableStack();
  const path = await directory(files);
  const ready = join(path, "nested-ready.json");
  const removed = join(path, "removed");
  const stopped = join(path, "stopped");
  const ownedDirectory = join(path, "owned");
  const fixture = join(path, "timeout.test.ts");
  const config = join(path, "vitest.config.ts");
  await Bun.write(
    fixture,
    `
import { mkdir, rm, writeFile } from "node:fs/promises";
import { beforeEach, expect } from ${JSON.stringify(join(root, "node_modules/vitest/dist/index.js"))};
import { test, runTestCommand } from ${JSON.stringify(join(root, "scripts/harness/test-resources.ts"))};
let command;
beforeEach(async ({ resources, signal }) => {
  await mkdir(${JSON.stringify(ownedDirectory)});
  resources.files.defer(async () => { await rm(${JSON.stringify(ownedDirectory)}, { recursive: true, force: true }); await writeFile(${JSON.stringify(removed)}, "removed"); });
  resources.tasks.defer(() => writeFile(${JSON.stringify(stopped)}, "stopped"));
  resources.tasks.defer(() => { throw new Error("expected disposer failure"); });
  command = runTestCommand([process.execPath, "-e", ${JSON.stringify(heldCommand(ready))}], { cwd: ${JSON.stringify(root)}, signal, tasks: resources.tasks });
  command.catch(() => {});
  await expect.poll(() => Bun.file(${JSON.stringify(ready)}).exists(), { timeout: 1500 }).toBe(true);
});
test("owned timeout fixture", async ({ resources }) => {
  void resources;
  await command;
}, 400);
`,
  );
  await Bun.write(
    config,
    `export default { root: ${JSON.stringify(root)}, test: { include: [${JSON.stringify(fixture)}], hookTimeout: 2000 } };`,
  );
  let owned: { parent: number; descendant: number } | undefined;
  try {
    const result = await runTestCommand(
      [
        process.execPath,
        join(root, "node_modules/vitest/vitest.mjs"),
        "run",
        "--config",
        config,
      ],
      { cwd: root, signal, tasks },
    );
    if (await Bun.file(ready).exists()) owned = await Bun.file(ready).json();
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toMatch(/timed out/);
    expect(result.output).toContain("expected disposer failure");
    expect(await Bun.file(stopped).exists()).toBe(true);
    expect(await Bun.file(removed).exists()).toBe(true);
    expect(existsSync(ownedDirectory)).toBe(false);
    expect.assert(owned);
    if (!owned) throw new Error("Expected owned resources");
    const ownedResources = owned;
    await expect
      .poll(
        () => alive(ownedResources.parent) || alive(ownedResources.descendant),
        {
          timeout: 1000,
        },
      )
      .toBe(false);
    expect(await Bun.file(`${ready}.natural`).exists()).toBe(false);
  } finally {
    if (owned) {
      stop(owned.parent);
      stop(owned.descendant);
    }
  }
}, 15000);

test.skipIf(process.platform === "win32").each([
  { signal: "SIGINT" as const, existingHandler: false },
  { signal: "SIGTERM" as const, existingHandler: false },
  { signal: "SIGINT" as const, existingHandler: true },
  { signal: "SIGTERM" as const, existingHandler: true },
  { signal: "exit" as const, existingHandler: false },
])(
  "$signal of the owner process group reclaims commands (existing handler: $existingHandler)",
  async ({ signal: interrupt, existingHandler }) => {
    await using files = new AsyncDisposableStack();
    await using tasks = new AsyncDisposableStack();
    const path = await directory(files);
    const ready = join(path, "signal-ready.json");
    const ownerReady = join(path, "owner.json");
    const controller = new AbortController();
    const ownerSource = `
import { runTestCommand } from ${JSON.stringify(join(root, "scripts/harness/test-command.ts"))};
await using tasks = new AsyncDisposableStack();
${existingHandler ? `process.on(${JSON.stringify(interrupt)}, () => process.exit(${interrupt === "SIGINT" ? 130 : 143}));` : ""}
await Bun.write(${JSON.stringify(ownerReady)}, JSON.stringify(process.pid));
const command = runTestCommand([process.execPath, "-e", ${JSON.stringify(heldCommand(ready))}], { cwd: ${JSON.stringify(root)}, signal: new AbortController().signal, tasks });
${interrupt === "exit" ? `while (!(await Bun.file(${JSON.stringify(ready)}).exists())) await Bun.sleep(1); process.exit(17);` : "await command;"}
`;
    const outcome = runTestCommand([process.execPath, "-e", ownerSource], {
      cwd: root,
      signal: controller.signal,
      tasks,
    }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    let owned: { parent: number; descendant: number } | undefined;
    let owner: number | undefined;
    try {
      await expect.poll(() => Bun.file(ready).exists()).toBe(true);
      owner = await Bun.file(ownerReady).json();
      owned = await Bun.file(ready).json();
      expect.assert(owner);
      expect.assert(owned);
      if (!owned) throw new Error("Expected owned resources");
      const ownedResources = owned;
      if (interrupt !== "exit") process.kill(-owner, interrupt);
      await expect
        .poll(
          () =>
            alive(ownedResources.parent) || alive(ownedResources.descendant),
          {
            timeout: 1000,
          },
        )
        .toBe(false);
      await outcome;
      expect(await Bun.file(`${ready}.natural`).exists()).toBe(false);
    } finally {
      controller.abort();
      if (owned) {
        stop(owned.parent);
        stop(owned.descendant);
      }
      if (owner) stop(owner);
      await outcome;
    }
  },
);

test.skipIf(process.platform === "win32")(
  "cancellation does not wait for EOF from an independently detached pipe holder",
  async () => {
    await using files = new AsyncDisposableStack();
    await using tasks = new AsyncDisposableStack();
    const path = await directory(files);
    const ready = join(path, "detached-ready.json");
    const controller = new AbortController();
    let settled = false;
    const outcome = runTestCommand(
      [process.execPath, "-e", heldCommand(ready, true)],
      { cwd: root, signal: controller.signal, tasks },
    )
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      .then((result) => {
        settled = true;
        return result;
      });
    let owned: { parent: number; descendant: number } | undefined;
    try {
      await expect.poll(() => Bun.file(ready).exists()).toBe(true);
      owned = await Bun.file(ready).json();
      expect.assert(owned);
      controller.abort();
      await expect.poll(() => settled, { timeout: 1000 }).toBe(true);
      expect(await outcome).toMatchObject({ error: { name: "AbortError" } });
    } finally {
      // 已脱离命令进程组的探针由本测试单独拥有，不能让它阻塞命令管道收尾。
      controller.abort();
      if (owned) {
        stop(owned.parent);
        stop(owned.descendant);
      }
      await outcome;
    }
  },
);
