/// <reference types="vite/client" />

declare const __HEADSCALE_UI_BUILD_ID__: string;

declare module "*.po" {
  import type { Messages } from "@lingui/core";
  export const messages: Messages;
}
