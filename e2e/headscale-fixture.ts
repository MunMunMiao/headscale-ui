import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";

export async function seedHeadscaleFixture(
  baseUrl: string,
  apiKey: string,
  containers: { headscale: string; online: string; offline: string },
) {
  async function request(path: string, body?: unknown) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? "GET" : path === "/api/v1/policy" ? "PUT" : "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(
      response.ok,
      true,
      `Headscale fixture request failed: ${path} (${response.status})`,
    );
    return response.json();
  }
  const docker = (...args: string[]) => execFileSync("docker", args, { stdio: "pipe" });
  for (const [name, displayName, email] of [
    ["alice", "Alice Ops", "alice@example.com"],
    ["edge-owner", "", ""],
    ["charlie", "Charlie", "charlie@example.com"],
  ]) {
    await request("/api/v1/user", { name, displayName, email });
  }
  docker(
    "exec",
    containers.headscale,
    "headscale",
    "users",
    "destroy",
    "--name",
    "edge-owner",
    "--force",
  );
  await request("/api/v1/policy", {
    policy: JSON.stringify({
      acls: [{ action: "accept", src: ["*"], dst: ["*:*"] }],
      groups: { "group:ops": ["alice@example.com"] },
      tagOwners: {
        "tag:server": ["alice@example.com"],
        "tag:workstation": ["alice@example.com"],
        "tag:laptop": ["alice@example.com"],
      },
      autoApprovers: { routes: { "10.42.0.0/16": ["alice@example.com"] } },
      ssh: [{ action: "accept", src: ["group:ops"], dst: ["tag:server"], users: ["root"] }],
    }),
  });
  const expiration = new Date(Date.now() + 365 * 86_400_000).toISOString();
  await request("/api/v1/preauthkey", {
    user: "1",
    reusable: true,
    expiration,
    aclTags: ["tag:server"],
  });
  const oneTimeKey = await request("/api/v1/preauthkey", {
    user: "3",
    ephemeral: true,
    expiration,
  });
  const loginKey = await request("/api/v1/preauthkey", { user: "1", expiration });
  function registerDevice(container: string, key: string, hostname: string, routes = "") {
    execFileSync(
      "docker",
      [
        "exec",
        "-i",
        container,
        "sh",
        "-c",
        'read -r key; exec tailscale up --auth-key="$key" --login-server=http://headscale:8080 --hostname="$1" --advertise-routes="$2" --accept-dns=false --timeout=30s',
        "sh",
        hostname,
        routes,
      ],
      { input: `${key}\n`, stdio: ["pipe", "pipe", "pipe"] },
    );
  }
  registerDevice(containers.online, loginKey.preAuthKey.key, "alice-laptop");
  const registrationKey = "abcdefghijklmnopqrstuvw0";
  await request("/api/v1/debug/node", {
    user: "alice",
    name: "edge-router",
    routes: ["10.42.0.0/16", "0.0.0.0/0", "::/0"],
    key: registrationKey,
  });
  await request(`/api/v1/node/register?user=alice&key=${registrationKey}`, {});
  registerDevice(containers.offline, oneTimeKey.preAuthKey.key, "old-phone", "192.168.88.0/24");
  // An abrupt disconnect retains the ephemeral registration until Headscale's inactivity timeout.
  docker("kill", containers.offline);
  await request("/api/v1/preauthkey/expire", { id: "2" });
  await request("/api/v1/node/2/tags", { tags: ["tag:server"] });
  await request("/api/v1/node/2/approve_routes", { routes: ["10.42.0.0/16"] });
  docker(
    "exec",
    containers.headscale,
    "headscale",
    "nodes",
    "expire",
    "--identifier",
    "2",
    "--expiry",
    expiration,
  );
  await request("/api/v1/node/3/expire", {});
  await request("/api/v1/apikey", { expiration });
  await request("/api/v1/apikey", { expiration });
  const { users } = await request("/api/v1/user");
  assert.deepEqual(
    users.map((user: { name: string }) => user.name),
    ["alice", "charlie"],
  );
  const { preAuthKeys } = await request("/api/v1/preauthkey");
  assert.equal(
    preAuthKeys.find((key: { id: string }) => key.id === "2").used,
    true,
    "The expired ephemeral invitation must have been used by a real device",
  );
  let { nodes } = await request("/api/v1/node");
  for (let attempt = 0; attempt < 100 && (!nodes[0]?.online || nodes[2]?.online); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    ({ nodes } = await request("/api/v1/node"));
  }
  assert.deepEqual(
    nodes.map((node: { id: string }) => node.id),
    ["1", "2", "3"],
  );
  assert.deepEqual(
    preAuthKeys.map((key: { id: string }) => key.id),
    ["1", "2", "3"],
  );
  assert.equal(preAuthKeys[0].reusable, true);
  assert.equal(preAuthKeys[1].ephemeral, true);
  assert.ok(Date.parse(preAuthKeys[1].expiration) <= Date.now());
  assert.equal(nodes[0].online, true);
  assert.equal(nodes[0].user.name, "alice");
  assert.equal(nodes[1].online, false);
  assert.equal(nodes[1].user.name, "tagged-devices");
  assert.ok(Date.parse(nodes[1].expiry) > Date.now(), "The offline router must not be expired");
  assert.ok(nodes[1].availableRoutes.includes("0.0.0.0/0"));
  assert.equal(nodes[2].online, false);
  assert.equal(nodes[2].user.name, "charlie");
  assert.ok(nodes[2].availableRoutes.includes("192.168.88.0/24"));
  assert.ok(Date.parse(nodes[2].expiry) <= Date.now());
}

// Restore only the disposable Compose container owned by this runner; every browser test
// starts from real persisted Headscale data, including its original API key and stable IDs.
export async function resetHeadscaleFixture(blankPolicy = false) {
  const container = process.env.HEADSCALE_E2E_CONTAINER;
  const snapshot = process.env.HEADSCALE_E2E_SNAPSHOT;
  const onlineContainer = process.env.HEADSCALE_E2E_ONLINE_CONTAINER;
  const project = container?.match(/^(headscale-ui-e2e-\d+)-headscale-1$/)?.[1];
  assert.ok(project, "Expected a runner-owned Headscale container");
  assert.equal(project, process.env.HEADSCALE_E2E_COMPOSE_PROJECT);
  assert.equal(onlineContainer, `${project}-online-device-1`);
  assert.ok(snapshot?.includes(`${project}-`));
  const source = `${snapshot}/${blankPolicy ? "headscale-empty-policy" : "headscale"}`;
  assert.ok(statSync(`${source}/db.sqlite`).isFile(), "Expected a complete database snapshot");
  const execute = promisify(execFile);
  const docker = async (...args: string[]) => {
    const { stdout } = await execute("docker", args, { encoding: "buffer" });
    return stdout;
  };
  assert.equal(
    (
      await docker(
        "inspect",
        "--format",
        '{{index .Config.Labels "com.docker.compose.project"}}',
        container as string,
      )
    )
      .toString()
      .trim(),
    project,
  );
  await docker("stop", onlineContainer as string, container as string);
  assert.equal(
    (await docker("inspect", "--format", "{{.State.Running}}", container as string))
      .toString()
      .trim(),
    "false",
  );
  // Directory copies merge files: stale WAL pages must not replay over the restored database.
  await docker(
    "run",
    "--rm",
    "--network",
    "none",
    "--name",
    `${project}-restore-data`,
    "--label",
    `com.docker.compose.project=${project}`,
    "--label",
    "com.docker.compose.service=fixture-restore",
    "--volumes-from",
    container as string,
    "--entrypoint",
    "rm",
    "tailscale/tailscale:v1.94.2",
    "-f",
    "/var/lib/headscale/db.sqlite-wal",
    "/var/lib/headscale/db.sqlite-shm",
  );
  await docker("cp", `${source}/.`, `${container}:/var/lib/headscale`);
  await docker("cp", `${snapshot}/tailscale/.`, `${onlineContainer}:/var/lib/tailscale`);
  await docker("start", container as string);
  let healthy = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await docker("exec", container as string, "headscale", "health");
      healthy = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.ok(healthy, "Headscale fixture did not become healthy after reset");
  // shortcut: Headscale 0.28 omits expiry persistence; replay until the test image fixes it.
  for (const [id, expiry] of [
    ["2", new Date(Date.now() + 365 * 86_400_000).toISOString()],
    ["3", new Date(Date.now() - 60_000).toISOString()],
  ]) {
    await docker(
      "exec",
      container as string,
      "headscale",
      "nodes",
      "expire",
      "--identifier",
      id,
      "--expiry",
      expiry,
    );
  }
  await docker("start", onlineContainer as string);
  for (let attempt = 0; attempt < 100; attempt++) {
    const nodes = JSON.parse(
      (
        await docker("exec", container as string, "headscale", "nodes", "list", "-o", "json")
      ).toString(),
    );
    if (nodes.find((node: { id: number; online: boolean }) => Number(node.id) === 1)?.online) {
      const router = nodes.find((node: { id: number }) => Number(node.id) === 2);
      const phone = nodes.find((node: { id: number }) => Number(node.id) === 3);
      assert.equal(Boolean(router.online), false);
      assert.ok(Number(router.expiry.seconds) * 1000 > Date.now());
      assert.equal(Boolean(phone.online), false);
      assert.ok(Number(phone.expiry.seconds) * 1000 <= Date.now());
      const keysResponse = await fetch(`${process.env.HEADSCALE_E2E_URL}/api/v1/preauthkey`, {
        headers: { Authorization: `Bearer ${process.env.HEADSCALE_E2E_API_KEY}` },
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(keysResponse.ok, true, "The restored auth-key fixture must be readable");
      const { preAuthKeys } = await keysResponse.json();
      assert.deepEqual(
        preAuthKeys.map((key: { id: string }) => key.id),
        ["1", "2", "3"],
        "The restored auth-key fixture must contain its three original keys",
      );
      if (blankPolicy) {
        const response = await fetch(`${process.env.HEADSCALE_E2E_URL}/api/v1/policy`, {
          headers: { Authorization: `Bearer ${process.env.HEADSCALE_E2E_API_KEY}` },
          signal: AbortSignal.timeout(10_000),
        });
        assert.equal(response.ok, false, "The blank fixture must have no persisted policy");
        const error = await response.json();
        assert.match(error.message, /acl policy not found/i);
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Real fixture laptop did not reconnect");
}
