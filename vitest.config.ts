import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

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
        thresholds: { perFile: true, statements: 100, branches: 100, functions: 100, lines: 100 },
      },
      projects: [
        {
          extends: true,
          test: {
            name: "unit",
            pool: "forks",
            include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
            exclude: ["src/**/*.browser.test.ts", "src/test-utils/**"],
          },
        },
        {
          extends: true,
          optimizeDeps: {
            include: ["@base-ui/react/*", "@defjs/core", "@tanstack/react-router", "effect"],
          },
          test: {
            name: "browser",
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
      ],
    },
  }),
);
