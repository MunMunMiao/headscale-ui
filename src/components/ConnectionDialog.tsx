import { useStore as useFormStore } from "@tanstack/react-form";
import { KeyRound, Plus, Save } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { connectionSettingsError, sendsApiKeyInClear } from "@/api/connection";
import { CopyButton } from "@/components/app/copy-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/app/dialog";
import { submitForm, useAppForm } from "@/components/app/form";
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
import { Button } from "@/components/ui/button";
import { useSession } from "@/composables/session-context";
import { useActionFeedback } from "@/composables/useActionFeedback";
import type { useConnectionDialog } from "@/composables/useConnectionDialog";
import {
  type ConnectionForm,
  defaultConnectionForm,
  normalizeConnectionForm,
  SAVED_LOCKED_ERROR,
  useProfiles,
} from "@/composables/useProfiles";
import { useHeadscaleI18n } from "@/i18n";
import { MIN_PROFILE_PASSWORD_LENGTH } from "@/lib/api-key-crypto";
import { normalizedBaseUrl } from "@/utils/strings";

function ApiKeyHelp() {
  const { t } = useHeadscaleI18n();
  const command = "headscale apikeys create --expiration 90d";
  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="link"
            className="mt-1 h-auto whitespace-normal px-0 py-1 text-xs"
          />
        }
      >
        <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
        {t("apiKeyGuideTitle")}
      </DialogTrigger>
      <DialogContent data-testid="api-key-guide">
        <DialogHeader>
          <DialogTitle>{t("apiKeyGuideTitle")}</DialogTitle>
          <DialogDescription>{t("apiKeyGuideDescription")}</DialogDescription>
        </DialogHeader>
        <div className="min-w-0 overflow-hidden rounded-md border bg-background p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-muted-foreground">
              {t("apiKeyGuideCommandLabel")}
            </p>
            <CopyButton
              value={command}
              variant="ghost"
              size="sm"
              iconClassName="h-3.5 w-3.5"
              className="h-7 gap-1 px-2 text-xs"
              data-testid="api-key-command-copy"
            >
              {t("copy")}
            </CopyButton>
          </div>
          <code className="mt-2 block overflow-x-auto whitespace-nowrap font-mono text-xs text-foreground">
            {command}
          </code>
        </div>
        <ol className="grid gap-1 ps-5 text-xs text-muted-foreground">
          <li>{t("apiKeyGuideStepServer")}</li>
          <li>{t("apiKeyGuideStepCreate")}</li>
          <li>{t("apiKeyGuideStepCopy")}</li>
          <li>{t("apiKeyGuideStepPaste")}</li>
        </ol>
        <p className="text-xs text-muted-foreground">{t("apiKeyGuideHint")}</p>
        <a
          href="https://docs.headscale.org/ref/remote-cli/"
          target="_blank"
          rel="noreferrer"
          className="inline-flex text-xs font-medium text-primary underline-offset-4 hover:underline"
          data-testid="api-key-docs-link"
        >
          {t("headscaleDocs")}
        </a>
      </DialogContent>
    </Dialog>
  );
}

export default function ConnectionDialog({
  actions,
  continueToServer,
}: {
  actions: ReturnType<typeof useConnectionDialog>;
  continueToServer: (profileId: string) => Promise<void>;
}) {
  const session = useSession();
  const { selectedProfile, isConnecting, connectionCloseConfirmOpen } =
    useProfiles();
  const { lastError } = useActionFeedback();
  const { t } = useHeadscaleI18n();
  const [activating, setActivating] = useState(false);
  const formElement = useRef<HTMLFormElement>(null);
  const newPassword =
    !selectedProfile || selectedProfile.credentialKind === "unreadable";
  const legacyProfile = selectedProfile?.credentialKind.startsWith("legacy-");
  function validateConnection(value: ConnectionForm) {
    const normalized = normalizeConnectionForm(value, selectedProfile);
    const fields: Partial<Record<keyof ConnectionForm, string>> = {};
    const metadataOnly =
      selectedProfile &&
      selectedProfile.credentialKind !== "unreadable" &&
      normalizedBaseUrl(normalized.baseUrl) === selectedProfile.baseUrl &&
      !normalized.apiKey;
    if (metadataOnly) return;
    const error = connectionSettingsError(normalized);
    if (error)
      fields[error === "connectionApiKeyRequired" ? "apiKey" : "baseUrl"] =
        t(error);
    else if (!normalized.password)
      fields.password = t("serverPasswordRequired");
    else if (newPassword) {
      if (normalized.password.length < MIN_PROFILE_PASSWORD_LENGTH)
        fields.password = t("profilePasswordMinLength");
      else if (normalized.password !== normalized.passwordConfirmation)
        fields.passwordConfirmation = t("passwordsMismatch");
    }
    return Object.keys(fields).length ? { fields } : undefined;
  }
  const form = useAppForm({
    defaultValues: defaultConnectionForm(),
    onSubmitMeta: { intent: selectedProfile ? "save" : "unlock" } as {
      intent: "save" | "unlock";
    },
    listeners: {
      onChange: ({ fieldApi }) => {
        session.profiles.setConnectionForm({
          [fieldApi.name]: fieldApi.state.value,
        });
      },
    },
    validators: { onDynamic: ({ value }) => validateConnection(value) },
    onSubmitInvalid: () => {
      requestAnimationFrame(() =>
        formElement.current
          ?.querySelector<HTMLElement>('[aria-invalid="true"]')
          ?.focus(),
      );
    },
    onSubmit: async ({ meta }) => {
      session.profiles.setConnectionForm(
        normalizeConnectionForm(
          session.profiles.getSnapshot().connectionForm,
          session.profiles.selectedProfile,
        ),
      );
      const ticket = session.profiles.connectionFormGeneration;
      const activate = meta.intent === "unlock";
      const savedLocked = SAVED_LOCKED_ERROR;
      const notification = session.feedback.beginNotification({
        isCurrent: () =>
          ticket === session.profiles.connectionFormGeneration &&
          session.feedback.getSnapshot().lastError === savedLocked,
      });
      setActivating(activate);
      await session.profiles.addProfile(activate);
      if (session.feedback.getSnapshot().lastError === savedLocked)
        notification.publish({
          tone: "warning",
          title: "common.sessionSavedLocked",
        });
      if (
        ticket === session.profiles.connectionFormGeneration &&
        !session.feedback.getSnapshot().lastError
      )
        actions.syncConnectionFormBaseline();
      const current = session.auth.getSessionSnapshot();
      if (
        activate &&
        ticket === session.profiles.connectionFormGeneration &&
        current?.status === "unlocked" &&
        current.profile.id ===
          session.profiles.getSnapshot().connectionForm.profileId
      )
        await continueToServer(current.profile.id);
    },
  });
  // 草稿由 profiles 持有；同步清秘密和外部编辑不触发字段监听，也不重置或保存秘密默认值。
  useLayoutEffect(() => {
    function sync() {
      const next = session.profiles.getSnapshot().connectionForm;
      for (const name of Object.keys(next) as (keyof ConnectionForm)[]) {
        if (form.getFieldValue(name) !== next[name])
          form.setFieldValue(name, next[name], {
            dontRunListeners: true,
            dontValidate: true,
            dontUpdateMeta: true,
          });
      }
    }
    sync();
    return session.profiles.subscribe(sync);
  }, [form, session]);
  const submitting = useFormStore(form.store, (state) => state.isSubmitting);
  const busy = isConnecting || submitting;
  return (
    <form.AppForm>
      <Dialog
        open
        onOpenChange={actions.handleConnectionDialogOpen}
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
            <DialogDescription
              className="text-sm leading-5"
              data-testid="connection-description"
            >
              {t(
                selectedProfile && !newPassword
                  ? "serverCredentialEditHint"
                  : "connectSubtitle",
              )}
            </DialogDescription>
            {selectedProfile?.credentialKind === "unreadable" ||
            legacyProfile ? (
              <p
                data-testid="connect-profile-state"
                className="rounded-md border border-amber-400/50 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
              >
                {t(
                  legacyProfile
                    ? "legacyProfileMigrateFirst"
                    : "unreadableProfileRepair",
                )}
              </p>
            ) : null}
          </DialogHeader>
          <form.Form
            ref={formElement}
            className="flex min-h-0 flex-col"
            data-testid="connect-form"
          >
            <div className="grid min-h-0 min-w-0 gap-2 overflow-y-auto px-4 pb-2 sm:gap-4 sm:px-6 sm:pb-3 md:grid-cols-2">
              <form.AppField name="profileName">
                {(field) => (
                  <field.TextField
                    id="connect-profile-name"
                    data-testid="connect-profile-name"
                    label={t("profileName")}
                    fieldClassName="md:col-span-2"
                    readOnly={busy}
                  />
                )}
              </form.AppField>
              <form.AppField name="baseUrl">
                {(field) => (
                  <field.TextField
                    id="connect-server-url"
                    data-testid="connect-server-url"
                    label={t("serverUrl")}
                    fieldClassName="md:col-span-2"
                    inputMode="url"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    readOnly={busy}
                    description={
                      sendsApiKeyInClear(field.state.value) ? (
                        <p
                          data-testid="connect-url-insecure"
                          className="text-amber-700 dark:text-amber-300"
                        >
                          {t("insecureServerUrlWarning")}
                        </p>
                      ) : undefined
                    }
                  />
                )}
              </form.AppField>
              <div className="min-w-0 md:col-span-2">
                <form.AppField name="apiKey">
                  {(field) => (
                    <field.TextField
                      id="connect-api-key"
                      data-testid="connect-api-key"
                      label={t("apiKey")}
                      type="password"
                      placeholder={t("apiKeyPlaceholder")}
                      autoComplete="off"
                      readOnly={busy}
                    />
                  )}
                </form.AppField>
                <ApiKeyHelp />
              </div>
              <form.AppField name="password">
                {(field) => (
                  <field.TextField
                    id="connect-password"
                    data-testid="connect-password"
                    label={t(
                      newPassword ? "serverPassword" : "currentServerPassword",
                    )}
                    fieldClassName="md:col-span-2"
                    type="password"
                    autoComplete={
                      newPassword ? "new-password" : "current-password"
                    }
                    trimOnBlur={newPassword}
                    readOnly={busy}
                    description={
                      newPassword ? (
                        <>
                          <span
                            className="block"
                            data-testid="connect-password-length"
                          >
                            {t("profilePasswordMinLength")}
                          </span>
                          {t("serverPasswordHint")}
                        </>
                      ) : (
                        t("serverCredentialEditHint")
                      )
                    }
                  />
                )}
              </form.AppField>
              {newPassword && (
                <form.AppField name="passwordConfirmation">
                  {(field) => (
                    <field.TextField
                      id="connect-password-confirm"
                      data-testid="connect-password-confirm"
                      errorId="connect-password-mismatch"
                      label={t("encryptionConfirmPassphrase")}
                      fieldClassName="md:col-span-2"
                      type="password"
                      autoComplete="new-password"
                      readOnly={busy}
                    />
                  )}
                </form.AppField>
              )}
              <form.AppField name="remember">
                {(field) => (
                  <field.CheckboxField
                    id="connect-remember"
                    data-testid="connect-remember"
                    label={t("rememberConnection")}
                    description={t("rememberConnectionHint")}
                    fieldClassName="rounded-md border px-3 py-2 text-sm md:col-span-2"
                    readOnly={busy}
                  />
                )}
              </form.AppField>
              <a
                href="https://github.com/MunMunMiao/headscale-ui#connecting-to-headscale-cors"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-medium text-primary underline-offset-4 hover:underline md:col-span-2"
                data-testid="connection-troubleshooting-link"
              >
                {t("connectionTroubleshooting")}
              </a>
            </div>
            <div
              className="grid shrink-0 gap-2 border-t bg-background p-2.5 sm:gap-3 sm:px-6 sm:py-4 md:grid-cols-2"
              data-testid="connect-footer"
            >
              {lastError ? (
                <p
                  data-testid="connect-error"
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
                  onClick={actions.requestConnectionDialogClose}
                >
                  {t("close")}
                </Button>
                <form.SubmitButton
                  type={selectedProfile ? "submit" : "button"}
                  variant={selectedProfile ? "default" : "outline"}
                  className="flex-1 sm:flex-none"
                  data-testid="connect-submit"
                  busy={isConnecting}
                  onClick={
                    selectedProfile
                      ? undefined
                      : () => void submitForm(form, { intent: "save" })
                  }
                >
                  {!busy &&
                    (selectedProfile ? (
                      <Save className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <Plus className="h-4 w-4" aria-hidden="true" />
                    ))}
                  {busy && !activating
                    ? t(selectedProfile ? "savingProfile" : "addingProfile")
                    : t("saveProfile")}
                </form.SubmitButton>
                {!selectedProfile && (
                  <form.SubmitButton
                    className="w-full sm:w-auto"
                    data-testid="connect-save-unlock"
                    busy={isConnecting}
                  >
                    {t("saveAndUnlock")}
                  </form.SubmitButton>
                )}
              </DialogFooter>
            </div>
          </form.Form>
        </DialogContent>
        <AlertDialog
          open={connectionCloseConfirmOpen}
          onOpenChange={actions.handleConnectionCloseConfirmOpen}
        >
          <AlertDialogContent data-testid="discard-profile-changes-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("discardProfileChangesTitle")}
              </AlertDialogTitle>
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
                onClick={actions.confirmConnectionDialogClose}
              >
                {t("discardProfileChanges")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Dialog>
    </form.AppForm>
  );
}
