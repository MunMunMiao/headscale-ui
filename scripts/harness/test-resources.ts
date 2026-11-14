/// <reference lib="esnext.disposable" />
import { test as base } from "vitest";

export { runTestCommand } from "./test-command";

export type TestResources = {
  files: AsyncDisposableStack;
  tasks: AsyncDisposableStack;
};

export const test = base.extend<{ resources: TestResources }>({
  resources: async ({ signal, onTestFinished }, use) => {
    signal.throwIfAborted();
    const files = new AsyncDisposableStack();
    const tasks = new AsyncDisposableStack();
    // 原生结束钩子受 hookTimeout 约束，fixture 的裸 finally 不受该预算保护。
    onTestFinished(async () => {
      await using cleanup = new AsyncDisposableStack();
      cleanup.defer(() => files.disposeAsync());
      cleanup.defer(() => tasks.disposeAsync());
    });
    await use({ files, tasks });
  },
});
