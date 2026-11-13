import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

test("default tooltips open on hover and keyboard focus without replacing the trigger name", async () => {
  await render(
    <TooltipProvider>
      <div style={{ padding: 80, display: "flex", gap: 80 }}>
        <Tooltip>
          <TooltipTrigger>Refresh devices</TooltipTrigger>
          <TooltipContent>Read the current server state.</TooltipContent>
        </Tooltip>
        <button type="button">Continue editing</button>
      </div>
    </TooltipProvider>,
  );
  const trigger = page.getByRole("button", {
    name: "Refresh devices",
    exact: true,
  });
  const next = page.getByRole("button", { name: "Continue editing" });
  const tip = page.getByText("Read the current server state.", { exact: true });
  await expect.element(tip).not.toBeInTheDocument();
  await trigger.hover();
  await expect.element(tip).toBeVisible();
  await expect.element(tip).toHaveTextContent("Read the current server state.");
  await expect.element(trigger).toHaveAccessibleName("Refresh devices");
  await next.hover();
  await expect.element(tip).not.toBeInTheDocument();
  await userEvent.tab();
  await expect.element(trigger).toHaveFocus();
  await expect.element(tip).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(tip).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
  await userEvent.tab();
  await expect.element(next).toHaveFocus();
  await expect.element(tip).not.toBeInTheDocument();
});

test("custom tooltips preserve forwarded accessibility props on hover", async () => {
  await render(
    <TooltipProvider delay={200} closeDelay={0} timeout={0}>
      <div style={{ padding: 80, display: "flex", gap: 80 }}>
        <Tooltip>
          <TooltipTrigger
            render={<button type="button" aria-label="Explain deployment" />}
            aria-describedby="deployment-help"
          >
            Details
          </TooltipTrigger>
          <TooltipContent
            id="deployment-help"
            role="tooltip"
            side="bottom"
            sideOffset={12}
            align="start"
            alignOffset={8}
          >
            <span>Changes apply after deployment.</span>
          </TooltipContent>
        </Tooltip>
        <button type="button">Keep editing</button>
      </div>
    </TooltipProvider>,
  );
  const trigger = page.getByRole("button", { name: "Explain deployment" });
  const tip = page.getByRole("tooltip");
  expect(trigger.element().querySelector("button")).toBeNull();
  await trigger.hover();
  await expect.element(tip).toBeVisible();
  await expect
    .element(tip)
    .toHaveTextContent("Changes apply after deployment.");
  await expect
    .element(trigger)
    .toHaveAccessibleDescription("Changes apply after deployment.");
  await page.getByRole("button", { name: "Keep editing" }).hover();
  await expect.element(tip).not.toBeInTheDocument();
});
