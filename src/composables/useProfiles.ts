import { connectionSettingsError } from "@/api/connection";
import { t } from "@/i18n";
import type {
  ProfileList,
  ProfileSummary,
  ProfileWriteExpected,
  StoredProfileCommit,
  VaultVersion,
} from "@/lib/profile-storage";
import { clearSessionMetadata } from "@/lib/secure-storage";
import { createStore } from "@/lib/store";
import type { SessionBridge } from "@/session/bridge";
import type { ProfileSaveInput } from "@/session/profile-actions";
import type { SessionIdentity } from "@/session/types";
import { ApiError } from "@/session/types";
import { storageErrorMessage } from "@/utils/storage-error";
import { normalizedBaseUrl } from "@/utils/strings";
import { useSession, useStore } from "./session-context";
import type { createActionFeedbackStore } from "./useActionFeedback";

export const newProfileId = "__new__";
/** Stored instead of localized text so consumers can recognize this result after a locale change. */
export const SAVED_LOCKED_ERROR = "session-saved-locked";
export { MIN_PROFILE_PASSWORD_LENGTH } from "@/lib/api-key-crypto";
export interface ConnectionForm {
  profileId: string;
  profileName: string;
  baseUrl: string;
  apiKey: string;
  password: string;
  passwordConfirmation: string;
  remember: boolean;
}
export type LoginPhase =
  | { kind: "idle" }
  | { kind: "adding" }
  | { kind: "authenticating"; profileId: string };
interface ProfilesState {
  profiles: ProfileSummary[];
  version: VaultVersion | null;
  unreadableRecords: number;
  connectionForm: ConnectionForm;
  phase: LoginPhase;
  connectionDialogOpen: boolean;
  connectionCloseConfirmOpen: boolean;
  pendingDeleteProfile: ProfileSummary | null;
  unlockProfile: ProfileSummary | null;
  /** Login notices: this tab changed the active password, or a lock ended unsaved Access edits. */
  passwordChanged: boolean;
  discardedPolicyDraft: boolean;
}
/** Presentation for one password-change attempt. It is not a business result or a retry. */
export type PasswordChangeFeedback =
  | { kind: "failed"; message: string; failureKind?: ApiError["kind"] }
  | { kind: "changed"; refreshError?: string };

export function defaultConnectionForm(): ConnectionForm {
  return {
    profileId: newProfileId,
    profileName: "",
    baseUrl: "",
    apiKey: "",
    password: "",
    passwordConfirmation: "",
    remember: true,
  };
}

export function normalizeConnectionForm(
  form: ConnectionForm,
  profile?: ProfileSummary,
) {
  const newPassword = !profile || profile.credentialKind === "unreadable";
  return {
    ...form,
    profileName: form.profileName.trim(),
    baseUrl: form.baseUrl.trim(),
    apiKey: form.apiKey.trim(),
    password: newPassword ? form.password.trim() : form.password,
    passwordConfirmation: form.passwordConfirmation.trim(),
  };
}

export function createProfilesStore(
  bridge: SessionBridge,
  feedback: ReturnType<typeof createActionFeedbackStore>,
  initial: ProfileList | null,
) {
  const store = createStore<ProfilesState>({
    profiles: initial?.profiles ?? [],
    version: initial?.version ?? null,
    unreadableRecords: initial?.unreadableRecords ?? 0,
    connectionForm: defaultConnectionForm(),
    phase: { kind: "idle" },
    connectionDialogOpen: false,
    connectionCloseConfirmOpen: false,
    pendingDeleteProfile: null,
    unlockProfile: null,
    passwordChanged: false,
    discardedPolicyDraft: false,
  });
  let formGeneration = 0;
  let submissionGeneration = 0;
  let reloadGeneration = 0;
  let draftId: string | null = null;
  // Background list refreshes must not rebase an existing form's write expectation.
  let draftExpected: ProfileWriteExpected | null = null;
  let draftIdentity: SessionIdentity | null =
    bridge.getSessionSnapshot()?.identity ?? null;
  let controller: AbortController | null = null;
  function setConnectionForm(patch: Partial<ConnectionForm>) {
    const current = store.getSnapshot().connectionForm;
    if (
      Object.entries(patch).every(
        ([key, value]) => current[key as keyof ConnectionForm] === value,
      )
    )
      return;
    if (
      !draftExpected ||
      (patch.profileId !== undefined && patch.profileId !== current.profileId)
    )
      captureDraftExpected(patch.profileId ?? current.profileId);
    ++formGeneration;
    store.setState({ connectionForm: { ...current, ...patch } });
  }
  function clearSecrets() {
    store.setState((state) => ({
      connectionForm: {
        ...state.connectionForm,
        apiKey: "",
        password: "",
        passwordConfirmation: "",
      },
    }));
  }
  function expected(
    profile: ProfileSummary | null,
    baseline: ProfileWriteExpected | null = null,
  ): ProfileWriteExpected {
    const version = store.getSnapshot().version;
    if (!version) throw new ApiError({ kind: "unavailable" });
    return (
      baseline ?? {
        version,
        ownerTabId: "",
        profile: profile
          ? { id: profile.id, credentialVersion: profile.credentialVersion }
          : null,
      }
    );
  }
  function captureDraftExpected(profileId: string) {
    const { profiles, version } = store.getSnapshot();
    draftExpected = version
      ? expected(profiles.find((profile) => profile.id === profileId) ?? null)
      : null;
  }
  async function reloadProfiles() {
    const ticket = ++reloadGeneration;
    const result = await bridge.listProfiles();
    if (ticket !== reloadGeneration) return;
    if (!result.ok) throw new ApiError(result.error);
    store.setState(result.value);
  }
  function adoptCommittedProfile(commit: StoredProfileCommit) {
    const current = store.getSnapshot();
    if (
      current.version?.keyEpoch !== commit.version.keyEpoch ||
      current.version.profilesRevision > commit.version.profilesRevision
    )
      return;
    store.setState({
      version: commit.version,
      profiles: [
        ...current.profiles.filter(
          (profile) => profile.id !== commit.profile.id,
        ),
        commit.profile,
      ],
    });
  }
  async function loadProfile(profileId: string) {
    ++formGeneration;
    draftId = null;
    draftIdentity = bridge.getSessionSnapshot()?.identity ?? null;
    captureDraftExpected(profileId);
    const profile = store
      .getSnapshot()
      .profiles.find((item) => item.id === profileId);
    store.setState({
      connectionForm: profile
        ? {
            profileId: profile.id,
            profileName: profile.name,
            baseUrl: profile.baseUrl,
            apiKey: "",
            password: "",
            passwordConfirmation: "",
            remember: profile.scope === "persistent",
          }
        : defaultConnectionForm(),
    });
  }
  async function openConnectionDialog(profileId: string) {
    const ticket = formGeneration + 1;
    await loadProfile(profileId);
    if (ticket !== formGeneration) return;
    feedback.setState({ lastError: "" });
    store.setState({ connectionDialogOpen: true });
  }
  function closeConnectionDialog() {
    ++formGeneration;
    ++submissionGeneration;
    controller?.abort();
    controller = null;
    draftExpected = null;
    clearSecrets();
    store.setState({
      connectionDialogOpen: false,
      connectionCloseConfirmOpen: false,
      unlockProfile: null,
      phase: { kind: "idle" },
    });
    feedback.setState({ lastError: "" });
  }
  async function save(
    validation: "required" | "skip",
    activate: boolean,
  ): Promise<string> {
    if (store.getSnapshot().phase.kind !== "idle")
      throw new ApiError({ kind: "busy" });
    const profile =
      store
        .getSnapshot()
        .profiles.find(
          (item) => item.id === store.getSnapshot().connectionForm.profileId,
        ) ?? null;
    const form = normalizeConnectionForm(
      store.getSnapshot().connectionForm,
      profile ?? undefined,
    );
    const formTicket = formGeneration;
    const ticket = ++submissionGeneration;
    const scope = form.remember ? "persistent" : "session";
    // An unreadable row keeps nothing worth renaming: it can only be replaced with new credentials.
    const metadataOnly =
      !!profile &&
      profile.credentialKind !== "unreadable" &&
      normalizedBaseUrl(form.baseUrl) === profile.baseUrl &&
      !form.apiKey;
    if (validation === "skip" && (!form.apiKey.trim() || !form.password))
      throw new Error(t("sessionSecretRequired"));
    if (!metadataOnly && profile?.credentialKind.startsWith("legacy-"))
      throw new Error(t("legacyProfileMigrateFirst"));
    let input: ProfileSaveInput;
    if (metadataOnly)
      input = {
        kind: "metadata",
        expected: expected(profile, draftExpected),
        name: form.profileName,
        scope,
      };
    else {
      const error = connectionSettingsError(form);
      if (error) throw new Error(t(error));
      if (!form.password) throw new Error(t("serverPasswordRequired"));
      if (!profile) draftId ??= crypto.randomUUID();
      input = {
        kind: "credentials",
        expected: expected(profile, draftExpected),
        profile: {
          id: profile?.id ?? (draftId as string),
          name: form.profileName,
          baseUrl: form.baseUrl,
          scope,
        },
        apiKey: form.apiKey,
        password: form.password,
        validation,
        activate,
        expectedWorkerId: bridge.getSnapshot().workerId ?? "",
        expectedIdentity: draftIdentity,
      };
    }
    // Local failures above keep the typed secrets; they are cleared only once dispatched.
    clearSecrets();
    controller = new AbortController();
    const saving = bridge.saveProfile(input, { signal: controller.signal });
    form.apiKey = form.password = form.passwordConfirmation = "";
    if (input.kind === "credentials") input.apiKey = input.password = "";
    store.setState({ phase: { kind: "adding" } });
    feedback.setState({ lastError: "" });
    try {
      const result = await saving;
      if (!result.ok) throw new ApiError(result.error);
      // Superseding aborts the request, so an ok reply is always for a commit that is now stored.
      adoptCommittedProfile(result.value.commit);
      await reloadProfiles().catch((error: unknown) => {
        if (ticket === submissionGeneration && formTicket === formGeneration)
          feedback.setState({ lastError: storageErrorMessage(error) });
      });
      if (ticket === submissionGeneration && formTicket === formGeneration) {
        draftId = null;
        draftExpected = null;
        store.setState((state) => ({
          connectionForm: {
            ...state.connectionForm,
            profileId: result.value.commit.profile.id,
            profileName: result.value.commit.profile.name,
          },
          connectionDialogOpen: false,
          connectionCloseConfirmOpen: false,
        }));
        if (result.value.activation && !result.value.activation.ok)
          feedback.setState({ lastError: SAVED_LOCKED_ERROR });
      }
      return result.value.commit.profile.id;
    } catch (error) {
      if (
        ticket === submissionGeneration &&
        error instanceof ApiError &&
        error.kind === "storage-conflict"
      ) {
        // Keep the write failure if refreshing its recovery metadata also fails.
        await reloadProfiles().catch(() => undefined);
        if (ticket === submissionGeneration && formTicket === formGeneration)
          captureDraftExpected(store.getSnapshot().connectionForm.profileId);
      }
      if (ticket === submissionGeneration && formTicket === formGeneration)
        feedback.setState({ lastError: storageErrorMessage(error) });
      throw error;
    } finally {
      if (ticket === submissionGeneration) {
        controller = null;
        store.setState({ phase: { kind: "idle" } });
      }
    }
  }
  async function enterProfile(
    profile: ProfileSummary,
    password?: string,
  ): Promise<boolean> {
    if (password === undefined) {
      feedback.setState({ lastError: "" });
      store.setState({ unlockProfile: profile });
      return false;
    }
    if (store.getSnapshot().phase.kind !== "idle") return false;
    const ticket = ++submissionGeneration;
    controller = new AbortController();
    store.setState({
      phase: { kind: "authenticating", profileId: profile.id },
    });
    feedback.setState({ lastError: "" });
    const unlocking = bridge.unlock(
      {
        profileId: profile.id,
        password,
        expectedWorkerId: bridge.getSnapshot().workerId ?? "",
        expectedIdentity: bridge.getSessionSnapshot()?.identity ?? null,
        expectedCredentialVersion: profile.credentialVersion ?? "",
      },
      { signal: controller.signal },
    );
    password = "";
    try {
      const result = await unlocking;
      if (ticket !== submissionGeneration) return false;
      if (!result.ok) throw new ApiError(result.error);
      const current = bridge.getSessionSnapshot()?.identity;
      if (
        current?.workerId !== result.value.identity?.workerId ||
        current?.sessionId !== result.value.identity?.sessionId
      )
        return false;
      store.setState({ unlockProfile: null });
      return true;
    } catch (error) {
      // bridge.unlock never rejects, so only the synchronous steps after the ticket check can throw.
      feedback.setState({ lastError: storageErrorMessage(error) });
      return false;
    } finally {
      if (ticket === submissionGeneration) {
        controller = null;
        store.setState({ phase: { kind: "idle" } });
      }
    }
  }
  async function migrateAndEnterProfile(
    profile: ProfileSummary,
    password: string,
    legacyPassword?: string,
  ) {
    if (store.getSnapshot().phase.kind !== "idle") return false;
    const ticket = ++submissionGeneration;
    const initialIdentity = bridge.getSessionSnapshot()?.identity;
    controller = new AbortController();
    store.setState({
      phase: { kind: "authenticating", profileId: profile.id },
    });
    feedback.setState({ lastError: "" });
    let committed = false;
    try {
      const migrating = bridge.migrateProfile(
        { expected: expected(profile), password, legacyPassword },
        { signal: controller.signal },
      );
      legacyPassword = "";
      const migrated = await migrating;
      if (ticket !== submissionGeneration) return false;
      if (!migrated.ok) throw new ApiError(migrated.error);
      committed = true;
      adoptCommittedProfile(migrated.value);
      // The open dialog now holds a password credential, so a failed unlock retries as an unlock.
      store.setState((state) =>
        state.unlockProfile?.id === profile.id
          ? { unlockProfile: migrated.value.profile }
          : {},
      );
      await reloadProfiles();
      if (ticket !== submissionGeneration) return false;
      const current = bridge.getSessionSnapshot()?.identity;
      if (
        initialIdentity?.workerId !== current?.workerId ||
        initialIdentity?.sessionId !== current?.sessionId
      ) {
        feedback.setState({ lastError: SAVED_LOCKED_ERROR });
        return false;
      }
      store.setState({ phase: { kind: "idle" } });
      const entering = enterProfile(migrated.value.profile, password);
      password = "";
      return await entering;
    } catch (error) {
      if (ticket === submissionGeneration)
        feedback.setState({
          lastError: committed
            ? SAVED_LOCKED_ERROR
            : storageErrorMessage(error),
        });
      return false;
    } finally {
      password = legacyPassword = "";
      if (ticket === submissionGeneration) {
        controller = null;
        store.setState({ phase: { kind: "idle" } });
      }
    }
  }
  function resetProjection(version: VaultVersion) {
    ++formGeneration;
    ++submissionGeneration;
    ++reloadGeneration;
    controller?.abort();
    controller = null;
    draftId = null;
    draftExpected = null;
    draftIdentity = null;
    store.setState({
      profiles: [],
      version,
      unreadableRecords: 0,
      connectionForm: defaultConnectionForm(),
      phase: { kind: "idle" },
      connectionDialogOpen: false,
      connectionCloseConfirmOpen: false,
      pendingDeleteProfile: null,
      unlockProfile: null,
      passwordChanged: false,
      discardedPolicyDraft: false,
    });
    feedback.setState({ lastError: "" });
  }
  return {
    ...store,
    setConnectionForm,
    loadProfile,
    openConnectionDialog,
    closeConnectionDialog,
    reloadProfiles,
    resetProjection,
    get connectionFormGeneration() {
      return formGeneration;
    },
    get authorizationGeneration() {
      return submissionGeneration;
    },
    get isConnecting() {
      return store.getSnapshot().phase.kind !== "idle";
    },
    get authenticatingProfileId() {
      const phase = store.getSnapshot().phase;
      return phase.kind === "authenticating" ? phase.profileId : null;
    },
    get selectedProfile() {
      return store
        .getSnapshot()
        .profiles.find(
          (profile) =>
            profile.id === store.getSnapshot().connectionForm.profileId,
        );
    },
    get currentProfileLabel() {
      return bridge.getSessionSnapshot()?.profile?.name || t("profile");
    },
    editProfile: (profile: ProfileSummary) => openConnectionDialog(profile.id),
    async addProfile(activate = false) {
      const formTicket = formGeneration;
      const ticket = submissionGeneration + 1;
      try {
        await save("required", activate);
      } catch (error) {
        if (ticket === submissionGeneration && formTicket === formGeneration)
          feedback.setState({ lastError: storageErrorMessage(error) });
      }
    },
    persistConnection: () => save("skip", false),
    enterProfile,
    migrateAndEnterProfile,
    closeUnlockDialog() {
      ++submissionGeneration;
      controller?.abort();
      controller = null;
      store.setState({ unlockProfile: null, phase: { kind: "idle" } });
      feedback.setState({ lastError: "" });
    },
    async changeProfilePassword(
      profile: ProfileSummary,
      password: string,
      newPassword: string,
      onFeedback?: (result: PasswordChangeFeedback) => boolean,
    ): Promise<boolean> {
      if (store.getSnapshot().phase.kind !== "idle") return false;
      const ticket = ++submissionGeneration;
      const formTicket = formGeneration;
      controller = new AbortController();
      store.setState({
        phase: { kind: "authenticating", profileId: profile.id },
      });
      feedback.setState({ lastError: "" });
      let outcome: PasswordChangeFeedback | null = null;
      const ownsAttempt = () =>
        ticket === submissionGeneration && formTicket === formGeneration;
      try {
        const changing = bridge.changeProfilePassword(
          { expected: expected(profile), password, newPassword },
          { signal: controller.signal },
        );
        password = newPassword = "";
        const result = await changing;
        if (ticket !== submissionGeneration) return false;
        if (!result.ok) throw new ApiError(result.error);
        adoptCommittedProfile(result.value);
        store.setState({ passwordChanged: true });
        let refreshError: string | undefined;
        await reloadProfiles().catch((error: unknown) => {
          if (ownsAttempt()) refreshError = storageErrorMessage(error);
        });
        if (ownsAttempt())
          outcome =
            refreshError === undefined
              ? { kind: "changed" }
              : { kind: "changed", refreshError };
        return true;
      } catch (error) {
        if (
          ticket === submissionGeneration &&
          error instanceof ApiError &&
          error.kind === "storage-conflict"
        )
          await reloadProfiles().catch(() => undefined);
        if (ownsAttempt()) {
          const message = storageErrorMessage(error);
          outcome =
            error instanceof ApiError
              ? { kind: "failed", message, failureKind: error.kind }
              : { kind: "failed", message };
        }
        return false;
      } finally {
        password = newPassword = "";
        if (ticket === submissionGeneration) {
          controller = null;
          store.setState({ phase: { kind: "idle" } });
        }
        // Cleanup and idle subscribers can retire this attempt before presentation.
        if (outcome && ownsAttempt()) {
          let consumed = false;
          if (onFeedback) {
            try {
              consumed = onFeedback(outcome) === true;
            } catch {
              consumed = false;
            }
          }
          if (!consumed && ownsAttempt()) {
            const message =
              outcome.kind === "failed"
                ? outcome.message
                : outcome.refreshError;
            if (message) feedback.setState({ lastError: message });
          }
        }
      }
    },
    deleteProfile(profile: ProfileSummary) {
      store.setState({ pendingDeleteProfile: profile });
    },
    async confirmDeleteProfile() {
      const profile = store.getSnapshot().pendingDeleteProfile;
      if (!profile || store.getSnapshot().phase.kind !== "idle") return;
      const ticket = ++submissionGeneration;
      const formTicket = formGeneration;
      controller = new AbortController();
      store.setState({ phase: { kind: "adding" } });
      feedback.setState({ lastError: "" });
      try {
        const result = await bridge.deleteProfile(expected(profile), {
          signal: controller.signal,
        });
        if (ticket !== submissionGeneration) return;
        if (!result.ok) throw new ApiError(result.error);
        const current = store.getSnapshot();
        if (
          current.version?.keyEpoch === result.value.version.keyEpoch &&
          current.version.profilesRevision <=
            result.value.version.profilesRevision
        )
          store.setState({
            version: result.value.version,
            profiles: current.profiles.filter((item) => item.id !== profile.id),
          });
        await reloadProfiles().catch((error: unknown) => {
          if (
            ticket === submissionGeneration &&
            store.getSnapshot().pendingDeleteProfile === profile
          )
            feedback.setState({ lastError: storageErrorMessage(error) });
        });
        if (ticket !== submissionGeneration) return;
        if (store.getSnapshot().pendingDeleteProfile === profile)
          store.setState({ pendingDeleteProfile: null });
        if (
          formTicket === formGeneration &&
          store.getSnapshot().connectionForm.profileId === profile.id
        )
          await loadProfile(newProfileId);
      } catch (error) {
        if (
          ticket === submissionGeneration &&
          error instanceof ApiError &&
          error.kind === "storage-conflict"
        )
          await reloadProfiles().catch(() => undefined);
        if (
          ticket === submissionGeneration &&
          store.getSnapshot().pendingDeleteProfile === profile
        )
          feedback.setState({ lastError: storageErrorMessage(error) });
      } finally {
        if (ticket === submissionGeneration) {
          controller = null;
          store.setState({ phase: { kind: "idle" } });
        }
      }
    },
    async logout() {
      closeConnectionDialog();
      const ticket = submissionGeneration;
      const formTicket = formGeneration;
      const result = await bridge.lock(
        bridge.getSessionSnapshot()?.identity ?? null,
      );
      if (
        !result.ok &&
        ticket === submissionGeneration &&
        formTicket === formGeneration
      )
        feedback.setState({
          lastError: storageErrorMessage(new ApiError(result.error)),
        });
    },
    async resetLocalData() {
      const result = await bridge.resetStorage(expected(null).version);
      if (!result.ok) throw new ApiError(result.error);
      resetProjection(result.value.version);
      return {
        ...result.value,
        sessionMetadataCleared: clearSessionMetadata(),
      };
    },
    startVaultSync() {
      const stop = bridge.subscribeProfiles(() => {
        // Stopping bumps reloadGeneration, so a reload in flight then returns before it can throw.
        void reloadProfiles().catch((error: unknown) =>
          feedback.setState({ lastError: storageErrorMessage(error) }),
        );
      });
      return () => {
        ++reloadGeneration;
        stop();
      };
    },
  };
}
export function useProfiles() {
  return useStore(useSession().profiles);
}
