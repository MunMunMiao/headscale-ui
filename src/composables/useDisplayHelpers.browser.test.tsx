import { beforeEach, describe, expect, test } from "vitest";
import { renderHook } from "vitest-browser-react";
import type { HeadscaleNode, HeadscaleUser } from "@/api/contracts";
import { prepareTestSession, SessionTestProviders } from "@/test/session";
import type { Session } from "./session-context";
import { useDisplayHelpers } from "./useDisplayHelpers";

let session: Session;
async function mountComposable() {
  const hook = await renderHook(useDisplayHelpers, {
    wrapper: ({ children }) => (
      <SessionTestProviders session={session}>{children}</SessionTestProviders>
    ),
  });
  return hook.result.current;
}

function node(overrides: Partial<HeadscaleNode> = {}): HeadscaleNode {
  return {
    id: "node-1",
    ipAddresses: [],
    name: "node-1",
    online: false,
    approvedRoutes: [],
    availableRoutes: [],
    subnetRoutes: [],
    tags: [],
    ...overrides,
  };
}

beforeEach(async () => {
  session = await prepareTestSession();
});

describe("useDisplayHelpers", () => {
  test("binds shared display utilities to the active English copy", async () => {
    const helpers = await mountComposable();
    const user: HeadscaleUser = { id: "user-1", name: "alice", displayName: "Alice" };

    expect(helpers.formatDate(undefined)).toBe("Never");
    expect(helpers.formatDate(null)).toBe("Never");
    expect(helpers.userLabel(undefined)).toBe("Unknown");
    expect(helpers.userLabel(null)).toBe("Unknown");
    expect(helpers.nodeDisplayName(node({ name: "raw-host", givenName: "renamed-host" }))).toBe(
      "renamed-host",
    );
    expect(helpers.nodeOwner(node({ user }))).toBe("Alice");
    expect(helpers.nodeStatusLabel(node({ online: true }))).toBe("Online");
    expect(helpers.shortSecret(undefined)).toBe("Unknown");
    expect(helpers.hasVisibleUser(user)).toBe(true);
    expect(helpers.hasVisibleUser(null)).toBe(false);
    expect(helpers.isTagManagedDeviceUser({ id: "tagged", name: "tagged-devices" })).toBe(true);
  });

  test("reports used, expired, and ready auth keys", async () => {
    const { keyStatus } = await mountComposable();

    expect(keyStatus({ used: true })).toBe("Used");
    expect(keyStatus({ used: false, expiration: "2000-01-01T00:00:00.000Z" })).toBe("Expired");
    expect(keyStatus({ used: false, expiration: "2999-01-01T00:00:00.000Z" })).toBe("Ready");
    expect(keyStatus({ used: false, expiration: null })).toBe("Ready");
  });
});
