import { t } from "@/i18n";
import { VaultConflictError, VaultDataError, VaultLockedError } from "@/lib/vault-state";
import { getErrorMessage } from "./error-mapping";

export function storageErrorMessage(error: unknown): string {
  if (error instanceof VaultConflictError) return t("vaultConflict");
  if (error instanceof VaultLockedError) return t("vaultLocked");
  if (error instanceof VaultDataError) return t("vaultData");
  if (error instanceof DOMException) return t("storageWrite");
  return getErrorMessage(error);
}
