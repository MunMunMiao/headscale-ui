<script setup lang="ts">
import { AlertCircle, Lock, ShieldCheck, Unlock } from "lucide-vue-next";
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMasterPassword } from "@/composables/useMasterPassword";
import { useHeadscaleI18n } from "@/i18n";
import { clearAllSecureData } from "@/lib/secure-storage";

const mp = useMasterPassword();
const router = useRouter();
const { t } = useHeadscaleI18n();

type Mode = "idle" | "enable" | "change" | "disable";
const mode = ref<Mode>("idle");

const acknowledged = ref(false);
const currentPassphrase = ref("");
const newPassphrase = ref("");
const confirmPassphrase = ref("");
const errorMessage = ref("");
const submitting = ref(false);
const clearing = ref(false);

const showEnableForm = computed(() => mode.value === "enable");
const showChangeForm = computed(() => mode.value === "change");
const showDisableForm = computed(() => mode.value === "disable");

function reset() {
  mode.value = "idle";
  acknowledged.value = false;
  currentPassphrase.value = "";
  newPassphrase.value = "";
  confirmPassphrase.value = "";
  errorMessage.value = "";
}

async function enable() {
  if (!acknowledged.value) {
    errorMessage.value = t("encryptionSetupWarningConfirm");
    return;
  }
  if (newPassphrase.value.length < 1 || newPassphrase.value !== confirmPassphrase.value) {
    errorMessage.value = t("encryptionUnlockFailed");
    return;
  }
  submitting.value = true;
  errorMessage.value = "";
  try {
    await mp.enablePassword(newPassphrase.value);
    reset();
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err);
  } finally {
    submitting.value = false;
  }
}

async function changeIt() {
  if (newPassphrase.value !== confirmPassphrase.value) {
    errorMessage.value = t("encryptionUnlockFailed");
    return;
  }
  submitting.value = true;
  errorMessage.value = "";
  try {
    await mp.changePassword(currentPassphrase.value, newPassphrase.value);
    reset();
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err);
  } finally {
    submitting.value = false;
  }
}

async function disableIt() {
  submitting.value = true;
  errorMessage.value = "";
  try {
    await mp.disablePassword(currentPassphrase.value);
    reset();
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
    window.location.assign(router.resolve({ name: "login" }).href);
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err);
    clearing.value = false;
  }
}
</script>

<template>
  <div class="grid gap-4">
    <div class="flex items-start gap-3 rounded-md border bg-card px-3 py-3">
      <component
        :is="mp.isPasswordEnabled.value ? Lock : ShieldCheck"
        class="mt-0.5 h-4 w-4 text-muted-foreground"
        aria-hidden="true"
      />
      <div class="flex-1 text-sm">
        <p class="font-medium text-foreground">
          {{
            mp.isPasswordEnabled.value
              ? t("encryptionEncryptedBadge")
              : t("encryptionStorageNote")
          }}
        </p>
        <p class="mt-0.5 text-xs text-muted-foreground">{{ t("encryptionEnableHint") }}</p>
      </div>
    </div>

    <div v-if="!mp.isPasswordEnabled.value && !showEnableForm" class="flex justify-end">
      <Button
        type="button"
        data-testid="security-enable-passphrase"
        @click="
          mode = 'enable';
          errorMessage = '';
        "
      >
        <Lock class="h-4 w-4" aria-hidden="true" />
        {{ t("encryptionEnableLabel") }}
      </Button>
    </div>

    <div
      v-if="mp.isPasswordEnabled.value && mode === 'idle'"
      class="flex flex-wrap items-center justify-end gap-2"
    >
      <Button
        type="button"
        variant="outline"
        data-testid="security-change-passphrase"
        @click="
          mode = 'change';
          errorMessage = '';
        "
      >
        {{ t("encryptionChangePassphrase") }}
      </Button>
      <Button
        type="button"
        variant="outline"
        data-testid="security-disable-passphrase"
        @click="
          mode = 'disable';
          errorMessage = '';
        "
      >
        <Unlock class="h-4 w-4" aria-hidden="true" />
        {{ t("encryptionDisable") }}
      </Button>
    </div>

    <form
      v-if="showEnableForm"
      class="grid gap-3 rounded-md border border-amber-200/60 bg-amber-50/60 p-3 dark:border-amber-900/60 dark:bg-amber-950/40"
      @submit.prevent="enable"
    >
      <p class="flex items-start gap-2 text-sm text-amber-900 dark:text-amber-300">
        <AlertCircle class="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
        <span>{{ t("encryptionSetupWarning") }}</span>
      </p>
      <Label class="flex items-start gap-2 text-xs text-amber-900 dark:text-amber-200">
        <Checkbox
          v-model="acknowledged"
          data-testid="security-acknowledge"
          class="mt-0.5"
        />
        <span>{{ t("encryptionSetupWarningConfirm") }}</span>
      </Label>
      <div class="space-y-1.5">
        <Label for="enc-new">{{ t("encryptionSetPassphrase") }}</Label>
        <Input
          id="enc-new"
          v-model="newPassphrase"
          type="password"
          autocomplete="new-password"
          data-testid="security-new-passphrase"
        />
      </div>
      <div class="space-y-1.5">
        <Label for="enc-confirm">{{ t("encryptionConfirmPassphrase") }}</Label>
        <Input
          id="enc-confirm"
          v-model="confirmPassphrase"
          type="password"
          autocomplete="new-password"
          data-testid="security-confirm-passphrase"
        />
      </div>
      <div class="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          data-testid="security-enable-cancel"
          :disabled="submitting"
          @click="reset"
        >
          {{ t("cancel") }}
        </Button>
        <Button
          type="submit"
          :disabled="submitting || !acknowledged || !newPassphrase || !confirmPassphrase"
          data-testid="security-enable-submit"
        >
          {{ t("encryptionSetPassphrase") }}
        </Button>
      </div>
    </form>

    <form
      v-if="showChangeForm"
      class="grid gap-3 rounded-md border bg-card p-3"
      @submit.prevent="changeIt"
    >
      <div class="space-y-1.5">
        <Label for="enc-current">{{ t("encryptionSetPassphrase") }} ({{ t("apiKey") }})</Label>
        <Input
          id="enc-current"
          v-model="currentPassphrase"
          type="password"
          autocomplete="current-password"
          data-testid="security-current-passphrase"
        />
      </div>
      <div class="space-y-1.5">
        <Label for="enc-new-c">{{ t("encryptionChangePassphrase") }}</Label>
        <Input
          id="enc-new-c"
          v-model="newPassphrase"
          type="password"
          autocomplete="new-password"
          data-testid="security-change-new-passphrase"
        />
      </div>
      <div class="space-y-1.5">
        <Label for="enc-confirm-c">{{ t("encryptionConfirmPassphrase") }}</Label>
        <Input
          id="enc-confirm-c"
          v-model="confirmPassphrase"
          type="password"
          autocomplete="new-password"
          data-testid="security-change-confirm-passphrase"
        />
      </div>
      <div class="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          data-testid="security-change-cancel"
          :disabled="submitting"
          @click="reset"
        >
          {{ t("cancel") }}
        </Button>
        <Button
          type="submit"
          :disabled="
            submitting || !currentPassphrase || !newPassphrase || !confirmPassphrase
          "
          data-testid="security-change-submit"
        >
          {{ t("encryptionChangePassphrase") }}
        </Button>
      </div>
    </form>

    <form
      v-if="showDisableForm"
      class="grid gap-3 rounded-md border bg-card p-3"
      @submit.prevent="disableIt"
    >
      <p class="text-sm text-muted-foreground">{{ t("encryptionDisableConfirm") }}</p>
      <div class="space-y-1.5">
        <Label for="enc-current-d">{{ t("encryptionSetPassphrase") }}</Label>
        <Input
          id="enc-current-d"
          v-model="currentPassphrase"
          type="password"
          autocomplete="current-password"
          data-testid="security-disable-current"
        />
      </div>
      <div class="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          data-testid="security-disable-cancel"
          :disabled="submitting"
          @click="reset"
        >
          {{ t("cancel") }}
        </Button>
        <Button
          type="submit"
          variant="destructive"
          :disabled="submitting || !currentPassphrase"
          data-testid="security-disable-submit"
        >
          {{ t("encryptionDisable") }}
        </Button>
      </div>
    </form>

    <p
      v-if="errorMessage"
      class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      role="alert"
    >
      {{ errorMessage }}
    </p>

    <div class="grid gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
      <p class="text-sm font-medium text-destructive">
        {{ t("encryptionForgottenButton") }}
      </p>
      <p class="text-xs text-muted-foreground">{{ t("encryptionForgotten") }}</p>
      <AlertDialog>
        <AlertDialogTrigger as-child>
          <Button
            type="button"
            variant="destructive"
            class="w-fit"
            :disabled="clearing"
            data-testid="security-clear-all"
          >
            {{ t("encryptionForgottenButton") }}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{{ t("encryptionForgottenButton") }}</AlertDialogTitle>
            <AlertDialogDescription>{{ t("encryptionForgotten") }}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="security-clear-all-cancel">{{ t("cancel") }}</AlertDialogCancel>
            <AlertDialogAction
              class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="security-clear-all-confirm"
              @click="clearAll"
            >
              {{ t("encryptionForgottenButton") }}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  </div>
</template>
