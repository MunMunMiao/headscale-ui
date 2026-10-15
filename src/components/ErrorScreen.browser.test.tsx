import { afterEach, describe, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { i18n, loadLocale } from "@/i18n/runtime";
import { VaultConflictError, VaultDataError } from "@/lib/vault-state";
import { ApiError } from "@/session/types";
import ErrorScreen from "./ErrorScreen";

afterEach(() => {
  vi.restoreAllMocks();
  i18n.activate("en-US");
});

test.each([
  new Error("storage unavailable"),
  "storage unavailable",
  { reason: "storage unavailable" },
])("shows bootstrap failures and retries without deleting data: %s", async (error) => {
  const reloadPage = vi.fn();
  await render(<ErrorScreen error={error} reloadPage={reloadPage} />);
  await expect.element(page.getByTestId("error-screen")).toMatchTextContent("storage unavailable");
  await page.getByTestId("error-reload").click();
  expect(reloadPage).toHaveBeenCalledTimes(1);
});
test("can still render an error that cannot be serialized", async () => {
  const error: { cause?: unknown } = {};
  error.cause = error;
  await render(<ErrorScreen error={error} reloadPage={vi.fn()} />);
  await expect.element(page.getByTestId("error-screen")).toMatchTextContent("[object Object]");
});

test.each(["blocked", "reload-required"] as const)(
  "database %s recovery preserves saved data and does not offer reset",
  async (databaseStatus) => {
    const reloadPage = vi.fn();
    await render(<ErrorScreen databaseStatus={databaseStatus} reloadPage={reloadPage} />);
    await expect
      .element(page.getByTestId("error-screen"))
      .toMatchTextContent("saved connections will be preserved");
    await expect.element(page.getByTestId("error-reset")).not.toBeInTheDocument();
    await page.getByTestId("error-reload").click();
    expect(reloadPage).toHaveBeenCalledTimes(1);
  },
);
test.each([
  {
    locale: "zh-Hans",
    databaseStatus: "blocked",
    title: "关闭旧的 Headscale UI 标签页",
    description:
      "旧页面仍占用本地数据库。请关闭其他 Headscale UI 标签页以继续。已保存的连接将被保留。",
    retry: "重试",
  },
  {
    locale: "zh-Hans",
    databaseStatus: "reload-required",
    title: "重新加载此页面",
    description: "另一个页面已升级本地数据库。请重新加载此页面后再继续。已保存的连接将被保留。",
    retry: "重试",
  },
  {
    locale: "ar",
    databaseStatus: "blocked",
    title: "أغلق علامات تبويب Headscale UI القديمة",
    description:
      "تُبقي صفحة قديمة قاعدة البيانات المحلية مفتوحة. أغلق علامات تبويب Headscale UI الأخرى للمتابعة. سيتم الاحتفاظ باتصالاتك المحفوظة.",
    retry: "حاول مجددًا",
  },
  {
    locale: "ar",
    databaseStatus: "reload-required",
    title: "أعد تحميل هذه الصفحة",
    description:
      "قامت صفحة أخرى بترقية قاعدة البيانات المحلية. أعد تحميل هذه الصفحة قبل المتابعة. سيتم الاحتفاظ باتصالاتك المحفوظة.",
    retry: "حاول مجددًا",
  },
] as const)(
  "renders $databaseStatus recovery in $locale without an i18n provider",
  async ({ locale, databaseStatus, title, description, retry }) => {
    await loadLocale(locale);
    i18n.activate(locale);
    const reloadPage = vi.fn();
    await render(<ErrorScreen databaseStatus={databaseStatus} reloadPage={reloadPage} />);
    await expect.element(page.getByRole("heading", { level: 1 })).toHaveTextContent(title);
    await expect.element(page.getByTestId("error-screen")).toMatchTextContent(description);
    await expect.element(page.getByTestId("error-reload")).toHaveTextContent(retry);
    await expect.element(page.getByTestId("error-reset")).not.toBeInTheDocument();
    await page.getByTestId("error-reload").click();
    expect(reloadPage).toHaveBeenCalledTimes(1);
  },
);

test("startup recovery never offers a page-side reset before the shared session can be locked", async () => {
  const clear = vi.spyOn(IDBObjectStore.prototype, "clear");
  const reloadPage = vi.fn();
  await render(<ErrorScreen error="storage unavailable" reloadPage={reloadPage} />);
  await expect.element(page.getByTestId("error-reset")).not.toBeInTheDocument();
  await page.getByTestId("error-reload").click();
  expect(clear).not.toHaveBeenCalled();
  expect(reloadPage).toHaveBeenCalledTimes(1);
});

test.each([
  { locale: "zh-Hans", kind: "unavailable", text: "共享会话不可用" },
  { locale: "zh-Hans", kind: "reload-required", text: "此页面与共享会话不兼容" },
  { locale: "ar", kind: "unavailable", text: "الجلسة المشتركة غير متاحة" },
  { locale: "ar", kind: "reload-required", text: "هذه الصفحة غير متوافقة مع الجلسة المشتركة" },
] as const)(
  "localizes $kind recovery in $locale outside a Provider",
  async ({ locale, kind, text }) => {
    await loadLocale(locale);
    i18n.activate(locale);
    const reloadPage = vi.fn();
    await render(<ErrorScreen error={new ApiError({ kind })} reloadPage={reloadPage} />);
    await expect.element(page.getByTestId("error-screen")).toMatchTextContent(text);
    await expect
      .element(page.getByTestId("error-screen"))
      .not.toMatchTextContent("Session request failed");
    await expect.element(page.getByTestId("error-reset")).not.toBeInTheDocument();
    await page.getByTestId("error-reload").click();
    expect(reloadPage).toHaveBeenCalledTimes(1);
  },
);

test("the generic failure screen is localized and keeps the raw detail left-to-right", async () => {
  const reloadPage = vi.fn();
  await render(<ErrorScreen error={new Error("storage unavailable")} reloadPage={reloadPage} />);
  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toHaveTextContent("Headscale UI ran into a problem");
  await expect.element(page.getByTestId("error-screen")).not.toMatchTextContent("failed to start");
  expect(page.getByTestId("error-screen").element().querySelector("pre")?.dir).toBe("ltr");
});

test.each([
  {
    locale: "zh-Hans",
    title: "Headscale UI 遇到了问题",
    description: "此页面未能完成加载或显示。",
    retry: "重试",
  },
  {
    locale: "ar",
    title: "واجهت Headscale UI مشكلة",
    description: "تعذّر إكمال تحميل هذه الصفحة أو عرضها.",
    retry: "حاول مجددًا",
  },
] as const)("localizes the generic failure screen in $locale", async (c) => {
  await loadLocale(c.locale);
  i18n.activate(c.locale);
  await render(<ErrorScreen error={new Error("storage unavailable")} reloadPage={vi.fn()} />);
  await expect.element(page.getByRole("heading", { level: 1 })).toHaveTextContent(c.title);
  await expect.element(page.getByTestId("error-screen")).toMatchTextContent(c.description);
  await expect.element(page.getByTestId("error-reload")).toHaveTextContent(c.retry);
});

describe("unreadable vault reset", () => {
  const confirmTitle = "Clear all encrypted data?";
  const label = "Clear all saved profiles";

  test("an unreadable vault without an injected reset only offers Try again", async () => {
    await render(<ErrorScreen error={new VaultDataError()} reloadPage={vi.fn()} />);
    await expect
      .element(page.getByTestId("error-screen"))
      .toMatchTextContent(
        "Some saved connection data cannot be read. Existing data was preserved.",
      );
    expect(page.getByTestId("error-screen").element().querySelector("pre")).toBeNull();
    await expect.element(page.getByTestId("error-reset")).not.toBeInTheDocument();
  });

  test.each([
    ["a generic error", { error: new Error("boom") }],
    ["a session error", { error: new ApiError({ kind: "unavailable" }) }],
    ["a blocked database", { error: null, databaseStatus: "blocked" as const }],
    ["a reload-required database", { error: null, databaseStatus: "reload-required" as const }],
  ])("%s never offers the reset even when one is passed", async (_name, props) => {
    const onReset = vi.fn();
    await render(<ErrorScreen {...props} onReset={onReset} reloadPage={vi.fn()} />);
    await expect.element(page.getByTestId("error-reload")).toBeVisible();
    await expect.element(page.getByTestId("error-reset")).not.toBeInTheDocument();
    expect(onReset).not.toHaveBeenCalled();
  });

  test("asks for confirmation, can be cancelled and never resets by itself", async () => {
    const onReset = vi.fn();
    await render(
      <ErrorScreen error={new VaultDataError()} onReset={onReset} reloadPage={vi.fn()} />,
    );
    await expect.element(page.getByTestId("error-reset")).toHaveTextContent(label);
    await expect.element(page.getByTestId("error-reset-confirm")).not.toBeInTheDocument();
    await page.getByTestId("error-reset").click();
    await expect.element(page.getByTestId("error-screen")).toMatchTextContent(confirmTitle);
    await expect.element(page.getByTestId("error-reset-confirm")).toHaveTextContent(label);
    await page.getByTestId("error-reset-cancel").click();
    await expect.element(page.getByTestId("error-reset")).toBeVisible();
    await expect.element(page.getByTestId("error-reset-confirm")).not.toBeInTheDocument();
    expect(onReset).not.toHaveBeenCalled();
  });

  test("confirming resets once, disables both buttons while busy, then reloads", async () => {
    const pending = Promise.withResolvers<boolean>();
    const onReset = vi.fn().mockReturnValue(pending.promise);
    const reloadPage = vi.fn();
    await render(
      <ErrorScreen error={new VaultDataError()} onReset={onReset} reloadPage={reloadPage} />,
    );
    await page.getByTestId("error-reset").click();
    await page.getByTestId("error-reset-confirm").click();
    await expect.element(page.getByTestId("error-reset-confirm")).toBeDisabled();
    await expect
      .element(page.getByTestId("error-reset-confirm"))
      .toHaveAttribute("aria-busy", "true");
    await expect.element(page.getByTestId("error-reset-cancel")).toBeDisabled();
    const confirm = page.getByTestId("error-reset-confirm").element();
    if (confirm instanceof HTMLElement) confirm.click(); // a disabled button ignores a second click
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(reloadPage).not.toHaveBeenCalled();
    pending.resolve(true);
    await expect.poll(() => reloadPage.mock.calls.length).toBe(1);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  test("a failed reset shows an alert, returns to the confirmation and can be retried", async () => {
    const onReset = vi
      .fn()
      .mockRejectedValueOnce(new VaultConflictError())
      .mockResolvedValueOnce(true);
    const reloadPage = vi.fn();
    await render(
      <ErrorScreen error={new VaultDataError()} onReset={onReset} reloadPage={reloadPage} />,
    );
    await page.getByTestId("error-reset").click();
    await page.getByTestId("error-reset-confirm").click();
    await expect
      .element(page.getByRole("alert"))
      .toMatchTextContent("Saved connections changed. Reload and try again");
    await expect.element(page.getByTestId("error-reset-confirm")).toBeEnabled();
    expect(reloadPage).not.toHaveBeenCalled();
    await page.getByTestId("error-reset-confirm").click();
    await expect.poll(() => reloadPage.mock.calls.length).toBe(1);
    expect(onReset).toHaveBeenCalledTimes(2);
  });

  test("a reset that could not clear tab metadata stays on screen with a warning and no reload", async () => {
    const onReset = vi.fn().mockResolvedValue(false);
    const reloadPage = vi.fn();
    await render(
      <ErrorScreen error={new VaultDataError()} onReset={onReset} reloadPage={reloadPage} />,
    );
    await page.getByTestId("error-reset").click();
    await page.getByTestId("error-reset-confirm").click();
    await expect
      .element(page.getByRole("alert"))
      .toMatchTextContent("Close this tab and open a new one.");
    await expect.element(page.getByTestId("error-reset-confirm")).not.toBeInTheDocument();
    await expect.element(page.getByTestId("error-reset")).not.toBeInTheDocument();
    expect(reloadPage).not.toHaveBeenCalled();
    await page.getByTestId("error-reload").click();
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });
});

test("takes over as a labelled alert dialog and moves keyboard focus to its title", async () => {
  const before = document.createElement("button");
  document.body.append(before);
  before.focus();
  try {
    await render(<ErrorScreen error={new Error("boom")} reloadPage={vi.fn()} />);
    const dialog = page.getByRole("alertdialog", { name: "Headscale UI ran into a problem" });
    await expect.element(dialog).toHaveAttribute("aria-modal", "true");
    await expect.element(dialog).toHaveAccessibleDescription(/could not finish loading/);
    await expect
      .element(page.getByRole("heading", { name: "Headscale UI ran into a problem" }))
      .toHaveFocus();
  } finally {
    before.remove();
  }
});
