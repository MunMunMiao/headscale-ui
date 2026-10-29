import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createChildRunner } from "./child-runner";
import { createCleanup, root } from "./docker";
import { createTagLifecycleRunner } from "./tag-lifecycle";

const signals = ["SIGINT", "SIGTERM"] as const;
const signalListeners = new Map(
  signals.map((signal) => [signal, process.listeners(signal)]),
);

afterEach(() => {
  vi.restoreAllMocks();
  for (const [signal, original] of signalListeners) {
    for (const listener of process.listeners(signal)) {
      if (!original.includes(listener))
        process.removeListener(signal, listener);
    }
  }
});

test.each(["repeat", ...signals] as const)(
  "%s waits for every in-flight cleanup step without running it twice",
  async (trigger) => {
    const held = Promise.withResolvers<void>();
    const steps: string[] = [];
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    const cleanup = createCleanup("fixture", [
      async () => {
        steps.push("start");
        await held.promise;
      },
      () => steps.push("removed"),
    ]);
    const first = cleanup();
    let settled = false;
    const listener =
      trigger === "repeat" ? undefined : process.listeners(trigger).at(-1);
    const repeated = Promise.resolve(
      listener
        ? (listener as (signal: NodeJS.Signals) => void)(
            trigger as NodeJS.Signals,
          )
        : cleanup(),
    ).then(() => {
      settled = true;
    });
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(exit).not.toHaveBeenCalled();
      expect(steps).toEqual(["start"]);
    } finally {
      held.resolve();
      await Promise.all([first, repeated]);
    }
    await cleanup();
    expect(steps).toEqual(["start", "removed"]);
    if (trigger !== "repeat")
      expect(exit).toHaveBeenCalledWith(trigger === "SIGINT" ? 130 : 143);
  },
);

type Resource = {
  kind: "container" | "network" | "volume";
  name: string;
  owner: string;
};
type ResourceState = { resources: Resource[]; directories: string[] };

test.each([
  { phase: "primary", exit: "SIGTERM" },
  { phase: "alternate", exit: "SIGTERM" },
  { phase: "alternate", exit: "SIGKILL" },
  { phase: "alternate", exit: "normal" },
] as const)(
  "the parent reclaims only its resources after $exit during $phase fixture startup",
  async ({ phase, exit }) => {
    const evidence = mkdtempSync(join(tmpdir(), "headscale-interrupt-test-"));
    const statePath = join(evidence, "resources.json");
    const readyPath = join(evidence, "ready");
    const cleanupStarted = join(evidence, "cleanup-started");
    const cleanupFinished = join(evidence, "cleanup-finished");
    const foreignDirectory = join(evidence, "independent-preview");
    mkdirSync(foreignDirectory);
    writeFileSync(join(foreignDirectory, "config.yaml"), "independent preview");
    const foreign: Resource[] = ["container", "volume", "network"].map(
      (kind) => ({
        kind: kind as Resource["kind"],
        name: `independent-preview-${kind}`,
        owner: "headscale-tag-lifecycle-independent-preview",
      }),
    );
    writeFileSync(
      statePath,
      JSON.stringify({ resources: foreign, directories: [] }),
    );
    const state = () =>
      JSON.parse(readFileSync(statePath, "utf8")) as ResourceState;
    const originalExitCode = process.exitCode;
    const runner = createChildRunner(root);
    const lifecycle = createTagLifecycleRunner(runner);
    // Only the external Docker boundary is replaced. The fixture, Bun child, OS signal,
    // Vitest Logger and parent child-runner all execute their real implementations.
    vi.spyOn(Bun, "spawnSync").mockImplementation((command) => {
      if (!Array.isArray(command) || command[0] !== "docker")
        throw new Error("Unexpected parent subprocess");
      const args = command.slice(1) as string[];
      const kind = args[0] as Resource["kind"];
      const current = state();
      let stdout = "";
      if (args[1] === "ls") {
        const filter = args[args.indexOf("--filter") + 1];
        stdout = current.resources
          .filter(
            (item) =>
              item.kind === kind &&
              filter === `label=io.headscale-ui.tag-lifecycle=${item.owner}`,
          )
          .map((item) => item.name)
          .join("\n");
      } else {
        const item = current.resources.find(
          (item) => item.kind === kind && item.name === args.at(-1),
        );
        if (!item) throw new Error(`Unknown test resource: ${args.join(" ")}`);
        if (args[1] === "inspect") stdout = item.owner;
        else if (args[1] === "rm") {
          if (
            kind === "container" &&
            item.name.endsWith("-network") &&
            current.resources.some(
              (entry) =>
                entry.kind === "container" &&
                entry !== item &&
                entry.name.startsWith(item.name.slice(0, -"network".length)),
            )
          )
            throw new Error("Network namespace keeper still has dependents");
          current.resources = current.resources.filter(
            (entry) => entry !== item,
          );
          writeFileSync(statePath, JSON.stringify(current));
        } else
          throw new Error(`Unexpected test Docker call: ${args.join(" ")}`);
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(stdout),
        stderr: Buffer.alloc(0),
      } as ReturnType<typeof Bun.spawnSync>;
    });
    const child = `
import { dirname, join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Logger } from "vitest/node";
import { createCleanup } from ${JSON.stringify(join(root, "scripts/harness/docker.ts"))};
import { createTagLifecycleFixture } from ${JSON.stringify(join(root, "scripts/harness/tag-lifecycle.ts"))};
const statePath = process.env.INTERRUPT_STATE;
const evidence = dirname(statePath);
Bun.spawnSync = (command) => {
  const args = command.slice(1);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  let stdout = "";
  if (command[0] === "docker") {
    const kind = args[0] === "run" ? "container" : args[0];
    if (args[0] === "run" || args[1] === "create") {
      const name = args[0] === "run" ? args[args.indexOf("--name") + 1] : args.at(-1);
      const owner = args[args.indexOf("--label") + 1].split("=")[1];
      state.resources.push({ kind, name, owner });
      if (name.endsWith("-headscale")) {
        const config = args.find((arg) => arg.endsWith(":/etc/headscale/config.yaml:ro"));
        state.directories.push(dirname(config.split(":")[0]));
      }
      writeFileSync(statePath, JSON.stringify(state));
    } else if (args[0] === "port") stdout = "127.0.0.1:49152";
    else if (args.includes("apikeys")) stdout = "synthetic-only-key";
  }
  return { exitCode: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) };
};
let versions = 0;
globalThis.fetch = async (url) => {
  if (url.endsWith("/version")) {
    if (++versions === ${phase === "primary" ? 1 : 2}) {
      writeFileSync(join(evidence, "ready"), JSON.stringify({
        pid: process.pid,
        owner: process.env.HEADSCALE_TAG_LIFECYCLE_OWNER,
        directory: process.env.HEADSCALE_TAG_LIFECYCLE_DIRECTORY,
      }));
      ${
        exit === "normal"
          ? 'while (!existsSync(join(evidence, "release"))) await Bun.sleep(10);'
          : "await new Promise(() => {});"
      }
    }
    return Response.json({ version: "v0.29.6+dirty" });
  }
  return Response.json(url.endsWith("/user") ? { user: { id: "1" } } : {});
};
let primary, alternate, starting;
createCleanup("Interrupted fixture", [
  () => writeFileSync(join(evidence, "cleanup-started"), "started"),
  async () => { await starting; },
  () => primary?.close(),
  () => alternate?.close(),
  () => writeFileSync(join(evidence, "cleanup-finished"), "finished"),
]);
new Logger().setVitest({ onClose() {} });
starting = (async () => {
  primary = await createTagLifecycleFixture();
  ${phase === "alternate" ? "alternate = await createTagLifecycleFixture();" : ""}
})();
const keepAlive = setInterval(() => {}, 1000);
await starting;
clearInterval(keepAlive);
`;
    const finished = lifecycle
      .run([process.execPath, "-e", child], {
        ...process.env,
        INTERRUPT_STATE: statePath,
      })
      .then(
        () => 0,
        () => process.exitCode,
      );
    let ownedDirectory: string | undefined;
    try {
      await expect.poll(() => existsSync(readyPath)).toBe(true);
      const ready = JSON.parse(readFileSync(readyPath, "utf8")) as {
        pid: number;
        owner: string;
        directory: string;
      };
      ownedDirectory = ready.directory;
      expect(ready.owner).toMatch(/^headscale-tag-lifecycle-run-/);
      expect(state().directories).toHaveLength(phase === "primary" ? 1 : 2);
      expect(
        state().directories.every(
          (directory) => dirname(directory) === ready.directory,
        ),
      ).toBe(true);
      expect(
        state()
          .resources.filter(
            (item) => !item.name.startsWith("independent-preview"),
          )
          .every((item) => item.owner === ready.owner),
      ).toBe(true);
      if (exit === "normal")
        writeFileSync(join(evidence, "release"), "release");
      else if (exit === "SIGKILL") process.kill(ready.pid, "SIGKILL");
      else await runner.terminateActive();
      expect(await finished).toBe(
        exit === "normal" ? 0 : exit === "SIGTERM" ? 143 : 137,
      );
      expect(existsSync(cleanupStarted)).toBe(exit === "SIGTERM");
      expect(existsSync(cleanupFinished)).toBe(false);
      lifecycle.cleanup();
      expect(existsSync(ready.directory)).toBe(false);
      expect(state().resources).toEqual(foreign);
      expect(
        state().directories.every((directory) => !existsSync(directory)),
      ).toBe(true);
      expect(readFileSync(join(foreignDirectory, "config.yaml"), "utf8")).toBe(
        "independent preview",
      );
    } finally {
      await runner.terminateActive();
      await finished;
      process.exitCode = originalExitCode;
      for (const directory of state().directories)
        rmSync(directory, { recursive: true, force: true });
      if (ownedDirectory)
        rmSync(ownedDirectory, { recursive: true, force: true });
      rmSync(evidence, { recursive: true, force: true });
    }
  },
);
