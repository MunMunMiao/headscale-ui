import { type ComputedRef, computed, type Ref, reactive, ref } from "vue";
import { type ConnectionSettings, connectionSettingsError } from "@/api/http";
import type { HeadscaleSnapshot } from "@/api/types";
import { useHeadscaleI18n } from "@/i18n";
import { isEncryptedApiKey } from "@/lib/api-key-crypto";
import {
  type ConnectionProfile,
  type ProfileStorageScope,
  profileStorage,
} from "@/lib/profile-storage";
import { useActionFeedback } from "./useActionFeedback";
import { useHeadscaleClient } from "./useHeadscaleClient";
import { useMasterPassword } from "./useMasterPassword";
import { fetchSnapshot } from "./useSnapshot";

export const newProfileId = "__new__";
const profileLoginMinimumMs = 300;

// Explicit state machine for the login lifecycle. Replaces three coupled refs
// (isConnecting/isRestoringSession/authenticatingProfileId) whose Cartesian
// product contained semantically ambiguous combinations.
export type LoginPhase =
  | { kind: "idle" }
  | { kind: "restoring"; profileId: string }
  | { kind: "authenticating"; profileId: string }
  | { kind: "adding" };

type ConnectionForm = ConnectionSettings & {
  profileId: string;
  profileName: string;
  remember: boolean;
};

type AuthenticatedHook = (snapshot: HeadscaleSnapshot) => void;
type LogoutHook = () => void;

interface UseProfilesReturn {
  profiles: Ref<ConnectionProfile[]>;
  connectionForm: ConnectionForm;
  phase: Ref<LoginPhase>;
  isConnecting: ComputedRef<boolean>;
  isRestoringSession: Ref<boolean>;
  authenticatingProfileId: ComputedRef<string | null>;
  selectedProfile: ComputedRef<ConnectionProfile | undefined>;
  currentProfileLabel: ComputedRef<string>;
  connectionDialogOpen: Ref<boolean>;
  connectionCloseConfirmOpen: Ref<boolean>;
  profileValidationDialogOpen: Ref<boolean>;
  profileValidationError: Ref<string>;
  pendingDeleteProfile: Ref<ConnectionProfile | null>;
  loadProfile(profileId: string): Promise<void>;
  openConnectionDialog(profileId: string): Promise<void>;
  closeConnectionDialog(): void;
  addProfile(): Promise<void>;
  persistConnection(): Promise<string>;
  editProfile(profile: ConnectionProfile): Promise<void>;
  deleteProfile(profile: ConnectionProfile): void;
  confirmDeleteProfile(): void;
  enterProfile(profile: ConnectionProfile, mode?: "authenticating" | "restoring"): Promise<boolean>;
  logout(): void;
  setOnAuthenticated(hook: AuthenticatedHook | null): void;
  setOnLogout(hook: LogoutHook | null): void;
}

let instance: UseProfilesReturn | null = null;

/** Internal: invoked by `__testing.ts` only. */
export const profilesTestingHandle = {
  reset() {
    instance = null;
  },
};

function createProfileId() {
  return crypto.randomUUID();
}

function defaultConnectionForm(): ConnectionForm {
  return {
    profileId: newProfileId,
    profileName: "",
    baseUrl: "",
    apiKey: "",
    remember: true,
  };
}

async function profileToForm(profile: ConnectionProfile): Promise<ConnectionForm> {
  const mp = useMasterPassword();
  let apiKey = "";
  try {
    apiKey = await mp.decryptApiKey(profile.apiKey);
  } catch (err) {
    console.error("[headscale-ui] failed to decrypt profile, marking corrupted", err);
    profileStorage.markCorrupted(profile.id);
  }
  return {
    profileId: profile.id,
    profileName: profile.name,
    baseUrl: profile.baseUrl,
    apiKey,
    remember: profileStorage.getProfileScope(profile.id) !== "session",
  };
}

function normalizeProfile(profile: Partial<ConnectionProfile>): ConnectionProfile | null {
  if (!profile.id || !profile.baseUrl || !isEncryptedApiKey(profile.apiKey)) {
    return null;
  }

  const baseUrl = profile.baseUrl.trim();

  return {
    id: profile.id,
    name: profile.name || baseUrl,
    baseUrl,
    apiKey: profile.apiKey,
    updatedAt: profile.updatedAt || new Date().toISOString(),
    scope: profile.scope ?? "persistent",
    ...(profile.ownerTabId ? { ownerTabId: profile.ownerTabId } : {}),
    ...(profile.corrupted ? { corrupted: true as const } : {}),
  };
}

function normalizeProfiles(profileRecords: Partial<ConnectionProfile>[]) {
  return profileRecords
    .map((profile) => normalizeProfile(profile))
    .filter((profile): profile is ConnectionProfile => profile !== null);
}

function loadConnectionProfiles(): ConnectionProfile[] {
  return normalizeProfiles(profileStorage.loadProfiles());
}

export function useProfiles(): UseProfilesReturn {
  if (instance) return instance;

  const { settings, createClient, setSettings } = useHeadscaleClient();
  const { lastError } = useActionFeedback();
  const { t } = useHeadscaleI18n();
  const masterPassword = useMasterPassword();

  const profiles = ref<ConnectionProfile[]>(loadConnectionProfiles());
  const connectionForm = reactive<ConnectionForm>(defaultConnectionForm());

  Object.assign(settings, {
    baseUrl: connectionForm.baseUrl,
    apiKey: connectionForm.apiKey,
  });

  // Phase is the single source of truth for "what's happening in the login flow."
  // generation guards against concurrent authorize calls: when the user switches
  // profiles or logs out mid-flight, the stale promise must not write back state.
  const phase = ref<LoginPhase>({ kind: "idle" });
  let generation = 0;
  const isConnecting = computed(() => phase.value.kind !== "idle");
  const authenticatingProfileId = computed(() => {
    const p = phase.value;
    return p.kind === "authenticating" || p.kind === "restoring" ? p.profileId : null;
  });
  // isRestoringSession stays a writable ref because useSessionRestore owns its
  // lifecycle externally (set true at the start of restoration, false once the
  // first navigation/cold-start decision settles).
  const isRestoringSession = ref(true);
  const connectionDialogOpen = ref(false);
  const connectionCloseConfirmOpen = ref(false);
  const profileValidationDialogOpen = ref(false);
  const profileValidationError = ref("");
  const pendingDeleteProfile = ref<ConnectionProfile | null>(null);

  const selectedProfile = computed(() =>
    profiles.value.find((profile) => profile.id === connectionForm.profileId),
  );
  const currentProfileLabel = computed(() => connectionForm.profileName || t("profile"));

  let onAuthenticated: AuthenticatedHook | null = null;
  let onLogout: LogoutHook | null = null;

  function reloadProfiles() {
    profiles.value = normalizeProfiles(profileStorage.loadProfiles());
  }

  function profileScopeFromForm(): ProfileStorageScope {
    return connectionForm.remember ? "persistent" : "session";
  }

  function formConnectionSettings(): ConnectionSettings {
    const baseUrl = connectionForm.baseUrl.trim();
    const next = { baseUrl, apiKey: connectionForm.apiKey.trim() };
    const error = connectionSettingsError(next);
    if (error) throw new Error(t(error));
    return next;
  }

  async function loadProfile(profileId: string) {
    connectionForm.profileId = profileId;

    if (profileId === newProfileId) {
      Object.assign(connectionForm, defaultConnectionForm());
      return;
    }

    const profile = profiles.value.find((item) => item.id === profileId);
    if (!profile) {
      return;
    }

    Object.assign(connectionForm, await profileToForm(profile));
  }

  async function openConnectionDialog(profileId: string) {
    lastError.value = "";
    await loadProfile(profileId);
    connectionDialogOpen.value = true;
  }

  function closeConnectionDialog() {
    connectionDialogOpen.value = false;
    connectionCloseConfirmOpen.value = false;
    lastError.value = "";
    profileValidationDialogOpen.value = false;
    profileValidationError.value = "";
  }

  async function persistConnection(): Promise<string> {
    const { baseUrl, apiKey } = formConnectionSettings();
    const name = connectionForm.profileName.trim() || baseUrl;
    const existingProfile =
      connectionForm.profileId === newProfileId
        ? null
        : profiles.value.find((profile) => profile.id === connectionForm.profileId);

    const apiKeySecret = await masterPassword.encryptApiKey(apiKey);
    const scope = profileScopeFromForm();

    const profile: ConnectionProfile = {
      id: existingProfile?.id ?? createProfileId(),
      name,
      baseUrl,
      apiKey: apiKeySecret,
      updatedAt: new Date().toISOString(),
      scope,
    };

    profiles.value = existingProfile
      ? profiles.value.map((item) => (item.id === existingProfile.id ? profile : item))
      : [...profiles.value, profile];
    connectionForm.profileId = profile.id;
    connectionForm.profileName = profile.name;
    profileStorage.saveProfile(profile, scope);
    reloadProfiles();
    // Persist is always followed by closing the connection dialog — owning the
    // close here keeps both success paths (addProfile + force-save after
    // validation failure) symmetric.
    closeConnectionDialog();

    return profile.id;
  }

  async function addProfile() {
    let nextSettings: ConnectionSettings;
    try {
      nextSettings = formConnectionSettings();
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : String(error);
      return;
    }
    const myGen = ++generation;
    phase.value = { kind: "adding" };
    lastError.value = "";

    try {
      await fetchSnapshot(createClient(nextSettings));
      if (myGen !== generation) return;
      await persistConnection();
    } catch (error) {
      // Surface the failure locally regardless of generation — the validation
      // dialog is per-attempt and writing it back never overrides committed state.
      profileValidationError.value = error instanceof Error ? error.message : String(error);
      profileValidationDialogOpen.value = true;
    } finally {
      if (myGen === generation) phase.value = { kind: "idle" };
    }
  }

  async function editProfile(profile: ConnectionProfile) {
    await openConnectionDialog(profile.id);
  }

  function deleteProfile(profile: ConnectionProfile) {
    pendingDeleteProfile.value = profile;
  }

  function confirmDeleteProfile() {
    const profileId = pendingDeleteProfile.value?.id;
    pendingDeleteProfile.value = null;
    if (!profileId || profileId === newProfileId) {
      return;
    }

    profiles.value = profiles.value.filter((profile) => profile.id !== profileId);
    profileStorage.deleteProfile(profileId);
    reloadProfiles();

    if (connectionForm.profileId === profileId) {
      void loadProfile(profiles.value[0]?.id ?? newProfileId);
    }
  }

  async function authorizeProfile(
    profile: ConnectionProfile,
    mode: "authenticating" | "restoring",
  ): Promise<boolean> {
    Object.assign(connectionForm, await profileToForm(profile));
    if (profile.corrupted) {
      lastError.value = t("encryptionProfileCorrupted");
      return false;
    }
    let plainApiKey = "";
    try {
      plainApiKey = await masterPassword.decryptApiKey(profile.apiKey);
    } catch (err) {
      console.error("[headscale-ui] decrypt failed during authorize; marking corrupted", err);
      profileStorage.markCorrupted(profile.id);
      reloadProfiles();
      lastError.value = t("encryptionProfileCorrupted");
      return false;
    }

    const startedAt = performance.now();
    const nextSettings: ConnectionSettings = {
      baseUrl: profile.baseUrl,
      apiKey: plainApiKey,
    };

    const myGen = ++generation;
    phase.value = { kind: mode, profileId: profile.id };
    lastError.value = "";

    let succeeded = false;
    try {
      const nextSnapshot = await fetchSnapshot(createClient(nextSettings));
      if (myGen !== generation) return false;
      setSettings(nextSettings);
      onAuthenticated?.(nextSnapshot);
      profileStorage.setActiveProfile(
        profile.id,
        profileStorage.getProfileScope(profile.id) ?? "session",
      );
      succeeded = true;
    } catch (error) {
      // Always surface the local error; clearActiveProfile is guarded so a
      // superseded flow doesn't clobber state owned by the newer flow.
      lastError.value = error instanceof Error ? error.message : String(error);
      if (myGen === generation) profileStorage.clearActiveProfile();
    } finally {
      const remainingMs = profileLoginMinimumMs - (performance.now() - startedAt);
      if (remainingMs > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, remainingMs));
      }
      if (myGen === generation) phase.value = { kind: "idle" };
    }
    return succeeded;
  }

  async function enterProfile(
    profile: ConnectionProfile,
    mode: "authenticating" | "restoring" = "authenticating",
  ): Promise<boolean> {
    connectionDialogOpen.value = false;
    return await authorizeProfile(profile, mode);
  }

  function logout() {
    // Bump generation so any in-flight authorize promise cannot resurrect the
    // active-profile state after we've cleared it.
    ++generation;
    phase.value = { kind: "idle" };
    profileStorage.clearActiveProfile();
    connectionDialogOpen.value = false;
    lastError.value = "";
    Object.assign(connectionForm, {
      ...defaultConnectionForm(),
      profileId: connectionForm.profileId,
      profileName: connectionForm.profileName,
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      remember: false,
    });
    onLogout?.();
  }

  instance = {
    profiles,
    connectionForm,
    phase,
    isConnecting,
    isRestoringSession,
    authenticatingProfileId,
    selectedProfile,
    currentProfileLabel,
    connectionDialogOpen,
    connectionCloseConfirmOpen,
    profileValidationDialogOpen,
    profileValidationError,
    pendingDeleteProfile,
    loadProfile,
    openConnectionDialog,
    closeConnectionDialog,
    addProfile,
    persistConnection,
    editProfile,
    deleteProfile,
    confirmDeleteProfile,
    enterProfile,
    logout,
    setOnAuthenticated(hook: AuthenticatedHook | null) {
      onAuthenticated = hook;
    },
    setOnLogout(hook: LogoutHook | null) {
      onLogout = hook;
    },
  };
  return instance;
}
