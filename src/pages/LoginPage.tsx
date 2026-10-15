import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  AlertCircle,
  KeyRound,
  Languages,
  LoaderCircle,
  Lock,
  LockKeyhole,
  Pencil,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { sendsApiKeyInClear } from "@/api/connection";
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
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CopyButton } from "@/components/ui/copy-button";
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
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession, useStore } from "@/composables/session-context";
import { useActionFeedback } from "@/composables/useActionFeedback";
import { useConnectionDialog } from "@/composables/useConnectionDialog";
import { useDisplayHelpers } from "@/composables/useDisplayHelpers";
import { MIN_PROFILE_PASSWORD_LENGTH, newProfileId, useProfiles } from "@/composables/useProfiles";
import { useProfileValidationFlow } from "@/composables/useProfileValidationFlow";
import { useProfileVisuals } from "@/composables/useProfileVisuals";
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
} as const satisfies Record<NonNullable<PublicSessionSnapshot["reason"]>, MessageKey>;

export default function LoginPage() {
  const apiKeyCommand = "headscale apikeys create --expiration 90d";
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  // A submit attempt shows the new-password rules inline even before the confirmation is typed.
  const [passwordChecked, setPasswordChecked] = useState(false);
  const [activating, setActivating] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmationRef = useRef<HTMLInputElement>(null);
  const session = useSession();
  const auth = useStore(session.auth).session;
  const headscaleRemoteCliDocsUrl = "https://docs.headscale.org/ref/remote-cli/";
  const githubRepositoryUrl = "https://github.com/MunMunMiao/headscale-ui";
  const { t, locale, pendingLocale, localeError, settingsError } = useHeadscaleI18n();
  const { lastError, setState: setFeedbackState } = useActionFeedback();
  const {
    profiles,
    connectionForm,
    isConnecting,
    authenticatingProfileId,
    selectedProfile,
    connectionDialogOpen,
    connectionCloseConfirmOpen,
    profileValidationDialogOpen,
    profileValidationError,
    pendingDeleteProfile,
    unlockProfile,
    unreadableRecords,
    passwordChanged,
    discardedPolicyDraft,
    enterProfile,
    deleteProfile,
    confirmDeleteProfile,
    setState: setProfileState,
    setConnectionForm,
  } = useProfiles();
  useEffect(() => {
    if (connectionDialogOpen) return;
    setPasswordConfirmation("");
    setPasswordChecked(false);
  }, [connectionDialogOpen]);
  // These notices explain the lock that brought the user here; leaving the page ends them.
  useEffect(
    () => () => session.profiles.setState({ passwordChanged: false, discardedPolicyDraft: false }),
    [session],
  );
  const { colorMode, themeError } = useTheme();
  const { profileVisualState, profileAvatarLabel } = useProfileVisuals();
  const {
    syncConnectionFormBaseline,
    openConnectionDialogWithBaseline,
    editProfileWithBaseline,
    requestConnectionDialogClose,
    confirmConnectionDialogClose,
    handleConnectionDialogOpen,
    handleConnectionCloseConfirmOpen,
  } = useConnectionDialog();
  const { reviewProfileConnection, continueAddingProfile, submitAddProfile } =
    useProfileValidationFlow(syncConnectionFormBaseline);
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
    return navigate(redirectTarget(query.redirect, profileId));
  }
  async function enterProfileAndRoute(profile: ProfileSummary) {
    if (profile.credentialKind === "unreadable") {
      await editProfileWithBaseline(profile);
      return;
    }
    // Another tab already unlocked this server; the shared session needs no password here.
    if (unlocked?.profile.id === profile.id) return continueToServer(profile.id);
    // Without a password this only opens the unlock overlay, which navigates after unlocking.
    await enterProfile(profile);
  }
  function clearConsumedConfirmation() {
    if (!session.profiles.getSnapshot().connectionForm.password) setPasswordConfirmation("");
  }
  // A new profile, or one whose unreadable row is replaced, gets a newly chosen password.
  const newPassword = !selectedProfile || selectedProfile.credentialKind === "unreadable";
  const passwordTooShort =
    newPassword && connectionForm.password.length < MIN_PROFILE_PASSWORD_LENGTH;
  const confirmationMismatch = newPassword && connectionForm.password !== passwordConfirmation;
  async function submitConnection(activate = false) {
    setPasswordChecked(true);
    // An empty password is reported by the save itself, after the URL and API key checks.
    if (connectionForm.password && passwordTooShort) return passwordRef.current?.focus();
    if (connectionForm.password && confirmationMismatch) return confirmationRef.current?.focus();
    const ticket = session.profiles.connectionFormGeneration;
    setActivating(activate);
    try {
      await submitAddProfile(activate);
    } finally {
      clearConsumedConfirmation();
    }
    const current = session.auth.getSessionSnapshot();
    if (
      activate &&
      ticket === session.profiles.connectionFormGeneration &&
      current?.status === "unlocked" &&
      current.profile.id === session.profiles.getSnapshot().connectionForm.profileId
    )
      await continueToServer(current.profile.id);
  }
  const profilesWereCleared = query.cleared === "1";
  const showTooShort = passwordTooShort && passwordChecked && connectionForm.password !== "";
  const showMismatch =
    confirmationMismatch && (passwordConfirmation !== "" || passwordChecked) && !showTooShort;
  const lockReason =
    auth?.status === "locked" && typeof query.redirect === "string" ? auth.reason : null;
  const lockNotice = passwordChanged
    ? t("loginNoticePasswordChanged")
    : lockReason
      ? t(lockNotices[lockReason])
      : "";
  const hiddenUnreadable =
    unreadableRecords -
    profiles.filter((profile) => profile.credentialKind === "unreadable").length;
  const legacyProfile = selectedProfile?.credentialKind.startsWith("legacy-");
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
              <h1 className="text-2xl font-semibold sm:text-3xl">{t("profileSelectorTitle")}</h1>
              <p className="mt-2 text-sm text-muted-foreground sm:text-base">
                {t("profileSelectorDescription")}
              </p>
            </div>

            {/* A dialog that is open reports its own failure, so the page shows it only once. */}
            {lastError && !connectionDialogOpen && !unlockProfile && !pendingDeleteProfile ? (
              <div
                data-testid="login-error"
                role="alert"
                className="mx-auto mt-4 max-w-xl rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-start text-sm text-destructive"
              >
                {lastError}
              </div>
            ) : null}
            {pendingLocale ? (
              <p
                role="status"
                data-testid="locale-pending"
                className="mt-4 text-sm text-muted-foreground"
              >
                {t("languageLoading")}
              </p>
            ) : null}
            {localeError ? (
              <p
                role="alert"
                data-testid="locale-error"
                className="mx-auto mt-4 max-w-xl rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-start text-sm text-destructive"
              >
                {t(localeError === "load-failed" ? "languageLoadFailed" : "languageNotSaved")}
              </p>
            ) : null}
            {themeError ? (
              <p
                role="alert"
                data-testid="theme-error"
                className="mx-auto mt-4 max-w-xl rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-start text-sm text-destructive"
              >
                {t("themeNotSaved")}
              </p>
            ) : null}
            {settingsError ? (
              <p
                role="alert"
                data-testid="settings-error"
                className="mx-auto mt-4 max-w-xl rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-start text-sm text-destructive"
              >
                {t("preferencesReloadFailed")}
              </p>
            ) : null}
            {lockNotice ? (
              <div
                data-testid="login-notice"
                role="status"
                className="mx-auto mt-4 max-w-xl rounded-md border bg-muted/40 px-3 py-2 text-start text-sm text-muted-foreground"
              >
                {lockNotice}
              </div>
            ) : null}
            {discardedPolicyDraft ? (
              <div
                data-testid="login-discarded-policy"
                role="status"
                className="mx-auto mt-4 max-w-xl rounded-md border border-amber-400/50 bg-amber-50 px-3 py-2 text-start text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
              >
                {t("loginNoticeDiscardedPolicy")}
              </div>
            ) : null}
            {unlocked ? (
              <div
                data-testid="login-unlocked"
                role="status"
                className="mx-auto mt-4 flex max-w-xl flex-wrap items-center justify-between gap-2 rounded-md border bg-card px-3 py-2 text-start text-sm"
              >
                <span className="min-w-0 break-words">
                  {t("loginUnlockedNotice", { name: unlocked.profile.name })}
                </span>
                <Button
                  type="button"
                  size="sm"
                  data-testid="login-continue"
                  onClick={() => void continueToServer(unlocked.profile.id)}
                >
                  {t("continueToServer")}
                </Button>
              </div>
            ) : null}
            {hiddenUnreadable > 0 ? (
              <div
                data-testid="unreadable-records-notice"
                role="status"
                className="mx-auto mt-4 max-w-xl rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-start text-sm text-muted-foreground"
              >
                {t("unreadableRecordsNotice", { count: hiddenUnreadable })}
              </div>
            ) : null}
            {profilesWereCleared && profiles.length === 0 ? (
              <div
                data-testid="profiles-cleared-notice"
                role="status"
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
                    disabled={isConnecting}
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
                      <span className={authenticatingProfileId === profile.id ? "opacity-35" : ""}>
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
                      <span className="truncate text-sm font-semibold" title={profile.name}>
                        {profile.name}
                      </span>
                      <span className="break-all text-xs text-muted-foreground">
                        {profile.baseUrl}
                      </span>
                      {authenticatingProfileId === profile.id ? (
                        <span className="text-xs text-primary">{t("checkingCredentials")}</span>
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
                    disabled={isConnecting}
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
                    disabled={isConnecting}
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
                className="h-auto min-h-36 w-full flex-col items-center justify-center gap-3 border border-dashed bg-card p-4 text-center hover:bg-accent hover:text-accent-foreground sm:w-52"
                onClick={() => openConnectionDialogWithBaseline(newProfileId)}
              >
                <span className="flex h-14 w-14 items-center justify-center rounded-full border bg-background">
                  <Plus className="h-6 w-6" aria-hidden="true" />
                </span>
                <span className="grid gap-1">
                  <span className="text-sm font-semibold">{t("addServerProfile")}</span>
                  <span className="text-xs text-muted-foreground">{t("newProfile")}</span>
                </span>
              </Button>
            </div>
          </div>
        </main>

        <Dialog
          open={connectionDialogOpen}
          onOpenChange={handleConnectionDialogOpen}
          disablePointerDismissal
        >
          <DialogContent
            className="grid max-h-[calc(100svh-0.5rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-h-[calc(100svh-4rem)] sm:max-w-2xl"
            data-testid="connection-dialog"
            showCloseButton={false}
          >
            <DialogHeader className="px-4 pb-2 pe-10 pt-3 text-start sm:px-6 sm:pb-3 sm:pt-6">
              <DialogTitle className="truncate" title={selectedProfile?.name}>
                {selectedProfile
                  ? `${t("editProfile")} ${selectedProfile.name}`
                  : t("addServerProfile")}
              </DialogTitle>
              <DialogDescription className="text-sm leading-5">
                {t("connectSubtitle")}
              </DialogDescription>
              {selectedProfile?.credentialKind === "unreadable" || legacyProfile ? (
                <p
                  role="note"
                  data-testid="connect-profile-state"
                  className="rounded-md border border-amber-400/50 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
                >
                  {t(legacyProfile ? "legacyProfileMigrateFirst" : "unreadableProfileRepair")}
                </p>
              ) : null}
            </DialogHeader>

            <form
              className="flex min-h-0 flex-col"
              data-testid="connect-form"
              onSubmit={(event) => {
                event.preventDefault();
                void submitConnection(!selectedProfile);
              }}
            >
              <div className="grid min-h-0 min-w-0 gap-2 overflow-y-auto px-4 pb-2 sm:gap-4 sm:px-6 sm:pb-3 md:grid-cols-2">
                <div className="min-w-0 md:col-span-2">
                  <Label htmlFor="connect-profile-name">{t("profileName")}</Label>
                  <Input
                    id="connect-profile-name"
                    data-testid="connect-profile-name"
                    className="mt-1.5"
                    value={connectionForm.profileName}
                    readOnly={isConnecting}
                    onChange={(event) => setConnectionForm({ profileName: event.target.value })}
                  />
                </div>

                <div className="min-w-0 md:col-span-2">
                  <Label htmlFor="connect-server-url">{t("serverUrl")}</Label>
                  <Input
                    id="connect-server-url"
                    data-testid="connect-server-url"
                    className="mt-1.5"
                    inputMode="url"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={connectionForm.baseUrl}
                    readOnly={isConnecting}
                    aria-describedby={
                      sendsApiKeyInClear(connectionForm.baseUrl)
                        ? "connect-url-insecure"
                        : undefined
                    }
                    onChange={(event) => setConnectionForm({ baseUrl: event.target.value })}
                  />
                  {sendsApiKeyInClear(connectionForm.baseUrl) ? (
                    <p
                      id="connect-url-insecure"
                      data-testid="connect-url-insecure"
                      className="mt-1.5 text-xs text-amber-700 dark:text-amber-300"
                    >
                      {t("insecureServerUrlWarning")}
                    </p>
                  ) : null}
                </div>

                <div className="min-w-0 md:col-span-2">
                  <Label htmlFor="connect-api-key">{t("apiKey")}</Label>
                  <Input
                    id="connect-api-key"
                    data-testid="connect-api-key"
                    type="password"
                    className="mt-1.5"
                    placeholder={t("apiKeyPlaceholder")}
                    autoComplete="off"
                    value={connectionForm.apiKey}
                    readOnly={isConnecting}
                    onChange={(event) => setConnectionForm({ apiKey: event.target.value })}
                  />
                </div>

                <div className="min-w-0 md:col-span-2">
                  <Label htmlFor="connect-password">
                    {t(newPassword ? "serverPassword" : "currentServerPassword")}
                  </Label>
                  <Input
                    ref={passwordRef}
                    id="connect-password"
                    data-testid="connect-password"
                    type="password"
                    className="mt-1.5"
                    value={connectionForm.password}
                    autoComplete={newPassword ? "new-password" : "current-password"}
                    readOnly={isConnecting}
                    aria-invalid={showTooShort}
                    aria-describedby="connect-password-hint"
                    onChange={(event) => setConnectionForm({ password: event.target.value })}
                  />
                  <p id="connect-password-hint" className="mt-1.5 text-xs text-muted-foreground">
                    {newPassword ? (
                      <>
                        <span
                          data-testid="connect-password-length"
                          className={cn("block", showTooShort && "text-destructive")}
                        >
                          {t("profilePasswordMinLength")}
                        </span>
                        {t("serverPasswordHint")}
                      </>
                    ) : (
                      t("serverCredentialEditHint")
                    )}
                  </p>
                </div>
                {newPassword && (
                  <div className="min-w-0 md:col-span-2">
                    <Label htmlFor="connect-password-confirm">
                      {t("encryptionConfirmPassphrase")}
                    </Label>
                    <Input
                      ref={confirmationRef}
                      id="connect-password-confirm"
                      data-testid="connect-password-confirm"
                      type="password"
                      className="mt-1.5"
                      value={passwordConfirmation}
                      autoComplete="new-password"
                      readOnly={isConnecting}
                      aria-invalid={showMismatch}
                      aria-describedby={showMismatch ? "connect-password-mismatch" : undefined}
                      onChange={(event) => setPasswordConfirmation(event.target.value)}
                    />
                    {showMismatch ? (
                      <p
                        id="connect-password-mismatch"
                        data-testid="connect-password-mismatch"
                        className="mt-1.5 text-xs text-destructive"
                      >
                        {t("passwordsMismatch")}
                      </p>
                    ) : null}
                  </div>
                )}

                <div className="grid gap-1.5 rounded-md border px-3 py-2 text-sm md:col-span-2">
                  <div className="flex min-h-7 items-center gap-2">
                    <Checkbox
                      id="connect-remember"
                      data-testid="connect-remember"
                      checked={connectionForm.remember}
                      readOnly={isConnecting}
                      aria-describedby="connect-remember-hint"
                      onCheckedChange={(checked) => setConnectionForm({ remember: checked })}
                    />
                    <Label htmlFor="connect-remember">{t("rememberConnection")}</Label>
                  </div>
                  <p id="connect-remember-hint" className="text-xs text-muted-foreground">
                    {t("rememberConnectionHint")}
                  </p>
                </div>

                <details
                  open
                  className="group min-w-0 rounded-md border bg-muted/35 p-3 text-sm dark:bg-muted/60 md:col-span-2"
                  data-testid="api-key-guide"
                >
                  <summary className="flex cursor-pointer list-none items-start gap-2 [&::-webkit-details-marker]:hidden">
                    <KeyRound
                      className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <div className="min-w-0">
                      <h3 className="font-medium">{t("apiKeyGuideTitle")}</h3>
                      <p className="mt-1 text-muted-foreground">{t("apiKeyGuideDescription")}</p>
                    </div>
                  </summary>
                  <div className="mt-3 overflow-hidden rounded-md border bg-background p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-medium text-muted-foreground">
                        {t("apiKeyGuideCommandLabel")}
                      </p>
                      <CopyButton
                        value={apiKeyCommand}
                        variant="ghost"
                        size="sm"
                        iconClassName="h-3.5 w-3.5"
                        className="h-7 gap-1 px-2 text-xs"
                        data-testid="api-key-command-copy"
                        aria-label={t("copy")}
                      >
                        {t("copy")}
                      </CopyButton>
                    </div>
                    <code className="mt-2 block overflow-x-auto whitespace-nowrap font-mono text-xs text-foreground">
                      {apiKeyCommand}
                    </code>
                  </div>
                  <ol className="mt-3 grid gap-1 ps-5 text-xs text-muted-foreground">
                    <li>{t("apiKeyGuideStepServer")}</li>
                    <li>{t("apiKeyGuideStepCreate")}</li>
                    <li>{t("apiKeyGuideStepCopy")}</li>
                    <li>{t("apiKeyGuideStepPaste")}</li>
                  </ol>
                  <p className="mt-3 text-xs text-muted-foreground">{t("apiKeyGuideHint")}</p>
                  <a
                    href={headscaleRemoteCliDocsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-flex cursor-pointer text-xs font-medium text-primary underline-offset-4 hover:underline"
                    data-testid="api-key-docs-link"
                  >
                    {t("headscaleDocs")}
                  </a>
                </details>
              </div>

              <div
                className="grid shrink-0 gap-2 border-t bg-background p-2.5 sm:gap-3 sm:px-6 sm:py-4 md:grid-cols-2"
                data-testid="connect-footer"
              >
                {lastError ? (
                  <p
                    data-testid="connect-error"
                    role="alert"
                    className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive md:col-span-2"
                  >
                    {lastError}
                  </p>
                ) : null}
                <DialogFooter className="flex-row flex-wrap gap-2 sm:justify-end md:col-span-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1 sm:flex-none"
                    data-testid="connect-close"
                    onClick={requestConnectionDialogClose}
                  >
                    {t("close")}
                  </Button>
                  {/* Saving an edit is the primary action; a new server is usually opened right away. */}
                  <Button
                    type={selectedProfile ? "submit" : "button"}
                    variant={selectedProfile ? "default" : "outline"}
                    className="flex-1 sm:flex-none"
                    data-testid="connect-submit"
                    disabled={isConnecting}
                    onClick={selectedProfile ? undefined : () => void submitConnection()}
                  >
                    {isConnecting && !activating ? (
                      <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : selectedProfile ? (
                      <Save className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <Plus className="h-4 w-4" aria-hidden="true" />
                    )}
                    {isConnecting && !activating
                      ? t(selectedProfile ? "savingProfile" : "addingProfile")
                      : t("saveProfile")}
                  </Button>
                  {!selectedProfile && (
                    <Button
                      type="submit"
                      className="w-full sm:w-auto"
                      data-testid="connect-save-unlock"
                      disabled={isConnecting}
                    >
                      {isConnecting && activating ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                      ) : null}
                      {t("saveAndUnlock")}
                    </Button>
                  )}
                </DialogFooter>
              </div>
            </form>
          </DialogContent>
        </Dialog>

        <AlertDialog
          open={connectionCloseConfirmOpen}
          onOpenChange={handleConnectionCloseConfirmOpen}
        >
          <AlertDialogContent data-testid="discard-profile-changes-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>{t("discardProfileChangesTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("discardProfileChangesDescription")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="keep-editing-profile">
                {t("keepEditingProfile")}
              </AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                data-testid="discard-profile-changes"
                onClick={confirmConnectionDialogClose}
              >
                {t("discardProfileChanges")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog
          open={profileValidationDialogOpen}
          onOpenChange={(open) => setProfileState({ profileValidationDialogOpen: open })}
        >
          <AlertDialogContent data-testid="profile-validation-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>{t("connectionValidationFailedTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("connectionValidationFailedDescription")}
                {profileValidationError ? (
                  <span
                    className="mt-2 block rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                    data-testid="profile-validation-error"
                  >
                    {profileValidationError}
                  </span>
                ) : null}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <p className="text-sm text-muted-foreground">{t("sessionSecretRequired")}</p>
            <div className="grid gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="validation-api-key">{t("apiKey")}</Label>
                <Input
                  id="validation-api-key"
                  data-testid="validation-api-key"
                  type="password"
                  autoComplete="off"
                  value={connectionForm.apiKey}
                  onChange={(event) => setConnectionForm({ apiKey: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="validation-password">
                  {t(newPassword ? "serverPassword" : "currentServerPassword")}
                </Label>
                <Input
                  id="validation-password"
                  data-testid="validation-password"
                  type="password"
                  autoComplete={newPassword ? "new-password" : "current-password"}
                  value={connectionForm.password}
                  aria-describedby={newPassword ? "validation-password-length" : undefined}
                  onChange={(event) => setConnectionForm({ password: event.target.value })}
                />
                {newPassword ? (
                  <p id="validation-password-length" className="text-xs text-muted-foreground">
                    {t("profilePasswordMinLength")}
                  </p>
                ) : null}
              </div>
              {newPassword && (
                <div className="space-y-1.5">
                  <Label htmlFor="validation-password-confirm">
                    {t("encryptionConfirmPassphrase")}
                  </Label>
                  <Input
                    id="validation-password-confirm"
                    data-testid="validation-password-confirm"
                    type="password"
                    autoComplete="new-password"
                    value={passwordConfirmation}
                    aria-invalid={showMismatch}
                    aria-describedby={showMismatch ? "validation-password-mismatch" : undefined}
                    onChange={(event) => setPasswordConfirmation(event.target.value)}
                  />
                  {showMismatch ? (
                    <p
                      id="validation-password-mismatch"
                      data-testid="validation-password-mismatch"
                      className="text-xs text-destructive"
                    >
                      {t("passwordsMismatch")}
                    </p>
                  ) : null}
                </div>
              )}
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel
                className="bg-primary text-primary-foreground hover:bg-primary/90"
                data-testid="review-profile-connection"
                onClick={reviewProfileConnection}
              >
                {t("backToEditConnection")}
              </AlertDialogCancel>
              <AlertDialogAction
                className="border border-input bg-background text-foreground shadow-xs hover:bg-accent hover:text-accent-foreground"
                data-testid="continue-add-profile"
                disabled={
                  isConnecting ||
                  !connectionForm.apiKey ||
                  !connectionForm.password ||
                  passwordTooShort ||
                  confirmationMismatch
                }
                onClick={async () => {
                  try {
                    await continueAddingProfile();
                  } finally {
                    clearConsumedConfirmation();
                  }
                }}
              >
                {t(selectedProfile ? "saveAnywayEditButton" : "saveAnywayButton")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={Boolean(pendingDeleteProfile)} onOpenChange={closeDeleteProfileDialog}>
          <AlertDialogContent data-testid="delete-profile-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>{t("confirmDeleteProfileTitle")}</AlertDialogTitle>
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
                role="alert"
                data-testid="delete-profile-error"
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {lastError}
              </p>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="cancel-delete-profile" disabled={isConnecting}>
                {t("cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                data-testid="confirm-delete-profile"
                disabled={isConnecting}
                onClick={confirmDeleteProfile}
              >
                {isConnecting ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
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
