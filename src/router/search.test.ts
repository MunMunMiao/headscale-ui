import { expect, test } from "vitest";
import { parseSearch, redirectTarget, stringifySearch } from "./search";

test("preserves string IDs and flags and repeated query values from existing links", () => {
  expect(parseSearch("?user=123&cleared=1&search=false&node=a&node=b&empty&term=a%2Bb+c")).toEqual({
    user: "123",
    cleared: "1",
    search: "false",
    node: ["a", "b"],
    empty: "",
    term: "a+b c",
  });
  const query = { user: "123", cleared: "1", node: ["a", "b"], ignored: undefined, empty: null };
  expect(parseSearch(stringifySearch(query))).toEqual({
    user: "123",
    cleared: "1",
    node: ["a", "b"],
    empty: "",
  });
  expect(stringifySearch({})).toBe("");
});

test("continues to the redirect target but never back to a login screen", () => {
  expect(redirectTarget("/devices?node=7&search=a%2Bb#details", "p1")).toEqual({
    to: "/devices",
    search: { node: "7", search: "a+b" },
    hash: "details",
    replace: true,
  });
  expect(redirectTarget("/devices?profile=p1#d", "p1")).toMatchObject({
    search: { profile: "p1" },
    hash: "d",
  });
  for (const redirect of [
    undefined,
    ["/a", "/b"],
    "/login",
    "/login?redirect=%2Fdevices",
    "/UNLOCK/",
  ])
    expect(redirectTarget(redirect, "p1")).toEqual({
      to: "/",
      search: {},
      hash: "",
      replace: true,
    });
});

test("drops another server's query and hash from a redirect pinned to a different profile", () => {
  expect(redirectTarget("/devices?profile=other&node=7#d", "p1")).toEqual({
    to: "/devices",
    search: {},
    hash: "",
    replace: true,
  });
});
