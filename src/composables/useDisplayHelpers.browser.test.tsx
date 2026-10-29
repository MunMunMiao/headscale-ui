import { act } from "react";
import { beforeEach, describe, expect, test } from "vitest";
import { page } from "vitest/browser";
import { render, renderHook } from "vitest-browser-react";
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
    const user: HeadscaleUser = {
      id: "user-1",
      name: "alice",
      displayName: "Alice",
    };

    expect(helpers.formatDate(undefined)).toBe("Never");
    expect(helpers.formatDate(null)).toBe("Never");
    expect(helpers.userLabel(undefined)).toBe("Unknown");
    expect(helpers.userLabel(null)).toBe("Unknown");
    expect(
      helpers.nodeDisplayName(
        node({ name: "raw-host", givenName: "renamed-host" }),
      ),
    ).toBe("renamed-host");
    expect(helpers.nodeOwner(node({ user }))).toBe("Alice");
    expect(helpers.nodeStatusLabel(node({ online: true }))).toBe("Online");
    expect(helpers.shortSecret(undefined)).toBe("Unknown");
    expect(helpers.hasVisibleUser(user)).toBe(true);
    expect(helpers.hasVisibleUser(null)).toBe(false);
    expect(
      helpers.isTagManagedDeviceUser({ id: "tagged", name: "tagged-devices" }),
    ).toBe(true);
  });

  test("usability: owner labels project the current directory by stable ID without changing node identity", async () => {
    const embedded = { id: "2", name: "old-name", displayName: "Old label" };
    const original = node({ user: embedded });
    session.snapshot.applyPatch({
      users: [{ id: "2", name: "renamed-user", displayName: "Current label" }],
    });
    const helpers = await mountComposable();
    expect(helpers.nodeOwner(original)).toBe("Current label");
    expect(original.user).toBe(embedded);
    expect(original.user).toEqual({
      id: "2",
      name: "old-name",
      displayName: "Old label",
    });
    expect(
      helpers.nodeOwner(node({ user: { id: "other", name: "old-name" } })),
    ).toBe("old-name");
    expect(
      helpers.nodeOwner(node({ user: { id: "2", name: "tagged-devices" } })),
    ).toBe("");
    expect(helpers.nodeOwner(node())).toBe("");
  });

  test("G12 a mounted owner label follows a directory rename without rewriting the raw node user", async () => {
    const embedded = { id: "2", name: "old-name" };
    const original = node({ user: embedded });
    session.snapshot.applyPatch({ users: [embedded], nodes: [original] });
    function OwnerLabel() {
      const { nodeOwner } = useDisplayHelpers();
      return (
        <output data-testid="live-owner-label">{nodeOwner(original)}</output>
      );
    }
    await render(
      <SessionTestProviders session={session}>
        <OwnerLabel />
      </SessionTestProviders>,
    );
    await expect
      .element(page.getByTestId("live-owner-label"))
      .toHaveTextContent("old-name");

    await act(async () => {
      session.snapshot.applyPatch({
        users: [{ id: "2", name: "renamed-user" }],
      });
    });

    await expect
      .element(page.getByTestId("live-owner-label"))
      .toHaveTextContent("renamed-user");
    expect(original.user).toBe(embedded);
    expect(original.user).toEqual({ id: "2", name: "old-name" });
    expect(session.snapshot.nodeById(original.id)?.user).toBe(embedded);
    expect(session.snapshot.nodeById(original.id)?.user?.name).toBe("old-name");
  });

  test("reports reusable usage as ready, expired usage as expired and unreadable expiry as unknown", async () => {
    const { keyStatus } = await mountComposable();
    expect(keyStatus({ used: true, reusable: true })).toBe("Ready");
    expect(
      keyStatus({
        used: true,
        reusable: true,
        expiration: "2000-01-01T00:00:00Z",
      }),
    ).toBe("Expired");
    expect(keyStatus({ used: false, expiration: "unreadable" })).toBe(
      "Unknown",
    );
  });

  test("reports used, expired, and ready auth keys", async () => {
    const { keyStatus } = await mountComposable();

    expect(keyStatus({ used: true })).toBe("Used");
    expect(
      keyStatus({ used: false, expiration: "2000-01-01T00:00:00.000Z" }),
    ).toBe("Expired");
    expect(
      keyStatus({ used: false, expiration: "2999-01-01T00:00:00.000Z" }),
    ).toBe("Ready");
    expect(keyStatus({ used: false, expiration: null })).toBe("Ready");
  });
});
