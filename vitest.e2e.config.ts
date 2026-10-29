import { playwright } from "@vitest/browser-playwright";
import type { BrowserContext, Page } from "playwright";
import { defineConfig, mergeConfig } from "vitest/config";
import {
  createHeadscalePolicyFixture,
  resetHeadscaleFixture,
} from "./e2e/headscale-fixture.ts";
import type { NetworkOperationCall } from "./e2e/network-observations.ts";
import { createSessionNetwork } from "./scripts/harness/session-network.ts";
import viteConfig from "./vite.config.ts";

const resizeObserverLoopMessage =
  "ResizeObserver loop completed with undelivered notifications.";
const headscaleE2eUrl = process.env.HEADSCALE_E2E_URL;
const headscaleFileModeUrl = process.env.HEADSCALE_E2E_FILE_MODE_URL;
interface NetworkFailure {
  timestamp: number;
  path: string;
  status?: number;
  errorText?: string;
  mimeType?: string;
}
const networkFailures = new WeakMap<BrowserContext, NetworkFailure[]>();
type SessionNetwork = ReturnType<typeof createSessionNetwork>;
let sessionNetwork: SessionNetwork | undefined;
const headscaleInterceptions = new WeakMap<
  BrowserContext,
  ReturnType<SessionNetwork["intercept"]>
>();
let networkOwner: BrowserContext | undefined;
let networkCleanup = Promise.resolve();

function policyFixture() {
  const apiKey = process.env.HEADSCALE_E2E_API_KEY;
  if (!headscaleE2eUrl || !apiKey)
    throw new Error("Headscale policy fixture is not configured");
  return createHeadscalePolicyFixture({ baseUrl: headscaleE2eUrl, apiKey });
}

async function claimNetwork(page: Page) {
  await networkCleanup;
  const context = page.context();
  if (networkOwner && networkOwner !== context)
    throw new Error(
      "The fixed-origin Headscale fixture supports one active browser context",
    );
  if (networkOwner === context) return;
  networkOwner = context;
  context.once("close", () => {
    networkOwner = undefined;
    headscaleInterceptions.delete(context);
    networkCleanup = sessionNetwork?.reset() ?? Promise.resolve();
  });
}

async function releaseHeadscaleRequest(page: Page) {
  await claimNetwork(page);
  const context = page.context();
  const interception = headscaleInterceptions.get(context);
  if (!interception) return;
  headscaleInterceptions.delete(context);
  await interception.release();
}

async function interceptHeadscaleRequest(
  page: Page,
  method: string,
  pathPattern: string,
  failure?: string | { responseBody: unknown } | { rawBody: string },
) {
  if (!sessionNetwork)
    throw new Error("Headscale network fixture is not running");
  await claimNetwork(page);
  await releaseHeadscaleRequest(page);
  headscaleInterceptions.set(
    page.context(),
    sessionNetwork.intercept({ method, pathPattern, failure }),
  );
}
function diagnosticPath(url: string): string | undefined {
  const { pathname } = new URL(url);
  return pathname.startsWith("/src/") ||
    pathname.includes("/node_modules/") ||
    pathname.startsWith("/@")
    ? pathname
    : undefined;
}
async function startNetworkDiagnostics(page: Page) {
  await claimNetwork(page);
  sessionNetwork?.clearObservations();
  sessionNetwork?.clearOperationCalls();
  const context = page.context();
  const existing = networkFailures.get(context);
  if (existing) {
    existing.length = 0;
    return;
  }
  const failures: NetworkFailure[] = [];
  networkFailures.set(context, failures);
  context.on("requestfailed", (request) => {
    const path = diagnosticPath(request.url());
    if (path)
      failures.push({
        timestamp: Date.now(),
        path,
        errorText:
          request.failure()?.errorText.match(/(?:net::)?ERR_[A-Z0-9_]+/)?.[0] ??
          "request failed",
      });
  });
  context.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    const status = text.match(/status of (\d{3})/);
    const errorText = text.match(/net::ERR_[A-Z0-9_]+/)?.[0];
    const mimeType = text.match(/MIME type of ["']([^"']+)["']/)?.[1];
    const url = text.match(/https?:\/\/[^\s"'<>]+/)?.[0];
    if (!url || (!status && !errorText && !mimeType)) return;
    const path = diagnosticPath(url);
    if (path)
      failures.push({
        timestamp: Date.now(),
        path,
        status: status ? Number(status[1]) : undefined,
        errorText,
        mimeType,
      });
  });
  context.on("response", (response) => {
    const path = diagnosticPath(response.url());
    if (path && response.status() >= 400)
      failures.push({
        timestamp: Date.now(),
        path,
        status: response.status(),
        mimeType: response.headers()["content-type"],
      });
  });
}

async function closeNetwork() {
  await networkCleanup;
  await sessionNetwork?.close();
  sessionNetwork = undefined;
}

export default mergeConfig(
  viteConfig,
  defineConfig({
    plugins: headscaleE2eUrl
      ? [
          {
            name: "headscale-session-network",
            configureServer(server) {
              sessionNetwork = createSessionNetwork({
                upstream: headscaleE2eUrl,
              });
              const proxy = server.config.server.proxy?.["/__headscale-e2e"];
              if (proxy && typeof proxy !== "string")
                proxy.target = sessionNetwork.url;
            },
            closeBundle: closeNetwork,
          },
        ]
      : [],
    server: headscaleE2eUrl
      ? {
          proxy: {
            // Plain proxy on purpose: createSessionNetwork preserves upstream status and the
            // fixed-origin gate supports one active context, so file mode talks to Headscale directly.
            // Listed first: Vite matches string keys by prefix and "/__headscale-e2e" is a prefix of this one.
            ...(headscaleFileModeUrl
              ? {
                  "/__headscale-e2e-file-mode": {
                    target: headscaleFileModeUrl,
                    changeOrigin: true,
                    rewrite: (path: string) =>
                      path.replace(/^\/__headscale-e2e-file-mode/, ""),
                  },
                }
              : {}),
            "/__headscale-e2e": {
              target: headscaleE2eUrl,
              changeOrigin: true,
              rewrite: (path) => path.replace(/^\/__headscale-e2e/, ""),
            },
          },
        }
      : undefined,
    optimizeDeps: {
      include: [
        "@base-ui/react/*",
        "@defjs/core",
        "@tanstack/react-router",
        "effect",
      ],
    },
    test: {
      api: { host: "127.0.0.1" },
      onConsoleLog(log, type) {
        if (
          type === "stderr" &&
          log.trim() === `[Error: ${resizeObserverLoopMessage}]`
        )
          return false;
      },
      include: [
        "e2e/**/*.browser.test.tsx",
        "src/test/screenshot-privacy.browser.test.tsx",
      ],
      exclude: ["e2e/tag-lifecycle.browser.test.tsx"],
      setupFiles: [
        "src/test/browser-motion.css",
        "src/test/screenshot-mask.css",
      ],
      fileParallelism: false,
      testTimeout: 30_000,
      hookTimeout: 30_000,
      browser: {
        commands: {
          seedHeadscalePolicyFixture: async ({ page }, policy: string) => {
            await claimNetwork(page);
            await policyFixture().seed(policy);
          },
          readHeadscaleFixturePolicy: async ({ page }) => {
            await claimNetwork(page);
            return policyFixture().read();
          },
          writeHeadscaleFixturePolicy: async ({ page }, policy: string) => {
            await claimNetwork(page);
            await policyFixture().write(policy);
          },
          headscaleOperationCalls: async ({
            page,
          }): Promise<NetworkOperationCall[]> => {
            await claimNetwork(page);
            return sessionNetwork?.getOperationCalls() ?? [];
          },
          clearHeadscaleOperationCalls: async ({ page }) => {
            await claimNetwork(page);
            sessionNetwork?.clearOperationCalls();
          },
          interceptHeadscaleRequest: (
            { page },
            method: string,
            pathPattern: string,
            failure?: string | { responseBody: unknown } | { rawBody: string },
          ) => interceptHeadscaleRequest(page, method, pathPattern, failure),
          headscaleRequestCaptured: async ({ page }) => {
            await claimNetwork(page);
            return (
              headscaleInterceptions.get(page.context())?.getSnapshot()
                .captured ?? false
            );
          },
          headscaleGateState: async ({ page }) => {
            await claimNetwork(page);
            return (
              headscaleInterceptions.get(page.context())?.getSnapshot() ?? null
            );
          },
          // Browser commands cannot receive null, so "reset" restores the browser's own preference.
          emulateColorScheme: ({ page }, scheme: "light" | "dark" | "reset") =>
            page.emulateMedia({
              colorScheme: scheme === "reset" ? null : scheme,
            }),
          releaseHeadscaleRequest: ({ page }) => releaseHeadscaleRequest(page),
          startNetworkDiagnostics: ({ page }) => startNetworkDiagnostics(page),
          reportNetworkFailures: async ({ page }, failedTest?: string) => {
            await claimNetwork(page);
            const requests = sessionNetwork?.getObservations() ?? [];
            sessionNetwork?.clearObservations();
            const failures = [
              ...(networkFailures.get(page.context())?.splice(0) ?? []),
              ...requests.filter(
                (request) => request.errorText || (request.status ?? 0) >= 400,
              ),
            ];
            if (failedTest)
              console.error(
                "E2E network failures",
                JSON.stringify({ test: failedTest, failures, requests }),
              );
          },
          resetHeadscaleFixture: (_context, blankPolicy?: boolean) =>
            resetHeadscaleFixture(blankPolicy),
        },
        enabled: true,
        headless: true,
        provider: playwright(),
        instances: [{ browser: "chromium" }],
      },
    },
  }),
);
