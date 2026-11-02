/// <reference lib="esnext.disposable" />

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === "object"
    ? Reflect.get(error, "code")
    : undefined;
}

export async function runTestCommand(
  command: string[],
  options: {
    cwd: string;
    signal: AbortSignal;
    tasks: AsyncDisposableStack;
    env?: NodeJS.ProcessEnv;
  },
) {
  options.signal.throwIfAborted();
  if (options.tasks.disposed)
    throw new ReferenceError("Test resources are already disposed");
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: true,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutReader = child.stdout.getReader();
  const stderrReader = child.stderr.getReader();
  let finished = false;
  let stopping = false;
  const stop = () => {
    if (finished || stopping) return;
    stopping = true;
    try {
      if (process.platform === "win32") {
        const result = Bun.spawnSync(
          ["taskkill", "/PID", String(child.pid), "/T", "/F"],
          { stdout: "ignore", stderr: "pipe" },
        );
        if (result.exitCode !== 0 && child.exitCode === null)
          throw new Error(`Cannot stop test command: ${result.stderr}`);
      } else {
        try {
          // ponytail: 仅管理命令进程组；自行守护化的工具由调用者登记独立清理。
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (errorCode(error) !== "ESRCH") throw error;
        }
      }
    } finally {
      // 取消读取而不是等待 EOF：脱离进程组的管道持有者不能阻塞收尾。
      void Promise.allSettled([stdoutReader.cancel(), stderrReader.cancel()]);
    }
  };
  const read = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    const decoder = new TextDecoder();
    let text = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return text + decoder.decode();
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
  };
  const stdout = read(stdoutReader);
  const stderr = read(stderrReader);
  const drained = Promise.all([child.exited, stdout, stderr]).catch(
    async (error) => {
      stop();
      await Promise.allSettled([child.exited, stdout, stderr]);
      throw error;
    },
  );
  options.tasks.defer(async () => {
    stop();
    await drained;
  });
  const interrupts = (["SIGINT", "SIGTERM"] as const).map((signal) => {
    const handler = () => {
      stop();
      // 不覆盖已有处理器；没有其它处理器时恢复该信号原有的退出语义。
      if (process.listenerCount(signal) === 0)
        process.kill(process.pid, signal);
    };
    process.prependOnceListener(signal, handler);
    return { signal, handler };
  });
  process.once("exit", stop);
  options.signal.addEventListener("abort", stop, { once: true });
  try {
    const [code, output, diagnostic] = await drained;
    options.signal.throwIfAborted();
    return {
      code,
      stdout: output,
      stderr: diagnostic,
      output: output + diagnostic,
    };
  } finally {
    finished = true;
    options.signal.removeEventListener("abort", stop);
    process.removeListener("exit", stop);
    for (const { signal, handler } of interrupts)
      process.removeListener(signal, handler);
  }
}
