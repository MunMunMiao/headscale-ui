import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { setLocale, t } from "@/i18n";
import * as localeRuntime from "@/i18n/runtime";
import * as settings from "@/lib/settings-storage";
import { prepareTestSession, SessionTestProviders } from "@/test/session";
import { LocaleRadioItems, ThemeRadioItems } from "./PreferenceMenuItems";

vi.mock("@/i18n/runtime", { spy: true });
vi.mock("@/lib/settings-storage", { spy: true });

afterEach(async () => {
  vi.restoreAllMocks();
  // vi.mock spies are not restored by restoreAllMocks; a rejected write would otherwise stick.
  vi.mocked(settings.writeSetting).mockReset();
  vi.mocked(localeRuntime.loadLocale).mockReset();
  await setLocale("en-US");
});

async function mount(onChosen?: () => void) {
  const session = await prepareTestSession();
  await render(
    <SessionTestProviders session={session}>
      <DropdownMenu>
        <DropdownMenuTrigger data-testid="menu">Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-testid="locale-sub">
              Language
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <LocaleRadioItems onChosen={onChosen} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-testid="theme-sub">
              Theme
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <ThemeRadioItems onChosen={onChosen} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    </SessionTestProviders>,
  );
  await page.getByTestId("menu").click();
  return session;
}

function checked() {
  return Array.from(
    document.querySelectorAll('[role="menuitemradio"][aria-checked="true"]'),
  ).map((el) => el.getAttribute("data-testid"));
}

// The checked state must be exposed as a radio, exactly one option at a time.
test("locale options are radios with exactly one checked option that moves on choice", async () => {
  const chosen = vi.fn();
  await mount(chosen);
  await page.getByTestId("locale-sub").click();
  await expect.element(page.getByTestId("locale-option-en-US")).toBeVisible();
  expect(document.querySelectorAll('[role="menuitemradio"]').length).toBe(11);
  expect(checked()).toEqual(["locale-option-en-US"]);
  await page.getByTestId("locale-option-fr-FR").click();
  expect(chosen).toHaveBeenCalledTimes(1);
  await expect.poll(() => document.documentElement.lang).toBe("fr-FR");
});

test("theme options are radios; choosing one moves the checked state and calls onChosen", async () => {
  const chosen = vi.fn();
  await mount(chosen);
  await page.getByTestId("theme-sub").click();
  await expect.element(page.getByTestId("theme-option-dark")).toBeVisible();
  expect(checked()).toEqual(["theme-option-auto"]);
  await page.getByTestId("theme-option-dark").click();
  expect(chosen).toHaveBeenCalledTimes(1);
  await expect
    .poll(() => document.documentElement.classList.contains("dark"))
    .toBe(true);
  await page.getByTestId("menu").click();
  await page.getByTestId("theme-sub").click();
  await expect
    .element(page.getByTestId("theme-option-dark"))
    .toHaveAttribute("aria-checked", "true");
  expect(checked()).toEqual(["theme-option-dark"]);
});

test("onChosen is optional", async () => {
  await mount();
  await page.getByTestId("theme-sub").click();
  await page.getByTestId("theme-option-light").click();
  await expect
    .poll(() => document.documentElement.classList.contains("dark"))
    .toBe(false);
});

test("a failed theme save notifies after its menu closes, and a separate retry is not text-deduplicated", async () => {
  const session = await mount();
  const add = vi.spyOn(session.feedback.toastManager, "add");
  vi.mocked(settings.writeSetting).mockRejectedValue(
    new Error("theme-storage-secret-canary"),
  );
  await page.getByTestId("theme-sub").click();
  await page.getByTestId("theme-option-dark").click();
  const notice = page.getByRole("dialog", {
    name: t("themeNotSaved"),
    exact: true,
  });
  await expect.element(notice).toBeVisible();
  await expect.element(page.getByTestId("theme-error")).not.toBeInTheDocument();
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  await expect
    .element(page.getByTestId("theme-option-dark"))
    .not.toBeInTheDocument();
  expect(add).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(add.mock.calls)).not.toContain(
    "theme-storage-secret-canary",
  );
  await notice.getByRole("button", { name: t("close"), exact: true }).click();
  await expect.element(notice).not.toBeInTheDocument();
  expect(session.theme.getSnapshot().themeError).toBe("not-saved");
  await page.getByTestId("menu").click();
  await page.getByTestId("theme-sub").click();
  await page.getByTestId("theme-option-dark").click();
  await expect.element(notice).toBeVisible();
  expect(add).toHaveBeenCalledTimes(2);
  expect(add.mock.calls[1]?.[0].id).not.toBe(add.mock.calls[0]?.[0].id);
});

test("a language load failure has one non-secret notification and keeps the current language", async () => {
  const session = await mount();
  const add = vi.spyOn(session.feedback.toastManager, "add");
  vi.mocked(localeRuntime.loadLocale).mockRejectedValueOnce(
    new Error("catalog-secret-canary"),
  );
  await page.getByTestId("locale-sub").click();
  await page.getByTestId("locale-option-ar").click();
  await expect
    .element(
      page.getByRole("dialog", { name: t("languageLoadFailed"), exact: true }),
    )
    .toBeVisible();
  await expect
    .element(page.getByTestId("locale-error"))
    .not.toBeInTheDocument();
  expect(document.documentElement.lang).toBe("en-US");
  expect(add).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(add.mock.calls)).not.toContain("catalog-secret-canary");
});

test("an activated language that could not be saved reports persistence, not a failed activation", async () => {
  const session = await mount();
  const add = vi.spyOn(session.feedback.toastManager, "add");
  vi.mocked(settings.writeSetting).mockRejectedValueOnce(
    new Error("locale-storage-secret-canary"),
  );
  await page.getByTestId("locale-sub").click();
  await page.getByTestId("locale-option-fr-FR").click();
  await expect.poll(() => document.documentElement.lang).toBe("fr-FR");
  await expect
    .element(
      page.getByRole("dialog", { name: t("languageNotSaved"), exact: true }),
    )
    .toBeVisible();
  await expect
    .element(page.getByTestId("locale-error"))
    .not.toBeInTheDocument();
  expect(add).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(add.mock.calls)).not.toContain(
    "locale-storage-secret-canary",
  );
});

test("a theme save that fails after its menu unmounts still notifies", async () => {
  const session = await mount();
  const add = vi.spyOn(session.feedback.toastManager, "add");
  const write = Promise.withResolvers<void>();
  vi.mocked(settings.writeSetting).mockImplementationOnce(() => write.promise);
  await page.getByTestId("theme-sub").click();
  await page.getByTestId("theme-option-dark").click();
  await expect
    .element(page.getByTestId("theme-option-dark"))
    .not.toBeInTheDocument();
  write.reject(new Error("late-theme-secret-canary"));
  await write.promise.catch(() => undefined);
  await expect
    .element(
      page.getByRole("dialog", { name: t("themeNotSaved"), exact: true }),
    )
    .toBeVisible();
  expect(add).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(add.mock.calls)).not.toContain(
    "late-theme-secret-canary",
  );
});

test("only the current theme attempt reports when two saves fail", async () => {
  const session = await mount();
  const add = vi.spyOn(session.feedback.toastManager, "add");
  const first = Promise.withResolvers<void>();
  vi.mocked(settings.writeSetting).mockImplementationOnce(() => first.promise);
  await page.getByTestId("theme-sub").click();
  await page.getByTestId("theme-option-dark").click();
  await page.getByTestId("menu").click();
  await page.getByTestId("theme-sub").click();
  vi.mocked(settings.writeSetting).mockRejectedValueOnce(new Error("current"));
  await page.getByTestId("theme-option-light").click();
  await expect
    .element(
      page.getByRole("dialog", { name: t("themeNotSaved"), exact: true }),
    )
    .toBeVisible();
  first.reject(new Error("retired"));
  await first.promise.catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(add).toHaveBeenCalledTimes(1);
  expect(session.theme.getSnapshot()).toMatchObject({
    colorMode: "light",
    themeError: "not-saved",
  });
});

test("a superseded theme-save failure cannot notify over the newer successful preference", async () => {
  const session = await mount();
  const add = vi.spyOn(session.feedback.toastManager, "add");
  const first = Promise.withResolvers<void>();
  vi.mocked(settings.writeSetting).mockImplementationOnce(() => first.promise);
  await page.getByTestId("theme-sub").click();
  await page.getByTestId("theme-option-dark").click();
  await page.getByTestId("menu").click();
  await page.getByTestId("theme-sub").click();
  await page.getByTestId("theme-option-light").click();
  await expect.poll(() => settings.readSetting("theme")).toBe("light");
  first.reject(new Error("retired-theme-secret-canary"));
  await first.promise.catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(session.theme.getSnapshot()).toMatchObject({
    colorMode: "light",
    themeError: null,
  });
  expect(add).not.toHaveBeenCalled();
});

test("a superseded language-load failure cannot notify over a newer activated language", async () => {
  const session = await mount();
  const add = vi.spyOn(session.feedback.toastManager, "add");
  const first = Promise.withResolvers<void>();
  vi.mocked(localeRuntime.loadLocale).mockImplementationOnce(
    () => first.promise,
  );
  await page.getByTestId("locale-sub").click();
  await page.getByTestId("locale-option-ar").click();
  await page.getByTestId("menu").click();
  await page.getByTestId("locale-sub").click();
  await page.getByTestId("locale-option-fr-FR").click();
  await expect.poll(() => document.documentElement.lang).toBe("fr-FR");
  first.reject(new Error("retired-locale-secret-canary"));
  await first.promise.catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(document.documentElement.lang).toBe("fr-FR");
  expect(add).not.toHaveBeenCalled();
});
