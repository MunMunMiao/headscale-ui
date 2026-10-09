import { reactive } from "vue";
import { RestHeadscaleClient } from "@/api/headscale-client";
import type { ConnectionSettings } from "@/api/http";
import type { HeadscaleClient } from "@/api/types";

export interface UseHeadscaleClientReturn {
  settings: ConnectionSettings;
  setSettings(next: ConnectionSettings): void;
  createClient(override?: ConnectionSettings): HeadscaleClient;
}

let instance: UseHeadscaleClientReturn | null = null;

/** Internal: invoked by `__testing.ts` only. */
export const headscaleClientTestingHandle = {
  reset() {
    instance = null;
  },
};

export function useHeadscaleClient(): UseHeadscaleClientReturn {
  if (instance) return instance;
  const settings = reactive<ConnectionSettings>({
    baseUrl: "",
    apiKey: "",
  });
  function createClient(override?: ConnectionSettings): HeadscaleClient {
    const target = override ?? settings;
    return new RestHeadscaleClient(target);
  }
  instance = {
    settings,
    setSettings(next: ConnectionSettings) {
      settings.baseUrl = next.baseUrl;
      settings.apiKey = next.apiKey;
    },
    createClient,
  };
  return instance;
}
