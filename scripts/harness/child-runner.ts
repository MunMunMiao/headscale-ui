/** Async child runner: unlike spawnSync it leaves the event loop free, so signal handlers can stop the child. */
export function createChildRunner(cwd: string, graceMs = 5000) {
  let active: ReturnType<typeof Bun.spawn> | undefined;
  return {
    async run(
      cmd: string[],
      env: NodeJS.ProcessEnv = process.env,
    ): Promise<void> {
      const child = Bun.spawn({
        cmd,
        cwd,
        env,
        stdout: "inherit",
        stderr: "inherit",
      });
      active = child;
      const code = await child.exited;
      if (active === child) active = undefined;
      if (code !== 0) {
        process.exitCode = code;
        throw new Error(`${cmd.join(" ")} failed`);
      }
    },
    /** SIGTERM first (`bun run` forwards it), SIGKILL when the child ignores it. */
    async terminateActive(): Promise<void> {
      const child = active;
      if (!child) return;
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
      try {
        await child.exited;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
