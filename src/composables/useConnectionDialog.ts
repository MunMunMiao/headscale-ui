import type { DialogRootChangeEventReason } from "@base-ui/react/dialog";
import { useMemo } from "react";
import type { ProfileSummary } from "@/lib/profile-storage";
import { useSession } from "./session-context";
import type { createProfilesStore } from "./useProfiles";

interface ConnectionDialogChange {
  reason: DialogRootChangeEventReason;
  cancel(): void;
}
export function createConnectionDialog(profiles: ReturnType<typeof createProfilesStore>) {
  let connectionFormBaseline = "";
  function serializeConnectionForm() {
    const { connectionForm } = profiles.getSnapshot();
    return JSON.stringify({
      baseUrl: connectionForm.baseUrl,
      profileId: connectionForm.profileId,
      profileName: connectionForm.profileName,
      remember: connectionForm.remember,
    });
  }
  function syncConnectionFormBaseline() {
    connectionFormBaseline = serializeConnectionForm();
  }
  async function openConnectionDialogWithBaseline(profileId: string) {
    const opening = profiles.openConnectionDialog(profileId);
    const ticket = profiles.connectionFormGeneration;
    await opening;
    if (ticket === profiles.connectionFormGeneration) syncConnectionFormBaseline();
  }
  async function editProfileWithBaseline(profile: ProfileSummary) {
    await openConnectionDialogWithBaseline(profile.id);
  }
  function requestConnectionDialogClose() {
    const { apiKey, password } = profiles.getSnapshot().connectionForm;
    if (apiKey || password || serializeConnectionForm() !== connectionFormBaseline) {
      profiles.setState({ connectionCloseConfirmOpen: true });
      return;
    }
    profiles.closeConnectionDialog();
  }
  function confirmConnectionDialogClose() {
    syncConnectionFormBaseline();
    profiles.closeConnectionDialog();
  }
  function handleConnectionDialogOpen(open: boolean, details?: ConnectionDialogChange) {
    if (!open && (details?.reason === "outside-press" || details?.reason === "focus-out")) {
      details.cancel();
      return;
    }
    if (open) {
      profiles.setState({ connectionDialogOpen: true });
      return;
    }
    requestConnectionDialogClose();
    if (profiles.getSnapshot().connectionDialogOpen) details?.cancel();
  }
  function handleConnectionCloseConfirmOpen(open: boolean) {
    profiles.setState({ connectionCloseConfirmOpen: open });
  }
  return {
    syncConnectionFormBaseline,
    openConnectionDialogWithBaseline,
    editProfileWithBaseline,
    requestConnectionDialogClose,
    confirmConnectionDialogClose,
    handleConnectionDialogOpen,
    handleConnectionCloseConfirmOpen,
  };
}
export function useConnectionDialog() {
  const { profiles } = useSession();
  return useMemo(() => createConnectionDialog(profiles), [profiles]);
}
