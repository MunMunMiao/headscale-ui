import { Lock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { useActionFeedback } from "@/composables/useActionFeedback";
import { useProfiles } from "@/composables/useProfiles";
import { useResetLocalData } from "@/composables/useResetLocalData";
import { useHeadscaleI18n } from "@/i18n";
import type { ProfileSummary } from "@/lib/profile-storage";

export default function SecuritySettings({
  profile,
  reloadPage = window.location.assign.bind(window.location),
}: {
  profile?: ProfileSummary | null;
  reloadPage?: (href: string) => void;
}) {
  const profiles = useProfiles();
  const feedback = useActionFeedback();
  const { t } = useHeadscaleI18n();
  const [showChangeForm, setShowChangeForm] = useState(false);
  const [currentPassphrase, setCurrentPassphrase] = useState("");
  const [newPassphrase, setNewPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const inFlight = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const currentRef = useRef<HTMLInputElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (showChangeForm) currentRef.current?.focus();
    else if (wasOpen.current) triggerRef.current?.focus();
    wasOpen.current = showChangeForm;
  }, [showChangeForm]);
  const { clearing, clearAll } = useResetLocalData({
    inFlight,
    reloadPage,
    onStart() {
      setClearConfirmOpen(false);
      setErrorMessage("");
      setSuccessMessage("");
      clearSecrets();
    },
    onError: setErrorMessage,
  });

  function clearSecrets() {
    setCurrentPassphrase("");
    setNewPassphrase("");
    setConfirmPassphrase("");
  }
  function reset() {
    clearSecrets();
    setShowChangeForm(false);
    setErrorMessage("");
    setSuccessMessage("");
  }
  async function changeIt() {
    if (inFlight.current || !profile) return;
    if (!currentPassphrase || !newPassphrase || newPassphrase !== confirmPassphrase) {
      setErrorMessage(t("passwordsMismatch"));
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    setErrorMessage("");
    setSuccessMessage("");
    try {
      const changing = profiles.changeProfilePassword(profile, currentPassphrase, newPassphrase);
      clearSecrets();
      if (await changing) {
        setShowChangeForm(false);
        setSuccessMessage(t("profilePasswordChanged"));
      } else setErrorMessage(feedback.getSnapshot().lastError);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }
  return (
    <div className="grid gap-4">
      <div className="flex items-start gap-3 rounded-md border bg-card px-3 py-3">
        <Lock className="mt-0.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium text-foreground">{t("sessionSharedNote")}</p>
          {profile && (
            <p className="mt-1 break-words text-xs text-muted-foreground">
              {t("securityProfileHint", { name: profile.name })}
            </p>
          )}
        </div>
      </div>
      {profile?.credentialKind === "password" && !showChangeForm && (
        <div className="flex justify-end">
          <Button
            ref={triggerRef}
            type="button"
            variant="outline"
            data-testid="security-change-passphrase"
            disabled={clearing}
            onClick={() => {
              setShowChangeForm(true);
              setErrorMessage("");
              setSuccessMessage("");
            }}
          >
            {t("encryptionChangePassphrase")}
          </Button>
        </div>
      )}
      {profile && showChangeForm && (
        <form
          className="grid gap-3 rounded-md border bg-card p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void changeIt();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="enc-current">{t("currentServerPassword")}</Label>
            <Input
              ref={currentRef}
              id="enc-current"
              type="password"
              data-testid="security-current-passphrase"
              value={currentPassphrase}
              onChange={(event) => setCurrentPassphrase(event.target.value)}
              autoComplete="current-password"
              disabled={submitting}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="enc-new-c">{t("newServerPassword")}</Label>
            <Input
              id="enc-new-c"
              type="password"
              data-testid="security-change-new-passphrase"
              value={newPassphrase}
              onChange={(event) => setNewPassphrase(event.target.value)}
              autoComplete="new-password"
              disabled={submitting}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="enc-confirm-c">{t("encryptionConfirmPassphrase")}</Label>
            <Input
              id="enc-confirm-c"
              type="password"
              data-testid="security-change-confirm-passphrase"
              value={confirmPassphrase}
              onChange={(event) => setConfirmPassphrase(event.target.value)}
              autoComplete="new-password"
              disabled={submitting}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              data-testid="security-change-cancel"
              disabled={submitting}
              onClick={reset}
            >
              {t("cancel")}
            </Button>
            <Button
              type="submit"
              data-testid="security-change-submit"
              disabled={submitting || !currentPassphrase || !newPassphrase || !confirmPassphrase}
            >
              {t("encryptionChangePassphrase")}
            </Button>
          </div>
        </form>
      )}
      {errorMessage && (
        <p
          data-testid="security-error"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {errorMessage}
        </p>
      )}
      {successMessage && (
        <p data-testid="security-success" className="text-sm text-muted-foreground" role="status">
          {successMessage}
        </p>
      )}
      <div className="grid gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
        <p className="text-sm font-medium text-destructive">{t("encryptionForgottenButton")}</p>
        <p className="text-xs text-muted-foreground">{t("forgotServerPasswordHint")}</p>
        <AlertDialog open={clearConfirmOpen} onOpenChange={setClearConfirmOpen}>
          <AlertDialogTrigger
            render={
              <Button
                type="button"
                variant="destructive"
                className="w-fit"
                disabled={clearing || submitting}
                data-testid="security-clear-all"
              />
            }
          >
            {t("encryptionForgottenButton")}
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("encryptionForgottenButton")}</AlertDialogTitle>
              <AlertDialogDescription>{t("clearProfilesDescription")}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="security-clear-all-cancel">
                {t("cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                data-testid="security-clear-all-confirm"
                disabled={clearing || submitting}
                onClick={clearAll}
              >
                {t("encryptionForgottenButton")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
