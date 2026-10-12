import { createRoot } from "react-dom/client";
import App from "./App";
import { prepareApplication, resetUnreadableVault } from "./bootstrap";
import ErrorScreen from "./components/ErrorScreen";
import { applyStoredTheme } from "./composables/useTheme";
import { getDatabaseStatus, subscribeDatabaseStatus } from "./lib/idb";
import { VaultDataError } from "./lib/vault-state";
import "./styles/globals.css";

const container = document.getElementById("app");
if (!container) throw new Error("Application root is missing");
const root = createRoot(container);
// Before any screen: recovery screens follow the OS until settings can be read.
applyStoredTheme();

function showDatabaseRecovery(): boolean {
  const databaseStatus = getDatabaseStatus();
  if (databaseStatus === "blocked" || databaseStatus === "reload-required") {
    root.render(<ErrorScreen error={null} databaseStatus={databaseStatus} />);
    return true;
  }
  return false;
}
subscribeDatabaseStatus(showDatabaseRecovery);
showDatabaseRecovery();

async function bootstrap() {
  console.info("[headscale-ui] bootstrap: hydrating settings and profiles from IndexedDB");
  const initialState = await prepareApplication();
  console.info("[headscale-ui] bootstrap: ready");
  if (!showDatabaseRecovery()) root.render(<App initialState={initialState} />);
}

void bootstrap().catch((error: unknown) => {
  console.error("[headscale-ui] bootstrap failed", error);
  if (!showDatabaseRecovery())
    root.render(
      <ErrorScreen
        error={error}
        onReset={error instanceof VaultDataError ? resetUnreadableVault : undefined}
      />,
    );
});
