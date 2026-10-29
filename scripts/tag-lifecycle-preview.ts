import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import { createCleanup, root } from "./harness/docker.ts";
import {
  createTagLifecycleFixture,
  type TagLifecycleFixture,
  tagLifecycleDiagnostics,
} from "./harness/tag-lifecycle.ts";

export function tagPreviewInitialization(
  origin: string,
  connection: { apiKey: string; password: string; profileName: string },
): Plugin {
  const credentialsPath = "/__tag-preview-credentials";
  const initializationPath = "/__tag-preview-init";
  const moduleId = "virtual:tag-preview-init";
  let consumed = false;
  return {
    name: "tag-preview-initialization",
    resolveId: (id) => (id === moduleId ? `\0${moduleId}` : undefined),
    load(id) {
      if (id !== `\0${moduleId}`) return;
      return `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import App from "/src/App.tsx";
import { prepareApplication } from "/src/bootstrap.ts";
import { createActionFeedbackStore } from "/src/composables/useActionFeedback.ts";
import { createProfilesStore, newProfileId } from "/src/composables/useProfiles.ts";
import "/src/styles/globals.css";
const root = document.getElementById("root");
let initial;
try {
  if (window.top !== window.self) throw new Error("Embedded initialization is forbidden");
  const response = await fetch("${credentialsPath}", { method: "POST", cache: "no-store", credentials: "same-origin" });
  if (!response.ok) throw new Error("Initialization unavailable");
  const connection = await response.json();
  if (connection.baseUrl !== location.origin) throw new Error("Fixture origin mismatch");
  initial = await prepareApplication();
  const previous = new Set((initial.profiles?.profiles ?? []).map(profile => profile.id));
  const feedback = createActionFeedbackStore();
  const profiles = createProfilesStore(initial.bridge, feedback, initial.profiles);
  await profiles.loadProfile(newProfileId);
  profiles.setConnectionForm({ profileName: connection.profileName, baseUrl: location.origin, apiKey: connection.apiKey, password: connection.password, passwordConfirmation: connection.password, remember: false });
  await profiles.addProfile(true);
  connection.apiKey = ""; connection.password = "";
  const active = initial.bridge.getSessionSnapshot();
  if (active?.status !== "unlocked" || !active.profile || previous.has(active.profile.id) || active.profile.id !== profiles.selectedProfile?.id || active.profile.baseUrl !== location.origin) throw new Error("Profile activation failed");
  const listing = await initial.bridge.listProfiles();
  if (!listing.ok || !listing.value.profiles.some(profile => profile.id === active.profile.id)) throw new Error("Profile readback failed");
  initial.profiles = listing.value;
  history.replaceState({}, "", "/devices");
  createRoot(root).render(createElement(App, { initialState: initial }));
} catch {
  initial?.bridge.dispose();
  root.setAttribute("role", "alert");
  root.textContent = "Isolated fixture initialization failed. No credentials were logged. Restart this preview fixture to obtain a new one-time initialization.";
}
`;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (
          request.url !== credentialsPath &&
          request.url !== initializationPath
        )
          return next();
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Frame-Options", "DENY");
        response.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
        const local = request.headers.host === new URL(origin).host;
        if (request.url === initializationPath) {
          const site = request.headers["sec-fetch-site"];
          if (
            !local ||
            request.method !== "GET" ||
            request.headers["sec-fetch-dest"] !== "document" ||
            (site !== "none" && site !== "same-origin")
          ) {
            response.statusCode = 403;
            response.end("Forbidden");
            return;
          }
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          void server
            .transformIndexHtml(
              initializationPath,
              `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Isolated tag lifecycle fixture</title></head><body><div id="root">Initializing isolated fixture…</div><script type="module" src="/@id/__x00__${moduleId}"></script></body></html>`,
            )
            .then(
              (html) => response.end(html),
              () => {
                response.statusCode = 500;
                response.end("Initialization unavailable");
              },
            );
          return;
        }
        if (
          !local ||
          request.method !== "POST" ||
          request.headers.origin !== origin ||
          request.headers["sec-fetch-site"] !== "same-origin" ||
          request.headers["sec-fetch-dest"] !== "empty"
        ) {
          response.statusCode = 403;
          response.end("Forbidden");
          return;
        }
        if (consumed) {
          response.statusCode = 410;
          response.end("Already consumed");
          return;
        }
        consumed = true;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ ...connection, baseUrl: origin }));
      });
    },
  };
}

// Run this test-only launcher through preview_start. It never points at the existing playground.
export async function runTagLifecyclePreview(port = 4179) {
  assert.ok(
    Number.isInteger(port) &&
      port > 1024 &&
      port < 65536 &&
      ![8080, 18080].includes(port),
  );
  let fixture: TagLifecycleFixture | undefined;
  let server: ViteDevServer | undefined;
  let stopping = false;
  let starting: Promise<void> | undefined;
  const cleanupPhase = (phase: string) =>
    console.error(
      JSON.stringify({
        status: "cleanup",
        phase,
        pid: process.pid,
        project: fixture?.project,
      }),
    );
  let fixtureClosing: Promise<void> | undefined;
  const closeFixture = () =>
    (fixtureClosing ??= (async () => {
      cleanupPhase("fixture-closing");
      try {
        await fixture?.close();
        cleanupPhase("fixture-closed");
      } catch (error) {
        process.exitCode = 1;
        const failure = new Error(
          tagLifecycleDiagnostics(
            String(error),
            fixture ? [fixture.connection().apiKey] : [],
          ),
        );
        console.error(failure.message);
        throw failure;
      }
    })());
  const close = createCleanup("Tag lifecycle preview", [
    () => {
      stopping = true;
      cleanupPhase("requested");
    },
    async () => {
      await starting?.catch(() => {});
      cleanupPhase("startup-settled");
    },
    async () => {
      cleanupPhase("server-closing");
      await server?.close();
      cleanupPhase("server-closed");
    },
    closeFixture,
  ]);
  try {
    starting = (async () => {
      fixture = await createTagLifecycleFixture();
      if (stopping) return;
      await fixture.policy({
        acls: [{ action: "accept", src: ["*"], dst: ["*:*"] }],
        tagOwners: { "tag:old": [], "tag:target": ["bob@"], "tag:extra": [] },
      });
      for (const item of [
        { name: "preview-personal", tags: [], ephemeral: false },
        {
          name: "preview-tagged",
          tags: ["tag:old", "tag:extra"],
          ephemeral: false,
        },
        { name: "preview-ephemeral", tags: ["tag:old"], ephemeral: true },
      ]) {
        if (stopping) return;
        const key = await fixture.key(item.tags, {
          user: item.tags.length ? undefined : fixture.users.alice,
          ephemeral: item.ephemeral,
          reusable: true,
        });
        if (stopping) return;
        const client = await fixture.client(item.name);
        if (stopping) return;
        await fixture.register(client, key.key);
      }
      if (stopping) return;
      await fixture.key(["tag:key-only"], { reusable: true });
      if (stopping) return;
      const origin = `http://127.0.0.1:${port}`;
      const connection = {
        apiKey: fixture.connection().apiKey,
        profileName: "Isolated tag lifecycle",
        password: crypto.randomUUID(),
      };
      server = await createServer({
        configFile: join(root, "vite.config.ts"),
        plugins: [
          tagPreviewInitialization(origin, connection),
          {
            name: "tag-preview-owned-resource-cleanup",
            async closeServer() {
              // Vite exits on SIGTERM or stdin EOF after closeServer hooks; cleanup must join that boundary.
              stopping = true;
              cleanupPhase("vite-server-close");
              await closeFixture();
            },
          },
        ],
        cacheDir: join(root, "node_modules/.vite/tag-lifecycle-preview"),
        server: {
          host: "127.0.0.1",
          port,
          strictPort: true,
          watch: { ignored: ["**/.claude/**"] },
          proxy: { "/api/": fixture.baseUrl, "/version": fixture.baseUrl },
        },
      });
      const closeVite = server.close.bind(server);
      server.close = async () => {
        stopping = true;
        const results = await Promise.allSettled([closeFixture(), closeVite()]);
        const failures = results.flatMap((result) =>
          result.status === "rejected"
            ? [
                tagLifecycleDiagnostics(String(result.reason), [
                  connection.apiKey,
                  connection.password,
                ]),
              ]
            : [],
        );
        if (failures.length) {
          process.exitCode = 1;
          const error = new AggregateError(
            failures,
            "Tag lifecycle preview cleanup failed",
          );
          console.error(error);
          throw error;
        }
      };
      if (stopping) return;
      await server.listen();
      if (stopping) return;
      const connectionPath = join(fixture.directory, "connection.json");
      const metadataPath = join(fixture.directory, "preview.json");
      writeFileSync(
        connectionPath,
        JSON.stringify({ baseUrl: origin, ...connection }),
        {
          mode: 0o600,
        },
      );
      const metadata = {
        origin,
        initialization: `${origin}/__tag-preview-init`,
        loginServer: "https://headscale",
        loginServerScope:
          "Owned fixture Docker network only; not the UI proxy origin",
        project: fixture.project,
        backend: fixture.baseUrl,
        pid: process.pid,
        version: "v0.29.6+dirty",
        connectionPath,
        nodes: (await fixture.nodes()).map(({ id, name, tags }) => ({
          id,
          name,
          tags,
        })),
      };
      writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), {
        mode: 0o600,
      });
      console.log(
        JSON.stringify({
          status: "ready",
          origin,
          initialization: `${origin}/__tag-preview-init`,
          project: fixture.project,
          metadataPath,
          connectionPath,
        }),
      );
    })();
    await starting;
  } catch (error) {
    console.error(
      tagLifecycleDiagnostics(
        String(error),
        fixture ? [fixture.connection().apiKey] : [],
      ),
    );
    await close();
    process.exitCode = 1;
  }
}

if (import.meta.main)
  await runTagLifecyclePreview(Number(process.argv[2] ?? "4179"));
