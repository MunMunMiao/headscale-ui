import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const composeFile = "e2e/docker-compose.yml";
const project = `headscale-ui-e2e-${process.pid}`;
const compose = ["docker", "compose", "-p", project, "-f", composeFile];

function run(command: string[], env = process.env): void {
  const result = Bun.spawnSync({
    cmd: command,
    cwd: root,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed`);
}

function capture(command: string[]): string {
  const result = Bun.spawnSync({ cmd: command, cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed\n${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

let cleaned = false;
function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  const result = Bun.spawnSync({
    cmd: [...compose, "down", "--volumes", "--remove-orphans"],
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    console.error("Docker Compose cleanup failed");
    process.exitCode = process.exitCode || result.exitCode || 1;
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    cleanup();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

try {
  run([...compose, "up", "-d", "--wait"]);
  for (const user of ["admin-test", "team-test", "deleted-test"]) {
    run([...compose, "exec", "-T", "headscale", "headscale", "users", "create", user]);
  }
  run([
    ...compose,
    "exec",
    "-T",
    "headscale",
    "headscale",
    "policy",
    "check",
    "--file",
    "/fixtures/policy.hujson",
  ]);
  run([
    ...compose,
    "exec",
    "-T",
    "headscale",
    "headscale",
    "policy",
    "set",
    "--file",
    "/fixtures/policy.hujson",
  ]);
  run([
    ...compose,
    "exec",
    "-T",
    "headscale",
    "headscale",
    "users",
    "destroy",
    "--name",
    "deleted-test",
    "--force",
  ]);

  const apiKey = capture([
    ...compose,
    "exec",
    "-T",
    "headscale",
    "headscale",
    "apikeys",
    "create",
    "--expiration",
    "30m",
  ]);
  const port = capture([...compose, "port", "headscale", "8080"])
    .split(":")
    .at(-1);
  if (!port) throw new Error("Docker Compose did not publish the Headscale port");

  run(["bun", "scripts/check-e2e-button-coverage.ts"]);
  const e2eEnv = {
    ...process.env,
    HEADSCALE_E2E_URL: `http://127.0.0.1:${port}`,
    HEADSCALE_E2E_API_KEY: apiKey,
    VITE_HEADSCALE_E2E_API_KEY: apiKey,
    HEADSCALE_E2E_COMPOSE_PROJECT: project,
    HEADSCALE_E2E_COMPOSE_FILE: composeFile,
  };
  run(
    ["bun", "--bun", "node_modules/vitest/vitest.mjs", "--config", "vitest.e2e.config.ts", "--run"],
    e2eEnv,
  );
  // Same compose project as the browser suite — do not start a second Headscale lane.
  run(["bun", "test", "./e2e/issue-7-policy-principals.ts", "--max-concurrency", "1"], e2eEnv);
} finally {
  cleanup();
}
