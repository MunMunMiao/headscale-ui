import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTagLifecycleFixture,
  createTagLifecycleRunner,
  type TagLifecycleFixture,
} from "../../scripts/harness/tag-lifecycle";
import { createChildRunner } from "../../scripts/harness/child-runner";
import { waitUntil } from "../../scripts/harness/wait-until";

// Characterization only: real SSH decisions use the normal API, not the browser UI.
// Run: bun reports/residual-followup-2026-10-26/g18-ssh-probe.ts
const output = join(dirname(fileURLToPath(import.meta.url)), "g18-ssh-results.json");
const marker = "G18_SSH_SHELL_MARKER";
const command = `printf '%s\\n' '${marker}'`;
const image = "tailscale/tailscale:v1.102.5";
const label = "io.headscale-ui.g18";
const fixtureLabel = "io.headscale-ui.tag-lifecycle";
const socket = "/tmp/g18-tailscaled.sock";
const dockerPath = Bun.which("docker");
assert.ok(dockerPath && /^\/[\w/.-]+$/.test(dockerPath));
const processes = new Set<ReturnType<typeof Bun.spawn>>();
const containers = new Set<string>();
const secrets: string[] = [];
const report: Record<string, unknown> & { events: unknown[] } = {
  startedAt: new Date().toISOString(),
  status: "running",
  scope: "Disposable SSH fixture; normal approval API; not a UI rerun or a historical syscall trace",
  marker,
  deadlinesMs: { wholeRun: 240_000, ssh: 45_000, pendingCheck: 18_000 },
  events: [],
};
let fixture: TagLifecycleFixture | undefined;
let owner = "";
let cleanupPromise: Promise<void> | undefined;
let aborting = false;

function redact(text: string) {
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, "<redacted>");
  return text
    .replace(/https?:\/\/[^\s"']*hskey-authreq-[\w-]+/g, "<redacted-check-url>")
    .replace(/hskey-(?:authreq|auth|api)-[\w-]+/g, "<redacted-key>");
}
function record(phase: string, evidence: unknown) {
  const event = JSON.parse(redact(JSON.stringify({ at: new Date().toISOString(), phase, evidence })));
  report.events.push(event);
  console.log(JSON.stringify(event));
}
function save() {
  writeFileSync(output, `${redact(JSON.stringify(report, null, 2))}\n`, { mode: 0o600 });
  chmodSync(output, 0o600);
}
async function run(args: string[], input?: string, timeout = 12_000) {
  const child = Bun.spawn(args, {
    stdin: input === undefined ? "ignore" : Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
    timeout,
    killSignal: "SIGKILL",
  });
  processes.add(child);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { stdout, stderr, code };
  } finally {
    processes.delete(child);
  }
}
async function docker(...args: string[]) {
  const result = await run([dockerPath!, ...args]);
  assert.equal(result.code, 0, redact(`Docker ${args[0]} failed: ${result.stderr}`));
  return `${result.stdout}${args[0] === "logs" ? result.stderr : ""}`.trim();
}
async function own(name: string) {
  assert.ok(containers.has(name), "Only this run's SSH containers may be changed");
  assert.equal(await docker("inspect", "--format", `{{index .Config.Labels "${label}"}}`, name), owner);
}
async function exec(name: string, args: string[], input?: string) {
  await own(name);
  return run([dockerPath!, "exec", ...(input === undefined ? [] : ["-i"]), name, ...args], input, 25_000);
}
async function cleanup() {
  cleanupPromise ??= (async () => {
    const failures: string[] = [];
    for (const child of processes) child.kill();
    await Promise.all([...processes].map((child) => child.exited));
    for (const name of [...containers].reverse()) {
      try {
        const exists = await run([dockerPath!, "inspect", "--format", `{{index .Config.Labels "${label}"}}`, name]);
        if (exists.code !== 0) continue;
        assert.equal(exists.stdout.trim(), owner, "Refusing cleanup of a differently owned container");
        await docker("rm", "-fv", name);
      } catch (error) { failures.push(redact(String(error))); }
    }
    try { await fixture?.close(); } catch (error) { failures.push(redact(String(error))); }
    const remaining = fixture ? {
      sshContainers: await docker("ps", "-a", "--filter", `label=${label}=${owner}`, "--format", "{{.Names}}"),
      fixtureContainers: await docker("ps", "-a", "--filter", `label=${fixtureLabel}=${owner}`, "--format", "{{.Names}}"),
      fixtureNetworks: await docker("network", "ls", "--filter", `label=${fixtureLabel}=${owner}`, "--format", "{{.Name}}"),
      fixtureVolumes: await docker("volume", "ls", "--filter", `label=${fixtureLabel}=${owner}`, "--format", "{{.Name}}"),
    } : {};
    record("cleanup", { remaining, failures });
    assert.equal(failures.length, 0, "Owned resource cleanup failed");
    assert.ok(Object.values(remaining).every((value) => value === ""), "Owned resources remain");
  })();
  return cleanupPromise;
}

interface Status {
  Self?: { TailscaleIPs: string[]; DNSName: string };
  Peer?: Record<string, { TailscaleIPs: string[]; sshHostKeys?: string[] }>;
}
async function status(name: string): Promise<Status> {
  const result = await exec(name, ["tailscale", `--socket=${socket}`, "status", "--json"]);
  assert.equal(result.code, 0, "Owned daemon status must be readable");
  return JSON.parse(result.stdout);
}
async function startClient(kind: "source" | "root" | "nonroot") {
  assert.ok(fixture);
  const name = `${fixture.project}-g18-${kind}`;
  containers.add(name);
  await docker("run", "-d", "--name", name,
    "--label", `${label}=${owner}`, "--label", `${fixtureLabel}=${owner}`,
    "--network", fixture.project, "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--user", kind === "nonroot" ? "10000:10000" : "0:0",
    ...(kind === "nonroot" ? [
      "-v", `${fixture.directory}/g18-passwd:/etc/passwd:ro`,
      "-v", `${fixture.directory}/g18-group:/etc/group:ro`,
    ] : []),
    "-e", "TS_NO_LOGS_NO_SUPPORT=true", "-e", "SSL_CERT_FILE=/fixture-ca.crt",
    "-v", `${fixture.directory}/fixture.crt:/fixture-ca.crt:ro`,
    "--entrypoint", "tailscaled", image, "--tun=userspace-networking", "--state=mem:",
    "--statedir=/tmp/g18-state", `--socket=${socket}`);
  await waitUntil(async () => {
    const result = await exec(name, ["tailscale", `--socket=${socket}`, "status", "--json"]);
    return result.stdout.includes('"BackendState"');
  }, { timeout: 15_000, timeoutMsg: "Owned daemon did not start" });
  const key = await fixture.key(kind === "source" ? [] : ["tag:g18-ssh"],
    kind === "source" ? { user: fixture.users.alice } : {});
  secrets.push(key.key);
  const registered = await exec(name, ["sh", "-c",
    'read -r key; exec tailscale --socket="$1" up --reset --auth-key="$key" --login-server=http://headscale:8080 --hostname="$2" --accept-dns=false --timeout=20s',
    "sh", socket, `g18-${kind}`], `${key.key}\n`);
  assert.equal(registered.code, 0, redact(`Owned client registration failed: ${registered.stderr}`));
  if (kind !== "source") {
    const enabled = await exec(name, ["tailscale", `--socket=${socket}`, "set", "--ssh=true"]);
    assert.equal(enabled.code, 0, redact(enabled.stderr));
  }
  const version = await exec(name, ["tailscale", "version"]);
  assert.equal(version.stdout.split("\n")[0]?.trim(), "1.102.5");
  assert.ok(version.stdout.includes("5fb2a81b0"), "Pinned Tailscale commit must match the archived version");
  const inspect = JSON.parse(await docker("inspect", "--format",
    '{"Config":{"User":{{json .Config.User}}},"Image":{{json .Image}},"HostConfig":{' +
    '"Privileged":{{json .HostConfig.Privileged}},"NetworkMode":{{json .HostConfig.NetworkMode}},' +
    '"CapDrop":{{json .HostConfig.CapDrop}},"CapAdd":{{json .HostConfig.CapAdd}},' +
    '"SecurityOpt":{{json .HostConfig.SecurityOpt}},"Devices":{{json .HostConfig.Devices}},' +
    '"PidMode":{{json .HostConfig.PidMode}},"GroupAdd":{{json .HostConfig.GroupAdd}}}}', name));
  const kernel = await exec(name, ["sh", "-c",
    'cat /proc/1/comm; grep -E "^(Uid|Gid|Groups|CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs|Seccomp|Seccomp_filters):" /proc/1/status; printf "LSM: "; cat /proc/1/attr/current 2>/dev/null || true']);
  const fields = Object.fromEntries(kernel.stdout.split("\n").filter((line) => line.includes(":"))
    .map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]));
  assert.ok(kernel.stdout.startsWith("tailscaled\n"), "Read the real daemon, not a docker-exec shell");
  for (const field of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"])
    assert.match(fields[field]!, /^0+$/, `Daemon ${field} must stay zero`);
  assert.equal(fields.NoNewPrivs, "1");
  assert.equal(fields.Seccomp, "2", "Default seccomp must remain active");
  assert.equal(inspect.HostConfig.Privileged, false);
  assert.equal(inspect.HostConfig.NetworkMode, fixture.project);
  assert.deepEqual(inspect.HostConfig.CapDrop, ["ALL"]);
  assert.ok(!inspect.HostConfig.CapAdd?.length);
  assert.deepEqual(inspect.HostConfig.SecurityOpt, ["no-new-privileges"]);
  assert.ok(!inspect.HostConfig.Devices?.length);
  assert.ok(inspect.HostConfig.PidMode === "");
  assert.equal(fields.Uid, kind === "nonroot" ? "10000\t10000\t10000\t10000" : "0\t0\t0\t0");
  if (kind === "nonroot") assert.equal(fields.Groups, "10000");
  record("daemon", { kind, name, version: version.stdout.trim(), kernel: fields,
    container: { user: inspect.Config.User, capDrop: inspect.HostConfig.CapDrop, capAdd: inspect.HostConfig.CapAdd,
      securityOpt: inspect.HostConfig.SecurityOpt, privileged: inspect.HostConfig.Privileged,
      networkMode: inspect.HostConfig.NetworkMode, devices: inspect.HostConfig.Devices,
      groupAdd: inspect.HostConfig.GroupAdd, imageId: inspect.Image },
  });
  return name;
}

async function check(source: string, target: string, user: "root" | "g18ssh", decision: "approve" | "reject") {
  assert.ok(fixture);
  const ip = (await status(target)).Self?.TailscaleIPs.find((address) => address.startsWith("100."));
  assert.ok(ip && /^100(?:\.\d{1,3}){3}$/.test(ip));
  let keys: string[] = [];
  await waitUntil(async () => {
    const peer = Object.values((await status(source)).Peer ?? {}).find((item) => item.TailscaleIPs.includes(ip));
    keys = peer?.sshHostKeys ?? [];
    return keys.length > 0;
  }, { timeout: 15_000, timeoutMsg: "Coordination-advertised SSH host keys unavailable" });
  for (const key of keys) assert.match(key.trim(), /^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/=]+$/);
  const knownHosts = join(fixture.directory, "g18-known-hosts");
  writeFileSync(knownHosts, keys.map((key) => `${ip} ${key.trim()}\n`).join(""), { mode: 0o600 });
  chmodSync(knownHosts, 0o600);
  const since = new Date().toISOString();
  const child = Bun.spawn(["/usr/bin/ssh", "-T", "-F", "/dev/null", "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8", "-o", "ConnectionAttempts=1", "-o", "ServerAliveInterval=3", "-o", "ServerAliveCountMax=2",
    "-o", `UserKnownHostsFile=${knownHosts}`, "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no",
    "-o", `ProxyCommand=${dockerPath} exec -i ${source} tailscale --socket=${socket} nc %h %p`,
    `${user}@${ip}`, command],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 45_000, killSignal: "SIGKILL" });
  processes.add(child);
  let stderr = "";
  const stderrDone = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) stderr += decoder.decode(chunk, { stream: true });
    stderr += decoder.decode();
  })();
  const completed = Promise.all([new Response(child.stdout).text(), stderrDone, child.exited]);
  try {
    let authId = "";
    await waitUntil(async () => {
      const match = stderr.match(/https:\/\/headscale\/auth\/(hskey-authreq-[\w-]{24})(?![\w-])/);
      if (match) { authId = match[1]!; secrets.push(match[0], authId); return true; }
      assert.equal(child.exitCode, null, redact(`SSH ended before a real pending check: ${stderr}`));
      return false;
    }, { timeout: 18_000, timeoutMsg: "Real SSH check did not become pending" });
    // The ID is private memory, sent only in the authenticated normal API body.
    const reply = await fixture.call("POST", `/api/v1/auth/${decision}`, { authId });
    assert.equal(reply.status, 200, "Normal SSH decision API must acknowledge the pending real request");
    const [stdout, , code] = await completed;
    const logs = await docker("logs", "--since", since, target);
    const sshLogs = logs.split("\n").filter((line) => /ssh-|audit: SSH/.test(line));
    const granted = sshLogs.some((line) => line.includes("access granted"));
    const childStarted = sshLogs.some((line) => line.includes("starting non-pty command:"));
    const markerObserved = stdout.trim() === marker;
    const result = { targetUser: user, decision, normalApiStatus: reply.status, realPendingCheck: true,
      strictHostKeyChecking: true, hostKeyFingerprints: keys.map((key) => {
        const [type, encoded] = key.trim().split(" ");
        return `${type} SHA256:${createHash("sha256").update(Buffer.from(encoded!, "base64")).digest("base64").replace(/=+$/, "")}`;
      }), exitCode: code, markerObserved, stdout: stdout.trim(), stderr: redact(stderr).trim(),
      granted, childStarted, targetSshLogs: sshLogs.map(redact) };
    record("real-ssh", result);
    if (decision === "reject") {
      assert.equal(code, 255, "Rejected real check must exit 255");
      assert.match(stderr, /access denied/i);
      assert.equal(granted, false);
      assert.equal(childStarted, false);
      assert.equal(markerObserved, false);
    } else if (user === "root") {
      assert.equal(granted, true);
      assert.equal(childStarted, true);
      assert.equal(code, 1, "Root without capabilities must reproduce the execution failure");
      assert.match(stderr, /operation not permitted/i);
      assert.equal(markerObserved, false);
    } else {
      assert.equal(granted, true);
      assert.equal(childStarted, true);
      assert.equal(code, 0, "Same-UID non-root shell must exit successfully");
      assert.equal(markerObserved, true, "Require remote stdout, not a marker printed in command logs");
    }
  } finally {
    if (child.exitCode === null) child.kill();
    await completed;
    processes.delete(child);
  }
}

async function rootChildDiagnostic(target: string) {
  const prepare = await exec(target, ["sh", "-c", "umask 077; : > /tmp/tailscalessh.log; id -G root"]);
  assert.equal(prepare.code, 0);
  const groups = prepare.stdout.trim().split(/\s+/).join(",");
  assert.match(groups, /^\d+(?:,\d+)*$/);
  const child = await exec(target, ["tailscaled", "be-child", "ssh", "--debug-test=true",
    "--login-shell=/bin/sh", "--uid=0", "--gid=0", `--groups=${groups}`,
    "--local-user=root", "--home-dir=/root", "--remote-user=fixture-only", "--remote-ip=100.64.0.1",
    "--has-tty=false", `--cmd=${command}`]);
  const trace = await exec(target, ["cat", "/tmp/tailscalessh.log"]);
  record("root-child-diagnostic", { exitCode: child.code, stdout: child.stdout.trim(), stderr: child.stderr.trim(),
    debugLog: trace.stdout.trim(), boundary: "Child-only diagnostic; no ptrace and not a historical syscall trace" });
  assert.equal(child.code, 1);
  assert.match(child.stderr, /operation not permitted/i);
  assert.match(trace.stdout, /dropping privileges/);
  assert.doesNotMatch(trace.stdout, /running \/bin\/sh/);
  assert.equal(child.stdout.includes(marker), false);
}

async function main() {
  owner = process.env.HEADSCALE_TAG_LIFECYCLE_OWNER ?? "";
  assert.match(owner, /^headscale-tag-lifecycle-run-\d+-[\da-f-]{36}$/, "Require this script's parent-owned fallback cleanup");
  record("native-tools", { ssh: (await run(["/usr/bin/ssh", "-V"])).stderr.trim(), bun: Bun.version });
  fixture = await createTagLifecycleFixture();
  secrets.push(fixture.connection().apiKey);
  assert.equal(await docker("inspect", "--format", `{{index .Config.Labels "${fixtureLabel}"}}`, fixture.headscale), owner);
  report.project = fixture.project;
  const hsVersion = await docker("exec", fixture.headscale, "headscale", "version");
  assert.match(hsVersion, /v0\.29\.4/);
  assert.match(hsVersion, /8106636c7f8d0cf8c9d4fb0beae94415069b768b/);
  record("control-plane", { headscaleVersion: hsVersion, reuse: "Existing owned fixture unchanged; zero-capability assertions apply to every SSH peer, not its control-plane helpers" });
  writeFileSync(join(fixture.directory, "g18-passwd"), "root:x:0:0:root:/root:/bin/sh\ng18ssh:x:10000:10000:SSH fixture:/tmp:/bin/sh\n", { mode: 0o644 });
  writeFileSync(join(fixture.directory, "g18-group"), "root:x:0:\ng18ssh:x:10000:g18ssh\n", { mode: 0o644 });
  // Only public CA/account metadata is world-readable; keys, logs and known_hosts stay private.
  for (const file of ["fixture.crt", "g18-passwd", "g18-group"]) chmodSync(join(fixture.directory, file), 0o644);
  await fixture.policy({ tagOwners: { "tag:g18-ssh": [] },
    acls: [{ action: "accept", src: ["*"], dst: ["tag:g18-ssh:22"] }],
    ssh: [{ action: "check", src: ["autogroup:member"], dst: ["tag:g18-ssh"], users: ["root", "g18ssh"], checkPeriod: "always" }],
  });
  const source = await startClient("source");
  const root = await startClient("root");
  await check(source, root, "root", "approve");
  await rootChildDiagnostic(root);
  const nonroot = await startClient("nonroot");
  await check(source, nonroot, "g18ssh", "approve");
  await check(source, nonroot, "g18ssh", "reject");
  report.status = "passed";
}

if (process.argv[2] === "--self-check") {
  const fake = "hskey-authreq-abcdefghijklmnopqrstuvwx";
  assert.ok(!redact(`https://headscale/auth/${fake} ${fake}`).includes(fake));
  secrets.push("private-fixture-secret");
  assert.ok(!redact("private-fixture-secret").includes("private-fixture-secret"));
  assert.notEqual(`starting command: ${command}`.trim(), marker);
  console.log("G18 probe self-check passed");
} else if (process.argv[2] !== "--worker") {
  assert.equal(process.env.HEADSCALE_TAG_LIFECYCLE_OWNER, undefined, "Do not adopt another run's resources");
  assert.equal(process.env.HEADSCALE_TAG_LIFECYCLE_DIRECTORY, undefined);
  const runner = createChildRunner(join(dirname(fileURLToPath(import.meta.url)), "../.."));
  const lifecycle = createTagLifecycleRunner(runner);
  const stop = () => { void runner.terminateActive(); };
  const deadline = setTimeout(stop, 270_000);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, stop);
  try { await lifecycle.run([process.execPath, fileURLToPath(import.meta.url), "--worker"]); }
  catch { process.exitCode = 1; }
  finally { clearTimeout(deadline); lifecycle.cleanup(); }
} else {
  const deadline = setTimeout(() => {
    aborting = true;
    report.status = "timed-out";
    void cleanup().catch((error) => { report.cleanupError = redact(String(error)); }).finally(() => {
      report.finishedAt = new Date().toISOString(); save(); process.exit(1);
    });
  }, 240_000);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
    aborting = true; report.status = `interrupted-${signal}`;
    void cleanup().catch((error) => { report.cleanupError = redact(String(error)); }).finally(() => {
      report.finishedAt = new Date().toISOString(); save(); process.exit(1);
    });
  });
  try { await main(); } catch (error) {
    report.status = "failed"; report.error = redact(error instanceof Error ? `${error.message}\n${error.stack}` : String(error));
    record("failure", { error: report.error }); process.exitCode = 1;
  } finally {
    if (!aborting) {
      try { await cleanup(); } catch (error) { report.status = "failed-cleanup"; report.cleanupError = redact(String(error)); process.exitCode = 1; }
      clearTimeout(deadline); report.finishedAt = new Date().toISOString(); save();
      console.log(JSON.stringify({ status: report.status, result: output }));
    }
  }
}
