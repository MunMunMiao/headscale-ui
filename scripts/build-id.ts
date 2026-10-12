import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const INPUTS = [
  "src",
  "public",
  "index.html",
  "package.json",
  "bun.lock",
  "vite.config.ts",
  "lingui.config.ts",
  "tsconfig.app.json",
];

const ignored = (name: string) => name.startsWith(".") || /\.test\.(?:ts|tsx|js|jsx)$/.test(name);

/** Deterministic content hash of every build input; a missing input throws. */
export function computeBuildId(root: string): string {
  const paths: string[] = [];
  for (const input of INPUTS) {
    if (!statSync(join(root, input)).isDirectory()) {
      paths.push(input);
      continue;
    }
    for (const entry of readdirSync(join(root, input), { recursive: true })) {
      const relative = String(entry).split("\\").join("/");
      // A hidden directory hides everything below it.
      if (relative.split("/").some((part) => part.startsWith(".")) || ignored(basename(relative)))
        continue;
      if (statSync(join(root, input, relative)).isFile()) paths.push(`${input}/${relative}`);
    }
  }
  const hash = createHash("sha256");
  for (const path of paths.sort()) {
    const bytes = readFileSync(join(root, path));
    hash.update(`${path}\0${bytes.length}\0`).update(bytes);
  }
  return hash.digest("hex").slice(0, 32);
}
