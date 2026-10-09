import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePolicy, removeRuleById, serializePolicy } from "../src/domain/policy-designer";

const root = fileURLToPath(new URL("..", import.meta.url));
const owned = `headscale-policy-traffic-${process.pid}-${Date.now()}`;
const temporary = mkdtempSync(join(tmpdir(), `${owned}-`));
const headscale = `${owned}-control`;
const clients = ["allowed", "other", "target"].map((name) => `${owned}-${name}`);
const [allowed, other, target] = clients as [string, string, string];
const containers: string[] = [];
const marker = `${owned}-http-ok`;
const ports = [18080, 18081];
const tailscaleImage = "tailscale/tailscale:v1.94.2";
const curlImage = "curlimages/curl:8.12.1";
let networkCreated = false;
let cleaned = false;

async function command(args: string[], input?: string) {
  const child = Bun.spawn(["docker", ...args], {
    cwd: root,
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 180_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout: stdout.trim(), stderr: stderr.trim(), code };
  } finally {
    clearTimeout(timer);
  }
}

async function docker(...args: string[]) {
  const result = await command(args);
  assert.equal(result.code, 0, `docker ${args.join(" ")}\n${result.stderr}`);
  return result.stdout;
}

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const name of [...containers].reverse()) {
    const result = await command(["rm", "-f", "-v", name]);
    if (result.code !== 0 && !result.stderr.includes("No such container")) {
      console.error(`Failed to remove ${name}: ${result.stderr}`);
      process.exitCode = 1;
    }
  }
  if (networkCreated) {
    const result = await command(["network", "rm", owned]);
    if (result.code !== 0) {
      console.error(`Failed to remove test network: ${result.stderr}`);
      process.exitCode = 1;
    }
  }
  rmSync(temporary, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await cleanup();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

async function start(name: string, args: string[]) {
  containers.push(name);
  await docker("run", "-d", "--name", name, ...args);
}

async function waitFor(label: string, check: () => Promise<boolean>) {
  const deadline = Date.now() + 45_000;
  do {
    if (await check()) return;
    await Bun.sleep(300);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

async function health() {
  await waitFor(
    "Headscale health",
    async () => (await command(["exec", headscale, "headscale", "health"])).code === 0,
  );
}

async function connected(name: string) {
  await waitFor(`${name} to connect`, async () => {
    const result = await command(["exec", name, "tailscale", "status", "--json"]);
    if (result.code !== 0) return false;
    const status = JSON.parse(result.stdout);
    return status.BackendState === "Running" && status.TailscaleIPs?.length > 0;
  });
}

async function setPolicy(policy: Record<string, unknown>) {
  writeFileSync(join(temporary, "policy.json"), JSON.stringify(policy), { mode: 0o600 });
  await docker("exec", headscale, "headscale", "policy", "set", "--file", "/fixtures/policy.json");
  const saved = JSON.parse(await docker("exec", headscale, "headscale", "policy", "get"));
  assert.deepEqual(saved, policy, "Headscale must persist exactly the generated policy");
}

async function serviceHealthy() {
  for (const port of ports) {
    assert.equal(
      await docker("exec", target, "wget", "-qO-", `http://127.0.0.1:${port}`),
      marker,
      `HTTP service ${port} must be healthy independently of ACLs`,
    );
  }
}

async function probe(source: string, ip: string, port: number) {
  // A fresh curl process creates a new TCP flow; ICMP/TSMP ping does not prove ACL enforcement.
  return command([
    "exec",
    `${source}-curl`,
    "curl",
    "--silent",
    "--show-error",
    "--fail",
    "--noproxy",
    "",
    "--socks5-hostname",
    "127.0.0.1:1055",
    "--connect-timeout",
    "2",
    "--max-time",
    "3",
    `http://${ip}:${port}/?probe=${crypto.randomUUID()}`,
  ]);
}

async function expectTraffic(label: string, ip: string, expected: boolean[][]) {
  await serviceHealthy();
  await waitFor(`${label}: all clients connected to Headscale`, async () => {
    const nodes = JSON.parse(
      await docker("exec", headscale, "headscale", "nodes", "list", "--output", "json"),
    );
    return nodes.length === 3 && nodes.every((node: { online: boolean }) => node.online);
  });
  for (const [sourceIndex, source] of [allowed, other].entries()) {
    await docker(
      "exec",
      `${source}-curl`,
      "curl",
      "--silent",
      "--show-error",
      "--fail",
      "--cacert",
      "/fixtures/control.crt",
      "--noproxy",
      "",
      "--socks5-hostname",
      "127.0.0.1:1055",
      "--max-time",
      "3",
      "https://control/health",
    );
    let peerVisible = false;
    await waitFor(`${label}: ${source} peer path`, async () => {
      const status = JSON.parse(await docker("exec", source, "tailscale", "status", "--json"));
      assert.equal(status.BackendState, "Running");
      peerVisible = Object.values(status.Peer ?? {}).some((peer) =>
        (peer as { TailscaleIPs: string[] }).TailscaleIPs.includes(ip),
      );
      if (!peerVisible) return expected[sourceIndex]?.every((reachable) => !reachable) === true;
      // TSMP is only a WireGuard health control; the fresh HTTP flows below assert ACL access.
      const ping = await command([
        "exec",
        source,
        "tailscale",
        "ping",
        "--tsmp",
        "--c=1",
        "--timeout=2s",
        ip,
      ]);
      return ping.code === 0 && ping.stdout.includes("pong");
    });
    console.log(
      `CONTROL ${label}: source ${sourceIndex}, SOCKS/TLS healthy, ${peerVisible ? "WireGuard TSMP healthy" : "target peer removed by ACL"}`,
    );
    for (const [portIndex, port] of ports.entries()) {
      const reachable = expected[sourceIndex]?.[portIndex];
      assert.notEqual(reachable, undefined);
      let last = { stdout: "", stderr: "", code: 0 };
      await waitFor(
        `${label}: ${sourceIndex}/${port} ${reachable ? "allowed" : "blocked"}`,
        async () => {
          last = await probe(source, ip, port);
          return reachable
            ? last.code === 0 && last.stdout === marker
            : last.code === 28 || last.code === 97;
        },
      );
      if (!reachable) {
        for (let repeat = 0; repeat < 2; repeat++) {
          last = await probe(source, ip, port);
          assert.ok(
            last.code === 28 || last.code === 97,
            `${label}: blocked TCP flow unexpectedly succeeded or failed for another reason: ${last.code} ${last.stderr}`,
          );
          assert.equal(last.stdout, "");
        }
      }
    }
  }
  console.log(`PASS ${label}: allowed=[${expected[0]}], other=[${expected[1]}] (ports ${ports})`);
}

try {
  console.log("Starting isolated Headscale 0.28.0 / Tailscale 1.94.2 TCP policy lifecycle");
  await docker("info", "--format", "{{.ServerVersion}}");
  for (const image of ["headscale/headscale:0.28.0", tailscaleImage, curlImage, "busybox:1.37.0"]) {
    if ((await command(["image", "inspect", image])).code !== 0) await docker("pull", image);
  }
  await docker("network", "create", "--internal", owned);
  networkCreated = true;
  const certificate = Bun.spawnSync(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=control",
      "-addext",
      "subjectAltName=DNS:control",
      "-keyout",
      join(temporary, "control.key"),
      "-out",
      join(temporary, "control.crt"),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  assert.equal(certificate.exitCode, 0, `Could not create test certificate: ${certificate.stderr}`);
  await start(headscale, [
    "--network",
    owned,
    "--network-alias",
    "control",
    "-v",
    `${root}/e2e/policy-traffic-config.yaml:/etc/headscale/config.yaml:ro`,
    "-v",
    `${temporary}:/fixtures:ro`,
    "headscale/headscale:0.28.0",
    "serve",
  ]);
  await health();
  for (const [index, name] of clients.entries()) {
    const user = JSON.parse(
      await docker(
        "exec",
        headscale,
        "headscale",
        "users",
        "create",
        `traffic-${index}`,
        "--output",
        "json",
      ),
    );
    const key = JSON.parse(
      await docker(
        "exec",
        headscale,
        "headscale",
        "preauthkeys",
        "create",
        "--user",
        String(user.id),
        "--expiration",
        "30m",
        "--output",
        "json",
      ),
    ).key;
    assert.equal(typeof key, "string");
    await start(name, [
      "--network",
      owned,
      "--hostname",
      `traffic-${index}`,
      "-e",
      "TS_NO_LOGS_NO_SUPPORT=true",
      "-e",
      "SSL_CERT_FILE=/fixtures/control.crt",
      "-v",
      `${temporary}/control.crt:/fixtures/control.crt:ro`,
      "--entrypoint",
      "tailscaled",
      tailscaleImage,
      "--tun=userspace-networking",
      "--socks5-server=127.0.0.1:1055",
      "--state=/tmp/tailscaled.state",
    ]);
    await waitFor(
      `${name} local daemon`,
      async () => (await command(["exec", name, "tailscale", "status", "--json"])).code === 0,
    );
    const login = await command(
      [
        "exec",
        "-i",
        name,
        "sh",
        "-c",
        'read -r key; exec tailscale up --auth-key="$key" --login-server=https://control --accept-dns=false --timeout=30s',
      ],
      `${key}\n`,
    );
    assert.equal(
      login.code,
      0,
      `Tailscale registration failed: ${login.stderr.replaceAll(key, "[redacted]")}`,
    );
    await connected(name);
  }
  writeFileSync(join(temporary, "index.html"), marker);
  await start(`${owned}-http`, [
    "--network",
    `container:${target}`,
    "-v",
    `${temporary}/index.html:/www/index.html:ro`,
    "busybox:1.37.0",
    "sh",
    "-c",
    "httpd -p 18080 -h /www; exec httpd -f -p 18081 -h /www",
  ]);
  for (const source of [allowed, other]) {
    await start(`${source}-curl`, [
      "--network",
      `container:${source}`,
      "-v",
      `${temporary}/control.crt:/fixtures/control.crt:ro`,
      "--entrypoint",
      "sh",
      curlImage,
      "-c",
      "exec sleep 86400",
    ]);
  }
  const ip = await docker("exec", target, "tailscale", "ip", "-4");
  assert.match(ip, /^100\.\d+\.\d+\.\d+$/);
  await expectTraffic("no policy defaults to allow all", ip, [
    [true, true],
    [true, true],
  ]);
  await setPolicy(serializePolicy(parsePolicy("{}")));
  await expectTraffic("designer round-trip preserves default allow", ip, [
    [true, true],
    [true, true],
  ]);
  const restricted = parsePolicy(
    JSON.stringify({ acls: [{ action: "accept", src: ["traffic-0@"], dst: [`${ip}:18080`] }] }),
  );
  await setPolicy(serializePolicy(restricted));
  await expectTraffic("restricted source and port", ip, [
    [true, false],
    [false, false],
  ]);
  const rule = restricted.rules[0];
  assert.ok(rule, "Restricted fixture must contain the rule to delete");
  const denied = serializePolicy(removeRuleById(restricted, rule.id));
  assert.deepEqual(denied.acls, [], "Deleting the last rule must emit an explicit empty ACL");
  await setPolicy(denied);
  await expectTraffic("delete final rule denies all", ip, [
    [false, false],
    [false, false],
  ]);
  await docker("restart", headscale);
  await health();
  for (const client of clients) await connected(client);
  assert.deepEqual(
    JSON.parse(await docker("exec", headscale, "headscale", "policy", "get")),
    denied,
  );
  await expectTraffic("deny all survives Headscale restart", ip, [
    [false, false],
    [false, false],
  ]);
  await setPolicy(serializePolicy(restricted));
  await expectTraffic("restore restricted rule", ip, [
    [true, false],
    [false, false],
  ]);
  await setPolicy(serializePolicy(parsePolicy("{}")));
  await expectTraffic("restore full access", ip, [
    [true, true],
    [true, true],
  ]);
  console.log("PASS policy TCP lifecycle (real WireGuard peers and HTTP responses)");
} finally {
  await cleanup();
}
