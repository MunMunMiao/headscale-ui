import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { createSessionBridge } from "@/session/bridge";
import { type Session, SessionContext } from "./session-context";
import { createActionFeedbackStore } from "./useActionFeedback";
import { createProfilesStore, useProfiles } from "./useProfiles";

test("React profiles projection reacts to an ordinary draft without opening a worker or exposing credentials", async () => {
  let connections = 0;
  const bridge = createSessionBridge({
    openPort() {
      connections++;
      throw new Error("Unexpected connection");
    },
    ownerTabId: () => "owner",
    buildId: "test",
    storageVersion: 3,
  });
  const profiles = createProfilesStore(bridge, createActionFeedbackStore(), null);
  function Form() {
    const state = useProfiles();
    return (
      <label>
        Server name
        <input
          aria-label="Server name"
          value={state.connectionForm.profileName}
          onChange={(event) => state.setConnectionForm({ profileName: event.target.value })}
        />
        <output>{state.connectionForm.profileName}</output>
      </label>
    );
  }
  await render(
    <SessionContext.Provider value={{ profiles } as Session}>
      <Form />
    </SessionContext.Provider>,
  );
  await page.getByRole("textbox", { name: "Server name" }).fill("Draft server");
  await expect.element(page.getByRole("status")).toHaveTextContent("Draft server");
  expect(profiles.getSnapshot().connectionForm).toMatchObject({ apiKey: "", password: "" });
  expect(connections).toBe(0);
  bridge.dispose();
});
