export function sessionMessage(
  port: MessagePort,
  matches: (value: unknown) => boolean = () => true,
): Promise<unknown> {
  return new Promise((resolve) => {
    const receive = (event: MessageEvent) => {
      if (matches(event.data)) {
        port.removeEventListener("message", receive);
        resolve(event.data);
      }
    };
    port.addEventListener("message", receive);
    port.start();
  });
}

export function createSessionPorts() {
  const channel = new MessageChannel();
  let paused = false;
  const queued: unknown[] = [];
  const worker: SessionMessagePort = {
    postMessage(value: unknown) {
      if (paused) queued.push(structuredClone(value));
      else channel.port2.postMessage(value);
    },
    start: () => channel.port2.start(),
    close: () => channel.port2.close(),
    addEventListener: channel.port2.addEventListener.bind(channel.port2),
    removeEventListener: channel.port2.removeEventListener.bind(channel.port2),
  };
  return {
    page: channel.port1,
    worker,
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      for (const value of queued.splice(0)) channel.port2.postMessage(value);
    },
    queued: () => queued.length,
    close() {
      channel.port1.close();
      channel.port2.close();
    },
  };
}

import type { SessionMessagePort } from "@/session/protocol";
