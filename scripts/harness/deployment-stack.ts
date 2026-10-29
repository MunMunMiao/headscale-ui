import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  containerLogs,
  createCleanup,
  docker,
  startHeadscale as launchHeadscale,
  root,
} from "./docker";
import { createSessionNetwork } from "./session-network";

export interface DeploymentConnection {
  baseUrl: string;
  apiKey: string;
  user: string;
  network: ReturnType<typeof createSessionNetwork>;
}

/**
 * One disposable Docker network, one production image and the containers started from it.
 * `cleanup` removes everything this stack created, in dependency order, and runs on SIGINT/SIGTERM.
 */
export function createDeploymentStack(label: string) {
  const owned = `${label}-${process.pid}-${Date.now()}`;
  const image = process.env.DEPLOYMENT_IMAGE || owned;
  const containers: string[] = [];
  const temporary = mkdtempSync(join(tmpdir(), `${owned}-`));
  const ephemeralApiKeys: string[] = [];
  const networks: ReturnType<typeof createSessionNetwork>[] = [];
  const disposers: (() => Promise<unknown> | unknown)[] = [];
  let build: ReturnType<typeof Bun.spawn> | undefined;
  let networkCreated = false;
  let imageCreated = false;

  const cleanup = createCleanup("Deployment", [
    async () => {
      if (build && build.exitCode === null) {
        build.kill();
        await build.exited;
      }
    },
    async () => {
      for (const dispose of disposers.toReversed()) await dispose();
    },
    async () => {
      await Promise.all(networks.map((network) => network.close()));
    },
    () => {
      if (containers.length) docker("rm", "-fv", ...containers);
    },
    () => {
      if (networkCreated) docker("network", "rm", owned);
    },
    () => {
      if (imageCreated || (build && docker("image", "ls", "--quiet", image))) {
        docker("image", "rm", image);
      }
    },
    () => rmSync(temporary, { recursive: true }),
  ]);

  async function endpoint(name: string, containerPort = 80): Promise<string> {
    const port = docker("port", name, `${containerPort}/tcp`).match(
      /127\.0\.0\.1:(\d+)/,
    )?.[1];
    assert.ok(port, `Missing loopback port: ${name}`);
    const origin = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await fetch(origin, { signal: AbortSignal.timeout(1000) });
        return origin;
      } catch {
        await Bun.sleep(100);
      }
    }
    const error = new Error(`Container did not become ready: ${name}`);
    try {
      console.error(
        `Container ${name} startup logs:\n${containerLogs(name, ephemeralApiKeys)}`,
      );
    } catch {
      // Diagnostic failures must not replace the readiness failure.
    }
    throw error;
  }

  const stack = {
    owned,
    image,
    temporary,
    /** Full Docker network ID, set by `prepare`. */
    networkId: "",
    cleanup,
    endpoint,
    /** Runs `dispose` during cleanup, before the containers and the network are removed. */
    onCleanup(dispose: () => Promise<unknown> | unknown) {
      disposers.push(dispose);
    },
    /** Redacts the ephemeral API keys from a diagnostic. */
    redact(diagnostic: string) {
      return ephemeralApiKeys.reduce(
        (message, key) => message.replaceAll(key, "<redacted>"),
        diagnostic,
      );
    },
    async prepare() {
      if (!process.env.DEPLOYMENT_IMAGE) {
        build = Bun.spawn(["docker", "build", "-t", image, "."], {
          cwd: root,
          stdout: "inherit",
          stderr: "inherit",
        });
        assert.equal(await build.exited, 0, "Docker build failed");
        imageCreated = true;
      }
      stack.networkId = docker("network", "create", owned);
      networkCreated = true;
    },
    /** A fresh container name that cleanup will remove. */
    reserveName() {
      const name = `${owned}-${containers.length}`;
      containers.push(name);
      return name;
    },
    async start(
      base: string | undefined,
      { port = 80, flags = [] }: { port?: number; flags?: string[] } = {},
    ): Promise<{ name: string; origin: string; port: number }> {
      const name = stack.reserveName();
      docker(
        "run",
        "-d",
        "--name",
        name,
        "--network",
        owned,
        "-p",
        `127.0.0.1::${port}`,
        ...(base === undefined ? [] : ["-e", `BASE_PATH=${base}`]),
        ...flags,
        image,
      );
      return { name, origin: await endpoint(name, port), port };
    },
    /** Starts a stock nginx container with its own config; used as a proxy. */
    async startProxy(config: string): Promise<string> {
      const name = stack.reserveName();
      docker(
        "run",
        "-d",
        "--name",
        name,
        "--network",
        owned,
        "-p",
        "127.0.0.1::80",
        "-v",
        `${config}:/etc/nginx/conf.d/default.conf:ro`,
        "--entrypoint",
        "nginx",
        "nginx:1.30.6-alpine",
        "-g",
        "daemon off;",
      );
      return endpoint(name);
    },
    async startHeadscale(
      headscaleLabel: string,
    ): Promise<DeploymentConnection> {
      const headscale = `${owned}-headscale-${headscaleLabel}`;
      const user = `deployment-${headscaleLabel}-probe`;
      containers.push(headscale);
      const apiKey = await launchHeadscale(headscale, { network: owned, user });
      ephemeralApiKeys.push(apiKey);

      const config = join(temporary, `${headscaleLabel}-headscale-proxy.conf`);
      await Bun.write(
        config,
        `server {
    listen 80;
    add_header Access-Control-Allow-Origin "*" always;
    add_header Access-Control-Allow-Methods "GET, POST, PUT, DELETE, OPTIONS" always;
    add_header Access-Control-Allow-Headers "Authorization, Content-Type" always;
    location / {
      if ($request_method = OPTIONS) { return 204; }
      proxy_pass http://${headscale}:8080;
    }
  }\n`,
      );
      const gateway = `${headscale}-proxy`;
      containers.push(gateway);
      docker(
        "run",
        "-d",
        "--name",
        gateway,
        "--network",
        owned,
        "-p",
        "127.0.0.1::80",
        "-v",
        `${config}:/etc/nginx/conf.d/default.conf:ro`,
        "--entrypoint",
        "nginx",
        "nginx:1.30.6-alpine",
        "-g",
        "daemon off;",
      );
      const baseUrl = await endpoint(gateway);
      const response = await fetch(`${baseUrl}/api/v1/policy`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          policy: JSON.stringify({
            acls: [],
            hosts: {
              [`deployment-${headscaleLabel}`]:
                headscaleLabel === "a" ? "100.64.0.1" : "100.64.0.2",
            },
          }),
        }),
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200, "Seed deployment policy on Headscale");
      const network = createSessionNetwork({ upstream: baseUrl });
      networks.push(network);
      return { baseUrl: network.url, apiKey, user, network };
    },
  };
  return stack;
}
