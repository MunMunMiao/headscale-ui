import { expect, test } from "vitest";
import { testDouble } from "@/test/dom";
import { redactDiagnosticData, redactStatusData } from "./operation-log";

test("the secret is removed from every string and private fields are redacted regardless of it", () => {
  expect(
    redactDiagnosticData(
      {
        message: "token abc rejected",
        list: ["abc", 7, null],
        nested: {
          detail: "abc/abc",
          apiKey: "visible",
          Authorization: "Bearer visible",
        },
      },
      "abc",
    ),
  ).toEqual({
    message: "token [redacted] rejected",
    list: ["[redacted]", 7, null],
    nested: {
      detail: "[redacted]/[redacted]",
      apiKey: "[redacted]",
      Authorization: "[redacted]",
    },
  });
});

test("an empty secret leaves text unchanged instead of interleaving the marker", () => {
  expect(
    redactDiagnosticData(
      { text: "unchanged text", list: ["plain"], password: "visible" },
      "",
    ),
  ).toEqual({
    text: "unchanged text",
    list: ["plain"],
    password: "[redacted]",
  });
  expect(redactDiagnosticData(true, "")).toBe(true);
});

test("status redaction keeps decoded business fields without passing invalid diagnostic data", () => {
  expect(redactStatusData(undefined, "secret")).toBeUndefined();
  expect(
    redactStatusData(
      {
        code: 7,
        message: "secret denied",
        details: [{ "@type": "rpc", token: "secret" }],
      },
      "secret",
    ),
  ).toEqual({
    code: 7,
    message: "[redacted] denied",
    details: [{ "@type": "rpc", token: "[redacted]" }],
  });
  expect(
    redactStatusData(testDouble({ code: "secret" }), "secret"),
  ).toBeUndefined();
});
