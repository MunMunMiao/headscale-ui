import { afterEach } from "vitest";
import { cleanup } from "vitest-browser-react";
import "../styles/globals.css";
import "./browser-motion.css";
import "./screenshot-mask.css";

// Vitest lays the test iframe out inline, and its baseline gap leaves the runner page a few pixels
// of scroll. A scroll reaching that page shifts the frame, so a click at a fixed element's top edge
// lands outside the window and Playwright reports the runner's <html> as intercepting it.
(window.frameElement as HTMLElement | null)?.style.setProperty(
  "display",
  "block",
);

afterEach(async () => {
  await cleanup();
});
