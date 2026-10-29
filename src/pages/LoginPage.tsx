import { useBlocker, useNavigate, useSearch } from "@tanstack/react-router";
import {
  AlertCircle,
  Languages,
  LoaderCircle,
  Lock,
  LockKeyhole,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ConnectionDialog from "@/components/ConnectionDialog";
import GithubIcon from "@/components/GithubIcon";
import HeadscaleLogo from "@/components/HeadscaleLogo";
import {
  LocaleRadioItems,
  ThemeModeIcon,
  ThemeRadioItems,
  themeModeLabel,
} from "@/components/PreferenceMenuItems";
import UnlockOverlay from "@/components/UnlockOverlay";
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
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSession, useStore } from "@/composables/session-context";
import { useActionFeedback } from "@/composables/useActionFeedback";
import { useConnectionDialog } from "@/composables/useConnectionDialog";
import { useDisplayHelpers } from "@/composables/useDisplayHelpers";
import {
  newProfileId,
  SAVED_LOCKED_ERROR,
  useProfiles,
} from "@/composables/useProfiles";
import { useProfileVisuals } from "@/composables/useProfileVisuals";
import { useResetLocalData } from "@/composables/useResetLocalData";
import { useTheme } from "@/composables/useTheme";
import { LOCALE_META, useHeadscaleI18n } from "@/i18n";
import type { MessageKey } from "@/i18n/descriptors";
import type { ProfileSummary } from "@/lib/profile-storage";
import { cn } from "@/lib/utils";
import { redirectTarget } from "@/router/search";
import type { PublicSessionSnapshot } from "@/session/types";

/** Why a page that was sent here must ask for the profile password again. */
const lockNotices = {
  initial: "loginNoticeNoSession",
  user: "loginNoticeLoggedOut",
  expired: "loginNoticeExpired",
  "clock-reversed": "loginNoticeClockReversed",
  "profile-changed": "loginNoticeProfileChanged",
} as const satisfies Record<
  NonNullable<PublicSessionSnapshot["reason"]>,
  MessageKey
>;

export default function LoginPage({
  reloadPage = window.location.assign.bind(window.location),
}: {
  reloadPage?: (href: string) => void;
}) {
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const clearInFlight = useRef(false);
  const session = useSession();
  // Choosing a profile keeps the existing policy draft in memory, unlike logging out.
  useBlocker({
    shouldBlockFn: () => false,
    enableBeforeUnload: () => session.policy.isPolicyDirty,
  });
  const { session: auth, status: authStatus } = useStore(session.auth);
  const githubRepositoryUrl = "https://github.com/MunMunMiao/headscale-ui";
  const { t, locale, pendingLocale, settingsError } = useHeadscaleI18n();
  const pageTitle = `${t("profileSelectorTitle")} · Headscale UI`;
  useEffect(() => {
    document.title = pageTitle;
  }, [pageTitle]);
  const { lastError, setState: setFeedbackState } = useActionFeedback();
  const { clearing, clearAll } = useResetLocalData({
    inFlight: clearInFlight,
    search: { cleared: "1" },
    reloadPage,
    onStart() {
      setClearConfirmOpen(false);
      setFeedbackState({ lastError: "" });
    },
    onError: (message) => setFeedbackState({ lastError: message }),
  });
  const {
    profiles,
    version: profilesVersion,
    isConnecting,
    authenticatingProfileId,
    connectionDialogOpen,
    pendingDeleteProfile,
    unlockProfile,
    unreadableRecords,
    passwordChanged,
    discardedPolicyDraft,
    enterProfile,
    deleteProfile,
    confirmDeleteProfile,
    setState: setProfileState,
  } = useProfiles();
  // These notices explain the lock that brought the user here; leaving the page ends them.
  useEffect(
    () => () =>
      session.profiles.setState({
        passwordChanged: false,
        discardedPolicyDraft: false,
      }),
    [session],
  );
  const { colorMode } = useTheme();
  const { profileVisualState, profileAvatarLabel } = useProfileVisuals();
  const connectionDialog = useConnectionDialog();
  const { openConnectionDialogWithBaseline, editProfileWithBaseline } =
    connectionDialog;
  const navigate = useNavigate();
  const query = useSearch({ strict: false }) as Record<string, unknown>;
  const { formatDate } = useDisplayHelpers();
  function requestDeleteProfile(profile: ProfileSummary) {
    setFeedbackState({ lastError: "" });
    deleteProfile(profile);
  }
  // Close-only: the dialog has no trigger, so Base UI only ever reports closing.
  function closeDeleteProfileDialog() {
    // A running delete keeps its dialog open, so its result is always reported there.
    if (session.profiles.isConnecting) return;
    window.setTimeout(() => setProfileState({ pendingDeleteProfile: null }), 0);
  }
  const unlocked = auth?.status === "unlocked" ? auth : null;
  function continueToServer(profileId: string) {
    return navigate(
      redirectTarget(
        query.redirect,
        {
          id: profileId,
          baseUrl: session.client.getSnapshot().settings.baseUrl,
        },
        session.navigationProfile,
      ),
    );
  }
  async function enterProfileAndRoute(profile: ProfileSummary) {
    if (profile.credentialKind === "unreadable") {
      await editProfileWithBaseline(profile);
      return;
    }
    // Another tab already unlocked this server; the shared session needs no password here.
    if (unlocked?.profile.id === profile.id)
      return continueToServer(profile.id);
    // Without a password this only opens the unlock overlay, which navigates after unlocking.
    await enterProfile(profile);
  }
  const profilesWereCleared = query.cleared === "1";
  const lockReason =
    auth?.status === "locked" && typeof query.redirect === "string"
      ? auth.reason
      : null;
  const firstConnection =
    authStatus === "ready-locked" &&
    profilesVersion !== null &&
    !isConnecting &&
    !lastError &&
    profiles.length === 0 &&
    unreadableRecords === 0;
  const lockNotice = firstConnection
    ? t("loginNoticeFirstConnection")
    : passwordChanged
      ? t("loginNoticePasswordChanged")
      : lockReason
        ? t(lockNotices[lockReason])
        : "";
  const hiddenUnreadable =
    unreadableRecords -
    profiles.filter((profile) => profile.credentialKind === "unreadable")
      .length;
  return (
    <div className="min-h-screen bg-background">
      <div className="min-h-screen bg-background">
        <header className="border-b bg-card text-card-foreground">
          <div className="container mx-auto flex h-14 w-full items-center gap-3 px-4">
            <div className="flex min-w-0 items-center gap-2">
              <HeadscaleLogo className="h-8 w-8 shrink-0" />
              <span className="truncate text-sm font-semibold leading-none sm:text-base">
                Headscale UI
              </span>
            </div>

            <div className="ms-auto flex items-center gap-1 py-1">
              <a
                className={buttonVariants({ variant: "ghost", size: "icon" })}
                href={githubRepositoryUrl}
                target="_blank"
                rel="noreferrer"
                title="GitHub"
                aria-label="GitHub"
                data-testid="github-repository-link"
              >
                <GithubIcon className="h-5 w-5" aria-hidden="true" />
              </a>

              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      data-testid="locale-select"
                      aria-busy={pendingLocale !== null}
                      aria-label={`${t("language")}: ${LOCALE_META[locale].nativeLabel}`}
                    />
                  }
                >
                  <Languages className="h-5 w-5" aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>{t("language")}</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <LocaleRadioItems />
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>

              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      data-testid="theme-select"
                      aria-label={`${t("theme")}: ${themeModeLabel(t, colorMode)}`}
                    />
                  }
                >
                  <ThemeModeIcon mode={colorMode} className="h-5 w-5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>{t("theme")}</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <ThemeRadioItems />
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </header>

        <main className="container mx-auto flex min-h-[calc(100vh-3.5rem)] w-full items-center justify-center px-4 py-8 sm:py-10">
          <div className="w-full max-w-5xl min-w-0 text-center">
            <div className="mx-auto max-w-2xl">
              <h1 className="text-2xl font-semibold sm:text-3xl">
                {t("profileSelectorTitle")}
              </h1>
              <p className="mt-2 text-sm text-muted-foreground sm:text-base">
                {t("profileSelectorDescription")}
              </p>
            </div>

            {/* A dialog that is open reports its own failure, so the page shows it only once.
                A saved-but-locked profile is a finished operation, so it uses one notification. */}
            {lastError &&
            lastError !== SAVED_LOCKED_ERROR &&
            !connectionDialogOpen &&
            !unlockProfile &&
            !pendingDeleteProfile ? (
              <div
                data-testid="login-error"
                className="mx-auto mt-4 max-w-xl rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-start text-sm text-destructive"
              >
                {lastError}
              </div>
            ) : null}
            {pendingLocale ? (
              <p
                data-testid="locale-pending"
                className="mt-4 text-sm text-muted-foreground"
              >
                {t("languageLoading")}
              </p>
            ) : null}
            {settingsError ? (
              <p
                data-testid="settings-error"
                className="mx-auto mt-4 max-w-xl rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-start text-sm text-destructive"
              >
                {t("preferencesReloadFailed")}
              </p>
            ) : null}
            {lockNotice ? (
              <div
                data-testid="login-notice"
                className="mx-auto mt-4 max-w-xl rounded-md border bg-muted/40 px-3 py-2 text-start text-sm text-muted-foreground"
              >
                {lockNotice}
              </div>
            ) : null}
            {discardedPolicyDraft ? (
              <div
                data-testid="login-discarded-policy"
                className="mx-auto mt-4 max-w-xl rounded-md border border-amber-400/50 bg-amber-50 px-3 py-2 text-start text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
              >
                {t("loginNoticeDiscardedPolicy")}
              </div>
            ) : null}
            {unlocked ? (
              <div
                data-testid="login-unlocked"
                className="mx-auto mt-4 flex max-w-xl flex-wrap items-center justify-between gap-2 rounded-md border bg-card px-3 py-2 text-start text-sm"
              >
                <span className="min-w-0 break-words">
                  {t("loginUnlockedNotice", { name: unlocked.profile.name })}
                </span>
                <Button
                  type="button"
                  size="sm"
                  data-testid="login-continue"
                  disabled={clearing}
                  onClick={() => void continueToServer(unlocked.profile.id)}
                >
                  {t("continueToServer")}
                </Button>
              </div>
            ) : null}
            {hiddenUnreadable > 0 ? (
              <div
                data-testid="unreadable-records-notice"
                className="mx-auto mt-4 max-w-xl rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-start text-sm text-muted-foreground"
              >
                {t("unreadableRecordsNotice", { count: hiddenUnreadable })}
              </div>
            ) : null}
            {profilesWereCleared && profiles.length === 0 ? (
              <div
                data-testid="profiles-cleared-notice"
                className="mx-auto mt-4 max-w-xl rounded-md border bg-muted/40 px-3 py-2 text-start text-sm text-muted-foreground"
              >
                {t("profilesClearedNotice")}
              </div>
            ) : null}
            {/* Wrapping rows stay centered under the heading, even with a single card. */}
            <div
              className="mx-auto mt-6 flex max-w-4xl flex-wrap justify-center gap-3"
              data-testid="profile-picker"
            >
              {profiles.map((profile) => (
                <div
                  key={profile.id}
                  className="relative w-full min-w-0 sm:w-52"
                  data-testid={`profile-row-${profile.name}`}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    data-testid={`profile-option-${profile.name}`}
                    className="h-auto min-h-36 w-full flex-col items-center justify-center gap-3 border bg-card p-4 text-center hover:bg-accent hover:text-accent-foreground"
                    aria-busy={authenticatingProfileId === profile.id}
                    disabled={isConnecting || clearing}
                    onClick={() => enterProfileAndRoute(profile)}
                  >
                    <span
                      className={cn(
                        "relative flex h-16 w-16 items-center justify-center rounded-full border bg-background text-lg font-semibold transition-colors",
                        [
                          authenticatingProfileId === profile.id
                            ? "border-primary/50 bg-primary/10 text-primary"
                            : "",
                          profileVisualState(profile) === "corrupted"
                            ? "border-destructive/50"
                            : "",
                        ],
                      )}
                    >
                      {authenticatingProfileId === profile.id ? (
                        <LoaderCircle
                          className="absolute h-[72px] w-[72px] animate-spin"
                          aria-hidden="true"
                          data-testid={`profile-loading-${profile.name}`}
                        />
                      ) : null}
                      <span
                        className={
                          authenticatingProfileId === profile.id
                            ? "opacity-35"
                            : ""
                        }
                      >
                        {profileAvatarLabel(profile)}
                      </span>
                      {profileVisualState(profile) === "password" ? (
                        <span className="absolute -bottom-1 -end-1 flex h-5 w-5 items-center justify-center rounded-full border bg-background text-muted-foreground">
                          <Lock className="h-3 w-3" aria-hidden="true" />
                        </span>
                      ) : profileVisualState(profile) === "locked" ? (
                        <span className="absolute -bottom-1 -end-1 flex h-5 w-5 items-center justify-center rounded-full border bg-background text-primary">
                          <LockKeyhole className="h-3 w-3" aria-hidden="true" />
                        </span>
                      ) : profileVisualState(profile) === "corrupted" ? (
                        <span className="absolute -bottom-1 -end-1 flex h-5 w-5 items-center justify-center rounded-full border bg-background text-destructive">
                          <AlertCircle className="h-3 w-3" aria-hidden="true" />
                        </span>
                      ) : null}
                    </span>
                    <span className="grid w-full min-w-0 gap-1">
                      <span
                        className="truncate text-sm font-semibold"
                        title={profile.name}
                      >
                        {profile.name}
                      </span>
                      <span className="break-all text-xs text-muted-foreground">
                        {profile.baseUrl}
                      </span>
                      {authenticatingProfileId === profile.id ? (
                        <span className="text-xs text-primary">
                          {t("checkingCredentials")}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {t("updatedProfile")} {formatDate(profile.updatedAt)}
                        </span>
                      )}
                      <span className="flex justify-center">
                        {profileVisualState(profile) === "corrupted" ? (
                          <Badge
                            variant="destructive"
                            data-testid={`profile-badge-corrupted-${profile.name}`}
                          >
                            {t("encryptionCorruptedBadge")}
                          </Badge>
                        ) : profileVisualState(profile) === "locked" ? (
                          <Badge
                            variant="default"
                            data-testid={`profile-badge-locked-${profile.name}`}
                          >
                            {t("encryptionLockedBadge")}
                          </Badge>
                        ) : profileVisualState(profile) === "password" ? (
                          <Badge
                            variant="secondary"
                            data-testid={`profile-badge-encrypted-${profile.name}`}
                          >
                            {t("encryptionEncryptedBadge")}
                          </Badge>
                        ) : profileVisualState(profile) === "session" ? (
                          <Badge
                            variant="outline"
                            className="border-amber-400/50 bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
                            data-testid={`profile-badge-session-${profile.name}`}
                          >
                            {t("encryptionSessionOnlyBadge")}
                          </Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            data-testid={`profile-badge-migration-${profile.name}`}
                          >
                            {t("migrationRequired")}
                          </Badge>
                        )}
                      </span>
                    </span>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    data-testid={`edit-profile-${profile.name}`}
                    className="absolute start-2 top-2 h-8 w-8 bg-background/80"
                    aria-label={`${t("editProfile")}: ${profile.name}`}
                    disabled={isConnecting || clearing}
                    onClick={(event) => {
                      event.stopPropagation();
                      void editProfileWithBaseline(profile);
                    }}
                  >
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    data-testid={`delete-profile-${profile.name}`}
                    className="absolute end-2 top-2 h-8 w-8 bg-background/80"
                    aria-label={`${t("deleteProfile")}: ${profile.name}`}
                    disabled={isConnecting || clearing}
                    onClick={(event) => {
                      event.stopPropagation();
                      void requestDeleteProfile(profile);
                    }}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              ))}

              <Button
                type="button"
                variant="ghost"
                data-testid="profile-option-new"
                disabled={clearing}
                className="h-auto min-h-36 w-full flex-col items-center justify-center gap-3 border border-dashed bg-card p-4 text-center hover:bg-accent hover:text-accent-foreground sm:w-52"
                onClick={() => openConnectionDialogWithBaseline(newProfileId)}
              >
                <span className="flex h-14 w-14 items-center justify-center rounded-full border bg-background">
                  <Plus className="h-6 w-6" aria-hidden="true" />
                </span>
                <span className="grid gap-1">
                  <span className="text-sm font-semibold">
                    {t("addServerProfile")}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t("newProfile")}
                  </span>
                </span>
              </Button>
            </div>
            <div className="mt-6">
              <AlertDialog
                open={clearConfirmOpen}
                onOpenChange={setClearConfirmOpen}
              >
                <AlertDialogTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-auto max-w-full whitespace-normal text-destructive hover:bg-destructive/10 hover:text-destructive"
                      data-testid="login-clear-all"
                      disabled={isConnecting || clearing}
                      aria-busy={clearing}
                    />
                  }
                >
                  {clearing ? (
                    <LoaderCircle
                      className="h-4 w-4 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  )}
                  {t("encryptionForgottenButton")}
                </AlertDialogTrigger>
                <AlertDialogContent data-testid="clear-profiles-dialog">
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("forgotConfirmTitle")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("clearProfilesDescription")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel
                      data-testid="login-clear-all-cancel"
                      disabled={clearing}
                    >
                      {t("cancel")}
                    </AlertDialogCancel>
                    <AlertDialogAction
                      data-testid="login-clear-all-confirm"
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      disabled={isConnecting || clearing}
                      onClick={clearAll}
                    >
                      {t("encryptionForgottenButton")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        </main>

        {connectionDialogOpen && (
          <ConnectionDialog
            actions={connectionDialog}
            continueToServer={continueToServer}
          />
        )}

        <AlertDialog
          open={Boolean(pendingDeleteProfile)}
          onOpenChange={closeDeleteProfileDialog}
        >
          <AlertDialogContent data-testid="delete-profile-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("confirmDeleteProfileTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("confirmDeleteProfileDescription")}
                {pendingDeleteProfile ? (
                  <span className="mt-2 block break-all font-medium text-foreground">
                    <bdi dir="auto">{pendingDeleteProfile.name}</bdi>·
                    <bdi dir="auto">{pendingDeleteProfile.baseUrl}</bdi>
                  </span>
                ) : null}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {lastError ? (
              <p
                data-testid="delete-profile-error"
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {lastError === SAVED_LOCKED_ERROR
                  ? t("sessionSavedLocked")
                  : lastError}
              </p>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel
                data-testid="cancel-delete-profile"
                disabled={isConnecting}
              >
                {t("cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                data-testid="confirm-delete-profile"
                disabled={isConnecting}
                onClick={confirmDeleteProfile}
              >
                {isConnecting ? (
                  <LoaderCircle
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : null}
                {t("deleteProfile")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      <UnlockOverlay />
    </div>
  );
}
