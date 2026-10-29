import { useRef, useState } from "react";
import { expect, test } from "vitest";
import { render } from "vitest-browser-react";
import { type Session, SessionContext } from "./session-context";
import {
  createDeviceSetupStore,
  useDeviceSetup,
  useRevealCreatedInvite,
} from "./useDeviceSetup";

function Probe({ ready }: { ready?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const { lastCreatedInvite, revealCreatedInvite } = useDeviceSetup();
  const [renders, setRenders] = useState(0);
  useRevealCreatedInvite(ref, ready);
  return (
    <>
      <button
        type="button"
        data-testid="rerender"
        onClick={() => setRenders(renders + 1)}
      >
        {renders}
      </button>
      <input data-testid="elsewhere" />
      <div ref={ref} tabIndex={-1} data-testid="created-key">
        {lastCreatedInvite}
      </div>
      <output data-testid="flag">{String(revealCreatedInvite)}</output>
    </>
  );
}

function setup(ready?: boolean) {
  const deviceSetup = createDeviceSetupStore();
  const session = { deviceSetup } as Session;
  const view = render(
    <SessionContext.Provider value={session}>
      <Probe ready={ready} />
    </SessionContext.Provider>,
  );
  return { deviceSetup, view };
}

// A mount-driven focus would steal focus on every revisit because the created key persists in the store.
test("focuses the created key once and clears the one-shot reveal flag", async () => {
  const { deviceSetup, view } = setup();
  const screen = await view;
  expect(deviceSetup.getSnapshot().revealCreatedInvite).toBe(false);
  deviceSetup.setState({
    lastCreatedInvite: "key-1",
    revealCreatedInvite: true,
  });
  await expect.element(screen.getByTestId("created-key")).toHaveFocus();
  expect(deviceSetup.getSnapshot().revealCreatedInvite).toBe(false);
  await expect.element(screen.getByTestId("flag")).toHaveTextContent("false");

  screen.getByTestId("elsewhere").element().focus();
  await screen.getByTestId("rerender").click();
  await expect.element(screen.getByTestId("rerender")).toHaveTextContent("1");
  expect(document.activeElement).toBe(screen.getByTestId("rerender").element());
  expect(deviceSetup.getSnapshot().lastCreatedInvite).toBe("key-1");
});

test("waits until the target is ready before revealing", async () => {
  const deviceSetup = createDeviceSetupStore();
  const session = { deviceSetup } as Session;
  deviceSetup.setState({
    lastCreatedInvite: "key-2",
    revealCreatedInvite: true,
  });
  const screen = await render(
    <SessionContext.Provider value={session}>
      <Probe ready={false} />
    </SessionContext.Provider>,
  );
  expect(deviceSetup.getSnapshot().revealCreatedInvite).toBe(true);
  await screen.rerender(
    <SessionContext.Provider value={session}>
      <Probe ready />
    </SessionContext.Provider>,
  );
  await expect.element(screen.getByTestId("created-key")).toHaveFocus();
  expect(deviceSetup.getSnapshot().revealCreatedInvite).toBe(false);
});

function Detached() {
  useRevealCreatedInvite(useRef(null));
  return null;
}

test("does nothing without a created key or an attached target", async () => {
  const deviceSetup = createDeviceSetupStore();
  deviceSetup.setState({ revealCreatedInvite: true });
  const session = { deviceSetup } as Session;
  await render(
    <SessionContext.Provider value={session}>
      <Detached />
    </SessionContext.Provider>,
  );
  expect(deviceSetup.getSnapshot().revealCreatedInvite).toBe(true);
  deviceSetup.setState({ lastCreatedInvite: "key-3" });
  expect(deviceSetup.getSnapshot().revealCreatedInvite).toBe(true);
});
