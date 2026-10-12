import { expect, test } from "vitest";
import { AUTH_ID_PLACEHOLDER, parseAuthRequest } from "./auth-request";

const id = "hskey-authreq-abcdefghijklmnopqrstuvwx";

test("accepts a bare id with surrounding whitespace", () => {
  expect(parseAuthRequest(id)).toEqual({ id, source: "bare" });
  expect(parseAuthRequest(`  ${id}\n`)).toEqual({ id, source: "bare" });
});

test("accepts the id from a registration or SSH check link and ignores host, port, base path and query", () => {
  expect(parseAuthRequest(`http://127.0.0.1:8080/register/${id}`)).toEqual({
    id,
    source: "register-link",
  });
  expect(parseAuthRequest(`https://headscale.example/base/register/${id}?x=1#top`)).toEqual({
    id,
    source: "register-link",
  });
  expect(parseAuthRequest(`https://h/p/auth/${id}/?x=1`)).toEqual({ id, source: "auth-link" });
});

test.each([
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

test("keeps the placeholder a protocol token", () => {
  expect(AUTH_ID_PLACEHOLDER.startsWith("hskey-authreq-")).toBe(true);
});
