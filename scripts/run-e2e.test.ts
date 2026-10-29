import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { root } from "./harness/docker";

interface RunnerTrace {
  commands: { kind: "async" | "sync"; args: string[] }[];
  owner?: string;
  directoryExists: boolean;
}

async function invoke(args: string[], childCode = 0) {
  const temporary = mkdtempSync(join(tmpdir(), "e2e-selection-test-"));
  const script = `
import { existsSync } from "node:fs";
const trace = { commands: [] };
let directory;
Bun.spawn = (command, options) => {
  const args = Array.isArray(command) ? command : command.cmd;
  const env = (Array.isArray(command) ? options : command).env;
  trace.commands.push({ kind: "async", args });
  if (args[0] !== "bun") return { exited: Promise.resolve(91) };
  trace.owner = env.HEADSCALE_TAG_LIFECYCLE_OWNER;
  directory = env.HEADSCALE_TAG_LIFECYCLE_DIRECTORY;
  return { exited: Promise.resolve(${childCode}) };
};
Bun.spawnSync = (command) => {
  const args = Array.isArray(command) ? command : command.cmd;
  trace.commands.push({ kind: "sync", args });
  if (args[0] !== "docker" || !["container", "volume", "network"].includes(args[1]) || args[2] !== "ls")
    throw new Error("Unexpected external command in isolated runner test");
  return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
};
process.on("exit", () => {
  trace.directoryExists = Boolean(directory && existsSync(directory));
  console.log("RUNNER_TRACE=" + JSON.stringify(trace));
});
process.argv = [process.execPath, ${JSON.stringify(join(root, "scripts/run-e2e.ts"))}, ...${JSON.stringify(args)}];
await import(${JSON.stringify(join(root, "scripts/run-e2e.ts"))});
`;
  try {
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: root,
      env: { ...process.env, TMPDIR: temporary },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const traceLine = stdout
      .split("\n")
      .find((line) => line.startsWith("RUNNER_TRACE="));
    expect(traceLine, stdout + stderr).toBeDefined();
    return {
      code,
      output: stdout + stderr,
      trace: JSON.parse(
        traceLine!.slice("RUNNER_TRACE=".length),
      ) as RunnerTrace,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

test.each([
  { selector: ["--suite", "tag-lifecycle"], childCode: 0 },
  { selector: ["--suite=tag-lifecycle"], childCode: 17 },
  { selector: ["--suite", "tag-lifecycle", "--"], childCode: 0 },
])(
  "runs only the selected lifecycle suite and cleans up after child exit $childCode",
  async ({ selector, childCode }) => {
    const filters = ["-t", "G27 real inventory", "--reporter=verbose"];
    const result = await invoke([...selector, ...filters], childCode);
    if (childCode === 0) expect(result.code, result.output).toBe(0);
    else expect(result.code, result.output).not.toBe(0);
    expect(
      result.trace.commands.filter((call) => call.kind === "async"),
    ).toEqual([
      {
        kind: "async",
        args: [
          "bun",
          join(root, "node_modules/vitest/vitest.mjs"),
          "run",
          "--config",
          "vitest.tag-lifecycle.config.ts",
          ...filters,
        ],
      },
    ]);
    expect(result.trace.owner).toMatch(/^headscale-tag-lifecycle-run-/);
    const cleanup = result.trace.commands.filter(
      (call) => call.kind === "sync",
    );
    expect(cleanup.map((call) => call.args[1])).toEqual([
      "container",
      "volume",
      "network",
    ]);
    for (const call of cleanup)
      expect(call.args).toContain(
        `label=io.headscale-ui.tag-lifecycle=${result.trace.owner}`,
      );
    expect(result.trace.directoryExists).toBe(false);
  },
);

test.each([
  ["--suite", "unknown"],
  ["--suite"],
  ["--suite=main", "--suite=contract"],
  ["--suite=all", "-t", "one test"],
  ["--suite=tag-lifecycle", "--config", "other.config.ts"],
  ["--suite=tag-lifecycle", "--root", ".."],
  ["--suite=main", "--r=.."],
  ["--suite=main", "-r.."],
  ["--suite=tag-lifecycle", "--c", "other.config.ts"],
  ["--suite=tag-lifecycle", "--workspace=elsewhere"],
])(
  "rejects invalid suite selection before starting external commands: %j",
  async (...args) => {
    const result = await invoke(args);
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/suite|config|root/i);
    expect(result.trace.commands).toEqual([]);
  },
);
