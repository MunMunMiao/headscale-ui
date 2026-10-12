import { afterEach } from "vitest";
import { cleanup } from "vitest-browser-react";
import "../styles/globals.css";

afterEach(async () => {
  await cleanup();
});
