import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import type { createChildRunner } from "./child-runner";
import { diagnosticTail, docker, root, waitForHeadscale } from "./docker";
import { waitUntil } from "./wait-until";

export function tagLifecycleDiagnostics(
  output: string,
  secrets: readonly string[] = [],
) {
  return diagnosticTail(
    output.replace(/hskey-authreq-[\w-]+/g, "<redacted-auth-request>"),
    secrets,
  );
}

export interface TagNode {
  id: string;
  name: string;
  givenName: string;
  machineKey: string;
  nodeKey: string;
  tags: string[];
  user: { id: string; name: string } | null;
  preAuthKey?: { id: string; ephemeral: boolean } | null;
  ipAddresses: string[];
  expiry: string;
  online: boolean;
  availableRoutes: string[];
  approvedRoutes: string[];
}
export interface TagKey {
  id: string;
  key: string;
  aclTags: string[];
  reusable: boolean;
  ephemeral: boolean;
  used: boolean;
  expiration: string;
}
export interface TagClient {
  name: string;
  container: string;
}
export interface DurableNode {
  id: number;
  user_id: number | null;
  tags: string | null;
  auth_key_id: number | null;
  node_key: string;
  machine_key: string;
  approved_routes: string | null;
}

const ownerLabel = "io.headscale-ui.tag-lifecycle";
const clientImage = "tailscale/tailscale:v1.104.2";
const defaultPolicy = {
  acls: [{ action: "accept", src: ["*"], dst: ["*:*"] }],
};

function assertOwnedResource(
  kind: "container" | "volume" | "network",
  name: string,
  owner: string,
) {
  assert.equal(
    docker(
      kind,
      "inspect",
      "--format",
      `{{index ${kind === "container" ? ".Config.Labels" : ".Labels"} "${ownerLabel}"}}`,
      name,
    ),
    owner,
  );
}

/** Vitest may exit before async teardown finishes; only the surviving parent owns this fallback. */
export function createTagLifecycleRunner(
  runner: ReturnType<typeof createChildRunner>,
) {
  let cleanup = () => {};
  return {
    cleanup: () => cleanup(),
    async run(cmd: string[], env: NodeJS.ProcessEnv = process.env) {
      const owner = `headscale-tag-lifecycle-run-${process.pid}-${crypto.randomUUID()}`;
      const directory = mkdtempSync(join(tmpdir(), `${owner}-`));
      let cleaned = false;
      const close = () => {
        if (cleaned) return;
        const errors: unknown[] = [];
        for (const kind of ["container", "volume", "network"] as const) {
          try {
            const names = docker(
              kind,
              "ls",
              ...(kind === "container" ? ["--all"] : []),
              "--filter",
              `label=${ownerLabel}=${owner}`,
              "--format",
              kind === "container" ? "{{.Names}}" : "{{.Name}}",
            )
              .split("\n")
              .filter(Boolean);
            // Remove namespace-sharing Headscale/TLS containers before their network keepers.
            names.sort(
              (left, right) =>
                Number(left.endsWith("-network")) -
                Number(right.endsWith("-network")),
            );
            for (const name of names) {
              try {
                assertOwnedResource(kind, name, owner);
                docker(
                  kind,
                  "rm",
                  ...(kind === "container" ? ["-fv"] : []),
                  name,
                );
              } catch (error) {
                errors.push(error);
              }
            }
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length)
          throw new AggregateError(
            errors,
            `Tag lifecycle runner cleanup failed; recovery files retained at ${directory}`,
          );
        rmSync(directory, { recursive: true, force: true });
        cleaned = true;
      };
      cleanup = close;
      try {
        await runner.run(cmd, {
          ...env,
          HEADSCALE_TAG_LIFECYCLE_OWNER: owner,
          HEADSCALE_TAG_LIFECYCLE_DIRECTORY: directory,
        });
      } finally {
        close();
      }
    },
  };
}

/** A real, unmodified 0.29.6 server. Every destructive target is created and labelled here. */
export async function createTagLifecycleFixture(
  options: { filePolicy?: string; reclaimSeconds?: number } = {},
) {
  const project = `headscale-tag-lifecycle-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  const runOwner = process.env.HEADSCALE_TAG_LIFECYCLE_OWNER;
  const runDirectory = process.env.HEADSCALE_TAG_LIFECYCLE_DIRECTORY;
  assert.equal(
    runOwner === undefined,
    runDirectory === undefined,
    "Fixture run ownership requires both an owner and a temporary directory",
  );
  if (runOwner !== undefined) {
    assert.match(runOwner, /^headscale-tag-lifecycle-run-\d+-[\da-f-]{36}$/);
    assert.ok(
      runDirectory &&
        isAbsolute(runDirectory) &&
        basename(runDirectory).startsWith(`${runOwner}-`),
      "Fixture run directory must belong to its parent runner",
    );
  }
  const owner = runOwner ?? project;
  const directory = mkdtempSync(join(runDirectory ?? tmpdir(), `${project}-`));
  const containers = new Set<string>();
  const clients = new Map<string, TagClient>();
  const logins = new Set<ReturnType<typeof Bun.spawn>>();
  const secrets: string[] = [];
  const keeper = `${project}-network`;
  const headscale = `${project}-headscale`;
  const tls = `${project}-tls`;
  const volume = `${project}-data`;
  let networkCreated = false;
  let volumeCreated = false;
  let disposed = false;
  let sqlSequence = 0;
  let apiKey = "";
  let baseUrl = "";
  const policyPath = join(directory, "policy.hujson");
  const reclaimSeconds = options.reclaimSeconds ?? 70;
  assert.ok(
    reclaimSeconds >= 65,
    "Headscale requires a reclaim window of at least 65 seconds",
  );
  const config = readFileSync(join(root, "e2e/headscale-config.yaml"), "utf8")
    .replace(
      "server_url: http://127.0.0.1:8080",
      "server_url: https://headscale",
    )
    .replace(
      "    enabled: false\n    region_id: 999",
      "    enabled: true\n    region_id: 999",
    )
    .replace(
      "automatically_add_embedded_derp_region: false",
      "automatically_add_embedded_derp_region: true",
    )
    .replace("  paths:\n    - /etc/headscale/derp.yaml", "  paths: []")
    .replace(
      "inactivity_timeout: 30m",
      `inactivity_timeout: ${reclaimSeconds}s`,
    )
    .replace("level: warn", "level: debug")
    .replace("format: text", "format: json")
    .replace(
      "mode: database",
      options.filePolicy === undefined
        ? "mode: database"
        : "mode: file\n  path: /fixtures/policy.hujson",
    );
  writeFileSync(join(directory, "config.yaml"), config, { mode: 0o600 });
  writeFileSync(
    policyPath,
    options.filePolicy ?? JSON.stringify(defaultPolicy),
    { mode: 0o600 },
  );

  function own(container: string) {
    assert.ok(
      containers.has(container),
      "Only a newly owned fixture container may be modified",
    );
    assertOwnedResource("container", container, owner);
  }
  async function close() {
    if (disposed) return;
    disposed = true;
    for (const login of logins) login.kill();
    await Promise.all([...logins].map((login) => login.exited));
    const errors: unknown[] = [];
    for (const container of [...containers].reverse()) {
      try {
        own(container);
        docker("rm", "-fv", container);
      } catch (error) {
        errors.push(error);
      }
    }
    for (const [created, kind, name] of [
      [volumeCreated, "volume", volume],
      [networkCreated, "network", project],
    ] as const) {
      if (!created) continue;
      try {
        assertOwnedResource(kind, name, owner);
        docker(kind, "rm", name);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        `Tag lifecycle fixture cleanup failed; recovery files retained at ${directory}`,
      );
    rmSync(directory, { recursive: true, force: true });
  }
  async function call<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    origin = baseUrl,
  ) {
    assert.ok(
      origin.startsWith("http://127.0.0.1:"),
      "Fixture API writes require a dynamic loopback origin",
    );
    const response = await fetch(`${origin}${path}`, {
      proxy: false,
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
      redirect: "manual",
    });
    const text = await response.text();
    let json: T | undefined;
    try {
      json = JSON.parse(text) as T;
    } catch {
      /* A dropped or invalid response is evidence, not success. */
    }
    return { status: response.status, json, text };
  }
  async function ok<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const result = await call<T>(method, path, body);
    assert.equal(
      result.status,
      200,
      `${method} ${path}: ${tagLifecycleDiagnostics(result.text, secrets)}`,
    );
    assert.ok(result.json, "Expected a JSON fixture response");
    return result.json;
  }
  async function nodes() {
    return (await ok<{ nodes: TagNode[] }>("GET", "/api/v1/node")).nodes;
  }
  async function node(id: string) {
    return (await ok<{ node: TagNode }>("GET", `/api/v1/node/${id}`)).node;
  }
  async function key(
    tags: string[],
    options: {
      user?: string;
      reusable?: boolean;
      ephemeral?: boolean;
      expiration?: string;
    } = {},
  ) {
    const { preAuthKey } = await ok<{ preAuthKey: TagKey }>(
      "POST",
      "/api/v1/preauthkey",
      {
        aclTags: tags,
        expiration: new Date(Date.now() + 3_600_000).toISOString(),
        ...options,
      },
    );
    secrets.push(preAuthKey.key);
    return preAuthKey;
  }
  function sql<T = Record<string, unknown>>(
    statement: string,
    params: (string | number | null)[] = [],
  ): T[] {
    own(headscale);
    const name = `${project}-sql-${++sqlSequence}`;
    const result = Bun.spawnSync(
      [
        "docker",
        "run",
        "--rm",
        "-i",
        "--name",
        name,
        "--label",
        `${ownerLabel}=${owner}`,
        "--network",
        "none",
        "--volumes-from",
        headscale,
        "oven/bun:1.4.4",
        "bun",
        "-e",
        'const {Database}=require("bun:sqlite");const input=await Bun.stdin.json();const db=new Database("/var/lib/headscale/db.sqlite");db.exec("PRAGMA busy_timeout=5000");try { const q=db.query(input.statement);console.log(JSON.stringify(q.all(...input.params))); } finally { db.close(); }',
      ],
      {
        cwd: root,
        stdin: Buffer.from(JSON.stringify({ statement, params })),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15_000,
      },
    );
    assert.equal(
      result.exitCode,
      0,
      `Fixture SQL failed: ${tagLifecycleDiagnostics(result.stderr.toString(), secrets)}`,
    );
    return JSON.parse(result.stdout.toString()) as T[];
  }
  function removeFaults() {
    for (const trigger of sql<{ name: string }>(
      "SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'tag_lifecycle_%'",
    ))
      sql(`DROP TRIGGER ${trigger.name}`);
  }
  async function restart(clearFaults = false) {
    own(headscale);
    if (clearFaults) {
      // Headscale validates its schema on boot. Remove only our injections after the server stops,
      // so an in-flight flush cannot turn the failed memory state into a successful durable write.
      docker("stop", headscale);
      removeFaults();
      docker("start", headscale);
    } else docker("restart", headscale);
    await waitForHeadscale(headscale);
  }
  async function client(name: string): Promise<TagClient> {
    assert.match(name, /^[a-z][a-z0-9-]*$/);
    assert.ok(!clients.has(name), "Client names must be unique in a fixture");
    const container = `${project}-${name}`;
    docker(
      "run",
      "-d",
      "--name",
      container,
      "--label",
      `${ownerLabel}=${owner}`,
      "--network",
      project,
      "-e",
      "TS_NO_LOGS_NO_SUPPORT=true",
      "-e",
      "SSL_CERT_FILE=/fixture-ca.crt",
      "-v",
      `${directory}/fixture.crt:/fixture-ca.crt:ro`,
      "--entrypoint",
      "tailscaled",
      clientImage,
      "--tun=userspace-networking",
      "--state=/var/lib/tailscale/state",
    );
    containers.add(container);
    const item = { name, container };
    clients.set(name, item);
    await waitUntil(async () => {
      const result = Bun.spawnSync(
        ["docker", "exec", container, "tailscale", "status", "--json"],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      return result.stdout.toString().includes('"BackendState"');
    });
    return item;
  }
  function status(client: TagClient): {
    BackendState: string;
    Self?: { PublicKey: string; TailscaleIPs: string[]; DNSName: string };
    Health?: string[];
    AuthURL?: string;
  } {
    own(client.container);
    const result = Bun.spawnSync(
      ["docker", "exec", client.container, "tailscale", "status", "--json"],
      { stdout: "pipe", stderr: "pipe" },
    );
    return JSON.parse(result.stdout.toString());
  }
  function serveHttp(client: TagClient) {
    own(client.container);
    // Serve is inside the official client's userspace netstack; no host port or extra image is used.
    for (const port of [18081, 18082, 18083]) {
      const result = Bun.spawnSync(
        [
          "docker",
          "exec",
          client.container,
          "timeout",
          "8",
          "tailscale",
          "serve",
          "--bg",
          "--yes",
          `--http=${port}`,
          "text:TAG_LIFECYCLE_HTTP_OK",
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe", timeout: 10_000 },
      );
      assert.equal(
        result.exitCode,
        0,
        tagLifecycleDiagnostics(`${result.stdout}\n${result.stderr}`, secrets),
      );
    }
  }
  async function httpProbe(from: TagClient, server: TagClient, port: number) {
    own(from.container);
    own(server.container);
    assert.ok(
      [18081, 18082, 18083].includes(port),
      "Only fixture HTTP service ports may be probed",
    );
    const peer = status(server).Self;
    const ip = peer?.TailscaleIPs.find((address) => address.startsWith("100."));
    const host = peer?.DNSName.replace(/\.$/, "");
    assert.ok(ip && host, "Expected an owned, registered service peer");
    const started = Date.now();
    const child = Bun.spawn(
      [
        "docker",
        "exec",
        "-i",
        from.container,
        "timeout",
        "3",
        "tailscale",
        "nc",
        ip,
        String(port),
      ],
      {
        cwd: root,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5_000,
      },
    );
    try {
      // nc closes on stdin EOF, so retain the input pipe until the real HTTP response has arrived.
      child.stdin.write(
        `GET / HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`,
      );
      await child.stdin.flush();
      const [response, errors, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      const elapsedMs = Date.now() - started;
      return {
        exitCode,
        elapsedMs,
        httpStatus:
          Number(response.match(/^HTTP\/1\.[01] (\d{3})/)?.[1]) || null,
        served: response.includes("TAG_LIFECYCLE_HTTP_OK"),
        timedOut: exitCode === 143 && elapsedMs >= 2_900,
        diagnostic: tagLifecycleDiagnostics(errors, secrets),
      };
    } finally {
      child.stdin.end();
      if (child.exitCode === null) {
        child.kill();
        await child.exited;
      }
    }
  }
  async function register(
    client: TagClient,
    authKey: string,
    options: {
      tags?: string[];
      routes?: string[];
      rotate?: boolean;
      succeeds?: boolean;
    } = {},
  ) {
    own(client.container);
    const result = Bun.spawn(
      [
        "docker",
        "exec",
        "-i",
        client.container,
        "sh",
        "-c",
        'read -r key; exec tailscale up --reset --auth-key="$key" --login-server=http://headscale:8080 --hostname="$1" --advertise-tags="$2" --advertise-routes="$3" --accept-dns=false --timeout=15s "$4"',
        "sh",
        client.name,
        (options.tags ?? []).join(","),
        (options.routes ?? []).join(","),
        options.rotate ? "--force-reauth" : "--accept-routes=false",
      ],
      {
        cwd: root,
        stdin: Buffer.from(`${authKey}\n`),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [output, errors, code] = await Promise.all([
      new Response(result.stdout).text(),
      new Response(result.stderr).text(),
      result.exited,
    ]);
    if (options.succeeds !== false)
      assert.equal(
        code,
        0,
        tagLifecycleDiagnostics(`${output}\n${errors}`, secrets),
      );
    return {
      code,
      rejectedTags: /invalid or not permitted/.test(`${output}\n${errors}`),
      diagnostic: tagLifecycleDiagnostics(`${output}\n${errors}`, secrets),
    };
  }
  function reregister(client: TagClient, authKey: string) {
    own(client.container);
    // Start replaces the official daemon's control client without LoginInteractive, preserving NodeKey.
    const result = Bun.spawnSync(
      [
        "docker",
        "exec",
        "-i",
        client.container,
        "tailscale",
        "debug",
        "localapi",
        "POST",
        "/localapi/v0/start",
        "-",
      ],
      {
        cwd: root,
        stdin: Buffer.from(JSON.stringify({ AuthKey: authKey })),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      },
    );
    assert.equal(
      result.exitCode,
      0,
      tagLifecycleDiagnostics(result.stderr.toString(), secrets),
    );
  }
  async function login(
    client: TagClient,
    tags: string[] = [],
    routes: string[] = [],
  ) {
    own(client.container);
    const child = Bun.spawn(
      [
        "docker",
        "exec",
        client.container,
        "tailscale",
        "up",
        "--reset",
        "--force-reauth",
        "--auth-key=",
        "--login-server=http://headscale:8080",
        `--hostname=${client.name}`,
        `--advertise-tags=${tags.join(",")}`,
        `--advertise-routes=${routes.join(",")}`,
        "--accept-dns=false",
        "--timeout=60s",
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    logins.add(child);
    let output = "";
    const read = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        output += decoder.decode(part.value);
      }
    };
    const completion = Promise.all([
      read(child.stdout),
      read(child.stderr),
      child.exited,
    ]).then(([, , code]) => {
      logins.delete(child);
      return { code, diagnostic: tagLifecycleDiagnostics(output, secrets) };
    });
    try {
      await waitUntil(async () => {
        if (child.exitCode !== null && !output.includes("hskey-authreq-"))
          throw new Error(tagLifecycleDiagnostics(output, secrets));
        return /hskey-authreq-[\w-]+/.test(output);
      });
      const authId = output.match(/hskey-authreq-[\w-]+/)?.[0];
      assert.ok(
        authId,
        "Official client must expose a one-time registration request",
      );
      secrets.push(authId);
      const url = output.match(/https?:\/\/[^\s]*hskey-authreq-[\w-]+/)?.[0];
      assert.ok(url, "Official client must retain the public registration URL");
      return {
        authId,
        url,
        loginServer: new URL(url).origin,
        completion,
        cancel: () => child.kill(),
      };
    } catch (error) {
      child.kill();
      await completion;
      throw error;
    }
  }
  function registrationNodeKeys(client: TagClient, since?: string): string[] {
    own(client.container);
    // Extract only public request-key fingerprints, never authentication material from client logs.
    const log = docker(
      "logs",
      ...(since ? ["--since", since] : []),
      client.container,
    );
    return [...log.matchAll(/RegisterReq: onode=\S* node=(\S+) fup=/g)].map(
      (match) => match[1],
    );
  }
  function stop(client: TagClient) {
    own(client.container);
    docker("stop", "--time", "2", client.container);
  }
  function events(since: string): Record<string, unknown>[] {
    own(headscale);
    return docker("logs", "--since", since, headscale)
      .split("\n")
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
  }
  async function reset() {
    for (const login of logins) login.kill();
    await Promise.all([...logins].map((login) => login.exited));
    for (const item of clients.values()) {
      own(item.container);
      docker("rm", "-fv", item.container);
      containers.delete(item.container);
    }
    clients.clear();
    removeFaults();
    if (
      docker("inspect", "--format", "{{.State.Running}}", headscale) !== "true"
    ) {
      docker("start", headscale);
      await waitForHeadscale(headscale);
    }
    for (const item of await nodes())
      await ok("DELETE", `/api/v1/node/${item.id}`);
    for (const item of (
      await ok<{ preAuthKeys: TagKey[] }>("GET", "/api/v1/preauthkey")
    ).preAuthKeys)
      await ok("DELETE", `/api/v1/preauthkey?id=${item.id}`);
    if (options.filePolicy === undefined)
      await ok("PUT", "/api/v1/policy", {
        policy: JSON.stringify(defaultPolicy),
      });
  }
  try {
    docker("network", "create", "--label", `${ownerLabel}=${owner}`, project);
    networkCreated = true;
    docker("volume", "create", "--label", `${ownerLabel}=${owner}`, volume);
    volumeCreated = true;
    docker(
      "run",
      "-d",
      "--name",
      keeper,
      "--label",
      `${ownerLabel}=${owner}`,
      "--network",
      project,
      "--network-alias",
      "headscale",
      "-p",
      "127.0.0.1::8080",
      "--entrypoint",
      "sleep",
      clientImage,
      "infinity",
    );
    containers.add(keeper);
    const port = docker("port", keeper, "8080/tcp").match(
      /127\.0\.0\.1:(\d+)/,
    )?.[1];
    assert.ok(port && !["8080", "18080"].includes(port));
    baseUrl = `http://127.0.0.1:${port}`;
    // The official client forces TLS on a second Noise dial within two minutes. Supply a real
    // trusted TLS fallback on this private network, rather than avoiding re-registration.
    const certificate = Bun.spawnSync(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(directory, "fixture.key"),
        "-out",
        join(directory, "fixture.crt"),
        "-days",
        "1",
        "-subj",
        "/CN=headscale",
        "-addext",
        "subjectAltName=DNS:headscale",
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    assert.equal(
      certificate.exitCode,
      0,
      "Generating the isolated fixture TLS certificate failed",
    );
    writeFileSync(
      join(directory, "nginx.conf"),
      'server { listen 443 ssl; server_name headscale; ssl_certificate /fixtures/fixture.crt; ssl_certificate_key /fixtures/fixture.key; location / { proxy_pass http://127.0.0.1:8080; proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_read_timeout 300s; } }',
      { mode: 0o600 },
    );
    docker(
      "run",
      "-d",
      "--name",
      tls,
      "--label",
      `${ownerLabel}=${owner}`,
      "--network",
      `container:${keeper}`,
      "-v",
      `${directory}/nginx.conf:/etc/nginx/conf.d/default.conf:ro`,
      "-v",
      `${directory}:/fixtures:ro`,
      "nginx:1.30.6-alpine",
    );
    containers.add(tls);
    docker(
      "run",
      "-d",
      "--name",
      headscale,
      "--label",
      `${ownerLabel}=${owner}`,
      "--network",
      `container:${keeper}`,
      "-v",
      `${directory}/config.yaml:/etc/headscale/config.yaml:ro`,
      "-v",
      `${root}/e2e/headscale-derp.yaml:/etc/headscale/derp.yaml:ro`,
      "-v",
      `${directory}:/fixtures:ro`,
      "-v",
      `${volume}:/var/lib/headscale`,
      "headscale/headscale:0.29.6",
      "serve",
    );
    containers.add(headscale);
    await waitForHeadscale(headscale);
    apiKey = docker(
      "exec",
      "-e",
      "HEADSCALE_LOG_LEVEL=error",
      headscale,
      "headscale",
      "apikeys",
      "create",
      "--expiration",
      "3h",
    );
    secrets.push(apiKey);
    assert.equal(
      (await ok<{ version: string }>("GET", "/version")).version,
      "v0.29.6+dirty",
    );
    const users: Record<string, string> = {};
    for (const name of ["alice", "bob"])
      users[name] = (
        await ok<{ user: { id: string } }>("POST", "/api/v1/user", { name })
      ).user.id;
    if (options.filePolicy === undefined)
      await ok("PUT", "/api/v1/policy", {
        policy: JSON.stringify(defaultPolicy),
      });
    return {
      project,
      baseUrl,
      headscale,
      directory,
      reclaimSeconds,
      users,
      call,
      ok,
      node,
      nodes,
      key,
      sql,
      client,
      status,
      serveHttp,
      httpProbe,
      register,
      reregister,
      registrationNodeKeys,
      login,
      stop,
      events,
      restart,
      reset,
      close,
      connection: () => ({ baseUrl, apiKey }),
      durableNode: (id: string) =>
        sql<DurableNode>(
          "SELECT id,user_id,tags,auth_key_id,node_key,machine_key,approved_routes FROM nodes WHERE id=?",
          [Number(id)],
        )[0],
      policy: (policy: unknown) =>
        ok("PUT", "/api/v1/policy", {
          policy: typeof policy === "string" ? policy : JSON.stringify(policy),
        }),
      writePolicyFile: (policy: unknown) => {
        assert.notEqual(options.filePolicy, undefined);
        writeFileSync(
          policyPath,
          typeof policy === "string" ? policy : JSON.stringify(policy),
          {
            mode: 0o600,
          },
        );
      },
      ping: (from: TagClient, ip: string) => {
        own(from.container);
        return docker(
          "exec",
          from.container,
          "tailscale",
          "ping",
          "--c=3",
          "--until-direct=false",
          "--timeout=5s",
          ip,
        );
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
export type TagLifecycleFixture = Awaited<
  ReturnType<typeof createTagLifecycleFixture>
>;
