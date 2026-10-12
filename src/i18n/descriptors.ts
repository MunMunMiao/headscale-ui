import { msg } from "@lingui/core/macro";

// Explicit descriptors keep messages reached through dynamic business keys extractable.
export const commonDescriptors = {
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
      "This deletes every saved server profile from this browser and locks the shared session. You will need to add your servers and API keys again.",
  }),
  forgotServerPasswordHint: msg({
    id: "common.forgotServerPasswordHint",
    message:
      "If you forget this server’s password, delete its saved profile and add it again with its API key. Other saved servers can be kept.",
  }),
  serverPassword: msg({ id: "common.serverPassword", message: "Server password" }),
  currentServerPassword: msg({
    id: "common.currentServerPassword",
    message: "Current server password",
  }),
  newServerPassword: msg({ id: "common.newServerPassword", message: "New server password" }),
  serverPasswordHint: msg({
    id: "common.serverPasswordHint",
    message: "This password encrypts only this server’s API key. It cannot be recovered.",
  }),
  serverCredentialEditHint: msg({
    id: "common.serverCredentialEditHint",
    message:
      "Leave the API key and password empty to change only the name or where this profile is saved. Changing the URL or API key requires both the API key and current server password.",
  }),
  sessionSharedNote: msg({
    id: "common.sessionSharedNote",
    message:
      "Tabs in this browser share the unlocked server. The session locks after 30 minutes without activity.",
  }),
  profileUnlockTitle: msg({ id: "common.profileUnlockTitle", message: "Unlock {name}" }),
  profileMigrationTitle: msg({ id: "common.profileMigrationTitle", message: "Migrate {name}" }),
  profileMigrationHint: msg({
    id: "common.profileMigrationHint",
    message:
      "Set a password for this server to migrate this saved connection. Its existing data stays unchanged if migration fails.",
  }),
  legacyPasswordLabel: msg({
    id: "common.legacyPasswordLabel",
    message: "Previous shared password",
  }),
  migrationRequired: msg({ id: "common.migrationRequired", message: "Migration required" }),
  migrateAndUnlock: msg({ id: "common.migrateAndUnlock", message: "Migrate and unlock" }),
  saveAndUnlock: msg({ id: "common.saveAndUnlock", message: "Save and unlock" }),
  passwordsMismatch: msg({
    id: "common.passwordsMismatch",
    message: "The passwords do not match.",
  }),
  profilePasswordChanged: msg({
    id: "common.profilePasswordChanged",
    message: "The server password was changed. Unlock it again when needed.",
  }),
  securityProfileHint: msg({
    id: "common.securityProfileHint",
    message: "Change the password for {name}. Other saved servers keep their own passwords.",
  }),
  sessionLocked: msg({ id: "common.sessionLocked", message: "Unlock this server to continue." }),
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
    message: "Another unlock or server change is in progress. Try again when it finishes.",
  }),
  sessionUnavailable: msg({
    id: "common.sessionUnavailable",
    message: "The shared session is unavailable. Reconnect and unlock the server to continue.",
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
    message: "The server profile was saved but is still locked. Enter its password to unlock it.",
  }),
  sessionSecretRequired: msg({
    id: "common.sessionSecretRequired",
    message: "Enter the API key and this server’s password again before submitting.",
  }),
  serverPasswordRequired: msg({
    id: "common.serverPasswordRequired",
    message: "Enter the server password.",
  }),
  preferencesReloadFailed: msg({
    id: "common.preferencesReloadFailed",
    message: "The browser could not reload your preferences. Reload this page and try again.",
  }),
  languageLoading: msg({ id: "common.languageLoading", message: "Changing language…" }),
  languageLoadFailed: msg({
    id: "common.languageLoadFailed",
    message: "The language could not be loaded. Please try again.",
  }),
  languageNotSaved: msg({
    id: "common.languageNotSaved",
    message: "The language changed, but the preference could not be saved. Please try again.",
  }),
  themeNotSaved: msg({
    id: "common.themeNotSaved",
    message: "The theme changed, but the preference could not be saved. Please try again.",
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
    message: "Some saved connection data cannot be read. Existing data was preserved.",
  }),
  storageWrite: msg({
    id: "common.storageWrite",
    message: "The browser could not save this change. Your previous data was preserved.",
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
    message: "Bearer token created by headscale apikeys create",
  }),
  connectionInvalidUrl: msg({
    id: "common.connectionInvalidUrl",
    message: "Enter an absolute HTTP(S) server URL.",
  }),
  connectionApiKeyRequired: msg({
    id: "common.connectionApiKeyRequired",
    message: "Enter an API key.",
  }),
  connectSubtitle: msg({
    id: "common.connectSubtitle",
    message: "Enter the server address and authorization token before opening the control surface.",
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
  addServerProfile: msg({ id: "common.addServerProfile", message: "Add server" }),
  updatedProfile: msg({ id: "common.updatedProfile", message: "Updated" }),
  saveProfile: msg({ id: "common.saveProfile", message: "Save profile" }),
  addingProfile: msg({ id: "common.addingProfile", message: "Adding" }),
  checkingCredentials: msg({ id: "common.checkingCredentials", message: "Checking credentials" }),
  close: msg({ id: "common.close", message: "Close" }),
  discardProfileChangesTitle: msg({
    id: "common.discardProfileChangesTitle",
    message: "Close without adding this server?",
  }),
  discardProfileChangesDescription: msg({
    id: "common.discardProfileChangesDescription",
    message: "The profile details have changed. Closing now will discard the unsaved edits.",
  }),
  keepEditingProfile: msg({ id: "common.keepEditingProfile", message: "Keep editing" }),
  discardProfileChanges: msg({ id: "common.discardProfileChanges", message: "Discard changes" }),
  connectionValidationFailedTitle: msg({
    id: "common.connectionValidationFailedTitle",
    message: "Add this server anyway?",
  }),
  connectionValidationFailedDescription: msg({
    id: "common.connectionValidationFailedDescription",
    message:
      "The UI could not verify the server URL or API key. You can keep editing the details, or add the profile and fix it later. You can edit this profile from the list at any time.",
  }),
  backToEditConnection: msg({ id: "common.backToEditConnection", message: "Review details" }),
  saveAnywayButton: msg({ id: "common.saveAnywayButton", message: "Continue adding" }),
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
  apiKeyGuideTitle: msg({ id: "common.apiKeyGuideTitle", message: "How to get an API key" }),
  apiKeyGuideDescription: msg({
    id: "common.apiKeyGuideDescription",
    message: "Headscale API keys are created from the server CLI before the UI can connect.",
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
    message: "If a key is lost or expired, expire it and create a new one on the server.",
  }),
  headscaleDocs: msg({ id: "common.headscaleDocs", message: "Headscale docs" }),
  rememberConnection: msg({
    id: "common.rememberConnection",
    message: "Remember this connection in this browser",
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
  encryptionSectionTitle: msg({ id: "common.encryptionSectionTitle", message: "Encryption" }),
  encryptionConfirmPassphrase: msg({
    id: "common.encryptionConfirmPassphrase",
    message: "Confirm passphrase",
  }),
  encryptionChangePassphrase: msg({
    id: "common.encryptionChangePassphrase",
    message: "Change passphrase",
  }),
  encryptionUnlockSubmit: msg({ id: "common.encryptionUnlockSubmit", message: "Unlock" }),
  encryptionUnlockFailed: msg({
    id: "common.encryptionUnlockFailed",
    message: "Incorrect passphrase.",
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
    message: "All saved profiles have been cleared. Add a server to start fresh.",
  }),
  encryptionSessionOnlyBadge: msg({
    id: "common.encryptionSessionOnlyBadge",
    message: "Session only",
  }),
  encryptionEncryptedBadge: msg({ id: "common.encryptionEncryptedBadge", message: "Encrypted" }),
  encryptionLockedBadge: msg({ id: "common.encryptionLockedBadge", message: "Locked" }),
  encryptionCorruptedBadge: msg({ id: "common.encryptionCorruptedBadge", message: "Corrupted" }),
  appErrorTitle: msg({ id: "common.appErrorTitle", message: "Headscale UI ran into a problem" }),
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
  serverVersionUnreadable: msg({
    id: "common.serverVersionUnreadable",
    message:
      "This server reports Headscale {version}, which this app does not support, and its response could not be read. Use a Headscale 0.29.x server.",
  }),
  primaryNavigation: msg({ id: "common.primaryNavigation", message: "Main navigation" }),
};
export type MessageKey = keyof typeof commonDescriptors;
export const productDescriptors = {
  nav: {
    home: msg({ id: "product.nav.home", message: "Overview" }),
    devices: msg({ id: "product.nav.devices", message: "Machines" }),
    members: msg({ id: "product.nav.members", message: "Users" }),
    invites: msg({ id: "product.nav.invites", message: "Auth keys" }),
    routes: msg({ id: "product.nav.routes", message: "Routes" }),
    access: msg({ id: "product.nav.access", message: "Access controls" }),
  },
  dashboardTitle: msg({ id: "product.dashboardTitle", message: "Tailnet overview" }),
  dashboardSubtitle: msg({
    id: "product.dashboardSubtitle",
    message: "A home base for devices, people and private routes.",
  }),
  onlineDevices: msg({ id: "product.onlineDevices", message: "Online devices" }),
  totalDevices: msg({ id: "product.totalDevices", message: "Total devices" }),
  openInvites: msg({ id: "product.openInvites", message: "Open invites" }),
  advertisedRoutes: msg({ id: "product.advertisedRoutes", message: "Advertised routes" }),
  recentDevices: msg({ id: "product.recentDevices", message: "Recent machines" }),
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
  noDevices: msg({ id: "product.noDevices", message: "No machines match these filters." }),
  addFirstDevice: msg({ id: "product.addFirstDevice", message: "Add your first device" }),
  addFirstDeviceDescription: msg({
    id: "product.addFirstDeviceDescription",
    message: "Install Tailscale on another device and connect it to this Headscale server.",
  }),
  addDevice: msg({ id: "product.addDevice", message: "Add device" }),
  addLinuxServerTitle: msg({ id: "product.addLinuxServerTitle", message: "Add Linux server" }),
  addClientDeviceTitle: msg({ id: "product.addClientDeviceTitle", message: "Add client device" }),
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
    message: "Create the key and copy the install command.",
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
    message: "Select preferences for your device to generate an install command.",
  }),
  pendingRegistrationDescription: msg({
    id: "product.pendingRegistrationDescription",
    message: "Use the registration key shown by a device waiting for approval.",
  }),
  registerPendingNode: msg({ id: "product.registerPendingNode", message: "Register pending node" }),
  registeredNode: msg({ id: "product.registeredNode", message: "Registered machine" }),
  setupDevice: msg({ id: "product.setupDevice", message: "Set up device" }),
  setupAuthKey: msg({ id: "product.setupAuthKey", message: "Set up authentication key" }),
  generateInstallScript: msg({
    id: "product.generateInstallScript",
    message: "Generate install script",
  }),
  generate: msg({ id: "product.generate", message: "Generate" }),
  manageTags: msg({ id: "product.manageTags", message: "Manage tags in Access controls" }),
  useTagsDescription: msg({
    id: "product.useTagsDescription",
    message:
      "Authenticate and control access to the device using tags. Tagged servers do not need frequent key expiry.",
  }),
  ephemeralDescription: msg({
    id: "product.ephemeralDescription",
    message: "Automatically remove the device from your tailnet when it goes offline.",
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
    message: "Keep auth keys short-lived unless you are automating repeat installs.",
  }),
  days: msg({ id: "product.days", message: "days" }),
  mustBeBetweenDays: msg({
    id: "product.mustBeBetweenDays",
    message: "Must be between 1 and 90 days.",
  }),
  devicesTableMachine: msg({ id: "product.devicesTableMachine", message: "Machine" }),
  devicesTableUser: msg({ id: "product.devicesTableUser", message: "User" }),
  devicesTableRoutes: msg({ id: "product.devicesTableRoutes", message: "Routes" }),
  devicesTableActivity: msg({ id: "product.devicesTableActivity", message: "Activity" }),
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
  allMachines: msg({ id: "product.allMachines", message: "All machines" }),
  onlineOnly: msg({ id: "product.onlineOnly", message: "Online" }),
  offlineOnly: msg({ id: "product.offlineOnly", message: "Offline" }),
  expiredOnly: msg({ id: "product.expiredOnly", message: "Expired" }),
  routeAdvertisers: msg({ id: "product.routeAdvertisers", message: "Advertises routes" }),
  taggedOnly: msg({ id: "product.taggedOnly", message: "Tagged" }),
  owner: msg({ id: "product.owner", message: "Owner" }),
  addresses: msg({ id: "product.addresses", message: "Addresses" }),
  tags: msg({ id: "product.tags", message: "Tags" }),
  editTags: msg({ id: "product.editTags", message: "Edit tags" }),
  editNodeTagsTitle: msg({ id: "product.editNodeTagsTitle", message: "Edit machine tags" }),
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
  machineDetails: msg({ id: "product.machineDetails", message: "Machine details" }),
  userDetails: msg({ id: "product.userDetails", message: "User details" }),
  nodeId: msg({ id: "product.nodeId", message: "Node ID" }),
  userId: msg({ id: "product.userId", message: "User ID" }),
  registerMethod: msg({ id: "product.registerMethod", message: "Register method" }),
  personalDevices: msg({ id: "product.personalDevices", message: "Personal machines" }),
  activeAuthKeys: msg({ id: "product.activeAuthKeys", message: "Active auth keys" }),
  policyReferences: msg({ id: "product.policyReferences", message: "Policy references" }),
  noPersonalDevices: msg({ id: "product.noPersonalDevices", message: "No personal machines." }),
  noPolicyReferences: msg({ id: "product.noPolicyReferences", message: "No policy references." }),
  unknown: msg({ id: "product.unknown", message: "Unknown" }),
  pendingRoutes: msg({ id: "product.pendingRoutes", message: "Pending routes" }),
  exitRoute: msg({ id: "product.exitRoute", message: "Exit route" }),
  rename: msg({ id: "product.rename", message: "Rename" }),
  renameMachineTitle: msg({ id: "product.renameMachineTitle", message: "Rename machine" }),
  renameMachineDescription: msg({
    id: "product.renameMachineDescription",
    message: "Change the machine name shown in Headscale.",
  }),
  machineName: msg({ id: "product.machineName", message: "Machine name" }),
  saveName: msg({ id: "product.saveName", message: "Save name" }),
  expire: msg({ id: "product.expire", message: "Expire" }),
  expireMachineTitle: msg({ id: "product.expireMachineTitle", message: "Expire machine" }),
  expireMachineDescription: msg({
    id: "product.expireMachineDescription",
    message: "This will force the machine to re-authenticate before it can connect again.",
  }),
  confirmExpire: msg({ id: "product.confirmExpire", message: "Expire machine" }),
  remove: msg({ id: "product.remove", message: "Remove" }),
  removeMachineTitle: msg({ id: "product.removeMachineTitle", message: "Remove machine" }),
  removeMachineDescription: msg({
    id: "product.removeMachineDescription",
    message: "This removes the machine from Headscale and cannot be undone from this UI.",
  }),
  confirmRemove: msg({ id: "product.confirmRemove", message: "Remove machine" }),
  cancel: msg({ id: "product.cancel", message: "Cancel" }),
  membersTitle: msg({ id: "product.membersTitle", message: "Users" }),
  membersSubtitle: msg({
    id: "product.membersSubtitle",
    message: "Manage the users in your network and their permissions.",
  }),
  addMember: msg({ id: "product.addMember", message: "Add user" }),
  searchUsers: msg({ id: "product.searchUsers", message: "Search users..." }),
  allUsers: msg({ id: "product.allUsers", message: "All users" }),
  owners: msg({ id: "product.owners", message: "Owners" }),
  members: msg({ id: "product.members", message: "Members" }),
  serviceAccounts: msg({ id: "product.serviceAccounts", message: "Service accounts" }),
  role: msg({ id: "product.role", message: "Role" }),
  joined: msg({ id: "product.joined", message: "Joined" }),
  authSource: msg({ id: "product.authSource", message: "Auth source" }),
  memberName: msg({ id: "product.memberName", message: "User name" }),
  displayName: msg({ id: "product.displayName", message: "Display name" }),
  email: msg({ id: "product.email", message: "Email" }),
  createMember: msg({ id: "product.createMember", message: "Create user" }),
  deviceCount: msg({ id: "product.deviceCount", message: "devices" }),
  memberDevices: msg({ id: "product.memberDevices", message: "Devices" }),
  deleteMember: msg({ id: "product.deleteMember", message: "Delete user" }),
  renameMember: msg({ id: "product.renameMember", message: "Rename user" }),
  renameMemberTitle: msg({ id: "product.renameMemberTitle", message: "Rename user" }),
  renameMemberDescription: msg({
    id: "product.renameMemberDescription",
    message: "Change the Headscale username used for this account.",
  }),
  saveMemberName: msg({ id: "product.saveMemberName", message: "Save user name" }),
  deleteMemberTitle: msg({ id: "product.deleteMemberTitle", message: "Delete user" }),
  deleteMemberDescription: msg({
    id: "product.deleteMemberDescription",
    message:
      "This removes the user from Headscale. Review their machines and auth keys before continuing.",
  }),
  confirmDeleteMember: msg({ id: "product.confirmDeleteMember", message: "Delete user" }),
  noUsersMatch: msg({ id: "product.noUsersMatch", message: "No users match these filters." }),
  invitesTitle: msg({ id: "product.invitesTitle", message: "Auth keys" }),
  invitesSubtitle: msg({
    id: "product.invitesSubtitle",
    message: "Create keys that let machines join without exposing server internals.",
  }),
  searchAuthKeys: msg({ id: "product.searchAuthKeys", message: "Search keys, owners or tags..." }),
  inviteOwner: msg({ id: "product.inviteOwner", message: "Owner" }),
  noUsers: msg({ id: "product.noUsers", message: "No users available" }),
  inviteExpiration: msg({ id: "product.inviteExpiration", message: "Expiration" }),
  dateTimePlaceholder: msg({ id: "product.dateTimePlaceholder", message: "Pick date and time" }),
  expirationMustBeFuture: msg({
    id: "product.expirationMustBeFuture",
    message: "Choose an expiration in the future.",
  }),
  policySavedNewerEdits: msg({
    id: "product.policySavedNewerEdits",
    message: "Saved the submitted policy. Newer edits are still unsaved.",
  }),
  policySaveContextChanged: msg({
    id: "product.policySaveContextChanged",
    message: "The policy was saved. This editor has changed; review it before trying again.",
  }),
  policyReferenceInvalidName: msg({
    id: "product.policyReferenceInvalidName",
    message: "Enter a valid group or tag name.",
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
  installCommand: msg({ id: "product.installCommand", message: "Install command" }),
  oneTimeKey: msg({ id: "product.oneTimeKey", message: "One-time key" }),
  readyKeys: msg({ id: "product.readyKeys", message: "Ready keys" }),
  taggedKeys: msg({ id: "product.taggedKeys", message: "Tagged keys" }),
  used: msg({ id: "product.used", message: "Used" }),
  unused: msg({ id: "product.unused", message: "Ready" }),
  expireInvite: msg({ id: "product.expireInvite", message: "Expire key" }),
  deleteInvite: msg({ id: "product.deleteInvite", message: "Delete key" }),
  expireInviteTitle: msg({ id: "product.expireInviteTitle", message: "Expire auth key" }),
  expireInviteDescription: msg({
    id: "product.expireInviteDescription",
    message: "This key will stop accepting new machines.",
  }),
  deleteInviteTitle: msg({ id: "product.deleteInviteTitle", message: "Delete auth key" }),
  deleteInviteDescription: msg({
    id: "product.deleteInviteDescription",
    message: "This removes the auth key from Headscale.",
  }),
  confirmExpireInvite: msg({ id: "product.confirmExpireInvite", message: "Expire key" }),
  confirmDeleteInvite: msg({ id: "product.confirmDeleteInvite", message: "Delete key" }),
  noAuthKeys: msg({ id: "product.noAuthKeys", message: "No auth keys match these filters." }),
  routesTitle: msg({ id: "product.routesTitle", message: "Routes" }),
  routesSubtitle: msg({
    id: "product.routesSubtitle",
    message: "Review subnet and exit routes before making them available to users.",
  }),
  approvedRoutes: msg({ id: "product.approvedRoutes", message: "Approved routes" }),
  availableRoutes: msg({ id: "product.availableRoutes", message: "Available routes" }),
  viewMachine: msg({ id: "product.viewMachine", message: "View machine" }),
  viewUser: msg({ id: "product.viewUser", message: "View user" }),
  approveRoute: msg({ id: "product.approveRoute", message: "Approve route" }),
  approveRouteTitle: msg({ id: "product.approveRouteTitle", message: "Approve route" }),
  approveRouteDescription: msg({
    id: "product.approveRouteDescription",
    message: "Only this route will be approved. Existing approved routes stay enabled.",
  }),
  approveExitRouteTitle: msg({
    id: "product.approveExitRouteTitle",
    message: "Approve exit route",
  }),
  approveExitRouteDescription: msg({
    id: "product.approveExitRouteDescription",
    message:
      "Exit routes can carry internet-bound traffic through this machine. Confirm that this server should be trusted for that path.",
  }),
  revokeRoute: msg({ id: "product.revokeRoute", message: "Revoke route" }),
  revokeRouteTitle: msg({ id: "product.revokeRouteTitle", message: "Revoke route approval" }),
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
  confirmApproveRoutes: msg({ id: "product.confirmApproveRoutes", message: "Approve routes" }),
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
  tagOwners: msg({ id: "product.tagOwners", message: "Tag owners" }),
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
  readyToSave: msg({ id: "product.readyToSave", message: "Ready to save" }),
  policy: msg({ id: "product.policy", message: "Policy" }),
  savePolicy: msg({ id: "product.savePolicy", message: "Save" }),
  noPolicyGroupMembers: msg({ id: "product.noPolicyGroupMembers", message: "No members yet." }),
  noPolicyTagOwnerEntries: msg({
    id: "product.noPolicyTagOwnerEntries",
    message: "No owners yet.",
  }),
  addUserToGroup: msg({ id: "product.addUserToGroup", message: "Add to groups" }),
  grantTagToUser: msg({ id: "product.grantTagToUser", message: "Grant tag ownership" }),
  assignMembershipsTitle: msg({
    id: "product.assignMembershipsTitle",
    message: "Add user to groups",
  }),
  assignMembershipsDescription: msg({
    id: "product.assignMembershipsDescription",
    message:
      "Pick the groups this user should belong to. Changes are saved to the Policy when you apply.",
  }),
  assignTagOwnershipsTitle: msg({
    id: "product.assignTagOwnershipsTitle",
    message: "Grant tag ownership",
  }),
  assignTagOwnershipsDescription: msg({
    id: "product.assignTagOwnershipsDescription",
    message:
      "Pick the tags this user should be able to own. Changes are saved to the Policy when you apply.",
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
  removeFromReference: msg({ id: "product.removeFromReference", message: "Remove from reference" }),
  userImpactOnDeleteHeading: msg({
    id: "product.userImpactOnDeleteHeading",
    message: "This user appears in the following Policy entries:",
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
      "You have unsaved policy changes on the Access page. Save or discard them there before changing the policy from here.",
  }),
  renameUpdateReferencesOption: msg({
    id: "product.renameUpdateReferencesOption",
    message: "Also update those Policy references to the new name",
  }),
  renameMemberPolicyPending: msg({
    id: "product.renameMemberPolicyPending",
    message:
      "The user was renamed, but the policy still uses the old name. Try again, or update those references in Access controls.",
  }),
  copied: msg({ id: "product.copied", message: "Copied" }),
  copy: msg({ id: "product.copy", message: "Copy" }),
  openServerSettings: msg({ id: "product.openServerSettings", message: "Server settings" }),
  serverSettingsTitle: msg({ id: "product.serverSettingsTitle", message: "Server settings" }),
  serverSettingsDescription: msg({
    id: "product.serverSettingsDescription",
    message: "Manage server-scoped credentials and maintenance actions.",
  }),
  apiKeysTitle: msg({ id: "product.apiKeysTitle", message: "API keys" }),
  apiKeysDescription: msg({
    id: "product.apiKeysDescription",
    message: "API keys can control this Headscale server. The full key is only shown once.",
  }),
  apiKeyPrefix: msg({ id: "product.apiKeyPrefix", message: "Prefix" }),
  createdApiKey: msg({ id: "product.createdApiKey", message: "Created API key" }),
  apiKeyOnlyShownOnce: msg({
    id: "product.apiKeyOnlyShownOnce",
    message: "Copy it now. Headscale will not return the full key again.",
  }),
  createApiKeyTitle: msg({ id: "product.createApiKeyTitle", message: "Create API key" }),
  apiKeyExpiration: msg({ id: "product.apiKeyExpiration", message: "API key expiration" }),
  expireApiKeyTitle: msg({ id: "product.expireApiKeyTitle", message: "Expire API key" }),
  deleteApiKeyTitle: msg({ id: "product.deleteApiKeyTitle", message: "Delete API key" }),
  confirmExpireApiKey: msg({ id: "product.confirmExpireApiKey", message: "Expire API key" }),
  confirmDeleteApiKey: msg({ id: "product.confirmDeleteApiKey", message: "Delete API key" }),
  maintenance: msg({ id: "product.maintenance", message: "Maintenance" }),
  maintenanceDescription: msg({
    id: "product.maintenanceDescription",
    message:
      "These actions are server-wide. Use them only when repairing or validating Headscale state.",
  }),
  backfillNodeIps: msg({ id: "product.backfillNodeIps", message: "Backfill node IPs" }),
  backfillNodeIpsDescription: msg({
    id: "product.backfillNodeIpsDescription",
    message: "Run Headscale''s global node IP backfill maintenance action.",
  }),
  confirmBackfillNodeIps: msg({ id: "product.confirmBackfillNodeIps", message: "Run backfill" }),
  backfillResult: msg({ id: "product.backfillResult", message: "Backfill result" }),
  refreshData: msg({ id: "product.refreshData", message: "Refresh data" }),
  never: msg({ id: "product.never", message: "Never" }),
  roleOwner: msg({ id: "product.roleOwner", message: "Owner" }),
  roleMember: msg({ id: "product.roleMember", message: "Member" }),
  roleServiceAccount: msg({ id: "product.roleServiceAccount", message: "Service account" }),
  errorUserNotFound: msg({ id: "product.errorUserNotFound", message: "User not found" }),
  errorUserStillOwns: msg({
    id: "product.errorUserStillOwns",
    message: "User still owns machines or auth keys. Remove them before deleting.",
  }),
  errorNodeNotFound: msg({ id: "product.errorNodeNotFound", message: "Node not found" }),
  errorRequestFailed: msg({
    id: "product.errorRequestFailed",
    message: "Headscale request failed. Check server URL and API key.",
  }),
  resourceAccessTitle: msg({ id: "product.resourceAccessTitle", message: "Resource access" }),
  resourceAccessSubtitle: msg({
    id: "product.resourceAccessSubtitle",
    message:
      "Decide which people and teams can reach which devices. Group devices with labels and people into teams.",
  }),
  teamsSection: msg({ id: "product.teamsSection", message: "Teams" }),
  deviceLabelsSection: msg({ id: "product.deviceLabelsSection", message: "Device labels" }),
  newTeam: msg({ id: "product.newTeam", message: "New team" }),
  newDeviceLabel: msg({ id: "product.newDeviceLabel", message: "New device label" }),
  noTeamsYet: msg({ id: "product.noTeamsYet", message: "No teams yet" }),
  noTeamsHint: msg({
    id: "product.noTeamsHint",
    message: "Create a team to grant access to a group of people at once.",
  }),
  noDeviceLabelsYet: msg({ id: "product.noDeviceLabelsYet", message: "No device labels yet" }),
  noDeviceLabelsHint: msg({
    id: "product.noDeviceLabelsHint",
    message: "Create a device label to manage access for groups of similar devices.",
  }),
  searchDeviceLabels: msg({ id: "product.searchDeviceLabels", message: "Search device labels…" }),
  tagDetailDialogTitle: msg({
    id: "product.tagDetailDialogTitle",
    message: "Device label · policy",
  }),
  tagDetailDialogSubtitle: msg({
    id: "product.tagDetailDialogSubtitle",
    message:
      "Define who owns this label and which teams can reach devices that carry it. This does not change tags on individual machines.",
  }),
  deviceLabelName: msg({ id: "product.deviceLabelName", message: "Label name" }),
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
    message: "Who can apply this label to devices",
  }),
  addAccessor: msg({ id: "product.addAccessor", message: "Give access" }),
  addLabelManager: msg({ id: "product.addLabelManager", message: "Add label manager" }),
  removeAccessor: msg({ id: "product.removeAccessor", message: "Remove access" }),
  removeLabelManager: msg({ id: "product.removeLabelManager", message: "Remove label manager" }),
  teamDetailDialogTitle: msg({ id: "product.teamDetailDialogTitle", message: "Manage team" }),
  teamName: msg({ id: "product.teamName", message: "Team name" }),
  teamNameHint: msg({ id: "product.teamNameHint", message: "Example: ops, dev, security" }),
  teamMembersSection: msg({ id: "product.teamMembersSection", message: "Members" }),
  addMemberToTeam: msg({ id: "product.addMemberToTeam", message: "Add member" }),
  removeTeamMember: msg({ id: "product.removeTeamMember", message: "Remove member" }),
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
  removeDeviceLabel: msg({ id: "product.removeDeviceLabel", message: "Delete device label" }),
  svcSshLabel: msg({ id: "product.svcSshLabel", message: "SSH" }),
  svcSshHint: msg({ id: "product.svcSshHint", message: "Port 22" }),
  svcWebLabel: msg({ id: "product.svcWebLabel", message: "Web" }),
  svcWebHint: msg({ id: "product.svcWebHint", message: "Ports 80 and 443" }),
  svcRdpLabel: msg({ id: "product.svcRdpLabel", message: "Remote desktop" }),
  svcRdpHint: msg({ id: "product.svcRdpHint", message: "Port 3389" }),
  svcDnsLabel: msg({ id: "product.svcDnsLabel", message: "DNS" }),
  svcDnsHint: msg({ id: "product.svcDnsHint", message: "Port 53" }),
  svcAllLabel: msg({ id: "product.svcAllLabel", message: "All services" }),
  svcCustomLabel: msg({ id: "product.svcCustomLabel", message: "Custom ports" }),
  svcCustomPlaceholder: msg({
    id: "product.svcCustomPlaceholder",
    message: "e.g. 8080, 9000-9100",
  }),
  labelManagersLabel: msg({ id: "product.labelManagersLabel", message: "Label managers" }),
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
  authRequestKind: msg({ id: "product.authRequestKind", message: "Request type" }),
  authRequestKindDevice: msg({ id: "product.authRequestKindDevice", message: "Device sign-in" }),
  authRequestKindSsh: msg({ id: "product.authRequestKindSsh", message: "SSH check" }),
  authRequestLabel: msg({ id: "product.authRequestLabel", message: "Request link or ID" }),
  authRequestHelp: msg({
    id: "product.authRequestHelp",
    message:
      "Paste the link or ID shown by tailscale up or by an SSH check prompt. Request IDs are short-lived.",
  }),
  authRequestInvalid: msg({
    id: "product.authRequestInvalid",
    message: "Enter a request ID starting with hskey-authreq- or paste the full link.",
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
      "Approve or reject an SSH session that is waiting for a check. This never registers a device.",
  }),
  approveSshCheck: msg({ id: "product.approveSshCheck", message: "Approve SSH check" }),
  rejectSshCheck: msg({ id: "product.rejectSshCheck", message: "Reject SSH check" }),
  sshCheckApproved: msg({ id: "product.sshCheckApproved", message: "SSH check approved." }),
  sshCheckRejected: msg({ id: "product.sshCheckRejected", message: "SSH check rejected." }),
  checkPolicy: msg({ id: "product.checkPolicy", message: "Check policy" }),
  policyCheckPassed: msg({
    id: "product.policyCheckPassed",
    message: "Headscale found no problems in this policy. Nothing was saved.",
  }),
  policyAdvancedRuleHint: msg({
    id: "product.policyAdvancedRuleHint",
    message: "This rule has additional restrictions. Edit its services in the Headscale policy.",
  }),
  noAccessors: msg({ id: "product.noAccessors", message: "No ACL access rules are listed here." }),
  noLabelManagers: msg({ id: "product.noLabelManagers", message: "No managers yet" }),
  ipRulesSectionTitle: msg({
    id: "product.ipRulesSectionTitle",
    message: "IP and all-destination rules (advanced)",
  }),
  ipRulesSectionHint: msg({
    id: "product.ipRulesSectionHint",
    message:
      "These rules grant access to IP addresses, network ranges, or all destinations. You can edit or delete them here.",
  }),
  editIpRule: msg({ id: "product.editIpRule", message: "Edit rule" }),
  saveIpRule: msg({ id: "product.saveIpRule", message: "Save rule" }),
  cancelIpRuleEdit: msg({ id: "product.cancelIpRuleEdit", message: "Cancel edit" }),
  ipRuleSourcePlaceholder: msg({ id: "product.ipRuleSourcePlaceholder", message: "source" }),
  ipRuleDestinationPlaceholder: msg({
    id: "product.ipRuleDestinationPlaceholder",
    message: "destination",
  }),
  ipRulePortsPlaceholder: msg({ id: "product.ipRulePortsPlaceholder", message: "ports" }),
  ipRuleFieldsRequired: msg({
    id: "product.ipRuleFieldsRequired",
    message: "Source, destination and ports are all required.",
  }),
  openAccessBannerTitle: msg({
    id: "product.openAccessBannerTitle",
    message: "High risk: open access detected",
  }),
  orphanRefBannerTitle: msg({
    id: "product.orphanRefBannerTitle",
    message: "Some policy references are stale",
  }),
  orphanReferenceBadge: msg({ id: "product.orphanReferenceBadge", message: "Stale reference" }),
  orphanReferenceTooltip: msg({
    id: "product.orphanReferenceTooltip",
    message:
      "We couldn''t find a matching account, team, or device label. It may be a typo, a format mismatch, or a deleted object. Click ✕ next to the entry to remove it.",
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
  changesAutoSaveHint: msg({
    id: "product.changesAutoSaveHint",
    message: 'Click "Save" at the top to send these changes to your devices.',
  }),
  unsavedChangesBadge: msg({ id: "product.unsavedChangesBadge", message: "Unsaved" }),
  unsavedChangesTitle: msg({ id: "product.unsavedChangesTitle", message: "Unsaved changes" }),
  unsavedChangesBody: msg({
    id: "product.unsavedChangesBody",
    message: "Your changes are only kept in this browser until you click Save. Close anyway?",
  }),
  unsavedChangesSaveAndClose: msg({
    id: "product.unsavedChangesSaveAndClose",
    message: "Save and close",
  }),
  unsavedChangesCloseAnyway: msg({
    id: "product.unsavedChangesCloseAnyway",
    message: "Close without saving",
  }),
  confirm: msg({ id: "product.confirm", message: "Confirm" }),
  assignedBadgeLabel: msg({ id: "product.assignedBadgeLabel", message: "Assigned" }),
  highRiskConfirmTitle: msg({
    id: "product.highRiskConfirmTitle",
    message: "Grant very broad access?",
  }),
  highRiskConfirmDescription: msg({
    id: "product.highRiskConfirmDescription",
    message: "Everyone in this scope will reach every selected device on every service. Continue?",
  }),
  selectAccessorSearchPlaceholder: msg({
    id: "product.selectAccessorSearchPlaceholder",
    message: "Find a person, team, or label…",
  }),
  selectAccessorEmpty: msg({ id: "product.selectAccessorEmpty", message: "No matches" }),
  selectMemberSearchPlaceholder: msg({
    id: "product.selectMemberSearchPlaceholder",
    message: "Search users…",
  }),
  selectMemberEmpty: msg({ id: "product.selectMemberEmpty", message: "No matching users" }),
  selectLabelManagerSearchPlaceholder: msg({
    id: "product.selectLabelManagerSearchPlaceholder",
    message: "Search users, teams…",
  }),
  selectLabelManagerEmpty: msg({ id: "product.selectLabelManagerEmpty", message: "No matches" }),
  optionGroupUsers: msg({ id: "product.optionGroupUsers", message: "Users" }),
  optionGroupTeams: msg({ id: "product.optionGroupTeams", message: "Teams" }),
  optionGroupLabels: msg({ id: "product.optionGroupLabels", message: "Device labels" }),
  optionGroupSpecial: msg({ id: "product.optionGroupSpecial", message: "Special" }),
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
  templateSmallTeamTitle: msg({ id: "product.templateSmallTeamTitle", message: "Small team" }),
  templateSmallTeamDescription: msg({
    id: "product.templateSmallTeamDescription",
    message: "Create a team and let them share a pool of devices over SSH and web.",
  }),
  templateSplitEnvTitle: msg({ id: "product.templateSplitEnvTitle", message: "Dev + production" }),
  templateSplitEnvDescription: msg({
    id: "product.templateSplitEnvDescription",
    message: "Separate dev and ops teams with access to their own labelled servers.",
  }),
  applyTemplate: msg({ id: "product.applyTemplate", message: "Use this template" }),
  currentApiKeyBadge: msg({ id: "product.currentApiKeyBadge", message: "Used by this session" }),
  currentApiKeyWarning: msg({
    id: "product.currentApiKeyWarning",
    message:
      "This key authenticates your current session. Once it is expired or deleted, this session loses access to the server and you must create a new API key with the Headscale CLI.",
  }),
  currentApiKeyAcknowledge: msg({
    id: "product.currentApiKeyAcknowledge",
    message: "I understand this session will lose access.",
  }),
  disableExpiry: msg({ id: "product.disableExpiry", message: "Disable expiry" }),
  disableExpiryTitle: msg({ id: "product.disableExpiryTitle", message: "Disable machine expiry?" }),
  disableExpiryDescription: msg({
    id: "product.disableExpiryDescription",
    message:
      "This machine will no longer expire and will keep access without signing in again until you expire it.",
  }),
  inviteNoOwner: msg({ id: "product.inviteNoOwner", message: "No owner (tags only)" }),
  inviteTagsRequired: msg({
    id: "product.inviteTagsRequired",
    message: "A key without an owner needs at least one ACL tag.",
  }),
  authKeyCreated: msg({ id: "product.authKeyCreated", message: "Auth key created" }),
};
export const pluralDescriptors = {
  teamMembers: msg({
    id: "plural.teamMembers",
    message: "{count, plural, one {{formattedCount} member} other {{formattedCount} members}}",
  }),
  devicesTagged: msg({
    id: "plural.devicesTagged",
    message: "{count, plural, one {{formattedCount} device} other {{formattedCount} devices}}",
  }),
  openAccessWarnings: msg({
    id: "plural.openAccessWarnings",
    message:
      "{count, plural, one {{formattedCount} rule currently lets everyone reach every device.} other {{formattedCount} rules currently let everyone reach every device.}}",
  }),
  orphanReferences: msg({
    id: "plural.orphanReferences",
    message:
      "{count, plural, one {{formattedCount} reference no longer matches an existing account, team, or device label.} other {{formattedCount} references no longer match existing accounts, teams, or device labels.}}",
  }),
  cleanupOrphans: msg({
    id: "plural.cleanupOrphans",
    message:
      "{count, plural, one {Clean up {formattedCount} stale reference} other {Clean up {formattedCount} stale references}}",
  }),
};
