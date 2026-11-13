// Runs in Node: a loaded page always has a window and a document, so a session without them can only start outside it.
import { expect, test, vi } from "vitest";
import type * as settings from "@/lib/settings-storage";
import { DB_VERSION } from "@/lib/idb";
import { createSessionBridge } from "@/session/bridge";
import { createSession } from "./session-context";

// Node has no IndexedDB to hydrate from, so the stored preferences read as empty.
vi.mock("@/lib/settings-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof settings>()),
  readSetting: () => null,
}));

test("a session starts and stops in a runtime without window or document", () => {
  expect(typeof window).toBe("undefined");
  expect(typeof document).toBe("undefined");
  const bridge = createSessionBridge({
    openPort() {
      throw new Error("this bridge is never connected");
    },
    ownerTabId: () => "owner",
    buildId: "node-test",
    storageVersion: DB_VERSION,
  });
  const stop = createSession({ bridge, profiles: null }).start();
  expect(() => stop()).not.toThrow();
  bridge.dispose();
});
