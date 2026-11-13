import { afterEach, beforeAll } from "vitest";
import { cleanup } from "vitest-browser-react";
import "../styles/globals.css";
import "./browser-motion.css";
import "./screenshot-mask.css";
import { clearHeadscaleDatabase } from "./clear-headscale-database";

// Vitest lays the test iframe out inline, and its baseline gap leaves the runner page a few pixels
// of scroll. A scroll reaching that page shifts the frame, so a click at a fixed element's top edge
// lands outside the window and Playwright reports the runner's <html> as intercepting it.
const frame = window.frameElement;
if (frame instanceof HTMLElement) frame.style.setProperty("display", "block");

// Files running one after another reuse a browser profile, so the previous file's vault would otherwise leak in.
beforeAll(async () => {
  await clearHeadscaleDatabase();
});

afterEach(async () => {
  await cleanup();
});
