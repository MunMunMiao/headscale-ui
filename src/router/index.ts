import { createRouter, createWebHistory, type RouteRecordRaw, type Router } from "vue-router";
import { useMasterPassword } from "@/composables/useMasterPassword";
import { profileStorage as storage } from "@/lib/profile-storage";

export const routes: RouteRecordRaw[] = [
  {
    path: "/unlock",
    name: "unlock",
    component: () => import("@/components/UnlockOverlay.vue"),
    meta: { requiresAuth: false },
  },
  {
    path: "/login",
    name: "login",
    component: () => import("@/pages/LoginPage.vue"),
    meta: { requiresAuth: false },
  },
  {
    path: "/",
    component: () => import("@/pages/AppLayout.vue"),
    meta: { requiresAuth: true },
    children: [
      { path: "", redirect: { name: "home" } },
      { path: "home", name: "home", component: () => import("@/pages/HomePage.vue") },
      { path: "devices", name: "devices", component: () => import("@/pages/DevicesPage.vue") },
      { path: "members", name: "members", component: () => import("@/pages/MembersPage.vue") },
      { path: "invites", name: "invites", component: () => import("@/pages/InvitesPage.vue") },
      { path: "routes", name: "routes", component: () => import("@/pages/RoutesPage.vue") },
      { path: "access", name: "access", component: () => import("@/pages/AccessPage.vue") },
    ],
  },
  {
    path: "/:profileId/:group(home|devices|members|invites|routes|access)?",
    redirect: (to) => ({
      path: `/${to.params.group || "home"}`,
      query: { profile: to.params.profileId as string },
    }),
  },
  { path: "/:pathMatch(.*)*", redirect: "/login" },
];

export function installAuthGuard(target: Router) {
  target.beforeEach((to) => {
    // Passphrase gate runs ahead of auth — a locked vault means no profile can decrypt.
    const mp = useMasterPassword();
    if (mp.needsUnlock.value && to.name !== "unlock") {
      return {
        name: "unlock",
        query: { redirect: to.fullPath },
      };
    }
    if (to.name === "unlock" && !mp.needsUnlock.value) {
      const redirect = typeof to.query.redirect === "string" ? to.query.redirect : "/";
      return redirect;
    }

    if (to.meta.requiresAuth === false) return true;

    const hasSession = storage.readActiveProfile() !== null && storage.hasAnyProfile();
    if (!hasSession) {
      return {
        name: "login",
        query: to.query.profile ? { profile: to.query.profile as string } : undefined,
      };
    }

    const requestedProfile = typeof to.query.profile === "string" ? to.query.profile : null;
    if (requestedProfile && !storage.hasProfile(requestedProfile)) {
      storage.clearActiveProfile();
      return { name: "login", query: { profile: requestedProfile } };
    }

    return true;
  });
}

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
});

installAuthGuard(router);
