import { useStore as useFormStore } from "@tanstack/react-form";
import { Lock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAppForm } from "@/components/app/form";
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
import { useActionFeedback } from "@/composables/useActionFeedback";
import { useProfiles } from "@/composables/useProfiles";
import { useResetLocalData } from "@/composables/useResetLocalData";
import { useHeadscaleI18n } from "@/i18n";
import {
  MIN_PROFILE_PASSWORD_LENGTH,
  normalizeNewProfilePassword,
} from "@/lib/api-key-crypto";
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
  const [errorMessage, setErrorMessage] = useState("");
  const [currentRejected, setCurrentRejected] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const inFlight = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const currentRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const form = useAppForm({
    defaultValues: {
      currentPassphrase: "",
      newPassphrase: "",
      confirmPassphrase: "",
    },
    validators: {
      onDynamic: ({ value }) => {
        if (!value.currentPassphrase)
          return { fields: { currentPassphrase: t("serverPasswordRequired") } };
        const password = value.newPassphrase.trim();
        if (password.length < MIN_PROFILE_PASSWORD_LENGTH)
          return { fields: { newPassphrase: t("profilePasswordMinLength") } };
        if (password !== value.confirmPassphrase.trim())
          return { fields: { confirmPassphrase: t("passwordsMismatch") } };
      },
    },
    listeners: {
      onChange: () => {
        setCurrentRejected(false);
        setErrorMessage("");
      },
    },
    onSubmit: async ({ formApi }): Promise<void> => {
      if (inFlight.current || !profile) return;
      inFlight.current = true;
      setErrorMessage("");
      setCurrentRejected(false);
      setSuccessMessage("");
      formApi.setFieldValue(
        "newPassphrase",
        normalizeNewProfilePassword(formApi.state.values.newPassphrase),
        {
          dontValidate: true,
          dontRunListeners: true,
        },
      );
      formApi.setFieldValue(
        "confirmPassphrase",
        formApi.state.values.confirmPassphrase.trim(),
        {
          dontValidate: true,
          dontRunListeners: true,
        },
      );
      try {
        const changing = profiles.changeProfilePassword(
          profile,
          formApi.state.values.currentPassphrase,
          formApi.state.values.newPassphrase,
          (result) => {
            if (!mounted.current) return false;
            if (result.kind === "failed") {
              setErrorMessage(result.message);
              const rejected = result.failureKind === "unlock-failed";
              setCurrentRejected(rejected);
              if (rejected) currentRef.current?.focus();
              return true;
            }
            clearSecrets();
            setShowChangeForm(false);
            setCurrentRejected(false);
            if (!result.refreshError) {
              setSuccessMessage(t("profilePasswordChanged"));
              return true;
            }
            const delivered = feedback
              .beginNotification({ isCurrent: () => mounted.current })
              .publish({
                tone: "warning",
                title: "common.profilePasswordChanged",
                description: "product.feedbackRefreshFailed",
              });
            if (!delivered) setErrorMessage(result.refreshError);
            return true;
          },
        );
        // 已派发的旧密码立即清除；新密码保留供本次修改显式重试。
        formApi.setFieldValue("currentPassphrase", "", {
          dontValidate: true,
          dontRunListeners: true,
        });
        await changing;
      } finally {
        inFlight.current = false;
      }
    },
  });
  const values = useFormStore(form.store, (state) => state.values);
  const submitting = useFormStore(form.store, (state) => state.isSubmitting);
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
    for (const name of [
      "currentPassphrase",
      "newPassphrase",
      "confirmPassphrase",
    ] as const)
      form.setFieldValue(name, "", {
        dontValidate: true,
        dontRunListeners: true,
      });
  }
  function reset() {
    form.reset();
    setShowChangeForm(false);
    setErrorMessage("");
    setCurrentRejected(false);
    setSuccessMessage("");
  }
  return (
    <div className="grid gap-4">
      <div className="flex items-start gap-3 rounded-md border bg-card px-3 py-3">
        <Lock
          className="mt-0.5 h-4 w-4 text-muted-foreground"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium text-foreground">
            {t("sessionSharedNote")}
          </p>
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
              form.reset();
              setShowChangeForm(true);
              setErrorMessage("");
              setCurrentRejected(false);
              setSuccessMessage("");
            }}
          >
            {t("encryptionChangePassphrase")}
          </Button>
        </div>
      )}
      {profile && showChangeForm && (
        <form.AppForm>
          <form.Form className="grid gap-3 rounded-md border bg-card p-3">
            <form.AppField name="currentPassphrase">
              {(field) => (
                <field.TextField
                  ref={currentRef}
                  id="enc-current"
                  label={t("currentServerPassword")}
                  type="password"
                  data-testid="security-current-passphrase"
                  autoComplete="current-password"
                  trimOnBlur={false}
                  readOnly={submitting}
                  aria-invalid={currentRejected}
                  aria-describedby={
                    currentRejected && errorMessage
                      ? "security-error"
                      : undefined
                  }
                />
              )}
            </form.AppField>
            <form.AppField name="newPassphrase">
              {(field) => (
                <field.TextField
                  id="enc-new-c"
                  label={t("newServerPassword")}
                  type="password"
                  data-testid="security-change-new-passphrase"
                  autoComplete="new-password"
                  readOnly={submitting}
                  description={t("profilePasswordMinLength")}
                />
              )}
            </form.AppField>
            <form.AppField name="confirmPassphrase">
              {(field) => (
                <field.TextField
                  id="enc-confirm-c"
                  label={t("encryptionConfirmPassphrase")}
                  type="password"
                  data-testid="security-change-confirm-passphrase"
                  autoComplete="new-password"
                  readOnly={submitting}
                />
              )}
            </form.AppField>
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
              <form.SubmitButton
                data-testid="security-change-submit"
                disabled={
                  submitting ||
                  !values.currentPassphrase ||
                  !values.newPassphrase ||
                  !values.confirmPassphrase
                }
              >
                {t("encryptionChangePassphrase")}
              </form.SubmitButton>
            </div>
          </form.Form>
        </form.AppForm>
      )}
      {errorMessage && (
        <p
          id="security-error"
          data-testid="security-error"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {errorMessage}
        </p>
      )}
      {successMessage && (
        <p
          data-testid="security-success"
          className="text-sm text-muted-foreground"
        >
          {successMessage}
        </p>
      )}
      <div className="grid gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
        <p className="text-sm font-medium text-destructive">
          {t("encryptionForgottenButton")}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("clearAllProfilesHint")}
        </p>
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
              <AlertDialogDescription>
                {t("clearProfilesDescription")}
              </AlertDialogDescription>
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
