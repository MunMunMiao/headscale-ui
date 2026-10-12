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
import { setLocale } from "@/i18n";
import { prepareTestSession, SessionTestProviders } from "@/test/session";
import { LocaleRadioItems, ThemeRadioItems } from "./PreferenceMenuItems";

afterEach(async () => {
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
            <DropdownMenuSubTrigger data-testid="locale-sub">Language</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <LocaleRadioItems onChosen={onChosen} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-testid="theme-sub">Theme</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <ThemeRadioItems onChosen={onChosen} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    </SessionTestProviders>,
  );
  await page.getByTestId("menu").click();
}

function checked() {
  return Array.from(document.querySelectorAll('[role="menuitemradio"][aria-checked="true"]')).map(
    (el) => el.getAttribute("data-testid"),
  );
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
  await expect.poll(() => document.documentElement.classList.contains("dark")).toBe(true);
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
  await expect.poll(() => document.documentElement.classList.contains("dark")).toBe(false);
});
