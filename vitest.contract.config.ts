import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "contract",
    pool: "forks",
    include: ["e2e/**/*.contract.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
