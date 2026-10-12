import "fake-indexeddb/auto";
import { I18nProvider } from "@lingui/react";
import { IDBFactory } from "fake-indexeddb";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { __resetForTest, STORE_META } from "@/lib/idb";
import * as settings from "@/lib/settings-storage";
import {
  captureSettingsWriteEpoch,
  hydrateSettings,
  readSetting,
  settingsStorageTestingHandle,
  writeSetting,
} from "@/lib/settings-storage";
import { notifyVaultChanged } from "@/lib/vault-state";
import { idbPut } from "@/test-utils/storage";
import { applyStoredLocale, i18n, setLocale, t, useHeadscaleI18n } from "./index";
import * as runtime from "./runtime";

vi.mock("@/lib/settings-storage", { spy: true });
vi.mock("./runtime", { spy: true });

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.indexedDB = new IDBFactory();
  __resetForTest();
  settingsStorageTestingHandle.reset();
  await hydrateSettings();
  await setLocale("en-US");
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("locale integration", () => {
  test("uses English document metadata when a persisted catalog fails during startup", async () => {
    await writeSetting("locale", "fr-FR", captureSettingsWriteEpoch());
    document.documentElement.lang = "ar";
    document.documentElement.dir = "rtl";
    vi.mocked(runtime.loadLocale).mockRejectedValueOnce(new Error("catalog offline"));
    await applyStoredLocale();
    expect(i18n.locale).toBe("en-US");
    expect(document.documentElement.lang).toBe("en-US");
    expect(document.documentElement.dir).toBe("ltr");
    expect(readSetting("locale")).toBe("fr-FR");
  });
  test("reports failed preference refreshes and re-reads notifications without activating a remote locale", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let current!: ReturnType<typeof useHeadscaleI18n>;
    function Probe() {
      current = useHeadscaleI18n();
      return createElement("p", null, `${current.locale}|${current.settingsError ?? "ready"}`);
    }
    await act(() => root.render(createElement(I18nProvider, { i18n }, createElement(Probe))));
    const version = { keyEpoch: captureSettingsWriteEpoch(), profilesRevision: 0 };
    vi.mocked(settings.hydrateSettings).mockRejectedValueOnce(new Error("read unavailable"));
    await act(async () => {
      notifyVaultChanged(version);
      await Promise.resolve();
    });
    expect(current.settingsError).toBe("reload-failed");
    await idbPut(STORE_META, { locale: "ar", theme: "dark" }, "ui-settings");
    await act(async () => {
      notifyVaultChanged(version);
      await vi.waitFor(() => expect(readSetting("locale")).toBe("ar"));
    });
    expect(current.settingsError).toBeNull();
    expect(current.locale).toBe("en-US");
    expect(document.documentElement.dir).toBe("ltr");

    const late = Promise.withResolvers<void>();
    vi.mocked(settings.hydrateSettings).mockReturnValueOnce(late.promise);
    await act(async () => {
      notifyVaultChanged(version);
      notifyVaultChanged(version);
      await vi.waitFor(() => expect(settings.hydrateSettings).toHaveBeenCalled());
      late.reject(new Error("old read failure"));
    });
    expect(current.settingsError).toBeNull();
    await act(() => root.unmount());
  });
  test("a superseded successful preference refresh cannot hide a newer refresh failure", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let current!: ReturnType<typeof useHeadscaleI18n>;
    function Probe() {
      current = useHeadscaleI18n();
      return createElement("p", null, current.settingsError ?? "ready");
    }
    await act(() => root.render(createElement(I18nProvider, { i18n }, createElement(Probe))));
    const version = { keyEpoch: captureSettingsWriteEpoch(), profilesRevision: 0 };
    const late = Promise.withResolvers<void>();
    vi.mocked(settings.hydrateSettings)
      .mockReturnValueOnce(late.promise)
      .mockRejectedValueOnce(new Error("newer read failure"));
    await act(async () => {
      notifyVaultChanged(version);
      notifyVaultChanged(version);
      await vi.waitFor(() => expect(current.settingsError).toBe("reload-failed"));
    });
    await act(async () => {
      late.resolve();
      await late.promise;
    });
    expect(current.settingsError).toBe("reload-failed");
    await act(() => root.unmount());
  });
  test("restores a saved legacy tag before React mounts and syncs document metadata", async () => {
    await writeSetting("locale", "fr", captureSettingsWriteEpoch());
    await applyStoredLocale();
    expect(i18n.locale).toBe("fr-FR");
    expect(readSetting("locale")).toBe("fr");
    expect(document.documentElement.lang).toBe("fr-FR");
    expect(document.documentElement.dir).toBe("ltr");
    await writeSetting("locale", "unsupported", captureSettingsWriteEpoch());
    await applyStoredLocale();
    expect(i18n.locale).toBe("en-US");
  });

  test("returns a missing localized key rather than an English descriptor fallback", async () => {
    // An incomplete active catalog must not borrow the source-locale text.
    await setLocale("ar");
    const dark = i18n.messages["common.dark"];
    if (dark === undefined) throw new Error("Arabic dark translation is missing");
    delete i18n.messages["common.dark"];
    try {
      expect(t("light")).toBe("فاتح");
      expect(t("dark")).toBe("dark");
    } finally {
      i18n.load("ar", { "common.dark": dark });
    }
  });

  test("updates an already mounted dialog and keeps callable helpers stable", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let current!: ReturnType<typeof useHeadscaleI18n>;
    function Dialog() {
      current = useHeadscaleI18n();
      return createElement(
        "div",
        { role: "dialog", "data-dir": current.meta.dir },
        `${current.locale}|${current.t("light")}`,
      );
    }
    await act(() => root.render(createElement(I18nProvider, { i18n }, createElement(Dialog))));
    const methods = {
      t: current.t,
      setLocale: current.setLocale,
    };
    expect(container.textContent).toBe("en-US|Light");
    expect(current.t("profileUnlockTitle", { name: "Alpha" })).toBe("Unlock Alpha");
    await act(() => current.setLocale("ar"));
    expect(current.locale).toBe("ar");
    expect(current.meta.dir).toBe("rtl");
    expect(container.querySelector('[role="dialog"]')?.getAttribute("data-dir")).toBe("rtl");
    expect(container.textContent).toBe("ar|فاتح");
    expect(current.t).toBe(methods.t);
    expect(current.setLocale).toBe(methods.setLocale);
    expect(readSetting("locale")).toBe("ar");
    expect(document.documentElement.lang).toBe("ar");
    expect(document.documentElement.dir).toBe("rtl");
    await act(() => root.unmount());
  });
});
