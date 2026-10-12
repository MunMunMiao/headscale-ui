import { afterEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { Switch } from "./switch";

afterEach(() => {
  document.documentElement.dir = "ltr";
});

function thumbOffset() {
  const root = document.querySelector<HTMLElement>('[role="switch"]');
  const thumb = root?.querySelector<HTMLElement>('[data-slot="switch-thumb"]');
  if (!root || !thumb) throw new Error("Switch and thumb must be rendered");
  const track = root.getBoundingClientRect();
  const handle = thumb.getBoundingClientRect();
  return handle.left + handle.width / 2 - (track.left + track.width / 2);
}

test.each(["ltr", "rtl"] as const)(
  "%s switch places the thumb at inline start when off and inline end when on",
  async (direction) => {
    document.documentElement.dir = direction;
    await render(<Switch aria-label="Reusable key" />);
    const control = page.getByRole("switch", { name: "Reusable key" });
    await expect.element(control).not.toBeChecked();
    await expect.element(control).toHaveAttribute("aria-checked", "false");
    await expect.poll(() => Math.sign(thumbOffset())).toBe(direction === "rtl" ? 1 : -1);

    await control.click();
    await expect.element(control).toBeChecked();
    await expect.element(control).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => Math.sign(thumbOffset())).toBe(direction === "rtl" ? -1 : 1);

    await userEvent.keyboard(" ");
    await expect.element(control).not.toBeChecked();
    await expect.poll(() => Math.sign(thumbOffset())).toBe(direction === "rtl" ? 1 : -1);
  },
);
