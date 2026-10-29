import "fake-indexeddb/auto";
import { I18nProvider } from "@lingui/react";
import { act, createElement, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, test } from "vitest";
import { i18n, setLocale } from "@/i18n";
import { loadLocale } from "@/i18n/runtime";
import { hydrateSettings } from "@/lib/settings-storage";
import { useProductCopy } from "./useProductCopy";

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  await hydrateSettings();
  await setLocale("en-US");
});

function Editor() {
  const { copy } = useProductCopy();
  const [name, setName] = useState("");
  useEffect(() => setName(copy.nav.devices), [copy]);
  return createElement(
    "button",
    { type: "button", onClick: () => setName("Draft") },
    name,
  );
}

function Dialog() {
  const { copy } = useProductCopy();
  return createElement(
    "div",
    { role: "dialog" },
    `${copy.nav.devices}|${copy.removeTeam}`,
  );
}

describe("useProductCopy", () => {
  test("does not reset an edited consumer field when its own state rerenders", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(() =>
      root.render(createElement(I18nProvider, { i18n }, createElement(Editor))),
    );
    expect(container.textContent).toBe("Machines");
    await act(() => container.querySelector("button")?.click());
    expect(container.textContent).toBe("Draft");
    await act(() => loadLocale("fr-FR"));
    expect(container.textContent).toBe("Draft");
    await act(() => root.unmount());
    container.remove();
  });

  test("refreshes ordinary product values inside an open dialog on locale change", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(() =>
      root.render(createElement(I18nProvider, { i18n }, createElement(Dialog))),
    );
    expect(container.textContent).toBe("Machines|Delete team");
    await act(() => setLocale("zh-Hans"));
    expect(container.textContent).toBe("设备|删除团队");
    await act(() => root.unmount());
    container.remove();
  });
});
