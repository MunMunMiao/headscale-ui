import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createChildRunner } from "./child-runner";
import { root } from "./docker";
import {
  createTagLifecycleFixture,
  createTagLifecycleRunner,
  tagLifecycleDiagnostics,
} from "./tag-lifecycle";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("tag fixture diagnostics never expose a one-time authentication request", () => {
  const authId = `hskey-authreq-${"a".repeat(24)}`;
  const result = tagLifecycleDiagnostics(
    `waiting for http://headscale:8080/register/${authId}\nfixture node persisted`,
  );
  expect(result).not.toContain(authId);
  expect(result).toContain("fixture node persisted");
});

test("cleanup preserves owned recovery files when a Docker removal fails", async () => {
  let project = "";
  let failRemoval = false;
  vi.spyOn(Bun, "spawnSync").mockImplementation((command) => {
    if (!Array.isArray(command)) throw new Error("Expected command arguments");
    const args = command as string[];
    if (args[0] === "docker" && args[1] === "network" && args[2] === "create")
      project = args.at(-1) ?? "";
    const failed =
      failRemoval && args[1] === "rm" && args.at(-1) === `${project}-headscale`;
    const stdout =
      args[1] === "port"
        ? "127.0.0.1:49152"
        : args.includes("inspect")
          ? project
          : args.includes("apikeys")
            ? "synthetic-test-key"
            : "";
    return {
      exitCode: failed ? 1 : 0,
      stdout: Buffer.from(stdout),
      stderr: Buffer.from(failed ? "synthetic removal failure" : ""),
    } as ReturnType<typeof Bun.spawnSync>;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      Response.json(
        url.endsWith("/version")
          ? { version: "v0.29.6+dirty" }
          : url.endsWith("/user")
            ? { user: { id: "1" } }
            : {},
      ),
    ),
  );
  const fixture = await createTagLifecycleFixture();
  try {
    failRemoval = true;
    await expect(fixture.close()).rejects.toThrow("cleanup failed");
    expect(existsSync(join(fixture.directory, "config.yaml"))).toBe(true);
  } finally {
    // Docker is stubbed throughout this test; only this newly created temporary directory exists.
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test.each(["owner changed", "removal failed"])(
  "parent cleanup retains recovery files and continues other removals when %s",
  async (failure) => {
    let directory = "";
    let owner = "";
    let recovered = false;
    const remaining = new Set(["container", "volume", "network"]);
    const runner = createChildRunner(root);
    vi.spyOn(runner, "run").mockImplementation(async (_cmd, env) => {
      directory = env?.HEADSCALE_TAG_LIFECYCLE_DIRECTORY ?? "";
      owner = env?.HEADSCALE_TAG_LIFECYCLE_OWNER ?? "";
      writeFileSync(join(directory, "recovery.yaml"), "owned recovery config");
    });
    vi.spyOn(Bun, "spawnSync").mockImplementation((command) => {
      if (!Array.isArray(command) || command[0] !== "docker")
        throw new Error("Expected Docker arguments");
      const [, kind, operation] = command as string[];
      let stdout = "";
      let failed = false;
      if (operation === "ls") {
        if (remaining.has(kind)) stdout = `owned-${kind}`;
      } else if (operation === "inspect")
        stdout =
          !recovered && kind === "container" && failure === "owner changed"
            ? "independent-preview-owner"
            : owner;
      else if (operation === "rm") {
        failed =
          !recovered && kind === "container" && failure === "removal failed";
        if (!failed) remaining.delete(kind);
      } else throw new Error(`Unexpected Docker operation: ${operation}`);
      return {
        exitCode: failed ? 1 : 0,
        stdout: Buffer.from(stdout),
        stderr: Buffer.from(failed ? "synthetic removal failure" : ""),
      } as ReturnType<typeof Bun.spawnSync>;
    });
    const lifecycle = createTagLifecycleRunner(runner);
    try {
      await expect(lifecycle.run(["synthetic-child"])).rejects.toThrow(
        "cleanup failed; recovery files retained",
      );
      expect(remaining).toEqual(new Set(["container"]));
      expect(existsSync(join(directory, "recovery.yaml"))).toBe(true);
      recovered = true;
      lifecycle.cleanup();
      lifecycle.cleanup();
      expect(remaining.size).toBe(0);
      expect(existsSync(directory)).toBe(false);
    } finally {
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  },
);

test.each([
  {
    owner: "headscale-tag-lifecycle-run-1-00000000-0000-0000-0000-000000000000",
    directory: undefined,
  },
  { owner: undefined, directory: "/tmp" },
  { owner: "", directory: "/tmp" },
  {
    owner: "headscale-tag-lifecycle-run-1-00000000-0000-0000-0000-000000000000",
    directory: "/",
  },
])(
  "rejects incomplete or unowned parent scope before Docker writes ($owner, $directory)",
  async ({ owner, directory }) => {
    vi.stubEnv("HEADSCALE_TAG_LIFECYCLE_OWNER", owner);
    vi.stubEnv("HEADSCALE_TAG_LIFECYCLE_DIRECTORY", directory);
    const spawn = vi.spyOn(Bun, "spawnSync");
    await expect(createTagLifecycleFixture()).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  },
);
