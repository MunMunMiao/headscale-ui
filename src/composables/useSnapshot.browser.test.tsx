import "fake-indexeddb/auto";
import { expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { isTimestampExpired } from "@/domain/node-status";
import { prepareTestSession, renderSessionPage } from "@/test/session";
import { useSnapshot } from "./useSnapshot";

function Probe() {
  const { snapshot } = useSnapshot();
  return (
    <ul>
      {snapshot.nodes.map((node) => (
        <li key={node.id} data-testid={`node-${node.id}`}>
          {isTimestampExpired(node.expiry) ? "expired" : "valid"}
        </li>
      ))}
      {snapshot.preAuthKeys.map((key) => (
        <li key={key.id} data-testid={`key-${key.id}`}>
          {isTimestampExpired(key.expiration) ? "expired" : "valid"}
        </li>
      ))}
    </ul>
  );
}

const node = (id: string, expiry: string) => ({
  id,
  name: `node-${id}`,
  expiry,
  ipAddresses: [],
  online: false,
  approvedRoutes: [],
  availableRoutes: [],
  subnetRoutes: [],
  tags: [],
});

test("pages re-render just after a node expires without fetching again", async () => {
  let fetches = 0;
  const session = await prepareTestSession(async () => {
    fetches += 1;
    return Response.json({});
  });
  session.snapshot.applyPatch({
    nodes: [node("1", new Date(Date.now() + 400).toISOString())],
    preAuthKeys: [
      {
        id: "1",
        key: "secret",
        reusable: false,
        ephemeral: false,
        used: false,
        aclTags: [],
        expiration: new Date(Date.now() + 900).toISOString(),
      },
    ],
  });
  await renderSessionPage(session, <Probe />, "/devices");
  await expect.element(page.getByTestId("node-1")).toHaveTextContent("valid");
  await expect.element(page.getByTestId("key-1")).toHaveTextContent("valid");
  await expect.element(page.getByTestId("node-1")).toHaveTextContent("expired");
  await expect.element(page.getByTestId("key-1")).toHaveTextContent("expired");
  expect(fetches).toBe(0);
});

test("unmounting clears the pending expiry timer", async () => {
  const session = await prepareTestSession();
  const armed: unknown[] = [];
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    handler: TimerHandler,
    ms?: number,
    ...args: unknown[]
  ) => {
    const id = realSetTimeout(handler, ms, ...args);
    // Only the expiry timer waits about a minute.
    if (ms !== undefined && ms > 59000 && ms < 61000) armed.push(id);
    return id;
  }) as typeof setTimeout);
  const cleared: unknown[] = [];
  const realClearTimeout = globalThis.clearTimeout;
  vi.spyOn(globalThis, "clearTimeout").mockImplementation((id) => {
    cleared.push(id);
    realClearTimeout(id);
  });
  session.snapshot.applyPatch({ nodes: [node("1", new Date(Date.now() + 60000).toISOString())] });
  const view = await renderSessionPage(session, <Probe />, "/devices");
  await expect.poll(() => armed.length).toBeGreaterThan(0);
  await view.unmount();
  expect(armed.every((id) => cleared.includes(id))).toBe(true);
});
