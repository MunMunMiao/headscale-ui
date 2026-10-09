import type { ConnectionProfile } from "@/lib/profile-storage";
import { useMasterPassword } from "./useMasterPassword";

export type ProfileVisualState = "device" | "password" | "locked" | "corrupted" | "session";

export function useProfileVisuals() {
  const masterPassword = useMasterPassword();

  // Ordered: corrupted > session > password-scheme > device. The ordering is
  // load-bearing — corruption hides a session/password classification because
  // the underlying secret can't be decrypted anyway.
  function profileVisualState(profile: ConnectionProfile): ProfileVisualState {
    if (profile.corrupted) return "corrupted";
    if (profile.scope === "session") return "session";
    if (profile.apiKey.scheme === "password") {
      return masterPassword.isUnlocked.value ? "password" : "locked";
    }
    return "device";
  }

  function profileAvatarLabel(profile: ConnectionProfile) {
    const source = profile.name || profile.baseUrl;
    return source.trim().slice(0, 2).toUpperCase() || "HS";
  }

  return { profileVisualState, profileAvatarLabel };
}
