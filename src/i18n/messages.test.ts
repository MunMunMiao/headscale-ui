import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { getMessage } from "@/test/messages";
import baseline from "./__fixtures__/translation-corpus.json";
import type { MessageKey } from "./descriptors";
import { SUPPORTED_LOCALES } from "./locales";
import { getProductCopy } from "./product-copy";
import { loadLocale } from "./runtime";

// Keep the historical corpus oracle unchanged when adding new messages.
const addedProductKeys = [
  "dateTimePlaceholder",
  "policySavedNewerEdits",
  "policySaveContextChanged",
  "policyReferenceInvalidName",
  "policyReferenceNameConflict",
  "policyReferenceEntityMissing",
  "policyReferenceUnsupported",
  "policyIdentityRemovalImpact",
  "policyTagRenameScope",
  "expirationMustBeFuture",
  "deleteMemberCleanupPending",
  "policyFileModeNoPath",
  "policyUpdateDisabled",
  "authRequestKind",
  "authRequestKindDevice",
  "authRequestKindSsh",
  "authRequestLabel",
  "authRequestHelp",
  "authRequestInvalid",
  "authRequestIsSshCheck",
  "authRequestIsRegistration",
  "sshCheckDescription",
  "approveSshCheck",
  "rejectSshCheck",
  "sshCheckApproved",
  "sshCheckRejected",
  "checkPolicy",
  "policyCheckPassed",
  "policyUnsavedBlocked",
  "renameUpdateReferencesOption",
  "renameMemberPolicyPending",
  "ipRuleFieldsRequired",
  "revokeRoute",
  "revokeRouteTitle",
  "revokeRouteDescription",
  "revokeExitRouteDescription",
  "statusActive",
  "currentApiKeyBadge",
  "currentApiKeyWarning",
  "currentApiKeyAcknowledge",
  "disableExpiry",
  "disableExpiryTitle",
  "disableExpiryDescription",
  "inviteNoOwner",
  "inviteTagsRequired",
  "authKeyCreated",
] as const;
const addedCommonKeys = [
  "sessionDraftsStaleTitle",
  "sessionDraftsStaleBody",
  "sessionDraftsDiscard",
  "clearProfilesDescription",
  "forgotServerPasswordHint",
  "serverPassword",
  "currentServerPassword",
  "newServerPassword",
  "serverPasswordHint",
  "serverCredentialEditHint",
  "sessionSharedNote",
  "profileUnlockTitle",
  "profileMigrationTitle",
  "profileMigrationHint",
  "legacyPasswordLabel",
  "migrationRequired",
  "migrateAndUnlock",
  "saveAndUnlock",
  "passwordsMismatch",
  "profilePasswordChanged",
  "securityProfileHint",
  "sessionLocked",
  "sessionExpired",
  "sessionChanged",
  "sessionBusy",
  "sessionUnavailable",
  "sessionCancelled",
  "sessionInvalidRequest",
  "sessionReloadRequired",
  "sessionOutcomeUnknown",
  "sessionSavedLocked",
  "sessionSecretRequired",
  "languageLoading",
  "languageLoadFailed",
  "languageNotSaved",
  "themeNotSaved",
  "vaultConflict",
  "vaultLocked",
  "vaultData",
  "storageWrite",
  "resetMetadataWarning",
  "preferencesReloadFailed",
  "databaseBlockedTitle",
  "databaseBlockedDescription",
  "databaseReloadTitle",
  "databaseReloadDescription",
  "tryAgain",
  "requestUnreachable",
  "requestUnexpectedResponse",
  "appErrorTitle",
  "appErrorDescription",
  "serverPasswordRequired",
  "copyFailed",
  "unsupportedServerVersion",
  "serverVersionUnreadable",
  "primaryNavigation",
] as const;
const addedMessageIds = new Set<string>([
  ...addedProductKeys.map((key) => `product.${key}`),
  ...addedCommonKeys.map((key) => `common.${key}`),
]);

function flatten(value: unknown, prefix = ""): Record<string, string> {
  if (typeof value === "string") return { [prefix]: value };
  return Object.assign(
    {},
    ...Object.entries(value as object).map(([key, item]) =>
      flatten(item, prefix ? `${prefix}.${key}` : key),
    ),
  );
}

// A dropped translation, changed punctuation or consumed literal placeholder breaks this oracle.
describe("translated corpus", () => {
  test.each(SUPPORTED_LOCALES)("preserves every baseline message in %s", async (locale) => {
    await loadLocale(locale);
    const { commonDescriptors } = await import("./descriptors");
    const corpus = flatten({
      common: Object.fromEntries(
        Object.keys(commonDescriptors).map((key) => [
          key,
          getMessage(locale, key as MessageKey, { name: "{name}", count: "{count}" }),
        ]),
      ),
      product: getProductCopy(locale),
    });
    const baselineEntries = Object.entries(corpus).filter(([id]) => !addedMessageIds.has(id));
    expect(baselineEntries).toHaveLength(baseline[locale].messageCount);
    const ordered = baselineEntries.sort(([a], [b]) => a.localeCompare(b));
    expect(createHash("sha256").update(JSON.stringify(ordered)).digest("hex")).toBe(
      baseline[locale].sha256,
    );
  });

  test.each(SUPPORTED_LOCALES)("translates the new remediation messages in %s", async (locale) => {
    await loadLocale(locale);
    const copy = getProductCopy(locale);
    const english = getProductCopy("en-US");
    for (const key of addedProductKeys) {
      expect(copy[key]).not.toBe("");
      expect(copy[key]).not.toBe(`product.${key}`);
      if (locale !== "en-US") expect(copy[key]).not.toBe(english[key]);
    }
    for (const key of addedCommonKeys) {
      const message = getMessage(locale, key);
      expect(message).not.toBe("");
      expect(message).not.toBe(key);
      if (locale !== "en-US") expect(message).not.toBe(getMessage("en-US", key));
    }
    expect(copy.policyIdentityRemovalImpact).toContain("{rules}");
    expect(copy.policyIdentityRemovalImpact).toContain("{tests}");
  });

  test.each(SUPPORTED_LOCALES)("keeps named placeholders interpolated in %s", async (locale) => {
    await loadLocale(locale);
    const unexpected = getMessage(locale, "requestUnexpectedResponse", { status: 502 });
    expect(unexpected).toContain("502");
    expect(unexpected).not.toContain("{status}");
    for (const key of ["unsupportedServerVersion", "serverVersionUnreadable"] as const) {
      const text = getMessage(locale, key, { version: "0.28.1" });
      expect(text).toContain("0.28.1");
      expect(text).not.toContain("{version}");
    }
  });

  test("preserves apostrophes and product placeholders for callers to interpolate", async () => {
    await loadLocale("fr-FR");
    expect(getProductCopy("fr-FR").renameMachineTitle).toBe("Renommer l'appareil");
    expect(getProductCopy("en-US").policyIdentityRemovalImpact).toBe(
      "Affected rules: {rules}. Affected policy tests: {tests}.",
    );
    expect(getProductCopy("en-US").orphanReferenceTooltip).toContain("We couldn't find");
    expect(getMessage("en-US", "profileUnlockTitle", { name: "Alpha's {lab}" })).toBe(
      "Unlock Alpha's {lab}",
    );
  });
});

test.each(SUPPORTED_LOCALES)(
  "provides translated per-server credential UI in %s",
  async (locale) => {
    await loadLocale(locale);
    const keys = [
      "sessionDraftsStaleTitle",
      "sessionDraftsStaleBody",
      "sessionDraftsDiscard",
      "clearProfilesDescription",
      "forgotServerPasswordHint",
      "serverPassword",
      "currentServerPassword",
      "newServerPassword",
      "serverPasswordHint",
      "serverCredentialEditHint",
      "sessionSharedNote",
      "profileUnlockTitle",
      "profileMigrationTitle",
      "profileMigrationHint",
      "legacyPasswordLabel",
      "migrationRequired",
      "migrateAndUnlock",
      "saveAndUnlock",
      "passwordsMismatch",
      "profilePasswordChanged",
      "securityProfileHint",
    ];
    for (const key of keys) {
      const text = getMessage(locale, key as MessageKey, { name: "Server Alpha" });
      expect.soft(text).toBeTruthy();
      if (locale !== "en-US")
        expect
          .soft(text)
          .not.toBe(getMessage("en-US", key as MessageKey, { name: "Server Alpha" }));
    }
  },
);
