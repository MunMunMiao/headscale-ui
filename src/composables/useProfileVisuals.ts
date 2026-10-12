import type { ProfileSummary } from "@/lib/profile-storage";
import type { PublicSessionSnapshot } from "@/session/types";
import { useSession, useStore } from "./session-context";

export type ProfileVisualState = "password" | "locked" | "corrupted" | "session" | "migration";
export function createProfileVisuals(getSessionSnapshot: () => PublicSessionSnapshot | null) {
  function profileVisualState(profile: ProfileSummary): ProfileVisualState {
    if (profile.credentialKind === "unreadable") return "corrupted";
    if (profile.credentialKind !== "password") return "migration";
    if (profile.scope === "session") return "session";
    const session = getSessionSnapshot();
    return session?.status === "unlocked" && session.profile?.id === profile.id
      ? "password"
      : "locked";
  }
  function profileAvatarLabel(profile: ProfileSummary) {
    const source = profile.name || profile.baseUrl;
    return source.trim().slice(0, 2).toUpperCase() || "HS";
  }
  return { profileVisualState, profileAvatarLabel };
}
export function useProfileVisuals() {
  const auth = useStore(useSession().auth);
  return createProfileVisuals(auth.getSessionSnapshot);
}
