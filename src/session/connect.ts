import { DB_VERSION } from "@/lib/idb";
import { getOrCreateTabOwnerId } from "@/lib/tab-owner";
import { createSessionBridge } from "./bridge";

export function createBrowserSessionBridge() {
  return createSessionBridge({
    openPort() {
      return new SharedWorker(new URL("./worker.ts", import.meta.url), {
        type: "module",
        name: "headscale-ui-session",
      }).port;
    },
    ownerTabId: getOrCreateTabOwnerId,
    buildId: __HEADSCALE_UI_BUILD_ID__,
    storageVersion: DB_VERSION,
  });
}
