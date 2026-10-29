import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterEach, expect, test, vi } from "vitest";
import { launchNativeBrowser } from "./native-browser";

afterEach(() => vi.restoreAllMocks());

test.each(["early exit", "CDP failure", "timeout"])(
  "native Chromium %s preserves a safe stderr tail before removing its profile",
  async (mode) => {
    const parent = mkdtempSync(join(tmpdir(), "native-diagnostic-test-"));
    const stderr = `${"obsolete diagnostic\n".repeat(2000)}Authorization: Bearer native-secret\npassword=profile-secret\nhttps://user:url-secret@example.test\nChromium sandbox initialization failed\n`;
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `process.stderr.write(${JSON.stringify(stderr)}); console.log('ready'); ${mode === "early exit" ? "process.exitCode = 23;" : "setInterval(() => {}, 1000);"}`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    await child.stdout.getReader().read();
    if (mode === "early exit") await child.exited;
    if (mode === "timeout")
      vi.spyOn(performance, "now")
        .mockReturnValueOnce(0)
        .mockReturnValue(15001);
    const original = new Error("CDP handshake failed");
    vi.spyOn(chromium, "connectOverCDP").mockRejectedValue(original);
    vi.spyOn(Bun, "spawn").mockImplementation((command) => {
      if (!Array.isArray(command))
        throw new Error("Expected command arguments");
      const profile = command
        .find((argument) => argument.startsWith("--user-data-dir="))
        ?.split("=")[1];
      if (mode === "CDP failure" && profile)
        writeFileSync(
          join(profile, "DevToolsActivePort"),
          "12345\n/devtools/browser/test",
        );
      return child;
    });
    const reports: string[] = [];
    const profilePresent: boolean[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => {
      reports.push(args.join(" "));
      profilePresent.push(readdirSync(parent).length > 0);
    });
    try {
      const launched = launchNativeBrowser(parent);
      if (mode === "early exit")
        await expect(launched).rejects.toThrow(
          "Native Chromium exited before debugging became available",
        );
      else if (mode === "timeout")
        await expect(launched).rejects.toThrow(
          "Condition did not become ready",
        );
      else await expect(launched).rejects.toBe(original);
      const output = reports.join("\n");
      expect(output).toContain("Chromium sandbox initialization failed");
      expect(output.length).toBeLessThan(9000);
      for (const secret of ["native-secret", "profile-secret", "url-secret"])
        expect(output).not.toContain(secret);
      expect(profilePresent).toContain(true);
      expect(readdirSync(parent)).toEqual([]);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      child.kill();
      await child.exited;
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

test("successful native launch stays quiet and disposes its process and profile only once", async () => {
  const parent = mkdtempSync(join(tmpdir(), "native-success-test-"));
  const child = Bun.spawn(
    [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    {
      stderr: "pipe",
    },
  );
  const context = {};
  const close = vi.fn(async () => {});
  const browser = { contexts: () => [context], close } as unknown as Browser;
  vi.spyOn(chromium, "connectOverCDP").mockResolvedValue(browser);
  vi.spyOn(Bun, "spawn").mockImplementation((command) => {
    const profile = command
      .find((argument) => argument.startsWith("--user-data-dir="))
      ?.split("=")[1];
    if (!profile) throw new Error("Missing native browser profile");
    writeFileSync(
      join(profile, "DevToolsActivePort"),
      "12345\n/devtools/browser/test",
    );
    return child;
  });
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const launched = await launchNativeBrowser(parent);
    expect(launched.browser).toBe(browser);
    expect(launched.context).toBe(context);
    expect(child.exitCode).toBeNull();
    await Promise.all([launched.dispose(), launched.dispose()]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(readdirSync(parent)).toEqual([]);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(diagnostic).not.toHaveBeenCalled();
  } finally {
    child.kill();
    await child.exited;
    rmSync(parent, { recursive: true, force: true });
  }
});

test("stderr read, cancellation and reporting failures cannot hide the original Chromium failure", async () => {
  const parent = mkdtempSync(join(tmpdir(), "native-diagnostic-failure-"));
  const child = Bun.spawn([process.execPath, "-e", "process.exitCode = 23"], {
    stderr: "pipe",
  });
  await child.exited;
  const reader = child.stderr.getReader();
  vi.spyOn(reader, "read").mockRejectedValue(
    new Error("diagnostic read failed"),
  );
  vi.spyOn(reader, "cancel").mockRejectedValue(
    new Error("diagnostic cancel failed"),
  );
  vi.spyOn(child.stderr, "getReader").mockReturnValue(reader);
  vi.spyOn(Bun, "spawn").mockReturnValue(child);
  vi.spyOn(console, "error").mockImplementation(() => {
    throw new Error("diagnostic writer failed");
  });
  try {
    await expect(launchNativeBrowser(parent)).rejects.toThrow(
      "Native Chromium exited before debugging became available",
    );
    expect(readdirSync(parent)).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    await reader.cancel();
    rmSync(parent, { recursive: true, force: true });
  }
});
