import { useStore as useFormStore } from "@tanstack/react-form";
import {
  Link,
  Outlet,
  useBlocker,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import {
  Activity,
  CircleUserRound,
  Clock,
  EllipsisVertical,
  FileCheck2,
  KeyRound,
  Languages,
  LoaderCircle,
  LogOut,
  Network,
  Plus,
  RefreshCw,
  Router,
  Server,
  ShieldCheck,
  Trash2,
  Users,
} from "lucide-react";
import { createElement, useEffect, useRef, useState } from "react";
import type { ApiKey } from "@/api/contracts";
import type { SnapshotSegment } from "@/api/snapshot";
import { CopyButton } from "@/components/app/copy-button";
import { DateTimePicker } from "@/components/app/date-time-picker";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/app/dialog";
import { useAppForm } from "@/components/app/form";
import { Notice } from "@/components/app/notice";
import {
  API_KEY_EXPIRY_DAYS,
  dateTimeLocalToIso,
  defaultExpirationLocal,
  isFutureExpiration,
} from "@/components/create-auth-key-dialog";
import GithubIcon from "@/components/GithubIcon";
import HeadscaleLogo from "@/components/HeadscaleLogo";
import {
  LocaleRadioItems,
  ThemeModeIcon,
  ThemeRadioItems,
} from "@/components/PreferenceMenuItems";
import SecuritySettings from "@/components/SecuritySettings";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
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
import { useSession, useStore } from "@/composables/session-context";
import type { MutationOutcome } from "@/composables/tag-lifecycle-state";
import {
  type ActionFeedbackKey,
  mutationNotification,
  useActionFeedback,
} from "@/composables/useActionFeedback";
import { useDisplayHelpers } from "@/composables/useDisplayHelpers";
import { useMutation } from "@/composables/useMutation";
import { useProductCopy } from "@/composables/useProductCopy";
import { SAVED_LOCKED_ERROR, useProfiles } from "@/composables/useProfiles";
import { useSessionDraft } from "@/composables/useSessionDraft";
import { useAutoRefresh, useSnapshot } from "@/composables/useSnapshot";
import { useTheme } from "@/composables/useTheme";
import { listedApiKeyPrefix } from "@/domain/api-key";
import { isTimestampExpired } from "@/domain/node-status";
import { isolateVersion, serverVersionSupport } from "@/domain/server-version";
import { i18n, useHeadscaleI18n } from "@/i18n";
import { commonDescriptors, productDescriptors } from "@/i18n/descriptors";
import { cn } from "@/lib/utils";
import { redirectTarget } from "@/router/search";
import { apiKeyStatusClass } from "@/utils/status-class";

type ProductSection =
  "home" | "devices" | "members" | "invites" | "routes" | "access";
type PreferenceMenu = "language" | "theme";
type ApiKeyActionTarget = {
  kind: "expire" | "delete";
  key: ApiKey;
};

const githubRepositoryUrl = "https://github.com/MunMunMiao/headscale-ui";
const refreshSegmentOrder = [
  "fabric",
  "identity",
  "policy",
] as const satisfies readonly SnapshotSegment[];
const refreshSegmentLabels = {
  fabric: productDescriptors.feedbackNetworkData,
  identity: productDescriptors.feedbackIdentityData,
  policy: productDescriptors.nav.access,
} as const;
const actionLabels = {
  "api-key-action": productDescriptors.apiKeysTitle,
  "api-key-create": productDescriptors.createApiKeyTitle,
  "approve-auth-request": productDescriptors.approveSshCheck,
  "approve-route": productDescriptors.approveRouteTitle,
  "approve-routes": productDescriptors.approveRoutesTitle,
  "assign-user-groups": productDescriptors.assignMembershipsTitle,
  "assign-user-tags": productDescriptors.assignTagOwnershipsTitle,
  "backfill-node-ips": productDescriptors.backfillNodeIps,
  "check-policy": productDescriptors.checkPolicy,
  "create-invite": productDescriptors.createInvite,
  "create-member": productDescriptors.createMember,
  "delete-member": productDescriptors.deleteMember,
  "expire-node": productDescriptors.expireMachineTitle,
  "invite-action": productDescriptors.inviteKey,
  "node-tags": productDescriptors.nodeTags,
  "register-auth-request": productDescriptors.authRequestKindDevice,
  "register-pending-node": productDescriptors.registerPendingNode,
  "reject-auth-request": productDescriptors.rejectSshCheck,
  "remove-node": productDescriptors.removeMachineTitle,
  "rename-member": productDescriptors.renameMemberTitle,
  "rename-node": productDescriptors.renameMachineTitle,
  "revoke-route": productDescriptors.revokeRouteTitle,
  "save-policy": productDescriptors.savePolicy,
} as const satisfies Record<
  ActionFeedbackKey,
  { id: string; message?: string }
>;

function SnapshotFeedbackStatus({
  refreshErrors,
  refreshing,
  outcomes,
  onRetry,
}: {
  refreshErrors: Partial<Record<SnapshotSegment, string>>;
  refreshing: boolean;
  outcomes: Partial<Record<ActionFeedbackKey, MutationOutcome>>;
  onRetry: (segments: readonly SnapshotSegment[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const failedSegments = refreshSegmentOrder.filter(
    (segment) => refreshErrors[segment],
  );
  const recent = (Object.keys(actionLabels) as ActionFeedbackKey[]).flatMap(
    (key) => {
      const outcome = outcomes[key];
      const presentation = outcome ? mutationNotification(outcome) : null;
      return presentation ? [{ key, presentation }] : [];
    },
  );
  if (failedSegments.length === 0 && recent.length === 0) return null;
  const statusLabel = i18n._(productDescriptors.feedbackStatus);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              "w-fit",
              failedSegments.length > 0 &&
                "border-destructive/40 text-destructive",
            )}
            data-testid={
              failedSegments.length > 0
                ? "feedback-status-error"
                : "feedback-status"
            }
          />
        }
      >
        {statusLabel}
      </DialogTrigger>
      <DialogContent data-testid="feedback-status-dialog">
        <DialogHeader>
          <DialogTitle>{statusLabel}</DialogTitle>
          {failedSegments.length > 0 ? (
            <DialogDescription>
              {i18n._(productDescriptors.feedbackDataStale)}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        {failedSegments.length > 0 ? (
          <div className="grid gap-3">
            <ul className="grid gap-1">
              {failedSegments.map((segment) => (
                <li
                  key={segment}
                  data-testid={`snapshot-segment-${segment}`}
                  className="text-sm text-foreground"
                >
                  {i18n._(refreshSegmentLabels[segment])}
                </li>
              ))}
            </ul>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-fit"
              disabled={refreshing}
              onClick={() => onRetry(failedSegments)}
            >
              {i18n._(commonDescriptors.tryAgain)}
            </Button>
          </div>
        ) : null}
        {recent.length > 0 ? (
          <section className="grid gap-2">
            <h3 className="text-sm font-medium">
              {i18n._(productDescriptors.feedbackRecentResults)}
            </h3>
            <p className="text-sm text-muted-foreground">
              {i18n._(productDescriptors.feedbackRecentResultsHint)}
            </p>
            <ul className="grid gap-2">
              {recent.map(({ key, presentation }) => (
                <li key={key} className="grid gap-1 text-sm">
                  <p className="font-medium">{i18n._(actionLabels[key])}</p>
                  <p>{i18n._(presentation.title)}</p>
                  {presentation.description ? (
                    <p>{i18n._(presentation.description)}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

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

export default function AppLayout() {
  const session = useSession();
  const { stale, viewEpoch } = useStore(session.drafts);
  const { t } = useHeadscaleI18n();
  const navigate = useNavigate();
  const location = useLocation();
  useBlocker({
    shouldBlockFn: () => !session.drafts.isCurrent(),
    enableBeforeUnload: () =>
      !session.drafts.isCurrent() || session.policy.isPolicyDirty,
  });
  return (
    <>
      <AppLayoutContent key={viewEpoch} />
      <AlertDialog open={stale !== null}>
        <AlertDialogContent data-testid="stale-session-draft-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("sessionDraftsStaleTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("sessionDraftsStaleBody", { name: stale?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              data-testid="discard-stale-session-draft"
              onClick={() => {
                const target = redirectTarget(
                  location.href,
                  session.auth.getSessionSnapshot()?.profile,
                  session.navigationProfile,
                );
                session.discardDrafts();
                void navigate(target);
              }}
            >
              {t("sessionDraftsDiscard")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function AppLayoutContent() {
  const session = useSession();
  const { stale } = useStore(session.drafts);
  const { session: authorization } = useStore(session.auth);
  const { t, locale, meta, pendingLocale, settingsError } = useHeadscaleI18n();
  const { copy } = useProductCopy();
  const { colorMode } = useTheme();
  const { currentProfileLabel, logout, profiles } = useProfiles();
  const {
    snapshot,
    isAuthorized,
    isReady,
    isRefreshing: isRefreshingSnapshot,
    refreshSnapshot,
    refreshByUser,
    refreshErrors,
    refreshNotice,
    clearRefreshNotice,
  } = useSnapshot();
  useAutoRefresh();
  const {
    lastError,
    isActionPending,
    actionError,
    actionOutcome,
    actionOutcomes,
    clearActionFeedback,
    setState: setFeedbackState,
  } = useActionFeedback();

  const location = useLocation();
  const navigate = useNavigate();

  const [profileMenuOpen, setProfileMenuOpenState] = useState(false);
  const [preferenceMenu, setPreferenceMenu] = useState<PreferenceMenu | null>(
    null,
  );
  const [serverSettingsDialogOpen, setServerSettingsDialogOpen] =
    useState(false);
  const [serverSettingsTab, setServerSettingsTab] = useState("apiKeys");
  const [createdApiKey, setCreatedApiKey] = useState("");
  const [pendingApiKeyAction, setPendingApiKeyAction] =
    useState<ApiKeyActionTarget | null>(null);
  const [backfillNodeIpsDialogOpen, setBackfillNodeIpsDialogOpen] =
    useState(false);
  const [backfillNodeIpsResult, setBackfillNodeIpsResult] = useState("");
  const apiKeyForm = useAppForm({
    defaultValues: { expiration: "" },
    validators: {
      onDynamic: ({ value }) => ({
        fields: {
          expiration: isFutureExpiration(value.expiration.trim())
            ? undefined
            : copy.expirationMustBeFuture,
        },
      }),
    },
    onSubmit: async ({ value }) => {
      if (!session.drafts.isCurrent() || isActionPending("api-key-create"))
        return;
      await createServerApiKey(value.expiration.trim());
    },
  });
  const apiKeyActionForm = useAppForm({
    defaultValues: { acknowledged: false },
    validators: {
      onDynamic: ({ value }) => ({
        fields: {
          acknowledged: value.acknowledged
            ? undefined
            : copy.currentApiKeyAcknowledge,
        },
      }),
    },
    onSubmit: pendingApiKeyAction
      ? async () => {
          await confirmApiKeyAction(pendingApiKeyAction);
        }
      : undefined,
  });
  const backfillForm = useAppForm({
    defaultValues: { confirmed: false },
    validators: {
      onDynamic: ({ value }) => ({
        fields: {
          confirmed: value.confirmed ? undefined : copy.backfillAcknowledge,
        },
      }),
    },
    onSubmit: async () => {
      await confirmBackfillNodeIps();
    },
  });
  const creatingApiKey = useFormStore(
    apiKeyForm.store,
    (state) => state.isSubmitting,
  );
  const currentKeyAcknowledged = useFormStore(
    apiKeyActionForm.store,
    (state) => state.values.acknowledged,
  );
  const submittingApiKeyAction = useFormStore(
    apiKeyActionForm.store,
    (state) => state.isSubmitting,
  );
  const backfillNodeIpsConfirmed = useFormStore(
    backfillForm.store,
    (state) => state.values.confirmed,
  );
  const submittingBackfill = useFormStore(
    backfillForm.store,
    (state) => state.isSubmitting,
  );
  useSessionDraft(serverSettingsDialogOpen);
  // a session transition must erase one-time credentials even when the settings dialog stays open.
  useEffect(() => {
    setCreatedApiKey("");
    setBackfillNodeIpsResult("");
  }, [authorization?.identity?.workerId, authorization?.identity?.sessionId]);

  const section = location.pathname.replace(/\/+$/, "").slice(1).toLowerCase();
  const activeSection: ProductSection = (
    productSections as readonly string[]
  ).includes(section)
    ? (section as ProductSection)
    : "home";

  const pageTitle = `${copy.nav[activeSection]} · ${currentProfileLabel} · Headscale UI`;
  useEffect(() => {
    document.title = pageTitle;
  }, [pageTitle]);

  function setProfileMenuOpen(open: boolean) {
    setProfileMenuOpenState(open);
    if (!open) setPreferenceMenu(null);
  }

  // Base UI opens these submenus on hover and ignores mouse presses; a click opens one at once.
  function preferenceSubmenu(menu: PreferenceMenu) {
    return {
      open: preferenceMenu === menu,
      onOpenChange: (open: boolean, eventDetails: { reason: string }) => {
        // A second press on the open trigger must not toggle the submenu shut.
        if (!open && eventDetails.reason === "trigger-press") return;
        setPreferenceMenu((current) =>
          open ? menu : current === menu ? null : current,
        );
      },
    };
  }
  function openPreferenceMenu(menu: PreferenceMenu) {
    if (preferenceMenu !== menu) setPreferenceMenu(menu);
  }

  function logoutToLogin() {
    setProfileMenuOpen(false);
    logout();
    void navigate({ to: "/login", search: { redirect: location.href } });
  }

  function openServerSettings() {
    setProfileMenuOpen(false);
    setServerSettingsTab("apiKeys");
    setServerSettingsDialogOpen(true);
    setCreatedApiKey("");
    apiKeyForm.reset(
      { expiration: defaultExpirationLocal(API_KEY_EXPIRY_DAYS) },
      { keepDefaultValues: true },
    );
    clearActionFeedback("api-key-create");
    clearActionFeedback("api-key-action");
    clearActionFeedback("backfill-node-ips");
  }

  // Close-only: the dialog has no trigger, so Base UI only ever reports closing.
  function closeServerSettings() {
    if (
      apiKeyForm.state.isSubmitting ||
      apiKeyActionForm.state.isSubmitting ||
      backfillForm.state.isSubmitting ||
      isActionPending("api-key-create") ||
      isActionPending("api-key-action") ||
      isActionPending("backfill-node-ips")
    ) {
      return;
    }
    setServerSettingsDialogOpen(false);
    setCreatedApiKey("");
    setBackfillNodeIpsResult("");
    clearActionFeedback("api-key-create");
    clearActionFeedback("api-key-action");
  }

  function requestApiKeyAction(kind: ApiKeyActionTarget["kind"], key: ApiKey) {
    clearActionFeedback("api-key-action");
    apiKeyActionForm.reset();
    setPendingApiKeyAction({ kind, key });
  }

  // Close-only: the dialog has no trigger, so Base UI only ever reports closing.
  function closeApiKeyActionDialog() {
    if (isActionPending("api-key-action")) return;
    setPendingApiKeyAction(null);
    apiKeyActionForm.reset();
    clearActionFeedback("api-key-action");
  }

  const { mutate, mutateWith } = useMutation();

  async function createServerApiKey(expiration: string): Promise<void> {
    const created = await mutateWith("api-key-create", {
      endpoint: "createApiKey",
      input: { expiration: dateTimeLocalToIso(expiration) },
    });
    if (created.ok) {
      setCreatedApiKey(created.result.apiKey);
    }
  }

  async function confirmApiKeyAction(
    target: ApiKeyActionTarget,
  ): Promise<void> {
    if (
      !session.drafts.isCurrent() ||
      isActionPending("api-key-action") ||
      !target.key.prefix ||
      (pendingKeyIsCurrent && !apiKeyActionForm.state.values.acknowledged)
    )
      return;
    const completed = await (target.kind === "expire"
      ? mutate("api-key-action", {
          endpoint: "expireApiKey",
          input: { prefix: target.key.prefix },
        })
      : mutate("api-key-action", {
          endpoint: "deleteApiKey",
          input: { prefix: target.key.prefix },
        }));
    if (completed) {
      // The one-time secret of a key that no longer works must not stay on screen.
      if (listedApiKeyPrefix(createdApiKey) === target.key.prefix)
        setCreatedApiKey("");
      closeApiKeyActionDialog();
    }
  }

  function openBackfillNodeIpsDialog() {
    clearActionFeedback("backfill-node-ips");
    backfillForm.reset();
    setBackfillNodeIpsResult("");
    setBackfillNodeIpsDialogOpen(true);
  }

  // Close-only: the dialog has no trigger, so Base UI only ever reports closing.
  function closeBackfillNodeIpsDialog() {
    if (isActionPending("backfill-node-ips")) return;
    setBackfillNodeIpsDialogOpen(false);
    backfillForm.reset();
    clearActionFeedback("backfill-node-ips");
  }

  async function confirmBackfillNodeIps(): Promise<void> {
    if (!session.drafts.isCurrent() || isActionPending("backfill-node-ips"))
      return;
    setBackfillNodeIpsResult("");
    const backfilled = await mutateWith("backfill-node-ips", {
      endpoint: "backfillNodeIps",
      input: { confirmed: true },
    });
    if (backfilled.ok) {
      setBackfillNodeIpsResult(
        (backfilled.result.changes ?? []).join(", ") || copy.backfillNoChanges,
      );
      closeBackfillNodeIpsDialog();
    }
  }

  function renderWriteError(
    key: "api-key-create" | "api-key-action" | "backfill-node-ips",
  ) {
    const error = actionError(key);
    if (!error) return null;
    const outcome = actionOutcome(key);
    if (outcome && ["unknown", "possibly-applied"].includes(outcome.status))
      return (
        <div data-testid={`${key}-notice`}>
          <Notice tone="warning" title={copy.feedbackPossiblyApplied}>
            <p>{t("sessionOutcomeUnknown")}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid={`${key}-verify`}
              onClick={() => {
                if (key === "backfill-node-ips") {
                  closeBackfillNodeIpsDialog();
                  closeServerSettings();
                  void navigate({ to: "/devices" });
                } else {
                  closeApiKeyActionDialog();
                  setServerSettingsTab("apiKeys");
                  document
                    .querySelector('[data-testid="api-key-table"]')
                    ?.scrollIntoView({ block: "nearest" });
                }
              }}
            >
              {key === "backfill-node-ips"
                ? copy.viewMachines
                : copy.apiKeysTitle}
            </Button>
            <details>
              <summary className="cursor-pointer text-muted-foreground">
                {copy.details}
              </summary>
              <p className="mt-2 break-words" data-testid={`${key}-error`}>
                {error}
              </p>
            </details>
          </Notice>
        </div>
      );
    return (
      <p
        className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        data-testid={`${key}-error`}
      >
        {error}
      </p>
    );
  }

  const { formatDate } = useDisplayHelpers();
  const currentApiKeyPrefix = authorization?.apiKeyPrefix ?? null;
  const pendingKeyIsCurrent =
    currentApiKeyPrefix !== null &&
    pendingApiKeyAction?.key.prefix === currentApiKeyPrefix;

  // A new route is a new context for the previous action's error; a search-only change is not.
  const previousPath = useRef(location.pathname);
  useEffect(() => {
    if (previousPath.current === location.pathname) return;
    previousPath.current = location.pathname;
    setFeedbackState({ lastError: "" });
  }, [location.pathname, setFeedbackState]);

  const createdApiKeyRef = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    if (createdApiKey) createdApiKeyRef.current?.focus();
  }, [createdApiKey]);

  useEffect(() => {
    if (!refreshNotice) return;
    const timer = setTimeout(clearRefreshNotice, 4000);
    return () => clearTimeout(timer);
  }, [refreshNotice, clearRefreshNotice]);

  const backfillResultRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (backfillNodeIpsResult)
      backfillResultRef.current?.scrollIntoView({ block: "nearest" });
  }, [backfillNodeIpsResult]);

  // direction changes move the active link inside the nav, not the document.
  useEffect(() => {
    const activeTab = document.querySelector<HTMLElement>(
      `[data-testid="section-${activeSection}"]`,
    );
    if (!activeTab || !isAuthorized || !isReady) return;
    const x = window.scrollX;
    const y = window.scrollY;
    activeTab.scrollIntoView({ block: "nearest", inline: "center" });
    window.scrollTo(x, y);
  }, [activeSection, isAuthorized, isReady, meta.dir]);

  return (
    <div className="min-h-screen bg-background">
      {!isAuthorized || (!isReady && !stale) ? (
        <main
          className="flex min-h-screen flex-col items-center justify-center gap-3 p-4 text-sm text-muted-foreground"
          data-testid="session-loading"
        >
          {Object.keys(refreshErrors).length === 0 || isRefreshingSnapshot ? (
            <div
              className="flex items-center gap-3"
              data-testid="session-loading-progress"
            >
              <LoaderCircle
                className="h-5 w-5 animate-spin"
                aria-hidden="true"
              />
              <span>{t("checkingCredentials")}</span>
            </div>
          ) : null}
          <ServerVersionNotice version={snapshot.version?.version} />
          {Object.keys(refreshErrors).length > 0 && (
            <>
              <p data-testid="initial-snapshot-error">
                {[...new Set(Object.values(refreshErrors))].join(" · ")}
              </p>
              <div className="flex gap-2">
                <Button
                  data-testid="retry-initial-snapshot"
                  disabled={isRefreshingSnapshot}
                  onClick={() => void refreshSnapshot()}
                >
                  {t("tryAgain")}
                </Button>
                <Button
                  variant="outline"
                  data-testid="initial-snapshot-logout"
                  onClick={logoutToLogin}
                >
                  {t("logout")}
                </Button>
              </div>
            </>
          )}
        </main>
      ) : (
        <div className="min-h-screen bg-background text-foreground">
          <header
            className="sticky top-0 z-20 bg-card/95 shadow-sm backdrop-blur"
            data-testid="app-header"
          >
            <div className="container mx-auto flex w-full min-w-0 flex-col gap-0 px-3 pt-2 md:px-4">
              <div
                className="flex min-h-11 min-w-0 items-center justify-between gap-2"
                data-testid="header-primary-row"
              >
                <div
                  className="flex shrink-0 items-center gap-2"
                  data-testid="app-logo"
                >
                  <HeadscaleLogo className="h-8 w-8" />
                  <span className="text-sm font-semibold leading-none sm:text-base">
                    Headscale UI
                  </span>
                </div>

                <div className="ms-auto flex min-w-0 items-center gap-1">
                  <bdi
                    dir="auto"
                    className="min-w-0 max-w-40 truncate text-xs text-muted-foreground sm:max-w-xs"
                    data-testid="current-server-context"
                    title={currentProfileLabel}
                  >
                    {currentProfileLabel}
                  </bdi>
                  <a
                    className={buttonVariants({
                      variant: "ghost",
                      size: "icon",
                    })}
                    href={githubRepositoryUrl}
                    target="_blank"
                    rel="noreferrer"
                    title="GitHub"
                    aria-label="GitHub"
                    data-testid="github-repository-link"
                  >
                    <GithubIcon className="h-5 w-5" aria-hidden="true" />
                  </a>

                  <DropdownMenu
                    open={profileMenuOpen}
                    onOpenChange={setProfileMenuOpen}
                  >
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon"
                          data-testid="profile-menu-trigger"
                          className="relative"
                          aria-label={t("profile")}
                        />
                      }
                    >
                      <CircleUserRound className="h-5 w-5" aria-hidden="true" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      className="w-64"
                      data-testid="profile-menu"
                    >
                      <DropdownMenuGroup>
                        <DropdownMenuLabel className="flex items-center gap-2">
                          <CircleUserRound
                            className="h-4 w-4"
                            aria-hidden="true"
                          />
                          <span className="min-w-0 truncate">
                            {currentProfileLabel}
                          </span>
                        </DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuSub {...preferenceSubmenu("language")}>
                          <DropdownMenuSubTrigger
                            data-testid="language-menu-trigger"
                            aria-busy={pendingLocale !== null}
                            onClick={() => openPreferenceMenu("language")}
                          >
                            <Languages className="h-4 w-4" aria-hidden="true" />
                            <span>{t("language")}</span>
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent
                            className="w-48"
                            side="inline-start"
                            sideOffset={8}
                            alignOffset={0}
                          >
                            <LocaleRadioItems
                              onChosen={() => setProfileMenuOpen(false)}
                            />
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                        <DropdownMenuSub {...preferenceSubmenu("theme")}>
                          <DropdownMenuSubTrigger
                            data-testid="theme-menu-trigger"
                            onClick={() => openPreferenceMenu("theme")}
                          >
                            <ThemeModeIcon
                              mode={colorMode}
                              className="h-4 w-4"
                            />
                            <span>{t("theme")}</span>
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent
                            className="w-44"
                            side="inline-start"
                            sideOffset={8}
                            alignOffset={0}
                          >
                            <ThemeRadioItems
                              onChosen={() => setProfileMenuOpen(false)}
                            />
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          data-testid="open-server-settings"
                          onClick={openServerSettings}
                        >
                          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                          {copy.openServerSettings}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          data-testid="logout"
                          onClick={logoutToLogin}
                        >
                          <LogOut className="h-4 w-4" aria-hidden="true" />
                          {t("logout")}
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              <nav
                aria-label={t("primaryNavigation")}
                className="flex h-9 w-full min-w-0 max-w-full justify-start overflow-x-auto"
                data-testid="header-navigation"
                dir={meta.dir}
              >
                {productSections.map((section) => (
                  <Link
                    key={section}
                    to={`/${section}`}
                    data-testid={`section-${section}`}
                    aria-current={
                      activeSection === section ? "page" : undefined
                    }
                    className={cn(
                      "inline-flex h-9 flex-none items-center gap-1.5 whitespace-nowrap px-3 text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      activeSection === section
                        ? "font-semibold text-primary"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {createElement(sectionIcons[section], {
                      className: "h-4 w-4",
                      "aria-hidden": true,
                    })}
                    {copy.nav[section]}
                  </Link>
                ))}
              </nav>
            </div>
          </header>

          <main
            className="container mx-auto min-w-0 space-y-3 px-3 pb-6 pt-4 sm:px-4 sm:py-4 lg:px-5"
            data-testid="page-body"
          >
            <ServerVersionNotice version={snapshot.version?.version} />
            <p data-testid="refresh-status" className="sr-only">
              {refreshNotice ? copy.dataRefreshed : null}
            </p>
            {lastError ? (
              <div
                data-testid="action-error"
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {lastError === SAVED_LOCKED_ERROR
                  ? t("sessionSavedLocked")
                  : lastError}
              </div>
            ) : null}
            <SnapshotFeedbackStatus
              refreshErrors={refreshErrors}
              refreshing={isRefreshingSnapshot}
              outcomes={actionOutcomes}
              onRetry={(segments) => void refreshByUser(segments)}
            />
            {pendingLocale ? (
              <p
                data-testid="locale-pending"
                className="text-sm text-muted-foreground"
              >
                {t("languageLoading")}
              </p>
            ) : null}
            {settingsError ? (
              <p
                data-testid="settings-error"
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {t("preferencesReloadFailed")}
              </p>
            ) : null}
            <Dialog
              open={serverSettingsDialogOpen}
              onOpenChange={closeServerSettings}
            >
              <DialogContent
                className="sm:max-w-4xl"
                data-testid="server-settings-dialog"
              >
                <DialogHeader>
                  <DialogTitle>{copy.serverSettingsTitle}</DialogTitle>
                  <DialogDescription>
                    {copy.serverSettingsDescription}
                  </DialogDescription>
                </DialogHeader>

                <Tabs
                  className="grid gap-4"
                  dir={meta.dir}
                  value={serverSettingsTab}
                  onValueChange={(value) => setServerSettingsTab(String(value))}
                >
                  <TabsList className="w-full justify-start overflow-x-auto">
                    <TabsTrigger
                      value="apiKeys"
                      data-testid="server-tab-api-keys"
                    >
                      <KeyRound className="h-4 w-4" aria-hidden="true" />
                      {copy.apiKeysTitle}
                    </TabsTrigger>
                    <TabsTrigger
                      value="maintenance"
                      data-testid="server-tab-maintenance"
                    >
                      <Server className="h-4 w-4" aria-hidden="true" />
                      {copy.maintenance}
                    </TabsTrigger>
                    <TabsTrigger
                      value="security"
                      data-testid="server-tab-security"
                    >
                      <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                      {t("encryptionSectionTitle")}
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent
                    value="apiKeys"
                    className="grid gap-4"
                    data-testid="api-key-settings"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="grid gap-2">
                        <h3 className="text-sm font-semibold">
                          {copy.apiKeysTitle}
                        </h3>
                        <p className="text-sm text-muted-foreground">
                          {copy.apiKeysDescription}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        data-testid="refresh-api-keys"
                        aria-label={copy.refreshData}
                        title={copy.refreshData}
                        disabled={isRefreshingSnapshot}
                        onClick={() => void refreshByUser()}
                      >
                        {isRefreshingSnapshot ? (
                          <LoaderCircle
                            className="h-4 w-4 animate-spin"
                            aria-hidden="true"
                          />
                        ) : (
                          <RefreshCw className="h-4 w-4" aria-hidden="true" />
                        )}
                      </Button>
                    </div>
                    <div className="grid gap-3 rounded-md border bg-background p-3">
                      <apiKeyForm.AppForm>
                        <apiKeyForm.Form className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
                          <apiKeyForm.Field name="expiration">
                            {(field) => (
                              <div className="grid gap-2">
                                <Label htmlFor="api-key-expiration">
                                  {copy.apiKeyExpiration}
                                </Label>
                                <DateTimePicker
                                  id="api-key-expiration"
                                  locale={locale}
                                  placeholder={copy.dateTimePlaceholder}
                                  testId="api-key-expiration"
                                  value={field.state.value}
                                  error={
                                    field.state.meta.isTouched
                                      ? field.state.meta.errors.join(" ")
                                      : undefined
                                  }
                                  onValueChange={field.handleChange}
                                  onBlur={field.handleBlur}
                                  disabled={
                                    creatingApiKey ||
                                    isActionPending("api-key-create") ||
                                    stale !== null
                                  }
                                  timeLabel={copy.time}
                                  hourLabel={copy.hour}
                                  minuteLabel={copy.minute}
                                />
                              </div>
                            )}
                          </apiKeyForm.Field>
                          <apiKeyForm.SubmitButton
                            data-testid="create-api-key-confirm"
                            disabled={stale !== null}
                            busy={isActionPending("api-key-create")}
                          >
                            {!creatingApiKey &&
                            !isActionPending("api-key-create") ? (
                              <Plus className="h-4 w-4" aria-hidden="true" />
                            ) : null}
                            {copy.createApiKeyTitle}
                          </apiKeyForm.SubmitButton>
                          {renderWriteError("api-key-create")}
                        </apiKeyForm.Form>
                      </apiKeyForm.AppForm>
                      {createdApiKey ? (
                        <fieldset
                          ref={createdApiKeyRef}
                          tabIndex={-1}
                          aria-labelledby="created-api-key-title"
                          aria-describedby="created-api-key-note"
                          className="grid min-w-0 gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-900 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300"
                          data-testid="created-api-key"
                        >
                          <p
                            id="created-api-key-title"
                            className="text-sm font-semibold"
                          >
                            {copy.createdApiKey}
                          </p>
                          <code
                            dir="ltr"
                            className="break-all rounded bg-background/70 px-2 py-1 text-xs text-foreground"
                          >
                            {createdApiKey}
                          </code>
                          <p id="created-api-key-note" className="text-xs">
                            {copy.apiKeyOnlyShownOnce}
                          </p>
                          <CopyButton
                            variant="outline"
                            size="sm"
                            className="w-fit"
                            data-testid="copy-created-api-key"
                            value={createdApiKey}
                          >
                            {copy.copy}
                          </CopyButton>
                        </fieldset>
                      ) : null}
                    </div>
                    <Card
                      role="region"
                      aria-label={copy.apiKeysTitle}
                      tabIndex={0}
                      className="overflow-x-auto [&>[data-slot=table-container]]:overflow-visible"
                      data-testid="api-key-table"
                    >
                      <Table aria-label={copy.apiKeysTitle}>
                        <TableHeader>
                          <TableRow>
                            <TableHead>{copy.apiKeyPrefix}</TableHead>
                            <TableHead>{copy.status}</TableHead>
                            <TableHead>{copy.apiKeyCreatedAt}</TableHead>
                            <TableHead>{copy.expires}</TableHead>
                            <TableHead>{copy.apiKeyLastUsed}</TableHead>
                            <TableHead>{copy.actions}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {snapshot.apiKeys.length === 0 ? (
                            <TableRow>
                              <TableCell
                                colSpan={6}
                                className="py-6 text-center text-sm text-muted-foreground"
                                data-testid="api-key-empty"
                              >
                                {copy.noApiKeys}
                              </TableCell>
                            </TableRow>
                          ) : null}
                          {snapshot.apiKeys.map((key) => (
                            <TableRow
                              key={key.id}
                              data-testid={`api-key-row-${key.prefix}`}
                            >
                              <TableCell className="font-mono text-xs">
                                {key.prefix}
                                {currentApiKeyPrefix !== null &&
                                key.prefix === currentApiKeyPrefix ? (
                                  <Badge
                                    variant="secondary"
                                    className="ms-2 font-sans"
                                    data-testid={`api-key-current-${key.prefix}`}
                                  >
                                    {copy.currentApiKeyBadge}
                                  </Badge>
                                ) : null}
                              </TableCell>
                              <TableCell>
                                <Badge
                                  variant="outline"
                                  className={apiKeyStatusClass(key)}
                                  data-testid={`api-key-status-${key.prefix}`}
                                >
                                  {isTimestampExpired(key.expiration)
                                    ? copy.expiredOnly
                                    : copy.statusActive}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-sm text-muted-foreground">
                                {formatDate(key.createdAt)}
                              </TableCell>
                              <TableCell className="text-sm text-muted-foreground">
                                {formatDate(key.expiration)}
                              </TableCell>
                              <TableCell
                                className="text-sm text-muted-foreground"
                                data-testid={`api-key-last-used-${key.prefix}`}
                              >
                                {/* Headscale v0.29 does not record when an API key was last used. */}
                                {key.lastSeen
                                  ? formatDate(key.lastSeen)
                                  : copy.notReported}
                              </TableCell>
                              <TableCell>
                                <div className="flex justify-start">
                                  <DropdownMenu>
                                    <DropdownMenuTrigger
                                      render={
                                        <Button
                                          type="button"
                                          variant="outline"
                                          size="icon"
                                          data-testid={`api-key-actions-trigger-${key.prefix}`}
                                          aria-label={`${copy.actions}: ${key.prefix}`}
                                        />
                                      }
                                    >
                                      <EllipsisVertical
                                        className="h-4 w-4"
                                        aria-hidden="true"
                                      />
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent
                                      align="end"
                                      className="w-56"
                                      data-testid={`api-key-actions-menu-${key.prefix}`}
                                    >
                                      <DropdownMenuGroup>
                                        <DropdownMenuLabel>
                                          {copy.actions}
                                        </DropdownMenuLabel>
                                        <DropdownMenuSeparator />
                                        {isTimestampExpired(
                                          key.expiration,
                                        ) ? null : (
                                          <DropdownMenuItem
                                            data-testid={`expire-api-key-${key.prefix}`}
                                            onClick={() =>
                                              requestApiKeyAction("expire", key)
                                            }
                                          >
                                            <Clock
                                              className="h-4 w-4"
                                              aria-hidden="true"
                                            />
                                            {copy.expireApiKeyTitle}
                                          </DropdownMenuItem>
                                        )}
                                        <DropdownMenuItem
                                          variant="destructive"
                                          data-testid={`delete-api-key-${key.prefix}`}
                                          onClick={() =>
                                            requestApiKeyAction("delete", key)
                                          }
                                        >
                                          <Trash2
                                            className="h-4 w-4"
                                            aria-hidden="true"
                                          />
                                          {copy.deleteApiKeyTitle}
                                        </DropdownMenuItem>
                                      </DropdownMenuGroup>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                </div>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </Card>
                  </TabsContent>

                  <TabsContent
                    value="maintenance"
                    className="grid gap-4"
                    data-testid="server-maintenance-settings"
                  >
                    <div className="grid gap-2">
                      <h3 className="text-sm font-semibold">
                        {copy.maintenance}
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        {copy.maintenanceDescription}
                      </p>
                    </div>
                    <Card className="grid gap-3 p-4">
                      <div>
                        <h4 className="text-sm font-semibold">
                          {copy.backfillNodeIps}
                        </h4>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {copy.backfillNodeIpsDescription}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        className="w-fit"
                        data-testid="open-backfill-node-ips"
                        onClick={openBackfillNodeIpsDialog}
                      >
                        <Server className="h-4 w-4" aria-hidden="true" />
                        {copy.backfillNodeIps}
                      </Button>
                      {backfillNodeIpsResult ? (
                        <p
                          ref={backfillResultRef}
                          tabIndex={-1}
                          className="rounded-md bg-muted px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                          data-testid="backfill-node-ips-result"
                        >
                          {copy.backfillResult}: {backfillNodeIpsResult}
                        </p>
                      ) : null}
                    </Card>
                  </TabsContent>

                  <TabsContent
                    value="security"
                    className="grid gap-4"
                    data-testid="security-settings"
                  >
                    <SecuritySettings
                      profile={profiles.find(
                        (profile) => profile.id === authorization?.profile?.id,
                      )}
                    />
                  </TabsContent>
                </Tabs>
              </DialogContent>
            </Dialog>

            <AlertDialog
              open={Boolean(pendingApiKeyAction)}
              onOpenChange={() => {
                if (!apiKeyActionForm.state.isSubmitting)
                  closeApiKeyActionDialog();
              }}
            >
              {pendingApiKeyAction ? (
                <apiKeyActionForm.AppForm>
                  <AlertDialogContent
                    data-testid={
                      pendingApiKeyAction.kind === "expire"
                        ? "expire-api-key-dialog"
                        : "delete-api-key-dialog"
                    }
                  >
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        {pendingApiKeyAction.kind === "expire"
                          ? copy.expireApiKeyTitle
                          : copy.deleteApiKeyTitle}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {pendingApiKeyAction.kind === "expire"
                          ? copy.expireApiKeyDescription
                          : copy.deleteApiKeyDescription}
                        <span className="mt-2 block font-mono text-xs text-foreground">
                          {pendingApiKeyAction.key.prefix}
                        </span>
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    {pendingKeyIsCurrent ? (
                      <apiKeyActionForm.Form
                        id="api-key-action-form"
                        className="grid gap-3"
                      >
                        <p
                          data-testid="api-key-current-warning"
                          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
                        >
                          {copy.currentApiKeyWarning}
                        </p>
                        <apiKeyActionForm.AppField name="acknowledged">
                          {(field) => (
                            <field.CheckboxField
                              id="api-key-current-ack"
                              data-testid="api-key-current-ack"
                              label={copy.currentApiKeyAcknowledge}
                              fieldClassName="rounded-md border bg-background p-3 text-sm"
                              disabled={
                                submittingApiKeyAction ||
                                isActionPending("api-key-action") ||
                                stale !== null
                              }
                            />
                          )}
                        </apiKeyActionForm.AppField>
                      </apiKeyActionForm.Form>
                    ) : null}
                    <AlertDialogFooter>
                      <AlertDialogCancel
                        type="button"
                        data-testid="cancel-api-key-action"
                        disabled={
                          submittingApiKeyAction ||
                          isActionPending("api-key-action")
                        }
                      >
                        {copy.cancel}
                      </AlertDialogCancel>
                      {pendingKeyIsCurrent ? (
                        <apiKeyActionForm.SubmitButton
                          form="api-key-action-form"
                          variant="destructive"
                          data-testid="confirm-api-key-action"
                          disabled={
                            !currentKeyAcknowledged ||
                            !pendingApiKeyAction.key.prefix ||
                            stale !== null
                          }
                          busy={isActionPending("api-key-action")}
                        >
                          {pendingApiKeyAction.kind === "expire"
                            ? copy.confirmExpireApiKey
                            : copy.confirmDeleteApiKey}
                        </apiKeyActionForm.SubmitButton>
                      ) : (
                        <Button
                          type="button"
                          variant="destructive"
                          data-testid="confirm-api-key-action"
                          disabled={
                            isActionPending("api-key-action") ||
                            !pendingApiKeyAction.key.prefix ||
                            stale !== null
                          }
                          onClick={() =>
                            confirmApiKeyAction(pendingApiKeyAction)
                          }
                        >
                          {isActionPending("api-key-action") ? (
                            <LoaderCircle
                              className="h-4 w-4 animate-spin"
                              aria-hidden="true"
                            />
                          ) : null}
                          {pendingApiKeyAction.kind === "expire"
                            ? copy.confirmExpireApiKey
                            : copy.confirmDeleteApiKey}
                        </Button>
                      )}
                    </AlertDialogFooter>
                    {renderWriteError("api-key-action")}
                  </AlertDialogContent>
                </apiKeyActionForm.AppForm>
              ) : null}
            </AlertDialog>

            <AlertDialog
              open={backfillNodeIpsDialogOpen}
              onOpenChange={() => {
                if (!backfillForm.state.isSubmitting)
                  closeBackfillNodeIpsDialog();
              }}
            >
              <AlertDialogContent
                data-testid="backfill-node-ips-dialog"
                finalFocus={backfillResultRef}
              >
                <AlertDialogHeader>
                  <AlertDialogTitle>{copy.backfillNodeIps}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {copy.backfillNodeIpsDescription}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <backfillForm.AppForm>
                  <backfillForm.Form className="grid gap-4">
                    <backfillForm.AppField name="confirmed">
                      {(field) => (
                        <field.CheckboxField
                          id="backfill-node-ips-confirmed"
                          data-testid="backfill-node-ips-confirmed"
                          label={copy.backfillAcknowledge}
                          fieldClassName="rounded-md border bg-background p-3 text-sm"
                          disabled={
                            submittingBackfill ||
                            isActionPending("backfill-node-ips") ||
                            stale !== null
                          }
                        />
                      )}
                    </backfillForm.AppField>
                    <AlertDialogFooter>
                      <AlertDialogCancel
                        type="button"
                        data-testid="cancel-backfill-node-ips"
                        disabled={
                          submittingBackfill ||
                          isActionPending("backfill-node-ips")
                        }
                      >
                        {copy.cancel}
                      </AlertDialogCancel>
                      <backfillForm.SubmitButton
                        variant="destructive"
                        data-testid="confirm-backfill-node-ips"
                        disabled={!backfillNodeIpsConfirmed || stale !== null}
                        busy={isActionPending("backfill-node-ips")}
                      >
                        {copy.confirmBackfillNodeIps}
                      </backfillForm.SubmitButton>
                    </AlertDialogFooter>
                    {renderWriteError("backfill-node-ips")}
                  </backfillForm.Form>
                </backfillForm.AppForm>
              </AlertDialogContent>
            </AlertDialog>

            <Outlet />
          </main>
        </div>
      )}
    </div>
  );
}

function ServerVersionNotice({ version }: { version: string | undefined }) {
  const { t } = useHeadscaleI18n();
  if (version === undefined || serverVersionSupport(version) !== "unsupported")
    return null;
  return (
    <p
      data-testid="server-version-warning"
      className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
    >
      {t("unsupportedServerVersion", { version: isolateVersion(version) })}
    </p>
  );
}
