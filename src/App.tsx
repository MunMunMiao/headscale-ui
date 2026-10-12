import { CatchBoundary, type RouterHistory, RouterProvider } from "@tanstack/react-router";
import { useState } from "react";
import { AppProviders } from "./AppProviders";
import type { BootstrapState } from "./bootstrap";
import ErrorScreen from "./components/ErrorScreen";
import { useSession } from "./composables/session-context";
import { createApplicationRouter } from "./router";

function ApplicationRouter({ history }: { history?: RouterHistory }) {
  const session = useSession();
  const [router] = useState(() => createApplicationRouter(session, history));
  return <RouterProvider router={router} />;
}

export default function App({
  initialState,
  history,
}: {
  initialState: BootstrapState;
  history?: RouterHistory;
}) {
  return (
    // Recovery is Try again (a full reload); a vault reset is only offered from main.tsx.
    <CatchBoundary
      getResetKey={() => 0}
      errorComponent={ErrorScreen}
      onCatch={(error) => console.error("[headscale-ui] render failed", error)}
    >
      <AppProviders initialState={initialState}>
        <ApplicationRouter history={history} />
      </AppProviders>
    </CatchBoundary>
  );
}
