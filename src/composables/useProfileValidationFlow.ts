import { storageErrorMessage } from "@/utils/storage-error";
import { type Session, useSession } from "./session-context";
export function createProfileValidationFlow(
  session: Session,
  syncConnectionFormBaseline: () => void,
) {
  const { feedback, profiles } = session;
  function reviewProfileConnection() {
    feedback.setState({ lastError: profiles.getSnapshot().profileValidationError });
    profiles.setState({ profileValidationDialogOpen: false });
  }
  async function continueAddingProfile() {
    const { apiKey, password } = profiles.getSnapshot().connectionForm;
    if (!apiKey || !password) {
      feedback.setState({ lastError: t("sessionSecretRequired") });
      return;
    }
    const ticket = profiles.connectionFormGeneration;
    try {
      await profiles.persistConnection();
    } catch (error) {
      if (ticket !== profiles.connectionFormGeneration) return;
      feedback.setState({ lastError: storageErrorMessage(error) });
      profiles.setState({ profileValidationDialogOpen: false });
      return;
    }
    if (ticket !== profiles.connectionFormGeneration) return;
    syncConnectionFormBaseline();
    profiles.setState({ profileValidationDialogOpen: false, profileValidationError: "" });
    feedback.setState({ lastError: "" });
  }
  async function submitAddProfile(activate = false) {
    const ticket = profiles.connectionFormGeneration;
    await profiles.addProfile(activate);
    if (
      ticket === profiles.connectionFormGeneration &&
      !profiles.getSnapshot().profileValidationDialogOpen &&
      !feedback.getSnapshot().lastError
    )
      syncConnectionFormBaseline();
  }
  return { reviewProfileConnection, continueAddingProfile, submitAddProfile };
}
export function useProfileValidationFlow(syncConnectionFormBaseline: () => void) {
  return createProfileValidationFlow(useSession(), syncConnectionFormBaseline);
}

import { t } from "@/i18n";
