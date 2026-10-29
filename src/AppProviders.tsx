import { DirectionProvider } from "@base-ui/react/direction-provider";
import { I18nProvider } from "@lingui/react";
import { type ReactNode, useEffect, useState } from "react";
import type { BootstrapState } from "./bootstrap";
import { NotificationHost } from "./components/app/notification-host";
import { TooltipProvider } from "./components/app/tooltip";
import ErrorScreen from "./components/ErrorScreen";
import {
  createSession,
  type Session,
  SessionContext,
  useSession,
  useStore,
} from "./composables/session-context";
import { i18n, useHeadscaleI18n } from "./i18n";
import { ApiError } from "./session/types";

/** Preference failures are reported by their state transitions, not by a closing menu. */
function PreferenceFailureNotifier() {
  const { feedback, theme } = useSession();
  const { localeError } = useHeadscaleI18n();
  const { themeError } = useStore(theme);
  useEffect(() => {
    if (!localeError) return;
    feedback.beginNotification({ isCurrent: () => true }).publish({
      tone: localeError === "load-failed" ? "error" : "warning",
      title:
        localeError === "load-failed"
          ? "common.languageLoadFailed"
          : "common.languageNotSaved",
    });
  }, [feedback, localeError]);
  useEffect(() => {
    if (!themeError) return;
    feedback
      .beginNotification({ isCurrent: () => true })
      .publish({ tone: "warning", title: "common.themeNotSaved" });
  }, [feedback, themeError]);
  return null;
}

function RuntimeProviders({ children }: { children: ReactNode }) {
  const session = useSession();
  const { theme } = session;
  const { status } = useStore(session.auth);
  const { meta } = useHeadscaleI18n();
  useEffect(() => session.start(), [session]);
  useEffect(() => {
    theme.applyTheme();
    const preference = window.matchMedia("(prefers-color-scheme: dark)");
    preference.addEventListener("change", theme.applyTheme);
    return () => preference.removeEventListener("change", theme.applyTheme);
  }, [theme]);
  return (
    <DirectionProvider direction={meta.dir}>
      {status === "unavailable" || status === "reload-required" ? (
        <ErrorScreen error={new ApiError({ kind: status })} />
      ) : (
        <TooltipProvider delay={600} closeDelay={0}>
          {children}
          <NotificationHost />
          <PreferenceFailureNotifier />
        </TooltipProvider>
      )}
    </DirectionProvider>
  );
}

export function AppProviders({
  initialState,
  children,
}: {
  initialState: BootstrapState;
  children: ReactNode;
}) {
  const [session] = useState(() => createSession(initialState));
  return <SessionProviders session={session}>{children}</SessionProviders>;
}

export function SessionProviders({
  session,
  children,
}: {
  session: Session;
  children: ReactNode;
}) {
  return (
    <I18nProvider i18n={i18n}>
      <SessionContext.Provider value={session}>
        <RuntimeProviders>{children}</RuntimeProviders>
      </SessionContext.Provider>
    </I18nProvider>
  );
}
