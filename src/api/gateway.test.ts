import { expect, test } from "vitest";
import { getErrorMessage } from "@/utils/error-mapping";
import { createApiKey, deleteUser } from "./commands";
import { createHeadscaleGateway } from "./gateway";

const key = { expiration: "2027-01-01T00:00:00Z" };

test("passes one command and its cancellation signal, returning one-time output once", async () => {
  const controller = new AbortController();
  const command = createApiKey({ expiration: "2027-01-01T00:00:00Z" });
  const calls: unknown[] = [];
  const gateway = createHeadscaleGateway(async (received, options) => {
    calls.push({ command: received, signal: options?.signal });
    return { ok: true, value: { apiKey: "one-time-business-key" } };
  });
  expect(await gateway.execute(command, { signal: controller.signal })).toEqual([
    null,
    { apiKey: "one-time-business-key" },
  ]);
  expect(calls).toEqual([{ command, signal: controller.signal }]);
});

test("preserves undefined output of no-body operations", async () => {
  const gateway = createHeadscaleGateway(async () => ({ ok: true, value: undefined }));
  expect(await gateway.execute(deleteUser({ id: "1" }))).toEqual([null, undefined]);
});

test("rebuilds HTTP errors for existing message mapping without copying transport internals", async () => {
  const error = {
    kind: "api" as const,
    code: "HTTP_STATUS" as const,
    message: "HTTP request failed",
    status: 403,
    data: { code: 7, message: "permission denied" },
    cause: new Error("private transport cause"),
    request: { headers: { Authorization: "private-connection-key" } },
  };
  const gateway = createHeadscaleGateway(async () => ({ ok: false, error }));
  const [failure, value] = await gateway.execute(deleteUser({ id: "1" }));
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({
    kind: "api",
    code: "HTTP_STATUS",
    message: "HTTP request failed",
    status: 403,
    data: error.data,
  });
  expect(getErrorMessage(failure)).toBe("permission denied");
  expect(failure).not.toHaveProperty("cause");
  expect(failure).not.toHaveProperty("request");
  expect(value).toBeNull();
});

test.each(["NET_TIMEOUT", "RES_DECODE_FAILED"] as const)(
  "preserves actual Defjs fault %s without retries",
  async (code) => {
    let calls = 0;
    const gateway = createHeadscaleGateway(async () => {
      ++calls;
      return { ok: false, error: { kind: "api", code, message: "request failed" } };
    });
    const [failure] = await gateway.execute(createApiKey({ expiration: "2027-01-01T00:00:00Z" }));
    expect(failure).toMatchObject({ kind: "api", code, message: "request failed" });
    expect(failure?.status).toBeUndefined();
    expect(calls).toBe(1);
  },
);

test("keeps session failure distinct from an API fault", async () => {
  const gateway = createHeadscaleGateway(async () => ({ ok: false, error: { kind: "expired" } }));
  const [failure] = await gateway.execute(deleteUser({ id: "1" }));
  expect(failure).toBeInstanceOf(Error);
  expect(failure?.kind).toBe("expired");
  expect(failure?.code).toBeUndefined();
});

test("bounds unexpected transport rejection without exposing its private cause or retrying a write", async () => {
  let calls = 0;
  const gateway = createHeadscaleGateway(async () => {
    ++calls;
    throw new Error("private-connection-key");
  });
  const [failure, data] = await gateway.execute(
    createApiKey({ expiration: "2027-01-01T00:00:00Z" }),
  );
  expect(failure?.kind).toBe("unavailable");
  expect(failure?.message).not.toContain("private-connection-key");
  expect(data).toBeNull();
  expect(calls).toBe(1);
});

test("keeps an unconfirmed write outcome when the bridge loses its reply", async () => {
  const error = { kind: "unavailable" as const, outcome: "unknown" as const };
  const gateway = createHeadscaleGateway(async () => ({ ok: false, error }));
  expect(
    (await gateway.execute(createApiKey({ expiration: "2027-01-01T00:00:00Z" })))[0],
  ).toMatchObject({
    kind: "unavailable",
    outcome: "unknown",
  });
});

test("keeps the unconfirmed outcome of an api failure and omits it otherwise", async () => {
  const marked = { kind: "api" as const, code: "NET_TIMEOUT" as const, message: "timed out" };
  const run = async (error: typeof marked & { outcome?: "unknown" }) =>
    (
      await createHeadscaleGateway(async () => ({ ok: false, error })).execute(createApiKey(key))
    )[0];
  expect(await run({ ...marked, outcome: "unknown" })).toMatchObject({
    kind: "api",
    code: "NET_TIMEOUT",
    outcome: "unknown",
  });
  expect((await run(marked))?.outcome).toBeUndefined();
});
