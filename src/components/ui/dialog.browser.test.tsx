import { I18nProvider } from "@lingui/react";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { i18n } from "@/i18n";
import { englishCopy } from "@/i18n/product-copy";
import { loadLocale } from "@/i18n/runtime";
import { AlertDialog, AlertDialogContent, AlertDialogTitle } from "./alert-dialog";
import { Button } from "./button";
import { DateTimePicker } from "./date-time-picker";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "./dialog";

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

test("localized close labels update in an open dialog", async () => {
  i18n.activate("en-US");
  await render(<Harness />);
  await page.getByText("Open", { exact: true }).click();
  await expect.element(page.getByRole("button", { name: "Close", exact: true })).toBeVisible();
  await loadLocale("ar");
  i18n.activate("ar");
  await expect.element(page.getByRole("button", { name: "إغلاق", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "إغلاق", exact: true }).click();
  await expect.element(page.getByText("Open", { exact: true })).toHaveFocus();
  i18n.activate("en-US");
});

test("Escape closes the nested calendar before its dialog and returns keyboard focus", async () => {
  i18n.activate("en-US");
  await page.viewport(360, 568);
  try {
    await render(<Harness />);
    await page.getByText("Open", { exact: true }).click();
    await page.getByTestId("expiry").click();
    await expect.poll(() => document.querySelector('[data-slot="calendar"]')).not.toBeNull();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("dialog", { name: "Key expiry" })).toBeVisible();
    await expect.element(page.getByTestId("expiry")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByText("Open", { exact: true })).toHaveFocus();
  } finally {
    await page.viewport(1280, 720);
  }
});

async function finishAnimations() {
  await Promise.all(
    document.getAnimations().map((animation) => animation.finished.catch(() => {})),
  );
}

test("a wide dialog keeps its side margins at 800px and has a 24px close target", async () => {
  i18n.activate("en-US");
  await page.viewport(800, 720);
  try {
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
    await finishAnimations();
    const bounds = dialog.element().getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(15.5);
    expect(window.innerWidth - bounds.right).toBeGreaterThanOrEqual(15.5);
    const close = page.getByRole("button", { name: "Close", exact: true }).element();
    expect(close.getBoundingClientRect().width).toBeGreaterThanOrEqual(24);
    expect(close.getBoundingClientRect().height).toBeGreaterThanOrEqual(24);
  } finally {
    await page.viewport(1280, 720);
  }
});

test("a confirmation dims the page like any other dialog", async () => {
  const shade = async (slot: string) => {
    await finishAnimations();
    const overlay = document.querySelector(`[data-slot="${slot}"]`);
    expect.assert(overlay);
    return getComputedStyle(overlay).backgroundColor;
  };
  const dialog = await render(
    <I18nProvider i18n={i18n}>
      <Dialog defaultOpen>
        <DialogContent>
          <DialogTitle>Settings</DialogTitle>
        </DialogContent>
      </Dialog>
    </I18nProvider>,
  );
  await expect.element(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  const dialogShade = await shade("dialog-overlay");
  await dialog.unmount();
  await render(
    <AlertDialog defaultOpen>
      <AlertDialogContent>
        <AlertDialogTitle>Delete key</AlertDialogTitle>
      </AlertDialogContent>
    </AlertDialog>,
  );
  await expect.element(page.getByRole("alertdialog", { name: "Delete key" })).toBeVisible();
  expect(await shade("alert-dialog-overlay")).toBe(dialogShade);
});
