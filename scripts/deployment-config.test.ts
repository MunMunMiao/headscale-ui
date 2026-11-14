import { expect, test } from "vitest";
import { testDouble } from "@/test/dom";

interface Workflow {
  jobs: Record<
    string,
    {
      steps?: {
        if?: string;
        uses?: string;
        with?: Record<string, unknown>;
      }[];
    }
  >;
}

test("CI artifact publication stays failure-only, allowlisted and short-lived", async () => {
  const ci = testDouble<Workflow>(
    Bun.YAML.parse(await Bun.file(".github/workflows/ci.yml").text()),
  );
  const uploads = ci.jobs.test.steps?.filter((step) =>
    step.uses?.startsWith("actions/upload-artifact@"),
  );
  expect(uploads).toHaveLength(1);
  const upload = uploads?.[0];
  expect(upload?.if).toBe("failure()");
  expect(upload?.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
  expect(upload?.with?.path).toBe(".vitest/attachments/failure-screenshots");
  expect(upload?.with?.["include-hidden-files"]).toBe(true);
  expect(upload?.with?.["if-no-files-found"]).toBe("ignore");
  expect(upload?.with?.["retention-days"]).toBeGreaterThanOrEqual(1);
  expect(upload?.with?.["retention-days"]).toBeLessThanOrEqual(7);
});

test("Git excludes local tool state without excluding application source", () => {
  const excluded = [
    ".superpowers/test-cleanup-canary",
    ".grok/test-cleanup-canary",
  ];
  const result = Bun.spawnSync([
    "git",
    "-c",
    "core.excludesFile=",
    "check-ignore",
    "--no-index",
    "--verbose",
    "--",
    ...excluded,
    "src/main.ts",
  ]);
  expect(result.exitCode).toBe(0);
  expect(new TextDecoder().decode(result.stderr)).toBe("");
  const matches = new TextDecoder().decode(result.stdout).trim().split(/\r?\n/);
  expect(matches.map((line) => line.split("\t")[1])).toEqual(excluded);
  for (const match of matches) expect(match).toMatch(/^\.gitignore:\d+:[^!]/);
});
