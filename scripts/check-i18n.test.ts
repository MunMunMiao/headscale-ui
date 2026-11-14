import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { SUPPORTED_LOCALES } from "../src/i18n/locales";
import {
  runTestCommand,
  test,
  type TestResources,
} from "./harness/test-resources";

const root = fileURLToPath(new URL("..", import.meta.url));

async function fixture(resources: TestResources, signal: AbortSignal) {
  signal.throwIfAborted();
  const creating = mkdtemp(join(tmpdir(), "headscale-i18n-check-"));
  resources.files.defer(async () =>
    rm(await creating, { recursive: true, force: true }),
  );
  const directory = await creating;
  signal.throwIfAborted();
  const preparing = (async () => {
    await cp(join(root, "src/i18n"), join(directory, "src/i18n"), {
      recursive: true,
    });
    await mkdir(join(directory, "scripts"));
    for (const file of [
      "package.json",
      "bunfig.toml",
      "lingui.config.ts",
      "scripts/check-i18n.ts",
    ]) {
      await cp(join(root, file), join(directory, file));
    }
    await symlink(
      join(root, "node_modules"),
      join(directory, "node_modules"),
      "dir",
    );
  })();
  resources.tasks.defer(() => preparing);
  await preparing;
  signal.throwIfAborted();
  return {
    directory,
    run: (...args: string[]) =>
      runTestCommand([process.execPath, ...args], {
        cwd: directory,
        signal,
        tasks: resources.tasks,
      }),
  };
}

test("rejects a PO-only translation change and accepts the synchronized compiled catalog", async ({
  resources,
  signal,
}) => {
  const { directory, run } = await fixture(resources, signal);
  const po = Bun.file(join(directory, "src/i18n/locales/zh-Hans/messages.po"));
  const compiled = Bun.file(
    join(directory, "src/i18n/locales/zh-Hans/messages.ts"),
  );
  const before = await compiled.text();
  const original = await po.text();
  const changed = original.replace(
    /msgid "common\.online"\nmsgstr "([^"\n]*)"/,
    'msgid "common.online"\nmsgstr "$1（校验回归）"',
  );
  expect(changed).not.toBe(original);
  await Bun.write(po, changed);

  const drifted = await run("scripts/check-i18n.ts");
  const generated = await compiled.text();
  expect(generated).not.toBe(before);
  expect(drifted.code, drifted.output).not.toBe(0);
  expect(drifted.output).toMatch(/compiled.*catalog.*changed/i);

  const synchronized = await run("scripts/check-i18n.ts");
  expect(synchronized.code, synchronized.output).toBe(0);
  expect(await compiled.text()).toBe(generated);
}, 60_000);

test("rejects stale source translations even when extraction and strict compilation are stable", async ({
  resources,
  signal,
}) => {
  const { directory, run } = await fixture(resources, signal);
  const descriptors = Bun.file(join(directory, "src/i18n/descriptors.ts"));
  const original = await descriptors.text();
  const changed = original.replace(
    'id: "common.online", message: "Online"',
    'id: "common.online", message: "Available"',
  );
  expect(changed).not.toBe(original);
  await Bun.write(descriptors, changed);

  const files = SUPPORTED_LOCALES.flatMap((locale) =>
    ["po", "ts"].map((extension) =>
      Bun.file(
        join(directory, `src/i18n/locales/${locale}/messages.${extension}`),
      ),
    ),
  );
  const extracted = await run("run", "i18n:extract");
  expect(extracted.code, extracted.output).toBe(0);
  const initialCompile = await run("run", "i18n:compile", "--strict");
  expect(initialCompile.code, initialCompile.output).toBe(0);
  const before = await Promise.all(files.map((file) => file.text()));
  for (const args of [
    ["run", "i18n:extract"],
    ["run", "i18n:extract"],
    ["run", "i18n:compile", "--strict"],
  ]) {
    const result = await run(...args);
    expect(result.code, result.output).toBe(0);
    expect(await Promise.all(files.map((file) => file.text()))).toEqual(before);
  }

  const drifted = await run("scripts/check-i18n.ts");
  expect(drifted.code, drifted.output).not.toBe(0);
  expect(drifted.output).toContain("en-US");
  expect(drifted.output).toContain("common.online");
  expect(drifted.output).toMatch(/source.*message/i);
  expect(await Promise.all(files.map((file) => file.text()))).toEqual(before);

  const po = Bun.file(join(directory, "src/i18n/locales/en-US/messages.po"));
  await Bun.write(
    po,
    (await po.text()).replace(
      'msgid "common.online"\nmsgstr "Online"',
      'msgid "common.online"\nmsgstr "Available"',
    ),
  );
  const compiled = await run("run", "i18n:compile", "--strict");
  expect(compiled.code, compiled.output).toBe(0);
  const synchronized = await run("scripts/check-i18n.ts");
  expect(synchronized.code, synchronized.output).toBe(0);
}, 60_000);
