import { useEffect, useId, useRef, useState } from "react";
import { t } from "@/i18n";
import type { DatabaseStatus } from "@/lib/idb";
import { VaultDataError } from "@/lib/vault-state";
import { ApiError } from "@/session/types";
import { getErrorMessage } from "@/utils/error-mapping";
import { storageErrorMessage } from "@/utils/storage-error";

type ResetPhase = "idle" | "confirm" | "busy" | "done";

export default function ErrorScreen(props: {
  error?: unknown;
  reloadPage?: () => void;
  databaseStatus?: DatabaseStatus;
  /** Worker-mediated vault repair; resolves false when tab metadata could not be cleared. */
  onReset?: () => Promise<boolean>;
}) {
  const reload = props.reloadPage ?? window.location.reload.bind(window.location);
  const blocked = props.databaseStatus === "blocked";
  const reloadRequired = props.databaseStatus === "reload-required";
  const databaseRecovery = blocked || reloadRequired;
  const sessionRecovery = props.error instanceof ApiError && props.error.kind !== "api";
  const vaultData = !databaseRecovery && props.error instanceof VaultDataError;
  const [phase, setPhase] = useState<ResetPhase>("idle");
  const [message, setMessage] = useState("");
  const id = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  // The screen replaces the page, so keyboard and screen reader users start from its title.
  useEffect(() => titleRef.current?.focus(), []);

  function describe(err: unknown): string {
    if (err instanceof Error) return `${err.name}: ${err.message}`;
    if (typeof err === "string") return err;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }

  async function reset(onReset: () => Promise<boolean>) {
    setPhase("busy");
    setMessage("");
    try {
      if (await onReset()) {
        reload();
        return;
      }
      setMessage(t("resetMetadataWarning"));
      setPhase("done");
    } catch (error) {
      setMessage(storageErrorMessage(error));
      setPhase("confirm");
    }
  }

  const buttonClass =
    "inline-flex h-9 items-center justify-center rounded-md border bg-background px-3 text-sm font-medium hover:bg-accent disabled:opacity-50";
  const resetAction = vaultData ? props.onReset : undefined;
  const busy = phase === "busy";

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-background p-4 text-foreground"
      data-testid="error-screen"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
    >
      <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
        <h1
          id={`${id}-title`}
          ref={titleRef}
          tabIndex={-1}
          className="text-lg font-semibold outline-none"
        >
          {blocked
            ? t("databaseBlockedTitle")
            : reloadRequired
              ? t("databaseReloadTitle")
              : sessionRecovery
                ? t("appTitle")
                : t("appErrorTitle")}
        </h1>
        <p id={`${id}-description`} className="mt-2 text-sm text-muted-foreground">
          {blocked
            ? t("databaseBlockedDescription")
            : reloadRequired
              ? t("databaseReloadDescription")
              : sessionRecovery
                ? getErrorMessage(props.error)
                : vaultData
                  ? t("vaultData")
                  : t("appErrorDescription")}
        </p>
        {!databaseRecovery && !sessionRecovery && !vaultData && (
          <pre
            dir="ltr"
            className="mt-4 max-h-32 overflow-auto rounded border bg-muted px-3 py-2 text-xs text-muted-foreground"
          >
            {describe(props.error)}
          </pre>
        )}
        {message && (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {message}
          </p>
        )}
        {resetAction && (phase === "confirm" || busy) && (
          <div className="mt-4 text-sm">
            <p className="font-medium">{t("forgotConfirmTitle")}</p>
            <p className="mt-1 text-muted-foreground">{t("clearProfilesDescription")}</p>
          </div>
        )}
        <div className="mt-4 flex flex-col gap-2">
          {resetAction && phase === "idle" && (
            <button
              type="button"
              className={`${buttonClass} text-destructive`}
              data-testid="error-reset"
              onClick={() => setPhase("confirm")}
            >
              {t("encryptionForgottenButton")}
            </button>
          )}
          {resetAction && (phase === "confirm" || busy) && (
            <>
              <button
                type="button"
                className={`${buttonClass} border-destructive text-destructive`}
                data-testid="error-reset-confirm"
                disabled={busy}
                aria-busy={busy}
                onClick={() => void reset(resetAction)}
              >
                {t("encryptionForgottenButton")}
              </button>
              <button
                type="button"
                className={buttonClass}
                data-testid="error-reset-cancel"
                disabled={busy}
                onClick={() => setPhase("idle")}
              >
                {t("cancel")}
              </button>
            </>
          )}
          <button type="button" className={buttonClass} data-testid="error-reload" onClick={reload}>
            {t("tryAgain")}
          </button>
        </div>
      </div>
    </div>
  );
}
