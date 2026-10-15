import { useRouter, useSearch } from "@tanstack/react-router";
import { type RefObject, useRef, useState } from "react";
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
import { MIN_PROFILE_PASSWORD_LENGTH, useProfiles } from "@/composables/useProfiles";
import { useResetLocalData } from "@/composables/useResetLocalData";
import { useHeadscaleI18n } from "@/i18n";
import type { ProfileSummary } from "@/lib/profile-storage";
import { cn } from "@/lib/utils";
import { redirectTarget } from "@/router/search";
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
type Field = "passphrase" | "new" | "confirm";
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
  const [invalid, setInvalid] = useState<Field | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const inFlight = useRef(false);
  const fields: Record<Field, RefObject<HTMLInputElement | null>> = {
    passphrase: useRef(null),
    new: useRef(null),
    confirm: useRef(null),
  };
  const { clearing, clearAll } = useResetLocalData({
    inFlight,
    search: { cleared: "1" },
    reloadPage,
    onStart() {
      setClearConfirmOpen(false);
      setErrorMessage("");
      setInvalid(null);
      clearSecrets();
    },
    onError: setErrorMessage,
  });
  // The page-level banner is hidden while this dialog is open, so profile errors are shown here once.
  const shownError = errorMessage || feedback.lastError;
  function clearSecrets() {
    setPassphrase("");
    setNewPassword("");
    setConfirmation("");
  }
  function close() {
    clearSecrets();
    profiles.closeUnlockDialog();
  }
  function reject(field: Field, message = "") {
    setErrorMessage(message);
    setInvalid(field);
    fields[field].current?.focus();
  }
  function invalidProps(field: Field, describedBy?: string) {
    const ids = [describedBy, invalid === field && shownError ? "unlock-error" : undefined];
    return {
      "aria-invalid": invalid === field,
      "aria-describedby": ids.filter(Boolean).join(" ") || undefined,
    };
  }

  async function submit() {
    if (inFlight.current) return;
    if ((!migration || needsPreviousPassword) && !passphrase)
      return reject("passphrase", t("sessionSecretRequired"));
    if (migration && newPassword.length < MIN_PROFILE_PASSWORD_LENGTH)
      return reject("new", t("profilePasswordMinLength"));
    if (migration && newPassword !== confirmation) return reject("confirm", t("passwordsMismatch"));
    inFlight.current = true;
    setSubmitting(true);
    setErrorMessage("");
    setInvalid(null);
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
        // The cleared password is the field to fill in again; the store error says why.
        reject(needsPreviousPassword || !migration ? "passphrase" : "new");
        return;
      }
      await router.navigate(redirectTarget(query.redirect, profile.id));
    } catch (error) {
      const message = storageErrorMessage(error);
      setErrorMessage(message);
      feedback.setState({ lastError: message });
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }
  // A migrated profile reopens this dialog while its unlock is still running.
  const busy = submitting || clearing || profiles.authenticatingProfileId === profile.id;
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
                ref={fields.passphrase}
                id="unlock-passphrase"
                type="password"
                data-testid={
                  needsPreviousPassword ? "migration-current-password" : "unlock-passphrase"
                }
                autoComplete="current-password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                readOnly={busy}
                {...invalidProps("passphrase")}
              />
            </div>
          )}
          {migration && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="migration-new-password">{t("newServerPassword")}</Label>
                <Input
                  ref={fields.new}
                  id="migration-new-password"
                  data-testid="migration-new-password"
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  readOnly={busy}
                  {...invalidProps("new", "migration-password-length")}
                />
                <p
                  id="migration-password-length"
                  className={cn(
                    "text-xs",
                    invalid === "new" && errorMessage
                      ? "text-destructive"
                      : "text-muted-foreground",
                  )}
                >
                  {t("profilePasswordMinLength")}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="migration-confirm-password">
                  {t("encryptionConfirmPassphrase")}
                </Label>
                <Input
                  ref={fields.confirm}
                  id="migration-confirm-password"
                  data-testid="migration-confirm-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  readOnly={busy}
                  {...invalidProps("confirm")}
                />
              </div>
              <p className="text-xs text-muted-foreground">{t("serverPasswordHint")}</p>
            </>
          )}
          {shownError && (
            <p
              id="unlock-error"
              role="alert"
              data-testid="unlock-error"
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {shownError}
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
                busy ||
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
              <Button type="button" variant="ghost" data-testid="unlock-forgot" disabled={busy} />
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
