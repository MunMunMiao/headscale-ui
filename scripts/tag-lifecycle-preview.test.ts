import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import { afterEach, expect, test, vi } from "vitest";
import {
  createTagLifecycleFixture,
  type TagLifecycleFixture,
} from "./harness/tag-lifecycle.ts";
import {
  runTagLifecyclePreview,
  tagPreviewInitialization,
} from "./tag-lifecycle-preview.ts";

type Middleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) => void;
function initializer() {
  let handler: Middleware | undefined;
  const plugin = tagPreviewInitialization("http://127.0.0.1:4179", {
    apiKey: "synthetic-only-key",
    password: "synthetic-only-password",
    profileName: "Fixture",
  });
  const server = {
    middlewares: {
      use: (callback: Middleware) => {
        handler = callback;
      },
    },
    transformIndexHtml: async (_url: string, html: string) => html,
  } as unknown as ViteDevServer;
  if (typeof plugin.configureServer !== "function")
    throw new Error("Expected a preview middleware");
  plugin.configureServer.call({} as never, server);
  return (patch: Partial<IncomingMessage> = {}) => {
    const headers: Record<string, string> = {};
    let body = "";
    const response = {
      statusCode: 200,
      setHeader: (key: string, value: string) => {
        headers[key] = value;
      },
      end: (value: string) => {
        body = value;
      },
    };
    if (!handler) throw new Error("Expected an initialization request handler");
    handler(
      {
        url: "/__tag-preview-credentials",
        method: "POST",
        headers: {
          host: "127.0.0.1:4179",
          origin: "http://127.0.0.1:4179",
          "sec-fetch-site": "same-origin",
          "sec-fetch-dest": "empty",
        },
        ...patch,
      } as IncomingMessage,
      response as unknown as ServerResponse,
      () => {},
    );
    return {
      get status() {
        return response.statusCode;
      },
      headers,
      get body() {
        return body;
      },
    };
  };
}

test("initializer document retains the application device-width viewport for mobile layout", async () => {
  const response = initializer()({
    url: "/__tag-preview-init",
    method: "GET",
    headers: {
      host: "127.0.0.1:4179",
      "sec-fetch-site": "none",
      "sec-fetch-dest": "document",
    },
  });
  await expect.poll(() => response.body).toContain("<!doctype html>");
  expect(response.status).toBe(200);
  expect(response.body).toContain(
    '<meta name="viewport" content="width=device-width, initial-scale=1.0"',
  );
});

test("preview credentials reject GET, foreign origins and embedding without consuming the one-time response", () => {
  const request = initializer();
  for (const patch of [
    { method: "GET" },
    {
      headers: {
        host: "foreign.test",
        origin: "http://foreign.test",
        "sec-fetch-site": "cross-site",
        "sec-fetch-dest": "empty",
      },
    },
    {
      headers: {
        host: "127.0.0.1:4179",
        origin: "http://127.0.0.1:4179",
        "sec-fetch-site": "same-origin",
        "sec-fetch-dest": "iframe",
      },
    },
  ]) {
    const denied = request(patch);
    expect(denied.status).toBe(403);
    expect(denied.body).not.toContain("synthetic-only");
  }
  const first = request();
  expect(first.status).toBe(200);
  expect(first.headers["Cache-Control"]).toBe("no-store");
  expect(JSON.parse(first.body)).toMatchObject({
    baseUrl: "http://127.0.0.1:4179",
    apiKey: "synthetic-only-key",
  });
  const repeated = request();
  expect(repeated.status).toBe(410);
  expect(repeated.body).not.toContain("synthetic-only");
});

vi.mock("vite", () => ({ createServer: vi.fn() }));
vi.mock("./harness/tag-lifecycle.ts", async (original) => ({
  ...(await original<typeof import("./harness/tag-lifecycle.ts")>()),
  createTagLifecycleFixture: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

test("SIGTERM during fixture startup waits for owned resources and never starts a preview server", async () => {
  const pending = Promise.withResolvers<TagLifecycleFixture>();
  vi.mocked(createTagLifecycleFixture).mockReturnValue(pending.promise);
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
  const close = vi.fn(async () => {});
  const policy = vi.fn(async () => ({}));
  const running = runTagLifecyclePreview();
  if (!terminate) throw new Error("Expected a SIGTERM handler");
  const stopped = terminate();
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      exit,
      "process must not exit while the fixture factory still owns live resources",
    ).not.toHaveBeenCalled();
    pending.resolve({ close, policy } as unknown as TagLifecycleFixture);
    await Promise.all([running, stopped]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(policy).not.toHaveBeenCalled();
    expect(createServer).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(143);
  } finally {
    pending.reject(new Error("Finish the synthetic startup"));
    await Promise.all([running, stopped]);
  }
});

test("Vite direct and concurrent shutdown await the same owned fixture cleanup before exit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tag-preview-close-test-"));
  const pending = Promise.withResolvers<void>();
  const fixtureClose = vi.fn(() => pending.promise);
  vi.mocked(createTagLifecycleFixture).mockResolvedValue({
    directory,
    project: "synthetic-only-project",
    baseUrl: "http://127.0.0.1:49152",
    users: { alice: "1" },
    policy: async () => {},
    key: async () => ({ key: "synthetic-only-key" }),
    client: async () => ({}),
    register: async () => {},
    nodes: async () => [],
    connection: () => ({ apiKey: "synthetic-only-key" }),
    close: fixtureClose,
  } as unknown as TagLifecycleFixture);
  vi.spyOn(process, "on").mockImplementation(() => process);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  let plugins: Plugin[] = [];
  const server = {
    listen: async () => {},
    close: async () => {
      for (const plugin of plugins)
        if (typeof plugin.closeServer === "function")
          await plugin.closeServer.call(
            {} as never,
            { reason: "close" } as never,
          );
    },
  } as unknown as ViteDevServer;
  vi.mocked(createServer)
    .mockReset()
    .mockImplementation(async (options) => {
      plugins = options?.plugins as Plugin[];
      return server;
    });
  const exited = vi.fn();
  let closing: Promise<unknown>[] = [];
  try {
    await runTagLifecyclePreview();
    // Vite's own SIGTERM/stdin-end handler calls close then process.exit, not our signal cleanup.
    closing = [server.close().then(exited), server.close().then(exited)];
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      fixtureClose,
      "Vite shutdown must enter the owned resource cleanup hook",
    ).toHaveBeenCalledTimes(1);
    expect(
      exited,
      "Vite must not exit before fixture cleanup settles",
    ).not.toHaveBeenCalled();
    pending.resolve();
    await Promise.all(closing);
    expect(exited).toHaveBeenCalledTimes(2);
    expect(fixtureClose).toHaveBeenCalledTimes(1);
  } finally {
    pending.resolve();
    await Promise.all(closing);
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each(["SIGTERM", "Vite close"] as const)(
  "%s releases the owned fixture before Vite reaches its delayed close hooks",
  async (source) => {
    const directory = mkdtempSync(
      join(tmpdir(), "tag-preview-delayed-close-test-"),
    );
    const pendingServer = Promise.withResolvers<void>();
    const fixtureClose = vi.fn(async () => {
      rmSync(directory, { recursive: true, force: true });
    });
    vi.mocked(createTagLifecycleFixture).mockResolvedValue({
      directory,
      project: "synthetic-only-project",
      baseUrl: "http://127.0.0.1:49152",
      users: { alice: "1" },
      policy: async () => {},
      key: async () => ({ key: "synthetic-only-key" }),
      client: async () => ({}),
      register: async () => {},
      nodes: async () => [],
      connection: () => ({ apiKey: "synthetic-only-key" }),
      close: fixtureClose,
    } as unknown as TagLifecycleFixture);
    let terminate: (() => Promise<void>) | undefined;
    vi.spyOn(process, "on").mockImplementation((event, listener) => {
      if (String(event) === "SIGTERM")
        terminate = listener as () => Promise<void>;
      return process;
    });
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    let plugins: Plugin[] = [];
    const server = {
      listen: async () => {},
      close: async () => {
        await pendingServer.promise;
        for (const plugin of plugins)
          if (typeof plugin.closeServer === "function")
            await plugin.closeServer.call(
              {} as never,
              { reason: "close" } as never,
            );
      },
    } as unknown as ViteDevServer;
    vi.mocked(createServer)
      .mockReset()
      .mockImplementation(async (options) => {
        plugins = options?.plugins as Plugin[];
        return server;
      });
    let stopped: Promise<void> | undefined;
    try {
      await runTagLifecyclePreview();
      expect(existsSync(directory)).toBe(true);
      if (!terminate) throw new Error("Expected a SIGTERM handler");
      stopped =
        source === "SIGTERM"
          ? terminate()
          : server.close().then(() => process.exit(0));
      await expect
        .poll(() => existsSync(directory), {
          message:
            "owned fixture cleanup must not wait for Vite to reach closeServer hooks",
          timeout: 1000,
        })
        .toBe(false);
      expect(
        exit,
        "shutdown still waits for the Vite server",
      ).not.toHaveBeenCalled();
      pendingServer.resolve();
      await stopped;
      expect(exit).toHaveBeenCalledWith(source === "SIGTERM" ? 143 : 0);
      expect(fixtureClose).toHaveBeenCalledTimes(1);
    } finally {
      pendingServer.resolve();
      await stopped;
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test.each(["fixture", "server"] as const)(
  "%s shutdown failure does not finish closing before the other resource settles",
  async (failing) => {
    const directory = mkdtempSync(
      join(tmpdir(), "tag-preview-close-failure-test-"),
    );
    const pendingFixture = Promise.withResolvers<void>();
    const pendingServer = Promise.withResolvers<void>();
    const failure = new Error(`Synthetic ${failing} shutdown failure`);
    vi.mocked(createTagLifecycleFixture).mockResolvedValue({
      directory,
      project: "synthetic-only-project",
      baseUrl: "http://127.0.0.1:49152",
      users: { alice: "1" },
      policy: async () => {},
      key: async () => ({ key: "synthetic-only-key" }),
      client: async () => ({}),
      register: async () => {},
      nodes: async () => [],
      connection: () => ({ apiKey: "synthetic-only-key" }),
      close: async () => {
        try {
          if (failing === "fixture") throw failure;
          await pendingFixture.promise;
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      },
    } as unknown as TagLifecycleFixture);
    vi.spyOn(process, "on").mockImplementation(() => process);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    let plugins: Plugin[] = [];
    const server = {
      listen: async () => {},
      close: async () => {
        if (failing === "server") throw failure;
        await pendingServer.promise;
        for (const plugin of plugins)
          if (typeof plugin.closeServer === "function")
            await plugin.closeServer.call(
              {} as never,
              { reason: "close" } as never,
            );
      },
    } as unknown as ViteDevServer;
    vi.mocked(createServer)
      .mockReset()
      .mockImplementation(async (options) => {
        plugins = options?.plugins as Plugin[];
        return server;
      });
    let result: unknown = "pending";
    let closing: Promise<void> | undefined;
    try {
      await runTagLifecyclePreview();
      closing = server.close().then(
        () => {
          result = "resolved";
        },
        (error: unknown) => {
          result = error;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(
        result,
        "failure cannot let Vite exit while another owned cleanup is pending",
      ).toBe("pending");
      pendingFixture.resolve();
      pendingServer.resolve();
      await closing;
      expect(
        inspect(result),
        "shutdown failure details must remain observable",
      ).toContain(failure.message);
      expect(
        existsSync(directory),
        "fixture cleanup must run even if Vite fails first",
      ).toBe(false);
    } finally {
      pendingFixture.resolve();
      pendingServer.resolve();
      await closing;
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test.each(["server-only", "both"] as const)(
  "Vite's finally exit retains a nonzero status and safe diagnostics for %s failures",
  async (failing) => {
    const directory = mkdtempSync(
      join(tmpdir(), "tag-preview-exit-error-test-"),
    );
    const secret = "opaque-fixture-value-91";
    const fixtureFailure = new Error(
      `Synthetic fixture close failure\n${secret}`,
    );
    const serverFailure = new Error(`Synthetic Vite close failure\n${secret}`);
    vi.mocked(createTagLifecycleFixture).mockResolvedValue({
      directory,
      project: "synthetic-only-project",
      baseUrl: "http://127.0.0.1:49152",
      users: { alice: "1" },
      policy: async () => {},
      key: async () => ({ key: "synthetic-only-key" }),
      client: async () => ({}),
      register: async () => {},
      nodes: async () => [],
      connection: () => ({ apiKey: secret }),
      close: async () => {
        rmSync(directory, { recursive: true, force: true });
        if (failing === "both") throw fixtureFailure;
      },
    } as unknown as TagLifecycleFixture);
    vi.spyOn(process, "on").mockImplementation(() => process);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitStatuses: number[] = [];
    vi.spyOn(process, "exit").mockImplementation((code) => {
      exitStatuses.push(Number(code ?? process.exitCode ?? 0));
      return undefined as never;
    });
    const server = {
      listen: async () => {},
      close: async () => {
        throw serverFailure;
      },
    } as unknown as ViteDevServer;
    vi.mocked(createServer).mockReset().mockResolvedValue(server);
    let result: unknown;
    try {
      await runTagLifecyclePreview();
      await (async () => {
        try {
          await server.close();
        } finally {
          process.exit();
        }
      })().catch((error: unknown) => {
        result = error;
      });
      expect(
        exitStatuses,
        "Vite's own exit must not report successful cleanup",
      ).toEqual([1]);
      const output = diagnostics.mock.calls
        .map((args) => inspect(args))
        .join("\n");
      expect(
        output,
        "server failure must be diagnosed before Vite's finally exit",
      ).toContain("Synthetic Vite close failure");
      expect(
        inspect(result),
        "server failure must remain observable to close callers",
      ).toContain("Synthetic Vite close failure");
      if (failing === "both") {
        expect(output).toContain("Synthetic fixture close failure");
        expect(inspect(result)).toContain("Synthetic fixture close failure");
      }
      expect(
        `${output}\n${inspect(result)}`,
        "cleanup errors must not carry credentials",
      ).not.toContain(secret);
      expect(existsSync(directory)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
