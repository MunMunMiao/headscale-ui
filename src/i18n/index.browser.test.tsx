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
import { clearAllSecureData } from "@/lib/secure-storage";
import {
  applyStoredLocale,
  i18n,
  setLocale,
  t,
  useHeadscaleI18n,
} from "./index";
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

type I18nProbeProps = {
  onValue: (value: ReturnType<typeof useHeadscaleI18n>) => void;
};

function LocaleProbe({ onValue }: I18nProbeProps) {
  const current = useHeadscaleI18n();
  onValue(current);
  return createElement(
    "p",
    null,
    `${current.locale}|${current.settingsError ?? "ready"}`,
  );
}

function SettingsProbe({ onValue }: I18nProbeProps) {
  const current = useHeadscaleI18n();
  onValue(current);
  return createElement("p", null, current.settingsError ?? "ready");
}

function Dialog({ onValue }: I18nProbeProps) {
  const current = useHeadscaleI18n();
  onValue(current);
  return createElement(
    "div",
    { role: "dialog", "data-dir": current.meta.dir },
    `${current.locale}|${current.t("light")}`,
  );
}

describe("locale integration", () => {
  test("usability: a peer locale hint adopts only the stored preference without writing it back", async () => {
    const peer = new BroadcastChannel("headscale-ui-preferences");
    try {
      await idbPut(STORE_META, { locale: "ar", theme: "dark" }, "ui-settings");
      const write = vi.mocked(settings.writeSetting);
      write.mockClear();
      peer.postMessage("locale");
      await vi.waitFor(() => expect(i18n.locale).toBe("ar"));
      expect(document.documentElement.lang).toBe("ar");
      expect(document.documentElement.dir).toBe("rtl");
      expect(readSetting("locale")).toBe("ar");
      expect(write).not.toHaveBeenCalled();
    } finally {
      peer.close();
    }
  });
  test("review I3: an unrelated vault hint cannot cancel an already received locale adoption", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let current!: ReturnType<typeof useHeadscaleI18n>;
    await act(() =>
      root.render(
        createElement(
          I18nProvider,
          { i18n },
          createElement(LocaleProbe, {
            onValue: (value) => {
              current = value;
            },
          }),
        ),
      ),
    );
    const peer = new BroadcastChannel("headscale-ui-preferences");
    const pending = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    vi.mocked(settings.hydrateSettings).mockImplementationOnce(() => {
      started.resolve();
      return pending.promise;
    });
    const write = vi.mocked(settings.writeSetting);
    write.mockClear();
    try {
      await idbPut(STORE_META, { locale: "ar", theme: "dark" }, "ui-settings");
      await act(async () => {
        peer.postMessage("locale");
        await started.promise;
        notifyVaultChanged({
          keyEpoch: captureSettingsWriteEpoch(),
          profilesRevision: 1,
        });
        await vi.waitFor(() => expect(readSetting("locale")).toBe("ar"));
        pending.resolve();
        await pending.promise;
      });
      await vi.waitFor(() => expect(current.locale).toBe("ar"));
      expect(document.documentElement.dir).toBe("rtl");
      expect(write).not.toHaveBeenCalled();
    } finally {
      peer.close();
      await act(() => root.unmount());
    }
  });

  test("review I3: locale adoption cannot hide a newer vault read error", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let current!: ReturnType<typeof useHeadscaleI18n>;
    await act(() =>
      root.render(
        createElement(
          I18nProvider,
          { i18n },
          createElement(LocaleProbe, {
            onValue: (value) => {
              current = value;
            },
          }),
        ),
      ),
    );
    await idbPut(STORE_META, { locale: "ar" }, "ui-settings");
    await settings.hydrateSettings();
    const pending = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    vi.mocked(settings.hydrateSettings)
      .mockImplementationOnce(() => {
        started.resolve();
        return pending.promise;
      })
      .mockRejectedValueOnce(new Error("newer profile reread failed"));
    const peer = new BroadcastChannel("headscale-ui-preferences");
    try {
      await act(async () => {
        peer.postMessage("locale");
        await started.promise;
        notifyVaultChanged({
          keyEpoch: captureSettingsWriteEpoch(),
          profilesRevision: 2,
        });
        await vi.waitFor(() =>
          expect(current.settingsError).toBe("reload-failed"),
        );
        pending.resolve();
        await pending.promise;
        await vi.waitFor(() => expect(current.locale).toBe("ar"));
      });
      expect(current.settingsError).toBe("reload-failed");
    } finally {
      peer.close();
      await act(() => root.unmount());
    }
  });

  test.each(["selection", "reset"] as const)(
    "a delayed peer locale read cannot override a newer %s",
    async (boundary) => {
      const peer = new BroadcastChannel("headscale-ui-preferences");
      const pending = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      vi.mocked(settings.hydrateSettings).mockImplementationOnce(() => {
        started.resolve();
        return pending.promise;
      });
      try {
        await idbPut(STORE_META, { locale: "ar" }, "ui-settings");
        peer.postMessage("locale");
        await started.promise;
        if (boundary === "selection") await setLocale("fr-FR");
        else await clearAllSecureData();
        pending.resolve();
        await pending.promise;
        await Promise.resolve();
        expect(i18n.locale).toBe(boundary === "selection" ? "fr-FR" : "en-US");
      } finally {
        peer.close();
      }
    },
  );

  test("peer preference rereads keep the newest failure and recover without writes", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let current!: ReturnType<typeof useHeadscaleI18n>;
    await act(() =>
      root.render(
        createElement(
          I18nProvider,
          { i18n },
          createElement(SettingsProbe, {
            onValue: (value) => {
              current = value;
            },
          }),
        ),
      ),
    );
    const peer = new BroadcastChannel("headscale-ui-preferences");
    const pending = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    vi.mocked(settings.hydrateSettings)
      .mockImplementationOnce(() => {
        started.resolve();
        return pending.promise;
      })
      .mockRejectedValueOnce(new Error("latest peer read failed"));
    try {
      await act(async () => {
        peer.postMessage("locale");
        await started.promise;
        peer.postMessage("locale");
        await vi.waitFor(() =>
          expect(current.settingsError).toBe("reload-failed"),
        );
        pending.reject(new Error("older peer read failed"));
        await pending.promise.catch(() => {});
      });
      expect(current.settingsError).toBe("reload-failed");
      const superseded = Promise.withResolvers<void>();
      const oldReadStarted = Promise.withResolvers<void>();
      vi.mocked(settings.hydrateSettings).mockImplementationOnce(() => {
        oldReadStarted.resolve();
        return superseded.promise;
      });
      await idbPut(STORE_META, { locale: "ar" }, "ui-settings");
      await act(async () => {
        peer.postMessage("locale");
        await oldReadStarted.promise;
        peer.postMessage("locale");
        await vi.waitFor(() => expect(current.locale).toBe("ar"));
        superseded.resolve();
        await superseded.promise;
      });
      expect(current.settingsError).toBeNull();
      expect(current.locale).toBe("ar");
    } finally {
      peer.close();
      await act(() => root.unmount());
    }
  });

  test("uses English document metadata when a persisted catalog fails during startup", async () => {
    await writeSetting("locale", "fr-FR", captureSettingsWriteEpoch());
    document.documentElement.lang = "ar";
    document.documentElement.dir = "rtl";
    vi.mocked(runtime.loadLocale).mockRejectedValueOnce(
      new Error("catalog offline"),
    );
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
    await act(() =>
      root.render(
        createElement(
          I18nProvider,
          { i18n },
          createElement(LocaleProbe, {
            onValue: (value) => {
              current = value;
            },
          }),
        ),
      ),
    );
    const version = {
      keyEpoch: captureSettingsWriteEpoch(),
      profilesRevision: 0,
    };
    vi.mocked(settings.hydrateSettings).mockRejectedValueOnce(
      new Error("read unavailable"),
    );
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
      await vi.waitFor(() =>
        expect(settings.hydrateSettings).toHaveBeenCalled(),
      );
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
    await act(() =>
      root.render(
        createElement(
          I18nProvider,
          { i18n },
          createElement(SettingsProbe, {
            onValue: (value) => {
              current = value;
            },
          }),
        ),
      ),
    );
    const version = {
      keyEpoch: captureSettingsWriteEpoch(),
      profilesRevision: 0,
    };
    const late = Promise.withResolvers<void>();
    vi.mocked(settings.hydrateSettings)
      .mockReturnValueOnce(late.promise)
      .mockRejectedValueOnce(new Error("newer read failure"));
    await act(async () => {
      notifyVaultChanged(version);
      notifyVaultChanged(version);
      await vi.waitFor(() =>
        expect(current.settingsError).toBe("reload-failed"),
      );
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
    if (dark === undefined)
      throw new Error("Arabic dark translation is missing");
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
    await act(() =>
      root.render(
        createElement(
          I18nProvider,
          { i18n },
          createElement(Dialog, {
            onValue: (value) => {
              current = value;
            },
          }),
        ),
      ),
    );
    const methods = {
      t: current.t,
      setLocale: current.setLocale,
    };
    expect(container.textContent).toBe("en-US|Light");
    expect(current.t("profileUnlockTitle", { name: "Alpha" })).toBe(
      "Unlock Alpha",
    );
    await act(() => current.setLocale("ar"));
    expect(current.locale).toBe("ar");
    expect(current.meta.dir).toBe("rtl");
    expect(
      container.querySelector('[role="dialog"]')?.getAttribute("data-dir"),
    ).toBe("rtl");
    expect(container.textContent).toBe("ar|فاتح");
    expect(current.t).toBe(methods.t);
    expect(current.setLocale).toBe(methods.setLocale);
    expect(readSetting("locale")).toBe("ar");
    expect(document.documentElement.lang).toBe("ar");
    expect(document.documentElement.dir).toBe("rtl");
    await act(() => root.unmount());
  });
});
