import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resetHeadscaleFixture, seedHeadscaleFixture } from "../e2e/headscale-fixture";
import { waitForDockerIpv6 } from "./docker-network";

const root = fileURLToPath(new URL("..", import.meta.url));
const composeFile = "e2e/docker-compose.yml";
const project = `headscale-ui-e2e-${process.pid}`;
const temporary = mkdtempSync(join(tmpdir(), `${project}-`));
const compose = ["docker", "compose", "-p", project, "-f", composeFile];

async function checkResetRemainsResponsive(): Promise<void> {
  const realDocker = Bun.which("docker");
  assert.ok(realDocker, "Docker is required for fixture recovery");
  const probeDirectory = join(temporary, "reset-probe");
  mkdirSync(probeDirectory);
  const originalPath = process.env.PATH;
  let probes = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      probes++;
      return new Response(null, { status: 204 });
    },
  });
  try {
    const launcher = join(probeDirectory, "docker-probe.mjs");
    const expectedStop = ["stop", `${project}-online-device-1`, `${project}-headscale-1`];
    // The Docker child must receive HTTP from its parent before doing the real stop.
    // A synchronous parent deadlocks here; the deadline detects that without a sleep.
    await Bun.write(
      launcher,
      `
const args = process.argv.slice(2);
if (JSON.stringify(args) === ${JSON.stringify(JSON.stringify(expectedStop))}) {
  const response = await fetch("http://127.0.0.1:${server.port}", {
    signal: AbortSignal.timeout(2000),
  }).catch((cause) => { throw new Error("Fixture reset blocked HTTP while its Docker child was pending", { cause }); });
  if (response.status !== 204) throw new Error("Unexpected fixture reset probe response");
}
const child = Bun.spawnSync([${JSON.stringify(realDocker)}, ...args], {
  stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
process.exit(child.exitCode);
`,
    );
    const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const executable = join(probeDirectory, "docker");
    await Bun.write(
      executable,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(launcher)} "$@"\n`,
    );
    chmodSync(executable, 0o700);
    process.env.PATH = `${probeDirectory}:${originalPath ?? ""}`;
    await resetHeadscaleFixture();
    assert.equal(probes, 1, "The pending Docker stop must receive its HTTP response");
    console.log("E2E fixture responsiveness passed: HTTP remained available during reset.");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    server.stop(true);
    rmSync(probeDirectory, { recursive: true, force: true });
  }
}

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

function fixtureNetworkIdentity(container: string): string {
  // Docker can retain a namespace inode while replacing its host-side veth on restart.
  const identity = capture([
    "docker",
    "run",
    "--rm",
    "--name",
    `${project}-network-probe`,
    "--label",
    `com.docker.compose.project=${project}`,
    "--label",
    "com.docker.compose.service=fixture-network-probe",
    "--network",
    `container:${container}`,
    "--entrypoint",
    "sh",
    "tailscale/tailscale:v1.94.2",
    "-c",
    "readlink /proc/self/ns/net; cat /sys/class/net/eth0/iflink",
  ]);
  assert.match(
    identity,
    /^net:\[\d+\]\n\d+$/,
    "Expected a network namespace and host interface identity",
  );
  return identity;
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

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    cleanup();
    process.exit(signal === "SIGINT" ? 130 : 143);
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
  run([...compose, "up", "-d", "--wait"]);
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

  const container = `${project}-headscale-1`;
  await seedHeadscaleFixture(`http://127.0.0.1:${port}`, apiKey, {
    headscale: container,
    online: `${project}-online-device-1`,
    offline: `${project}-offline-device-1`,
  });
  run(["docker", "stop", `${project}-online-device-1`, container]);
  mkdirSync(join(temporary, "headscale"));
  mkdirSync(join(temporary, "tailscale"));
  run(["docker", "cp", `${container}:/var/lib/headscale/.`, join(temporary, "headscale")]);
  run([
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
    assert.equal(database.query("SELECT COUNT(*) AS count FROM policies").get().count, 0);
    database.run("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }
  run(["bun", "scripts/check-e2e-button-coverage.ts"]);
  Object.assign(process.env, {
    HEADSCALE_E2E_ONLINE_CONTAINER: `${project}-online-device-1`,
    HEADSCALE_E2E_CONTAINER: container,
    HEADSCALE_E2E_SNAPSHOT: temporary,
    HEADSCALE_E2E_URL: `http://127.0.0.1:${port}`,
    HEADSCALE_E2E_API_KEY: apiKey,
    HEADSCALE_E2E_COMPOSE_PROJECT: project,
    HEADSCALE_E2E_COMPOSE_FILE: composeFile,
  });
  const e2eEnv = { ...process.env, VITE_HEADSCALE_E2E_API_KEY: apiKey };

  // A crash can leave committed deletions in WAL; restoring must replace that database state.
  await checkResetRemainsResponsive();
  const deletedKey = await fetch(`${process.env.HEADSCALE_E2E_URL}/api/v1/preauthkey?id=1`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(deletedKey.ok, true, "The recovery check must delete fixture auth key 1");
  const keysAfterDeletion = await fetch(`${process.env.HEADSCALE_E2E_URL}/api/v1/preauthkey`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(keysAfterDeletion.ok, true, "The deleted fixture key must be verifiable");
  const { preAuthKeys } = await keysAfterDeletion.json();
  assert.deepEqual(
    preAuthKeys.map((key: { id: string }) => key.id),
    ["2", "3"],
  );
  const networkContainers = [container, `${project}-online-device-1`];
  const networkIdentities = networkContainers.map(fixtureNetworkIdentity);
  run(["docker", "kill", container]);
  await resetHeadscaleFixture();
  assert.deepEqual(
    networkContainers.map(fixtureNetworkIdentity),
    networkIdentities,
    "Fixture reset must preserve network namespaces and host interfaces used by Chrome",
  );
  console.log("E2E fixture crash recovery passed: all three auth keys restored.");
  console.log(
    "E2E fixture network stability passed: namespaces and host interfaces survived reset.",
  );

  await waitForDockerIpv6(networkId);
  run(
    [
      "bun",
      "--bun",
      "node_modules/vitest/vitest.mjs",
      "--config",
      "vitest.e2e.config.ts",
      "--run",
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
      run([...compose, "exec", "-T", "headscale", "headscale", "users", "create", user]);
  }
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
  // Same compose project as the browser suite — do not start a second Headscale lane.
  run(["bun", "test", "./e2e/issue-7-policy-principals.ts", "--max-concurrency", "1"], e2eEnv);
} finally {
  cleanup();
}
