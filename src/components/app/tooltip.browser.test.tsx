import { I18nProvider } from "@lingui/react";
import { afterEach, expect, test, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { i18n } from "@/i18n";
import { Tooltip, TooltipProvider } from "./tooltip";

afterEach(async () => {
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await page.viewport(1280, 720);
});

test("short help is associated with the existing named button and Escape closes only the tooltip", async () => {
  i18n.activate("en-US");
  await render(
    <I18nProvider i18n={i18n}>
      <TooltipProvider delay={600} closeDelay={0}>
        <Dialog>
          <DialogTrigger render={<Button type="button" />}>
            Open help form
          </DialogTrigger>
          <DialogContent>
            <DialogTitle>Help form</DialogTitle>
            <DialogDescription>
              Short help must not replace the button name.
            </DialogDescription>
            <Tooltip content="Read the current server state without changing it.">
              <Button type="button" aria-label="Refresh data">
                Refresh
              </Button>
            </Tooltip>
          </DialogContent>
        </Dialog>
      </TooltipProvider>
    </I18nProvider>,
  );
  await userEvent.tab();
  await expect
    .element(page.getByRole("button", { name: "Open help form" }))
    .toHaveFocus();
  await userEvent.keyboard("{Enter}");
  const tip = page.getByText(
    "Read the current server state without changing it.",
    { exact: true },
  );
  await expect.element(tip).toBeVisible();
  const refresh = page.getByRole("button", {
    name: "Refresh data",
    exact: true,
  });
  await expect.element(refresh).toHaveFocus();
  expect(refresh.element().querySelector("button")).toBeNull();
  await userEvent.keyboard("{Escape}");
  await expect.element(tip).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("dialog", { name: "Help form" }))
    .toBeVisible();
  await expect.element(refresh).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("button", { name: "Open help form" }))
    .toHaveFocus();
});

test("closing short help keeps the existing field hint visible", async () => {
  await render(
    <TooltipProvider delay={600} closeDelay={0}>
      <p id="existing-help">The existing field help.</p>
      <Tooltip
        content="Additional short explanation."
        side="bottom"
        align="end"
      >
        <Button type="button" aria-describedby="existing-help">
          Explain field
        </Button>
      </Tooltip>
    </TooltipProvider>,
  );
  await expect
    .element(page.getByText("The existing field help.", { exact: true }))
    .toBeVisible();
  await userEvent.tab();
  const tip = page.getByText("Additional short explanation.", { exact: true });
  await expect.element(tip).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(tip).not.toBeInTheDocument();
  await expect
    .element(page.getByText("The existing field help.", { exact: true }))
    .toBeVisible();
});

test("required interactive help remains touch-operable in a Popover and never submits its form", async () => {
  await page.viewport(375, 812);
  await cdp().send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 1,
  });
  const submit = vi.fn();
  const pointers: string[] = [];
  await render(
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label>
        Unsubmitted name
        <input defaultValue="Keep this draft" />
      </label>
      <Popover>
        <PopoverTrigger
          render={
            <Button
              type="button"
              onPointerDown={(event) => pointers.push(event.pointerType)}
            />
          }
        >
          Connection help
        </PopoverTrigger>
        <PopoverContent>
          <PopoverTitle>Connection help</PopoverTitle>
          <PopoverDescription>
            Check the server URL and allowed browser origins.
          </PopoverDescription>
          <Button type="button">Copy example</Button>
        </PopoverContent>
      </Popover>
    </form>,
  );
  const button = page
    .getByRole("button", { name: "Connection help", exact: true })
    .element();
  const rect = button.getBoundingClientRect();
  const frame = (
    window.frameElement as HTMLElement | null
  )?.getBoundingClientRect();
  await cdp().send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      {
        x: (frame?.left ?? 0) + rect.left + rect.width / 2,
        y: (frame?.top ?? 0) + rect.top + rect.height / 2,
      },
    ],
  });
  await cdp().send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect
    .element(page.getByRole("button", { name: "Copy example" }))
    .toBeVisible();
  expect(pointers).toEqual(["touch"]);
  expect(submit).not.toHaveBeenCalled();
  await expect
    .element(page.getByRole("textbox", { name: "Unsubmitted name" }))
    .toHaveValue("Keep this draft");
});
