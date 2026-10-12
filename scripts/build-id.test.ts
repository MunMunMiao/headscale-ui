import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { computeBuildId } from "./build-id.ts";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

const files: Record<string, string> = {
  "src/main.ts": "export {};\n",
  "src/nested/view.tsx": "export const view = 1;\n",
  "public/favicon.svg": "<svg/>",
  "index.html": "<html></html>",
  "package.json": "{}",
  "bun.lock": "lock",
  "vite.config.ts": "export default {};",
  "lingui.config.ts": "export default {};",
  "tsconfig.app.json": "{}",
};

function tree(order: string[] = Object.keys(files)) {
  const root = mkdtempSync(join(tmpdir(), "headscale-build-id-"));
  temporary.push(root);
  for (const name of order) put(root, name, files[name] as string);
  return root;
}

function put(root: string, name: string, content: string) {
  mkdirSync(dirname(join(root, name)), { recursive: true });
  writeFileSync(join(root, name), content);
}

test("the id is a 32 character hex digest independent of location and creation order", () => {
  const id = computeBuildId(tree());
  expect(id).toMatch(/^[0-9a-f]{32}$/);
  expect(computeBuildId(tree())).toBe(id);
  expect(computeBuildId(tree(Object.keys(files).reverse()))).toBe(id);
  const copy = mkdtempSync(join(tmpdir(), "headscale-build-id-copy-"));
  temporary.push(copy);
  cpSync(tree(), copy, { recursive: true });
  expect(computeBuildId(copy)).toBe(id);
});

test.each([
  ["editing a source file", (root: string) => put(root, "src/main.ts", "export const a = 1;\n")],
  ["adding a source file", (root: string) => put(root, "src/extra.ts", "")],
  ["removing a source file", (root: string) => rmSync(join(root, "src/nested/view.tsx"))],
  ["changing bun.lock", (root: string) => put(root, "bun.lock", "other")],
  ["changing index.html", (root: string) => put(root, "index.html", "<html>x</html>")],
  [
    "renaming a public file",
    (root: string) => {
      rmSync(join(root, "public/favicon.svg"));
      put(root, "public/icon.svg", "<svg/>");
    },
  ],
])("%s changes the id", (_name, change) => {
  const root = tree();
  const before = computeBuildId(root);
  change(root);
  expect(computeBuildId(root)).not.toBe(before);
});

test.each([
  ["a new test file", "src/main.test.ts"],
  ["a tsx test file", "src/nested/view.test.tsx"],
  ["a hidden file", "src/.DS_Store"],
  ["a file in a hidden directory", "public/.cache/blob"],
])("%s does not change the id", (_name, path) => {
  const root = tree();
  const before = computeBuildId(root);
  put(root, path, "one");
  put(root, path, "two");
  expect(computeBuildId(root)).toBe(before);
});

test("a missing input throws instead of being dropped", () => {
  const inputs = ["src", "public", ...Object.keys(files).filter((name) => !name.includes("/"))];
  for (const name of inputs) {
    const root = tree();
    rmSync(join(root, name), { recursive: true });
    expect(() => computeBuildId(root), name).toThrow();
  }
});
