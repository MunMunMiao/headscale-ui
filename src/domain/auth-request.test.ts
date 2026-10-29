import { expect, test } from "vitest";
import {
  AUTH_ID_PLACEHOLDER,
  normalizePublicLoginServer,
  parseAuthRequest,
} from "./auth-request";

const id = "hskey-authreq-abcdefghijklmnopqrstuvwx";

test("accepts a bare id with surrounding whitespace", () => {
  expect(parseAuthRequest(id)).toEqual({ id, source: "bare" });
  expect(parseAuthRequest(`  ${id}\n`)).toEqual({ id, source: "bare" });
});

test("retains the public login-server of a registration or SSH check link", () => {
  expect(parseAuthRequest(`http://127.0.0.1:8080/register/${id}`)).toEqual({
    id,
    source: "register-link",
    loginServer: "http://127.0.0.1:8080",
  });
  expect(
    parseAuthRequest(`https://headscale.example/base/register/${id}?x=1#top`),
  ).toEqual({
    id,
    source: "register-link",
    loginServer: "https://headscale.example/base",
  });
  expect(parseAuthRequest(`https://h/p/auth/${id}/?x=1`)).toEqual({
    id,
    source: "auth-link",
    loginServer: "https://h/p",
  });
});

test.each([
  ["a non-web scheme", `ftp://h/register/${id}`],
  ["embedded credentials", `https://admin:secret@h/register/${id}`],
  ["the OIDC confirmation page", `https://h/register/confirm/${id}`],
  ["a link of another kind", `https://h/other/${id}`],
  ["a link without a kind", `https://h/${id}`],
  ["a link without an id", "https://h/register/"],
  ["a wrong prefix", "hskey-other-abcdefghijklmnopqrstuvwx"],
  ["a 23 character tail", "hskey-authreq-abcdefghijklmnopqrstuvw"],
  ["a 25 character tail", "hskey-authreq-abcdefghijklmnopqrstuvwxy"],
  ["a non-ASCII tail", "hskey-authreq-abcdefghijklmnopqrstuvw亚"],
  ["an embedded space", "hskey-authreq-abcdefghijk mnopqrstuvwx"],
  ["plain text", "register this machine"],
  ["an empty string", ""],
])("rejects %s", (_name, input) => {
  expect(parseAuthRequest(input)).toBeNull();
});

test("normalizes only a public HTTP server address without carrying secrets", () => {
  expect(normalizePublicLoginServer(" https://PUBLIC.example:443/base/ ")).toBe(
    "https://public.example/base",
  );
  expect(normalizePublicLoginServer("http://127.0.0.1:8080/")).toBe(
    "http://127.0.0.1:8080",
  );
  expect(normalizePublicLoginServer("https://hskey-gateway.example")).toBe(
    "https://hskey-gateway.example",
  );
  expect(
    normalizePublicLoginServer("https://public.example/auth/headscale"),
  ).toBe("https://public.example/auth/headscale");
  expect(
    normalizePublicLoginServer(
      `https://public.example/%61uth/%68skey-authreq-${"x".repeat(24)}`,
    ),
  ).toBeNull();
  for (const server of [
    "not a URL",
    "ftp://public.example",
    "https://user:pass@public.example",
    "https://public.example?key=secret",
    "https://public.example/#secret",
    `https://public.example/register/${id}`,
    "https://public.example/%XX",
  ]) {
    expect(normalizePublicLoginServer(server)).toBeNull();
  }
});

test("keeps the placeholder a protocol token", () => {
  expect(AUTH_ID_PLACEHOLDER.startsWith("hskey-authreq-")).toBe(true);
});
