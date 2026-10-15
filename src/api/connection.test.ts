import { expect, test } from "vitest";
import { canonicalBaseUrl, connectionSettingsError, sendsApiKeyInClear } from "./connection";

test.each([
  "https://admin:secret@hs.example.com",
  "https://admin@hs.example.com",
  "https://hs.example.com/?token=1",
  "https://hs.example.com/#section",
])("rejects a server URL with credentials, a query or a fragment: %s", (baseUrl) => {
  expect(connectionSettingsError({ baseUrl, apiKey: "key" })).toBe("connectionUrlParts");
});

test("keeps the existing URL and API key rules", () => {
  expect(connectionSettingsError({ baseUrl: "ftp://hs.example.com", apiKey: "key" })).toBe(
    "connectionInvalidUrl",
  );
  expect(connectionSettingsError({ baseUrl: "https://hs.example.com", apiKey: " " })).toBe(
    "connectionApiKeyRequired",
  );
  expect(connectionSettingsError({ baseUrl: " https://hs.example.com/ ", apiKey: "key" })).toBe(
    null,
  );
});

test("stores a server URL as its origin and path without trailing slashes", () => {
  expect(canonicalBaseUrl(" HTTPS://HS.Example.com:443/headscale// ")).toBe(
    "https://hs.example.com/headscale",
  );
  expect(canonicalBaseUrl("http://127.0.0.1:8080/?#")).toBe("http://127.0.0.1:8080");
  expect(canonicalBaseUrl(" not a url/ ")).toBe("not a url");
});

test("flags plain HTTP only when the API key would leave this device", () => {
  expect(sendsApiKeyInClear("http://headscale.example.com")).toBe(true);
  expect(sendsApiKeyInClear("http://10.0.0.5:8080")).toBe(true);
  for (const local of [
    "http://localhost:8080",
    "http://LOCALHOST",
    "http://app.localhost",
    "http://127.0.0.1:18080",
    "http://[::1]:8080",
    "https://headscale.example.com",
    "not a url",
  ])
    expect(sendsApiKeyInClear(local)).toBe(false);
});
