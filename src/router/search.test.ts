import { expect, test } from "vitest";
import { parseSearch, stringifySearch } from "./search";

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
