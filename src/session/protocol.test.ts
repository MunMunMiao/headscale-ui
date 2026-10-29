import { struct } from "@defjs/core";
import { expect, test, vi } from "vitest";
import type { MigrateProfileInput } from "@/lib/profile-storage";
import { createSessionPorts, sessionMessage } from "@/test/session-ports";
import type { AuthSessionDependencies } from "./auth-session";
import type { ProfileActions } from "./profile-actions";
import {
  createSessionProtocol,
  type SessionCommand,
  type SessionMessagePort,
} from "./protocol";
import { createSessionRuntime } from "./runtime";
import { workerMessage } from "./types";

const valid = (message: unknown) =>
  struct.parse(workerMessage, message)[0] === null;

function auth(): AuthSessionDependencies {
  return {
    workerId: "worker",
    now: () => 1000,
    newSessionId: () => "session",
    async openCredential() {
      return {
        profile: {
          id: "profile",
          name: "Profile",
          baseUrl: "https://fixture.test",
        },
        apiKey: "connection-secret",
        credentialVersion: "credential",
        keyEpoch: "epoch",
      };
    },
    async readCurrentProfile(candidate) {
      return candidate.profile;
    },
    async validateCredential() {},
    async execute() {
      return { ok: true, value: { users: [] } };
    },
  };
}

function profiles(): ProfileActions {
  const unavailable = async () => ({
    ok: false as const,
    error: { kind: "unavailable" as const },
  });
  return {
    list: unavailable,
    save: unavailable,
    migrate: unavailable,
    changePassword: unavailable,
    delete: unavailable,
    reset: unavailable,
  };
}

async function hello(port: MessagePort, ownerTabId = "owner-a") {
  const result = sessionMessage(port);
  port.postMessage({
    type: "hello",
    protocolVersion: 1,
    storageVersion: 3,
    buildId: "page-build",
    ownerTabId,
  });
  return result;
}

async function request(
  port: MessagePort,
  requestId: number,
  command: SessionCommand,
) {
  const result = sessionMessage(
    port,
    (value) =>
      (value as { type: string; requestId: number }).type === "reply" &&
      (value as { requestId: number }).requestId === requestId,
  );
  port.postMessage({ type: "request", requestId, command });
  return result;
}

test("MessageChannel handshake exposes a cloneable locked snapshot and checks without unlocking", async () => {
  const runtime = createSessionRuntime({ auth: auth() });
  const protocol = createSessionProtocol({
    runtime,
    profiles: profiles(),
    workerId: "worker",
    buildId: "build-a",
    storageVersion: 3,
  });
  const ports = createSessionPorts();
  protocol.connect(ports.worker);
  try {
    const hello = sessionMessage(ports.page);
    ports.page.postMessage({
      type: "hello",
      protocolVersion: 1,
      storageVersion: 3,
      buildId: "build-b",
      ownerTabId: "owner-a",
    });
    expect(await hello).toMatchObject({
      type: "hello",
      workerId: "worker",
      buildId: "build-a",
      snapshot: { status: "locked", identity: null },
    });
    const checked = sessionMessage(ports.page);
    ports.page.postMessage({
      type: "request",
      requestId: 1,
      command: { type: "session.snapshot" },
    });
    const reply = await checked;
    expect(reply).toMatchObject({
      type: "reply",
      requestId: 1,
      result: { ok: true, value: { status: "locked" } },
    });
    expect(structuredClone(reply)).toEqual(reply);
    expect(JSON.stringify(reply)).not.toMatch(
      /connection-secret|password|CryptoKey/,
    );
  } finally {
    ports.close();
    await protocol.dispose();
    await runtime.dispose();
  }
});

test.each([0, 2])(
  "refuses incompatible protocol %s before any business command",
  async (protocolVersion) => {
    let calls = 0;
    const actions = profiles();
    actions.list = async () => {
      calls++;
      return {
        ok: true,
        value: {
          profiles: [],
          unreadableRecords: 0,
          version: { keyEpoch: "epoch", profilesRevision: 0 },
        },
      };
    };
    const runtime = createSessionRuntime({ auth: auth() });
    const protocol = createSessionProtocol({
      runtime,
      profiles: actions,
      workerId: "worker",
      buildId: "build",
      storageVersion: 3,
    });
    const ports = createSessionPorts();
    protocol.connect(ports.worker);
    try {
      const result = sessionMessage(ports.page);
      ports.page.postMessage({
        type: "hello",
        protocolVersion,
        storageVersion: 3,
        buildId: "old",
        ownerTabId: "a",
      });
      expect(await result).toEqual({
        type: "error",
        error: { kind: "reload-required" },
      });
      expect(calls).toBe(0);
    } finally {
      ports.close();
      await protocol.dispose();
      await runtime.dispose();
    }
  },
);

test("all peers share one unlock and API session, while owner context remains bound to its port", async () => {
  const deps = auth();
  let openedInput: unknown;
  const open = deps.openCredential;
  deps.openCredential = (input, signal) => {
    openedInput = input;
    return open(input, signal);
  };
  const runtime = createSessionRuntime({ auth: deps });
  const actions = profiles();
  actions.list = async (context) => ({
    ok: true,
    value: {
      profiles: [],
      unreadableRecords: 0,
      version: { keyEpoch: context.ownerTabId, profilesRevision: 0 },
    },
  });
  const protocol = createSessionProtocol({
    runtime,
    profiles: actions,
    workerId: "worker",
    buildId: "build",
    storageVersion: 3,
  });
  const a = createSessionPorts();
  const b = createSessionPorts();
  protocol.connect(a.worker);
  protocol.connect(b.worker);
  try {
    await hello(a.page, "owner-a");
    await hello(b.page, "owner-b");
    const peerUnlock = sessionMessage(
      b.page,
      (value) =>
        (value as { snapshot?: { status: string } }).snapshot?.status ===
        "unlocked",
    );
    const unlocked = await request(a.page, 1, {
      type: "session.unlock",
      input: {
        profileId: "profile",
        password: "profile-password",
        expectedWorkerId: "worker",
        expectedIdentity: null,
        expectedCredentialVersion: "credential",
        ownerTabId: "forged-owner",
      },
    } as never);
    expect(unlocked).toMatchObject({
      result: {
        ok: true,
        value: { status: "unlocked", identity: { sessionId: "session" } },
      },
    });
    expect(await peerUnlock).toMatchObject({
      type: "snapshot",
      snapshot: { status: "unlocked", profile: { id: "profile" } },
    });
    expect(openedInput).toEqual({
      profileId: "profile",
      password: "profile-password",
      expectedWorkerId: "worker",
      expectedIdentity: null,
      expectedCredentialVersion: "credential",
      ownerTabId: "owner-a",
    });
    expect(
      await request(b.page, 1, {
        type: "api.read",
        expected: { workerId: "worker", sessionId: "session" },
        endpoint: "listUsers",
        input: {},
      }),
    ).toMatchObject({ result: { ok: true, value: { users: [] } } });
    expect(await request(b.page, 2, { type: "profiles.list" })).toMatchObject({
      result: { ok: true, value: { version: { keyEpoch: "owner-b" } } },
    });
    expect(
      await request(b.page, 3, {
        type: "session.touch",
        expected: { workerId: "worker", sessionId: "session" },
      }),
    ).toMatchObject({ result: { ok: true } });
    expect(
      await request(a.page, 2, {
        type: "session.lock",
        expected: { workerId: "worker", sessionId: "session" },
      }),
    ).toMatchObject({ result: { ok: true, value: { status: "locked" } } });
    expect(
      await request(b.page, 4, {
        type: "api.read",
        expected: { workerId: "worker", sessionId: "session" },
        endpoint: "listUsers",
        input: {},
      }),
    ).toMatchObject({ result: { ok: false, error: { kind: "locked" } } });
    expect(JSON.stringify(unlocked)).not.toMatch(
      /connection-secret|profile-password|forged-owner/,
    );
  } finally {
    a.close();
    b.close();
    await protocol.dispose();
    await runtime.dispose();
  }
});

test.each([
  [
    "api.write",
    "authRegister",
    { user: "alice", authId: "hskey-authreq-abcdefghijklmnopqrstuvwx" },
    true,
  ],
  [
    "api.write",
    "authApprove",
    { authId: "hskey-authreq-abcdefghijklmnopqrstuvwx" },
    true,
  ],
  [
    "api.write",
    "authReject",
    { authId: "hskey-authreq-abcdefghijklmnopqrstuvwx" },
    true,
  ],
  ["api.write", "checkPolicy", { policy: "{}" }, true],
  // A write may name a read: it is only treated more carefully if its answer is lost.
  ["api.write", "listUsers", {}, true],
  ["api.read", "listUsers", {}, true],
  // A read may name only a GET endpoint, so a write can never pass for one.
  ["api.read", "checkPolicy", { policy: "{}" }, false],
  ["api.read", "createUser", { name: "ops" }, false],
  ["api.write", "auth.approve", {}, false],
  ["api.write", "toString", {}, false],
  ["api.write", "__proto__", {}, false],
  ["api.write", "constructor", {}, false],
  ["api.write", "hasOwnProperty", {}, false],
  ["api.write", 1, {}, false],
  ["api.write", null, {}, false],
  ["api.execute", "listUsers", {}, false],
])(
  "%s %s is %s by the command allow-list",
  async (type, endpoint, input, accepted) => {
    const runtime = createSessionRuntime({ auth: auth() });
    const protocol = createSessionProtocol({
      runtime,
      profiles: profiles(),
      workerId: "worker",
      buildId: "build",
      storageVersion: 3,
    });
    const pair = createSessionPorts();
    protocol.connect(pair.worker);
    try {
      await hello(pair.page);
      await request(pair.page, 1, {
        type: "session.unlock",
        input: {
          profileId: "profile",
          password: "profile-password",
          expectedWorkerId: "worker",
          expectedIdentity: null,
          expectedCredentialVersion: "credential",
        },
      });
      const reply = await request(pair.page, 2, {
        type,
        expected: { workerId: "worker", sessionId: "session" },
        endpoint,
        input,
      } as never);
      expect(reply).toMatchObject({
        result: accepted
          ? { ok: true, value: { users: [] } }
          : { ok: false, error: { kind: "invalid-request" } },
      });
    } finally {
      pair.close();
      await protocol.dispose();
      await runtime.dispose();
    }
  },
);

test("finite profile commands preserve inputs and completed request ids cannot replay a write", async () => {
  const calls: string[] = [];
  const actions = profiles();
  const success = async () => {
    calls.push("write");
    return {
      ok: true as const,
      value: { version: { keyEpoch: "epoch", profilesRevision: 1 } },
    };
  };
  actions.delete = success;
  const runtime = createSessionRuntime({ auth: auth() });
  const protocol = createSessionProtocol({
    runtime,
    profiles: actions,
    workerId: "worker",
    buildId: "build",
    storageVersion: 3,
  });
  const ports = createSessionPorts();
  protocol.connect(ports.worker);
  const expected = {
    ownerTabId: "forged",
    version: { keyEpoch: "epoch", profilesRevision: 0 },
    profile: { id: "profile", credentialVersion: "v1" },
  };
  try {
    await hello(ports.page);
    expect(
      await request(ports.page, 1, { type: "profiles.delete", expected }),
    ).toMatchObject({
      result: { ok: true },
    });
    expect(
      await request(ports.page, 1, { type: "profiles.delete", expected }),
    ).toMatchObject({
      result: { ok: false, error: { kind: "invalid-request" } },
    });
    expect(
      await request(ports.page, 2, {
        type: "profiles.delete",
        expected: {
          ...expected,
          version: { keyEpoch: "epoch", profilesRevision: "0" },
        },
      } as never),
    ).toMatchObject({
      result: { ok: false, error: { kind: "invalid-request" } },
    });
    expect(calls).toEqual(["write"]);
  } finally {
    ports.close();
    await protocol.dispose();
    await runtime.dispose();
  }
});

test("disposing the host closes ports that have not handshaken", async () => {
  const runtime = createSessionRuntime({ auth: auth() });
  const protocol = createSessionProtocol({
    runtime,
    profiles: profiles(),
    workerId: "worker",
    buildId: "build",
    storageVersion: 3,
  });
  const pair = createSessionPorts();
  let closed = 0;
  protocol.connect({
    ...pair.worker,
    close() {
      closed++;
      pair.worker.close();
    },
  });
  try {
    await protocol.dispose();
    expect(closed).toBe(1);
    await protocol.dispose();
    expect(closed).toBe(1);
  } finally {
    pair.close();
    await protocol.dispose();
    await runtime.dispose();
  }
});

test("one reserved control slot lets logout cancel a saturated port", async () => {
  const runtime = createSessionRuntime({ auth: auth() });
  const actions = profiles();
  const release = Promise.withResolvers<void>();
  const signals: AbortSignal[] = [];
  actions.list = async (context) => {
    signals.push(context.signal);
    await release.promise;
    return { ok: false, error: { kind: "cancelled" } };
  };
  const protocol = createSessionProtocol({
    runtime,
    profiles: actions,
    workerId: "worker",
    buildId: "build",
    storageVersion: 3,
  });
  const pair = createSessionPorts();
  protocol.connect(pair.worker);
  try {
    await hello(pair.page);
    for (let id = 1; id <= 63; id++)
      pair.page.postMessage({
        type: "request",
        requestId: id,
        command: { type: "profiles.list" },
      });
    await expect.poll(() => signals.length).toBe(63);
    const extra = request(pair.page, 64, { type: "profiles.list" });
    const lock = request(pair.page, 65, {
      type: "session.lock",
      expected: null,
    });
    expect(await lock).toMatchObject({
      result: { ok: true, value: { status: "locked" } },
    });
    expect(await extra).toMatchObject({
      result: { ok: false, error: { kind: "busy" } },
    });
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  } finally {
    release.resolve();
    pair.close();
    await protocol.dispose();
    await runtime.dispose();
  }
});

test("cancel ids are scoped to the sending port and cannot cancel a peer's request", async () => {
  const runtime = createSessionRuntime({ auth: auth() });
  const actions = profiles();
  const signals = new Map<string, AbortSignal>();
  const releases = new Map<string, () => void>();
  actions.list = async (context) => {
    const wait = Promise.withResolvers<void>();
    signals.set(context.ownerTabId, context.signal);
    releases.set(context.ownerTabId, wait.resolve);
    await wait.promise;
    return { ok: false, error: { kind: "storage-failed" } };
  };
  const protocol = createSessionProtocol({
    runtime,
    profiles: actions,
    workerId: "worker",
    buildId: "build",
    storageVersion: 3,
  });
  const a = createSessionPorts();
  const b = createSessionPorts();
  protocol.connect(a.worker);
  protocol.connect(b.worker);
  try {
    await hello(a.page, "a");
    await hello(b.page, "b");
    a.page.postMessage({
      type: "request",
      requestId: 1,
      command: { type: "profiles.list" },
    });
    const bReply = request(b.page, 1, { type: "profiles.list" });
    await expect.poll(() => signals.size).toBe(2);
    a.page.postMessage({ type: "cancel", requestId: 1, portId: "b" });
    await expect.poll(() => signals.get("a")?.aborted).toBe(true);
    expect(signals.get("b")?.aborted).toBe(false);
    releases.get("b")?.();
    expect(await bReply).toMatchObject({
      result: { ok: false, error: { kind: "storage-failed" } },
    });
    a.page.postMessage({ type: "cancel", requestId: 2 });
    expect(await request(a.page, 2, { type: "profiles.list" })).toMatchObject({
      result: { ok: false, error: { kind: "invalid-request" } },
    });
  } finally {
    for (const release of releases.values()) release();
    a.close();
    b.close();
    await protocol.dispose();
    await runtime.dispose();
  }
});

test.each([
  null,
  { type: "request", requestId: 1, command: { type: "profiles.list" } },
  { type: "hello", buildId: "build", ownerTabId: "" },
])("rejects malformed pre-handshake messages: %j", async (message) => {
  const runtime = createSessionRuntime({ auth: auth() });
  const protocol = createSessionProtocol({
    runtime,
    profiles: profiles(),
    workerId: "worker",
    buildId: "build",
    storageVersion: 3,
  });
  const pair = createSessionPorts();
  protocol.connect(pair.worker);
  try {
    const reply = sessionMessage(pair.page);
    pair.page.postMessage(message);
    expect(await reply).toEqual({
      type: "error",
      error: { kind: "invalid-request" },
    });
  } finally {
    pair.close();
    await protocol.dispose();
    await runtime.dispose();
  }
});

test.each([
  null,
  { type: "unknown" },
  { type: "profiles.save", input: { kind: "metadata", expected: null } },
  {
    type: "profiles.save",
    input: {
      kind: "unknown",
      expected: {
        ownerTabId: "a",
        version: { keyEpoch: "e", profilesRevision: 0 },
        profile: null,
      },
    },
  },
])(
  "rejects unrecognized or malformed business commands: %j",
  async (command) => {
    const runtime = createSessionRuntime({ auth: auth() });
    const protocol = createSessionProtocol({
      runtime,
      profiles: profiles(),
      workerId: "worker",
      buildId: "build",
      storageVersion: 3,
    });
    const pair = createSessionPorts();
    protocol.connect(pair.worker);
    try {
      await hello(pair.page);
      expect(await request(pair.page, 1, command as never)).toMatchObject({
        result: { ok: false, error: { kind: "invalid-request" } },
      });
    } finally {
      pair.close();
      await protocol.dispose();
      await runtime.dispose();
    }
  },
);

test.each([
  ["null", null, true],
  ["a vault version", { keyEpoch: "epoch", profilesRevision: 2 }, true],
  ["undefined", undefined, false],
  ["a malformed version", { keyEpoch: "epoch", profilesRevision: "2" }, false],
  ["a string", "epoch", false],
])(
  "storage.reset accepts only null or a vault version: %s",
  async (_name, expected, valid) => {
    const runtime = createSessionRuntime({ auth: auth() });
    const reset = vi.fn(profiles().reset);
    const protocol = createSessionProtocol({
      runtime,
      profiles: { ...profiles(), reset },
      workerId: "worker",
      buildId: "build",
      storageVersion: 3,
    });
    const pair = createSessionPorts();
    protocol.connect(pair.worker);
    try {
      await hello(pair.page);
      const reply = await request(pair.page, 1, {
        type: "storage.reset",
        expected,
      } as never);
      expect(reply).toMatchObject({
        result: {
          ok: false,
          error: { kind: valid ? "unavailable" : "invalid-request" },
        },
      });
      if (valid)
        expect(reset).toHaveBeenCalledWith(expected, expect.anything());
      else expect(reset).not.toHaveBeenCalled();
    } finally {
      pair.close();
      await protocol.dispose();
      await runtime.dispose();
    }
  },
);

test("malformed request envelopes close the port and a disposed runtime refuses new owners", async () => {
  const runtime = createSessionRuntime({ auth: auth() });
  const protocol = createSessionProtocol({
    runtime,
    profiles: profiles(),
    workerId: "worker",
    buildId: "build",
    storageVersion: 3,
  });
  const pair = createSessionPorts();
  protocol.connect(pair.worker);
  const late = createSessionPorts();
  try {
    await hello(pair.page);
    const reply = sessionMessage(pair.page);
    pair.page.postMessage({
      type: "request",
      requestId: 0,
      command: { type: "session.snapshot" },
    });
    expect(await reply).toEqual({
      type: "error",
      error: { kind: "invalid-request" },
    });
    await runtime.dispose();
    protocol.connect(late.worker);
    expect(await hello(late.page)).toEqual({
      type: "error",
      error: { kind: "unavailable" },
    });
    await protocol.dispose();
    const cleanup = protocol.connect(pair.worker);
    cleanup();
  } finally {
    pair.close();
    late.close();
    await protocol.dispose();
    await runtime.dispose();
  }
});

test("a failed Worker post closes the port instead of leaving the connection registered", async () => {
  const runtime = createSessionRuntime({ auth: auth() });
  const protocol = createSessionProtocol({
    runtime,
    profiles: profiles(),
    workerId: "worker",
    buildId: "build",
    storageVersion: 3,
  });
  const pair = createSessionPorts();
  let closed = 0;
  protocol.connect({
    ...pair.worker,
    postMessage() {
      throw new DOMException("Port failed", "DataCloneError");
    },
    close() {
      closed++;
      pair.worker.close();
    },
  });
  try {
    pair.page.postMessage({
      type: "hello",
      protocolVersion: 1,
      storageVersion: 3,
      buildId: "build",
      ownerTabId: "owner",
    });
    await expect.poll(() => closed).toBe(1);
    await protocol.dispose();
    expect(closed).toBe(1);
  } finally {
    pair.close();
    await protocol.dispose();
    await runtime.dispose();
  }
});

const lockedSnapshot = {
  status: "locked",
  identity: null,
  profile: null,
  expiresAt: null,
  pendingProfileId: null,
  reason: "initial",
  revision: 1,
  apiKeyPrefix: null,
};
const unlockedSnapshot = {
  status: "unlocked",
  identity: { workerId: "worker", sessionId: "session" },
  profile: { id: "profile", name: "Profile", baseUrl: "https://fixture.test" },
  expiresAt: 5_000,
  pendingProfileId: null,
  reason: null,
  revision: 2,
};
test.each([
  ["a locked snapshot with a null prefix", lockedSnapshot, null, true],
  [
    "an unlocked snapshot with a listed prefix",
    unlockedSnapshot,
    "hskey-api-abcdefghijkl-***",
    true,
  ],
  ["an unlocked snapshot with a null prefix", unlockedSnapshot, null, true],
  [
    "a locked snapshot with a non-null prefix",
    lockedSnapshot,
    "abcdefg***",
    false,
  ],
  ["a numeric prefix", unlockedSnapshot, 7, false],
])("snapshot validation: %s", (_name, base, apiKeyPrefix, accepted) => {
  expect(valid({ type: "snapshot", snapshot: { ...base, apiKeyPrefix } })).toBe(
    accepted,
  );
});
test("a snapshot without the prefix field is rejected", () => {
  const { apiKeyPrefix: _omitted, ...withoutPrefix } = lockedSnapshot;
  expect(valid({ type: "snapshot", snapshot: withoutPrefix })).toBe(false);
});
const errorMessage = (error: unknown) => ({ type: "error", error });

test.each([
  ["api", { kind: "api", code: "NET_TIMEOUT", message: "timed out" }],
  ["session", { kind: "unavailable" }],
])(
  "an unconfirmed outcome is accepted only as 'unknown' on the %s error branch",
  (_name, error) => {
    expect(valid(errorMessage({ ...error, outcome: "unknown" }))).toBe(true);
    expect(valid(errorMessage(error))).toBe(true);
    expect(valid(errorMessage({ ...error, outcome: "maybe" }))).toBe(false);
    expect(
      valid({
        type: "reply",
        requestId: 1,
        snapshot: lockedSnapshot,
        result: { ok: false, error: { ...error, outcome: "maybe" } },
      }),
    ).toBe(false);
    expect(
      valid({
        type: "reply",
        requestId: 1,
        snapshot: lockedSnapshot,
        result: { ok: false, error: { ...error, outcome: "unknown" } },
      }),
    ).toBe(true);
  },
);

test.each([null, "unavailable", 7, []])(
  "an error DTO that is %j is rejected",
  (error) => {
    expect(valid(errorMessage(error))).toBe(false);
    expect(
      valid({
        type: "reply",
        requestId: 1,
        snapshot: lockedSnapshot,
        result: { ok: false, error },
      }),
    ).toBe(false);
  },
);

test("a connection stays silent before its handshake and ignores everything once closed", async () => {
  const runtime = createSessionRuntime({ auth: auth() });
  const protocol = createSessionProtocol({
    runtime,
    profiles: profiles(),
    workerId: "worker",
    buildId: "build",
    storageVersion: 3,
  });
  const listeners = new Map<string, EventListener>();
  const posted: unknown[] = [];
  let closes = 0;
  // A port that keeps delivering after removeEventListener, like a message already in flight.
  const port: SessionMessagePort = {
    postMessage: (message) => void posted.push(message),
    start() {},
    close: () => void closes++,
    addEventListener: (
      type: string,
      listener: EventListenerOrEventListenerObject,
    ) => void listeners.set(type, listener as EventListener),
    removeEventListener() {},
  };
  const attach = vi.spyOn(runtime, "attachPort");
  try {
    const close = protocol.connect(port);
    protocol.notifyProfiles();
    protocol.notifyReset({ keyEpoch: "epoch", profilesRevision: 1 });
    expect(posted).toEqual([]);
    close();
    close();
    expect(closes).toBe(1);
    listeners.get("message")?.(
      new MessageEvent("message", {
        data: {
          type: "hello",
          protocolVersion: 1,
          storageVersion: 3,
          buildId: "build",
          ownerTabId: "owner",
        },
      }),
    );
    expect(attach).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  } finally {
    await protocol.dispose();
    await runtime.dispose();
  }
});

/** A Worker with the given profile actions, connected and past its handshake. */
async function connected(actions: ProfileActions = profiles()) {
  const runtime = createSessionRuntime({ auth: auth() });
  const protocol = createSessionProtocol({
    runtime,
    profiles: actions,
    workerId: "worker",
    buildId: "build",
    storageVersion: 3,
  });
  const pair = createSessionPorts();
  protocol.connect(pair.worker);
  await hello(pair.page);
  return {
    page: pair.page,
    async close() {
      pair.close();
      await protocol.dispose();
      await runtime.dispose();
    },
  };
}
const writeExpected = {
  ownerTabId: "owner-a",
  version: { keyEpoch: "epoch", profilesRevision: 0 },
  profile: null,
};

// struct.number() accepts Infinity and fractions; an Infinity id would refuse every later request.
test.each([Number.POSITIVE_INFINITY, 1.5, -1, 0, "1"])(
  "a request id of %j closes the port",
  async (requestId) => {
    const worker = await connected();
    try {
      const reply = sessionMessage(worker.page);
      worker.page.postMessage({
        type: "request",
        requestId,
        command: { type: "profiles.list" },
      });
      expect(await reply).toEqual({
        type: "error",
        error: { kind: "invalid-request" },
      });
    } finally {
      await worker.close();
    }
  },
);

test("own __proto__ keys and undeclared fields never reach a handler", async () => {
  const save = vi.fn<ProfileActions["save"]>(profiles().save);
  const worker = await connected({ ...profiles(), save });
  try {
    const command = JSON.parse(
      `{"type":"profiles.save","__proto__":{"polluted":1},"input":{"kind":"metadata","name":"n","scope":"session","expected":${JSON.stringify(writeExpected)},"__proto__":{"admin":true},"extra":"x"}}`,
    );
    await request(worker.page, 1, command);
    const input = save.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual([
      "expected",
      "kind",
      "name",
      "scope",
    ]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  } finally {
    await worker.close();
  }
});

test("a malformed unlock is answered with a bare invalid-request that echoes nothing", async () => {
  const worker = await connected();
  try {
    const reply = await request(worker.page, 1, {
      type: "session.unlock",
      input: {
        profileId: "profile",
        password: "hunter2-profile-password",
        expectedWorkerId: "worker",
        expectedCredentialVersion: 7,
        expectedIdentity: null,
      },
    } as never);
    expect(reply).toMatchObject({
      result: { ok: false, error: { kind: "invalid-request" } },
    });
    expect(JSON.stringify(reply)).not.toContain("hunter2");
  } finally {
    await worker.close();
  }
});

// The struct drops what it does not declare: a sample naming every optional field must arrive whole.
test("profiles.migrate delivers every field the page sends", async () => {
  const sample = {
    expected: {
      ...writeExpected,
      profile: { id: "profile", credentialVersion: null },
    },
    password: "new-password",
    legacyPassword: "legacy-password",
  } satisfies Required<MigrateProfileInput>;
  const migrate = vi.fn<ProfileActions["migrate"]>(profiles().migrate);
  const worker = await connected({ ...profiles(), migrate });
  try {
    await request(worker.page, 1, { type: "profiles.migrate", input: sample });
    expect({ ...migrate.mock.calls[0]?.[0] }).toEqual(sample);
  } finally {
    await worker.close();
  }
});

test("a reply without a value and an API error with its server data both reach the page", () => {
  const locked = {
    status: "locked",
    identity: null,
    profile: null,
    expiresAt: null,
    pendingProfileId: null,
    reason: null,
    revision: 1,
    apiKeyPrefix: null,
  };
  expect(
    valid({
      type: "reply",
      requestId: 1,
      result: { ok: true },
      snapshot: locked,
    }),
  ).toBe(true);
  // readPolicy recognizes an unconfigured policy only by this data.message.
  const [, reply] = struct.parse(workerMessage, {
    type: "reply",
    requestId: 1,
    snapshot: locked,
    result: {
      ok: false,
      error: {
        kind: "api",
        code: "HTTP_STATUS",
        message: "failed",
        status: 500,
        data: { code: 2, message: "acl policy not found" },
      },
    },
  });
  expect(reply).toMatchObject({
    result: {
      error: { status: 500, data: { message: "acl policy not found" } },
    },
  });
});
