import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedHeadscaleFixture } from "../e2e/headscale-fixture";
import { createChildRunner } from "./harness/child-runner";
import { waitForDockerIpv6 } from "./harness/docker-network";

const root = fileURLToPath(new URL("..", import.meta.url));
const composeFile = "e2e/docker-compose.yml";
const project = `headscale-ui-e2e-${process.pid}`;
const temporary = mkdtempSync(join(tmpdir(), `${project}-`));
const compose = ["docker", "compose", "-p", project, "-f", composeFile];
const runner = createChildRunner(root);

function capture(command: string[]): string {
  const result = Bun.spawnSync({
    cmd: command,
    cwd: root,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed\n${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

async function assertPolicyFailure(
  url: string,
  apiKey: string,
  method: "GET" | "PUT",
  message: RegExp,
): Promise<void> {
  const response = await fetch(`${url}/api/v1/policy`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: method === "PUT" ? JSON.stringify({ policy: "{}" }) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const raw = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    body = undefined;
  }
  const text = typeof body === "object" && body !== null && "message" in body ? body.message : "";
  // Headscale wording drift must fail here, at the fixture, not as a confusing browser failure.
  assert.equal(
    response.status,
    500,
    `file-mode ${method} /policy must be HTTP 500, got ${response.status}: ${raw}`,
  );
  assert.match(String(text), message, `file-mode ${method} /policy message drifted: ${raw}`);
}

let cleaned = false;
function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  const result = Bun.spawnSync({
    cmd: [...compose, "down", "--volumes", "--remove-orphans"],
    cwd: root,
    env: process.env,
    stdout: "inherit",
    stderr: "inherit",
  });
  rmSync(temporary, { recursive: true, force: true });
  if (result.exitCode !== 0) {
    console.error("Docker Compose cleanup failed");
    process.exitCode = process.exitCode || result.exitCode || 1;
  }
}

let signalled: "SIGINT" | "SIGTERM" | undefined;
const signalExitCode = () => (signalled === "SIGINT" ? 130 : 143);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    signalled = signal;
    await runner.terminateActive();
    cleanup();
    process.exit(signalExitCode());
  });
}

try {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null),
  });
  process.env.HEADSCALE_E2E_PORT = String(reservation.port);
  reservation.stop(true);
  await runner.run([...compose, "up", "-d", "--wait"]);
  const networkId = capture([
    "docker",
    "network",
    "inspect",
    `${project}_default`,
    "--format",
    "{{.Id}}",
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
  const port = capture([...compose, "port", "fixture-network", "8080"])
    .split(":")
    .at(-1);
  if (!port) throw new Error("Docker Compose did not publish the Headscale port");

  const fileModePort = capture([...compose, "port", "headscale-file-mode", "8080"])
    .split(":")
    .at(-1);
  if (!fileModePort) throw new Error("Docker Compose did not publish the file-mode Headscale port");
  const fileModeUrl = `http://127.0.0.1:${fileModePort}`;
  const fileModeApiKey = capture([
    ...compose,
    "exec",
    "-T",
    "headscale-file-mode",
    "headscale",
    "apikeys",
    "create",
    "--expiration",
    "30m",
  ]);
  await assertPolicyFailure(fileModeUrl, fileModeApiKey, "GET", /^reading policy from path "":/);
  await assertPolicyFailure(
    fileModeUrl,
    fileModeApiKey,
    "PUT",
    /update is disabled for modes other than 'database'/,
  );

  const container = `${project}-headscale-1`;
  await seedHeadscaleFixture(`http://127.0.0.1:${port}`, apiKey, {
    headscale: container,
    online: `${project}-online-device-1`,
    offline: `${project}-offline-device-1`,
  });
  await runner.run(["docker", "stop", `${project}-online-device-1`, container]);
  mkdirSync(join(temporary, "headscale"));
  mkdirSync(join(temporary, "tailscale"));
  await runner.run([
    "docker",
    "cp",
    `${container}:/var/lib/headscale/.`,
    join(temporary, "headscale"),
  ]);
  await runner.run([
    "docker",
    "cp",
    `${project}-online-device-1:/var/lib/tailscale/.`,
    join(temporary, "tailscale"),
  ]);
  const blankPolicySnapshot = join(temporary, "headscale-empty-policy");
  cpSync(join(temporary, "headscale"), blankPolicySnapshot, { recursive: true });
  const database = new Database(join(blankPolicySnapshot, "db.sqlite"));
  try {
    assert.ok(
      database
        .query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'policies'")
        .get(),
      "Expected Headscale policies table in the disposable snapshot",
    );
    database.run("DELETE FROM policies");
    assert.equal(
      database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM policies").get()?.count,
      0,
    );
    database.run("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }
  Object.assign(process.env, {
    HEADSCALE_E2E_ONLINE_CONTAINER: `${project}-online-device-1`,
    HEADSCALE_E2E_CONTAINER: container,
    HEADSCALE_E2E_SNAPSHOT: temporary,
    HEADSCALE_E2E_URL: `http://127.0.0.1:${port}`,
    HEADSCALE_E2E_API_KEY: apiKey,
    HEADSCALE_E2E_COMPOSE_PROJECT: project,
    HEADSCALE_E2E_COMPOSE_FILE: composeFile,
    HEADSCALE_E2E_FILE_MODE_URL: fileModeUrl,
    HEADSCALE_E2E_FILE_MODE_API_KEY: fileModeApiKey,
  });
  const e2eEnv = {
    ...process.env,
    VITE_HEADSCALE_E2E_API_KEY: apiKey,
    VITE_HEADSCALE_E2E_FILE_MODE_API_KEY: fileModeApiKey,
  };

  await waitForDockerIpv6(networkId);
  await runner.run(
    [
      "bun",
      "run",
      "vitest",
      "run",
      "--config",
      "vitest.e2e.config.ts",
      ...process.argv.slice(2).filter((arg) => arg !== "--"),
    ],
    e2eEnv,
  );
  for (const user of ["admin-test", "team-test", "deleted-test"]) {
    const listed = capture([
      ...compose,
      "exec",
      "-T",
      "headscale",
      "headscale",
      "users",
      "list",
      "-o",
      "json",
    ]);
    if (!JSON.parse(listed).some((row: { name: string }) => row.name === user))
      await runner.run([
        ...compose,
        "exec",
        "-T",
        "headscale",
        "headscale",
        "users",
        "create",
        user,
      ]);
  }
  await runner.run([
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
  await runner.run([
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
  // Same compose project as the browser suite — do not start a second Headscale lane.
  await runner.run(
    ["bun", "run", "vitest", "run", "--config", "vitest.contract.config.ts"],
    e2eEnv,
  );
} catch (error) {
  // The stopped child makes the pending run() reject; the signal still owns the exit code.
  if (!signalled) throw error;
  cleanup();
  process.exit(signalExitCode());
} finally {
  cleanup();
}
