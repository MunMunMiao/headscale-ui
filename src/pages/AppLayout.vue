<script setup lang="ts">
import {
  Activity,
  Check,
  CircleUserRound,
  Clock,
  Copy,
  EllipsisVertical,
  FileCheck2,
  Github,
  KeyRound,
  Languages,
  LoaderCircle,
  LogOut,
  MonitorCog,
  MoonStar,
  Network,
  Plus,
  RefreshCw,
  Router,
  Server,
  ShieldCheck,
  SunMedium,
  Trash2,
  Users,
} from "lucide-vue-next";
import { computed, nextTick, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { ApiKey, HeadscaleClient } from "@/api/types";
import HeadscaleLogo from "@/components/HeadscaleLogo.vue";
import SecuritySettings from "@/components/SecuritySettings.vue";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { DateTimePicker } from "@/components/ui/date-time-picker";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type ActionFeedbackKey, useActionFeedback } from "@/composables/useActionFeedback";
import { useDisplayHelpers } from "@/composables/useDisplayHelpers";
import { useMutation } from "@/composables/useMutation";
import { useProductCopy } from "@/composables/useProductCopy";
import { useProfiles } from "@/composables/useProfiles";
import { useSnapshot } from "@/composables/useSnapshot";
import { isThemeMode, type ThemeMode, useTheme } from "@/composables/useTheme";
import { LOCALE_META, type Locale, SUPPORTED_LOCALES, useHeadscaleI18n } from "@/i18n";

type ProductSection = "home" | "devices" | "members" | "invites" | "routes" | "access";
type ProfileSubmenu = "language" | "theme";
type ServerSettingsTab = "apiKeys" | "maintenance" | "security";
type ApiKeyActionTarget = {
  kind: "expire" | "delete";
  key: ApiKey;
};

const githubRepositoryUrl = "https://github.com/MunMunMiao/headscale-ui";

const productSections: ProductSection[] = [
  "home",
  "devices",
  "members",
  "invites",
  "routes",
  "access",
];

const sectionIcons: Record<ProductSection, typeof Activity> = {
  home: Activity,
  devices: Network,
  members: Users,
  invites: KeyRound,
  routes: Router,
  access: FileCheck2,
};

const { t, locale, meta, setLocale } = useHeadscaleI18n();
const { copy } = useProductCopy();
const { colorMode, themeModes, setTheme } = useTheme();
const { currentProfileLabel, logout } = useProfiles();
const {
  snapshot,
  isAuthorized,
  isRefreshing: isRefreshingSnapshot,
  refreshSnapshot,
} = useSnapshot();
const { lastError, isActionPending, actionError, clearActionFeedback } = useActionFeedback();

const route = useRoute();
const router = useRouter();

const profileMenuOpen = ref(false);
const profileSubmenu = ref<ProfileSubmenu | null>(null);
const serverSettingsDialogOpen = ref(false);
const serverSettingsTab = ref<ServerSettingsTab>("apiKeys");
const createdApiKey = ref("");
const copiedKey = ref("");
const pendingApiKeyAction = ref<ApiKeyActionTarget | null>(null);
const backfillNodeIpsDialogOpen = ref(false);
const backfillNodeIpsConfirmed = ref(false);
const backfillNodeIpsResult = ref("");
const apiKeyForm = reactive({
  expiration: "2026-12-31T23:59:00Z",
});

const activeSection = computed<ProductSection>(() => {
  const name = route.name;
  if (typeof name === "string" && (productSections as readonly string[]).includes(name)) {
    return name as ProductSection;
  }
  return "home";
});

function themeModeLabel(mode: ThemeMode) {
  if (mode === "dark") return t("dark");
  if (mode === "light") return t("light");
  return t("system");
}

function changeSection(nextSection: string) {
  if ((productSections as readonly string[]).includes(nextSection)) {
    void router.push({ name: nextSection });
  }
}

function changeLocale(nextLocale: string) {
  if ((SUPPORTED_LOCALES as readonly string[]).includes(nextLocale)) {
    setLocale(nextLocale as Locale);
  }
}

function changeTheme(nextTheme: string) {
  if (isThemeMode(nextTheme)) {
    setTheme(nextTheme);
  }
}

function chooseLocale(option: Locale) {
  changeLocale(option);
  profileMenuOpen.value = false;
}

function chooseTheme(mode: ThemeMode) {
  changeTheme(mode);
  profileMenuOpen.value = false;
}

function logoutFromMenu() {
  profileMenuOpen.value = false;
  logout();
  void router.push({ name: "login" });
}

function openProfileSubmenu(menu: ProfileSubmenu) {
  profileSubmenu.value = menu;
}

function keepProfileSubmenuOpen(menu: ProfileSubmenu, isOpen: boolean) {
  if (isOpen) {
    openProfileSubmenu(menu);
  }
}

function openServerSettings() {
  profileMenuOpen.value = false;
  serverSettingsTab.value = "apiKeys";
  serverSettingsDialogOpen.value = true;
  createdApiKey.value = "";
  clearActionFeedback("api-key-create");
  clearActionFeedback("api-key-action");
  clearActionFeedback("backfill-node-ips");
}

function handleServerSettingsOpen(open: boolean) {
  if (!open && (isActionPending("api-key-create") || isActionPending("api-key-action"))) {
    return;
  }
  serverSettingsDialogOpen.value = open;
  if (!open) {
    createdApiKey.value = "";
    backfillNodeIpsResult.value = "";
    clearActionFeedback("api-key-create");
    clearActionFeedback("api-key-action");
  }
}

function changeServerSettingsTab(nextTab: string) {
  if (nextTab === "apiKeys" || nextTab === "maintenance" || nextTab === "security") {
    serverSettingsTab.value = nextTab;
  }
}

function requestApiKeyAction(kind: ApiKeyActionTarget["kind"], key: ApiKey) {
  clearActionFeedback("api-key-action");
  pendingApiKeyAction.value = { kind, key };
}

function handleApiKeyActionDialogOpen(open: boolean) {
  if (!open && isActionPending("api-key-action")) {
    return;
  }
  if (!open) {
    pendingApiKeyAction.value = null;
    clearActionFeedback("api-key-action");
  }
}

const { mutate, mutateWith } = useMutation();

async function createServerApiKey() {
  createdApiKey.value = "";
  const created = await mutateWith("api-key-create", (client) =>
    client.createApiKey({ expiration: apiKeyForm.expiration }),
  );
  if (created.ok) {
    createdApiKey.value = created.result.apiKey;
  }
}

async function confirmApiKeyAction() {
  const target = pendingApiKeyAction.value;
  if (!target) return;

  const completed = await mutate("api-key-action", (client) =>
    target.kind === "expire"
      ? client.expireApiKey({ prefix: target.key.prefix })
      : client.deleteApiKey({ prefix: target.key.prefix }),
  );
  if (completed) {
    handleApiKeyActionDialogOpen(false);
  }
}

function openBackfillNodeIpsDialog() {
  clearActionFeedback("backfill-node-ips");
  backfillNodeIpsConfirmed.value = false;
  backfillNodeIpsResult.value = "";
  backfillNodeIpsDialogOpen.value = true;
}

function handleBackfillNodeIpsDialogOpen(open: boolean) {
  if (!open && isActionPending("backfill-node-ips")) {
    return;
  }
  backfillNodeIpsDialogOpen.value = open;
  if (!open) {
    backfillNodeIpsConfirmed.value = false;
    clearActionFeedback("backfill-node-ips");
  }
}

async function confirmBackfillNodeIps() {
  backfillNodeIpsResult.value = "";
  const backfilled = await mutateWith("backfill-node-ips", (client) =>
    client.backfillNodeIps({ confirmed: true }),
  );
  if (backfilled.ok) {
    backfillNodeIpsResult.value = backfilled.result.changes.join(", ") || copy.value.readyToSave;
    handleBackfillNodeIpsDialogOpen(false);
  }
}

async function copyKeyValue(value: string) {
  await navigator.clipboard.writeText(value);
  copiedKey.value = value;
  window.setTimeout(() => {
    copiedKey.value = "";
  }, 1200);
}

const { formatDate } = useDisplayHelpers();

function scrollActiveTabIntoView() {
  void nextTick(() => {
    const activeTab = document.querySelector<HTMLElement>(
      `[data-testid="section-${activeSection.value}"]`,
    );
    activeTab?.scrollIntoView({ block: "nearest", inline: "center" });
  });
}

watch(profileMenuOpen, (isOpen) => {
  if (!isOpen) {
    profileSubmenu.value = null;
  }
});

watch([activeSection, isAuthorized], scrollActiveTabIntoView, { immediate: true });
</script>

<template>
  <main class="min-h-screen bg-background">
    <div
      v-if="!isAuthorized"
      role="status"
      class="flex min-h-screen items-center justify-center gap-3 text-sm text-muted-foreground"
      data-testid="session-loading"
    >
      <LoaderCircle class="h-5 w-5 animate-spin" aria-hidden="true" />
      <span>{{ t("checkingCredentials") }}</span>
    </div>
    <div v-else class="min-h-screen bg-background text-foreground">
      <header
        class="sticky top-0 z-20 bg-card/95 shadow-sm backdrop-blur"
        data-testid="app-header"
      >
        <div class="container mx-auto flex w-full min-w-0 flex-col gap-0 px-3 pt-2 md:px-4">
          <div class="flex min-h-11 min-w-0 items-center justify-between gap-2" data-testid="header-primary-row">
            <div class="flex shrink-0 items-center gap-2" data-testid="app-logo">
              <HeadscaleLogo class="h-8 w-8" />
              <span class="text-sm font-semibold leading-none sm:text-base">Headscale UI</span>
            </div>

            <div class="ms-auto flex shrink-0 items-center gap-1">
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

              <DropdownMenu v-model:open="profileMenuOpen">
                <DropdownMenuTrigger as-child>
                  <Button
                    variant="ghost"
                    size="icon"
                    data-testid="profile-menu-trigger"
                    class="relative"
                    :aria-label="t('profile')"
                  >
                    <CircleUserRound class="h-5 w-5" aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" class="w-64" data-testid="profile-menu">
                  <DropdownMenuLabel class="flex items-center gap-2">
                    <CircleUserRound class="h-4 w-4" aria-hidden="true" />
                    <span class="min-w-0 truncate">{{ currentProfileLabel }}</span>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuSub
                    :open="profileSubmenu === 'language'"
                    @update:open="(isOpen) => keepProfileSubmenuOpen('language', isOpen)"
                  >
                    <DropdownMenuSubTrigger
                      data-testid="language-menu-trigger"
                      @click.prevent="openProfileSubmenu('language')"
                      @focus="openProfileSubmenu('language')"
                      @pointermove="openProfileSubmenu('language')"
                    >
                      <Languages class="h-4 w-4" aria-hidden="true" />
                      <span>{{ t("language") }}</span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent class="w-48" :side-offset="-16">
                      <DropdownMenuItem
                        v-for="option in SUPPORTED_LOCALES"
                        :key="option"
                        :data-testid="`locale-option-${option}`"
                        @click="chooseLocale(option)"
                      >
                        <span>{{ LOCALE_META[option].nativeLabel }}</span>
                        <Check v-if="locale === option" class="ms-auto h-4 w-4" aria-hidden="true" />
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuSub
                    :open="profileSubmenu === 'theme'"
                    @update:open="(isOpen) => keepProfileSubmenuOpen('theme', isOpen)"
                  >
                    <DropdownMenuSubTrigger
                      data-testid="theme-menu-trigger"
                      @click.prevent="openProfileSubmenu('theme')"
                      @focus="openProfileSubmenu('theme')"
                      @pointermove="openProfileSubmenu('theme')"
                    >
                      <SunMedium v-if="colorMode === 'light'" class="h-4 w-4" aria-hidden="true" />
                      <MoonStar v-else-if="colorMode === 'dark'" class="h-4 w-4" aria-hidden="true" />
                      <MonitorCog v-else class="h-4 w-4" aria-hidden="true" />
                      <span>{{ t("theme") }}</span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent class="w-44" :side-offset="-16">
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
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem data-testid="open-server-settings" @click="openServerSettings">
                    <ShieldCheck class="h-4 w-4" aria-hidden="true" />
                    {{ copy.openServerSettings }}
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" data-testid="logout" @click="logoutFromMenu">
                    <LogOut class="h-4 w-4" aria-hidden="true" />
                    {{ t("logout") }}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          <Tabs
            :model-value="activeSection"
            :dir="meta.dir"
            class="w-full min-w-0 gap-0"
            data-testid="header-navigation"
            @update:model-value="(value) => changeSection(String(value))"
          >
            <TabsList class="h-9 w-full max-w-full justify-start gap-0 overflow-x-auto rounded-none bg-transparent px-0 py-0 text-foreground">
              <TabsTrigger
                v-for="section in productSections"
                :key="section"
                :value="section"
                :data-testid="`section-${section}`"
                :aria-current="activeSection === section ? 'page' : undefined"
                class="h-9 flex-none rounded-none border-0 bg-transparent px-3 shadow-none hover:bg-transparent data-[state=active]:bg-transparent data-[state=active]:shadow-none dark:data-[state=active]:bg-transparent"
                :class="activeSection === section ? 'font-semibold text-primary' : 'text-muted-foreground hover:text-foreground'"
              >
                <component :is="sectionIcons[section]" class="h-4 w-4" aria-hidden="true" />
                {{ copy.nav[section] }}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </header>

      <section class="container mx-auto min-w-0 space-y-3 px-3 pb-6 pt-4 sm:px-4 sm:py-4 lg:px-5" data-testid="page-body">
        <div v-if="lastError" role="alert" class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {{ lastError }}
        </div>

        <Dialog :open="serverSettingsDialogOpen" @update:open="handleServerSettingsOpen">
          <DialogContent class="max-h-[85vh] overflow-y-auto sm:max-w-4xl" data-testid="server-settings-dialog">
            <DialogHeader>
              <DialogTitle>{{ copy.serverSettingsTitle }}</DialogTitle>
              <DialogDescription>{{ copy.serverSettingsDescription }}</DialogDescription>
            </DialogHeader>

            <Tabs
              :model-value="serverSettingsTab"
              :dir="meta.dir"
              class="grid gap-4"
              @update:model-value="(value) => changeServerSettingsTab(String(value))"
            >
              <TabsList class="w-full justify-start overflow-x-auto">
                <TabsTrigger value="apiKeys" data-testid="server-tab-api-keys">
                  <KeyRound class="h-4 w-4" aria-hidden="true" />
                  {{ copy.apiKeysTitle }}
                </TabsTrigger>
                <TabsTrigger value="maintenance" data-testid="server-tab-maintenance">
                  <Server class="h-4 w-4" aria-hidden="true" />
                  {{ copy.maintenance }}
                </TabsTrigger>
                <TabsTrigger value="security" data-testid="server-tab-security">
                  <ShieldCheck class="h-4 w-4" aria-hidden="true" />
                  {{ t("encryptionSectionTitle") }}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="apiKeys" class="grid gap-4" data-testid="api-key-settings">
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div class="grid gap-2">
                    <h3 class="text-sm font-semibold">{{ copy.apiKeysTitle }}</h3>
                    <p class="text-sm text-muted-foreground">{{ copy.apiKeysDescription }}</p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    data-testid="refresh-api-keys"
                    :aria-label="copy.refreshData"
                    :title="copy.refreshData"
                    :disabled="isRefreshingSnapshot"
                    @click="refreshSnapshot"
                  >
                    <LoaderCircle v-if="isRefreshingSnapshot" class="h-4 w-4 animate-spin" aria-hidden="true" />
                    <RefreshCw v-else class="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
                <div class="grid gap-3 rounded-md border bg-background p-3">
                  <div class="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
                    <div class="grid gap-2">
                      <Label for="api-key-expiration">{{ copy.apiKeyExpiration }}</Label>
                      <DateTimePicker
                        id="api-key-expiration"
                        v-model="apiKeyForm.expiration"
                        :locale="locale"
                        :time-label="copy.time"
                        :hour-label="copy.hour"
                        :minute-label="copy.minute"
                        data-testid="api-key-expiration"
                      />
                    </div>
                    <Button type="button" data-testid="create-api-key-confirm" :disabled="isActionPending('api-key-create')" @click="createServerApiKey">
                      <LoaderCircle v-if="isActionPending('api-key-create')" class="h-4 w-4 animate-spin" aria-hidden="true" />
                      <Plus v-else class="h-4 w-4" aria-hidden="true" />
                      {{ copy.createApiKeyTitle }}
                    </Button>
                    <p
                      v-if="actionError('api-key-create')"
                      role="alert"
                      class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                      data-testid="api-key-create-error"
                    >
                      {{ actionError("api-key-create") }}
                    </p>
                  </div>
                  <div v-if="createdApiKey" class="grid gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300" data-testid="created-api-key">
                    <p class="text-sm font-semibold">{{ copy.createdApiKey }}</p>
                    <code dir="ltr" class="break-all rounded bg-background/70 px-2 py-1 text-xs text-foreground">{{ createdApiKey }}</code>
                    <p class="text-xs">{{ copy.apiKeyOnlyShownOnce }}</p>
                    <Button type="button" variant="outline" size="sm" class="w-fit" data-testid="copy-created-api-key" @click="copyKeyValue(createdApiKey)">
                      <Copy class="h-4 w-4" aria-hidden="true" />
                      {{ copiedKey === createdApiKey ? copy.copied : copy.copy }}
                    </Button>
                  </div>
                </div>
                <Card class="overflow-x-auto" data-testid="api-key-table">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{{ copy.apiKeyPrefix }}</TableHead>
                        <TableHead>{{ copy.joined }}</TableHead>
                        <TableHead>{{ copy.expires }}</TableHead>
                        <TableHead>{{ copy.lastSeen }}</TableHead>
                        <TableHead>{{ copy.actions }}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <TableRow v-for="key in snapshot.apiKeys" :key="key.id" :data-testid="`api-key-row-${key.prefix}`">
                        <TableCell class="font-mono text-xs">{{ key.prefix }}</TableCell>
                        <TableCell class="text-sm text-muted-foreground">{{ formatDate(key.createdAt) }}</TableCell>
                        <TableCell class="text-sm text-muted-foreground">{{ formatDate(key.expiration) }}</TableCell>
                        <TableCell class="text-sm text-muted-foreground">{{ formatDate(key.lastSeen) }}</TableCell>
                        <TableCell>
                          <div class="flex justify-start">
                            <DropdownMenu>
                              <DropdownMenuTrigger as-child>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="icon"
                                  :data-testid="`api-key-actions-trigger-${key.prefix}`"
                                  :aria-label="`${copy.actions}: ${key.prefix}`"
                                >
                                  <EllipsisVertical class="h-4 w-4" aria-hidden="true" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" class="w-56" :data-testid="`api-key-actions-menu-${key.prefix}`">
                                <DropdownMenuLabel>{{ copy.actions }}</DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem :data-testid="`expire-api-key-${key.prefix}`" @click="requestApiKeyAction('expire', key)">
                                  <Clock class="h-4 w-4" aria-hidden="true" />
                                  {{ copy.expireApiKeyTitle }}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  variant="destructive"
                                  :data-testid="`delete-api-key-${key.prefix}`"
                                  @click="requestApiKeyAction('delete', key)"
                                >
                                  <Trash2 class="h-4 w-4" aria-hidden="true" />
                                  {{ copy.deleteApiKeyTitle }}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </Card>
              </TabsContent>

              <TabsContent value="maintenance" class="grid gap-4" data-testid="server-maintenance-settings">
                <div class="grid gap-2">
                  <h3 class="text-sm font-semibold">{{ copy.maintenance }}</h3>
                  <p class="text-sm text-muted-foreground">{{ copy.maintenanceDescription }}</p>
                </div>
                <Card class="grid gap-3 p-4">
                  <div>
                    <h4 class="text-sm font-semibold">{{ copy.backfillNodeIps }}</h4>
                    <p class="mt-1 text-sm text-muted-foreground">{{ copy.backfillNodeIpsDescription }}</p>
                  </div>
                  <Button type="button" variant="outline" class="w-fit" data-testid="open-backfill-node-ips" @click="openBackfillNodeIpsDialog">
                    <Server class="h-4 w-4" aria-hidden="true" />
                    {{ copy.backfillNodeIps }}
                  </Button>
                  <p v-if="backfillNodeIpsResult" class="rounded-md bg-muted px-3 py-2 text-sm" data-testid="backfill-node-ips-result">
                    {{ copy.backfillResult }}: {{ backfillNodeIpsResult }}
                  </p>
                </Card>
              </TabsContent>

              <TabsContent value="security" class="grid gap-4" data-testid="security-settings">
                <SecuritySettings />
              </TabsContent>
            </Tabs>
          </DialogContent>
        </Dialog>

        <AlertDialog :open="Boolean(pendingApiKeyAction)" @update:open="handleApiKeyActionDialogOpen">
          <AlertDialogContent v-if="pendingApiKeyAction" :data-testid="pendingApiKeyAction.kind === 'expire' ? 'expire-api-key-dialog' : 'delete-api-key-dialog'">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {{ pendingApiKeyAction.kind === "expire" ? copy.expireApiKeyTitle : copy.deleteApiKeyTitle }}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {{ copy.apiKeysDescription }}
                <span class="mt-2 block font-mono text-xs text-foreground">{{ pendingApiKeyAction.key.prefix }}</span>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="cancel-api-key-action" :disabled="isActionPending('api-key-action')">{{ copy.cancel }}</AlertDialogCancel>
              <Button
                type="button"
                variant="destructive"
                data-testid="confirm-api-key-action"
                :disabled="isActionPending('api-key-action')"
                @click="confirmApiKeyAction"
              >
                <LoaderCircle v-if="isActionPending('api-key-action')" class="h-4 w-4 animate-spin" aria-hidden="true" />
                {{ pendingApiKeyAction.kind === "expire" ? copy.confirmExpireApiKey : copy.confirmDeleteApiKey }}
              </Button>
            </AlertDialogFooter>
            <p
              v-if="actionError('api-key-action')"
              role="alert"
              class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              data-testid="api-key-action-error"
            >
              {{ actionError("api-key-action") }}
            </p>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog :open="backfillNodeIpsDialogOpen" @update:open="handleBackfillNodeIpsDialogOpen">
          <AlertDialogContent data-testid="backfill-node-ips-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>{{ copy.backfillNodeIps }}</AlertDialogTitle>
              <AlertDialogDescription>{{ copy.backfillNodeIpsDescription }}</AlertDialogDescription>
            </AlertDialogHeader>
            <label class="flex items-start gap-2 rounded-md border bg-background p-3 text-sm" for="backfill-node-ips-confirmed">
              <Checkbox id="backfill-node-ips-confirmed" v-model="backfillNodeIpsConfirmed" data-testid="backfill-node-ips-confirmed" />
              <span>{{ copy.maintenanceDescription }}</span>
            </label>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="cancel-backfill-node-ips" :disabled="isActionPending('backfill-node-ips')">{{ copy.cancel }}</AlertDialogCancel>
              <Button
                type="button"
                variant="destructive"
                data-testid="confirm-backfill-node-ips"
                :disabled="!backfillNodeIpsConfirmed || isActionPending('backfill-node-ips')"
                @click="confirmBackfillNodeIps"
              >
                <LoaderCircle v-if="isActionPending('backfill-node-ips')" class="h-4 w-4 animate-spin" aria-hidden="true" />
                {{ copy.confirmBackfillNodeIps }}
              </Button>
            </AlertDialogFooter>
            <p
              v-if="actionError('backfill-node-ips')"
              role="alert"
              class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              data-testid="backfill-node-ips-error"
            >
              {{ actionError("backfill-node-ips") }}
            </p>
          </AlertDialogContent>
        </AlertDialog>

        <router-view />
      </section>
    </div>
  </main>
</template>
