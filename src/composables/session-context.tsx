import { createContext, useContext, useSyncExternalStore } from "react";
import type { BootstrapState } from "@/bootstrap";
import { applyStoredLocale } from "@/i18n";
import { clearSessionMetadata } from "@/lib/secure-storage";
import { clearSettingsProjection } from "@/lib/settings-storage";
import { attachSessionActivity } from "@/session/activity";
import { getErrorMessage } from "@/utils/error-mapping";
import { createSessionDrafts } from "./session-drafts";
import { createTagLifecycleStore } from "./tag-lifecycle-state";
import { createActionFeedbackStore } from "./useActionFeedback";
import { createDeviceSetupStore } from "./useDeviceSetup";
import { createHeadscaleClientStore } from "./useHeadscaleClient";
import { createPolicyDesignerStore } from "./usePolicyDesigner";
import { createProfilesStore } from "./useProfiles";
import { createSnapshotStore } from "./useSnapshot";
import { createThemeStore } from "./useTheme";

export function createSession(initialState: BootstrapState) {
  const feedback = createActionFeedbackStore();
  const auth = initialState.bridge;
  const client = createHeadscaleClientStore();
  const snapshot = createSnapshotStore(auth, client, feedback);
  const profiles = createProfilesStore(auth, feedback, initialState.profiles);
  const policy = createPolicyDesignerStore();
  const deviceSetup = createDeviceSetupStore();
  const theme = createThemeStore();
  const drafts = createSessionDrafts();
  const tagLifecycle = createTagLifecycleStore();
  const emptyDeviceSetup = deviceSetup.getSnapshot();

  // A server policy that arrived while Access had unsaved work is applied once that work ends.
  let withheld = false;
  function syncServerPolicy() {
    if (!drafts.isCurrent()) return;
    const server = snapshot.getSnapshot().snapshot.policy?.policy ?? "";
    if (server === policy.getSnapshot().policyDraft) {
      withheld = false;
      return;
    }
    withheld =
      policy.isPolicyDirty || policy.isPolicyEditing || policy.isPolicySaving;
    if (!withheld) policy.load(server);
  }
  snapshot.setOnApplySnapshot((next, patch) => {
    // Runs on every policy patch, ahead of the draft-load guard: "" === "" skips the load.
    if ("policy" in patch) {
      policy.setFileModeWithoutPath(next.policy?.fileModeWithoutPath === true);
      syncServerPolicy();
    }
  });
  let previousDraft = policy.getSnapshot().policyDraft;
  policy.subscribe(() => {
    const draft = policy.getSnapshot().policyDraft;
    if (draft !== previousDraft) {
      previousDraft = draft;
      snapshot.invalidatePolicyRefreshes();
    }
    if (withheld) syncServerPolicy();
  });
  // One-time business secrets never survive a session boundary, even when the drafts do.
  function clearGeneratedCredentials() {
    deviceSetup.setState({
      lastCreatedInvite: "",
      lastRegisteredNode: null,
      pendingRegistrationForm: {
        ...deviceSetup.getSnapshot().pendingRegistrationForm,
        key: "",
      },
      lastAuthDecision: null,
    });
  }
  let projectedProfile = auth.getSessionSnapshot()?.profile ?? null;
  function syncTagLifecycleScope() {
    const current = auth.getSessionSnapshot();
    const identity = client.getSnapshot().identity;
    const view = snapshot.getSnapshot();
    tagLifecycle.bind(
      current?.status === "unlocked" &&
        identity &&
        view.isAuthorized &&
        drafts.isCurrent() &&
        identity.workerId === current.identity.workerId &&
        identity.sessionId === current.identity.sessionId
        ? {
            profileId: current.profile.id,
            baseUrl: current.profile.baseUrl,
            ...identity,
            viewEpoch: drafts.getSnapshot().viewEpoch,
            version: view.snapshot.version?.version ?? null,
            versionFresh: view.versionFresh,
          }
        : null,
    );
  }
  client.subscribe(syncTagLifecycleScope);
  snapshot.subscribe(syncTagLifecycleScope);
  drafts.subscribe(syncTagLifecycleScope);
  // The URL still belongs to this server through a lock or a held draft. Auth can move first.
  let navigationProfile = projectedProfile;
  function adopt(refresh: boolean) {
    const current = auth.getSessionSnapshot();
    const previous = client.getSnapshot().identity;
    const next = current?.status === "unlocked" ? current.identity : null;
    const previousProfile = projectedProfile;
    projectedProfile = current?.profile ?? null;
    navigationProfile ??= projectedProfile;
    if (
      previous?.workerId === next?.workerId &&
      previous?.sessionId === next?.sessionId
    )
      return;
    // Re-unlocking the same server (same id and address) keeps pages, data and drafts mounted.
    if (
      previous &&
      next &&
      previousProfile &&
      current?.profile &&
      previousProfile.id === current.profile.id &&
      previousProfile.baseUrl === current.profile.baseUrl
    ) {
      snapshot.rebindSession();
      feedback.clearAllActionFeedback();
      client.adopt(current);
      clearGeneratedCredentials();
      if (refresh) void snapshot.refreshSnapshot();
      return;
    }
    // A switch must not load the previous server's text while policy.load("") notifies.
    withheld = false;
    const held = Boolean(
      previous &&
      next &&
      previousProfile &&
      drafts.hold(
        previousProfile,
        policy.isPolicyDirty || policy.isPolicyEditing,
      ),
    );
    snapshot.setAuthorized(false);
    if (current) client.adopt(current);
    else client.clear();
    if (held) {
      clearGeneratedCredentials();
    } else {
      // The login page tells the user before anything continues past this lock.
      if (!next && policy.isPolicyDirty)
        profiles.setState({ discardedPolicyDraft: true });
      policy.load("");
      deviceSetup.setState(emptyDeviceSetup);
      if (!next) drafts.discard();
    }
    snapshot.resetSnapshot();
    snapshot.setAuthorized(next !== null);
    if (next && refresh) void snapshot.refreshSnapshot();
  }
  adopt(false);
  return {
    feedback,
    client,
    auth,
    snapshot,
    profiles,
    policy,
    deviceSetup,
    theme,
    drafts,
    tagLifecycle,
    get navigationProfile() {
      return navigationProfile;
    },
    acceptNavigationProfile() {
      navigationProfile = projectedProfile;
    },
    discardDrafts() {
      policy.load(snapshot.getSnapshot().snapshot.policy?.policy ?? "");
      deviceSetup.setState(emptyDeviceSetup);
      drafts.discard();
      // 清理旧策略会取消新会话的在途读取；未就绪时立即补读。
      if (!snapshot.getSnapshot().isReady) void snapshot.refreshSnapshot();
    },
    start() {
      let active = true;
      let resetGeneration = 0;
      const stopAuth = auth.subscribe(() => adopt(true));
      const stopProfiles = profiles.startVaultSync();
      const stopPreferences = theme.startPreferenceSync();
      const stopReset = auth.subscribeReset((version) => {
        const request = ++resetGeneration;
        profiles.resetProjection(version);
        clearSessionMetadata();
        clearSettingsProjection(version.keyEpoch);
        theme.refreshFromSettings();
        void applyStoredLocale();
        // Finish the initiating reset's continuation before choosing a fresh tab owner.
        void Promise.resolve()
          .then(async () => {
            if (!active || request !== resetGeneration) return;
            const connected = await auth.reconnect();
            if (!active || request !== resetGeneration || !connected.ok) return;
            await profiles.reloadProfiles();
          })
          .catch((error: unknown) => {
            if (active && request === resetGeneration)
              feedback.setState({ lastError: getErrorMessage(error) });
          });
      });
      const stopActivity =
        typeof window !== "undefined" && typeof document !== "undefined"
          ? attachSessionActivity({ window, document, now: Date.now }, auth)
          : () => {};
      adopt(false);
      if (snapshot.getSnapshot().isAuthorized) void snapshot.refreshSnapshot();
      return () => {
        active = false;
        stopAuth();
        stopProfiles();
        stopPreferences();
        stopReset();
        stopActivity();
      };
    },
  };
}

export type Session = ReturnType<typeof createSession>;
export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("Application state requires AppProviders");
  return session;
}

type ObservableStore = {
  getSnapshot(): object;
  subscribe(listener: () => void): () => void;
};

export function useStore<Model extends ObservableStore>(store: Model) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  return { ...state, ...store } as ReturnType<Model["getSnapshot"]> & Model;
}
