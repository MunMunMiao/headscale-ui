import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { __resetForTest, DB_VERSION } from "@/lib/idb";
import { subscribeVaultChanges } from "@/lib/vault-state";
import { createSessionPorts } from "@/test/session-ports";
import { startSnapshotServer } from "@/test-utils/headscale.test";
import { idbDelete, idbGet, idbGetAll, idbPut } from "@/test-utils/storage";
import { createSessionNetwork } from "../../scripts/harness/session-network";
import { attachSessionActivity } from "./activity";
import { createSessionBridge, type SessionBridge } from "./bridge";
import { createSessionHost } from "./host";
import * as runtimeModule from "./runtime";
import type { SessionResult } from "./types";

const cleanup: (() => void | Promise<void>)[] = [];
beforeEach(() => {
  __resetForTest();
  globalThis.indexedDB = new IDBFactory();
});
afterEach(async () => {
  for (const stop of cleanup.reverse().splice(0)) await stop();
  vi.restoreAllMocks();
});
function value<T>(result: SessionResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}
async function fixture() {
  const host = await createSessionHost("build-a");
  cleanup.push(() => host.dispose());
  async function page(owner: string) {
    const bridge = createSessionBridge({
      openPort() {
        const ports = createSessionPorts();
        cleanup.push(ports.close);
        host.connect(ports.worker);
        return ports.page;
      },
      ownerTabId: () => owner,
      buildId: "build-a",
      storageVersion: DB_VERSION,
    });
    cleanup.push(() => bridge.dispose());
    value(await bridge.connect());
    return bridge;
  }
  return { host, page };
}
async function save(
  bridge: SessionBridge,
  scope: "persistent" | "session" = "persistent",
  wrapUrl: (url: string) => string = (url) => url,
) {
  const server = startSnapshotServer();
  cleanup.push(server.stop);
  const list = value(await bridge.listProfiles());
  const result = value(
    await bridge.saveProfile({
      kind: "credentials",
      expected: { version: list.version, ownerTabId: "forged-owner", profile: null },
      profile: { id: "server-a", name: "Server A", baseUrl: wrapUrl(server.baseUrl), scope },
      apiKey: "only-worker-connection-key",
      password: "server-a-password",
      validation: "required",
      activate: true,
      expectedWorkerId: bridge.getSnapshot().workerId ?? "",
      expectedIdentity: null,
    }),
  );
  expect(result.activation?.ok).toBe(true);
  return { result, server };
}

test("validates and unlocks a profile when Headscale file mode has no policy path", async () => {
  const { page } = await fixture();
  const bridge = await page("owner-a");
  const server = startSnapshotServer();
  cleanup.push(server.stop);
  server.policyFailure = {
    status: 500,
    message: 'reading policy from path "": open : no such file or directory',
  };
  const list = value(await bridge.listProfiles());
  const saved = value(
    await bridge.saveProfile({
      kind: "credentials",
      expected: { version: list.version, ownerTabId: "owner-a", profile: null },
      profile: { id: "file-mode", name: "File mode", baseUrl: server.baseUrl, scope: "persistent" },
      apiKey: "file-mode-connection-key",
      password: "file-mode-password",
      validation: "required",
      activate: true,
      expectedWorkerId: bridge.getSnapshot().workerId ?? "",
      expectedIdentity: null,
    }),
  );
  expect(saved.activation?.ok).toBe(true);
  value(await bridge.lock(bridge.getSessionSnapshot()?.identity ?? null));
  expect(bridge.getSessionSnapshot()?.status).toBe("locked");
  value(
    await bridge.unlock({
      profileId: saved.commit.profile.id,
      password: "file-mode-password",
      expectedCredentialVersion: saved.commit.profile.credentialVersion ?? "",
      expectedWorkerId: bridge.getSnapshot().workerId ?? "",
      expectedIdentity: null,
    }),
  );
  expect(bridge.getSessionSnapshot()?.status).toBe("unlocked");
});

test("boots without creating any decrypting key and only sends profile summaries", async () => {
  const { page } = await fixture();
  const first = await page("owner-a");
  expect(first.getSessionSnapshot()?.status).toBe("locked");
  const { server } = await save(first);
  expect(server.requests).toHaveLength(14);
  expect(await idbGetAll("keys")).toEqual([]);
  const stored = await idbGetAll("profiles");
  expect(stored).toEqual([expect.objectContaining({ apiKey: expect.objectContaining({ v: 2 }) })]);
  const wire = JSON.stringify([first.getSnapshot(), value(await first.listProfiles())]);
  expect(wire).not.toContain("only-worker-connection-key");
  expect(wire).not.toContain("server-a-password");
  expect(wire).not.toContain('"ct"');
  const identity = first.getSessionSnapshot()?.identity;
  if (!identity) throw new Error("Missing shared session");
  expect(value(await first.read(identity, { endpoint: "listUsers", input: {} }))).toEqual({
    users: server.snapshot.users,
  });
});

test("permanent pagehide aborts that port's live HTTP without locking its peer", async () => {
  const { page } = await fixture();
  const first = await page("owner-a");
  const peer = await page("owner-b");
  let network: ReturnType<typeof createSessionNetwork> | undefined;
  await save(first, "persistent", (upstream) => {
    network = createSessionNetwork({ upstream });
    cleanup.push(() => network?.close());
    return network.url;
  });
  expect.assert(network);
  const transport = network;
  const identity = first.getSessionSnapshot()?.identity;
  expect.assert(identity);
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" as const });
  cleanup.push(attachSessionActivity({ window, document, now: Date.now }, first));
  const signals: AbortSignal[] = [];
  const nativeFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const signal = input instanceof Request ? input.signal : init?.signal;
    if (url.startsWith(transport.url) && signal) signals.push(signal);
    return nativeFetch(
      input,
      url.startsWith(transport.url) ? { ...init, ...{ proxy: false } } : init,
    );
  });
  const gate = transport.intercept({ method: "GET", pathPattern: "^/api/v1/user$" });
  const pending = first.read(identity, { endpoint: "listUsers", input: {} });
  await expect.poll(() => gate.getSnapshot().captured).toBe(true);
  window.dispatchEvent(Object.assign(new Event("pagehide"), { persisted: false }));
  expect(await pending).toMatchObject({ ok: false, error: { kind: "unavailable" } });
  await expect
    .poll(() => signals.some((signal) => signal.aborted), {
      message: "native fetch signal must abort",
    })
    .toBe(true);
  await expect
    .poll(
      () =>
        transport
          .getObservations()
          .some((entry) => entry.gateId === gate.getSnapshot().id && entry.aborted),
      { message: "the proxy must observe its request abort" },
    )
    .toBe(true);
  expect(peer.getSessionSnapshot()?.identity).toEqual(identity);
  expect((await peer.read(identity, { endpoint: "listUsers", input: {} })).ok).toBe(true);
});

test("a second owner adopts the one global temporary connection without listing its private profile", async () => {
  const { page } = await fixture();
  const first = await page("owner-a");
  await save(first, "session");
  const second = await page("owner-b");
  expect(second.getSessionSnapshot()).toEqual(first.getSessionSnapshot());
  expect(value(await second.listProfiles()).profiles).toEqual([]);
  expect(value(await first.listProfiles()).profiles).toHaveLength(1);
  const identity = second.getSessionSnapshot()?.identity;
  if (!identity) throw new Error("Missing shared session");
  expect((await second.read(identity, { endpoint: "listUsers", input: {} })).ok).toBe(true);
  value(await second.lock(identity));
  await expect.poll(() => first.getSessionSnapshot()?.status).toBe("locked");
  expect((await first.read(identity, { endpoint: "listUsers", input: {} })).ok).toBe(false);
});

test("a newly created host cannot inherit an earlier unlocked connection", async () => {
  const previous = await fixture();
  const first = await previous.page("owner-a");
  await save(first);
  await previous.host.dispose();
  const restarted = await fixture();
  const next = await restarted.page("owner-a");
  expect(next.getSessionSnapshot()?.status).toBe("locked");
  const profile = value(await next.listProfiles()).profiles[0];
  if (!profile?.credentialVersion) throw new Error("Missing saved profile");
  const unlock = {
    profileId: profile.id,
    expectedCredentialVersion: profile.credentialVersion,
    expectedWorkerId: next.getSnapshot().workerId ?? "",
    expectedIdentity: null,
  };
  expect(await next.unlock({ ...unlock, password: "wrong" })).toMatchObject({ ok: false });
  value(await next.unlock({ ...unlock, password: "server-a-password" }));
  expect(next.getSessionSnapshot()?.identity?.workerId).not.toBe(first.getSnapshot().workerId);
});

test("disposing the host also erases its live session and closes the Effect scope", async () => {
  const createRuntime = runtimeModule.createSessionRuntime;
  const runtime = vi.spyOn(runtimeModule, "createSessionRuntime").mockImplementation(createRuntime);
  const { host, page } = await fixture();
  const first = await page("owner-a");
  await save(first);
  const current = runtime.mock.results[0]?.value;
  expect(current.auth.getSnapshot().status).toBe("unlocked");
  await host.dispose();
  expect(current.auth.getSnapshot().status).toBe("locked");
  expect(current.attachPort("after-disposal")).toBe(false);
});

test("foreign temporary unlocks never contact the server and reset announces its committed version", async () => {
  const { page } = await fixture();
  const first = await page("owner-a");
  const { server, result } = await save(first, "session");
  const second = await page("owner-b");
  const calls = server.requests.length;
  expect(
    await second.unlock({
      profileId: "server-a",
      password: "server-a-password",
      expectedWorkerId: second.getSnapshot().workerId ?? "",
      expectedIdentity: second.getSessionSnapshot()?.identity ?? null,
      expectedCredentialVersion: result.commit.profile.credentialVersion ?? "",
    }),
  ).toMatchObject({ ok: false, error: { kind: "unlock-failed" } });
  expect(server.requests).toHaveLength(calls);
  const reset = vi.fn();
  second.subscribeReset(reset);
  const committed = value(await first.resetStorage(result.commit.version));
  await expect.poll(() => reset.mock.calls.length).toBe(1);
  // The page receives the wire VaultVersion; the Worker's storage marker `v` is not part of it.
  const { keyEpoch, profilesRevision } = committed.version;
  expect(reset).toHaveBeenCalledWith({ keyEpoch, profilesRevision });
  expect(second.getSessionSnapshot()?.status).toBe("locked");
  expect(value(await first.listProfiles()).profiles).toEqual([]);
});

test.each(["cancel", "disconnect"] as const)(
  "a committed save notifies peers even when activation is abandoned by %s",
  async (boundary) => {
    const backend = startSnapshotServer();
    cleanup.push(backend.stop);
    const network = createSessionNetwork({ upstream: backend.baseUrl });
    cleanup.push(() => network.close());
    const { page } = await fixture();
    const first = await page("owner-a");
    const peer = await page("owner-b");
    const changed = vi.fn();
    cleanup.push(peer.subscribeProfiles(changed));
    let gate: ReturnType<typeof network.intercept> | undefined;
    cleanup.push(
      subscribeVaultChanges((change) => {
        if (change.profilesRevision === 1 && !gate)
          gate = network.intercept({ method: "GET", pathPattern: "^/api/v1/policy$" });
      }),
    );
    const list = value(await first.listProfiles());
    const controller = new AbortController();
    const saving = first.saveProfile(
      {
        kind: "credentials",
        expected: { version: list.version, ownerTabId: "owner-a", profile: null },
        profile: { id: "saved", name: "Saved", baseUrl: network.url, scope: "persistent" },
        apiKey: "isolated-committed-key",
        password: "isolated-password",
        validation: "required",
        activate: true,
        expectedWorkerId: first.getSnapshot().workerId ?? "",
        expectedIdentity: null,
      },
      { signal: controller.signal },
    );
    await expect.poll(() => gate?.getSnapshot().captured).toBe(true);
    expect(value(await peer.listProfiles()).profiles).toHaveLength(1);
    expect(await idbGetAll("profiles")).toHaveLength(1);
    if (boundary === "cancel") controller.abort();
    else first.dispose();
    expect(await saving).toMatchObject({
      ok: false,
      error: { kind: boundary === "cancel" ? "cancelled" : "unavailable" },
    });
    await gate?.release();
    value(await peer.check());
    await expect.poll(() => changed.mock.calls.length).toBe(1);
    expect(peer.getSessionSnapshot()?.status).toBe("locked");
  },
);

test("an unlock adopts the current profile name when a peer renames it during validation", async () => {
  const backend = startSnapshotServer();
  cleanup.push(backend.stop);
  const network = createSessionNetwork({ upstream: backend.baseUrl });
  cleanup.push(() => network.close());
  const { page } = await fixture();
  const first = await page("owner-a");
  const peer = await page("owner-b");
  const list = value(await first.listProfiles());
  const saved = value(
    await first.saveProfile({
      kind: "credentials",
      expected: { version: list.version, ownerTabId: "owner-a", profile: null },
      profile: {
        id: "rename-candidate",
        name: "Before",
        baseUrl: network.url,
        scope: "persistent",
      },
      apiKey: "isolated-name-key",
      password: "isolated-password",
      validation: "skip",
      activate: false,
      expectedWorkerId: first.getSnapshot().workerId ?? "",
      expectedIdentity: null,
    }),
  );
  const gate = network.intercept({ method: "GET", pathPattern: "^/api/v1/policy$" });
  const unlocking = first.unlock({
    profileId: saved.commit.profile.id,
    password: "isolated-password",
    expectedCredentialVersion: saved.commit.profile.credentialVersion ?? "",
    expectedWorkerId: first.getSnapshot().workerId ?? "",
    expectedIdentity: null,
  });
  await expect.poll(() => gate.getSnapshot().captured).toBe(true);
  value(
    await peer.saveProfile({
      kind: "metadata",
      expected: {
        version: saved.commit.version,
        ownerTabId: "owner-b",
        profile: {
          id: saved.commit.profile.id,
          credentialVersion: saved.commit.profile.credentialVersion,
        },
      },
      name: "After",
      scope: "persistent",
    }),
  );
  await gate.release();
  const unlocked = value(await unlocking);
  expect(value(await peer.listProfiles()).profiles[0]?.name).toBe("After");
  expect(unlocked.profile?.name).toBe("After");
  await expect.poll(() => peer.getSessionSnapshot()?.profile?.name).toBe("After");
});

test.each(["deleted", "credential-rotated"] as const)(
  "an unlock fails with a storage conflict when a foreign writer leaves the profile %s during validation",
  async (change) => {
    const backend = startSnapshotServer();
    cleanup.push(backend.stop);
    const network = createSessionNetwork({ upstream: backend.baseUrl });
    cleanup.push(() => network.close());
    const { page } = await fixture();
    const bridge = await page("owner-a");
    const list = value(await bridge.listProfiles());
    const saved = value(
      await bridge.saveProfile({
        kind: "credentials",
        expected: { version: list.version, ownerTabId: "owner-a", profile: null },
        profile: { id: "foreign-edit", name: "Foreign", baseUrl: network.url, scope: "persistent" },
        apiKey: "isolated-foreign-key",
        password: "isolated-password",
        validation: "skip",
        activate: false,
        expectedWorkerId: bridge.getSnapshot().workerId ?? "",
        expectedIdentity: null,
      }),
    );
    const gate = network.intercept({ method: "GET", pathPattern: "^/api/v1/policy$" });
    const unlocking = bridge.unlock({
      profileId: saved.commit.profile.id,
      password: "isolated-password",
      expectedCredentialVersion: saved.commit.profile.credentialVersion ?? "",
      expectedWorkerId: bridge.getSnapshot().workerId ?? "",
      expectedIdentity: null,
    });
    await expect.poll(() => gate.getSnapshot().captured).toBe(true);
    // Another build or worker writes IndexedDB directly, without this worker invalidating anything.
    if (change === "deleted") await idbDelete("profiles", "foreign-edit");
    else
      await idbPut("profiles", {
        ...(await idbGet<object>("profiles", "foreign-edit")),
        credentialVersion: "rotated-elsewhere",
      });
    await gate.release();
    expect(await unlocking).toEqual({ ok: false, error: { kind: "storage-conflict" } });
    expect(bridge.getSessionSnapshot()?.status).toBe("locked");
  },
);
