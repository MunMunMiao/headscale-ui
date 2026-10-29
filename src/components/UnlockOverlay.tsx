import { useStore as useFormStore } from "@tanstack/react-form";
import { useRouter, useSearch } from "@tanstack/react-router";
import { useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/app/dialog";
import { useAppForm } from "@/components/app/form";
import { Button } from "@/components/ui/button";
import { useActionFeedback } from "@/composables/useActionFeedback";
import { SAVED_LOCKED_ERROR, useProfiles } from "@/composables/useProfiles";
import { useHeadscaleI18n } from "@/i18n";
import {
  MIN_PROFILE_PASSWORD_LENGTH,
  normalizeNewProfilePassword,
} from "@/lib/api-key-crypto";
import type { ProfileSummary } from "@/lib/profile-storage";
import { redirectTarget } from "@/router/search";
import { storageErrorMessage } from "@/utils/storage-error";

export default function UnlockOverlay() {
  const { unlockProfile } = useProfiles();
  return unlockProfile ? (
    <ProfileUnlockDialog
      key={`${unlockProfile.id}:${unlockProfile.credentialVersion}`}
      profile={unlockProfile}
    />
  ) : null;
}

function ProfileUnlockDialog({ profile }: { profile: ProfileSummary }) {
  const router = useRouter();
  const query = useSearch({ strict: false }) as Record<string, unknown>;
  const profiles = useProfiles();
  const feedback = useActionFeedback();
  const { t } = useHeadscaleI18n();
  const migration = profile.credentialKind.startsWith("legacy-");
  const needsPreviousPassword = profile.credentialKind === "legacy-password";
  const [errorMessage, setErrorMessage] = useState("");
  const [rejectedField, setRejectedField] = useState<
    "passphrase" | "newPassword" | null
  >(null);
  const passphraseRef = useRef<HTMLInputElement>(null);
  const newPasswordRef = useRef<HTMLInputElement>(null);
  const form = useAppForm({
    defaultValues: { passphrase: "", newPassword: "", confirmation: "" },
    validators: {
      onDynamic: ({ value }) => {
        if ((!migration || needsPreviousPassword) && !value.passphrase)
          return { fields: { passphrase: t("sessionSecretRequired") } };
        if (migration) {
          const password = value.newPassword.trim();
          if (password.length < MIN_PROFILE_PASSWORD_LENGTH)
            return { fields: { newPassword: t("profilePasswordMinLength") } };
          if (password !== value.confirmation.trim())
            return { fields: { confirmation: t("passwordsMismatch") } };
        }
      },
    },
    listeners: {
      onChange: () => {
        setRejectedField(null);
        setErrorMessage("");
      },
    },
    onSubmit: async ({ formApi }): Promise<void> => {
      setErrorMessage("");
      setRejectedField(null);
      try {
        const unlocking = migration
          ? profiles.migrateAndEnterProfile(
              profile,
              normalizeNewProfilePassword(formApi.state.values.newPassword),
              needsPreviousPassword
                ? formApi.state.values.passphrase
                : undefined,
            )
          : profiles.enterProfile(profile, formApi.state.values.passphrase);
        clearSecrets();
        if (!(await unlocking)) {
          const previous = needsPreviousPassword || !migration;
          setRejectedField(previous ? "passphrase" : "newPassword");
          (previous ? passphraseRef : newPasswordRef).current?.focus();
          return;
        }
        await router.navigate(
          redirectTarget(
            query.redirect,
            profile,
            router.options.context?.session?.navigationProfile,
          ),
        );
      } catch (error) {
        const message = storageErrorMessage(error);
        setErrorMessage(message);
        feedback.setState({ lastError: message });
      }
    },
  });
  const values = useFormStore(form.store, (state) => state.values);
  const submitting = useFormStore(form.store, (state) => state.isSubmitting);
  const busy = submitting || profiles.authenticatingProfileId === profile.id;
  const storedError = feedback.lastError;
  const shownError =
    errorMessage ||
    (storedError === SAVED_LOCKED_ERROR
      ? t("sessionSavedLocked")
      : storedError);
  function clearSecrets() {
    for (const name of ["passphrase", "newPassword", "confirmation"] as const)
      form.setFieldValue(name, "", {
        dontValidate: true,
        dontRunListeners: true,
      });
  }
  function close() {
    clearSecrets();
    profiles.closeUnlockDialog();
  }
  return (
    <Dialog open onOpenChange={close}>
      <DialogContent data-testid="unlock-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t(migration ? "profileMigrationTitle" : "profileUnlockTitle", {
              name: profile.name,
            })}
          </DialogTitle>
          <DialogDescription>
            {t(migration ? "profileMigrationHint" : "sessionSharedNote")}
          </DialogDescription>
        </DialogHeader>
        <p className="break-all text-xs text-muted-foreground">
          <bdi dir="auto">{profile.baseUrl}</bdi>
        </p>
        <form.AppForm>
          <form.Form className="grid gap-3">
            {(!migration || needsPreviousPassword) && (
              <form.AppField name="passphrase">
                {(field) => (
                  <field.TextField
                    ref={passphraseRef}
                    id="unlock-passphrase"
                    label={t(
                      needsPreviousPassword
                        ? "legacyPasswordLabel"
                        : "serverPassword",
                    )}
                    type="password"
                    data-testid={
                      needsPreviousPassword
                        ? "migration-current-password"
                        : "unlock-passphrase"
                    }
                    autoComplete="current-password"
                    trimOnBlur={false}
                    readOnly={busy}
                    aria-invalid={rejectedField === "passphrase"}
                    aria-describedby={
                      rejectedField === "passphrase" && shownError
                        ? "unlock-error"
                        : undefined
                    }
                  />
                )}
              </form.AppField>
            )}
            {migration && (
              <>
                <form.AppField name="newPassword">
                  {(field) => (
                    <field.TextField
                      ref={newPasswordRef}
                      id="migration-new-password"
                      data-testid="migration-new-password"
                      label={t("newServerPassword")}
                      type="password"
                      autoComplete="new-password"
                      readOnly={busy}
                      description={t("profilePasswordMinLength")}
                      aria-invalid={rejectedField === "newPassword"}
                      aria-describedby={
                        rejectedField === "newPassword" && shownError
                          ? "unlock-error"
                          : undefined
                      }
                    />
                  )}
                </form.AppField>
                <form.AppField name="confirmation">
                  {(field) => (
                    <field.TextField
                      id="migration-confirm-password"
                      data-testid="migration-confirm-password"
                      label={t("encryptionConfirmPassphrase")}
                      type="password"
                      autoComplete="new-password"
                      readOnly={busy}
                    />
                  )}
                </form.AppField>
                <p className="text-xs text-muted-foreground">
                  {t("serverPasswordHint")}
                </p>
              </>
            )}
            {shownError && (
              <p
                id="unlock-error"
                data-testid="unlock-error"
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {shownError}
              </p>
            )}
            <DialogFooter className="flex-row">
              <Button
                type="button"
                variant="outline"
                data-testid="unlock-cancel"
                onClick={close}
              >
                {t("cancel")}
              </Button>
              <form.SubmitButton
                data-testid={migration ? "migration-submit" : "unlock-submit"}
                busy={profiles.authenticatingProfileId === profile.id}
                disabled={
                  busy ||
                  (migration
                    ? !values.newPassword ||
                      !values.confirmation ||
                      (needsPreviousPassword && !values.passphrase)
                    : !values.passphrase)
                }
              >
                {t(migration ? "migrateAndUnlock" : "encryptionUnlockSubmit")}
              </form.SubmitButton>
            </DialogFooter>
          </form.Form>
        </form.AppForm>
        <p className="text-xs text-muted-foreground">
          {t("forgotServerPasswordHint")}
        </p>
      </DialogContent>
    </Dialog>
  );
}
