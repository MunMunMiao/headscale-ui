import { I18nProvider } from "@lingui/react";
import { expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { i18n } from "@/i18n";
import { Notice } from "./notice";

test("a persistent notice keeps compact content and its action without a dismiss control", async () => {
  const inspect = vi.fn();
  await render(
    <Notice
      id="persistent-notice"
      tone="warning"
      title="Data may be out of date"
      className="test-owner-style"
      action={
        <Button type="button" onClick={inspect}>
          Inspect state
        </Button>
      }
    >
      The original operation remains unresolved.
    </Notice>,
  );
  const notice = document.getElementById("persistent-notice");
  expect.assert(notice);
  await expect.element(notice).toHaveAttribute("data-slot", "notice");
  await expect.element(notice).toHaveAttribute("data-tone", "warning");
  await expect.element(notice).toHaveClass("test-owner-style");
  await page.getByRole("button", { name: "Inspect state" }).click();
  expect(inspect).toHaveBeenCalledOnce();
  await expect
    .element(page.getByText("The original operation remains unresolved."))
    .toBeVisible();
  expect(page.getByRole("button").elements()).toHaveLength(1);
});

test.each(["info", "success", "warning", "error"] as const)(
  "%s styling preserves the visible title",
  async (tone) => {
    await render(<Notice id="tone-notice" tone={tone} title="Current state" />);
    const notice = document.getElementById("tone-notice");
    expect.assert(notice);
    await expect.element(notice).toHaveAttribute("data-tone", tone);
    await expect
      .element(page.getByText("Current state", { exact: true }))
      .toBeVisible();
  },
);

test.each(["page", "lower dialog"] as const)(
  "a notice action remains usable after a foreground modal is dismissed from a %s",
  async (position) => {
    i18n.activate("en-US");
    const inspect = vi.fn();
    const content = (
      <>
        <Notice
          tone="warning"
          title="Saved evidence"
          action={
            <Button type="button" onClick={inspect}>
              Inspect candidate state
            </Button>
          }
        >
          The original operation remains unresolved.
        </Notice>
        <Dialog>
          <DialogTrigger render={<Button />}>
            Open foreground task
          </DialogTrigger>
          <DialogContent>
            <DialogTitle>Foreground task</DialogTitle>
            <DialogDescription>
              Complete this task before returning to saved evidence.
            </DialogDescription>
            <Button type="button">Foreground action</Button>
          </DialogContent>
        </Dialog>
      </>
    );
    await render(
      <I18nProvider i18n={i18n}>
        {position === "page" ? (
          content
        ) : (
          <Dialog>
            <DialogTrigger render={<Button />}>Open lower task</DialogTrigger>
            <DialogContent>
              <DialogTitle>Lower task</DialogTitle>
              <DialogDescription>Review the saved evidence.</DialogDescription>
              {content}
            </DialogContent>
          </Dialog>
        )}
      </I18nProvider>,
    );
    if (position === "lower dialog") {
      await page
        .getByRole("button", { name: "Open lower task", exact: true })
        .click();
      await expect
        .element(page.getByRole("dialog", { name: "Lower task", exact: true }))
        .toBeVisible();
    }
    const candidate = page.getByRole("button", {
      name: "Inspect candidate state",
      exact: true,
    });
    const candidateElement = candidate.element();
    await expect.element(candidate).toBeVisible();
    await expect.element(candidate).toBeEnabled();
    await page
      .getByRole("button", { name: "Open foreground task", exact: true })
      .click();
    const foreground = page.getByRole("dialog", {
      name: "Foreground task",
      exact: true,
    });
    await expect.element(foreground).toBeVisible();
    await expect
      .element(foreground.getByRole("button", { name: "Foreground action" }))
      .toBeVisible();
    expect(candidateElement.isConnected).toBe(true);
    await expect.element(candidateElement).toBeEnabled();
    expect(inspect).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    await expect
      .element(page.getByRole("button", { name: "Open foreground task" }))
      .toHaveFocus();
    if (position === "lower dialog")
      await expect
        .element(page.getByRole("dialog", { name: "Lower task", exact: true }))
        .toBeVisible();
    await candidate.click();
    expect(inspect).toHaveBeenCalledOnce();
  },
);
