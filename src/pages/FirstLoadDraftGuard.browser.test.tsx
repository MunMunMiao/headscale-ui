import {
  createBrowserHistory,
  createMemoryHistory,
  RouterProvider,
} from "@tanstack/react-router";
import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { setLocale } from "@/i18n";
import { createApplicationRouter } from "@/router";
import { prepareTestSession, SessionTestProviders } from "@/test/session";

const id = (name: string) => page.getByTestId(name);

async function setup() {
  const session = await prepareTestSession();
  await setLocale("en-US");
  const router = createApplicationRouter(
    session,
    createMemoryHistory({ initialEntries: ["/login"] }),
  );
  await router.load();
  await render(
    <SessionTestProviders session={session}>
      <RouterProvider router={router} />
    </SessionTestProviders>,
  );
  await expect.element(id("profile-picker")).toBeVisible();
  expect(session.auth.getSessionSnapshot()?.status).not.toBe("unlocked");
  // Memory history does not attach beforeunload, so exercise Login's actual blocker too.
  const history = createBrowserHistory();
  const blockers = router.history._getBlockers();
  expect(blockers.length).toBeGreaterThan(0);
  const stops = blockers.map((blocker) => history.block(blocker));
  return {
    dispose() {
      for (const stop of stops) stop();
      history.destroy();
    },
  };
}

function unloadIsPrevented() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

// A mismatched initial policy baseline must not impersonate a saved profile's retained draft.
// Native Chromium reload and trusted user activation are covered by the companion acceptance probe.
test("a never-authenticated selector and untouched connection form do not block unload", async () => {
  const fixture = await setup();
  try {
    expect(unloadIsPrevented()).toBe(false);
    await id("profile-option-new").click();
    await expect.element(id("connect-profile-name")).toHaveValue("");
    expect(unloadIsPrevented()).toBe(false);
    await id("connect-close").click();
    await expect.element(id("connection-dialog")).not.toBeInTheDocument();
    expect(unloadIsPrevented()).toBe(false);
  } finally {
    fixture.dispose();
  }
});

test("fresh connection edits stay protected until explicit Discard releases every unload guard", async () => {
  const fixture = await setup();
  try {
    await id("profile-option-new").click();
    await id("connect-profile-name").fill("Unsaved connection");
    expect(unloadIsPrevented()).toBe(true);
    await id("connect-close").click();
    await id("keep-editing-profile").click();
    await expect
      .element(id("connect-profile-name"))
      .toHaveValue("Unsaved connection");
    expect(unloadIsPrevented()).toBe(true);
    await id("connect-close").click();
    await id("discard-profile-changes").click();
    await expect.element(id("connection-dialog")).not.toBeInTheDocument();
    expect(unloadIsPrevented()).toBe(false);
  } finally {
    fixture.dispose();
  }
});
