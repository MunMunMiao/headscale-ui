// Runs in Node: a browser can only replace a module before its first import, and this test swaps a failing catalog for a working one mid-test.
import { expect, test, vi } from "vitest";

test("removes a failed pending load so a later request can retry", async () => {
  vi.resetModules();
  vi.doMock("./locales/ko-KR/messages", () => {
    throw new Error("catalog unavailable");
  });
  const runtime = await import("./runtime");
  await expect(runtime.loadLocale("ko-KR")).rejects.toThrow();
  expect(() => runtime.getLocaleI18n("ko-KR")).toThrow("has not been loaded");
  vi.doUnmock("./locales/ko-KR/messages");
  await runtime.loadLocale("ko-KR");
  expect(runtime.getLocaleI18n("ko-KR")._("common.light")).toBe("라이트");
  expect(runtime.i18n.locale).toBe("en-US");
});
