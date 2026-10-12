import { afterEach, expect, test, vi } from "vitest";
import App from "./App";
import ErrorScreen from "./components/ErrorScreen";

const boundary = vi.hoisted(() => ({
  render: vi.fn(),
  prepare: vi.fn(),
  reset: vi.fn(),
  classToggles: [] as string[],
  createRoot: vi.fn(),
  status: "opening",
  listener: () => {},
}));
vi.mock("react-dom/client", () => ({ createRoot: boundary.createRoot }));
vi.mock("./bootstrap", () => ({
  prepareApplication: boundary.prepare,
  resetUnreadableVault: boundary.reset,
}));
vi.mock("./lib/idb", async (original) => ({
  ...(await original<object>()),
  getDatabaseStatus: () => boundary.status,
  subscribeDatabaseStatus: (listener: () => void) => {
    boundary.listener = listener;
    return () => {};
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function start(container: object | null = {}) {
  vi.resetModules();
  boundary.render.mockClear();
  boundary.status = "opening";
  boundary.listener = () => {};
  boundary.createRoot.mockReset().mockReturnValue({ render: boundary.render });
  boundary.classToggles = [];
  vi.stubGlobal("document", {
    getElementById: vi.fn().mockReturnValue(container),
    documentElement: {
      classList: {
        toggle: (name: string, on: boolean) => {
          boundary.classToggles.push(`${name}:${on}@${boundary.render.mock.calls.length}`);
        },
      },
    },
  });
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  return import("./main");
}

test("waits for secure storage hydration before rendering the application", async () => {
  const ready = Promise.withResolvers<object>();
  boundary.prepare.mockReturnValue(ready.promise);
  await start();
  expect(boundary.render).not.toHaveBeenCalled();
  const initialState = { bridge: "test handshake boundary", profiles: null };
  ready.resolve(initialState);
  await vi.waitFor(() => expect(boundary.render).toHaveBeenCalledTimes(1));
  const element = boundary.render.mock.calls[0]?.[0];
  expect(element.type.name).toBe(App.name);
  expect(element.props.initialState).toBe(initialState);
});

test("renders recoverable startup errors instead of a partially hydrated application", async () => {
  const error = new Error("IndexedDB unavailable");
  boundary.prepare.mockRejectedValue(error);
  await start();
  await vi.waitFor(() => expect(boundary.render).toHaveBeenCalledTimes(1));
  const element = boundary.render.mock.calls[0]?.[0];
  expect(element.type.name).toBe(ErrorScreen.name);
  expect(element.props.error).toBe(error);
});

test("reports a missing application root without attempting to hydrate data", async () => {
  boundary.prepare.mockClear();
  await expect(start(null)).rejects.toThrow("Application root is missing");
  expect(boundary.prepare).not.toHaveBeenCalled();
  expect(boundary.createRoot).not.toHaveBeenCalled();
});

test("shows a blocked database while waiting, then renders after the existing startup completes", async () => {
  const ready = Promise.withResolvers<object>();
  boundary.prepare.mockReturnValue(ready.promise);
  await start();
  boundary.status = "blocked";
  boundary.listener();
  expect(boundary.render.mock.lastCall?.[0].props.databaseStatus).toBe("blocked");
  boundary.status = "ready";
  boundary.listener();
  expect(boundary.render.mock.lastCall?.[0].type.name).toBe(ErrorScreen.name);
  ready.resolve({ bridge: "ready", profiles: null });
  await vi.waitFor(() => expect(boundary.render.mock.lastCall?.[0].type.name).toBe(App.name));
});

test("removes the mounted app when its database requires reload", async () => {
  boundary.prepare.mockResolvedValue({ bridge: "ready", profiles: null });
  await start();
  await vi.waitFor(() => expect(boundary.render.mock.lastCall?.[0].type.name).toBe(App.name));
  boundary.status = "reload-required";
  boundary.listener();
  expect(boundary.render.mock.lastCall?.[0].props.databaseStatus).toBe("reload-required");
  expect(boundary.render.mock.lastCall?.[0].type.name).toBe(ErrorScreen.name);
});

test("does not mount a late bootstrap result after the database requires reload", async () => {
  const ready = Promise.withResolvers<object>();
  boundary.prepare.mockReturnValue(ready.promise);
  await start();
  boundary.status = "reload-required";
  boundary.listener();
  ready.resolve({ bridge: "stale", profiles: null });
  await vi.waitFor(() => expect(boundary.render).toHaveBeenCalledTimes(2));
  expect(
    boundary.render.mock.calls.every(([element]) => element.type.name === ErrorScreen.name),
  ).toBe(true);
});

test("applies the OS or stored theme before the first render so recovery screens are themed", async () => {
  boundary.prepare.mockRejectedValue(new Error("hydrate failed"));
  await start();
  await vi.waitFor(() => expect(boundary.render).toHaveBeenCalledTimes(1));
  expect(boundary.classToggles).toEqual(["dark:false@0", "light:true@0"]);
});

test("offers the shared-session vault reset only for an unreadable vault", async () => {
  boundary.prepare.mockImplementation(async () => {
    throw new (await import("./lib/vault-state")).VaultDataError();
  });
  await start();
  await vi.waitFor(() => expect(boundary.render).toHaveBeenCalledTimes(1));
  expect(boundary.render.mock.calls[0]?.[0].props.onReset).toBe(boundary.reset);
});

test("other startup failures, including session errors, never get a reset action", async () => {
  boundary.prepare.mockImplementation(async () => {
    throw new (await import("./api/gateway")).ApiError({ kind: "storage-failed" });
  });
  await start();
  await vi.waitFor(() => expect(boundary.render).toHaveBeenCalledTimes(1));
  expect(boundary.render.mock.calls[0]?.[0].props.error.name).toBe("ApiError");
  expect(boundary.render.mock.calls[0]?.[0].props.onReset).toBeUndefined();
});

test.each(["blocked", "reload-required"])(
  "a startup failure while the database is %s keeps the recovery screen instead of the error",
  async (status) => {
    const ready = Promise.withResolvers<object>();
    boundary.prepare.mockReturnValue(ready.promise);
    await start();
    boundary.status = status;
    boundary.listener();
    ready.reject(new Error("IndexedDB blocked"));
    await vi.waitFor(() => expect(boundary.render).toHaveBeenCalledTimes(2));
    for (const [element] of boundary.render.mock.calls) {
      expect(element.type.name).toBe(ErrorScreen.name);
      expect(element.props).toMatchObject({ error: null, databaseStatus: status });
    }
  },
);
