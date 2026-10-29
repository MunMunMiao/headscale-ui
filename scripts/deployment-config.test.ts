import { expect, test } from "vitest";

const read = (path: string) => Bun.file(path).text();
interface Job {
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  uses?: string;
  steps?: {
    if?: string;
    uses?: string;
    with?: Record<string, unknown>;
  }[];
}
interface Workflow {
  on: Record<string, unknown>;
  jobs: Record<string, Job>;
}
// Test-only view of our own workflow files; every asserted field is checked below.
const workflow = async (name: string) =>
  Bun.YAML.parse(await read(`.github/workflows/${name}.yml`)) as Workflow;

test("CI is reusable and both publishing workflows are gated by it", async () => {
  expect(Object.keys((await workflow("ci")).on)).toContain("workflow_call");
  const docker = await workflow("docker");
  const pages = await workflow("pages");
  for (const [config, job] of [
    [docker, "build"],
    [pages, "deploy"],
  ] as const) {
    expect(config.jobs.verify.uses).toBe("./.github/workflows/ci.yml");
    expect(config.jobs.verify.permissions).toEqual({ contents: "read" });
    expect([config.jobs[job].needs].flat()).toContain("verify");
  }
  expect(docker.jobs.verify.if).toBe("github.event_name != 'pull_request'");
  // Fail closed: a skipped or failed verify must not publish, but PR builds still run.
  expect(docker.jobs.build.if).toContain("needs.verify.result == 'success'");
  expect(docker.jobs.build.if).toContain("github.event_name == 'pull_request'");
  expect(pages.jobs.verify.if).toBe(pages.jobs.deploy.if);
});

test("failed CI jobs preserve only existing browser screenshots as short-lived artifacts", async () => {
  const ci = await workflow("ci");
  expect(ci.jobs.e2e).toBeUndefined();
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
  expect(upload?.with?.name).toEqual(expect.any(String));
});

test("base images are referenced by tag", async () => {
  const dockerfile = await read("Dockerfile");
  expect(dockerfile.match(/^FROM .+$/gm)).toEqual([
    "FROM --platform=$BUILDPLATFORM oven/bun:1.4.4-alpine AS build",
    "FROM nginx:1.30.6-alpine",
  ]);
  expect(dockerfile).not.toContain("@sha256:");
});

test("nginx template declares headers once at server level", async () => {
  const template = (await read("docker/nginx.conf")).replace(
    /\$\{[A-Z_]+\}/g,
    "x",
  );
  const blocks = template.match(/location [^{]*\{[^{}]*\}/g) ?? [];
  expect(blocks.length).toBeGreaterThan(0);
  // add_header is not inherited by a location that sets its own, so locations must only set variables.
  for (const block of blocks) expect(block, block).not.toContain("add_header");
  for (const header of [
    "Content-Security-Policy",
    "X-Frame-Options",
    "X-Content-Type-Options",
  ])
    expect(template).toContain(`add_header ${header} `);
  expect(template).toContain("gzip_vary on;");
});

test("deployment check counts a collapsed snapshot status error without opening it", async () => {
  const source = await read("scripts/check-deployment.ts");
  expect(source).toContain('[data-testid="page-body"]');
  expect(source).toContain('[data-testid="feedback-status-error"]');
  expect(source).toContain("shows an error instead of its content");
  expect(source).not.toContain("refresh-error-");
});

test("ignore files keep local tool state out of images and git", async () => {
  const dockerignore = (await read(".dockerignore")).split("\n");
  expect(dockerignore).toEqual(
    expect.arrayContaining([".superpowers", ".grok"]),
  );
  expect((await read(".gitignore")).split("\n")).toContain(".superpowers/");
});
