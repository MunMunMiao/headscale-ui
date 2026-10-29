import { closeSync, mkdtempSync, openSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { countPolicyWrites } from "../scripts/harness/policy-publication-count";

const root = fileURLToPath(new URL("..", import.meta.url));
type CountEvent = Record<string, unknown>;

async function runValidator(
  argument: string,
  verify: (result: {
    exitCode: number;
    output: string;
    events: CountEvent[];
  }) => void,
) {
  const evidence = mkdtempSync(
    join(tmpdir(), "headscale-policy-count-evidence-"),
  );
  const log = join(evidence, "validator.log");
  const fd = openSync(log, "wx", 0o600);
  const env = { ...process.env };
  delete env.DEPLOYMENT_IMAGE;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let hardDeadline: ReturnType<typeof setTimeout> | undefined;
  let passed = false;
  try {
    child = Bun.spawn(
      ["bun", join(root, "scripts/check-policy-lifecycle.ts"), argument],
      {
        cwd: root,
        env,
        stdout: fd,
        stderr: fd,
        timeout: 90_000,
        killSignal: "SIGTERM",
      },
    );
    // Give the owned script's SIGTERM cleanup 15 seconds before bounding a stuck child.
    hardDeadline = setTimeout(() => {
      if (child?.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }, 105_000);
    const exitCode = await child.exited;
    const output = await Bun.file(log).text();
    const events = output
      .split("\n")
      .filter((line) => line.startsWith('{"kind":"policy-publication-count",'))
      .map((line) => JSON.parse(line) as CountEvent);
    const prefix = `headscale-policy-lifecycle-${child.pid}-`;
    const inspections: Record<string, string[]> = {
      containers: [
        "ps",
        "-a",
        "--filter",
        `name=^/${prefix}`,
        "--format",
        "{{.Names}}",
      ],
      networks: [
        "network",
        "ls",
        "--filter",
        `name=^${prefix}`,
        "--format",
        "{{.Name}}",
      ],
      volumes: [
        "volume",
        "ls",
        "--filter",
        `name=^${prefix}`,
        "--format",
        "{{.Name}}",
      ],
      images: [
        "image",
        "ls",
        "--filter",
        `reference=${prefix}*`,
        "--format",
        "{{.Repository}}:{{.Tag}}",
      ],
    };
    const resources: Record<string, string[]> = {};
    for (const [kind, args] of Object.entries(inspections)) {
      const result = Bun.spawnSync(["docker", ...args], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      });
      expect(result.exitCode, `Owned ${kind} inspection must succeed`).toBe(0);
      resources[kind] = result.stdout
        .toString()
        .trim()
        .split("\n")
        .filter(Boolean);
    }
    resources.temporaryDirectories = readdirSync(tmpdir()).filter((name) =>
      name.startsWith(prefix),
    );
    expect(resources).toEqual({
      containers: [],
      networks: [],
      volumes: [],
      images: [],
      temporaryDirectories: [],
    });
    expect(
      output.includes("Policy lifecycle cleanup failed:"),
      "Cleanup failure is not a counter rejection",
    ).toBe(false);
    console.log(
      JSON.stringify({
        kind: "policy-publication-count-contract",
        stage: "resources-cleared",
        pid: child.pid,
        exitCode,
      }),
    );
    verify({ exitCode, output, events });
    passed = true;
  } finally {
    if (child?.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await child.exited;
    }
    clearTimeout(hardDeadline);
    closeSync(fd);
    if (passed) rmSync(evidence, { recursive: true });
    else
      console.log(
        JSON.stringify({
          kind: "policy-publication-count-contract",
          stage: "evidence-retained",
          log,
        }),
      );
  }
}

test.each([
  { point: "between-publications", before: 2, after: 3 },
  { point: "after-final-publication", before: 4, after: 5 },
])(
  "the real policy validator rejects a late extra PUT at $point instead of absorbing or omitting it",
  async ({ point, before, after }) => {
    await runValidator(
      `--inject-policy-put=${point}`,
      ({ exitCode, output, events }) => {
        expect(
          events.filter((event) => event.stage === "fault-complete"),
        ).toEqual([
          {
            kind: "policy-publication-count",
            stage: "fault-complete",
            point,
            before,
            after,
            rawUnchanged: true,
          },
        ]);
        expect(
          exitCode,
          "The original validator must reject the completed extra PUT",
        ).toBe(1);
        const rejections = events.filter(
          (event) => event.stage === "count-rejected",
        );
        expect(rejections).toHaveLength(1);
        expect(rejections[0]).toMatchObject({
          kind: "policy-publication-count",
          stage: "count-rejected",
          checkpoint:
            point === "between-publications" ? "before-review" : "final-drain",
          expected: before,
          observed: after,
        });
        const faultIndex = events.findIndex(
          (event) => event.stage === "fault-complete",
        );
        const rejectionIndex = events.indexOf(rejections[0]);
        expect(rejectionIndex).toBeGreaterThan(faultIndex);
        const drains = events.filter((event) => event.stage === "logs-drained");
        if (point === "after-final-publication") {
          expect(drains).toEqual([
            {
              kind: "policy-publication-count",
              stage: "logs-drained",
              proxyExitCode: 0,
              followerExitCode: 0,
              stdoutEof: true,
              stderrEof: true,
              expected: before,
              observed: after,
            },
          ]);
          expect(events.indexOf(drains[0])).toBeGreaterThan(faultIndex);
          expect(events.indexOf(drains[0])).toBeLessThan(rejectionIndex);
        } else {
          expect(drains).toEqual([]);
        }
        const closedFollowers = events.filter(
          (event) => event.stage === "log-follower-closed",
        );
        expect(closedFollowers).toHaveLength(1);
        expect(closedFollowers[0]).toMatchObject({
          forced: point === "between-publications",
          exitCode: point === "between-publications" ? 137 : 0,
          signalCode: point === "between-publications" ? "SIGKILL" : null,
        });
        expect(events.indexOf(closedFollowers[0])).toBeGreaterThan(
          rejectionIndex,
        );
        expect(output.includes("POLICY_PUBLICATION_COUNT_MISMATCH")).toBe(true);
      },
    );
  },
  150_000,
);

test("unknown policy fault values are rejected before fixture creation", async () => {
  await runValidator(
    "--inject-policy-put=unsupported",
    ({ exitCode, output, events }) => {
      expect(exitCode).toBe(1);
      expect(
        output.includes("Unsupported policy lifecycle fault argument"),
      ).toBe(true);
      expect(events).toEqual([]);
    },
  );
});

const policyAccessLine =
  '127.0.0.1 - - [19/Oct/2026:00:00:00 +0000] "PUT /api/v1/policy HTTP/1.1" 200 2 "-" "fixture" "-"';
const policyErrorContext =
  '2026/10/19 00:00:00 [error] 17#17: *1 upstream prematurely closed connection while reading response header from upstream, client: 127.0.0.1, server: , request: "PUT /api/v1/policy HTTP/1.1", upstream: "http://127.0.0.1:8080/api/v1/policy", host: "localhost"';

test.each([
  { name: "one complete access record", logs: policyAccessLine, expected: 1 },
  {
    name: "an error context is not an access record",
    logs: policyErrorContext,
    expected: 0,
  },
  {
    name: "stdout access plus stderr context counts the request once",
    logs: `${policyAccessLine}\n${policyErrorContext}`,
    expected: 1,
  },
  {
    name: "two full PUT records count twice while health GET is ignored",
    logs: [
      policyAccessLine,
      policyAccessLine
        .replace("127.0.0.1", "::1")
        .replace("HTTP/1.1", "HTTP/1.0"),
      policyAccessLine.replace("PUT /api/v1/policy", "GET /health"),
    ].join("\n"),
    expected: 2,
  },
])("policy access-log counter: $name", ({ logs, expected }) => {
  expect(countPolicyWrites(logs)).toBe(expected);
});
