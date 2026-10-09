import type { OperationGroup, OperationId } from "@/domain/headscale-operations";
import { arCatalog } from "./catalogs/ar";
import { esESCatalog } from "./catalogs/es-ES";
import { frFRCatalog } from "./catalogs/fr-FR";
import { itITCatalog } from "./catalogs/it-IT";
import { jaJP } from "./catalogs/ja-JP";
import { koKR } from "./catalogs/ko-KR";
import { ruRU } from "./catalogs/ru-RU";
import { zhHans } from "./catalogs/zh-Hans";
import { zhHantHK } from "./catalogs/zh-Hant-HK";
import { zhHantTW } from "./catalogs/zh-Hant-TW";
import type { Locale } from "./locales";

export const messageKeys = {
  appTitle: "Headscale UI",
  appSubtitle: "A typed control surface for Headscale v0.28 REST operations.",
  connection: "Connection",
  serverUrl: "Server URL",
  apiKey: "API key",
  apiKeyPlaceholder: "Bearer token created by headscale apikeys create",
  connectionInvalidUrl: "Enter an absolute HTTP(S) server URL.",
  connectionApiKeyRequired: "Enter an API key.",
  connectTitle: "Connect to Headscale",
  connectSubtitle:
    "Enter the server address and authorization token before opening the control surface.",
  profileSelectorTitle: "Choose a server profile",
  profileSelectorDescription:
    "Pick a saved profile like an operating system login, or add another Headscale server.",
  profile: "Profile",
  newProfile: "New profile",
  profileName: "Profile name",
  addServerProfile: "Add server",
  connectAsProfile: "Connect as",
  updatedProfile: "Updated",
  saveProfile: "Save profile",
  addProfile: "Add",
  addingProfile: "Adding",
  checkingCredentials: "Checking credentials",
  restoringSession: "Reconnecting to {name}…",
  close: "Close",
  discardProfileChangesTitle: "Close without adding this server?",
  discardProfileChangesDescription:
    "The profile details have changed. Closing now will discard the unsaved edits.",
  keepEditingProfile: "Keep editing",
  discardProfileChanges: "Discard changes",
  connectionValidationFailedTitle: "Add this server anyway?",
  connectionValidationFailedDescription:
    "The UI could not verify the server URL or API key. You can keep editing the details, or add the profile and fix it later. You can edit this profile from the list at any time.",
  backToEditConnection: "Review details",
  saveAnywayButton: "Continue adding",
  savedProfiles: "Saved profiles",
  useProfile: "Use",
  editProfile: "Edit profile",
  deleteProfile: "Delete profile",
  confirmDeleteProfileTitle: "Delete this profile?",
  confirmDeleteProfileDescription:
    "This removes the saved server URL and API key from this browser.",
  apiKeyGuideTitle: "How to get an API key",
  apiKeyGuideDescription:
    "Headscale API keys are created from the server CLI before the UI can connect.",
  apiKeyGuideCommandLabel: "Run on the Headscale server",
  apiKeyGuideStepServer: "SSH into the server that runs Headscale.",
  apiKeyGuideStepCreate: "Create a short-lived API key with the Headscale CLI.",
  apiKeyGuideStepCopy: "Copy the full key immediately; Headscale only shows it once.",
  apiKeyGuideStepPaste: "Paste the key here with your HTTPS Headscale URL.",
  apiKeyGuideHint: "If a key is lost or expired, expire it and create a new one on the server.",
  headscaleDocs: "Headscale docs",
  rememberConnection: "Remember this connection in this browser",
  cancel: "Cancel",
  connect: "Connect",
  logout: "Log out",
  theme: "Theme",
  language: "Language",
  light: "Light",
  dark: "Dark",
  system: "System",
  refresh: "Refresh",
  run: "Run",
  running: "Running",
  result: "Result",
  operation: "Operation",
  method: "Method",
  path: "Path",
  executableOperations: "Executable operations",
  serverBoundaries: "Configuration and server boundaries",
  serverBoundariesDescription:
    "These Headscale areas are important, but v0.28 does not expose stable REST management endpoints for them.",
  stateOverview: "State overview",
  users: "Users",
  nodes: "Nodes",
  preAuthKeys: "Pre-auth keys",
  apiKeys: "API keys",
  policy: "Policy",
  routes: "Routes",
  health: "Health",
  version: "Version",
  online: "Online",
  offline: "Offline",
  database: "Database",
  connected: "Connected",
  disconnected: "Disconnected",
  coverageMatrix: "E2E coverage matrix",
  coverageDescription:
    "Every stable Headscale REST operation below is rendered and executable through the UI.",
  lastResponse: "Last response",
  copy: "Copy",
  copied: "Copied",
  noData: "No data",
  sensitiveValue: "Sensitive values are only shown when returned by Headscale once.",
  unsupportedByApi: "No stable REST API in Headscale v0.28",
  dnsTitle: "DNS and MagicDNS",
  dnsDescription:
    "MagicDNS, nameservers, split DNS, search domains and extra records are configuration-file concerns.",
  oidcTitle: "OIDC and registration policy",
  oidcDescription:
    "Issuer, client settings, allowed users and groups are server configuration; v0.28 node approval uses node registration endpoints.",
  derpTitle: "DERP and relay map",
  derpDescription:
    "DERP map sources, embedded DERP and STUN settings are server configuration and diagnostics.",
  serveTitle: "Serve, Funnel and Taildrop",
  serveDescription:
    "Serve and Funnel are Tailscale client features; Taildrop is Headscale configuration, not a v0.28 management API.",
  encryptionSectionTitle: "Encryption",
  encryptionEnableLabel: "Use a passphrase to protect saved API keys",
  encryptionEnableHint:
    "Without a passphrase, saved keys are bound to this browser only and cannot be transferred.",
  encryptionSetupWarning:
    "This passphrase cannot be recovered. If you forget it, you must clear all saved profiles and re-enter your API keys.",
  encryptionSetupWarningConfirm: "I have safely recorded this passphrase",
  encryptionSetPassphrase: "Set a passphrase",
  encryptionConfirmPassphrase: "Confirm passphrase",
  encryptionChangePassphrase: "Change passphrase",
  encryptionDisable: "Disable passphrase",
  encryptionDisableConfirm:
    "Enter current passphrase to disable. Saved keys will fall back to device-bound encryption.",
  encryptionUnlockTitle: "Unlock saved profiles",
  encryptionUnlockDescription:
    "Enter the passphrase you set previously to access your saved API keys.",
  encryptionUnlockSubmit: "Unlock",
  encryptionEnterPassphrase: "Enter passphrase",
  encryptionLocalityNote:
    "Your API keys are encrypted on this device. The passphrase never leaves your browser.",
  encryptionUnlockFailed: "Incorrect passphrase.",
  encryptionForgotten:
    "Forgot your passphrase? You must clear all saved profiles and re-enter your API keys. The passphrase cannot be recovered.",
  encryptionForgottenButton: "Clear all saved profiles",
  forgotConfirmTitle: "Clear all encrypted data?",
  forgotConfirmDescription:
    "This will permanently delete all {count} saved server profile(s) and reset your passphrase. You will need to add your servers and API keys again. This cannot be undone.",
  profilesClearedNotice: "All saved profiles have been cleared. Add a server to start fresh.",
  encryptionProfileCorrupted:
    "This profile's data is corrupted (not a passphrase issue). Re-enter the API key to rebuild this connection.",
  encryptionStorageNote: "Saved API keys are encrypted in this browser.",
  encryptionSessionOnlyBadge: "Session only",
  encryptionEncryptedBadge: "Encrypted",
  encryptionLockedBadge: "Locked",
  encryptionCorruptedBadge: "Corrupted",
  encryptionUnsupportedHint: "This browser does not support persistent storage.",
  encryptionMultiTabNote: "Each browser tab requires its own unlock.",
} as const;

export type MessageKey = keyof typeof messageKeys;

export const commonMessages: Record<Locale, Record<MessageKey, string>> = {
  "en-US": messageKeys,
  "zh-Hans": zhHans.common,
  "zh-Hant-TW": zhHantTW.common,
  "zh-Hant-HK": zhHantHK.common,
  "ja-JP": jaJP.common,
  "ko-KR": koKR.common,
  "fr-FR": frFRCatalog.common,
  "ru-RU": ruRU.common,
  "es-ES": esESCatalog.common,
  "it-IT": itITCatalog.common,
  ar: arCatalog.common,
};

export const groupLabels: Record<Locale, Record<OperationGroup, string>> = {
  "en-US": {
    connection: "Connection",
    users: "Users",
    preauthkeys: "Pre-auth keys",
    nodes: "Nodes",
    routes: "Routes",
    apikeys: "API keys",
    policy: "Policy",
  },
  "zh-Hans": zhHans.groups,
  "zh-Hant-TW": zhHantTW.groups,
  "zh-Hant-HK": zhHantHK.groups,
  "ja-JP": jaJP.groups,
  "ko-KR": koKR.groups,
  "fr-FR": frFRCatalog.groups,
  "ru-RU": ruRU.groups,
  "es-ES": esESCatalog.groups,
  "it-IT": itITCatalog.groups,
  ar: arCatalog.groups,
};

type OperationText = Record<OperationId, { title: string; description: string }>;

const enOperations: OperationText = {
  "health.check": {
    title: "Check health",
    description: "Read Headscale database connectivity from the server health endpoint.",
  },
  "version.get": {
    title: "Read version",
    description: "Read the Headscale server version.",
  },
  "user.list": {
    title: "Query users",
    description: "Filter by id, name or email; leave empty to list all users.",
  },
  "user.create": {
    title: "Create user",
    description: "Create a tailnet user with optional display name, email and avatar.",
  },
  "user.rename": {
    title: "Rename user",
    description: "Rename a user by numeric user ID.",
  },
  "user.delete": {
    title: "Delete user",
    description: "Delete the selected user.",
  },
  "preauthkey.list": {
    title: "List pre-auth keys",
    description: "List all pre-authentication keys.",
  },
  "preauthkey.create": {
    title: "Create pre-auth key",
    description: "Create an auth key for personal or tagged devices.",
  },
  "preauthkey.expire": {
    title: "Expire pre-auth key",
    description: "Expire a pre-authentication key by ID.",
  },
  "preauthkey.delete": {
    title: "Delete pre-auth key",
    description: "Delete a pre-authentication key by ID.",
  },
  "node.list": {
    title: "List nodes",
    description: "List all nodes, optionally filtered by user.",
  },
  "node.get": {
    title: "Read node details",
    description: "Fetch a full node record by node ID.",
  },
  "node.register": {
    title: "Register pending node",
    description: "Approve and register a node with a registration key.",
  },
  "node.debugCreate": {
    title: "Debug create node",
    description: "Create a test node through Headscale's debug endpoint.",
  },
  "node.rename": {
    title: "Rename node",
    description: "Change a node's given name.",
  },
  "node.expire": {
    title: "Expire node",
    description: "Expire a node now, at a specified time, or clear its expiry on newer servers.",
  },
  "node.delete": {
    title: "Delete node",
    description: "Remove a node from the tailnet.",
  },
  "node.setTags": {
    title: "Set node tags",
    description: "Replace the node's current tags.",
  },
  "node.setApprovedRoutes": {
    title: "Approve node routes",
    description: "Replace approved routes, including subnet and exit-node routes.",
  },
  "node.backfillIps": {
    title: "Backfill node IPs",
    description: "Run the Headscale node IP backfill maintenance action.",
  },
  "apikey.list": {
    title: "List API keys",
    description: "List server API key metadata.",
  },
  "apikey.create": {
    title: "Create API key",
    description: "Create a new API key; the full value is returned once.",
  },
  "apikey.expire": {
    title: "Expire API key",
    description: "Expire an API key by prefix or ID.",
  },
  "apikey.delete": {
    title: "Delete API key",
    description: "Delete an API key by prefix and optional ID.",
  },
  "policy.get": {
    title: "Read policy",
    description: "Read the Headscale policy content and update timestamp.",
  },
  "policy.set": {
    title: "Save policy",
    description: "Save the policy generated by the visual ACL, group and tag-owner designer.",
  },
};

export const operationMessages: Record<Locale, OperationText> = {
  "en-US": enOperations,
  "zh-Hans": zhHans.operations,
  "zh-Hant-TW": zhHantTW.operations,
  "zh-Hant-HK": zhHantHK.operations,
  "ja-JP": jaJP.operations,
  "ko-KR": koKR.operations,
  "fr-FR": frFRCatalog.operations,
  "ru-RU": ruRU.operations,
  "es-ES": esESCatalog.operations,
  "it-IT": itITCatalog.operations,
  ar: arCatalog.operations,
};

export function getMessage(locale: Locale, key: MessageKey) {
  return commonMessages[locale][key];
}

export function getGroupLabel(locale: Locale, group: OperationGroup) {
  return groupLabels[locale][group];
}

export function getOperationMessage(locale: Locale, id: OperationId) {
  return operationMessages[locale][id];
}
