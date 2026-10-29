import { parseCLI } from "vitest/node";

const allSuites = ["main", "tag-lifecycle", "contract"] as const;
type E2eSuite = (typeof allSuites)[number];

export function selectE2eSuites(argv: readonly string[]): {
  suites: E2eSuite[];
  vitestArgs: string[];
} {
  const args = argv.filter((arg) => arg !== "--");
  let suite: E2eSuite | "all" | undefined;
  const vitestArgs: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--suite" || arg.startsWith("--suite=")) {
      if (suite !== undefined) throw new Error("Specify --suite only once");
      const value =
        arg === "--suite" ? args[++index] : arg.slice("--suite=".length);
      if (value !== "all" && !allSuites.includes(value as E2eSuite))
        throw new Error("--suite must be main, tag-lifecycle, contract or all");
      suite = value as E2eSuite | "all";
    } else vitestArgs.push(arg);
  }
  if (suite === "all" && vitestArgs.length)
    throw new Error("Vitest filters require a single --suite");
  // 由 Vitest 解析别名，避免遗漏双横线别名或紧凑短参数。
  const { options } = parseCLI(["vitest", "run", ...vitestArgs]);
  if (
    options.config !== undefined ||
    options.root !== undefined ||
    ("workspace" in options && options.workspace !== undefined)
  )
    throw new Error(
      "Use --suite instead of overriding Vitest config, root or workspace",
    );
  return {
    suites:
      suite && suite !== "all"
        ? [suite]
        : vitestArgs.length
          ? ["main"]
          : [...allSuites],
    vitestArgs,
  };
}
