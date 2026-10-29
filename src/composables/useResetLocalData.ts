import { useRouter } from "@tanstack/react-router";
import { type RefObject, useState } from "react";
import { useHeadscaleI18n } from "@/i18n";
import { storageErrorMessage } from "@/utils/storage-error";
import { useActionFeedback } from "./useActionFeedback";
import { useProfiles } from "./useProfiles";

interface ResetLocalDataOptions {
  /** Shared with the caller's submit handler so the two stay mutually exclusive. */
  inFlight: RefObject<boolean>;
  search?: Record<string, string>;
  reloadPage: (href: string) => void;
  onStart: () => void;
  onError: (message: string) => void;
}

export function useResetLocalData({
  inFlight,
  search,
  reloadPage,
  onStart,
  onError,
}: ResetLocalDataOptions) {
  const router = useRouter();
  const profiles = useProfiles();
  const feedback = useActionFeedback();
  const { t } = useHeadscaleI18n();
  const [clearing, setClearing] = useState(false);

  async function clearAll() {
    if (inFlight.current) return;
    inFlight.current = true;
    setClearing(true);
    onStart();
    const warning = t("resetMetadataWarning");
    try {
      const result = await profiles.resetLocalData();
      if (!result.sessionMetadataCleared) {
        onError(warning);
        feedback.setState({ lastError: warning });
        return;
      }
      reloadPage(
        router.buildLocation({ to: "/login", ...(search ? { search } : {}) })
          .publicHref,
      );
    } catch (error) {
      const message = storageErrorMessage(error);
      onError(message);
      feedback.setState({ lastError: message });
    } finally {
      inFlight.current = false;
      setClearing(false);
    }
  }
  return { clearing, clearAll };
}
