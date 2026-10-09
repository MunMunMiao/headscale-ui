import { beforeEach, describe, expect, test } from "bun:test";
import { deviceSetupTestingHandle, useDeviceSetup } from "./useDeviceSetup";

beforeEach(() => deviceSetupTestingHandle.reset());

describe("useDeviceSetup", () => {
  test("starts with the add-device defaults and shares the singleton", () => {
    const setup = useDeviceSetup();

    expect(useDeviceSetup()).toBe(setup);
    expect({
      open: setup.open.value,
      task: setup.task.value,
      step: setup.step.value,
      authKeyExpiryDays: setup.authKeyExpiryDays.value,
      returnAfterInvite: setup.returnAfterInvite.value,
      lastCreatedInvite: setup.lastCreatedInvite.value,
      lastRegisteredNode: setup.lastRegisteredNode.value,
      pendingRegistrationForm: { ...setup.pendingRegistrationForm },
    }).toEqual({
      open: false,
      task: null,
      step: "type",
      authKeyExpiryDays: 7,
      returnAfterInvite: false,
      lastCreatedInvite: "",
      lastRegisteredNode: null,
      pendingRegistrationForm: { user: "", key: "" },
    });
  });

  test("reset creates fresh mutable state", () => {
    const first = useDeviceSetup();
    first.open.value = true;
    first.pendingRegistrationForm.user = "alice";

    deviceSetupTestingHandle.reset();
    const second = useDeviceSetup();

    expect(second).not.toBe(first);
    expect(second.open.value).toBe(false);
    expect(second.pendingRegistrationForm.user).toBe("");
  });
});
