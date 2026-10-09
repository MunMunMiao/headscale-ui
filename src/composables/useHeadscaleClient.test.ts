import { beforeEach, describe, expect, test } from "bun:test";
import { RestHeadscaleClient } from "@/api/headscale-client";
import { headscaleClientTestingHandle, useHeadscaleClient } from "./useHeadscaleClient";

beforeEach(() => headscaleClientTestingHandle.reset());

describe("useHeadscaleClient", () => {
  test("starts unconfigured and cannot accidentally connect to the UI origin", () => {
    const api = useHeadscaleClient();
    expect(api.settings).toEqual({ baseUrl: "", apiKey: "" });
    expect(() => api.createClient()).toThrow();
    expect(useHeadscaleClient()).toBe(api);
    headscaleClientTestingHandle.reset();
    expect(useHeadscaleClient()).not.toBe(api);
  });

  test("uses REST for local and remote live or override settings", () => {
    const api = useHeadscaleClient();
    const live = { baseUrl: "http://127.0.0.1:8080", apiKey: "local-key" };
    api.setSettings(live);
    expect(api.settings).toEqual(live);
    expect(api.createClient()).toBeInstanceOf(RestHeadscaleClient);
    expect(
      api.createClient({ baseUrl: "https://headscale.example.test/path", apiKey: "key" }),
    ).toBeInstanceOf(RestHeadscaleClient);
    expect(api.settings).toEqual(live);
  });
});
