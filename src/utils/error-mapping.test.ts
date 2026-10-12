import "fake-indexeddb/auto";
import type { FaultCode } from "@defjs/core";
import { expect, test } from "vitest";
import { listUsers } from "@/api/commands";
import { ApiError, createHeadscaleGateway } from "@/api/gateway";
import { UnsupportedServerVersionError } from "@/domain/server-version";
import { setLocale, t } from "@/i18n";
import { getProductCopy } from "@/i18n/product-copy";
import { hydrateSettings } from "@/lib/settings-storage";
import type { SessionExecutionContext } from "@/session/auth-session";
import { executeOperation } from "@/session/operation-dispatch";
import type { SessionFailureKind } from "@/session/types";
import { getErrorMessage } from "./error-mapping";
import { storageErrorMessage } from "./storage-error";

const bearerSecret = "fixture-connection-secret";

test.each([
  {
    locale: "zh-Hans" as const,
    messages: {
      locked: "请解锁此服务器后继续。",
      expired: "会话已过期，请重新解锁此服务器。",
      stale: "当前服务器已切换。请检查此页面后重试。",
      busy: "正在解锁或切换服务器，请等待完成后重试。",
      unavailable: "共享会话不可用。请重新连接并解锁服务器后继续。",
      cancelled: "请求已取消。准备好后可重试。",
      "invalid-request": "无法发送此请求。请刷新页面后重试。",
      "reload-required": "此页面与共享会话不兼容。请关闭旧标签页并刷新此页面。",
    },
    unknown: "无法确认操作结果，服务器可能已保存更改。请先检查当前状态，再决定是否重试。",
  },
  {
    locale: "ar" as const,
    messages: {
      locked: "افتح قفل هذا الخادم للمتابعة.",
      expired: "انتهت جلستك. افتح قفل هذا الخادم مجددًا.",
      stale: "تغيّر الخادم النشط. راجع هذه الصفحة قبل المحاولة مجددًا.",
      busy: "تجري الآن عملية فتح قفل أو تبديل خادم. انتظر اكتمالها ثم حاول مجددًا.",
      unavailable: "الجلسة المشتركة غير متاحة. أعد الاتصال وافتح قفل الخادم للمتابعة.",
      cancelled: "أُلغي الطلب. حاول مجددًا عندما تكون مستعدًا.",
      "invalid-request": "تعذّر إرسال هذا الطلب. أعد تحميل الصفحة وحاول مجددًا.",
      "reload-required":
        "هذه الصفحة غير متوافقة مع الجلسة المشتركة. أغلق علامات التبويب القديمة وأعد تحميل الصفحة.",
    },
    unknown: "تعذّر تأكيد النتيجة. ربما حفظ الخادم التغيير. تحقّق من حالته قبل المحاولة مجددًا.",
  },
])(
  "session errors remain actionable in $locale without raw protocol messages",
  async ({ locale, messages, unknown }) => {
    await hydrateSettings();
    await setLocale(locale);
    for (const [kind, expected] of Object.entries(messages)) {
      const error = new ApiError({ kind: kind as SessionFailureKind });
      expect.soft(getErrorMessage(error)).toBe(expected);
      expect.soft(storageErrorMessage(error)).toBe(expected);
    }
    for (const [kind, key] of [
      ["unlock-failed", "encryptionUnlockFailed"],
      ["storage-conflict", "vaultConflict"],
      ["storage-failed", "storageWrite"],
    ] as const) {
      expect.soft(storageErrorMessage(new ApiError({ kind }))).toBe(t(key));
    }
    const uncertain = new ApiError({ kind: "unavailable", outcome: "unknown" });
    expect.soft(getErrorMessage(uncertain)).toBe(unknown);
    expect.soft(storageErrorMessage(uncertain)).toBe(unknown);
    const timedOut = { kind: "api", code: "NET_TIMEOUT", message: "timed out" } as const;
    expect.soft(getErrorMessage(new ApiError({ ...timedOut, outcome: "unknown" }))).toBe(unknown);
    expect.soft(getErrorMessage(new ApiError(timedOut))).toBe(t("requestUnreachable"));
  },
);

function context(baseUrl: string): SessionExecutionContext {
  return {
    signal: new AbortController().signal,
    requireCurrent: () => ({ baseUrl, apiKey: bearerSecret }),
  };
}

async function failureFrom(respond: () => Response | Promise<Response>): Promise<ApiError> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: respond });
  try {
    const gateway = createHeadscaleGateway((command) =>
      executeOperation(command, context(server.url.origin)),
    );
    const [error] = await gateway.execute(listUsers({}));
    if (!(error instanceof ApiError)) throw new Error("Expected an API failure");
    return error;
  } finally {
    server.stop(true);
  }
}

const plainText = (body: string, status: number, type = "text/plain") =>
  new Response(body, { status, headers: { "Content-Type": type } });

test.each(["en-US", "zh-Hans", "ar"] as const)(
  "maps Headscale plain-text 401 to localized API-key guidance in %s",
  async (locale) => {
    await hydrateSettings();
    await setLocale(locale);
    const error = await failureFrom(() => new Response("Unauthorized", { status: 401 }));
    expect(error.code).toBe("RES_MEDIA_TYPE_INVALID");
    expect(error.status).toBe(401);
    expect("data" in JSON.parse(JSON.stringify(error))).toBe(false);
    const expected = getProductCopy(locale).errorRequestFailed;
    expect(getErrorMessage(error)).toBe(expected);
    expect(storageErrorMessage(error)).toBe(expected);
    expect(getErrorMessage(error)).not.toMatch(/media type|text\/plain|Unauthorized/i);
    expect(JSON.stringify(error)).not.toContain(bearerSecret);
  },
);

test("classifies transport and proxy faults", async () => {
  await hydrateSettings();
  await setLocale("en-US");
  const unexpected = (status: number) => t("requestUnexpectedResponse", { status });
  const refused = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const origin = refused.url.origin;
  refused.stop(true);
  const gateway = createHeadscaleGateway((command) => executeOperation(command, context(origin)));
  const [unreachable] = await gateway.execute(listUsers({}));
  expect(unreachable).toMatchObject({ code: "NET_UNREACHABLE" });
  expect(getErrorMessage(unreachable)).toBe(t("requestUnreachable"));

  const cases: [string, () => Response, string][] = [
    ["502 html", () => plainText("<html>Bad gateway</html>", 502, "text/html"), unexpected(502)],
    ["504 text", () => plainText("gateway timeout", 504), unexpected(504)],
    ["200 html", () => plainText("<html>login</html>", 200, "text/html"), unexpected(200)],
    ["empty 503", () => new Response(null, { status: 503 }), unexpected(503)],
    ["200 wrong shape", () => Response.json({ users: "not-an-array" }), unexpected(200)],
    [
      "401 json",
      () => Response.json({ code: 16, message: "Unauthorized" }, { status: 401 }),
      getProductCopy("en-US").errorRequestFailed,
    ],
    [
      "403 html",
      () => plainText("<html>Access denied</html>", 403, "text/html"),
      getProductCopy("en-US").errorRequestFailed,
    ],
    ["500 without message", () => Response.json({}, { status: 500 }), unexpected(500)],
  ];
  for (const [name, respond, expected] of cases) {
    const error = await failureFrom(respond);
    expect.soft(getErrorMessage(error), name).toBe(expected);
  }
});

test.each([
  [403, { code: 7, message: "permission denied" }],
  [500, { code: 13, message: "acl policy not found" }],
  [500, { code: 13, message: "database is locked" }],
  [400, { code: 3, message: "invalid policy: missing src" }],
])("keeps the Headscale-authored message verbatim for %i %j", async (status, body) => {
  await hydrateSettings();
  await setLocale("en-US");
  const error = await failureFrom(() => Response.json(body, { status }));
  expect(getErrorMessage(error)).toBe(body.message);
});

test.each(["en-US", "zh-Hans"] as const)(
  "localizes real Headscale phrases in %s",
  async (locale) => {
    await hydrateSettings();
    await setLocale(locale);
    const copy = getProductCopy(locale);
    const rows: [number, string, string][] = [
      [500, "user not found", copy.errorUserNotFound],
      [500, "user not empty: node(s) found", copy.errorUserStillOwns],
      [404, "node not found", copy.errorNodeNotFound],
      [404, "node not found: 5", copy.errorNodeNotFound],
      [500, "update is disabled for modes other than 'database'", copy.policyUpdateDisabled],
    ];
    for (const [status, message, expected] of rows) {
      const error = await failureFrom(() => Response.json({ code: 2, message }, { status }));
      expect.soft(getErrorMessage(error), message).toBe(expected);
    }
  },
);

test("never surfaces defjs transport text but keeps internal diagnostics", async () => {
  await hydrateSettings();
  await setLocale("en-US");
  const internal = new Set<FaultCode>([
    "REQ_BUILD_FAILED",
    "REQ_INPUT_INVALID",
    "REQ_OPTIONS_INVALID",
    "CAP_BUFFER_EXCEEDED",
    "CAP_QUEUE_OVERFLOW",
    "ENV_UNSUPPORTED",
    "EXT_HOOK_FAILED",
    "EXT_INTERCEPTOR_FAILED",
    "EXT_OBSERVER_FAILED",
  ]);
  const codes: FaultCode[] = [
    ...internal,
    "NET_ABORTED",
    "NET_TIMEOUT",
    "NET_UNREACHABLE",
    "NET_BODY_INCOMPLETE",
    "HTTP_STATUS",
    "RES_DECODE_FAILED",
    "RES_MEDIA_TYPE_INVALID",
    "RES_STRUCT_MISMATCH",
  ];
  expect(codes).toHaveLength(17);
  for (const code of codes) {
    const message = getErrorMessage(
      new ApiError({ kind: "api", code, message: "defjs internal text", status: 502 }),
    );
    if (internal.has(code)) expect.soft(message, code).toBe("defjs internal text");
    else expect.soft(message, code).not.toBe("defjs internal text");
  }
});

test.each(["en-US", "ar"] as const)(
  "an unsupported-version decode failure names the isolated version in %s",
  async (locale) => {
    await hydrateSettings();
    await setLocale(locale);
    const error = new UnsupportedServerVersionError("0.28.0");
    const message = getErrorMessage(error);
    expect(message).toBe(t("serverVersionUnreadable", { version: "\u20680.28.0\u2069" }));
    expect(message).toContain("\u20680.28.0\u2069");
    expect(message).not.toContain("{version}");
    // The unsupported-version message wins even when the cause is an unknown-outcome fault.
    const cause = new ApiError({ kind: "unavailable", outcome: "unknown" });
    expect(getErrorMessage(new UnsupportedServerVersionError("0.28.0", { cause }))).toBe(message);
  },
);
