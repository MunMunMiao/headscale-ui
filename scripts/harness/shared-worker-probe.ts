import type { Page } from "playwright";

export async function evaluateSharedWorker<T>(
  page: Page,
  workerUrl: string,
  expression: string,
): Promise<T> {
  const browser = page.context().browser();
  if (!browser) throw new Error("Worker probe requires a connected browser");
  const pageSession = await page.context().newCDPSession(page);
  const connection = await browser.newBrowserCDPSession();
  let attached: string | undefined;
  try {
    const { targetInfo: pageTarget } = await pageSession.send("Target.getTargetInfo");
    const { targetInfos } = await connection.send("Target.getTargets");
    const target = targetInfos.find(
      (candidate) =>
        candidate.type === "shared_worker" &&
        candidate.url === workerUrl &&
        candidate.browserContextId === pageTarget.browserContextId,
    );
    if (!target) throw new Error("SharedWorker target missing");
    const { sessionId } = await connection.send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: false,
    });
    attached = sessionId;
    const reply = Promise.withResolvers<T>();
    const timer = setTimeout(() => reply.reject(new Error("Worker evaluation timed out")), 5000);
    const receive = (event: { sessionId: string; message: string }) => {
      if (event.sessionId !== sessionId) return;
      const message = JSON.parse(event.message);
      if (message.id !== 1) return;
      const exception = message.result?.exceptionDetails;
      if (message.error || exception)
        reply.reject(
          new Error(
            `Worker evaluation failed: ${message.error?.message ?? exception.exception?.description ?? exception.text}`,
          ),
        );
      else reply.resolve(message.result.result.value as T);
    };
    connection.on("Target.receivedMessageFromTarget", receive);
    try {
      await connection.send("Target.sendMessageToTarget", {
        sessionId,
        message: JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      });
      return await reply.promise;
    } finally {
      clearTimeout(timer);
      connection.off("Target.receivedMessageFromTarget", receive);
    }
  } finally {
    if (attached) await connection.send("Target.detachFromTarget", { sessionId: attached });
    await connection.detach();
    await pageSession.detach();
  }
}
