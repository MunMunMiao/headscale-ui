import { fileURLToPath } from "node:url";
import { lingui } from "@lingui/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { computeBuildId } from "./scripts/build-id.ts";

export default defineConfig({
  base: process.env.PAGES_BASE ?? "/",
  define: {
    __HEADSCALE_UI_BUILD_ID__: JSON.stringify(
      computeBuildId(fileURLToPath(new URL(".", import.meta.url))),
    ),
  },
  plugins: [lingui({ macroTransform: true }), react(), tailwindcss()],
  worker: {
    format: "es",
    rolldownOptions: { output: { entryFileNames: "shared-session-worker.js" } },
  },
  resolve: {
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
});
