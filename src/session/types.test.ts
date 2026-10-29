import { expect, test } from "vitest";
import { getErrorMessage } from "@/utils/error-mapping";
import { ApiError } from "./types";

test("rebuilds an API fault for message mapping without copying transport internals", () => {
  const dto = {
    kind: "api" as const,
    code: "HTTP_STATUS" as const,
    message: "HTTP request failed",
    status: 403,
    data: { code: 7, message: "permission denied" },
    cause: new Error("private transport cause"),
    request: { headers: { Authorization: "private-connection-key" } },
  };
  const error = new ApiError(dto);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({
    kind: "api",
    code: "HTTP_STATUS",
    status: 403,
    data: dto.data,
  });
  expect(getErrorMessage(error)).toBe("permission denied");
  expect(error).not.toHaveProperty("cause");
  expect(error).not.toHaveProperty("request");
});

test("keeps a session failure distinct from an API fault", () => {
  const error = new ApiError({ kind: "expired" });
  expect(error.kind).toBe("expired");
  expect(error.code).toBeUndefined();
});

test("keeps an unconfirmed outcome and omits it otherwise", () => {
  const fault = {
    kind: "api" as const,
    code: "NET_TIMEOUT" as const,
    message: "timed out",
  };
  expect(new ApiError({ ...fault, outcome: "unknown" }).outcome).toBe(
    "unknown",
  );
  expect(new ApiError(fault).outcome).toBeUndefined();
  expect(
    new ApiError({ kind: "unavailable", outcome: "unknown" }).outcome,
  ).toBe("unknown");
});
