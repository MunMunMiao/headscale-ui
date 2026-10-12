export async function waitUntil(
  condition: () => Promise<boolean>,
  {
    timeout = 15000,
    timeoutMsg = "Condition did not become ready",
  }: { timeout?: number; timeoutMsg?: string } = {},
): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!(await condition())) {
    if (performance.now() >= deadline) throw new Error(timeoutMsg);
    await Bun.sleep(100);
  }
}
