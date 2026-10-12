import { useRouter, useSearch } from "@tanstack/react-router";
import { useRef, useState } from "react";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useActionFeedback } from "@/composables/useActionFeedback";
import { useProfiles } from "@/composables/useProfiles";
import { useResetLocalData } from "@/composables/useResetLocalData";
import { useHeadscaleI18n } from "@/i18n";
import type { ProfileSummary } from "@/lib/profile-storage";
import { parseSearch } from "@/router/search";
import { storageErrorMessage } from "@/utils/storage-error";

type UnlockProps = { reloadPage?: (href: string) => void };
export default function UnlockOverlay(props: UnlockProps) {
  const { unlockProfile } = useProfiles();
  return unlockProfile ? (
    <ProfileUnlockDialog
      key={`${unlockProfile.id}:${unlockProfile.credentialVersion}`}
      profile={unlockProfile}
      {...props}
    />
  ) : null;
}
function ProfileUnlockDialog({
  profile,
  reloadPage = window.location.assign.bind(window.location),
}: UnlockProps & { profile: ProfileSummary }) {
  const router = useRouter();
  const query = useSearch({ strict: false }) as Record<string, unknown>;
  const profiles = useProfiles();
  const feedback = useActionFeedback();
  const { t } = useHeadscaleI18n();
  const migration = profile.credentialKind.startsWith("legacy-");
  const needsPreviousPassword = profile.credentialKind === "legacy-password";
  const [passphrase, setPassphrase] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const inFlight = useRef(false);
  const { clearing, clearAll } = useResetLocalData({
    inFlight,
    search: { cleared: "1" },
    reloadPage,
    onStart() {
      setClearConfirmOpen(false);
      setErrorMessage("");
      clearSecrets();
    },
    onError: setErrorMessage,
  });
  function clearSecrets() {
    setPassphrase("");
    setNewPassword("");
    setConfirmation("");
  }
  function close() {
    clearSecrets();
    profiles.closeUnlockDialog();
  }

  async function submit() {
    if (inFlight.current) return;
    if (migration ? !newPassword || newPassword !== confirmation : !passphrase) {
      setErrorMessage(t(migration ? "passwordsMismatch" : "sessionSecretRequired"));
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    setErrorMessage("");
    try {
      const unlocking = migration
        ? profiles.migrateAndEnterProfile(
            profile,
            newPassword,
            needsPreviousPassword ? passphrase : undefined,
          )
        : profiles.enterProfile(profile, passphrase);
      clearSecrets();
      if (!(await unlocking)) {
        setErrorMessage(feedback.getSnapshot().lastError);
        return;
      }
      const redirect = typeof query.redirect === "string" ? query.redirect : "/";
      const target = new URL(redirect, "http://headscale.local");
      const pinned = target.searchParams.get("profile");
      // A redirect pinned to a different or stale profile would bounce back to /login via guardRoute,
      // and its ids and hash belong to another server.
      const foreign = pinned !== null && pinned !== profile.id;
      await router.navigate(
        foreign
          ? { to: target.pathname, search: {}, hash: "", replace: true }
          : {
              to: target.pathname,
              search: parseSearch(target.search),
              hash: target.hash.slice(1),
              replace: true,
            },
      );
    } catch (error) {
      const message = storageErrorMessage(error);
      setErrorMessage(message);
      feedback.setState({ lastError: message });
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }
  return (
    // Always open and trigger-less, so Base UI only reports closing (Escape, backdrop, close button).
    <Dialog open onOpenChange={close}>
      <DialogContent data-testid="unlock-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t(migration ? "profileMigrationTitle" : "profileUnlockTitle", { name: profile.name })}
          </DialogTitle>
          <DialogDescription>
            {t(migration ? "profileMigrationHint" : "sessionSharedNote")}
          </DialogDescription>
        </DialogHeader>
        <p className="break-all text-xs text-muted-foreground">
          <bdi dir="auto">{profile.baseUrl}</bdi>
        </p>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {(!migration || needsPreviousPassword) && (
            <div className="space-y-1.5">
              <Label htmlFor="unlock-passphrase">
                {t(needsPreviousPassword ? "legacyPasswordLabel" : "serverPassword")}
              </Label>
              <Input
                id="unlock-passphrase"
                type="password"
                data-testid={
                  needsPreviousPassword ? "migration-current-password" : "unlock-passphrase"
                }
                autoComplete="current-password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                disabled={submitting || clearing}
              />
            </div>
          )}
          {migration && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="migration-new-password">{t("newServerPassword")}</Label>
                <Input
                  id="migration-new-password"
                  data-testid="migration-new-password"
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  disabled={submitting || clearing}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="migration-confirm-password">
                  {t("encryptionConfirmPassphrase")}
                </Label>
                <Input
                  id="migration-confirm-password"
                  data-testid="migration-confirm-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  disabled={submitting || clearing}
                />
              </div>
              <p className="text-xs text-muted-foreground">{t("serverPasswordHint")}</p>
            </>
          )}
          {errorMessage && (
            <p
              role="alert"
              data-testid="unlock-error"
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {errorMessage}
            </p>
          )}
          <DialogFooter className="flex-row">
            <Button type="button" variant="outline" data-testid="unlock-cancel" onClick={close}>
              {t("cancel")}
            </Button>
            <Button
              type="submit"
              data-testid={migration ? "migration-submit" : "unlock-submit"}
              disabled={
                submitting ||
                clearing ||
                (migration
                  ? !newPassword || !confirmation || (needsPreviousPassword && !passphrase)
                  : !passphrase)
              }
            >
              {t(migration ? "migrateAndUnlock" : "encryptionUnlockSubmit")}
            </Button>
          </DialogFooter>
        </form>
        <p className="text-xs text-muted-foreground">{t("forgotServerPasswordHint")}</p>
        <AlertDialog open={clearConfirmOpen} onOpenChange={setClearConfirmOpen}>
          <AlertDialogTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                data-testid="unlock-forgot"
                disabled={submitting || clearing}
              />
            }
          >
            {t("encryptionForgottenButton")}
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("forgotConfirmTitle")}</AlertDialogTitle>
              <AlertDialogDescription>{t("clearProfilesDescription")}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="unlock-forgot-cancel">
                {t("cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                data-testid="unlock-forgot-confirm"
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                disabled={clearing}
                onClick={clearAll}
              >
                {t("encryptionForgottenButton")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
