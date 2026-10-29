import { afterEach, expect, test, vi } from "vitest";
import {
  advanceVaultState,
  assertVaultVersion,
  newVaultState,
  notifyVaultChanged,
  readVaultState,
  subscribeVaultChanges,
  VaultConflictError,
  VaultDataError,
  VaultLockedError,
} from "./vault-state";

afterEach(() => vi.unstubAllGlobals());
test("validates persistent version state and refuses exhausted revisions", () => {
  const state = newVaultState();
  expect(readVaultState(state)).toEqual(state);
  expect(advanceVaultState(state)).toEqual({ ...state, profilesRevision: 1 });
  expect(advanceVaultState(state, "next").keyEpoch).toBe("next");
  for (const raw of [
    undefined,
    null,
    false,
    {},
    { ...state, v: 2 },
    { ...state, keyEpoch: "" },
    { ...state, profilesRevision: -1 },
    { ...state, profilesRevision: 0.5 },
  ])
    expect(() => readVaultState(raw)).toThrow(VaultDataError);
  expect(() =>
    advanceVaultState({ ...state, profilesRevision: Number.MAX_SAFE_INTEGER }),
  ).toThrow(VaultDataError);
  expect(() =>
    assertVaultVersion(state, { ...state, keyEpoch: "old" }),
  ).toThrow(VaultConflictError);
  expect(() =>
    assertVaultVersion(state, { ...state, profilesRevision: 1 }),
  ).toThrow(VaultConflictError);
  expect(() => assertVaultVersion(state, state)).not.toThrow();
  expect(new VaultLockedError().name).toBe("VaultLockedError");
});
test("local notifications publish only version hints and unsubscribe is idempotent", () => {
  const listener = vi.fn();
  const state = newVaultState();
  const stop = subscribeVaultChanges(listener);
  notifyVaultChanged(state, true);
  expect(listener).toHaveBeenCalledWith({
    keyEpoch: state.keyEpoch,
    profilesRevision: 0,
    reset: true,
  });
  stop();
  stop();
  notifyVaultChanged(state);
  expect(listener).toHaveBeenCalledTimes(1);
});
test("a blocked broadcast channel cannot turn an already committed change into a failed operation", () => {
  vi.stubGlobal("window", {});
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      constructor() {
        throw new DOMException("channel denied", "SecurityError");
      }
    },
  );
  const listener = vi.fn();
  let stop = () => {};
  expect(() => {
    stop = subscribeVaultChanges(listener);
    notifyVaultChanged(newVaultState());
  }).not.toThrow();
  expect(listener).toHaveBeenCalledTimes(1);
  stop();
});

test("worker broadcast hints are validated and share one channel until the final subscriber leaves", () => {
  vi.stubGlobal("window", undefined);
  class Channel {
    static instances: Channel[] = [];
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    close = vi.fn();
    postMessage = vi.fn();
    constructor() {
      Channel.instances.push(this);
    }
  }
  vi.stubGlobal("BroadcastChannel", Channel);
  const a = vi.fn();
  const b = vi.fn();
  const stopA = subscribeVaultChanges(a);
  const stopB = subscribeVaultChanges(b);
  expect(Channel.instances).toHaveLength(1);
  const connection = Channel.instances[0];
  for (const data of [
    null,
    true,
    {},
    { reset: true, keyEpoch: "", profilesRevision: 0 },
  ])
    connection.onmessage?.({ data } as MessageEvent<unknown>);
  expect(a).not.toHaveBeenCalled();
  connection.onmessage?.({
    data: { keyEpoch: "remote", profilesRevision: 2, reset: false },
  } as MessageEvent<unknown>);
  expect(a).toHaveBeenCalledWith({
    keyEpoch: "remote",
    profilesRevision: 2,
    reset: false,
  });
  expect(b).toHaveBeenCalledTimes(1);
  stopA();
  stopA();
  expect(connection.close).not.toHaveBeenCalled();
  connection.postMessage.mockImplementationOnce(() => {
    throw new DOMException("closed", "InvalidStateError");
  });
  expect(() => notifyVaultChanged(newVaultState())).not.toThrow();
  stopB();
  expect(connection.close).toHaveBeenCalledTimes(1);
  notifyVaultChanged(newVaultState());
  expect(Channel.instances[1].postMessage).toHaveBeenCalledTimes(1);
  expect(Channel.instances[1].close).toHaveBeenCalledTimes(1);
});

test("local subscribers are notified when the runtime has no BroadcastChannel", () => {
  vi.stubGlobal("BroadcastChannel", undefined);
  const listener = vi.fn();
  const stop = subscribeVaultChanges(listener);
  notifyVaultChanged(newVaultState());
  expect(listener).toHaveBeenCalledTimes(1);
  stop();
});
