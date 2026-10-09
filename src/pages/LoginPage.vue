<script setup lang="ts">
import {
  AlertCircle,
  Check,
  ClipboardCheck,
  Copy,
  Github,
  Info,
  KeyRound,
  Languages,
  LoaderCircle,
  Lock,
  LockKeyhole,
  MonitorCog,
  MoonStar,
  Pencil,
  Plus,
  SunMedium,
  Trash2,
} from "lucide-vue-next";
import { computed, onMounted, ref } from "vue";
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
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useActionFeedback } from "@/composables/useActionFeedback";
import { useConnectionDialog } from "@/composables/useConnectionDialog";
import { useDisplayHelpers } from "@/composables/useDisplayHelpers";
import { useLoginPageShell } from "@/composables/useLoginPageShell";
import { newProfileId, useProfiles } from "@/composables/useProfiles";
import { useProfileValidationFlow } from "@/composables/useProfileValidationFlow";
import { useProfileVisuals } from "@/composables/useProfileVisuals";
import { LOCALE_META, SUPPORTED_LOCALES, useHeadscaleI18n } from "@/i18n";
import { type ConnectionProfile, profileStorage } from "@/lib/profile-storage";

const apiKeyCommand = "headscale apikeys create --expiration 90d";
const commandCopied = ref(false);
async function copyApiKeyCommand() {
  try {
    await navigator.clipboard.writeText(apiKeyCommand);
    commandCopied.value = true;
    window.setTimeout(() => {
      commandCopied.value = false;
    }, 1200);
  } catch {
    // ignore — clipboard API may be unavailable (insecure context / older browsers)
  }
}
const headscaleRemoteCliDocsUrl = "https://docs.headscale.org/ref/remote-cli/";
const githubRepositoryUrl = "https://github.com/MunMunMiao/headscale-ui";

const { t, locale } = useHeadscaleI18n();
const { lastError } = useActionFeedback();
const {
  profiles,
  connectionForm,
  phase,
  isConnecting,
  isRestoringSession,
  authenticatingProfileId,
  selectedProfile,
  connectionDialogOpen,
  connectionCloseConfirmOpen,
  profileValidationDialogOpen,
  profileValidationError,
  pendingDeleteProfile,
  enterProfile,
  deleteProfile,
  confirmDeleteProfile,
} = useProfiles();

const { colorMode, themeModes, themeLabel, themeModeLabel, chooseLocale, chooseTheme } =
  useLoginPageShell();
const { profileVisualState, profileAvatarLabel } = useProfileVisuals();
const {
  syncConnectionFormBaseline,
  openConnectionDialogWithBaseline,
  editProfileWithBaseline,
  requestConnectionDialogClose,
  confirmConnectionDialogClose,
  handleConnectionDialogOpen,
  handleConnectionCloseConfirmOpen,
  preventConnectionDialogOutsideClose,
  handleConnectionDialogEscape,
} = useConnectionDialog();
const { reviewProfileConnection, continueAddingProfile, submitAddProfile } =
  useProfileValidationFlow(syncConnectionFormBaseline);

const route = useRoute();
const router = useRouter();

const isPersistentAvailable = computed(() => profileStorage.isPersistentAvailable());

// Derived from the phase-driven authenticatingProfileId so the session-restore
// loader picks up cold-start restorations (previously a local ref was only
// written on manual clicks, leaving cold-start without a profile reference).
const restoringProfile = computed(() => {
  const profileId = authenticatingProfileId.value;
  return profileId ? profiles.value.find((profile) => profile.id === profileId) : null;
});
const restoringProfileLabel = computed(() => restoringProfile.value?.name ?? t("profile"));

const { formatDate } = useDisplayHelpers();

function requestDeleteProfile(profile: ConnectionProfile) {
  deleteProfile(profile);
}

function handleDeleteProfileDialogOpen(open: boolean) {
  if (!open) {
    window.setTimeout(() => {
      pendingDeleteProfile.value = null;
    }, 0);
  }
}

async function enterProfileAndRoute(profile: ConnectionProfile) {
  if (profile.corrupted) {
    await editProfileWithBaseline(profile);
    return;
  }
  const succeeded = await enterProfile(profile);
  if (succeeded) {
    await router.push({ name: "home" });
  }
}

const profilesWereCleared = computed(() => route.query.cleared === "1");

onMounted(() => {
  // TODO: auto-login via route.query.profile (legacy URL compatibility).
  // The main thread will complete this integration when wiring the new router.
  void route;
});
</script>

<template>
  <main class="min-h-screen bg-background">
    <section
      v-if="isRestoringSession && restoringProfile"
      class="flex min-h-screen items-center justify-center px-4"
      data-testid="session-restore"
    >
      <div class="grid justify-items-center gap-4 text-center text-sm text-muted-foreground">
        <div class="relative flex h-16 w-16 items-center justify-center rounded-full border bg-card shadow-sm">
          <HeadscaleLogo class="h-9 w-9 opacity-60" />
          <LoaderCircle class="absolute h-16 w-16 animate-spin text-primary" aria-hidden="true" />
        </div>
        <div class="grid gap-1">
          <p class="font-medium text-foreground">{{ restoringProfileLabel }}</p>
          <p>
            {{
              phase.kind === "restoring"
                ? t("restoringSession", { name: restoringProfileLabel })
                : t("checkingCredentials")
            }}
          </p>
        </div>
      </div>
    </section>

    <section v-else class="min-h-screen bg-background">
      <header class="border-b bg-card text-card-foreground">
        <div class="container mx-auto flex h-14 w-full items-center gap-3 px-4">
          <div class="flex min-w-0 items-center gap-2">
            <HeadscaleLogo class="h-8 w-8 shrink-0" />
            <span class="truncate text-sm font-semibold leading-none sm:text-base">Headscale UI</span>
          </div>

          <div class="ms-auto flex items-center gap-1 py-1">
            <Button
              as="a"
              :href="githubRepositoryUrl"
              target="_blank"
              rel="noreferrer"
              variant="ghost"
              size="icon"
              title="GitHub"
              aria-label="GitHub"
              data-testid="github-repository-link"
            >
              <Github class="h-5 w-5" aria-hidden="true" />
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  data-testid="locale-select"
                  :aria-label="`${t('language')}: ${LOCALE_META[locale].nativeLabel}`"
                >
                  <Languages class="h-5 w-5" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" class="w-48">
                <DropdownMenuLabel>{{ t("language") }}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  v-for="option in SUPPORTED_LOCALES"
                  :key="option"
                  :data-testid="`locale-option-${option}`"
                  @click="chooseLocale(option)"
                >
                  <span>{{ LOCALE_META[option].nativeLabel }}</span>
                  <Check v-if="locale === option" class="ms-auto h-4 w-4" aria-hidden="true" />
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  data-testid="theme-select"
                  :aria-label="`${t('theme')}: ${themeLabel}`"
                >
                  <SunMedium v-if="colorMode === 'light'" class="h-5 w-5" aria-hidden="true" />
                  <MoonStar v-else-if="colorMode === 'dark'" class="h-5 w-5" aria-hidden="true" />
                  <MonitorCog v-else class="h-5 w-5" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" class="w-44">
                <DropdownMenuLabel>{{ t("theme") }}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  v-for="mode in themeModes"
                  :key="mode"
                  :data-testid="`theme-option-${mode}`"
                  @click="chooseTheme(mode)"
                >
                  <SunMedium v-if="mode === 'light'" class="h-4 w-4" aria-hidden="true" />
                  <MoonStar v-else-if="mode === 'dark'" class="h-4 w-4" aria-hidden="true" />
                  <MonitorCog v-else class="h-4 w-4" aria-hidden="true" />
                  <span>{{ themeModeLabel(mode) }}</span>
                  <Check v-if="colorMode === mode" class="ms-auto h-4 w-4" aria-hidden="true" />
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <div class="container mx-auto flex min-h-[calc(100vh-3.5rem)] w-full items-center justify-center px-4 py-8 sm:py-10">
        <div class="w-full max-w-5xl min-w-0 text-center">
          <div class="mx-auto max-w-2xl">
            <h1 class="text-2xl font-semibold sm:text-3xl">{{ t("profileSelectorTitle") }}</h1>
            <p class="mt-2 text-sm text-muted-foreground sm:text-base">
              {{ t("profileSelectorDescription") }}
            </p>
          </div>

          <div
            v-if="lastError && !connectionDialogOpen"
            data-testid="login-error"
            role="alert"
            class="mx-auto mt-4 max-w-xl rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-start text-sm text-destructive"
          >
            {{ lastError }}
          </div>

          <div
            v-if="profilesWereCleared && profiles.length === 0"
            data-testid="profiles-cleared-notice"
            role="status"
            class="mx-auto mt-4 max-w-xl rounded-md border bg-muted/40 px-3 py-2 text-start text-sm text-muted-foreground"
          >
            {{ t("profilesClearedNotice") }}
          </div>

          <div class="mx-auto mt-6 grid max-w-4xl gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" data-testid="profile-picker">
            <div
              v-for="profile in profiles"
              :key="profile.id"
              class="relative min-w-0"
              :data-testid="`profile-row-${profile.name}`"
            >
              <Button
                type="button"
                variant="ghost"
                :data-testid="`profile-option-${profile.name}`"
                class="h-auto min-h-36 w-full flex-col items-center justify-center gap-3 border bg-card p-4 text-center hover:bg-accent hover:text-accent-foreground"
                :aria-busy="authenticatingProfileId === profile.id"
                :disabled="isConnecting"
                @click="enterProfileAndRoute(profile)"
              >
                <span
                  class="relative flex h-16 w-16 items-center justify-center rounded-full border bg-background text-lg font-semibold transition-colors"
                  :class="[
                    authenticatingProfileId === profile.id ? 'border-primary/50 bg-primary/10 text-primary' : '',
                    profileVisualState(profile) === 'corrupted' ? 'border-destructive/50' : '',
                  ]"
                >
                  <LoaderCircle
                    v-if="authenticatingProfileId === profile.id"
                    class="absolute h-[72px] w-[72px] animate-spin"
                    aria-hidden="true"
                    :data-testid="`profile-loading-${profile.name}`"
                  />
                  <span :class="authenticatingProfileId === profile.id ? 'opacity-35' : ''">
                    {{ profileAvatarLabel(profile) }}
                  </span>
                  <span
                    v-if="profileVisualState(profile) === 'password'"
                    class="absolute -bottom-1 -end-1 flex h-5 w-5 items-center justify-center rounded-full border bg-background text-muted-foreground"
                  >
                    <Lock class="h-3 w-3" aria-hidden="true" />
                  </span>
                  <span
                    v-else-if="profileVisualState(profile) === 'locked'"
                    class="absolute -bottom-1 -end-1 flex h-5 w-5 items-center justify-center rounded-full border bg-background text-primary"
                  >
                    <LockKeyhole class="h-3 w-3" aria-hidden="true" />
                  </span>
                  <span
                    v-else-if="profileVisualState(profile) === 'corrupted'"
                    class="absolute -bottom-1 -end-1 flex h-5 w-5 items-center justify-center rounded-full border bg-background text-destructive"
                  >
                    <AlertCircle class="h-3 w-3" aria-hidden="true" />
                  </span>
                </span>
                <span class="grid w-full min-w-0 gap-1">
                  <span class="truncate text-sm font-semibold">{{ profile.name }}</span>
                  <span class="break-all text-xs text-muted-foreground">{{ profile.baseUrl }}</span>
                  <span v-if="authenticatingProfileId === profile.id" class="text-xs text-primary">
                    {{ t("checkingCredentials") }}
                  </span>
                  <span v-else class="text-xs text-muted-foreground">
                    {{ t("updatedProfile") }} {{ formatDate(profile.updatedAt) }}
                  </span>
                  <span
                    v-if="profileVisualState(profile) !== 'device'"
                    class="flex justify-center"
                  >
                    <Badge
                      v-if="profileVisualState(profile) === 'corrupted'"
                      variant="destructive"
                      :data-testid="`profile-badge-corrupted-${profile.name}`"
                    >
                      {{ t("encryptionCorruptedBadge") }}
                    </Badge>
                    <Badge
                      v-else-if="profileVisualState(profile) === 'locked'"
                      variant="default"
                      :data-testid="`profile-badge-locked-${profile.name}`"
                    >
                      {{ t("encryptionLockedBadge") }}
                    </Badge>
                    <Badge
                      v-else-if="profileVisualState(profile) === 'password'"
                      variant="secondary"
                      :data-testid="`profile-badge-encrypted-${profile.name}`"
                    >
                      {{ t("encryptionEncryptedBadge") }}
                    </Badge>
                    <Badge
                      v-else-if="profileVisualState(profile) === 'session'"
                      variant="outline"
                      class="border-amber-400/50 bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
                      :data-testid="`profile-badge-session-${profile.name}`"
                    >
                      {{ t("encryptionSessionOnlyBadge") }}
                    </Badge>
                  </span>
                </span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                :data-testid="`edit-profile-${profile.name}`"
                class="absolute start-2 top-2 h-8 w-8 bg-background/80"
                :aria-label="t('editProfile')"
                :disabled="isConnecting"
                @click.stop="editProfileWithBaseline(profile)"
              >
                <Pencil class="h-4 w-4" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                :data-testid="`delete-profile-${profile.name}`"
                class="absolute end-2 top-2 h-8 w-8 bg-background/80"
                :aria-label="t('deleteProfile')"
                :disabled="isConnecting"
                @click.stop="requestDeleteProfile(profile)"
              >
                <Trash2 class="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>

            <Button
              type="button"
              variant="ghost"
              data-testid="profile-option-new"
              class="h-auto min-h-36 flex-col items-center justify-center gap-3 border border-dashed bg-card p-4 text-center hover:bg-accent hover:text-accent-foreground"
              @click="openConnectionDialogWithBaseline(newProfileId)"
            >
              <span class="flex h-14 w-14 items-center justify-center rounded-full border bg-background">
                <Plus class="h-6 w-6" aria-hidden="true" />
              </span>
              <span class="grid gap-1">
                <span class="text-sm font-semibold">{{ t("addServerProfile") }}</span>
                <span class="text-xs text-muted-foreground">{{ t("newProfile") }}</span>
              </span>
            </Button>
          </div>
        </div>
      </div>

      <Dialog :open="connectionDialogOpen" @update:open="handleConnectionDialogOpen">
        <DialogContent
          class="grid max-h-[calc(100svh-0.5rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-h-[calc(100svh-4rem)] sm:max-w-2xl"
          data-testid="connection-dialog"
          :show-close-button="false"
          @escape-key-down="handleConnectionDialogEscape"
          @interact-outside="preventConnectionDialogOutsideClose"
          @pointer-down-outside="preventConnectionDialogOutsideClose"
        >
          <DialogHeader class="px-4 pb-2 pe-10 pt-3 text-start sm:px-6 sm:pb-3 sm:pt-6">
            <DialogTitle class="truncate">
              {{ selectedProfile ? `${t("editProfile")} ${selectedProfile.name}` : t("addServerProfile") }}
            </DialogTitle>
            <DialogDescription class="text-sm leading-5">{{ t("connectSubtitle") }}</DialogDescription>
          </DialogHeader>

          <form class="flex min-h-0 flex-col" data-testid="connect-form" @submit.prevent="submitAddProfile">
            <div class="grid min-h-0 min-w-0 gap-2 overflow-y-auto px-4 pb-2 sm:gap-4 sm:px-6 sm:pb-3 md:grid-cols-2">
              <div class="min-w-0 md:col-span-2">
                <Label for="connect-profile-name">{{ t("profileName") }}</Label>
                <Input
                  id="connect-profile-name"
                  v-model="connectionForm.profileName"
                  data-testid="connect-profile-name"
                  class="mt-1.5"
                />
              </div>

              <div class="min-w-0 md:col-span-2">
                <Label for="connect-server-url">{{ t("serverUrl") }}</Label>
                <Input
                  id="connect-server-url"
                  v-model="connectionForm.baseUrl"
                  data-testid="connect-server-url"
                  class="mt-1.5"
                />
              </div>

              <div class="min-w-0 md:col-span-2">
                <Label for="connect-api-key">{{ t("apiKey") }}</Label>
                <Input
                  id="connect-api-key"
                  v-model="connectionForm.apiKey"
                  data-testid="connect-api-key"
                  type="password"
                  class="mt-1.5"
                  :placeholder="t('apiKeyPlaceholder')"
                />
              </div>

              <div class="flex min-h-11 items-center gap-2 rounded-md border px-3 py-2 text-sm md:col-span-2">
                <Checkbox
                  id="connect-remember"
                  v-model="connectionForm.remember"
                  data-testid="connect-remember"
                  :disabled="!isPersistentAvailable"
                />
                <Label for="connect-remember" class="flex items-center gap-1.5">
                  {{ t("rememberConnection") }}
                  <Info
                    class="h-3.5 w-3.5 text-muted-foreground"
                    aria-hidden="true"
                    :title="t('encryptionStorageNote')"
                  />
                </Label>
                <span
                  v-if="!isPersistentAvailable"
                  class="ms-auto text-xs text-muted-foreground"
                  data-testid="connect-remember-unsupported"
                >
                  {{ t("encryptionUnsupportedHint") }}
                </span>
              </div>

              <details
                open
                class="group min-w-0 rounded-md border bg-muted/35 p-3 text-sm dark:bg-muted/60 md:col-span-2"
                data-testid="api-key-guide"
              >
                <summary class="flex cursor-pointer list-none items-start gap-2 [&::-webkit-details-marker]:hidden">
                  <KeyRound class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div class="min-w-0">
                    <h3 class="font-medium">{{ t("apiKeyGuideTitle") }}</h3>
                    <p class="mt-1 text-muted-foreground">{{ t("apiKeyGuideDescription") }}</p>
                  </div>
                </summary>
                <div class="mt-3 overflow-hidden rounded-md border bg-background p-3">
                  <div class="flex items-center justify-between gap-2">
                    <p class="text-xs font-medium text-muted-foreground">{{ t("apiKeyGuideCommandLabel") }}</p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      class="h-7 gap-1 px-2 text-xs"
                      data-testid="api-key-command-copy"
                      :aria-label="t('copy')"
                      @click="copyApiKeyCommand"
                    >
                      <ClipboardCheck v-if="commandCopied" class="h-3.5 w-3.5" aria-hidden="true" />
                      <Copy v-else class="h-3.5 w-3.5" aria-hidden="true" />
                      {{ commandCopied ? t("copied") : t("copy") }}
                    </Button>
                  </div>
                  <code class="mt-2 block overflow-x-auto whitespace-nowrap font-mono text-xs text-foreground">{{ apiKeyCommand }}</code>
                </div>
                <ol class="mt-3 grid gap-1 ps-5 text-xs text-muted-foreground">
                  <li>{{ t("apiKeyGuideStepServer") }}</li>
                  <li>{{ t("apiKeyGuideStepCreate") }}</li>
                  <li>{{ t("apiKeyGuideStepCopy") }}</li>
                  <li>{{ t("apiKeyGuideStepPaste") }}</li>
                </ol>
                <p class="mt-3 text-xs text-muted-foreground">{{ t("apiKeyGuideHint") }}</p>
                <a
                  :href="headscaleRemoteCliDocsUrl"
                  target="_blank"
                  rel="noreferrer"
                  class="mt-3 inline-flex cursor-pointer text-xs font-medium text-primary underline-offset-4 hover:underline"
                  data-testid="api-key-docs-link"
                >
                  {{ t("headscaleDocs") }}
                </a>
              </details>
            </div>

            <div class="grid shrink-0 gap-2 border-t bg-background p-2.5 sm:gap-3 sm:px-6 sm:py-4 md:grid-cols-2" data-testid="connect-footer">
              <p
                v-if="lastError"
                data-testid="connect-error"
                role="alert"
                class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive md:col-span-2"
              >
                {{ lastError }}
              </p>

              <DialogFooter class="flex-row gap-2 sm:justify-end md:col-span-2">
                <Button type="button" variant="outline" class="flex-1 sm:flex-none" data-testid="connect-close" @click="requestConnectionDialogClose">
                  {{ t("close") }}
                </Button>
                <Button type="submit" class="flex-1 sm:flex-none" data-testid="connect-submit" :disabled="isConnecting">
                  <LoaderCircle v-if="isConnecting" class="h-4 w-4 animate-spin" aria-hidden="true" />
                  <Plus v-else class="h-4 w-4" aria-hidden="true" />
                  {{ isConnecting ? t("addingProfile") : t("addProfile") }}
                </Button>
              </DialogFooter>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog :open="connectionCloseConfirmOpen" @update:open="handleConnectionCloseConfirmOpen">
        <AlertDialogContent data-testid="discard-profile-changes-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{{ t("discardProfileChangesTitle") }}</AlertDialogTitle>
            <AlertDialogDescription>
              {{ t("discardProfileChangesDescription") }}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="keep-editing-profile">
              {{ t("keepEditingProfile") }}
            </AlertDialogCancel>
            <AlertDialogAction
              class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="discard-profile-changes"
              @click="confirmConnectionDialogClose"
            >
              {{ t("discardProfileChanges") }}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog v-model:open="profileValidationDialogOpen">
        <AlertDialogContent data-testid="profile-validation-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{{ t("connectionValidationFailedTitle") }}</AlertDialogTitle>
            <AlertDialogDescription>
              {{ t("connectionValidationFailedDescription") }}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p
            v-if="profileValidationError"
            data-testid="profile-validation-error"
            class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {{ profileValidationError }}
          </p>
          <AlertDialogFooter>
            <AlertDialogCancel
              class="bg-primary text-primary-foreground hover:bg-primary/90"
              data-testid="review-profile-connection"
              @click="reviewProfileConnection"
            >
              {{ t("backToEditConnection") }}
            </AlertDialogCancel>
            <AlertDialogAction
              class="border border-input bg-background text-foreground shadow-xs hover:bg-accent hover:text-accent-foreground"
              data-testid="continue-add-profile"
              @click="continueAddingProfile"
            >
              {{ t("saveAnywayButton") }}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog :open="Boolean(pendingDeleteProfile)" @update:open="handleDeleteProfileDialogOpen">
        <AlertDialogContent data-testid="delete-profile-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{{ t("confirmDeleteProfileTitle") }}</AlertDialogTitle>
            <AlertDialogDescription>
              {{ t("confirmDeleteProfileDescription") }}
              <span v-if="pendingDeleteProfile" class="mt-2 block break-all font-medium text-foreground">
                <bdi dir="auto">{{ pendingDeleteProfile.name }}</bdi>
                ·
                <bdi dir="auto">{{ pendingDeleteProfile.baseUrl }}</bdi>
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="cancel-delete-profile">{{ t("cancel") }}</AlertDialogCancel>
            <AlertDialogAction
              class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="confirm-delete-profile"
              @click="confirmDeleteProfile"
            >
              {{ t("deleteProfile") }}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  </main>
</template>

<style scoped>
/* No scoped styles; styling uses tailwind utility classes. */
</style>
