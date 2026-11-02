import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

const toolchainTests = [
  "scripts/check-i18n.test.ts",
  "scripts/session-worker-build.test.ts",
  "scripts/harness/test-resources.test.ts",
];

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // Waiting for a condition is bounded generously so heavy machine load does not fail polls.
      expect: { poll: { timeout: 5000 } },
      coverage: {
        provider: "istanbul",
        include: ["src/**/*.{ts,tsx}"],
        exclude: [
          "src/**/*.test.{ts,tsx}",
          "src/**/*.browser.test.tsx",
          "src/test/**",
          "src/test-utils/**",
          "src/i18n/locales/**",
          "src/components/ui/{alert-dialog,badge,button,calendar,card,checkbox,dialog,dropdown-menu,input,label,native-select,popover,switch,table,tabs}{.tsx,/**}",
          "src/**/*.d.ts",
        ],
        reporter: ["text", "html", "lcov", "json-summary"],
        // Every statement, branch, function and line in every covered file.
        thresholds: {
          perFile: true,
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
      },
      // 按运行时分组，避免浏览器、密码派生和嵌套 CLI 同时争用资源。
      projects: [
        {
          extends: true,
          test: {
            name: "unit",
            pool: "forks",
            include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
            exclude: [
              "src/**/*.browser.test.ts",
              "src/test-utils/**",
              ...toolchainTests,
            ],
          },
        },
        {
          extends: true,
          optimizeDeps: {
            include: [
              "@base-ui/react/*",
              "@defjs/core",
              "@tanstack/react-form",
              "@tanstack/react-router",
              "effect",
            ],
          },
          test: {
            name: "browser",
            sequence: { groupOrder: 1 },
            // The browser default is 15s, and a click only gets the time left in that budget.
            // A loaded CI runner then fails a scenario that finishes locally.
            testTimeout: 60_000,
            hookTimeout: 60_000,
            // Keep the browser URL and listener on one loopback address during parallel runs.
            api: { host: "127.0.0.1" },
            include: ["src/**/*.test.tsx", "src/**/*.browser.test.ts"],
            setupFiles: ["src/test/browser-setup.ts"],
            browser: {
              enabled: true,
              headless: true,
              provider: playwright(),
              instances: [{ browser: "chromium" }],
            },
          },
        },
        {
          extends: true,
          test: {
            name: "toolchain",
            pool: "forks",
            include: toolchainTests,
            sequence: { groupOrder: 2 },
            maxWorkers: 1,
            // 仅为工具链资源收尾预留预算；用例自身仍保留原有期限。
            hookTimeout: 60_000,
          },
        },
      ],
    },
  }),
);
