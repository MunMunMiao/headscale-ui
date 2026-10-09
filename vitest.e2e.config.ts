import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { webdriverio } from "@vitest/browser-webdriverio";
import { defineConfig } from "vitest/config";
import { resetHeadscaleFixture } from "./e2e/headscale-fixture";

const resizeObserverLoopMessage = "ResizeObserver loop completed with undelivered notifications.";
const headscaleE2eUrl = process.env.HEADSCALE_E2E_URL;

// Chrome emits this as an ErrorEvent with no `error`; Vitest Browser then forwards
// it through Vite as noisy test output, not as an application failure.
function suppressKnownResizeObserverNoise() {
  return {
    name: "headscale-ui:suppress-known-resize-observer-noise",
    apply: "serve" as const,
    configureServer(server) {
      const error = server.config.logger.error.bind(server.config.logger);
      server.config.logger.error = (message, options) => {
        if (
          typeof message === "string" &&
          message.includes(resizeObserverLoopMessage) &&
          (message.includes("[Unhandled error]") || message.includes("[console.error]"))
        ) {
          return;
        }
        error(message, options);
      };
    },
  };
}

export default defineConfig({
  plugins: [suppressKnownResizeObserverNoise(), vue(), tailwindcss()],
  server: headscaleE2eUrl
    ? {
        proxy: {
          "/__headscale-e2e": {
            target: headscaleE2eUrl,
            changeOrigin: true,
            rewrite: (path) => path.replace(/^\/__headscale-e2e/, ""),
          },
        },
      }
    : undefined,
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["e2e/**/*.test.ts"],
    // beforeEach does an IDB delete + hydrate (device key + legacy migration scan), adding
    // roughly 0.5-1s per test. Bump per-test timeout to absorb that overhead.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    deps: {
      optimizer: {
        web: {
          include: ["vue-router"],
        },
      },
    },
    browser: {
      commands: {
        reportNetworkFailures: async ({ browser }, failedTest?: string) => {
          // Drain Chrome's existing error log after each test; never return raw records.
          const records = await browser.getLogs("browser");
          if (!failedTest) return;
          const failures = [];
          for (const record of records) {
            if (record.source !== "network" && record.source !== "javascript") continue;
            const status = record.message.match(/status of (\d{3})(?: \(([^)]+)\))?/);
            const errorText = record.message.match(/net::ERR_[A-Z0-9_]+/)?.[0];
            const mimeType = record.message.match(/MIME type of "([^"]+)"/)?.[1];
            if (!status && !errorText && !mimeType) continue;
            const url = record.message.match(/https?:\/\/[^\s"'<>]+/)?.[0];
            if (!url) continue;
            const { pathname } = new URL(url);
            if (
              !pathname.startsWith("/src/") &&
              !pathname.includes("/node_modules/") &&
              !pathname.startsWith("/@") &&
              !pathname.startsWith("/__headscale-e2e/")
            )
              continue;
            failures.push({
              timestamp: record.timestamp,
              path: pathname,
              status: status ? Number(status[1]) : undefined,
              statusText: status?.[2],
              mimeType,
              errorText,
            });
          }
          console.error("E2E network failures", JSON.stringify({ test: failedTest, failures }));
        },
        resetHeadscaleFixture: (_context, blankPolicy?: boolean) =>
          resetHeadscaleFixture(blankPolicy),
      },
      enabled: true,
      headless: true,
      provider: webdriverio({
        capabilities: {
          "wdio:enforceWebDriverClassic": true,
        },
      }),
      instances: [{ browser: "chrome" }],
    },
  },
});
