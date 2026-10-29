import { msg } from "@lingui/core/macro";

// Explicit descriptors keep messages reached through dynamic business keys extractable.
export const commonDescriptors = {
  notifications: msg({ id: "common.notifications", message: "Notifications" }),
  operationFailed: msg({
    id: "common.operationFailed",
    message: "The operation could not be completed.",
  }),
  sessionDraftsStaleTitle: msg({
    id: "common.sessionDraftsStaleTitle",
    message: "Draft belongs to another server",
  }),
  sessionDraftsStaleBody: msg({
    id: "common.sessionDraftsStaleBody",
    message:
      "You have an unfinished draft for {name}. It cannot be submitted to the current server. Discard it to continue.",
  }),
  sessionDraftsDiscard: msg({
    id: "common.sessionDraftsDiscard",
    message: "Discard draft and continue",
  }),
  clearProfilesDescription: msg({
    id: "common.clearProfilesDescription",
    message:
      "This deletes every saved server profile from this browser, locks the shared session, and resets language and theme preferences. You will need to add your servers and API keys again.",
  }),
  forgotServerPasswordHint: msg({
    id: "common.forgotServerPasswordHint",
    message:
      "Forgot this profile’s password? Cancel, then use the delete icon on its card to remove only this profile and add the server again with its API key.",
  }),
  clearAllProfilesHint: msg({
    id: "common.clearAllProfilesHint",
    message:
      "This clears every saved profile in this browser. To remove only one, log out and use the delete icon on its card.",
  }),
  serverPassword: msg({
    id: "common.serverPassword",
    message: "Profile password",
  }),
  currentServerPassword: msg({
    id: "common.currentServerPassword",
    message: "Current profile password",
  }),
  newServerPassword: msg({
    id: "common.newServerPassword",
    message: "New profile password",
  }),
  profilePasswordMinLength: msg({
    id: "common.profilePasswordMinLength",
    message: "Use at least 8 characters.",
  }),
  serverPasswordHint: msg({
    id: "common.serverPasswordHint",
    message:
      "This password encrypts only this server’s API key. It cannot be recovered.",
  }),
  serverCredentialEditHint: msg({
    id: "common.serverCredentialEditHint",
    message:
      "Leave the API key and password empty to change only the name or where this profile is saved. Changing the URL or API key requires both the API key and current profile password.",
  }),
  sessionSharedNote: msg({
    id: "common.sessionSharedNote",
    message:
      "Tabs in this browser share the unlocked server. The session locks after 30 minutes without activity.",
  }),
  profileUnlockTitle: msg({
    id: "common.profileUnlockTitle",
    message: "Unlock {name}",
  }),
  profileMigrationTitle: msg({
    id: "common.profileMigrationTitle",
    message: "Migrate {name}",
  }),
  profileMigrationHint: msg({
    id: "common.profileMigrationHint",
    message:
      "Set a profile password to migrate this saved connection. Its existing data stays unchanged if migration fails.",
  }),
  legacyPasswordLabel: msg({
    id: "common.legacyPasswordLabel",
    message: "Previous shared password",
  }),
  migrationRequired: msg({
    id: "common.migrationRequired",
    message: "Migration required",
  }),
  migrateAndUnlock: msg({
    id: "common.migrateAndUnlock",
    message: "Migrate and unlock",
  }),
  saveAndUnlock: msg({
    id: "common.saveAndUnlock",
    message: "Save and unlock",
  }),
  passwordsMismatch: msg({
    id: "common.passwordsMismatch",
    message: "The passwords do not match.",
  }),
  profilePasswordChanged: msg({
    id: "common.profilePasswordChanged",
    message: "The profile password was changed. Unlock it again when needed.",
  }),
  securityProfileHint: msg({
    id: "common.securityProfileHint",
    message:
      "Change the password for {name}. Other saved servers keep their own passwords.",
  }),
  loginNoticeFirstConnection: msg({
    id: "common.loginNoticeFirstConnection",
    message:
      "No connection profiles yet. Add your Headscale server URL and API key to get started.",
  }),
  loginNoticeNoSession: msg({
    id: "common.loginNoticeNoSession",
    message:
      "No other open tab kept the session unlocked, so reloading or reopening the page locked it. Enter the profile password to continue.",
  }),
  loginNoticeLoggedOut: msg({
    id: "common.loginNoticeLoggedOut",
    message:
      "You logged out in this or another tab. Enter the profile password to continue.",
  }),
  loginNoticeExpired: msg({
    id: "common.loginNoticeExpired",
    message:
      "The session locked after 30 minutes without activity. Enter the profile password to continue.",
  }),
  loginNoticeClockReversed: msg({
    id: "common.loginNoticeClockReversed",
    message:
      "The system clock moved backwards, so the session was locked. Enter the profile password to continue.",
  }),
  loginNoticeProfileChanged: msg({
    id: "common.loginNoticeProfileChanged",
    message:
      "This server’s saved profile was changed, for example its password, so the session was locked. Enter the profile password to continue.",
  }),
  loginNoticePasswordChanged: msg({
    id: "common.loginNoticePasswordChanged",
    message:
      "Password changed. Unlock the server with the new profile password.",
  }),
  loginNoticeDiscardedPolicy: msg({
    id: "common.loginNoticeDiscardedPolicy",
    message:
      "Unsaved access control changes were discarded when the session locked.",
  }),
  loginUnlockedNotice: msg({
    id: "common.loginUnlockedNotice",
    message: "{name} is already unlocked in this browser.",
  }),
  continueToServer: msg({ id: "common.continueToServer", message: "Continue" }),
  unreadableRecordsNotice: msg({
    id: "common.unreadableRecordsNotice",
    message:
      "Saved profile records that can’t be read and are not listed: {count}. Clearing all saved profiles removes them.",
  }),
  unreadableProfileRepair: msg({
    id: "common.unreadableProfileRepair",
    message:
      "This saved profile can’t be read. Enter its server URL and API key and choose a new profile password to replace it, or delete it from its card.",
  }),
  legacyProfileMigrateFirst: msg({
    id: "common.legacyProfileMigrateFirst",
    message:
      "This profile uses an older storage format. Open it from its card to migrate it before changing its URL or API key. You can rename it here.",
  }),
  sessionLocked: msg({
    id: "common.sessionLocked",
    message: "Unlock this server to continue.",
  }),
  sessionExpired: msg({
    id: "common.sessionExpired",
    message: "Your session expired. Unlock this server again.",
  }),
  sessionChanged: msg({
    id: "common.sessionChanged",
    message: "The active server changed. Review this page before trying again.",
  }),
  sessionBusy: msg({
    id: "common.sessionBusy",
    message:
      "Another unlock or server change is in progress. Try again when it finishes.",
  }),
  sessionUnavailable: msg({
    id: "common.sessionUnavailable",
    message:
      "The shared session is unavailable. Reconnect and unlock the server to continue.",
  }),
  sessionCancelled: msg({
    id: "common.sessionCancelled",
    message: "The request was cancelled. Try again when you are ready.",
  }),
  sessionInvalidRequest: msg({
    id: "common.sessionInvalidRequest",
    message: "This request could not be sent. Reload this page and try again.",
  }),
  sessionReloadRequired: msg({
    id: "common.sessionReloadRequired",
    message:
      "This page and the shared session are incompatible. Close older tabs and reload this page.",
  }),
  sessionOutcomeUnknown: msg({
    id: "common.sessionOutcomeUnknown",
    message:
      "The result could not be confirmed. The server may have saved the change. Check its state before trying again.",
  }),
  requestUnreachable: msg({
    id: "common.requestUnreachable",
    message:
      "The request did not complete. Check the server URL, your network connection and the server’s CORS settings. If you were saving a change, check the server’s current state before trying again.",
  }),
  requestUnexpectedResponse: msg({
    id: "common.requestUnexpectedResponse",
    message:
      "The server answered with an unexpected response (HTTP {status}). Check that the URL points to Headscale and that any reverse proxy is working.",
  }),
  sessionSavedLocked: msg({
    id: "common.sessionSavedLocked",
    message:
      "The server profile was saved but is still locked. Enter its password to unlock it.",
  }),
  sessionSecretRequired: msg({
    id: "common.sessionSecretRequired",
    message:
      "Enter the API key and this profile’s password again before submitting.",
  }),
  serverPasswordRequired: msg({
    id: "common.serverPasswordRequired",
    message: "Enter the profile password.",
  }),
  preferencesReloadFailed: msg({
    id: "common.preferencesReloadFailed",
    message:
      "The browser could not reload your preferences. Reload this page and try again.",
  }),
  languageLoading: msg({
    id: "common.languageLoading",
    message: "Changing language…",
  }),
  languageLoadFailed: msg({
    id: "common.languageLoadFailed",
    message: "The language could not be loaded. Please try again.",
  }),
  languageNotSaved: msg({
    id: "common.languageNotSaved",
    message:
      "The language changed, but the preference could not be saved. Please try again.",
  }),
  themeNotSaved: msg({
    id: "common.themeNotSaved",
    message:
      "The theme changed, but the preference could not be saved. Please try again.",
  }),
  vaultConflict: msg({
    id: "common.vaultConflict",
    message:
      "Saved connections changed. Reload and try again; unlock again if the password changed.",
  }),
  vaultLocked: msg({
    id: "common.vaultLocked",
    message: "Unlock saved connections before continuing.",
  }),
  vaultData: msg({
    id: "common.vaultData",
    message:
      "Some saved connection data cannot be read. Existing data was preserved.",
  }),
  storageWrite: msg({
    id: "common.storageWrite",
    message:
      "The browser could not save this change. Your previous data was preserved.",
  }),
  resetMetadataWarning: msg({
    id: "common.resetMetadataWarning",
    message:
      "Saved data was cleared, but this tab’s temporary settings could not be removed. Close this tab and open a new one.",
  }),
  databaseBlockedTitle: msg({
    id: "common.databaseBlockedTitle",
    message: "Close older Headscale UI tabs",
  }),
  databaseBlockedDescription: msg({
    id: "common.databaseBlockedDescription",
    message:
      "An older page is keeping the local database open. Close other Headscale UI tabs to continue. Your saved connections will be preserved.",
  }),
  databaseReloadTitle: msg({
    id: "common.databaseReloadTitle",
    message: "Reload this page",
  }),
  databaseReloadDescription: msg({
    id: "common.databaseReloadDescription",
    message:
      "Another page upgraded the local database. Reload this page before continuing. Your saved connections will be preserved.",
  }),
  tryAgain: msg({ id: "common.tryAgain", message: "Try again" }),
  appTitle: msg({ id: "common.appTitle", message: "Headscale UI" }),
  connection: msg({ id: "common.connection", message: "Connection" }),
  serverUrl: msg({ id: "common.serverUrl", message: "Server URL" }),
  apiKey: msg({ id: "common.apiKey", message: "API key" }),
  apiKeyPlaceholder: msg({
    id: "common.apiKeyPlaceholder",
    message: "API key created by headscale apikeys create",
  }),
  connectionInvalidUrl: msg({
    id: "common.connectionInvalidUrl",
    message: "Enter an absolute HTTP(S) server URL.",
  }),
  connectionUrlParts: msg({
    id: "common.connectionUrlParts",
    message:
      "Remove the user name, password, query (?…) or fragment (#…) from the server URL.",
  }),
  insecureServerUrlWarning: msg({
    id: "common.insecureServerUrlWarning",
    message:
      "This address uses plain HTTP, so the API key is sent unencrypted over the network. Use HTTPS unless the network is trusted.",
  }),
  connectionApiKeyRequired: msg({
    id: "common.connectionApiKeyRequired",
    message: "Enter an API key.",
  }),
  connectSubtitle: msg({
    id: "common.connectSubtitle",
    message:
      "Enter your Headscale server URL and API key to save a connection profile.",
  }),
  connectionTroubleshooting: msg({
    id: "common.connectionTroubleshooting",
    message: "Connection help: CORS and mixed content",
  }),
  profileSelectorTitle: msg({
    id: "common.profileSelectorTitle",
    message: "Choose a server profile",
  }),
  profileSelectorDescription: msg({
    id: "common.profileSelectorDescription",
    message:
      "Pick a saved profile like an operating system login, or add another Headscale server.",
  }),
  profile: msg({ id: "common.profile", message: "Profile" }),
  newProfile: msg({ id: "common.newProfile", message: "New profile" }),
  profileName: msg({ id: "common.profileName", message: "Profile name" }),
  addServerProfile: msg({
    id: "common.addServerProfile",
    message: "Add server",
  }),
  updatedProfile: msg({ id: "common.updatedProfile", message: "Updated" }),
  saveProfile: msg({ id: "common.saveProfile", message: "Save profile" }),
  addingProfile: msg({ id: "common.addingProfile", message: "Adding" }),
  savingProfile: msg({ id: "common.savingProfile", message: "Saving" }),
  checkingCredentials: msg({
    id: "common.checkingCredentials",
    message: "Checking credentials",
  }),
  close: msg({ id: "common.close", message: "Close" }),
  discardProfileChangesTitle: msg({
    id: "common.discardProfileChangesTitle",
    message: "Close without adding this server?",
  }),
  discardProfileChangesDescription: msg({
    id: "common.discardProfileChangesDescription",
    message:
      "The profile details have changed. Closing now will discard the unsaved edits.",
  }),
  keepEditingProfile: msg({
    id: "common.keepEditingProfile",
    message: "Keep editing",
  }),
  discardProfileChanges: msg({
    id: "common.discardProfileChanges",
    message: "Discard changes",
  }),
  editProfile: msg({ id: "common.editProfile", message: "Edit profile" }),
  deleteProfile: msg({ id: "common.deleteProfile", message: "Delete profile" }),
  confirmDeleteProfileTitle: msg({
    id: "common.confirmDeleteProfileTitle",
    message: "Delete this profile?",
  }),
  confirmDeleteProfileDescription: msg({
    id: "common.confirmDeleteProfileDescription",
    message: "This removes the saved server URL and API key from this browser.",
  }),
  apiKeyGuideTitle: msg({
    id: "common.apiKeyGuideTitle",
    message: "How to get an API key",
  }),
  apiKeyGuideDescription: msg({
    id: "common.apiKeyGuideDescription",
    message:
      "Headscale API keys are created from the server CLI before the UI can connect.",
  }),
  apiKeyGuideCommandLabel: msg({
    id: "common.apiKeyGuideCommandLabel",
    message: "Run on the Headscale server",
  }),
  apiKeyGuideStepServer: msg({
    id: "common.apiKeyGuideStepServer",
    message: "SSH into the server that runs Headscale.",
  }),
  apiKeyGuideStepCreate: msg({
    id: "common.apiKeyGuideStepCreate",
    message: "Create a short-lived API key with the Headscale CLI.",
  }),
  apiKeyGuideStepCopy: msg({
    id: "common.apiKeyGuideStepCopy",
    message: "Copy the full key immediately; Headscale only shows it once.",
  }),
  apiKeyGuideStepPaste: msg({
    id: "common.apiKeyGuideStepPaste",
    message: "Paste the key here with your HTTPS Headscale URL.",
  }),
  apiKeyGuideHint: msg({
    id: "common.apiKeyGuideHint",
    message:
      "If a key is lost or expired, expire it and create a new one on the server.",
  }),
  headscaleDocs: msg({ id: "common.headscaleDocs", message: "Headscale docs" }),
  rememberConnection: msg({
    id: "common.rememberConnection",
    message: "Remember this connection in this browser",
  }),
  rememberConnectionHint: msg({
    id: "common.rememberConnectionHint",
    message:
      "When unchecked, this profile is listed only in this tab and tabs opened from it. Either way, its encrypted API key stays in this browser until you delete the profile or clear local data.",
  }),
  cancel: msg({ id: "common.cancel", message: "Cancel" }),
  connect: msg({ id: "common.connect", message: "Connect" }),
  logout: msg({ id: "common.logout", message: "Log out" }),
  theme: msg({ id: "common.theme", message: "Theme" }),
  language: msg({ id: "common.language", message: "Language" }),
  light: msg({ id: "common.light", message: "Light" }),
  dark: msg({ id: "common.dark", message: "Dark" }),
  system: msg({ id: "common.system", message: "System" }),
  result: msg({ id: "common.result", message: "Result" }),
  users: msg({ id: "common.users", message: "Users" }),
  nodes: msg({ id: "common.nodes", message: "Nodes" }),
  apiKeys: msg({ id: "common.apiKeys", message: "API keys" }),
  policy: msg({ id: "common.policy", message: "Policy" }),
  routes: msg({ id: "common.routes", message: "Routes" }),
  online: msg({ id: "common.online", message: "Online" }),
  offline: msg({ id: "common.offline", message: "Offline" }),
  database: msg({ id: "common.database", message: "Database" }),
  copy: msg({ id: "common.copy", message: "Copy" }),
  copied: msg({ id: "common.copied", message: "Copied" }),
  encryptionSectionTitle: msg({
    id: "common.encryptionSectionTitle",
    message: "Encryption",
  }),
  encryptionConfirmPassphrase: msg({
    id: "common.encryptionConfirmPassphrase",
    message: "Confirm profile password",
  }),
  encryptionChangePassphrase: msg({
    id: "common.encryptionChangePassphrase",
    message: "Change profile password",
  }),
  encryptionUnlockSubmit: msg({
    id: "common.encryptionUnlockSubmit",
    message: "Unlock",
  }),
  encryptionUnlockFailed: msg({
    id: "common.encryptionUnlockFailed",
    message: "Could not unlock this profile with the supplied password.",
  }),
  encryptionForgottenButton: msg({
    id: "common.encryptionForgottenButton",
    message: "Clear all saved profiles",
  }),
  forgotConfirmTitle: msg({
    id: "common.forgotConfirmTitle",
    message: "Clear all encrypted data?",
  }),
  profilesClearedNotice: msg({
    id: "common.profilesClearedNotice",
    message:
      "All saved profiles have been cleared. Add a server to start fresh.",
  }),
  encryptionSessionOnlyBadge: msg({
    id: "common.encryptionSessionOnlyBadge",
    message: "Session only",
  }),
  encryptionEncryptedBadge: msg({
    id: "common.encryptionEncryptedBadge",
    message: "Encrypted",
  }),
  encryptionLockedBadge: msg({
    id: "common.encryptionLockedBadge",
    message: "Locked",
  }),
  encryptionCorruptedBadge: msg({
    id: "common.encryptionCorruptedBadge",
    message: "Corrupted",
  }),
  appErrorTitle: msg({
    id: "common.appErrorTitle",
    message: "Headscale UI ran into a problem",
  }),
  appErrorDescription: msg({
    id: "common.appErrorDescription",
    message:
      "This page could not finish loading or displaying. This is usually temporary, for example after an update, in private browsing, or with outdated cached files. Try again to reload. Saved connections are not deleted.",
  }),
  copyFailed: msg({
    id: "common.copyFailed",
    message: "Copy failed. Select the text and copy it manually.",
  }),
  unsupportedServerVersion: msg({
    id: "common.unsupportedServerVersion",
    message:
      "This server reports Headscale {version}, but this app targets 0.29.x. Some pages may fail to load or show incomplete data.",
  }),
  machineCount: msg({
    id: "common.machineCount",
    message: "Machines shown: {shown} of {total}",
  }),
  inviteCount: msg({
    id: "common.inviteCount",
    message: "Auth keys shown: {shown} of {total}",
  }),
  serverVersionUnreadable: msg({
    id: "common.serverVersionUnreadable",
    message:
      "This server reports Headscale {version}, which this app does not support, and its response could not be read. Use a Headscale 0.29.x server.",
  }),
  primaryNavigation: msg({
    id: "common.primaryNavigation",
    message: "Main navigation",
  }),
  usersShown: msg({
    id: "common.usersShown",
    message: "Users shown: {shown} of {total}",
  }),
};
export type MessageKey = keyof typeof commonDescriptors;
export const productDescriptors = {
  policyCheckFailed: msg({
    id: "product.policyCheckFailed",
    message: "Policy check did not pass",
  }),
  policyReadOnlyTitle: msg({
    id: "product.policyReadOnlyTitle",
    message: "Policy editing is unavailable",
  }),
  policySaveConflictTitle: msg({
    id: "product.policySaveConflictTitle",
    message: "Policy changed on the server",
  }),
  policyInventoryUnknownTitle: msg({
    id: "product.policyInventoryUnknownTitle",
    message: "Required sources are unverified",
  }),
  policyReferenceHelp: msg({
    id: "product.policyReferenceHelp",
    message: "About this stale reference",
  }),
  feedbackRequestConfirmed: msg({
    id: "product.feedbackRequestConfirmed",
    message: "Request confirmed",
  }),
  feedbackRequestNotSent: msg({
    id: "product.feedbackRequestNotSent",
    message: "Request not sent",
  }),
  feedbackRequestRejected: msg({
    id: "product.feedbackRequestRejected",
    message: "Request rejected",
  }),
  feedbackPossiblyApplied: msg({
    id: "product.feedbackPossiblyApplied",
    message: "The change may have been applied",
  }),
  feedbackRefreshFailed: msg({
    id: "product.feedbackRefreshFailed",
    message: "Could not refresh data",
  }),
  feedbackDataStale: msg({
    id: "product.feedbackDataStale",
    message: "Some data may be out of date",
  }),
  feedbackStatus: msg({
    id: "product.feedbackStatus",
    message: "Data and operation status",
  }),
  feedbackRecentResults: msg({
    id: "product.feedbackRecentResults",
    message: "Recent results in this session",
  }),
  feedbackRecentResultsHint: msg({
    id: "product.feedbackRecentResultsHint",
    message:
      "Only the latest result per operation type is shown. This view does not include targets or an operation history.",
  }),
  feedbackNetworkData: msg({
    id: "product.feedbackNetworkData",
    message: "Machines, routes and server status",
  }),
  feedbackIdentityData: msg({
    id: "product.feedbackIdentityData",
    message: "Users and keys",
  }),
  policyUnmodeledReview: msg({
    id: "product.policyUnmodeledReview",
    message:
      "Unmodeled reference locations are preserved in the complete document below. Review them at the actual configuration source; automatic identity rewrites are blocked.",
  }),
  inviteCreatedAt: msg({
    id: "product.inviteCreatedAt",
    message: "Created at",
  }),
  policyRenameReview: msg({
    id: "product.policyRenameReview",
    message: "Review this policy-only rename",
  }),
  policyRenameScope: msg({
    id: "product.policyRenameScope",
    message:
      "Only the policy definition and modeled references will be renamed. The current device and usable-key inventory must be empty; external configuration must be checked. This is not a global rename.",
  }),
  policyRenameInUse: msg({
    id: "product.policyRenameInUse",
    message:
      "This name is still used by devices or usable invitations. Use the explicit migration inventory instead of a policy-only rename.",
  }),
  policyRenameExternal: msg({
    id: "product.policyRenameExternal",
    message:
      "I checked external configuration and reviewed the full policy-only rename scope.",
  }),
  policyRenameConfirm: msg({
    id: "product.policyRenameConfirm",
    message: "Keep the reviewed rename in the policy draft",
  }),
  policyDraftAdded: msg({
    id: "product.policyDraftAdded",
    message: "Pending declaration in the local draft",
  }),
  policyDraftChanged: msg({
    id: "product.policyDraftChanged",
    message: "Local definition or access changes",
  }),
  policyDraftRemoved: msg({
    id: "product.policyDraftRemoved",
    message: "Pending removal from the local draft",
  }),
  restorePersonalLead: msg({
    id: "product.restorePersonalLead",
    message:
      "Restore a tagged device to personal user identity through non-authkey reauthentication. Node ID, IP addresses and uninterrupted access are not guaranteed.",
  }),
  restoreBackup: msg({
    id: "product.restoreBackup",
    message: "I have a working backup management channel for this device.",
  }),
  restoreClientInstructions: msg({
    id: "product.restoreClientInstructions",
    message:
      "On the target device, clear advertised tags and force reauthentication using its existing non-authkey sign-in method. This console does not run commands remotely. Do not substitute an untagged auth key.",
  }),
  restoreTargetUser: msg({
    id: "product.restoreTargetUser",
    message: "Explicit target user",
  }),
  restoreChooseUser: msg({
    id: "product.restoreChooseUser",
    message: "Choose a target user",
  }),
  restoreUserChanged: msg({
    id: "product.restoreUserChanged",
    message:
      "The chosen user was removed or renamed. Choose and verify the intended user again; no replacement user was selected.",
  }),
  restorePublicServer: msg({
    id: "product.restorePublicServer",
    message: "Confirmed public login-server",
  }),
  restoreServerConfirm: msg({
    id: "product.restoreServerConfirm",
    message:
      "I verified this public login-server in the deployment configuration; it may differ from the API proxy.",
  }),
  restoreSourceConfirm: msg({
    id: "product.restoreSourceConfirm",
    message:
      "Through the target device’s trusted management channel, I verified that this exact Auth ID or link belongs to this device and this reauthentication attempt.",
  }),
  restoreSourceRequired: msg({
    id: "product.restoreSourceRequired",
    message:
      "A same-server link is not proof of the target device. Verify the request through its trusted device channel before approving.",
  }),
  restoreWrongServer: msg({
    id: "product.restoreWrongServer",
    message:
      "The registration link belongs to a different public login-server. No approval will be sent.",
  }),
  restoreApprove: msg({
    id: "product.restoreApprove",
    message: "Approve this device for the selected user",
  }),
  restoreUncertain: msg({
    id: "product.restoreUncertain",
    message:
      "Approval was confirmed, but the original device could not be reliably linked. Personal identity restoration is still unconfirmed.",
  }),
  restoreIdentityObserved: msg({
    id: "product.restoreIdentityObserved",
    message:
      "Current readback matches the intended user, empty tags and original device identity. Connectivity is a separate check.",
  }),
  restoreIdentityPending: msg({
    id: "product.restoreIdentityPending",
    message:
      "Approval was confirmed; the intended identity has not yet been confirmed by readback.",
  }),
  restoreConnectivity: msg({
    id: "product.restoreConnectivity",
    message:
      "Verify SSH, management access and required allowed and denied connections separately.",
  }),
  restoreEphemeral: msg({
    id: "product.restoreEphemeral",
    message:
      "Check that the old auth-key association is gone. For an ephemeral device, verify survival after disconnecting beyond the cleanup window and restarting; the approval response is not proof.",
  }),
  restoreLateFailure: msg({
    id: "product.restoreLateFailure",
    message:
      "The approval may have changed the device and consumed the Auth ID. The input was cleared and will not be replayed. Retain the intended target and use read-only verification or your deployment’s manual authentication procedure.",
  }),
  restoreNameRace: msg({
    id: "product.restoreNameRace",
    message:
      "The server registers by user name. This ID/name check is not a server-side compare-and-swap and cannot prevent concurrent name reuse.",
  }),
  restoreNoAutomatic: msg({
    id: "product.restoreNoAutomatic",
    message: "No remote command or automatic identity change is performed.",
  }),
  restoreRefreshFailed: msg({
    id: "product.restoreRefreshFailed",
    message:
      "Approval was confirmed, but readback failed. Read again without resending the Auth ID.",
  }),
  restoreObservationFailed: msg({
    id: "product.restoreObservationFailed",
    message:
      "The current device and user state could not be read. The original approval outcome is unchanged. Do not resend the old Auth ID.",
  }),
  restoreRereadForReview: msg({
    id: "product.restoreRereadForReview",
    message: "Reread device baseline for review",
  }),
  restoreBaselineReread: msg({
    id: "product.restoreBaselineReread",
    message:
      "The current device baseline has been reread. Review the raw user and complete tags, then confirm the server, backup management channel and request source again. No approval has been sent.",
  }),
  restoreBaselineUnavailable: msg({
    id: "product.restoreBaselineUnavailable",
    message:
      "This device baseline cannot be safely and uniquely rebuilt, or its user has changed. No approval has been sent. Close this flow and verify the device through a trusted channel before starting again.",
  }),
  restoreBaselineReadFailed: msg({
    id: "product.restoreBaselineReadFailed",
    message:
      "The device baseline could not be reread. The unsubmitted request is retained, but approval is blocked. Read again and review the current device before confirming.",
  }),
  restoreAssociationPending: msg({
    id: "product.restoreAssociationPending",
    message:
      "The old auth-key association is still present or could not be confirmed cleared.",
  }),
  restoreAssociationCleared: msg({
    id: "product.restoreAssociationCleared",
    message:
      "Current readback no longer shows an auth-key association; runtime cleanup and connectivity still need verification.",
  }),
  restoreNewRequest: msg({
    id: "product.restoreNewRequest",
    message:
      "For another attempt, initiate a new authentication request on the target device; never reuse the consumed Auth ID.",
  }),
  inviteCreateResponseUnknown: msg({
    id: "product.inviteCreateResponseUnknown",
    message: "Response unknown",
  }),
  inviteCreatePossiblyApplied: msg({
    id: "product.inviteCreatePossiblyApplied",
    message: "Server error; creation may have been applied",
  }),
  tagAllSelected: msg({
    id: "product.tagAllSelected",
    message: "All compatible tags are already selected.",
  }),
  policyRetirementDefinition: msg({
    id: "product.policyRetirementDefinition",
    message:
      "The policy definition still exists. Review and publish its removal in Access controls before checking retirement again:",
  }),
  policyRetirementExternalMissing: msg({
    id: "product.policyRetirementExternalMissing",
    message:
      "External deployment dependencies have not been confirmed cleared.",
  }),
  tagNoSuggestions: msg({
    id: "product.tagNoSuggestions",
    message:
      "No known tag suggestions. Enter a legal tag to add it without a policy definition.",
  }),
  tagReview: msg({
    id: "product.tagReview",
    message: "Review the complete target set",
  }),
  tagApply: msg({
    id: "product.tagApply",
    message: "Confirm complete tag replacement",
  }),
  tagDecisionChanged: msg({
    id: "product.tagDecisionChanged",
    message:
      "The device identity, tags, policy or server version changed. Your selection is retained; review the new baseline before confirming again.",
  }),
  tagFreshReadRequired: msg({
    id: "product.tagFreshReadRequired",
    message:
      "Fresh device and policy reads are required before this write. No write was sent.",
  }),
  tagNoChange: msg({
    id: "product.tagNoChange",
    message: "The current tag set already matches. No write is needed.",
  }),
  tagIdentityImpact: msg({
    id: "product.tagIdentityImpact",
    message:
      "Personal user identity will become tag identity. Access rules, autogroup matches and this management connection may change. Verify access separately.",
  }),
  tagRestorePersonal: msg({
    id: "product.tagRestorePersonal",
    message: "Restore personal identity",
  }),
  tagWriteConfirmed: msg({
    id: "product.tagWriteConfirmed",
    message:
      "The server confirmed the write. Connectivity and durable storage have not been independently verified.",
  }),
  tagRefreshFailed: msg({
    id: "product.tagRefreshFailed",
    message:
      "The write was confirmed, but the list refresh failed. Read again; do not resend.",
  }),
  writeOutcomeVerifyInDevices: msg({
    id: "product.writeOutcomeVerifyInDevices",
    message:
      "The request outcome is unknown. Verify the current state in the Machines or Auth keys list. Nothing is retried automatically.",
  }),
  writeOutcomeVerifyInAccess: msg({
    id: "product.writeOutcomeVerifyInAccess",
    message:
      "The policy write outcome is unknown. Verify the current policy in Access controls. Nothing is retried automatically.",
  }),
  tagUnresolved: msg({
    id: "product.tagUnresolved",
    message:
      "The request outcome is unknown. Verify the current state in the Machines or Auth keys list. Nothing is retried automatically.",
  }),
  tagPolicyDependency: msg({
    id: "product.tagPolicyDependency",
    message:
      "The policy write outcome is unknown. Verify the current policy in Access controls. Nothing is retried automatically.",
  }),
  tagReadOnlyCheck: msg({
    id: "product.tagReadOnlyCheck",
    message: "Read current state only",
  }),
  tagObservedMatch: msg({
    id: "product.tagObservedMatch",
    message:
      "The current observation matches the target. This does not prove the original request or durable storage succeeded.",
  }),
  tagObservedConflict: msg({
    id: "product.tagObservedConflict",
    message:
      "The current observation differs from the submitted target. Keep your draft and review the differences.",
  }),
  tagOperatorVerify: msg({
    id: "product.tagOperatorVerify",
    message: "Verify the current state in the Machines or Auth keys list.",
  }),
  tagReleaseGate: msg({
    id: "product.tagReleaseGate",
    message:
      "The request outcome is unknown. Verify the current state in the Machines or Auth keys list. Nothing is retried automatically.",
  }),
  tagPriorUnresolved: msg({
    id: "product.tagPriorUnresolved",
    message:
      "The request outcome is unknown. Verify the current state in the Machines or Auth keys list. Nothing is retried automatically.",
  }),
  tagCompleteSet: msg({
    id: "product.tagCompleteSet",
    message: "Complete target tag set",
  }),
  tagReturnReadFailed: msg({
    id: "product.tagReturnReadFailed",
    message:
      "Could not refresh before restoring. Your saved non-secret inputs are retained; retry or cancel the return.",
  }),
  tagReturnNewerEdit: msg({
    id: "product.tagReturnNewerEdit",
    message:
      "The form or view changed during restoration. Your earlier tag draft is still kept; close any open form before choosing to restore or discard it.",
  }),
  tagReturnRetry: msg({
    id: "product.tagReturnRetry",
    message: "Retry restoring inputs",
  }),
  tagConfirmationStale: msg({
    id: "product.tagConfirmationStale",
    message:
      "The session or server changed. Reopen this operation and confirm again.",
  }),
  setupExpiredReturn: msg({
    id: "product.setupExpiredReturn",
    message:
      "The original absolute expiration is now in the past. Choose a new expiration explicitly; it has not been extended.",
  }),
  setupKeyAwaitingDevice: msg({
    id: "product.setupKeyAwaitingDevice",
    message: "Auth key created. The device has not been verified as joined.",
  }),
  policyPublishAll: msg({
    id: "product.policyPublishAll",
    message: "Publish all policy changes",
  }),
  policyPublishReview: msg({
    id: "product.policyPublishReview",
    message: "Review the complete policy publication",
  }),
  policyPublishScope: msg({
    id: "product.policyPublishScope",
    message:
      "This sends the entire policy, including all existing ACL and ownership drafts. It does not assign device tags or update invitations.",
  }),
  policyRawOriginal: msg({
    id: "product.policyRawOriginal",
    message: "Original raw policy",
  }),
  policyRawCurrent: msg({
    id: "product.policyRawCurrent",
    message: "Latest policy readback",
  }),
  policyFullSubmitted: msg({
    id: "product.policyFullSubmitted",
    message: "Full policy to submit",
  }),
  policyRawDiff: msg({
    id: "product.policyRawDiff",
    message: "Complete raw before/after comparison",
  }),
  policyPublishRace: msg({
    id: "product.policyPublishRace",
    message:
      "The policy will be read again before writing. This is not a compare-and-swap or a cross-resource snapshot; coordinate a single writer and keep a restricted raw backup when needed.",
  }),
  policyPublishCheckScope: msg({
    id: "product.policyPublishCheckScope",
    message:
      "Policy check validates acceptability only. It does not prove write permission, loaded runtime state, durability, or connectivity.",
  }),
  policyPrereadFailed: msg({
    id: "product.policyPrereadFailed",
    message:
      "Could not read the current policy. This does not mean the write failed. Verify the current policy in Access controls. Nothing is retried automatically.",
  }),
  policyDraftOnly: msg({
    id: "product.policyDraftOnly",
    message: "Keep in policy draft",
  }),
  policyBufferedInvalid: msg({
    id: "product.policyBufferedInvalid",
    message:
      "Correct the invalid or unfinished local inputs before keeping or publishing changes.",
  }),
  policyReadbackDefinition: msg({
    id: "product.policyReadbackDefinition",
    message: "Recently read declaration",
  }),
  policyDraftDefinition: msg({
    id: "product.policyDraftDefinition",
    message: "Local draft only — not an assignment candidate",
  }),
  policyDefinitionAbsent: msg({
    id: "product.policyDefinitionAbsent",
    message: "Undeclared in the latest readback",
  }),
  policyDefinitionUnknown: msg({
    id: "product.policyDefinitionUnknown",
    message: "Declaration unknown — policy read unavailable",
  }),
  policyObservedNodes: msg({
    id: "product.policyObservedNodes",
    message: "Device observations",
  }),
  policyObservedKeys: msg({
    id: "product.policyObservedKeys",
    message: "Invitation observations",
  }),
  policyObservedReferences: msg({
    id: "product.policyObservedReferences",
    message: "Policy references",
  }),
  policyDeclaredSource: msg({
    id: "product.policyDeclaredSource",
    message: "Policy definition",
  }),
  policyDeclareTag: msg({
    id: "product.policyDeclareTag",
    message: "Declare this name with empty client owners",
  }),
  policyIncompatibleTag: msg({
    id: "product.policyIncompatibleTag",
    message:
      "This observed name cannot be declared by policy. Use a compatible replacement tag; do not keep retrying declaration.",
  }),
  policyManagementIncompatible: msg({
    id: "product.policyManagementIncompatible",
    message:
      "This policy name is preserved, but the administrator device and invitation APIs require a compatible lowercase name.",
  }),
  policyEmptyOwners: msg({
    id: "product.policyEmptyOwners",
    message:
      "No members are authorized here to request this tag through the client. Administrator assignment and tagged invitations use different contracts.",
  }),
  policyOwnerImpact: msg({
    id: "product.policyOwnerImpact",
    message:
      "Client owners and network access are separate. Adding an owner does not create a flow rule, but may let that identity match existing rules. Removing owners does not clear device tags or revoke issued invitations.",
  }),
  policyOwnerDependencies: msg({
    id: "product.policyOwnerDependencies",
    message: "Client authorization dependency paths",
  }),
  policyDependencyDisclaimer: msg({
    id: "product.policyDependencyDisclaimer",
    message:
      "These are declared direct, group, and nested-tag dependencies, not a Headscale-equivalent authorization evaluator. Existing nested owners are preserved; adding new nested owners is not offered.",
  }),
  policyImplicitAccess: msg({
    id: "product.policyImplicitAccess",
    message:
      "The original policy has implicit default allow. Declaring a tag preserves that access baseline; restricting traffic is a separate change.",
  }),
  policyExplicitAccess: msg({
    id: "product.policyExplicitAccess",
    message:
      "Explicit ACL/grants restrictions, including empty lists, are preserved. Definition changes do not imply connectivity has been verified.",
  }),
  policyManageReturn: msg({
    id: "product.policyManageReturn",
    message: "Return to the original form — continue without submitting",
  }),
  policyManageContext: msg({
    id: "product.policyManageContext",
    message:
      "Managing {tag} for {source}. Non-secret original inputs are retained; returning will refresh and revalidate them.",
  }),
  policyManageDraftWarning: msg({
    id: "product.policyManageDraftWarning",
    message:
      "Existing policy drafts are retained. Publish all changes explicitly, finish those drafts first, or return without publishing.",
  }),
  policyReadOnlyAssignment: msg({
    id: "product.policyReadOnlyAssignment",
    message:
      "Policy writing is unavailable here. This does not globally prohibit administrator SetTags for compatible definitions in the latest readback; the loaded server policy remains the final authority.",
  }),
  policyKnownReadOnly: msg({
    id: "product.policyKnownReadOnly",
    message:
      "Headscale rejected policy writing in this configuration. Ask the configuration owner to edit, check and load the actual source; this page will not change mode or restart it.",
  }),
  policyInventoryRefresh: msg({
    id: "product.policyInventoryRefresh",
    message: "Refresh required sources",
  }),
  policyInventoryUnknown: msg({
    id: "product.policyInventoryUnknown",
    message:
      "Required sources are unknown or stale. Old observations remain visible, but automatic removal and retirement are blocked.",
  }),
  policyInventoryReadback: msg({
    id: "product.policyInventoryReadback",
    message:
      "Current observations are not proof of runtime loading, persistent storage, or client connectivity.",
  }),
  policyViewInvites: msg({
    id: "product.policyViewInvites",
    message: "View exact matching invitations",
  }),
  policyViewDevice: msg({
    id: "product.policyViewDevice",
    message: "Review device tags",
  }),
  policyMaintenance: msg({
    id: "product.policyMaintenance",
    message: "Live tag maintenance",
  }),
  policyMigrate: msg({
    id: "product.policyMigrate",
    message: "Migrate identity",
  }),
  policyStopEntrances: msg({
    id: "product.policyStopEntrances",
    message: "Stop known registration entrances",
  }),
  policyRetirement: msg({
    id: "product.policyRetirement",
    message: "Retirement check",
  }),
  policyPolicyOnlyRemove: msg({
    id: "product.policyPolicyOnlyRemove",
    message: "Remove only the policy definition and listed references",
  }),
  policyPolicyOnlyScope: msg({
    id: "product.policyPolicyOnlyScope",
    message:
      "This deliberately changes only policy, even when known devices or invitations still use the name. It does not change those resources, globally revoke the identity, or complete retirement.",
  }),
  policyMigrationNew: msg({
    id: "product.policyMigrationNew",
    message: "Move to a new identity",
  }),
  policyMigrationExisting: msg({
    id: "product.policyMigrationExisting",
    message: "Use an existing identity",
  }),
  policyMigrationTarget: msg({
    id: "product.policyMigrationTarget",
    message: "Target tag",
  }),
  policyMigrationOccupied: msg({
    id: "product.policyMigrationOccupied",
    message:
      "This target is already observed in policy, devices, or invitations, including key-only use. It is not a new identity.",
  }),
  policyMigrationMissing: msg({
    id: "product.policyMigrationMissing",
    message:
      "Select an applicable definition from the latest successful policy readback, not an unpublished draft.",
  }),
  policyMigrationReview: msg({
    id: "product.policyMigrationReview",
    message:
      "Review both identities and expected allowed and denied traffic. Existing target owners and rules are not merged or copied; no dual-tagging is performed.",
  }),
  policyMigrationSequence: msg({
    id: "product.policyMigrationSequence",
    message:
      "Prepare and pilot the replacement definition, rules, keys and client configuration first. Then stop known old entrances, refresh, and review each remaining resource. Reopening rebuilds this inventory; nothing runs in the background.",
  }),
  policyMigrationPrepare: msg({
    id: "product.policyMigrationPrepare",
    message: "Prepare empty target definition in the policy draft",
  }),
  policyMigrationPreserve: msg({
    id: "product.policyMigrationPreserve",
    message:
      "Each device operation replaces only this tag in the full set, deduplicates the target, and preserves unrelated tags. Review the complete set in the device editor.",
  }),
  policyMigrationPending: msg({
    id: "product.policyMigrationPending",
    message:
      "Write outcome unknown — verify the current state in the relevant list.",
  }),
  policyMigrationObserved: msg({
    id: "product.policyMigrationObserved",
    message:
      "Current target observed — not a durability or connectivity guarantee",
  }),
  policyStopScope: msg({
    id: "product.policyStopScope",
    message:
      "Review client owners and each invitation separately. Keep production devices and definitions if needed. No global disable or permanent name tombstone is created; administrators can still issue new tagged keys.",
  }),
  policyKeyDeployment: msg({
    id: "product.policyKeyDeployment",
    message:
      "Expired or consumed keys may still be referenced by old deployments and eligible re-registration paths. Expiration is not deletion and neither removes existing device identities.",
  }),
  policyExternalConfirm: msg({
    id: "product.policyExternalConfirm",
    message:
      "The external deployment owner has verified scripts, offline clients and old-key re-registration dependencies, and confirmed no unresolved use.",
  }),
  policyRetirementBlocked: msg({
    id: "product.policyRetirementBlocked",
    message:
      "Retirement is blocked by current devices, registration entrances, policy references, unknown sources, or unconfirmed external deployments.",
  }),
  policyRetirementObserved: msg({
    id: "product.policyRetirementObserved",
    message:
      "Current managed observations are clear and the external deployment owner has confirmed. This is not a permanent guarantee against this name reappearing.",
  }),
  policyPendingTitle: msg({
    id: "product.policyPendingTitle",
    message: "Policy write outcome unknown",
  }),
  policyPendingBody: msg({
    id: "product.policyPendingBody",
    message:
      "The policy write outcome is unknown. Verify the current policy in Access controls. Nothing is retried automatically.",
  }),
  policyPendingRead: msg({
    id: "product.policyPendingRead",
    message: "Read policy only",
  }),
  policyPendingMatches: msg({
    id: "product.policyPendingMatches",
    message:
      "Current policy observation matches the submitted target; the original request result remains unresolved.",
  }),
  policyPendingDiffers: msg({
    id: "product.policyPendingDiffers",
    message:
      "Current policy observation differs from the submitted target. Keep newer drafts and review the difference.",
  }),
  policyPendingOperator: msg({
    id: "product.policyPendingOperator",
    message: "Verify the current policy in Access controls.",
  }),
  policyPendingRelease: msg({
    id: "product.policyPendingRelease",
    message:
      "The policy write outcome is unknown. Verify the current policy in Access controls. Nothing is retried automatically.",
  }),
  policyPendingReleased: msg({
    id: "product.policyPendingReleased",
    message:
      "The policy write outcome is unknown. Verify the current policy in Access controls. Nothing is retried automatically.",
  }),
  inviteCreatorLabel: msg({
    id: "product.inviteCreatorLabel",
    message: "Key creation-associated user",
  }),
  inviteUserUnavailable: msg({
    id: "product.inviteUserUnavailable",
    message:
      "The selected user is no longer available. Choose a user explicitly or choose no owner for a tagged key.",
  }),
  inviteKeyCreatedNotJoined: msg({
    id: "product.inviteKeyCreatedNotJoined",
    message: "Key created. No device registration has been verified.",
  }),
  inviteManageTags: msg({
    id: "product.inviteManageTags",
    message: "Manage tag definitions in Access",
  }),
  inviteReturnReadFailed: msg({
    id: "product.inviteReturnReadFailed",
    message:
      "Could not refresh the users and policy. Your invitation input is retained; retry before restoring it.",
  }),
  inviteRetryReturn: msg({
    id: "product.inviteRetryReturn",
    message: "Retry restoring invitation",
  }),
  inviteExactTag: msg({ id: "product.inviteExactTag", message: "Exact tag" }),
  inviteClearTag: msg({
    id: "product.inviteClearTag",
    message: "Clear tag filter",
  }),
  inviteRegistrationReady: msg({
    id: "product.inviteRegistrationReady",
    message: "Available for new registration",
  }),
  inviteRegistrationUsed: msg({
    id: "product.inviteRegistrationUsed",
    message: "Used one-time key; unavailable for new registration",
  }),
  inviteRegistrationExpired: msg({
    id: "product.inviteRegistrationExpired",
    message: "Expired; unavailable for new registration",
  }),
  inviteOldDeploymentHint: msg({
    id: "product.inviteOldDeploymentHint",
    message:
      "Expired or used keys may still be referenced by old deployments. Some existing-node re-registration paths can skip expiry or usage checks. Review the deployment and server records separately; expiration is not deletion.",
  }),
  inviteExpiryEffectHint: msg({
    id: "product.inviteExpiryEffectHint",
    message:
      "Expiring a key blocks new registrations that require normal validation. It does not remove existing devices or guarantee that every existing-node re-registration is blocked.",
  }),
  inviteDeleteEffectHint: msg({
    id: "product.inviteDeleteEffectHint",
    message:
      "Deleting a key makes requests carrying it fail at key lookup. It does not remove existing devices, clear their tags, or immediately disconnect them.",
  }),
  inviteStopUnresolved: msg({
    id: "product.inviteStopUnresolved",
    message:
      "The outcome of the request to expire or delete this auth key is unknown. Verify its current state in the Auth keys list. Nothing is retried automatically.",
  }),
  inviteRotationHint: msg({
    id: "product.inviteRotationHint",
    message:
      "A replacement tagged key can replace an existing device’s complete tag set and affect ephemeral behavior. Review all tags and test deployment before retiring the old key.",
  }),
  inviteCreateUnknown: msg({
    id: "product.inviteCreateUnknown",
    message:
      "The creation outcome is unknown. A key may have been created. Verify the current state in the Auth keys list. Nothing is retried automatically.",
  }),
  inviteCreateManualCheck: msg({
    id: "product.inviteCreateManualCheck",
    message:
      "Verify the current state in the Auth keys list. Matching tags or options do not identify this operation. Do not revoke other keys based on those matches. Nothing is retried automatically.",
  }),
  inviteCreateBefore: msg({
    id: "product.inviteCreateBefore",
    message: "Inventory before creation",
  }),
  inviteCreateAfter: msg({
    id: "product.inviteCreateAfter",
    message: "Current inventory after creation",
  }),
  inviteCreateInventoryUnknown: msg({
    id: "product.inviteCreateInventoryUnknown",
    message:
      "Inventory read failed or has not completed; the list is not known to be complete.",
  }),
  inviteCreateReadOnly: msg({
    id: "product.inviteCreateReadOnly",
    message: "Refresh inventory only",
  }),
  inviteCreateNewOperation: msg({
    id: "product.inviteCreateNewOperation",
    message: "Start a separate new creation",
  }),
  inviteCreateNewOperationHint: msg({
    id: "product.inviteCreateNewOperationHint",
    message:
      "Creating another key sends a new request. A key from the previous request may already exist. Nothing is retried automatically.",
  }),
  inviteCreateConfirmedRefreshFailed: msg({
    id: "product.inviteCreateConfirmedRefreshFailed",
    message:
      "Key creation was confirmed, but refreshing the inventory failed. Do not create another key just to refresh the list.",
  }),
  inviteCreateReadFailed: msg({
    id: "product.inviteCreateReadFailed",
    message:
      "Could not read the current key inventory. No creation request was sent.",
  }),
  inviteCreateReviewRequired: msg({
    id: "product.inviteCreateReviewRequired",
    message:
      "The request outcome is unknown. Verify the current state in the Auth keys list. Nothing is retried automatically.",
  }),
  tagSelection: msg({
    id: "product.tagSelection",
    message: "Current selection",
  }),
  tagSearch: msg({
    id: "product.tagSearch",
    message: "Search tags (optional)",
  }),
  tagAdd: msg({ id: "product.tagAdd", message: "Add this tag" }),
  tagNoOptions: msg({
    id: "product.tagNoOptions",
    message:
      "No compatible tag definitions were read. Create or align the policy definition first.",
  }),
  tagNoMatches: msg({
    id: "product.tagNoMatches",
    message: "No matching tags. Clear the search to see available tags.",
  }),
  tagDeclared: msg({
    id: "product.tagDeclared",
    message: "Declared in the last policy read",
  }),
  tagUndeclared: msg({
    id: "product.tagUndeclared",
    message: "Not declared in the last policy read",
  }),
  tagDefinitionUnknown: msg({
    id: "product.tagDefinitionUnknown",
    message: "Definition could not be read",
  }),
  tagDefine: msg({ id: "product.tagDefine", message: "Add policy definition" }),
  tagReplaceIncompatible: msg({
    id: "product.tagReplaceIncompatible",
    message: "Use a compatible replacement tag",
  }),
  tagKeyUndeclaredHint: msg({
    id: "product.tagKeyUndeclaredHint",
    message:
      "A legal undeclared tag can be used for a key. Later device management may require a policy definition.",
  }),
  tagReadbackHint: msg({
    id: "product.tagReadbackHint",
    message:
      "Suggestions come from the last policy read, not unpublished edits; this does not prove the runtime policy is loaded.",
  }),
  tagPolicyUnreadable: msg({
    id: "product.tagPolicyUnreadable",
    message:
      "The policy could not be read or safely parsed. Retry the read; existing selections are retained.",
  }),
  tagRetry: msg({ id: "product.tagRetry", message: "Read again" }),
  nav: {
    home: msg({ id: "product.nav.home", message: "Overview" }),
    devices: msg({ id: "product.nav.devices", message: "Machines" }),
    members: msg({ id: "product.nav.members", message: "Users" }),
    invites: msg({ id: "product.nav.invites", message: "Auth keys" }),
    routes: msg({ id: "product.nav.routes", message: "Routes" }),
    access: msg({ id: "product.nav.access", message: "Access controls" }),
  },
  dashboardTitle: msg({
    id: "product.dashboardTitle",
    message: "Tailnet overview",
  }),
  dashboardSubtitle: msg({
    id: "product.dashboardSubtitle",
    message: "A home base for devices, people and private routes.",
  }),
  onlineDevices: msg({
    id: "product.onlineDevices",
    message: "Online devices",
  }),
  totalDevices: msg({ id: "product.totalDevices", message: "Total devices" }),
  openInvites: msg({
    id: "product.openInvites",
    message: "Unused, unexpired auth keys",
  }),
  advertisedRoutes: msg({
    id: "product.advertisedRoutes",
    message: "Advertised routes",
  }),
  recentDevices: msg({
    id: "product.recentDevices",
    message: "Recent machines",
  }),
  devicesTitle: msg({ id: "product.devicesTitle", message: "Machines" }),
  devicesSubtitle: msg({
    id: "product.devicesSubtitle",
    message: "Manage the devices connected to your tailnet.",
  }),
  learnMore: msg({ id: "product.learnMore", message: "Learn more" }),
  searchDevices: msg({
    id: "product.searchDevices",
    message: "Search by name, owner, tag, version...",
  }),
  noDevices: msg({
    id: "product.noDevices",
    message: "No machines match these filters.",
  }),
  addFirstDevice: msg({
    id: "product.addFirstDevice",
    message: "Add your first device",
  }),
  addFirstDeviceDescription: msg({
    id: "product.addFirstDeviceDescription",
    message:
      "Install Tailscale on another device and connect it to this Headscale server.",
  }),
  addDevice: msg({ id: "product.addDevice", message: "Add device" }),
  addLinuxServerTitle: msg({
    id: "product.addLinuxServerTitle",
    message: "Add Linux server",
  }),
  addClientDeviceTitle: msg({
    id: "product.addClientDeviceTitle",
    message: "Add client device",
  }),
  pendingRegistrationTitle: msg({
    id: "product.pendingRegistrationTitle",
    message: "Register pending device",
  }),
  wizardStepPreferencesDescription: msg({
    id: "product.wizardStepPreferencesDescription",
    message: "Set tags and lifecycle behavior for the device.",
  }),
  wizardStepAuthKeyDescription: msg({
    id: "product.wizardStepAuthKeyDescription",
    message: "Choose how the authentication key behaves.",
  }),
  wizardStepGenerateDescription: msg({
    id: "product.wizardStepGenerateDescription",
    message: "Create the key and copy the connection command.",
  }),
  wizardStepPendingDescription: msg({
    id: "product.wizardStepPendingDescription",
    message: "Register or review a device that is waiting.",
  }),
  wizardStepResultDescription: msg({
    id: "product.wizardStepResultDescription",
    message: "Review the result and continue.",
  }),
  wizardResult: msg({ id: "product.wizardResult", message: "Result" }),
  nextStep: msg({ id: "product.nextStep", message: "Next" }),
  previousStep: msg({ id: "product.previousStep", message: "Back" }),
  finish: msg({ id: "product.finish", message: "Done" }),
  deviceSetupLead: msg({
    id: "product.deviceSetupLead",
    message:
      "Select preferences for your device to generate a connection command.",
  }),
  pendingRegistrationDescription: msg({
    id: "product.pendingRegistrationDescription",
    message: "Use the registration key shown by a device waiting for approval.",
  }),
  pendingRegistrationLead: msg({
    id: "product.pendingRegistrationLead",
    message:
      "Approve a device sign-in or SSH check that is waiting for this server.",
  }),
  registerPendingNode: msg({
    id: "product.registerPendingNode",
    message: "Register pending node",
  }),
  registeredNode: msg({
    id: "product.registeredNode",
    message: "Registered machine",
  }),
  setupDevice: msg({ id: "product.setupDevice", message: "Set up device" }),
  setupAuthKey: msg({
    id: "product.setupAuthKey",
    message: "Set up authentication key",
  }),
  generateInstallCommand: msg({
    id: "product.generateInstallCommand",
    message: "Generate connection command",
  }),
  generate: msg({ id: "product.generate", message: "Generate" }),
  manageTags: msg({
    id: "product.manageTags",
    message: "Manage tags in Access controls",
  }),
  useTagsDescription: msg({
    id: "product.useTagsDescription",
    message:
      "Authenticate and control access to the device using tags. Tagged servers do not need frequent key expiry.",
  }),
  ephemeralDescription: msg({
    id: "product.ephemeralDescription",
    message:
      "Automatically remove the device from your tailnet when it goes offline.",
  }),
  exitNodeDescription: msg({
    id: "product.exitNodeDescription",
    message: "Route traffic through this device on your network.",
  }),
  reusableDescription: msg({
    id: "product.reusableDescription",
    message: "Use this key to authenticate more than one device.",
  }),
  authKeyAutomationHint: msg({
    id: "product.authKeyAutomationHint",
    message: "Use this as part of automation to set up multiple devices.",
  }),
  authKeyExpirationDescription: msg({
    id: "product.authKeyExpirationDescription",
    message:
      "Set a short time window for authenticating this device. Existing devices keep their own expiry.",
  }),
  keyExpiryHint: msg({
    id: "product.keyExpiryHint",
    message:
      "Keep auth keys short-lived unless you are automating repeat installs.",
  }),
  days: msg({ id: "product.days", message: "days" }),
  mustBeBetweenDays: msg({
    id: "product.mustBeBetweenDays",
    message: "Must be between 1 and 90 days.",
  }),
  decreaseDays: msg({ id: "product.decreaseDays", message: "Decrease days" }),
  increaseDays: msg({ id: "product.increaseDays", message: "Increase days" }),
  loginServerUrl: msg({
    id: "product.loginServerUrl",
    message: "Login server URL",
  }),
  loginServerUrlHint: msg({
    id: "product.loginServerUrlHint",
    message:
      "The address devices use to reach Headscale. Change it when this console reaches the API through a proxy.",
  }),
  discardKeyTitle: msg({
    id: "product.discardKeyTitle",
    message: "Discard the uncopied auth key?",
  }),
  discardKeyDescription: msg({
    id: "product.discardKeyDescription",
    message:
      "The auth key will not be shown again. Copy it first, or create a new key later.",
  }),
  discardKeyConfirm: msg({
    id: "product.discardKeyConfirm",
    message: "Discard key and continue",
  }),
  devicesTableMachine: msg({
    id: "product.devicesTableMachine",
    message: "Machine",
  }),
  devicesTableUser: msg({ id: "product.devicesTableUser", message: "User" }),
  devicesTableRoutes: msg({
    id: "product.devicesTableRoutes",
    message: "Routes",
  }),
  devicesTableActivity: msg({
    id: "product.devicesTableActivity",
    message: "Activity",
  }),
  linuxServer: msg({ id: "product.linuxServer", message: "Linux server" }),
  linuxServerDescription: msg({
    id: "product.linuxServerDescription",
    message: "Services running on VMs, containers and routers.",
  }),
  clientDevice: msg({ id: "product.clientDevice", message: "Client device" }),
  clientDeviceDescription: msg({
    id: "product.clientDeviceDescription",
    message: "User-owned laptops, phones and desktops.",
  }),
  filters: msg({ id: "product.filters", message: "Filters" }),
  exportData: msg({ id: "product.exportData", message: "Export data" }),
  clearFilters: msg({ id: "product.clearFilters", message: "Clear filters" }),
  removeOwnerFilter: msg({
    id: "product.removeOwnerFilter",
    message: "Remove owner filter",
  }),
  allMachines: msg({ id: "product.allMachines", message: "All machines" }),
  onlineOnly: msg({ id: "product.onlineOnly", message: "Online" }),
  offlineOnly: msg({ id: "product.offlineOnly", message: "Offline" }),
  expiredOnly: msg({ id: "product.expiredOnly", message: "Expired" }),
  routeAdvertisers: msg({
    id: "product.routeAdvertisers",
    message: "Advertises routes",
  }),
  taggedOnly: msg({ id: "product.taggedOnly", message: "Tagged" }),
  owner: msg({ id: "product.owner", message: "Owner" }),
  addresses: msg({ id: "product.addresses", message: "Addresses" }),
  tags: msg({ id: "product.tags", message: "Tags" }),
  editTags: msg({ id: "product.editTags", message: "Edit tags" }),
  editNodeTagsTitle: msg({
    id: "product.editNodeTagsTitle",
    message: "Edit machine tags",
  }),
  editNodeTagsDescription: msg({
    id: "product.editNodeTagsDescription",
    message:
      "Directly overwrite the tags assigned to this machine. To change which teams can reach machines that share a label, edit the label policy under Access controls.",
  }),
  nodeTags: msg({ id: "product.nodeTags", message: "Machine tags" }),
  replaceTagsWarning: msg({
    id: "product.replaceTagsWarning",
    message: "Saving replaces the current tags instead of appending to them.",
  }),
  saveTags: msg({ id: "product.saveTags", message: "Save tags" }),
  tagUserNodeAcknowledge: msg({
    id: "product.tagUserNodeAcknowledge",
    message:
      "I understand that this removes the personal owner. Tags cannot be cleared with an empty tag update; restoring personal identity requires reauthentication without an auth key.",
  }),
  tagsRequiredForTaggedNode: msg({
    id: "product.tagsRequiredForTaggedNode",
    message:
      "Enter at least one tag. Headscale does not accept an empty tag list, even for an untagged machine.",
  }),
  invalidTags: msg({
    id: "product.invalidTags",
    message:
      "Use lowercase tags starting with tag:, for example tag:server. Separate tags with commas or spaces.",
  }),
  routes: msg({ id: "product.routes", message: "Routes" }),
  lastSeen: msg({ id: "product.lastSeen", message: "Last seen" }),
  expires: msg({ id: "product.expires", message: "Expires" }),
  status: msg({ id: "product.status", message: "Status" }),
  statusActive: msg({ id: "product.statusActive", message: "Active" }),
  actions: msg({ id: "product.actions", message: "Actions" }),
  details: msg({ id: "product.details", message: "Details" }),
  viewDetails: msg({ id: "product.viewDetails", message: "View details" }),
  viewMachines: msg({ id: "product.viewMachines", message: "View machines" }),
  viewRoutes: msg({ id: "product.viewRoutes", message: "View routes" }),
  machineDetails: msg({
    id: "product.machineDetails",
    message: "Machine details",
  }),
  userDetails: msg({ id: "product.userDetails", message: "User details" }),
  nodeId: msg({ id: "product.nodeId", message: "Node ID" }),
  userId: msg({ id: "product.userId", message: "User ID" }),
  registerMethod: msg({
    id: "product.registerMethod",
    message: "Register method",
  }),
  registerMethodAuthKey: msg({
    id: "product.registerMethodAuthKey",
    message: "Auth key",
  }),
  registerMethodCli: msg({ id: "product.registerMethodCli", message: "CLI" }),
  registerMethodOidc: msg({
    id: "product.registerMethodOidc",
    message: "OIDC",
  }),
  personalDevices: msg({
    id: "product.personalDevices",
    message: "Personal machines",
  }),
  activeAuthKeys: msg({
    id: "product.activeAuthKeys",
    message: "Active auth keys",
  }),
  policyReferences: msg({
    id: "product.policyReferences",
    message: "Team memberships and tag management",
  }),
  noPersonalDevices: msg({
    id: "product.noPersonalDevices",
    message: "No personal machines.",
  }),
  noPolicyReferences: msg({
    id: "product.noPolicyReferences",
    message: "No team memberships or tag management permissions.",
  }),
  unknown: msg({ id: "product.unknown", message: "Unknown" }),
  pendingRoutes: msg({
    id: "product.pendingRoutes",
    message: "Pending routes",
  }),
  exitRoute: msg({ id: "product.exitRoute", message: "Exit route" }),
  exitNode: msg({ id: "product.exitNode", message: "Exit node" }),
  routeStatusPending: msg({
    id: "product.routeStatusPending",
    message: "Pending",
  }),
  routeStatusApproved: msg({
    id: "product.routeStatusApproved",
    message: "Approved",
  }),
  routeStatusExit: msg({ id: "product.routeStatusExit", message: "Exit" }),
  rename: msg({ id: "product.rename", message: "Rename" }),
  renameMachineTitle: msg({
    id: "product.renameMachineTitle",
    message: "Rename machine",
  }),
  renameMachineDescription: msg({
    id: "product.renameMachineDescription",
    message: "Change the machine name shown in Headscale.",
  }),
  machineName: msg({ id: "product.machineName", message: "Machine name" }),
  saveName: msg({ id: "product.saveName", message: "Save name" }),
  invalidMachineName: msg({
    id: "product.invalidMachineName",
    message:
      "Use 1 to 63 letters, digits or hyphens, starting and ending with a letter or digit.",
  }),
  expire: msg({ id: "product.expire", message: "Expire" }),
  expireMachineTitle: msg({
    id: "product.expireMachineTitle",
    message: "Expire machine",
  }),
  expireMachineDescription: msg({
    id: "product.expireMachineDescription",
    message:
      "This will force the machine to re-authenticate before it can connect again.",
  }),
  confirmExpire: msg({
    id: "product.confirmExpire",
    message: "Expire machine",
  }),
  remove: msg({ id: "product.remove", message: "Remove" }),
  removeMachineTitle: msg({
    id: "product.removeMachineTitle",
    message: "Remove machine",
  }),
  removeMachineDescription: msg({
    id: "product.removeMachineDescription",
    message:
      "This removes the machine from Headscale and cannot be undone from this UI.",
  }),
  confirmRemove: msg({
    id: "product.confirmRemove",
    message: "Remove machine",
  }),
  cancel: msg({ id: "product.cancel", message: "Cancel" }),
  membersTitle: msg({ id: "product.membersTitle", message: "Users" }),
  membersSubtitle: msg({
    id: "product.membersSubtitle",
    message: "Manage the users in your network and their permissions.",
  }),
  addMember: msg({ id: "product.addMember", message: "Add user" }),
  searchUsers: msg({ id: "product.searchUsers", message: "Search users..." }),
  joined: msg({ id: "product.joined", message: "Joined" }),
  authSource: msg({ id: "product.authSource", message: "Auth source" }),
  memberName: msg({ id: "product.memberName", message: "User name" }),
  displayName: msg({ id: "product.displayName", message: "Display name" }),
  email: msg({ id: "product.email", message: "Email" }),
  optionalField: msg({ id: "product.optionalField", message: "(optional)" }),
  createMemberDescription: msg({
    id: "product.createMemberDescription",
    message:
      "The Headscale CLI uses the user name. Access controls selects a uniquely resolvable policy identity: email first, then user name, then provider identity. Display name is only a label. Duplicate emails can make existing policy identities ambiguous.",
  }),
  memberIdentityConflict: msg({
    id: "product.memberIdentityConflict",
    message:
      "This identity would make an existing policy reference ambiguous. Use a distinct user name or email.",
  }),
  memberFreshReadRequired: msg({
    id: "product.memberFreshReadRequired",
    message:
      "Read the user directory again before creating a user. No create request was sent.",
  }),
  userNameRequired: msg({
    id: "product.userNameRequired",
    message: "Enter a user name.",
  }),
  userNameInvalid: msg({
    id: "product.userNameInvalid",
    message: "User names cannot contain spaces or control characters.",
  }),
  userNameTaken: msg({
    id: "product.userNameTaken",
    message: "A user with this name already exists.",
  }),
  emailInvalid: msg({
    id: "product.emailInvalid",
    message: "Enter a valid email address, or leave this field empty.",
  }),
  createMember: msg({ id: "product.createMember", message: "Create user" }),
  deviceCount: msg({ id: "product.deviceCount", message: "devices" }),
  memberDevices: msg({ id: "product.memberDevices", message: "Devices" }),
  deleteMember: msg({ id: "product.deleteMember", message: "Delete user" }),
  renameMember: msg({ id: "product.renameMember", message: "Rename user" }),
  renameMemberTitle: msg({
    id: "product.renameMemberTitle",
    message: "Rename user",
  }),
  renameMemberDescription: msg({
    id: "product.renameMemberDescription",
    message: "Change the Headscale username used for this account.",
  }),
  saveMemberName: msg({
    id: "product.saveMemberName",
    message: "Save user name",
  }),
  deleteMemberTitle: msg({
    id: "product.deleteMemberTitle",
    message: "Delete user",
  }),
  deleteMemberDescription: msg({
    id: "product.deleteMemberDescription",
    message:
      "This removes the user from Headscale. Review their machines and auth keys before continuing.",
  }),
  confirmDeleteMember: msg({
    id: "product.confirmDeleteMember",
    message: "Delete user",
  }),
  noUsersMatch: msg({
    id: "product.noUsersMatch",
    message: "No users match these filters.",
  }),
  noUsersYet: msg({
    id: "product.noUsersYet",
    message: "No users yet. Add a user to get started.",
  }),
  membersLoading: msg({
    id: "product.membersLoading",
    message: "Loading users…",
  }),
  membersLoadFailed: msg({
    id: "product.membersLoadFailed",
    message: "Users could not be loaded.",
  }),
  noActiveAuthKeys: msg({
    id: "product.noActiveAuthKeys",
    message: "No active auth keys.",
  }),
  deleteMemberOwnsDevices: msg({
    id: "product.deleteMemberOwnsDevices",
    message:
      "Headscale refuses to delete a user who still owns machines. Remove these machines first:",
  }),
  invitesTitle: msg({ id: "product.invitesTitle", message: "Auth keys" }),
  invitesSubtitle: msg({
    id: "product.invitesSubtitle",
    message:
      "Create keys that let machines join without exposing server internals.",
  }),
  searchAuthKeys: msg({
    id: "product.searchAuthKeys",
    message: "Search keys, owners or tags...",
  }),
  inviteOwner: msg({ id: "product.inviteOwner", message: "Owner" }),
  noUsers: msg({ id: "product.noUsers", message: "No users available" }),
  inviteExpiration: msg({
    id: "product.inviteExpiration",
    message: "Expiration",
  }),
  dateTimePlaceholder: msg({
    id: "product.dateTimePlaceholder",
    message: "Pick date and time",
  }),
  expirationMustBeFuture: msg({
    id: "product.expirationMustBeFuture",
    message: "Choose an expiration in the future.",
  }),
  policySaveConflict: msg({
    id: "product.policySaveConflict",
    message:
      "The policy changed on the server. Your draft has been kept and was not saved. Discard your edits or reload the policy before trying again.",
  }),
  policySavedNewerEdits: msg({
    id: "product.policySavedNewerEdits",
    message: "Saved the submitted policy. Newer edits are still unsaved.",
  }),
  policySaveContextChanged: msg({
    id: "product.policySaveContextChanged",
    message:
      "The policy was saved. This editor has changed; review it before trying again.",
  }),
  teamNameInvalid: msg({
    id: "product.teamNameInvalid",
    message: "Team names cannot contain spaces, commas, colons (:) or @.",
  }),
  labelNameInvalid: msg({
    id: "product.labelNameInvalid",
    message:
      "Label names must start with a letter (A–Z) and cannot contain spaces, commas, colons (:) or @.",
  }),
  policyReferenceNameConflict: msg({
    id: "product.policyReferenceNameConflict",
    message: "That group or tag name is already in use.",
  }),
  policyReferenceEntityMissing: msg({
    id: "product.policyReferenceEntityMissing",
    message: "This group or tag no longer exists.",
  }),
  policyReferenceUnsupported: msg({
    id: "product.policyReferenceUnsupported",
    message: "This policy contains fields that cannot be updated safely.",
  }),
  policyIdentityRemovalImpact: msg({
    id: "product.policyIdentityRemovalImpact",
    message: "Affected rules: '{'rules'}'. Affected policy tests: '{'tests'}'.",
  }),
  policyTagRenameScope: msg({
    id: "product.policyTagRenameScope",
    message:
      "This renames the tag in the policy. Device tags and external configuration remain unchanged.",
  }),
  time: msg({ id: "product.time", message: "Time" }),
  hour: msg({ id: "product.hour", message: "Hour" }),
  minute: msg({ id: "product.minute", message: "Minute" }),
  reusable: msg({ id: "product.reusable", message: "Reusable" }),
  ephemeral: msg({ id: "product.ephemeral", message: "Ephemeral device" }),
  aclTags: msg({ id: "product.aclTags", message: "Device tags" }),
  createInvite: msg({ id: "product.createInvite", message: "Create auth key" }),
  inviteKey: msg({ id: "product.inviteKey", message: "Auth key" }),
  copyCommand: msg({ id: "product.copyCommand", message: "Copy command" }),
  installCommand: msg({
    id: "product.installCommand",
    message: "Connection command",
  }),
  oneTimeKey: msg({ id: "product.oneTimeKey", message: "One-time key" }),
  allAuthKeys: msg({ id: "product.allAuthKeys", message: "All keys" }),
  readyKeys: msg({ id: "product.readyKeys", message: "Ready keys" }),
  taggedKeys: msg({ id: "product.taggedKeys", message: "Tagged keys" }),
  used: msg({ id: "product.used", message: "Used" }),
  unused: msg({ id: "product.unused", message: "Ready" }),
  expireInvite: msg({ id: "product.expireInvite", message: "Expire key" }),
  deleteInvite: msg({ id: "product.deleteInvite", message: "Delete key" }),
  expireInviteTitle: msg({
    id: "product.expireInviteTitle",
    message: "Expire auth key",
  }),
  expireInviteDescription: msg({
    id: "product.expireInviteDescription",
    message: "This key will stop accepting new machines.",
  }),
  deleteInviteTitle: msg({
    id: "product.deleteInviteTitle",
    message: "Delete auth key",
  }),
  deleteInviteDescription: msg({
    id: "product.deleteInviteDescription",
    message: "This removes the auth key from Headscale.",
  }),
  confirmExpireInvite: msg({
    id: "product.confirmExpireInvite",
    message: "Expire key",
  }),
  confirmDeleteInvite: msg({
    id: "product.confirmDeleteInvite",
    message: "Delete key",
  }),
  noAuthKeys: msg({
    id: "product.noAuthKeys",
    message: "No auth keys match these filters.",
  }),
  noAuthKeysYet: msg({
    id: "product.noAuthKeysYet",
    message: "No auth keys yet. Create one to add a device.",
  }),
  routesTitle: msg({ id: "product.routesTitle", message: "Routes" }),
  routesSubtitle: msg({
    id: "product.routesSubtitle",
    message:
      "Review subnet and exit routes before making them available to users.",
  }),
  routeRefreshRequired: msg({
    id: "product.routeRefreshRequired",
    message:
      "Refresh route data successfully before confirming. Retry or cancel.",
  }),
  approvedRoutes: msg({
    id: "product.approvedRoutes",
    message: "Approved routes",
  }),
  viewMachine: msg({ id: "product.viewMachine", message: "View machine" }),
  viewUser: msg({ id: "product.viewUser", message: "View user" }),
  approveRoute: msg({ id: "product.approveRoute", message: "Approve route" }),
  approveRouteTitle: msg({
    id: "product.approveRouteTitle",
    message: "Approve route",
  }),
  approveRouteDescription: msg({
    id: "product.approveRouteDescription",
    message:
      "Only this route will be approved. Existing approved routes stay enabled.",
  }),
  approveExitNode: msg({
    id: "product.approveExitNode",
    message: "Approve exit node",
  }),
  approveExitRouteDescription: msg({
    id: "product.approveExitRouteDescription",
    message:
      "Headscale approves the IPv4 and IPv6 exit routes together. Devices can then send internet-bound traffic through this machine. Confirm that this machine should be trusted for that path.",
  }),
  revokeRoute: msg({ id: "product.revokeRoute", message: "Revoke route" }),
  revokeRouteTitle: msg({
    id: "product.revokeRouteTitle",
    message: "Revoke route approval",
  }),
  revokeExitNode: msg({
    id: "product.revokeExitNode",
    message: "Revoke exit node",
  }),
  revokeRouteDescription: msg({
    id: "product.revokeRouteDescription",
    message:
      "Devices stop using this route through this machine. Other approved routes stay enabled. If the access policy auto-approves this route, it may be approved again the next time the machine advertises it.",
  }),
  revokeExitRouteDescription: msg({
    id: "product.revokeExitRouteDescription",
    message:
      "Exit routes are revoked as a pair: the IPv4 and IPv6 routes are removed together, and devices stop sending internet-bound traffic through this machine. Other approved routes stay enabled. If the access policy auto-approves exit routes, they may be approved again the next time the machine advertises them.",
  }),
  approveAll: msg({ id: "product.approveAll", message: "Approve all" }),
  approveRoutesTitle: msg({
    id: "product.approveRoutesTitle",
    message: "Approve advertised routes",
  }),
  approveRoutesDescription: msg({
    id: "product.approveRoutesDescription",
    message: "This approves every currently advertised route for this machine.",
  }),
  approveExitRoutesTitle: msg({
    id: "product.approveExitRoutesTitle",
    message: "Approve exit routes",
  }),
  approveExitRoutesDescription: msg({
    id: "product.approveExitRoutesDescription",
    message:
      "This includes exit routes, which can carry internet-bound traffic through this machine.",
  }),
  confirmApproveRoutes: msg({
    id: "product.confirmApproveRoutes",
    message: "Approve routes",
  }),
  routesApproved: msg({ id: "product.routesApproved", message: "Approved" }),
  noRoutes: msg({
    id: "product.noRoutes",
    message: "No advertised routes are waiting for review.",
  }),
  noRouteValues: msg({ id: "product.noRouteValues", message: "None" }),
  source: msg({ id: "product.source", message: "From" }),
  destination: msg({ id: "product.destination", message: "To" }),
  ports: msg({ id: "product.ports", message: "Service" }),
  groups: msg({ id: "product.groups", message: "Groups" }),
  groupName: msg({ id: "product.groupName", message: "Group name" }),
  tagOwners: msg({
    id: "product.tagOwners",
    message: "Client tag authorization",
  }),
  tagName: msg({ id: "product.tagName", message: "Tag" }),
  removeItem: msg({ id: "product.removeItem", message: "Remove" }),
  confirmRemovePolicyItemTitle: msg({
    id: "product.confirmRemovePolicyItemTitle",
    message: "Remove this?",
  }),
  confirmRemovePolicyItemDescription: msg({
    id: "product.confirmRemovePolicyItemDescription",
    message: "This removes it from your access setup.",
  }),
  policy: msg({ id: "product.policy", message: "Policy" }),
  savePolicy: msg({ id: "product.savePolicy", message: "Save" }),
  noPolicyGroupMembers: msg({
    id: "product.noPolicyGroupMembers",
    message: "No members yet.",
  }),
  noPolicyTagOwnerEntries: msg({
    id: "product.noPolicyTagOwnerEntries",
    message:
      "No members are authorized here to request this tag through a client.",
  }),
  addUserToGroup: msg({
    id: "product.addUserToGroup",
    message: "Add to groups",
  }),
  grantTagToUser: msg({
    id: "product.grantTagToUser",
    message: "Allow client tag requests",
  }),
  assignMembershipsTitle: msg({
    id: "product.assignMembershipsTitle",
    message: "Add user to groups",
  }),
  assignMembershipsDescription: msg({
    id: "product.assignMembershipsDescription",
    message:
      "Choose this user's groups. Applying opens a review before publishing the complete policy.",
  }),
  assignTagOwnershipsTitle: msg({
    id: "product.assignTagOwnershipsTitle",
    message: "Allow client tag requests",
  }),
  assignTagOwnershipsDescription: msg({
    id: "product.assignTagOwnershipsDescription",
    message:
      "Choose which tags this user may request through a client. Applying this publishes the complete policy; it does not change existing device tags or issued keys. Group relationships may still authorize requests.",
  }),
  noGroupsAvailable: msg({
    id: "product.noGroupsAvailable",
    message: "No groups yet. Add one in Access controls first.",
  }),
  noTagsAvailable: msg({
    id: "product.noTagsAvailable",
    message: "No tag access entries yet. Add one in Access controls first.",
  }),
  applyAssignment: msg({ id: "product.applyAssignment", message: "Apply" }),
  cancelAssignment: msg({ id: "product.cancelAssignment", message: "Cancel" }),
  removeFromReference: msg({
    id: "product.removeFromReference",
    message: "Remove from reference",
  }),
  removeReferenceDescription: msg({
    id: "product.removeReferenceDescription",
    message:
      "This removes the user from this policy entry and saves the policy on the server now.",
  }),
  userImpactOnDeleteHeading: msg({
    id: "product.userImpactOnDeleteHeading",
    message: "This user appears in the following Policy entries:",
  }),
  userPolicyReferencesUnknown: msg({
    id: "product.userPolicyReferencesUnknown",
    message:
      "Policy references could not be verified. You can delete the user without policy cleanup; check references through a trusted management channel.",
  }),
  cleanupReferencesOption: msg({
    id: "product.cleanupReferencesOption",
    message: "Also remove this user from those Policy references",
  }),
  deleteMemberCleanupPending: msg({
    id: "product.deleteMemberCleanupPending",
    message:
      "The user was deleted, but the policy still references them. Try again, or remove those references in Access controls.",
  }),
  policyUnsavedBlocked: msg({
    id: "product.policyUnsavedBlocked",
    message:
      "You have unpublished policy changes on the Access page. Publish or discard them there before changing the policy from here.",
  }),
  renameUpdateReferencesOption: msg({
    id: "product.renameUpdateReferencesOption",
    message: "Also update those Policy references to the new name",
  }),
  renameMemberPrincipalConflict: msg({
    id: "product.renameMemberPrincipalConflict",
    message:
      "This name does not uniquely identify this user. Review the user directory before updating policy references.",
  }),
  renameMemberPolicyPending: msg({
    id: "product.renameMemberPolicyPending",
    message:
      "The user was renamed, but the policy still uses the old name. Try again, or update those references in Access controls.",
  }),
  copied: msg({ id: "product.copied", message: "Copied" }),
  copy: msg({ id: "product.copy", message: "Copy" }),
  openServerSettings: msg({
    id: "product.openServerSettings",
    message: "Server settings",
  }),
  serverSettingsTitle: msg({
    id: "product.serverSettingsTitle",
    message: "Server settings",
  }),
  serverSettingsDescription: msg({
    id: "product.serverSettingsDescription",
    message: "Manage server-scoped credentials and maintenance actions.",
  }),
  apiKeysTitle: msg({ id: "product.apiKeysTitle", message: "API keys" }),
  apiKeysDescription: msg({
    id: "product.apiKeysDescription",
    message:
      "API keys can control this Headscale server. The full key is only shown once.",
  }),
  apiKeyPrefix: msg({ id: "product.apiKeyPrefix", message: "Prefix" }),
  createdApiKey: msg({
    id: "product.createdApiKey",
    message: "Created API key",
  }),
  apiKeyOnlyShownOnce: msg({
    id: "product.apiKeyOnlyShownOnce",
    message: "Copy it now. Headscale will not return the full key again.",
  }),
  createApiKeyTitle: msg({
    id: "product.createApiKeyTitle",
    message: "Create API key",
  }),
  apiKeyExpiration: msg({
    id: "product.apiKeyExpiration",
    message: "API key expiration",
  }),
  expireApiKeyTitle: msg({
    id: "product.expireApiKeyTitle",
    message: "Expire API key",
  }),
  deleteApiKeyTitle: msg({
    id: "product.deleteApiKeyTitle",
    message: "Delete API key",
  }),
  confirmExpireApiKey: msg({
    id: "product.confirmExpireApiKey",
    message: "Expire API key",
  }),
  confirmDeleteApiKey: msg({
    id: "product.confirmDeleteApiKey",
    message: "Delete API key",
  }),
  expireApiKeyDescription: msg({
    id: "product.expireApiKeyDescription",
    message:
      "Scripts and integrations using this key lose access to the server immediately. The key stays listed as expired and cannot be renewed.",
  }),
  deleteApiKeyDescription: msg({
    id: "product.deleteApiKeyDescription",
    message:
      "Scripts and integrations using this key lose access to the server immediately, and the key is permanently removed. This cannot be undone.",
  }),
  apiKeyCreatedAt: msg({ id: "product.apiKeyCreatedAt", message: "Created" }),
  apiKeyLastUsed: msg({ id: "product.apiKeyLastUsed", message: "Last used" }),
  notReported: msg({ id: "product.notReported", message: "Not reported" }),
  noApiKeys: msg({ id: "product.noApiKeys", message: "No API keys to show." }),
  maintenance: msg({ id: "product.maintenance", message: "Maintenance" }),
  maintenanceDescription: msg({
    id: "product.maintenanceDescription",
    message:
      "These actions are server-wide. Use them only when repairing or validating Headscale state.",
  }),
  backfillNodeIps: msg({
    id: "product.backfillNodeIps",
    message: "Backfill node IPs",
  }),
  backfillNodeIpsDescription: msg({
    id: "product.backfillNodeIpsDescription",
    message:
      "This adds or removes IP addresses on every node to match the server’s configured prefixes.",
  }),
  confirmBackfillNodeIps: msg({
    id: "product.confirmBackfillNodeIps",
    message: "Run backfill",
  }),
  backfillResult: msg({
    id: "product.backfillResult",
    message: "Backfill result",
  }),
  backfillNoChanges: msg({
    id: "product.backfillNoChanges",
    message: "No changes were needed",
  }),
  backfillAcknowledge: msg({
    id: "product.backfillAcknowledge",
    message:
      "I understand this adds or removes IP addresses on every node to match the server’s configured prefixes.",
  }),
  refreshData: msg({ id: "product.refreshData", message: "Refresh data" }),
  dataRefreshed: msg({ id: "product.dataRefreshed", message: "Data updated" }),
  never: msg({ id: "product.never", message: "Never" }),
  errorUserNotFound: msg({
    id: "product.errorUserNotFound",
    message: "User not found",
  }),
  errorUserStillOwns: msg({
    id: "product.errorUserStillOwns",
    message:
      "User still owns machines. Remove or reassign them before deleting the user.",
  }),
  errorNodeNotFound: msg({
    id: "product.errorNodeNotFound",
    message: "Node not found",
  }),
  errorRequestFailed: msg({
    id: "product.errorRequestFailed",
    message:
      "The API key was rejected and may be invalid or expired. Use the Headscale CLI to get a valid key, then update this connection profile.",
  }),
  errorRequestForbidden: msg({
    id: "product.errorRequestForbidden",
    message:
      "The server or proxy rejected the request. Check this deployment’s access restrictions.",
  }),
  errorInvalidDnsLabel: msg({
    id: "product.errorInvalidDnsLabel",
    message:
      "This name is not valid. Use up to 63 letters, digits or hyphens, starting and ending with a letter or digit.",
  }),
  errorNodeNameTaken: msg({
    id: "product.errorNodeNameTaken",
    message: "Another machine already uses this name.",
  }),
  errorTagsNotPermitted: msg({
    id: "product.errorTagsNotPermitted",
    message:
      "Headscale did not accept these tags. Administrator assignment requires a matching tagOwners definition in the loaded policy; an empty owner list is valid. Check the tag format and the server’s loaded configuration.",
  }),
  errorCannotRemoveAllTags: msg({
    id: "product.errorCannotRemoveAllTags",
    message:
      "SetTags cannot remove the last tag. To restore a personal identity, clear the client’s advertised tags and reauthenticate as a user without an auth key.",
  }),
  errorUserNameTaken: msg({
    id: "product.errorUserNameTaken",
    message: "A user with this name already exists.",
  }),
  resourceAccessTitle: msg({
    id: "product.resourceAccessTitle",
    message: "Resource access",
  }),
  resourceAccessSubtitle: msg({
    id: "product.resourceAccessSubtitle",
    message:
      "Decide which people and teams can reach which devices. Group devices with labels and people into teams.",
  }),
  teamsSection: msg({ id: "product.teamsSection", message: "Teams" }),
  deviceLabelsSection: msg({
    id: "product.deviceLabelsSection",
    message: "Device labels",
  }),
  newTeam: msg({ id: "product.newTeam", message: "New team" }),
  newDeviceLabel: msg({
    id: "product.newDeviceLabel",
    message: "New device label",
  }),
  noTeamsYet: msg({ id: "product.noTeamsYet", message: "No teams yet" }),
  noTeamsHint: msg({
    id: "product.noTeamsHint",
    message: "Create a team to grant access to a group of people at once.",
  }),
  noDeviceLabelsYet: msg({
    id: "product.noDeviceLabelsYet",
    message: "No device labels yet",
  }),
  noDeviceLabelsHint: msg({
    id: "product.noDeviceLabelsHint",
    message:
      "Create a device label to manage access for groups of similar devices.",
  }),
  searchDeviceLabels: msg({
    id: "product.searchDeviceLabels",
    message: "Search device labels…",
  }),
  tagDetailDialogTitle: msg({
    id: "product.tagDetailDialogTitle",
    message: "Device label · policy",
  }),
  tagDetailDialogSubtitle: msg({
    id: "product.tagDetailDialogSubtitle",
    message:
      "Manage who may request this tag through a client and review network access separately. Changing authorization can expose existing tag-based access, but does not change tags on devices or issued keys.",
  }),
  deviceLabelName: msg({
    id: "product.deviceLabelName",
    message: "Label name",
  }),
  deviceLabelNameHint: msg({
    id: "product.deviceLabelNameHint",
    message: "Example: server, workstation, database",
  }),
  tagAccessorsSection: msg({
    id: "product.tagAccessorsSection",
    message: "Who can access these devices",
  }),
  tagOwnersSection: msg({
    id: "product.tagOwnersSection",
    message: "Who may request this tag through a client (optional)",
  }),
  addAccessor: msg({ id: "product.addAccessor", message: "Give access" }),
  addLabelManager: msg({
    id: "product.addLabelManager",
    message: "Add client authorization",
  }),
  removeAccessor: msg({
    id: "product.removeAccessor",
    message: "Remove access",
  }),
  removeLabelManager: msg({
    id: "product.removeLabelManager",
    message: "Remove direct client authorization",
  }),
  teamDetailDialogTitle: msg({
    id: "product.teamDetailDialogTitle",
    message: "Manage team",
  }),
  teamName: msg({ id: "product.teamName", message: "Team name" }),
  teamNameHint: msg({
    id: "product.teamNameHint",
    message: "Example: ops, dev, security",
  }),
  teamMembersSection: msg({
    id: "product.teamMembersSection",
    message: "Members",
  }),
  addMemberToTeam: msg({
    id: "product.addMemberToTeam",
    message: "Add member",
  }),
  removeTeamMember: msg({
    id: "product.removeTeamMember",
    message: "Remove member",
  }),
  teamAccessView: msg({
    id: "product.teamAccessView",
    message: "Device labels this team can access",
  }),
  teamAccessViewHint: msg({
    id: "product.teamAccessViewHint",
    message: "To change access, close this and open the device label.",
  }),
  noTeamAccess: msg({
    id: "product.noTeamAccess",
    message: "No ACL rules from this team to device labels are listed here.",
  }),
  removeTeam: msg({ id: "product.removeTeam", message: "Delete team" }),
  removeDeviceLabel: msg({
    id: "product.removeDeviceLabel",
    message: "Delete device label",
  }),
  svcSshLabel: msg({ id: "product.svcSshLabel", message: "SSH" }),
  svcSshHint: msg({
    id: "product.svcSshHint",
    message:
      "Network port 22 only. Configure Tailscale SSH login users and ssh accept/check session rules separately in the Headscale policy.",
  }),
  serviceSelectionHint: msg({
    id: "product.serviceSelectionHint",
    message:
      "To switch to custom ports, enter and confirm them before clearing the last preset. Clearing the last service removes this access row; use Give access to add it again.",
  }),
  svcWebLabel: msg({ id: "product.svcWebLabel", message: "Web" }),
  svcWebHint: msg({ id: "product.svcWebHint", message: "Ports 80 and 443" }),
  svcRdpLabel: msg({ id: "product.svcRdpLabel", message: "Remote desktop" }),
  svcRdpHint: msg({ id: "product.svcRdpHint", message: "Port 3389" }),
  svcDnsLabel: msg({ id: "product.svcDnsLabel", message: "DNS" }),
  svcDnsHint: msg({ id: "product.svcDnsHint", message: "Port 53" }),
  svcAllLabel: msg({ id: "product.svcAllLabel", message: "All services" }),
  svcCustomLabel: msg({
    id: "product.svcCustomLabel",
    message: "Custom ports",
  }),
  svcCustomPlaceholder: msg({
    id: "product.svcCustomPlaceholder",
    message: "e.g. 8080, 9000-9100",
  }),
  labelManagersLabel: msg({
    id: "product.labelManagersLabel",
    message: "Client authorization",
  }),
  grantsPreservedHint: msg({
    id: "product.grantsPreservedHint",
    message:
      "Only ACL rules are shown and edited here. Existing grants are preserved and may allow additional access. Before renaming or deleting a team or label, update its grants references in the Headscale policy.",
  }),
  policyReadOnlyError: msg({
    id: "product.policyReadOnlyError",
    message:
      "This policy could not be read safely. Policy changes are disabled. Correct it in Headscale and refresh.",
  }),
  policyFileModeNoPath: msg({
    id: "product.policyFileModeNoPath",
    message:
      "Headscale is set to read its access policy from a file (policy.mode: file), but no policy file is configured (policy.path is empty), so there is nothing to edit here. Set policy.mode to database in the Headscale configuration to manage access rules in this app.",
  }),
  policyUpdateDisabled: msg({
    id: "product.policyUpdateDisabled",
    message:
      "Headscale reads its access policy from a file (policy.mode: file), so changes cannot be saved from here. Edit the policy file on the Headscale server, or set policy.mode to database to manage access rules in this app.",
  }),
  authRequestKind: msg({
    id: "product.authRequestKind",
    message: "Request type",
  }),
  authRequestKindDevice: msg({
    id: "product.authRequestKindDevice",
    message: "Device sign-in",
  }),
  authRequestKindSsh: msg({
    id: "product.authRequestKindSsh",
    message: "SSH check",
  }),
  authRequestLabel: msg({
    id: "product.authRequestLabel",
    message: "Request link or ID",
  }),
  authRequestHelp: msg({
    id: "product.authRequestHelp",
    message:
      "Paste the link or ID shown by tailscale up or by an SSH check prompt. Request IDs are short-lived.",
  }),
  authRequestInvalid: msg({
    id: "product.authRequestInvalid",
    message:
      "Enter a request ID starting with hskey-authreq- or paste the full link.",
  }),
  authRequestIsSshCheck: msg({
    id: "product.authRequestIsSshCheck",
    message:
      "This is an SSH check link. Switch the request type to SSH check; it cannot register a device.",
  }),
  authRequestIsRegistration: msg({
    id: "product.authRequestIsRegistration",
    message:
      "This is a device sign-in link. Switch the request type to Device sign-in; SSH check actions do not register a device.",
  }),
  sshCheckDescription: msg({
    id: "product.sshCheckDescription",
    message:
      "Approve or reject a waiting SSH check; this does not register a device. This API cannot provide a trusted source, target or login-user summary. Before approving, verify this exact request and those identities with the requester through a trusted channel.",
  }),
  approveSshCheck: msg({
    id: "product.approveSshCheck",
    message: "Approve SSH check",
  }),
  rejectSshCheck: msg({
    id: "product.rejectSshCheck",
    message: "Reject SSH check",
  }),
  sshCheckApproved: msg({
    id: "product.sshCheckApproved",
    message: "SSH check approved.",
  }),
  sshCheckRejected: msg({
    id: "product.sshCheckRejected",
    message: "SSH check rejected.",
  }),
  checkPolicy: msg({ id: "product.checkPolicy", message: "Check policy" }),
  policyCheckPassed: msg({
    id: "product.policyCheckPassed",
    message: "Headscale found no problems in this policy. Nothing was saved.",
  }),
  policyAdvancedRuleHint: msg({
    id: "product.policyAdvancedRuleHint",
    message:
      "This rule has additional restrictions. Edit its services in the Headscale policy.",
  }),
  noAccessors: msg({
    id: "product.noAccessors",
    message: "No ACL access rules are listed here.",
  }),
  noLabelManagers: msg({
    id: "product.noLabelManagers",
    message: "No managers yet",
  }),
  ipRulesSectionTitle: msg({
    id: "product.ipRulesSectionTitle",
    message: "IP and all-destination rules (advanced)",
  }),
  ipRulesSectionHint: msg({
    id: "product.ipRulesSectionHint",
    message:
      "These rules grant access to IP addresses, network ranges, or all destinations (*). You can add, edit or delete them here.",
  }),
  addIpRule: msg({ id: "product.addIpRule", message: "Add rule" }),
  noIpRules: msg({
    id: "product.noIpRules",
    message: "No IP or all-destination rules yet.",
  }),
  ipRuleDestinationHasPort: msg({
    id: "product.ipRuleDestinationHasPort",
    message:
      "Enter the destination without a port. Put ports in the ports field.",
  }),
  removeIpRuleConsequence: msg({
    id: "product.removeIpRuleConsequence",
    message:
      "After you save, connections that only this rule allows are blocked.",
  }),
  denyAllBannerTitle: msg({
    id: "product.denyAllBannerTitle",
    message: "No rule allows any access",
  }),
  denyAllBannerBody: msg({
    id: "product.denyAllBannerBody",
    message:
      "With this policy, devices cannot reach each other. Add a rule or start from a template to allow access.",
  }),
  discardPolicyChanges: msg({
    id: "product.discardPolicyChanges",
    message: "Discard changes",
  }),
  discardPolicyChangesTitle: msg({
    id: "product.discardPolicyChangesTitle",
    message: "Discard all unsaved changes?",
  }),
  discardPolicyChangesBody: msg({
    id: "product.discardPolicyChangesBody",
    message:
      "Every unsaved change on this page is reverted to the policy last loaded from Headscale. This cannot be undone.",
  }),
  templateReplaceTitle: msg({
    id: "product.templateReplaceTitle",
    message: "Replace open access with this template?",
  }),
  templateReplaceBody: msg({
    id: "product.templateReplaceBody",
    message:
      "This template removes the rules below, which let every device reach every other device. After you save, only the template’s rules allow access: untagged devices, and devices whose tags the template does not cover, lose access unless another rule covers them.",
  }),
  templateReplaceConfirm: msg({
    id: "product.templateReplaceConfirm",
    message: "Replace rules",
  }),
  emptyTeamWarning: msg({
    id: "product.emptyTeamWarning",
    message:
      "No members yet. This team gives access to no one until you add people.",
  }),
  deviceOnlyLabelBadge: msg({
    id: "product.deviceOnlyLabelBadge",
    message: "From devices",
  }),
  deviceOnlyLabelHint: msg({
    id: "product.deviceOnlyLabelHint",
    message:
      "This label comes from devices and is not defined in the policy, so it cannot be renamed or deleted here. Give access or add a label manager to define it.",
  }),
  noDeviceLabelsMatch: msg({
    id: "product.noDeviceLabelsMatch",
    message: "No device labels match your search.",
  }),
  clearSearch: msg({ id: "product.clearSearch", message: "Clear search" }),
  editIpRule: msg({ id: "product.editIpRule", message: "Edit rule" }),
  saveIpRule: msg({
    id: "product.saveIpRule",
    message: "Keep rule in policy draft",
  }),
  cancelIpRuleEdit: msg({
    id: "product.cancelIpRuleEdit",
    message: "Cancel edit",
  }),
  ipRuleSourcePlaceholder: msg({
    id: "product.ipRuleSourcePlaceholder",
    message: "source",
  }),
  ipRuleDestinationPlaceholder: msg({
    id: "product.ipRuleDestinationPlaceholder",
    message: "destination",
  }),
  ipRulePortsPlaceholder: msg({
    id: "product.ipRulePortsPlaceholder",
    message: "ports",
  }),
  ipRuleFieldsRequired: msg({
    id: "product.ipRuleFieldsRequired",
    message: "Source, destination and ports are all required.",
  }),
  openAccessBannerTitle: msg({
    id: "product.openAccessBannerTitle",
    message: "High risk: open access detected",
  }),
  policyIdentityUnverified: msg({
    id: "product.policyIdentityUnverified",
    message:
      "The user directory could not be verified. Successfully refresh it before cleaning up user references.",
  }),
  policyRuleRestrictions: msg({
    id: "product.policyRuleRestrictions",
    message: "Rule restrictions",
  }),
  policyAllPorts: msg({ id: "product.policyAllPorts", message: "All ports" }),
  policyNormalizationNotice: msg({
    id: "product.policyNormalizationNotice",
    message:
      "Publishing rewrites the whole policy as normalized JSON. HuJSON comments and formatting are not retained. Row confirmation only updates the policy draft; Publish all policy changes submits the complete document to Headscale.",
  }),
  discardIpDraftBody: msg({
    id: "product.discardIpDraftBody",
    message:
      "Discard the unconfirmed text in this rule? Cancel keeps editing. Confirmed policy changes remain in the page draft and are not saved by this action.",
  }),
  orphanRefBannerTitle: msg({
    id: "product.orphanRefBannerTitle",
    message: "Some policy references are stale",
  }),
  orphanReferenceBadge: msg({
    id: "product.orphanReferenceBadge",
    message: "Stale reference",
  }),
  orphanReferenceTooltip: msg({
    id: "product.orphanReferenceTooltip",
    message:
      "We couldn''t find a matching account, team, or device label. It may be a typo, a format mismatch, or a deleted object. Open the details and use the remove action for the entry.",
  }),
  cleanupOrphanRefsConfirm: msg({
    id: "product.cleanupOrphanRefsConfirm",
    message: "Remove all stale references?",
  }),
  cleanupOrphanRefsConfirmBody: msg({
    id: "product.cleanupOrphanRefsConfirmBody",
    message:
      "This removes every reference flagged as stale. You''ll still need to click Save at the top to push the cleanup.",
  }),
  dialogChangesKeptHint: msg({
    id: "product.dialogChangesKeptHint",
    message:
      "Keep in policy draft retains these edits without publishing. After closing, choose Publish all policy changes at the top of the page to review and publish the complete document.",
  }),
  unsavedChangesBadge: msg({
    id: "product.unsavedChangesBadge",
    message: "Unsaved",
  }),
  unsavedChangesTitle: msg({
    id: "product.unsavedChangesTitle",
    message: "Unsaved changes",
  }),
  dialogUnsavedChangesBody: msg({
    id: "product.dialogUnsavedChangesBody",
    message:
      "Discard reverts only the changes made in this dialog. Publish and close reviews and publishes the complete policy to Headscale. To retain unpublished edits, cancel and choose Keep in policy draft.",
  }),
  unsavedChangesSaveAndClose: msg({
    id: "product.unsavedChangesSaveAndClose",
    message: "Publish and close",
  }),
  discardDialogChanges: msg({
    id: "product.discardDialogChanges",
    message: "Discard these changes",
  }),
  confirm: msg({ id: "product.confirm", message: "Confirm" }),
  assignedBadgeLabel: msg({
    id: "product.assignedBadgeLabel",
    message: "Assigned",
  }),
  highRiskConfirmTitle: msg({
    id: "product.highRiskConfirmTitle",
    message: "Grant very broad access?",
  }),
  highRiskConfirmDescription: msg({
    id: "product.highRiskConfirmDescription",
    message:
      "Allow the source below to reach devices with this label on the listed ports? No protocol restriction is added.",
  }),
  selectAccessorSearchPlaceholder: msg({
    id: "product.selectAccessorSearchPlaceholder",
    message: "Find a person, team, or label…",
  }),
  selectAccessorEmpty: msg({
    id: "product.selectAccessorEmpty",
    message: "No matches",
  }),
  selectMemberSearchPlaceholder: msg({
    id: "product.selectMemberSearchPlaceholder",
    message: "Search users…",
  }),
  selectMemberEmpty: msg({
    id: "product.selectMemberEmpty",
    message: "No matching users",
  }),
  selectLabelManagerSearchPlaceholder: msg({
    id: "product.selectLabelManagerSearchPlaceholder",
    message: "Search users, teams…",
  }),
  selectLabelManagerEmpty: msg({
    id: "product.selectLabelManagerEmpty",
    message: "No matches",
  }),
  optionGroupUsers: msg({ id: "product.optionGroupUsers", message: "Users" }),
  optionGroupTeams: msg({ id: "product.optionGroupTeams", message: "Teams" }),
  optionGroupLabels: msg({
    id: "product.optionGroupLabels",
    message: "Device labels",
  }),
  optionGroupSpecial: msg({
    id: "product.optionGroupSpecial",
    message: "Special",
  }),
  allUsersChoice: msg({ id: "product.allUsersChoice", message: "Anyone" }),
  removeRule: msg({ id: "product.removeRule", message: "Remove" }),
  resourceAccessEmptyTitle: msg({
    id: "product.resourceAccessEmptyTitle",
    message: "Decide who reaches what",
  }),
  resourceAccessEmptyHint: msg({
    id: "product.resourceAccessEmptyHint",
    message: "Pick a starting point below. You can change it any time.",
  }),
  templatesSectionTitle: msg({
    id: "product.templatesSectionTitle",
    message: "Start from a template",
  }),
  templateSelfOnlyTitle: msg({
    id: "product.templateSelfOnlyTitle",
    message: "Open personal device access",
  }),
  templateSelfOnlyDescription: msg({
    id: "product.templateSelfOnlyDescription",
    message: "Anyone can reach my personal devices on any service.",
  }),
  templateSmallTeamTitle: msg({
    id: "product.templateSmallTeamTitle",
    message: "Small team",
  }),
  templateSmallTeamDescription: msg({
    id: "product.templateSmallTeamDescription",
    message:
      "Create a team and let them share a pool of devices over SSH and web.",
  }),
  templateSplitEnvTitle: msg({
    id: "product.templateSplitEnvTitle",
    message: "Dev + production",
  }),
  templateSplitEnvDescription: msg({
    id: "product.templateSplitEnvDescription",
    message:
      "Separate dev and ops teams with access to their own labelled servers.",
  }),
  applyTemplate: msg({
    id: "product.applyTemplate",
    message: "Use this template",
  }),
  currentApiKeyBadge: msg({
    id: "product.currentApiKeyBadge",
    message: "Used by this session",
  }),
  currentApiKeyWarning: msg({
    id: "product.currentApiKeyWarning",
    message:
      "This key authenticates your current session. Once it is expired or deleted, this session loses access to the server and you must create a new API key with the Headscale CLI.",
  }),
  currentApiKeyAcknowledge: msg({
    id: "product.currentApiKeyAcknowledge",
    message: "I understand this session will lose access.",
  }),
  disableExpiry: msg({
    id: "product.disableExpiry",
    message: "Disable expiry",
  }),
  disableExpiryTitle: msg({
    id: "product.disableExpiryTitle",
    message: "Disable machine expiry?",
  }),
  disableExpiryDescription: msg({
    id: "product.disableExpiryDescription",
    message:
      "This machine will no longer expire and will keep access without signing in again until you expire it.",
  }),
  inviteNoOwner: msg({
    id: "product.inviteNoOwner",
    message: "No owner (tags only)",
  }),
  inviteTagsRequired: msg({
    id: "product.inviteTagsRequired",
    message: "A key without an owner needs at least one ACL tag.",
  }),
  inviteTagsHint: msg({
    id: "product.inviteTagsHint",
    message:
      "Separate lowercase tags with commas or spaces, for example tag:server tag:db.",
  }),
  inviteTagsPrefix: msg({
    id: "product.inviteTagsPrefix",
    message:
      "Use lowercase tags starting with tag:, for example tag:server. Separate tags with commas or spaces.",
  }),
  authKeyCreated: msg({
    id: "product.authKeyCreated",
    message: "Auth key created",
  }),
  taggedKeyCreatorHint: msg({
    id: "product.taggedKeyCreatorHint",
    message:
      "For a tagged key, the selected user is its creator, not the owner of joining devices; tags manage those devices.",
  }),
  keyOneTimeNotice: msg({
    id: "product.keyOneTimeNotice",
    message:
      "Save this full key securely now. It cannot be retrieved again after it is discarded or this session is locked.",
  }),
  connectionCommandHint: msg({
    id: "product.connectionCommandHint",
    message:
      "Install Tailscale first, then run this connection command in a POSIX shell on the target computer.",
  }),
  mobileSetupHint: msg({
    id: "product.mobileSetupHint",
    message:
      "This is not a mobile command. On Android or iOS, install the Tailscale app and choose a custom login server. Follow the platform guide; if registration awaits approval, use Register pending device with the link it shows.",
  }),
  createdKeyUnavailable: msg({
    id: "product.createdKeyUnavailable",
    message:
      "The last successful refresh confirms this key is no longer usable: it was removed, expired, or used as a one-time key. Create another key to connect a device.",
  }),
  createdKeyUnverified: msg({
    id: "product.createdKeyUnverified",
    message:
      "This key's current status is not verified. Refresh the auth key list successfully to check it; the saved copy is kept.",
  }),
};
export const pluralDescriptors = {
  teamMembers: msg({
    id: "plural.teamMembers",
    message:
      "{count, plural, one {{formattedCount} member} other {{formattedCount} members}}",
  }),
  devicesTagged: msg({
    id: "plural.devicesTagged",
    message:
      "{count, plural, one {{formattedCount} device} other {{formattedCount} devices}}",
  }),
  openAccessWarnings: msg({
    id: "plural.openAccessWarnings",
    message:
      "{count, plural, one {{formattedCount} rule has a broad source or destination. Review its exact scope:} other {{formattedCount} rules have a broad source or destination. Review their exact scope:}}",
  }),
  orphanReferences: msg({
    id: "plural.orphanReferences",
    message:
      "{count, plural, one {{formattedCount} reference no longer matches an existing account, team, or device label.} other {{formattedCount} references no longer match existing accounts, teams, or device labels.}}",
  }),
  moreItems: msg({
    id: "plural.moreItems",
    message:
      "{count, plural, one {+{formattedCount} more} other {+{formattedCount} more}}",
  }),
  labelRemovalDevices: msg({
    id: "plural.labelRemovalDevices",
    message:
      "{count, plural, one {{formattedCount} device carries this label. It keeps the tag: deleting the label here does not remove tags from devices.} other {{formattedCount} devices carry this label. They keep the tag: deleting the label here does not remove tags from devices.}}",
  }),
  cleanupOrphans: msg({
    id: "plural.cleanupOrphans",
    message:
      "{count, plural, one {Clean up {formattedCount} stale reference} other {Clean up {formattedCount} stale references}}",
  }),
};
