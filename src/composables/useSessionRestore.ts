import { watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { profileStorage as storage } from "@/lib/profile-storage";
import { mapErrorToCopy } from "@/utils/error-mapping";
import { useActionFeedback } from "./useActionFeedback";
import { usePolicyDesigner } from "./usePolicyDesigner";
import { useProductCopy } from "./useProductCopy";
import { useProfiles } from "./useProfiles";
import { useRouteIntent } from "./useRouteIntent";
import { useSnapshot } from "./useSnapshot";

/**
 * Cross-cutting bootstrap that turns `App.vue` into a one-liner.
 *
 * Responsibilities, all wired in setup-time order:
 *   1. Plug the i18n-aware error mapper into `useActionFeedback`.
 *   2. Mirror snapshot writes into the policy designer draft.
 *   3. Bridge `useProfiles` auth lifecycle to `useSnapshot` + router.
 *   4. Refresh the snapshot on every authenticated route change.
 *   5. Restore the active profile on cold start (or redirect to /login).
 *
 * Call exactly once from `App.vue`'s `<script setup>`.
 */
export function useSessionRestore(): void {
  const router = useRouter();
  const route = useRoute();
  const intent = useRouteIntent();
  const snap = useSnapshot();
  const profilesApi = useProfiles();
  const policy = usePolicyDesigner();
  const feedback = useActionFeedback();
  const { copy } = useProductCopy();

  const redirectToLogin = () => router.replace({ name: "login" });

  // (1) i18n-aware error translation
  feedback.setErrorMapper((error) => mapErrorToCopy(error, copy.value));

  // (2) snapshot → policy designer mirror
  snap.setOnApplySnapshot((next, patch) => {
    if ("policy" in patch && !policy.isPolicyDirty.value && !policy.isPolicyEditing.value) {
      policy.load(next.policy?.policy ?? "");
    }
  });
  watch(policy.policyDraft, snap.invalidatePolicyRefreshes, { flush: "sync" });

  // (3) profiles → snapshot/router bridge
  profilesApi.setOnAuthenticated((snapshot) => {
    policy.load(snapshot.policy?.policy ?? "");
    snap.applySnapshot(snapshot);
    snap.isAuthorized.value = true;
    profilesApi.isRestoringSession.value = false;
  });
  profilesApi.setOnLogout(() => {
    snap.isAuthorized.value = false;
    policy.load("");
    snap.applyOfflineHealth();
    void router.push({ name: "login" });
  });

  // (4) refresh on every authenticated route change so per-section data is fresh
  watch(
    () => route.name,
    (next, prev) => {
      if (next && next !== prev && route.meta.requiresAuth && snap.isAuthorized.value) {
        void snap.refreshSnapshot();
      }
    },
  );

  // (5) cold-start active-profile restoration
  async function restoreActiveProfile() {
    // Wait for the first navigation (and its guards) to settle so we don't race the
    // auth guard's clearActiveProfile path on unknown-profile redirects.
    await router.isReady();
    if (snap.isAuthorized.value) return;
    const requestedFromUrl = intent.profileId.value;
    const activeId = requestedFromUrl ?? storage.readActiveProfile();
    if (!activeId) {
      profilesApi.isRestoringSession.value = false;
      return;
    }
    const profile = profilesApi.profiles.value.find((p) => p.id === activeId);
    if (!profile) {
      profilesApi.isRestoringSession.value = false;
      if (route.meta.requiresAuth || requestedFromUrl) await redirectToLogin();
      return;
    }
    profilesApi.isRestoringSession.value = true;
    const ok = await profilesApi.enterProfile(profile, "restoring");
    profilesApi.isRestoringSession.value = false;
    if (!ok && route.meta.requiresAuth) await redirectToLogin();
  }
  void restoreActiveProfile();
}
