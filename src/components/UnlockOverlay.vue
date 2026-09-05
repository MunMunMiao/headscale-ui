<script setup lang="ts">
import { LockKeyhole } from "lucide-vue-next";
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import HeadscaleLogo from "@/components/HeadscaleLogo.vue";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMasterPassword } from "@/composables/useMasterPassword";
import { useProfiles } from "@/composables/useProfiles";
import { useHeadscaleI18n } from "@/i18n";
import { clearAllSecureData } from "@/lib/secure-storage";

const router = useRouter();
const route = useRoute();
const mp = useMasterPassword();
const { profiles } = useProfiles();
const { t } = useHeadscaleI18n();

const passphrase = ref("");
const errorMessage = ref("");
const submitting = ref(false);
const clearing = ref(false);

async function submit() {
  if (!passphrase.value) return;
  submitting.value = true;
  errorMessage.value = "";
  try {
    const ok = await mp.unlock(passphrase.value);
    if (!ok) {
      errorMessage.value = t("encryptionUnlockFailed");
      passphrase.value = "";
      return;
    }
    const redirect = typeof route.query.redirect === "string" ? route.query.redirect : "/";
    await router.replace(redirect);
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err);
  } finally {
    submitting.value = false;
  }
}

async function clearAll() {
  clearing.value = true;
  try {
    await clearAllSecureData();
    // Full reload so bootstrap runs from a clean slate; the cleared query
    // suppresses the empty-state auto-dialog and shows a confirmation banner.
    window.location.assign(router.resolve({ name: "login", query: { cleared: "1" } }).href);
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err);
    clearing.value = false;
  }
}
</script>

<template>
  <div
    class="fixed inset-0 z-[60] flex items-center justify-center bg-background/95 px-4 py-8 backdrop-blur-sm dark:bg-background/90"
    data-testid="unlock-overlay"
  >
    <div class="w-full max-w-sm rounded-lg border bg-card p-6 shadow-sm">
      <div class="mb-4 flex items-center gap-2">
        <HeadscaleLogo class="h-7 w-7 shrink-0" />
        <span class="text-sm font-semibold">Headscale UI</span>
      </div>
      <div class="flex items-center gap-2">
        <LockKeyhole class="h-5 w-5 text-primary" />
        <h1 class="text-lg font-semibold leading-none">{{ t("encryptionUnlockTitle") }}</h1>
      </div>
      <p class="mt-3 text-sm text-muted-foreground">
        {{ t("encryptionUnlockDescription") }}
      </p>
      <p class="mt-2 text-xs text-muted-foreground">
        {{ t("encryptionLocalityNote") }}
      </p>
      <form class="mt-5 space-y-3" @submit.prevent="submit">
        <div class="space-y-1.5">
          <Label for="unlock-passphrase">{{ t("encryptionEnterPassphrase") }}</Label>
          <Input
            id="unlock-passphrase"
            v-model="passphrase"
            type="password"
            autocomplete="current-password"
            autofocus
            data-testid="unlock-passphrase"
            :disabled="submitting || clearing"
          />
        </div>
        <p
          v-if="errorMessage"
          class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
          data-testid="unlock-error"
        >
          {{ errorMessage }}
        </p>
        <Button
          type="submit"
          class="w-full"
          :disabled="submitting || clearing || !passphrase"
          data-testid="unlock-submit"
        >
          {{ t("encryptionUnlockSubmit") }}
        </Button>
      </form>
      <p class="mt-4 text-xs text-muted-foreground">
        {{ t("encryptionMultiTabNote") }}
      </p>
      <div class="mt-4 border-t pt-4">
        <p class="text-xs text-muted-foreground">{{ t("encryptionForgotten") }}</p>
        <AlertDialog>
          <AlertDialogTrigger as-child>
            <Button
              variant="link"
              class="mt-1 h-auto p-0 text-xs text-destructive"
              :disabled="clearing"
              data-testid="unlock-forgot"
            >
              {{ t("encryptionForgottenButton") }}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{{ t("forgotConfirmTitle") }}</AlertDialogTitle>
              <AlertDialogDescription>
                {{ t("forgotConfirmDescription", { count: profiles.length }) }}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="unlock-forgot-cancel">{{ t("cancel") }}</AlertDialogCancel>
              <AlertDialogAction
                class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                data-testid="unlock-forgot-confirm"
                @click="clearAll"
              >
                {{ t("encryptionForgottenButton") }}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  </div>
</template>
