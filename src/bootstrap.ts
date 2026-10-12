import { ApiError } from "./api/gateway";
import { applyStoredTheme } from "./composables/useTheme";
import { applyStoredLocale } from "./i18n";
import type { ProfileList } from "./lib/profile-storage";
import { clearSessionMetadata } from "./lib/secure-storage";
import { hydrateSettings } from "./lib/settings-storage";
import type { SessionBridge } from "./session/bridge";
import { createBrowserSessionBridge } from "./session/connect";

export interface BootstrapState {
  bridge: SessionBridge;
  profiles: ProfileList | null;
}

export async function prepareApplication(): Promise<BootstrapState> {
  await hydrateSettings();
  applyStoredTheme();
  await applyStoredLocale();
  const bridge = createBrowserSessionBridge();
  try {
    const ready = await bridge.connect();
    if (!ready.ok) throw new ApiError(ready.error);
    const profiles = await bridge.listProfiles();
    if (!profiles.ok) throw new ApiError(profiles.error);
    return { bridge, profiles: profiles.value };
  } catch (error) {
    bridge.dispose();
    throw error;
  }
}

/**
 * Repairs an unreadable vault-state. The page never touches IndexedDB: the shared
 * Worker locks the session, then rewrites storage, and refuses a readable vault.
 * Resolves false when the committed reset could not clear sessionStorage metadata.
 */
export async function resetUnreadableVault(): Promise<boolean> {
  const bridge = createBrowserSessionBridge();
  try {
    const ready = await bridge.connect();
    if (!ready.ok) throw new ApiError(ready.error);
    const reset = await bridge.resetStorage(null);
    if (!reset.ok) throw new ApiError(reset.error);
    return clearSessionMetadata();
  } finally {
    bridge.dispose();
  }
}
