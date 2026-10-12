import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../..", import.meta.url));

export function docker(...args: string[]): string {
  const result = Bun.spawnSync(["docker", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  assert.equal(result.exitCode, 0, `docker ${args.join(" ")}\n${result.stderr}`);
  return `${result.stdout}${args[0] === "logs" ? result.stderr : ""}`.trim();
}

/** Runs `cleanup` and exits with the conventional signal status when the harness is interrupted. */
export function exitOnSignal(cleanup: () => Promise<void>) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      await cleanup();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

/**
 * Builds an idempotent cleanup that runs every step even when one throws, failing the process
 * instead of hiding the error, and that also runs on SIGINT and SIGTERM.
 */
export function createCleanup(label: string, steps: (() => unknown)[]) {
  let done = false;
  const cleanup = async () => {
    if (done) return;
    done = true;
    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        console.error(`${label} cleanup failed:`, error);
        process.exitCode = 1;
      }
    }
  };
  exitOnSignal(cleanup);
  return cleanup;
}

export async function waitForHeadscale(container: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = Bun.spawnSync(["docker", "exec", container, "headscale", "health"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode === 0) return;
    await Bun.sleep(200);
  }
  throw new Error(`Headscale ${container} did not become healthy`);
}

/** Starts a disposable Headscale with the E2E config and returns a short-lived API key for it. */
export async function startHeadscale(
  name: string,
  { network, user, volume }: { network: string; user: string; volume?: string },
): Promise<string> {
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--network",
    network,
    "-v",
    `${root}/e2e/headscale-config.yaml:/etc/headscale/config.yaml:ro`,
    "-v",
    `${root}/e2e/headscale-derp.yaml:/etc/headscale/derp.yaml:ro`,
    ...(volume ? ["-v", `${volume}:/var/lib/headscale`] : []),
    "headscale/headscale:0.29.4",
    "serve",
  );
  await waitForHeadscale(name);
  docker("exec", name, "headscale", "users", "create", user);
  const apiKey = docker("exec", name, "headscale", "apikeys", "create", "--expiration", "30m");
  assert.ok(apiKey, `Headscale ${name} API key creation failed`);
  return apiKey;
}
