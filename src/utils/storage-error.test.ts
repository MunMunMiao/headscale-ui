import "fake-indexeddb/auto";
import { expect, test } from "vitest";
import { setLocale, t } from "@/i18n";
import { hydrateSettings } from "@/lib/settings-storage";
import { VaultConflictError, VaultDataError, VaultLockedError } from "@/lib/vault-state";
import { storageErrorMessage } from "./storage-error";

test("storage boundaries use the active language and preserve non-storage error messages", async () => {
  await hydrateSettings();
  await setLocale("zh-Hans");
  expect(storageErrorMessage(new VaultConflictError())).toBe(t("vaultConflict"));
  expect(storageErrorMessage(new VaultLockedError())).toBe(t("vaultLocked"));
  expect(storageErrorMessage(new VaultDataError())).toBe(t("vaultData"));
  expect(storageErrorMessage(new DOMException("quota", "QuotaExceededError"))).toBe(
    t("storageWrite"),
  );
  expect(storageErrorMessage(new Error("Incorrect current passphrase"))).toBe(
    "Incorrect current passphrase",
  );
  expect(storageErrorMessage("offline")).toBe("offline");
});
