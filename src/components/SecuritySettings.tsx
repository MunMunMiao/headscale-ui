import { Lock } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
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
import { MIN_PROFILE_PASSWORD_LENGTH, useProfiles } from "@/composables/useProfiles";
import { useResetLocalData } from "@/composables/useResetLocalData";
import { useHeadscaleI18n } from "@/i18n";
import type { ProfileSummary } from "@/lib/profile-storage";
import { cn } from "@/lib/utils";

type Field = "current" | "new" | "confirm";

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
  const [invalid, setInvalid] = useState<Field | null>(null);
  const [successMessage, setSuccessMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const inFlight = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const currentRef = useRef<HTMLInputElement>(null);
  const fields: Record<Field, RefObject<HTMLInputElement | null>> = {
    current: currentRef,
    new: useRef(null),
    confirm: useRef(null),
  };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
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
    setInvalid(null);
    setSuccessMessage("");
  }
  function reject(field: Field, message: string) {
    setErrorMessage(message);
    setInvalid(field);
    fields[field].current?.focus();
  }
  function invalidProps(field: Field, describedBy?: string) {
    const ids = [describedBy, invalid === field ? "security-error" : undefined];
    return {
      "aria-invalid": invalid === field,
      "aria-describedby": ids.filter(Boolean).join(" ") || undefined,
    };
  }
  async function changeIt() {
    if (inFlight.current || !profile) return;
    if (!currentPassphrase) return reject("current", t("serverPasswordRequired"));
    if (newPassphrase.length < MIN_PROFILE_PASSWORD_LENGTH)
      return reject("new", t("profilePasswordMinLength"));
    if (newPassphrase !== confirmPassphrase) return reject("confirm", t("passwordsMismatch"));
    inFlight.current = true;
    setSubmitting(true);
    setErrorMessage("");
    setInvalid(null);
    setSuccessMessage("");
    try {
      const changing = profiles.changeProfilePassword(profile, currentPassphrase, newPassphrase);
      // The new password stays typed for a retry; only the rejected current password is cleared.
      setCurrentPassphrase("");
      if (await changing) {
        clearSecrets();
        setShowChangeForm(false);
        setSuccessMessage(t("profilePasswordChanged"));
      } else if (mounted.current) {
        // Shown once, here; a page that already left for login keeps it as its banner.
        reject("current", feedback.getSnapshot().lastError);
        feedback.setState({ lastError: "" });
      }
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
              readOnly={submitting}
              {...invalidProps("current")}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="enc-new-c">{t("newServerPassword")}</Label>
            <Input
              ref={fields.new}
              id="enc-new-c"
              type="password"
              data-testid="security-change-new-passphrase"
              value={newPassphrase}
              onChange={(event) => setNewPassphrase(event.target.value)}
              autoComplete="new-password"
              readOnly={submitting}
              {...invalidProps("new", "enc-new-length")}
            />
            <p
              id="enc-new-length"
              className={cn(
                "text-xs",
                invalid === "new" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {t("profilePasswordMinLength")}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="enc-confirm-c">{t("encryptionConfirmPassphrase")}</Label>
            <Input
              ref={fields.confirm}
              id="enc-confirm-c"
              type="password"
              data-testid="security-change-confirm-passphrase"
              value={confirmPassphrase}
              onChange={(event) => setConfirmPassphrase(event.target.value)}
              autoComplete="new-password"
              readOnly={submitting}
              {...invalidProps("confirm")}
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
          id="security-error"
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
        <p className="text-xs text-muted-foreground">{t("clearAllProfilesHint")}</p>
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
              <AlertDialogTitle>{t("forgotConfirmTitle")}</AlertDialogTitle>
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
