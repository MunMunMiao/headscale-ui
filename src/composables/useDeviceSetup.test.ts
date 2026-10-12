import { describe, expect, test } from "vitest";
import { createDeviceSetupStore } from "./useDeviceSetup";

describe("createDeviceSetupStore", () => {
  test("starts with the add-device defaults", () => {
    expect(createDeviceSetupStore().getSnapshot()).toEqual({
      open: false,
      task: null,
      step: "type",
      authKeyExpiryDays: 7,
      returnAfterInvite: false,
      lastCreatedInvite: "",
      revealCreatedInvite: false,
      lastRegisteredNode: null,
      pendingRegistrationForm: { user: "", key: "", kind: "device" },
      lastAuthDecision: null,
    });
  });

  test("keeps device setup isolated between application instances", () => {
    const first = createDeviceSetupStore();
    const previous = first.getSnapshot();
    first.setState({
      open: true,
      pendingRegistrationForm: { user: "alice", key: "", kind: "device" },
    });
    const second = createDeviceSetupStore();
    expect(first.getSnapshot().open).toBe(true);
    expect(first.getSnapshot().pendingRegistrationForm.user).toBe("alice");
    expect(previous.open).toBe(false);
    expect(previous.pendingRegistrationForm.user).toBe("");
    expect(second.getSnapshot().open).toBe(false);
    expect(second.getSnapshot().pendingRegistrationForm.user).toBe("");
  });

  test("the one-shot reveal flag returns to false with the initial snapshot", () => {
    const store = createDeviceSetupStore();
    const initial = store.getSnapshot();
    store.setState({ lastCreatedInvite: "key", revealCreatedInvite: true });
    expect(store.getSnapshot().revealCreatedInvite).toBe(true);
    store.setState(initial);
    expect(store.getSnapshot()).toEqual(initial);
    expect(store.getSnapshot().revealCreatedInvite).toBe(false);
  });
});
