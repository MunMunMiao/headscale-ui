import { expect, test } from "vitest";
import { parseSearch, redirectTarget, stringifySearch } from "./search";

test("preserves string IDs and flags and repeated query values from existing links", () => {
  expect(
    parseSearch(
      "?user=123&cleared=1&search=false&node=a&node=b&empty&term=a%2Bb+c",
    ),
  ).toEqual({
    user: "123",
    cleared: "1",
    search: "false",
    node: ["a", "b"],
    empty: "",
    term: "a+b c",
  });
  const query = {
    user: "123",
    cleared: "1",
    node: ["a", "b"],
    ignored: undefined,
    empty: null,
  };
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

test.each(["http://[", "https://", "http://%"])(
  "a malformed redirect %s falls back to the console after unlocking",
  (redirect) => {
    expect(redirectTarget(redirect, "p1")).toEqual({
      to: "/",
      search: {},
      hash: "",
      replace: true,
    });
  },
);

test.each(["http://[", "https://host:bad/devices?node=7", "https://%/"])(
  "a malformed redirect %s falls back to the console after unlocking",
  (redirect) => {
    expect(redirectTarget(redirect, "p1")).toEqual({
      to: "/",
      search: {},
      hash: "",
      replace: true,
    });
  },
);

test("a destination lost during a shared lock does not consume entity navigation", () => {
  expect(
    redirectTarget("/devices?node=7#details", undefined, {
      id: "a",
      baseUrl: "https://a.test",
    }),
  ).toEqual({ to: "/", search: {}, hash: "", replace: true });
});

test.each(["", "&profile=a"])(
  "a cross-server redirect drops only entity intent (pin: %s)",
  (pin) => {
    expect(
      redirectTarget(
        `/devices?node=7&user=1&popup=node&from=members&filter=online&search=edge${pin}#details`,
        { id: "b", baseUrl: "https://b.test" },
        { id: "a", baseUrl: "https://a.test" },
      ),
    ).toEqual({
      to: "/devices",
      search: { filter: "online", search: "edge" },
      hash: "",
      replace: true,
    });
  },
);

test("a profile edited to point at another server cannot reuse its pinned entities", () => {
  expect(
    redirectTarget(
      "/devices?profile=a&node=7&filter=online#details",
      { id: "a", baseUrl: "https://b.test" },
      { id: "a", baseUrl: "https://a.test" },
    ),
  ).toEqual({
    to: "/devices",
    search: { filter: "online" },
    hash: "",
    replace: true,
  });
});

test("same-server redirects and explicitly selected destination profiles retain their entity context", () => {
  const current = { id: "a", baseUrl: "https://a.test" };
  for (const previous of [current, null]) {
    expect(
      redirectTarget(
        "/devices?profile=a&node=7&popup=node#details",
        current,
        previous,
      ),
    ).toEqual({
      to: "/devices",
      search: { profile: "a", node: "7", popup: "node" },
      hash: "details",
      replace: true,
    });
  }
  expect(
    redirectTarget(
      "/devices?profile=b&node=7",
      { id: "b", baseUrl: "https://b.test" },
      current,
    ),
  ).toMatchObject({ search: { profile: "b", node: "7" } });
  expect(
    redirectTarget(
      "/devices?filter=online#overview",
      { id: "b", baseUrl: "https://b.test" },
      current,
    ),
  ).toMatchObject({ search: { filter: "online" }, hash: "overview" });
});

test("drops another server's query and hash from a redirect pinned to a different profile", () => {
  expect(redirectTarget("/devices?profile=other&node=7#d", "p1")).toEqual({
    to: "/devices",
    search: {},
    hash: "",
    replace: true,
  });
});
