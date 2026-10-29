import { expect, test } from "vitest";
import { SUPPORTED_LOCALES } from "./locales";
import { getProductCopy } from "./product-copy";
import { getLocaleI18n, loadLocale } from "./runtime";

const deviceNotices = [
  "writeOutcomeVerifyInDevices",
  "tagUnresolved",
  "tagReleaseGate",
  "tagPriorUnresolved",
] as const;
const accessNotices = [
  "writeOutcomeVerifyInAccess",
  "tagPolicyDependency",
  "policyPendingBody",
  "policyPendingRelease",
  "policyPendingReleased",
] as const;
const noticeKeys = [
  ...deviceNotices,
  ...accessNotices,
  "inviteStopUnresolved",
  "inviteCreateUnknown",
  "inviteCreateReviewRequired",
] as const;

// These legacy descriptor names still have callers; none should instruct an operator to release a gate.
test("unknown device and key writes direct admins to their lists without a gate or automatic retry", () => {
  const copy = getProductCopy("en-US");
  for (const key of deviceNotices) {
    expect.soft(copy[key], key).toMatch(/outcome is unknown/i);
    expect.soft(copy[key], key).toMatch(/verify.*Machines or Auth keys list/i);
    expect.soft(copy[key], key).toContain("Nothing is retried automatically.");
    expect.soft(copy[key], key).not.toMatch(/gate|reconcil|before continuing/i);
  }
});

test("unknown policy writes direct admins to Access controls without blocking other writes", () => {
  const copy = getProductCopy("en-US");
  for (const key of accessNotices) {
    expect.soft(copy[key], key).toMatch(/outcome is unknown/i);
    expect.soft(copy[key], key).toMatch(/verify.*Access controls/i);
    expect.soft(copy[key], key).toContain("Nothing is retried automatically.");
    expect.soft(copy[key], key).not.toMatch(/gate|reconcil|before applying/i);
  }
});

test("a failed post-write policy read does not claim the write was never sent", () => {
  const text = getProductCopy("en-US").policyPrereadFailed;
  expect
    .soft(text)
    .toBe(
      "Could not read the current policy. This does not mean the write failed. Verify the current policy in Access controls. Nothing is retried automatically.",
    );
  expect.soft(text).not.toMatch(/no policy was sent|no write was sent/i);
});

test("an unknown auth-key expiry or deletion asks only for verification in the Auth keys list", () => {
  const text = getProductCopy("en-US").inviteStopUnresolved;
  expect.soft(text).toMatch(/outcome.*unknown/i);
  expect.soft(text).toMatch(/verify.*Auth keys list/i);
  expect.soft(text).toContain("Nothing is retried automatically.");
  expect.soft(text).not.toMatch(/inventor|before continuing|does not resolve/i);
});

test("unknown key creation uses the list and never identifies or revokes keys by matching options", () => {
  const text = getProductCopy("en-US").inviteCreateManualCheck;
  expect.soft(text).toMatch(/verify.*Auth keys list/i);
  expect.soft(text).toMatch(/matching tags or options do not identify/i);
  expect.soft(text).toMatch(/do not revoke other keys/i);
  expect.soft(text).toContain("Nothing is retried automatically.");
  expect.soft(text).not.toMatch(/compare.*inventor|before and after/i);
});

test("legacy verification labels do not require acknowledgements, recorded outcomes or release actions", () => {
  const copy = getProductCopy("en-US");
  for (const key of [
    "tagOperatorVerify",
    "policyPendingTitle",
    "policyPendingOperator",
    "inviteCreateNewOperationHint",
    "inviteCreateReviewRequired",
    "policyRetirementBlocked",
  ] as const) {
    expect
      .soft(copy[key], key)
      .not.toMatch(
        /gate|reconcil|I (?:have )?verified|before starting|remains recorded|unresolved writes/i,
      );
  }
});

test.each(SUPPORTED_LOCALES)(
  "serves translated list-verification notices in %s",
  async (locale) => {
    await loadLocale(locale);
    const copy = getProductCopy(locale);
    const english = getProductCopy("en-US");
    for (const key of [
      ...noticeKeys,
      "policyPrereadFailed",
      "inviteCreateManualCheck",
      "tagOperatorVerify",
      "policyPendingTitle",
      "policyPendingOperator",
      "inviteCreateNewOperationHint",
      "policyRetirementBlocked",
    ] as const) {
      expect.soft(copy[key], key).toBeTruthy();
      expect.soft(copy[key], key).not.toBe(`product.${key}`);
      if (locale !== "en-US")
        expect.soft(copy[key], key).not.toBe(english[key]);
    }
    for (const key of deviceNotices) {
      expect.soft(copy[key], key).toContain(copy.nav.devices);
      expect.soft(copy[key], key).toContain(copy.nav.invites);
    }
    for (const key of accessNotices)
      expect.soft(copy[key], key).toContain(copy.nav.access);
    for (const key of [
      "inviteStopUnresolved",
      "inviteCreateManualCheck",
    ] as const)
      expect.soft(copy[key], key).toContain(copy.nav.invites);
  },
);

test.each([
  ["en-US", "unknown", "Nothing is retried automatically."],
  ["zh-Hans", "未知", "不会自动重试。"],
  ["zh-Hant-TW", "未知", "不會自動重試。"],
  ["zh-Hant-HK", "未知", "不會自動重試。"],
  ["ja-JP", "不明", "自動で再試行されることはありません。"],
  ["ko-KR", "알 수 없습니다", "자동으로 재시도하지 않습니다."],
  [
    "fr-FR",
    "inconnu",
    "Aucune nouvelle tentative automatique n’est effectuée.",
  ],
  ["ru-RU", "неизвестен", "Автоматических повторных попыток не будет."],
  ["es-ES", "desconocido", "No se reintenta nada automáticamente."],
  [
    "it-IT",
    "sconosciuto",
    "Non viene eseguito alcun nuovo tentativo automatico.",
  ],
  ["ar", "غير معروفة", "لن تتم إعادة المحاولة تلقائيًا."],
] as const)(
  "keeps uncertainty and no automatic retry explicit in %s",
  async (locale, unknown, noRetry) => {
    await loadLocale(locale);
    const copy = getProductCopy(locale);
    for (const key of noticeKeys) {
      expect.soft(copy[key], key).toContain(unknown);
      expect.soft(copy[key], key).toContain(noRetry);
    }
    expect.soft(copy.policyPrereadFailed).toContain(noRetry);
    expect.soft(copy.inviteCreateManualCheck).toContain(noRetry);
  },
);

test.each(SUPPORTED_LOCALES)(
  "does not serve obsolete tag-rejection rules in %s",
  async (locale) => {
    await loadLocale(locale);
    const translator = getLocaleI18n(locale);
    expect
      .soft(translator._("common.undefinedTags", { tags: "tag:example" }))
      .toBe("undefinedTags");
    expect
      .soft(
        translator._("common.tagUserNodeWarning", { owner: "Example user" }),
      )
      .toBe("tagUserNodeWarning");
  },
);
