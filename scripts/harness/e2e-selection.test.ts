import { expect, test } from "vitest";
import { selectE2eSuites } from "./e2e-selection";

test("keeps the full no-argument run and scopes legacy filters to main", () => {
  expect(selectE2eSuites([])).toEqual({
    suites: ["main", "tag-lifecycle", "contract"],
    vitestArgs: [],
  });
  expect(selectE2eSuites(["--suite=all"])).toEqual({
    suites: ["main", "tag-lifecycle", "contract"],
    vitestArgs: [],
  });
  expect(
    selectE2eSuites(["e2e/headscale-ui.browser.test.tsx", "-t", "one case"]),
  ).toEqual({
    suites: ["main"],
    vitestArgs: ["e2e/headscale-ui.browser.test.tsx", "-t", "one case"],
  });
});

test.each([
  {
    argv: ["e2e/headscale-ui.browser.test.tsx", "--", "-t", "SSH"],
    suites: ["main"],
    vitestArgs: ["e2e/headscale-ui.browser.test.tsx", "-t", "SSH"],
  },
  {
    argv: ["--suite", "tag-lifecycle", "--", "-t", "G27"],
    suites: ["tag-lifecycle"],
    vitestArgs: ["-t", "G27"],
  },
])(
  "does not let an invocation separator disable name filtering: $argv",
  ({ argv, suites, vitestArgs }) => {
    expect(selectE2eSuites(argv)).toEqual({ suites, vitestArgs });
  },
);

test.each(["main", "tag-lifecycle", "contract"] as const)(
  "selects only %s and preserves Vitest filter values",
  (suite) => {
    expect(
      selectE2eSuites([
        "--",
        "--suite",
        suite,
        "-t",
        "name with spaces",
        "--reporter=verbose",
      ]),
    ).toEqual({
      suites: [suite],
      vitestArgs: ["-t", "name with spaces", "--reporter=verbose"],
    });
    expect(selectE2eSuites([`--suite=${suite}`])).toEqual({
      suites: [suite],
      vitestArgs: [],
    });
    expect(
      selectE2eSuites([`--suite=${suite}`, "--testNamePattern=--r"]),
    ).toEqual({
      suites: [suite],
      vitestArgs: ["--testNamePattern=--r"],
    });
  },
);

test.each([
  ["--suite", "missing"],
  ["--suite"],
  ["--suite="],
  ["--suite=main", "--suite=main"],
  ["--suite=all", "-t", "only one suite"],
  ["--config=other.config.ts"],
  ["-c", "other.config.ts"],
  ["--root=.."],
  ["--workspace", "elsewhere"],
  ["--c=other.config.ts"],
  ["--r", ".."],
  ["-r.."],
])(
  "rejects an ambiguous selection or configuration override: %j",
  (...args) => {
    expect(() => selectE2eSuites(args)).toThrow();
  },
);
