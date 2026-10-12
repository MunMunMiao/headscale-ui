import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { SUPPORTED_LOCALES } from "../src/i18n/locales";

const project = resolve(import.meta.dirname, "..");
const workspaces: string[] = [];
async function workspace() {
  const cwd = await mkdtemp(resolve(tmpdir(), "headscale-i18n-"));
  workspaces.push(cwd);
  await symlink(resolve(project, "node_modules"), resolve(cwd, "node_modules"));
  await Bun.write(
    resolve(cwd, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: {
        "i18n:extract": `bun run ${resolve(project, "node_modules/@lingui/cli/dist/lingui.js")} extract --workers 1`,
        "i18n:compile": `bun run ${resolve(project, "node_modules/@lingui/cli/dist/lingui.js")} compile --typescript --workers 1`,
      },
    }),
  );
  await Bun.write(
    resolve(cwd, "lingui.config.ts"),
    `import { formatter } from '@lingui/format-po';
export default {locales:${JSON.stringify(SUPPORTED_LOCALES)},sourceLocale:'en-US',fallbackLocales:false,format:formatter({explicitIdAsDefault:true,lineNumbers:false}),catalogs:[{path:'catalogs/{locale}/messages',include:['src']}]};`,
  );
  await Bun.write(
    resolve(cwd, "src/messages.ts"),
    `import {msg} from '@lingui/core/macro'; export const messages={title:msg({id:'common.title',message:'Title'})};`,
  );
  for (const locale of SUPPORTED_LOCALES) {
    const path = resolve(cwd, `catalogs/${locale}/messages.po`);
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(
      path,
      `msgid ""\nmsgstr ""\n"Language: ${locale}\\n"\n\nmsgid "common.title"\nmsgstr "Title"\n`,
    );
  }
  const child = Bun.spawn([process.execPath, "run", "i18n:extract"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(await child.exited).toBe(0);
  return cwd;
}
async function run(cwd: string) {
  const child = Bun.spawn([process.execPath, "run", resolve(project, "scripts/check-i18n.ts")], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, output: stdout + stderr };
}
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((cwd) => rm(cwd, { recursive: true, force: true })));
});

describe("i18n integrity command", () => {
  test("accepts complete catalogs and proves extraction is stable without Git", {
    timeout: 60_000,
  }, async () => {
    const cwd = await workspace();
    const result = await run(cwd);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("11 locales");
  });
  test("rejects a missing localized message", { timeout: 60_000 }, async () => {
    const cwd = await workspace();
    const path = resolve(cwd, "catalogs/ar/messages.po");
    await Bun.write(path, (await Bun.file(path).text()).replace('msgstr "Title"', 'msgstr ""'));
    const result = await run(cwd);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("ar: missing translation common.title");
  });
  test("rejects a changed source descriptor even when all committed translations exist", {
    timeout: 60_000,
  }, async () => {
    const cwd = await workspace();
    await Bun.write(
      resolve(cwd, "src/messages.ts"),
      `import {msg} from '@lingui/core/macro';export const message=msg({id:'common.another',message:'Another'});`,
    );
    const result = await run(cwd);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Catalogs changed during extraction");
  });
});
