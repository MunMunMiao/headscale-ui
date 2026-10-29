import { mergeConfig } from "vite";
import base from "../../../vite.config.ts";

// Some embedded browsers (e.g. the Claude desktop browser pane) block cross-origin fetches from
// SharedWorkers, so the dev server also serves the Headscale API on the UI's own origin.
const headscale = "http://127.0.0.1:18080";

export default mergeConfig(base, {
  server: {
    // 运行记录保存在 .claude/，写入时不能重载受测页面。
    watch: { ignored: ["**/.claude/**"] },
    proxy: { "/api/": headscale, "/version": headscale },
  },
});
