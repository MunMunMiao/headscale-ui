import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../..", import.meta.url));

export function docker(...args: string[]): string {
  const result = Bun.spawnSync(["docker", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  assert.equal(
    result.exitCode,
    0,
    `docker ${args.join(" ")}\n${result.stderr}`,
  );
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
  let pending: Promise<void> | undefined;
  const cleanup = () => {
    pending ??= Promise.resolve().then(async () => {
      for (const step of steps) {
        try {
          await step();
        } catch (error) {
          console.error(`${label} cleanup failed:`, error);
          process.exitCode = 1;
        }
      }
    });
    return pending;
  };
  exitOnSignal(cleanup);
  return cleanup;
}

/** Keeps at most 8K characters, omitting credential-bearing lines and any truncated first line. */
export function diagnosticTail(
  output: string,
  secrets: readonly string[] = [],
): string {
  for (const secret of secrets) {
    if (secret) output = output.replaceAll(secret, "<redacted>");
  }
  const tail =
    output.length > 8192
      ? output.slice(-8192).replace(/^[^\n]*(?:\n|$)/, "")
      : output;
  return tail
    .split("\n")
    .map((line) =>
      /authorization|cookie|(?:api|auth|preauth)[-_ ]?key|password|secret|token|bearer|https?:\/\/[^/\s]*@|tskey-|\b[a-zA-Z0-9]{7}\.[a-zA-Z0-9_-]{32,}/i.test(
        line,
      )
        ? "<redacted>"
        : line,
    )
    .join("\n")
    .slice(-8192);
}

/** Diagnostic reads must neither hang cleanup nor replace the startup failure. */
export function containerLogs(
  container: string,
  secrets: readonly string[] = [],
): string {
  try {
    const result = Bun.spawnSync(
      ["docker", "logs", "--tail", "60", container],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 2000,
        maxBuffer: 65536,
        killSignal: "SIGKILL",
      },
    );
    if (result.exitCode === 0)
      return diagnosticTail(`${result.stdout}\n${result.stderr}`, secrets);
  } catch {
    // Keep the original startup error; even Docker itself may be unavailable.
  }
  return "Container logs unavailable";
}

export async function waitForHeadscale(container: string) {
  let health = "Health output unavailable";
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = Bun.spawnSync(
        ["docker", "exec", container, "headscale", "health"],
        {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 2000,
          maxBuffer: 65536,
          killSignal: "SIGKILL",
        },
      );
      if (result.exitCode === 0) return;
      health = diagnosticTail(`${result.stdout}\n${result.stderr}`);
      await Bun.sleep(200);
    }
    throw new Error(`Headscale ${container} did not become healthy`);
  } catch (error) {
    try {
      console.error(
        `Headscale ${container} health:\n${health}\n${containerLogs(container)}`,
      );
    } catch {
      // Diagnostics are best effort; preserve the original failure.
    }
    throw error;
  }
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
    "headscale/headscale:0.29.6",
    "serve",
  );
  await waitForHeadscale(name);
  docker("exec", name, "headscale", "users", "create", user);
  const apiKey = docker(
    "exec",
    name,
    "headscale",
    "apikeys",
    "create",
    "--expiration",
    "30m",
  );
  assert.ok(apiKey, `Headscale ${name} API key creation failed`);
  return apiKey;
}
