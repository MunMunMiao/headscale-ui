import { expect, test } from "vitest";
import { UnsupportedServerVersionError } from "@/domain/server-version";
import { SessionFault } from "@/session/auth-session";
import { executeOperation } from "@/session/operation-dispatch";
import type { EndpointName } from "@/session/protocol";
import { ApiError } from "@/session/types";
import { snapshotFixture, startSnapshotServer } from "@/test-utils/headscale.test";
import { type Execute, fetchSegment, fetchSnapshot, readPolicy } from "./snapshot";

function fixture() {
  const snapshot = snapshotFixture();
  const values = new Map<EndpointName, unknown>([
    ["health", snapshot.health],
    ["version", snapshot.version],
    ["listUsers", { users: snapshot.users }],
    ["listPreAuthKeys", { preAuthKeys: snapshot.preAuthKeys }],
    ["listApiKeys", { apiKeys: snapshot.apiKeys }],
    ["listNodes", { nodes: snapshot.nodes }],
    ["getPolicy", snapshot.policy],
  ]);
  const calls: { endpoint: EndpointName; signal?: AbortSignal }[] = [];
  const release = Promise.withResolvers<void>();
  const gateway = (async (command, options) => {
    calls.push({ endpoint: command.endpoint, signal: options?.signal });
    await release.promise;
    return { ok: true, value: values.get(command.endpoint) };
  }) as Execute;
  return { snapshot, values, calls, release, gateway };
}

test("starts exactly seven reads with one cancellation signal and assembles normalized snapshot", async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  const result = fetchSnapshot(f.gateway, { signal });
  const started = [...f.calls];
  f.release.resolve();
  const snapshot = await result;
  expect(started.map(({ endpoint }) => endpoint).sort()).toEqual([
    "getPolicy",
    "health",
    "listApiKeys",
    "listNodes",
    "listPreAuthKeys",
    "listUsers",
    "version",
  ]);
  expect(f.calls.every((call) => call.signal === signal)).toBe(true);
  expect(snapshot).toMatchObject(f.snapshot);
  expect(snapshot.version).toEqual({ version: "v0.29.4" });
  expect(snapshot.health).toMatchObject({
    checkedAt: expect.any(String),
    latencyMs: expect.any(Number),
    serverReachable: true,
  });
});

test("reads only the resources of the selected segment", async () => {
  const f = fixture();
  f.release.resolve();
  expect(await fetchSegment(f.gateway, "identity")).toEqual({
    users: f.snapshot.users,
    preAuthKeys: f.snapshot.preAuthKeys,
    apiKeys: f.snapshot.apiKeys,
  });
  expect(await fetchSegment(f.gateway, "policy")).toEqual({ policy: f.snapshot.policy });
  expect(f.calls.map(({ endpoint }) => endpoint).sort()).toEqual([
    "getPolicy",
    "listApiKeys",
    "listPreAuthKeys",
    "listUsers",
  ]);
});

test("keeps optional lists empty and normalizes missing node and key arrays", async () => {
  const f = fixture();
  f.values.set("listUsers", {});
  f.values.set("listApiKeys", {});
  f.values.set("listNodes", { nodes: [{ id: "1", name: "node" }] });
  f.values.set("listPreAuthKeys", { preAuthKeys: [{ id: "1" }] });
  f.release.resolve();
  const snapshot = await fetchSnapshot(f.gateway);
  expect(snapshot.users).toEqual([]);
  expect(snapshot.apiKeys).toEqual([]);
  expect(snapshot.nodes[0]).toMatchObject({
    ipAddresses: [],
    approvedRoutes: [],
    availableRoutes: [],
    subnetRoutes: [],
    tags: [],
  });
  expect(snapshot.preAuthKeys[0]?.aclTags).toEqual([]);
  f.values.set("listNodes", {});
  f.values.set("listPreAuthKeys", {});
  expect(await fetchSegment(f.gateway, "fabric")).toMatchObject({ nodes: [] });
  expect(await fetchSegment(f.gateway, "identity")).toMatchObject({ preAuthKeys: [] });
});

test("treats only Headscale's missing ACL policy error as an empty policy", async () => {
  const gateway = (async () => ({
    ok: false,
    error: {
      kind: "api",
      code: "HTTP_STATUS",
      message: "HTTP error",
      status: 500,
      data: { code: 2, message: "loading ACL from database: acl policy not found" },
    },
  })) as Execute;
  expect(await readPolicy(gateway)).toEqual({ policy: "" });
});

test("reports file mode without a policy path as an empty annotated policy", async () => {
  const gateway = (async () => ({
    ok: false,
    error: {
      kind: "api",
      code: "HTTP_STATUS",
      message: "HTTP error",
      status: 500,
      data: { code: 2, message: 'reading policy from path "": open : no such file or directory' },
    },
  })) as Execute;
  expect(await readPolicy(gateway)).toEqual({ policy: "", fileModeWithoutPath: true });
});

test.each([
  { status: 500, data: { message: "database connectivity failed" } },
  {
    status: 500,
    data: { message: 'reading policy from path "/acl.hujson": open /acl.hujson: no such file' },
  },
  {
    status: 403,
    data: { message: 'reading policy from path "": open : no such file or directory' },
  },
  { status: 500, data: { message: "policy not found" } },
  { status: 403, data: { message: "acl policy not found" } },
  { status: 500, data: undefined },
])("preserves policy failure $status $data", async ({ status, data }) => {
  const gateway = (async () => ({
    ok: false,
    error: { kind: "api", code: "HTTP_STATUS", message: "HTTP error", status, data },
  })) as Execute;
  await expect(readPolicy(gateway)).rejects.toMatchObject({ code: "HTTP_STATUS", status });
});

test("keeps policy nullable timestamp and extension fields", async () => {
  const policy = { policy: '{"acls":[]}', updatedAt: null, revision: "17" };
  const gateway = (async () => ({ ok: true, value: policy })) as Execute;
  expect(await readPolicy(gateway)).toEqual(policy);
});

test.each(["listUsers", "listNodes", "getPolicy"] as const)(
  "does not hide cancellation during %s",
  async (operation) => {
    const f = fixture();
    const gateway = (async (command) =>
      command.endpoint === operation
        ? { ok: false, error: { kind: "cancelled" } }
        : { ok: true, value: f.values.get(command.endpoint) }) as Execute;
    await expect(fetchSnapshot(gateway)).rejects.toMatchObject({ kind: "cancelled" });
  },
);

test("the Worker dispatcher reads all seven resources through declared Defjs contracts", async () => {
  const server = startSnapshotServer();
  const controller = new AbortController();
  const gateway = ((command, options) =>
    executeOperation(
      { ...command, type: "api.read" },
      {
        signal: options?.signal ?? controller.signal,
        requireCurrent: () => ({ baseUrl: server.baseUrl, apiKey: "fixture-connection-key" }),
      },
    )) as Execute;
  try {
    expect(await fetchSnapshot(gateway, { signal: controller.signal })).toMatchObject(
      server.snapshot,
    );
    expect(server.requests.sort()).toEqual([
      "GET /api/v1/apikey",
      "GET /api/v1/health",
      "GET /api/v1/node",
      "GET /api/v1/policy",
      "GET /api/v1/preauthkey",
      "GET /api/v1/user",
      "GET /version",
    ]);
  } finally {
    server.stop();
  }
});

test("snapshot cancellation reaches all seven in-flight Defjs requests", async () => {
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let count = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      if (++count === 7) arrived.resolve();
      await release.promise;
      return Response.json({});
    },
  });
  const controller = new AbortController();
  const gateway = ((command, options) =>
    executeOperation(
      { ...command, type: "api.read" },
      {
        signal: options?.signal ?? controller.signal,
        requireCurrent() {
          if (controller.signal.aborted) throw new SessionFault("cancelled");
          return { baseUrl: server.url.origin, apiKey: "fixture-connection-key" };
        },
      },
    )) as Execute;
  const pending = fetchSnapshot(gateway, { signal: controller.signal });
  const outcome = pending.catch((error: unknown) => error);
  try {
    await arrived.promise;
    controller.abort();
    expect(await outcome).toMatchObject({ kind: "cancelled" });
    expect(count).toBe(7);
  } finally {
    release.resolve();
    await server.stop(true);
  }
});

type Failure = { code: string; status?: number };
/** Gateway answering from the fixture map, except where an operation is told to fail. */
function fabricGateway(
  f: ReturnType<typeof fixture>,
  failures: Partial<Record<EndpointName, Failure>>,
) {
  f.release.resolve();
  return (async (command) => {
    const failure = failures[command.endpoint];
    if (failure)
      return {
        ok: false,
        error: { kind: "api", code: failure.code, message: failure.code, status: failure.status },
      } as never;
    return { ok: true, value: f.values.get(command.endpoint) };
  }) as Execute;
}

test.each([
  { name: "version 404", failures: { version: { code: "HTTP_STATUS", status: 404 } } },
  { name: "version contract", failures: { version: { code: "RES_STRUCT_MISMATCH" } } },
  { name: "health 500", failures: { health: { code: "HTTP_STATUS", status: 500 } } },
] as const)("optional metadata failure ($name) still gives nodes", async ({ failures }) => {
  const f = fixture();
  const gateway = fabricGateway(f, failures);
  const fabric = await fetchSegment(gateway, "fabric");
  expect(fabric.nodes).toHaveLength(2);
  if ("health" in failures) expect(fabric.health).toBeNull();
  else expect(fabric.health).toMatchObject({ serverReachable: true });
  if ("version" in failures) expect("version" in fabric).toBe(false);
  else expect(fabric.version).toEqual({ version: "v0.29.4" });
});

test.each(["RES_STRUCT_MISMATCH", "RES_DECODE_FAILED", "RES_MEDIA_TYPE_INVALID"])(
  "nodes %s on an unsupported version reports the version instead of a decode fault",
  async (code) => {
    const f = fixture();
    f.values.set("version", { version: "0.28.0" });
    const gateway = fabricGateway(f, { listNodes: { code } });
    const error = await fetchSegment(gateway, "fabric").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsupportedServerVersionError);
    expect(error).toMatchObject({ serverVersion: "0.28.0", cause: { code } });
  },
);

test.each([
  { name: "supported version", version: { version: "0.29.4" }, versionFails: false },
  { name: "unknown version", version: { version: "dev" }, versionFails: false },
  { name: "unreadable version", version: undefined, versionFails: true },
])("nodes mismatch with $name rethrows the original error", async ({ version, versionFails }) => {
  const f = fixture();
  if (version) f.values.set("version", version);
  const gateway = fabricGateway(f, {
    listNodes: { code: "RES_STRUCT_MISMATCH" },
    ...(versionFails ? { version: { code: "HTTP_STATUS", status: 404 } } : {}),
  });
  const error = await fetchSegment(gateway, "fabric").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ code: "RES_STRUCT_MISMATCH" });
});

test.each([
  { code: "HTTP_STATUS", status: 500 },
  { code: "HTTP_STATUS", status: 401 },
  { code: "NET_UNREACHABLE" },
])("nodes $code/$status with an unsupported version is not rewritten", async (failure) => {
  const f = fixture();
  f.values.set("version", { version: "0.28.0" });
  const gateway = fabricGateway(f, { listNodes: failure });
  const error = await fetchSegment(gateway, "fabric").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject(failure);
});
