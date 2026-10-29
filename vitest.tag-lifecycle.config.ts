import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";
import { createCleanup } from "./scripts/harness/docker.ts";
import {
  createSessionNetwork,
  type NetworkGateOptions,
} from "./scripts/harness/session-network.ts";
import {
  createTagLifecycleFixture,
  type TagClient,
  type TagLifecycleFixture,
} from "./scripts/harness/tag-lifecycle.ts";
import viteConfig from "./vite.config.ts";

let fixture: TagLifecycleFixture;
let network: ReturnType<typeof createSessionNetwork>;
let gate: ReturnType<typeof network.intercept> | undefined;
let second: TagLifecycleFixture | undefined;
let secondNetwork: ReturnType<typeof createSessionNetwork> | undefined;
let stopping = false;
let starting: Promise<void> | undefined;
let secondStarting: Promise<{ baseUrl: string; apiKey: string }> | undefined;
const close = createCleanup("Tag lifecycle", [
  () => {
    stopping = true;
  },
  async () => {
    await Promise.allSettled([starting, secondStarting]);
  },
  () => release(),
  () => network?.close(),
  () => secondNetwork?.close(),
  () => fixture?.close(),
  () => second?.close(),
]);
const clients = new Map<string, TagClient>();
const logins = new Map<
  string,
  Awaited<ReturnType<TagLifecycleFixture["login"]>>
>();
async function release() {
  await gate?.release();
  gate = undefined;
}
async function snapshot() {
  const nodes = (await fixture.nodes()).map(
    ({ preAuthKey: _key, ...node }) => node,
  );
  const { preAuthKeys } = await fixture.ok<{
    preAuthKeys: {
      id: string;
      key?: string;
      aclTags: string[];
      used: boolean;
      reusable: boolean;
      ephemeral: boolean;
      expiration: string;
    }[];
  }>("GET", "/api/v1/preauthkey");
  return {
    nodes,
    keys: preAuthKeys.map(({ key: _secret, ...key }) => key),
    policy: (await fixture.ok<{ policy: string }>("GET", "/api/v1/policy"))
      .policy,
  };
}

export default mergeConfig(
  viteConfig,
  defineConfig({
    plugins: [
      {
        name: "tag-lifecycle-real-fixture",
        async configureServer(server) {
          if (stopping) return;
          starting = (async () => {
            fixture = await createTagLifecycleFixture();
            if (stopping) return;
            network = createSessionNetwork({ upstream: fixture.baseUrl });
            const proxy =
              server.config.server.proxy?.["/__headscale-tag-lifecycle"];
            if (proxy && typeof proxy !== "string") proxy.target = network.url;
          })();
          await starting;
        },
        closeBundle: close,
      },
    ],
    server: {
      proxy: {
        "/__headscale-tag-lifecycle": {
          target: "http://127.0.0.1:1",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/__headscale-tag-lifecycle/, ""),
        },
      },
    },
    cacheDir: "node_modules/.vite/tag-lifecycle",
    optimizeDeps: {
      include: [
        "@base-ui/react/*",
        "@defjs/core",
        "@tanstack/react-router",
        "effect",
        "react-dom/client",
      ],
    },
    test: {
      name: "tag-lifecycle-real",
      api: { host: "127.0.0.1" },
      include: ["e2e/tag-lifecycle.browser.test.tsx"],
      setupFiles: [
        "src/test/browser-motion.css",
        "src/test/screenshot-mask.css",
      ],
      fileParallelism: false,
      testTimeout: 60_000,
      hookTimeout: 60_000,
      browser: {
        enabled: true,
        headless: true,
        // Real one-time requests must never be included in failure artifacts.
        screenshotFailures: false,
        provider: playwright(),
        instances: [{ browser: "chromium" }],
        commands: {
          tagFixtureReset: async () => {
            await release();
            await network.reset();
            await fixture.reset();
            clients.clear();
            logins.clear();
            await secondNetwork?.close();
            await second?.close();
            second = undefined;
            secondNetwork = undefined;
            secondStarting = undefined;
          },
          tagFixtureConnection: async () => ({
            apiKey: fixture.connection().apiKey,
          }),
          tagFixtureSecondServer: async (_context, matchingNodeId: string) => {
            if (second || secondStarting)
              throw new Error("Only one alternate fixture is needed");
            const checkRunning = () => {
              if (stopping)
                throw new Error("Tag lifecycle fixture is stopping");
            };
            checkRunning();
            secondStarting = (async () => {
              second = await createTagLifecycleFixture();
              checkRunning();
              await second.policy({
                acls: [{ action: "accept", src: ["*"], dst: ["*:*"] }],
                tagOwners: { "tag:old": [], "tag:next": [] },
              });
              checkRunning();
              // IDs deliberately overlap across two independent servers, not just two UI aliases.
              second.sql("DELETE FROM sqlite_sequence WHERE name='nodes'");
              second.sql(
                "INSERT INTO sqlite_sequence(name,seq) VALUES('nodes',?)",
                [Number(matchingNodeId) - 1],
              );
              const key = await second.key(["tag:old"]);
              checkRunning();
              const client = await second.client("other-server-device");
              checkRunning();
              await second.register(client, key.key);
              checkRunning();
              secondNetwork = createSessionNetwork({
                upstream: second.baseUrl,
              });
              return {
                baseUrl: secondNetwork.url,
                apiKey: second.connection().apiKey,
              };
            })();
            return secondStarting;
          },
          tagFixtureSecondSnapshot: async () => {
            if (!second || !secondNetwork)
              throw new Error("Alternate fixture is not running");
            return {
              nodes: (await second.nodes()).map(
                ({ preAuthKey: _key, ...node }) => node,
              ),
              calls: secondNetwork.getOperationCalls(),
            };
          },
          tagFixtureSeedPolicy: async (_context, policy: string) => {
            await fixture.policy(policy);
          },
          tagFixtureCreateNode: async (
            _context,
            name: string,
            tags: string[],
            ephemeral = false,
            routes: string[] = [],
          ) => {
            const key = await fixture.key(tags, {
              user: tags.length ? undefined : fixture.users.alice,
              ephemeral,
              reusable: true,
            });
            const client = await fixture.client(name);
            clients.set(name, client);
            await fixture.register(client, key.key, { routes });
            const node = (await fixture.nodes()).find(
              (node) => node.name === name,
            );
            if (!node)
              throw new Error(
                "The official client did not register its fixture node",
              );
            return {
              nodeId: node.id,
              keyId: key.id,
              machineKey: node.machineKey,
            };
          },
          tagFixtureRegisterKey: async (
            _context,
            name: string,
            key: string,
          ) => {
            const client = await fixture.client(name);
            clients.set(name, client);
            await fixture.register(client, key);
            const node = (await fixture.nodes()).find(
              (node) => node.name === name,
            );
            if (!node)
              throw new Error(
                "The official client did not register its fixture node",
              );
            return { nodeId: node.id, machineKey: node.machineKey };
          },
          tagFixtureSnapshot: snapshot,
          tagFixtureDurableNode: async (_context, id: string) =>
            fixture.durableNode(id),
          tagFixtureLogin: async (
            _context,
            name: string,
            routes: string[] = [],
          ) => {
            const client = clients.get(name);
            if (!client) throw new Error("Unknown owned test client");
            const login = await fixture.login(client, [], routes);
            logins.set(name, login);
            return {
              authId: login.authId,
              url: login.url,
              loginServer: login.loginServer,
            };
          },
          tagFixtureFinishLogin: async (_context, name: string) => {
            const login = logins.get(name);
            if (!login) throw new Error("No owned authentication request");
            const result = await login.completion;
            logins.delete(name);
            return result.code;
          },
          tagFixtureStopClient: async (_context, name: string) => {
            const client = clients.get(name);
            if (!client) throw new Error("Unknown owned test client");
            fixture.stop(client);
          },
          tagFixtureRestart: async (_context, clearFaults = false) => {
            await fixture.restart(clearFaults);
          },
          tagFixtureInjectFailure: async (
            _context,
            point: "node-tags" | "auth-register",
            id: string,
          ) => {
            if (!/^\d+$/.test(id))
              throw new Error("Expected an owned numeric node ID");
            const column = point === "node-tags" ? "tags" : "approved_routes";
            fixture.sql(
              `CREATE TRIGGER tag_lifecycle_ui_fault BEFORE UPDATE OF ${column} ON nodes WHEN NEW.id=${Number(id)} AND NEW.${column} IS NOT OLD.${column} BEGIN SELECT RAISE(ABORT,'TAG_LIFECYCLE_UI_LATE_FAILURE'); END`,
            );
          },
          tagFixtureConcurrentKey: async (
            _context,
            tags: string[],
            expiration: string,
            user?: string,
          ) => {
            const key = await fixture.key(tags, {
              expiration,
              reusable: true,
              ...(user ? { user } : {}),
            });
            return { id: key.id };
          },
          tagFixtureSetTags: async (_context, id: string, tags: string[]) => {
            await fixture.ok("POST", `/api/v1/node/${id}/tags`, { tags });
          },
          tagNetworkIntercept: async (
            _context,
            options: NetworkGateOptions,
          ) => {
            const previous = gate;
            gate = network.intercept(options);
            await previous?.release();
          },
          tagNetworkState: async () => gate?.getSnapshot() ?? null,
          tagNetworkRelease: release,
          tagNetworkCalls: async () => network.getOperationCalls(),
          tagNetworkObservations: async () => network.getObservations(),
          tagNetworkClear: async () => {
            network.clearOperationCalls();
            network.clearObservations();
          },
        },
      },
    },
  }),
);
