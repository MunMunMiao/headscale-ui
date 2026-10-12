import { expect, test } from "vitest";
import { page } from "vitest/browser";

// Catches the runner page scrolling under the test frame: a scroll that reaches the runner pushes
// the frame up a few pixels, and a click at a fixed overlay's top edge then lands outside the window.
test("a click at a fixed overlay's top edge lands after a scroll reaches the runner page", async () => {
  await page.viewport(1366, 768);
  const filler = document.createElement("div");
  filler.style.height = "2000px";
  const end = document.createElement("div");
  const overlay = document.createElement("div");
  overlay.style.cssText = "position: fixed; inset: 0";
  let clicks = 0;
  overlay.addEventListener("click", () => clicks++);
  document.body.append(filler, end, overlay);
  end.scrollIntoView({ block: "start" });
  await page.elementLocator(overlay).click({ position: { x: 1, y: 1 }, timeout: 2000 });
  expect(clicks).toBe(1);
});
