import { afterEach, expect, test, vi } from "vitest";
import { createDeploymentStack } from "./deployment-stack";
import { diagnosticTail, waitForHeadscale } from "./docker";

const signalListeners = new Map(
  (["SIGINT", "SIGTERM"] as const).map((signal) => [
    signal,
    process.listeners(signal),
  ]),
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

test("diagnostic tails redact known bare credentials and discard truncated credential lines", () => {
  expect(
    diagnosticTail("rejected abc123456789 at startup", ["", "abc123456789"]),
  ).toBe("rejected <redacted> at startup");
  expect(
    diagnosticTail(
      `Authorization: Bearer ${"x".repeat(10000)}\nuseful failure`,
    ),
  ).toBe("useful failure");
  expect(diagnosticTail("Authorization: Bearer opaque-value")).toBe(
    "<redacted>",
  );
  expect(diagnosticTail("opaque-value".repeat(1000))).toBe("");
  expect(diagnosticTail("token\n".repeat(2000)).length).toBeLessThanOrEqual(
    8192,
  );
});

function result(stdout = "", stderr = "", exitCode = 0) {
  return {
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    exitCode,
    success: exitCode === 0,
    signalCode: undefined,
    resourceUsage: {
      contextSwitches: { voluntary: 0, involuntary: 0 },
      cpuTime: { user: 0n, system: 0n, total: 0n },
      maxRSS: 0,
      messages: { sent: 0, received: 0 },
      ops: { in: 0, out: 0 },
      shmSize: 0,
      signalCount: 0,
      swapCount: 0,
    },
    pid: 1,
  };
}

function headscaleProcess(logs: () => ReturnType<typeof result>) {
  vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);
  return vi.spyOn(Bun, "spawnSync").mockImplementation((command) => {
    if (!Array.isArray(command)) throw new Error("Expected command arguments");
    if (command.join(" ") === "docker exec unhealthy headscale health") {
      return result(
        "health probe: database unavailable",
        "Authorization: Bearer health-secret",
        1,
      );
    }
    if (command[1] === "logs") return logs();
    throw new Error(`Unexpected subprocess: ${command.join(" ")}`);
  });
}

test("Headscale timeout retains bounded, redacted health and container logs before caller cleanup", async () => {
  const spawn = headscaleProcess(() =>
    result(
      `${"old noisy log\n".repeat(2000)}api_key=log-secret\n`,
      "database open failed: read-only filesystem\nhttps://user:url-secret@example.test/?token=query-secret\n",
    ),
  );
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(waitForHeadscale("unhealthy")).rejects.toThrow(
    "Headscale unhealthy did not become healthy",
  );
  const output = diagnostic.mock.calls.flat().join("\n");
  expect(output).toContain("health probe: database unavailable");
  expect(output).toContain("database open failed: read-only filesystem");
  expect(output.length).toBeLessThan(18_000);
  for (const secret of [
    "health-secret",
    "log-secret",
    "url-secret",
    "query-secret",
  ])
    expect(output).not.toContain(secret);
  const logCall = spawn.mock.calls.find(
    ([command]) => Array.isArray(command) && command[1] === "logs",
  );
  expect(logCall?.[0]).toEqual(["docker", "logs", "--tail", "60", "unhealthy"]);
  expect(logCall?.[1]).toMatchObject({
    timeout: 2000,
    maxBuffer: 65536,
    killSignal: "SIGKILL",
  });
});

test.each(["throws", "fails"])(
  "Headscale log collection that %s cannot replace the health timeout",
  async (mode) => {
    headscaleProcess(() => {
      if (mode === "throws")
        throw new Error("diagnostic failure with private-secret");
      return result("", "diagnostic failure with private-secret", 1);
    });
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(waitForHeadscale("unhealthy")).rejects.toThrow(
      "Headscale unhealthy did not become healthy",
    );
    const output = diagnostic.mock.calls.flat().join("\n");
    expect(output).toContain("logs unavailable");
    expect(output).not.toContain("private-secret");
  },
);

test("a successful Headscale probe does not read logs or emit diagnostics", async () => {
  const spawn = vi.spyOn(Bun, "spawnSync").mockReturnValue(result());
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(waitForHeadscale("ready")).resolves.toBeUndefined();
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(diagnostic).not.toHaveBeenCalled();
});

test("a failed health subprocess keeps the original error even if diagnostic collection also fails", async () => {
  const original = new Error("health subprocess could not start");
  vi.spyOn(Bun, "spawnSync").mockImplementation((command) => {
    if (Array.isArray(command) && command[1] === "exec") throw original;
    throw new Error("diagnostic process could not start");
  });
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(waitForHeadscale("unhealthy")).rejects.toBe(original);
  expect(diagnostic.mock.calls.flat().join("\n")).toContain("logs unavailable");
});

test.each([false, true])(
  "deployment readiness keeps its failure and bounded logs (log failure=%s)",
  async (logsFail) => {
    vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    vi.spyOn(Bun, "spawnSync").mockImplementation((command) => {
      if (!Array.isArray(command))
        throw new Error("Expected command arguments");
      if (command[1] === "port") return result("127.0.0.1:49152");
      if (command[1] === "logs") {
        if (logsFail) throw new Error("logs read failed: private-secret");
        return result(
          `${"noise\n".repeat(4000)}nginx bind failed\npassword=private-secret\n`,
        );
      }
      throw new Error(`Unexpected subprocess: ${command.join(" ")}`);
    });
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const stack = createDeploymentStack("diagnostic-test");
    try {
      await expect(stack.endpoint("unhealthy")).rejects.toThrow(
        "Container did not become ready: unhealthy",
      );
      const output = diagnostic.mock.calls.flat().join("\n");
      expect(output).toContain(
        logsFail ? "logs unavailable" : "nginx bind failed",
      );
      expect(output).not.toContain("private-secret");
      expect(output.length).toBeLessThan(9000);
    } finally {
      await stack.cleanup();
    }
  },
);
