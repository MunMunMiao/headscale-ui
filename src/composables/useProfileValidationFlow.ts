import { useActionFeedback } from "./useActionFeedback";
import { useProfiles } from "./useProfiles";

/**
 * Coordinates the "connection-validation-failed" recovery flow: a user-facing
 * AlertDialog where the user can either return to editing or save anyway.
 * Lives outside `useConnectionDialog` because the baseline-sync function is
 * the only thing this flow borrows — keeping it parameterised avoids creating
 * a second `useConnectionDialog` instance with its own baseline.
 */
export function useProfileValidationFlow(syncConnectionFormBaseline: () => void) {
  const { lastError } = useActionFeedback();
  const { profileValidationError, profileValidationDialogOpen, addProfile, persistConnection } =
    useProfiles();

  function reviewProfileConnection() {
    lastError.value = profileValidationError.value;
    profileValidationDialogOpen.value = false;
  }

  async function continueAddingProfile() {
    // persistConnection owns the dialog close — we only clean validation flags.
    try {
      await persistConnection();
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : String(error);
      profileValidationDialogOpen.value = false;
      return;
    }
    syncConnectionFormBaseline();
    profileValidationDialogOpen.value = false;
    profileValidationError.value = "";
    lastError.value = "";
  }

  async function submitAddProfile() {
    await addProfile();
    if (!profileValidationDialogOpen.value && !lastError.value) {
      syncConnectionFormBaseline();
    }
  }

  return { reviewProfileConnection, continueAddingProfile, submitAddProfile };
}
