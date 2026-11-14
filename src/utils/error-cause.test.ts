import { expect, test } from "vitest";
import { ApiError } from "@/session/types";
import { findErrorCause } from "./error-cause";

const isApiError = (error: Error) => error instanceof ApiError;

test("finds the first typed cause without copying its status or data", () => {
  const root = new ApiError({
    kind: "api",
    code: "HTTP_STATUS",
    message: "forbidden",
    status: 403,
    data: { message: "permission denied" },
  });
  const wrapped = new Error("read snapshot", {
    cause: new Error("list users", { cause: root }),
  });
  expect(findErrorCause(wrapped, isApiError)).toBe(root);
  expect(findErrorCause(root, isApiError)).toBe(root);
  const nearer = new ApiError({ kind: "cancelled" });
  nearer.cause = root;
  expect(findErrorCause(nearer, isApiError)).toBe(nearer);
});

test("non-errors and unmatched cyclic causes terminate without accepting plain objects", () => {
  expect(findErrorCause("offline", isApiError)).toBeUndefined();
  expect(findErrorCause(new Error("plain"), isApiError)).toBeUndefined();
  expect(
    findErrorCause(
      new Error("plain", { cause: { kind: "cancelled" } }),
      isApiError,
    ),
  ).toBeUndefined();
  const first = new Error("first");
  const second = new Error("second", { cause: first });
  first.cause = second;
  expect(findErrorCause(first, isApiError)).toBeUndefined();
  expect(
    findErrorCause(second, (error): error is Error => error === first),
  ).toBe(first);
});
