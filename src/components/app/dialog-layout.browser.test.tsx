import { I18nProvider } from "@lingui/react";
import { Network } from "lucide-react";
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { i18n } from "@/i18n";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./dialog";

const originalDirection = document.documentElement.dir;
afterEach(async () => {
  document.documentElement.dir = originalDirection;
  await page.viewport(1280, 720);
});

test.each(["ltr", "rtl"])(
  "a truncated machine title keeps its visible ellipsis clear of the close target in %s",
  async (direction) => {
    await page.viewport(360, 640);
    document.documentElement.dir = direction;
    i18n.activate("en-US");
    await render(
      <I18nProvider i18n={i18n}>
        <Dialog defaultOpen>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="flex min-w-0 items-center gap-2">
                <Network className="h-5 w-5 shrink-0" aria-hidden="true" />
                <span className="truncate">
                  branch-router-europe-west-production-control-plane-network-edge
                </span>
              </DialogTitle>
              <DialogDescription>Machine details</DialogDescription>
            </DialogHeader>
          </DialogContent>
        </Dialog>
      </I18nProvider>,
    );
    await Promise.all(
      document.getAnimations().map((animation) => animation.finished),
    );
    const text = document.querySelector('[data-slot="dialog-title"] span');
    expect.assert(text instanceof HTMLElement);
    expect(text.scrollWidth).toBeGreaterThan(text.clientWidth);
    expect(getComputedStyle(text).textOverflow).toBe("ellipsis");
    const visibleText = text.getBoundingClientRect();
    const close = page
      .getByRole("button", { name: "Close", exact: true })
      .element()
      .getBoundingClientRect();
    expect(visibleText.top).toBeLessThan(close.bottom);
    expect(visibleText.bottom).toBeGreaterThan(close.top);
    if (direction === "rtl") {
      expect(visibleText.left).toBeGreaterThanOrEqual(close.right);
    } else {
      expect(visibleText.right).toBeLessThanOrEqual(close.left);
    }
  },
);
