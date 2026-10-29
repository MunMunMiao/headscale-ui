import { I18nProvider } from "@lingui/react";
import { afterEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { DateTimePicker } from "@/components/app/date-time-picker";
import { Button } from "@/components/ui/button";
import { i18n } from "@/i18n";
import { englishCopy } from "@/i18n/product-copy";
import { loadLocale } from "@/i18n/runtime";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "./dialog";

afterEach(async () => {
  i18n.activate("en-US");
  await page.viewport(1280, 720);
});

function Harness() {
  return (
    <I18nProvider i18n={i18n}>
      <Dialog>
        <DialogTrigger render={<Button />}>Open</DialogTrigger>
        <DialogContent>
          <DialogTitle>Key expiry</DialogTitle>
          <DialogDescription>Pick an expiry</DialogDescription>
          <DateTimePicker
            value="2026-06-01T13:45"
            onValueChange={() => {}}
            testId="expiry"
            placeholder={englishCopy.dateTimePlaceholder}
            timeLabel={englishCopy.time}
            hourLabel={englishCopy.hour}
            minuteLabel={englishCopy.minute}
          />
        </DialogContent>
      </Dialog>
    </I18nProvider>
  );
}

test("the application close label updates in an open dialog and returns focus to its trigger", async () => {
  i18n.activate("en-US");
  await render(<Harness />);
  await page.getByText("Open", { exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Close", exact: true }))
    .toBeVisible();
  await loadLocale("ar");
  i18n.activate("ar");
  await expect
    .element(page.getByRole("button", { name: "إغلاق", exact: true }))
    .toBeVisible();
  await page.getByRole("button", { name: "إغلاق", exact: true }).click();
  await expect.element(page.getByText("Open", { exact: true })).toHaveFocus();
});

test("Escape closes the nested calendar before its application dialog and returns keyboard focus", async () => {
  i18n.activate("en-US");
  await page.viewport(360, 568);
  await render(<Harness />);
  await page.getByText("Open", { exact: true }).click();
  await page.getByTestId("expiry").click();
  await expect
    .poll(() => document.querySelector('[data-slot="calendar"]'))
    .not.toBeNull();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("dialog", { name: "Key expiry" }))
    .toBeVisible();
  await expect.element(page.getByTestId("expiry")).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByText("Open", { exact: true })).toHaveFocus();
});

test("a wide application dialog keeps its side margins at 800px and a 24px close target", async () => {
  i18n.activate("en-US");
  await page.viewport(800, 720);
  await render(
    <I18nProvider i18n={i18n}>
      <Dialog defaultOpen>
        <DialogContent className="sm:max-w-4xl">
          <DialogTitle>Server settings</DialogTitle>
        </DialogContent>
      </Dialog>
    </I18nProvider>,
  );
  const dialog = page.getByRole("dialog", { name: "Server settings" });
  await expect.element(dialog).toBeVisible();
  await Promise.all(
    document.getAnimations().map((animation) => animation.finished),
  );
  const bounds = dialog.element().getBoundingClientRect();
  expect(bounds.left).toBeGreaterThanOrEqual(15.5);
  expect(window.innerWidth - bounds.right).toBeGreaterThanOrEqual(15.5);
  const close = page
    .getByRole("button", { name: "Close", exact: true })
    .element();
  expect(close.getBoundingClientRect().width).toBeGreaterThanOrEqual(24);
  expect(close.getBoundingClientRect().height).toBeGreaterThanOrEqual(24);
});

test("an application footer can provide the only localized close control", async () => {
  await loadLocale("ar");
  i18n.activate("ar");
  await render(
    <I18nProvider i18n={i18n}>
      <Dialog>
        <DialogTrigger render={<Button />}>Open</DialogTrigger>
        <DialogContent showCloseButton={false}>
          <DialogTitle>Settings</DialogTitle>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>
    </I18nProvider>,
  );
  await page.getByRole("button", { name: "Open", exact: true }).click();
  expect(
    page.getByRole("button", { name: "إغلاق", exact: true }).elements(),
  ).toHaveLength(1);
  expect(
    page.getByRole("button", { name: "Close", exact: true }).elements(),
  ).toHaveLength(0);
  await page.getByRole("button", { name: "إغلاق", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Open", exact: true }))
    .toHaveFocus();
});

test("an application footer stays inside a flush dialog without creating hidden overflow", async () => {
  await render(
    <I18nProvider i18n={i18n}>
      <Dialog defaultOpen>
        <DialogContent className="flex flex-col gap-0 overflow-hidden p-0">
          <DialogTitle className="p-6">Manage team</DialogTitle>
          <div className="p-6">Team name</div>
          <DialogFooter className="border-t p-6">
            <Button>Save team</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </I18nProvider>,
  );
  const dialog = page.getByRole("dialog", { name: "Manage team" });
  await expect.element(dialog).toBeVisible();
  await Promise.all(
    document.getAnimations().map((animation) => animation.finished),
  );
  const bounds = dialog.element().getBoundingClientRect();
  const footer = dialog.element().querySelector('[data-slot="dialog-footer"]');
  expect.assert(footer);
  const footerBounds = footer.getBoundingClientRect();
  expect(footerBounds.left).toBeGreaterThanOrEqual(bounds.left);
  expect(footerBounds.right).toBeLessThanOrEqual(bounds.right);
  expect(footerBounds.bottom).toBeLessThanOrEqual(bounds.bottom);
  expect(dialog.element().scrollHeight).toBeLessThanOrEqual(
    dialog.element().clientHeight + 1,
  );
});

test("a tall application dialog scrolls within a short viewport without hiding its actions", async () => {
  await page.viewport(360, 568);
  await render(
    <I18nProvider i18n={i18n}>
      <Dialog defaultOpen>
        <DialogContent>
          <DialogTitle>Settings</DialogTitle>
          <div className="h-[800px]">Long settings form</div>
          <DialogFooter>
            <Button>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </I18nProvider>,
  );
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect.element(dialog).toBeVisible();
  await Promise.all(
    document.getAnimations().map((animation) => animation.finished),
  );
  const bounds = dialog.element().getBoundingClientRect();
  expect(bounds.top).toBeGreaterThanOrEqual(15.5);
  expect(bounds.bottom).toBeLessThanOrEqual(552.5);
  expect(dialog.element().scrollHeight).toBeGreaterThan(
    dialog.element().clientHeight,
  );
  (
    page
      .getByRole("button", { name: "Save", exact: true })
      .element() as HTMLButtonElement
  ).focus();
  await expect
    .element(page.getByRole("button", { name: "Save", exact: true }))
    .toHaveFocus();
  const action = page
    .getByRole("button", { name: "Save", exact: true })
    .element()
    .getBoundingClientRect();
  expect(action.top).toBeGreaterThanOrEqual(bounds.top);
  expect(action.bottom).toBeLessThanOrEqual(bounds.bottom);
});
