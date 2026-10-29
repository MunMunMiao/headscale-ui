import type { ViteDevServer } from "vite";
import { afterEach, expect, test, vi } from "vitest";
import { createSessionNetwork } from "./harness/session-network.ts";
import {
  createTagLifecycleFixture,
  type TagLifecycleFixture,
} from "./harness/tag-lifecycle.ts";

vi.mock("./harness/tag-lifecycle.ts", () => ({
  createTagLifecycleFixture: vi.fn(),
}));
vi.mock("./harness/session-network.ts", () => ({
  createSessionNetwork: vi.fn(),
}));
vi.mock("../vite.config.ts", () => ({ default: {} }));
vi.mock("@vitest/browser-playwright", () => ({ playwright: () => ({}) }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  process.exitCode = 0;
});

function syntheticFixture() {
  return {
    baseUrl: "http://127.0.0.1:49152",
    close: vi.fn(async () => {}),
    policy: vi.fn(async () => {}),
    sql: vi.fn(() => []),
    key: vi.fn(async () => ({ key: "synthetic-only-key" })),
    client: vi.fn(async () => ({
      name: "fixture",
      container: "synthetic-only-container",
    })),
    register: vi.fn(async () => {}),
    connection: () => ({ apiKey: "synthetic-only-key" }),
  };
}

test.each(["primary", "alternate"] as const)(
  "SIGTERM waits for the pending %s browser fixture and does not continue setup",
  async (phase) => {
    const pending = Promise.withResolvers<TagLifecycleFixture>();
    const primary = syntheticFixture();
    const owned = phase === "primary" ? primary : syntheticFixture();
    vi.mocked(createTagLifecycleFixture).mockReset();
    if (phase === "alternate")
      vi.mocked(createTagLifecycleFixture).mockResolvedValueOnce(
        primary as unknown as TagLifecycleFixture,
      );
    vi.mocked(createTagLifecycleFixture).mockReturnValueOnce(pending.promise);
    const networkClose = vi.fn(async () => {});
    vi.mocked(createSessionNetwork)
      .mockReset()
      .mockReturnValue({
        url: "http://127.0.0.1:49153",
        close: networkClose,
      } as unknown as ReturnType<typeof createSessionNetwork>);
    let terminate: (() => Promise<void>) | undefined;
    vi.spyOn(process, "on").mockImplementation((event, listener) => {
      if (String(event) === "SIGTERM")
        terminate = listener as () => Promise<void>;
      return process;
    });
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const config = (await import("../vitest.tag-lifecycle.config.ts"))
      .default as unknown as {
      plugins: { configureServer(server: ViteDevServer): Promise<void> }[];
      test: {
        browser: {
          commands: {
            tagFixtureSecondServer(
              context: unknown,
              id: string,
            ): Promise<unknown>;
          };
        };
      };
    };
    const server = { config: { server: { proxy: {} } } } as ViteDevServer;
    let starting = config.plugins[0].configureServer(server);
    if (phase === "alternate") {
      await starting;
      starting = config.test.browser.commands
        .tagFixtureSecondServer({}, "1")
        .then(() => {});
    }
    // Observe a startup rejection immediately, even if cleanup intentionally stops that command.
    const settled = Promise.allSettled([starting]);
    if (!terminate)
      throw new Error("Expected the browser lane SIGTERM handler");
    const stopping = terminate();
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(
        exit,
        "pending fixture resources must be owned before process exit",
      ).not.toHaveBeenCalled();
      pending.resolve(owned as unknown as TagLifecycleFixture);
      await Promise.all([settled, stopping]);
      expect(owned.close).toHaveBeenCalledTimes(1);
      expect(owned.policy).not.toHaveBeenCalled();
      expect(owned.client).not.toHaveBeenCalled();
      expect(createSessionNetwork).toHaveBeenCalledTimes(
        phase === "primary" ? 0 : 1,
      );
      if (phase === "alternate") {
        expect(primary.close).toHaveBeenCalledTimes(1);
        expect(networkClose).toHaveBeenCalledTimes(1);
      }
      expect(exit).toHaveBeenCalledWith(143);
    } finally {
      pending.resolve(owned as unknown as TagLifecycleFixture);
      await Promise.all([settled, stopping]);
    }
  },
);
