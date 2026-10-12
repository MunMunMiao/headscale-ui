import { isTimestampExpired } from "@/domain/node-status";
import { useHeadscaleI18n } from "@/i18n";
import { formatDate as rawFormatDate } from "@/utils/format";
import {
  nodeDisplayName as rawNodeDisplayName,
  nodeOwner as rawNodeOwner,
  nodeStatusLabel as rawNodeStatusLabel,
} from "@/utils/node";
import { shortSecret as rawShortSecret } from "@/utils/strings";
import { hasVisibleUser, isTagManagedDeviceUser, userLabel as rawUserLabel } from "@/utils/user";
import { useProductCopy } from "./useProductCopy";

/**
 * I18n-aware display helpers shared by every page. Pure utilities live in
 * `@/utils/*`; this composable binds them to the active locale + copy so
 * template code can stay as terse as `{{ formatDate(v) }}` with one source
 * of truth for translations.
 *
 * Consumers needing the return shape can use `ReturnType<typeof useDisplayHelpers>`.
 */
export function useDisplayHelpers() {
  const { copy } = useProductCopy();
  const { t, locale } = useHeadscaleI18n();
  return {
    formatDate: (value: string | null | undefined) => rawFormatDate(value, locale, copy.never),
    userLabel: (user: Parameters<typeof rawUserLabel>[0]) => rawUserLabel(user, copy.unknown),
    nodeDisplayName: (node: Parameters<typeof rawNodeDisplayName>[0]) => rawNodeDisplayName(node),
    nodeOwner: (node: Parameters<typeof rawNodeOwner>[0]) => rawNodeOwner(node, copy.unknown),
    nodeStatusLabel: (node: Parameters<typeof rawNodeStatusLabel>[0]) =>
      rawNodeStatusLabel(node, {
        online: t("online"),
        offline: t("offline"),
        expired: copy.expiredOnly,
      }),
    shortSecret: (value: string | undefined) => rawShortSecret(value, copy.unknown),
    keyStatus: (key: { used: boolean; expiration?: string | null }) => {
      if (key.used) return copy.used;
      if (isTimestampExpired(key.expiration)) return copy.expiredOnly;
      return copy.unused;
    },
    hasVisibleUser,
    isTagManagedDeviceUser,
  };
}
