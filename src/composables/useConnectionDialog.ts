import { ref } from "vue";
import type { ConnectionProfile } from "@/lib/profile-storage";
import { useProfiles } from "./useProfiles";

/**
 * Owns the lifecycle of the "Add server" / "Edit profile" dialog: dirty-check
 * against a serialized baseline, escape/outside-click confirmation, and the
 * nested AlertDialog escape hatch. Pulls its state from the `useProfiles`
 * singleton so the dialog refs stay shared with anything else that reads them.
 */
export function useConnectionDialog() {
  const {
    connectionForm,
    connectionDialogOpen,
    connectionCloseConfirmOpen,
    openConnectionDialog,
    closeConnectionDialog,
    editProfile,
  } = useProfiles();

  const connectionFormBaseline = ref("");

  function serializeConnectionForm() {
    return JSON.stringify({
      apiKey: connectionForm.apiKey,
      baseUrl: connectionForm.baseUrl,
      profileId: connectionForm.profileId,
      profileName: connectionForm.profileName,
      remember: connectionForm.remember,
    });
  }

  function syncConnectionFormBaseline() {
    connectionFormBaseline.value = serializeConnectionForm();
  }

  function isConnectionFormDirty() {
    return serializeConnectionForm() !== connectionFormBaseline.value;
  }

  async function openConnectionDialogWithBaseline(profileId: string) {
    await openConnectionDialog(profileId);
    syncConnectionFormBaseline();
  }

  async function editProfileWithBaseline(profile: ConnectionProfile) {
    await editProfile(profile);
    syncConnectionFormBaseline();
  }

  function requestConnectionDialogClose() {
    if (isConnectionFormDirty()) {
      connectionCloseConfirmOpen.value = true;
      return;
    }
    closeConnectionDialog();
  }

  function confirmConnectionDialogClose() {
    syncConnectionFormBaseline();
    closeConnectionDialog();
  }

  function handleConnectionDialogOpen(open: boolean) {
    if (open) {
      connectionDialogOpen.value = true;
      return;
    }
    requestConnectionDialogClose();
  }

  function handleConnectionCloseConfirmOpen(open: boolean) {
    connectionCloseConfirmOpen.value = open;
  }

  function originalOutsideEventTarget(event: Event) {
    const originalEvent = (event as CustomEvent<{ originalEvent?: Event }>).detail?.originalEvent;
    const target = originalEvent?.target ?? event.target;
    return target instanceof HTMLElement ? target : null;
  }

  // Bail when the click originated inside any nested dialog/alertdialog so that
  // closing an inner AlertDialog doesn't bubble up and close this one. Uses
  // ARIA roles (stable W3C contract) instead of reka-ui's internal data-slot.
  function preventConnectionDialogOutsideClose(event: Event) {
    const target = originalOutsideEventTarget(event);
    if (target?.closest('[role="alertdialog"],[role="dialog"]')) return;
    event.preventDefault();
  }

  function handleConnectionDialogEscape(event: Event) {
    event.preventDefault();
    requestConnectionDialogClose();
  }

  return {
    syncConnectionFormBaseline,
    openConnectionDialogWithBaseline,
    editProfileWithBaseline,
    requestConnectionDialogClose,
    confirmConnectionDialogClose,
    handleConnectionDialogOpen,
    handleConnectionCloseConfirmOpen,
    preventConnectionDialogOutsideClose,
    handleConnectionDialogEscape,
  };
}
