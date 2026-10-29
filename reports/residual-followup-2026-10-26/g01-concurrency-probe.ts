import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createCleanup, docker } from "../../scripts/harness/docker";
import { createSessionNetwork } from "../../scripts/harness/session-network";
import {
  createTagLifecycleFixture,
  type TagLifecycleFixture,
  tagLifecycleDiagnostics,
} from "../../scripts/harness/tag-lifecycle";
import { waitUntil } from "../../scripts/harness/wait-until";
import type { HeadscaleUser } from "../../src/api/contracts";
import {
  policyPrincipalForUser,
  userCreationPrincipalConflict,
  userMatchesPolicyValue,
} from "../../src/domain/principal";

// A standalone characterization probe, not a UI test or an atomicity guarantee.
// PASS means the deliberately scheduled control-plane race was confirmed.
type Network = ReturnType<typeof createSessionNetwork>;
type Candidate = { name: string; email: string };
let fixture: TagLifecycleFixture | undefined;
let networkA: Network | undefined;
let networkB: Network | undefined;
let secrets: string[] = [];
let sequence = 0;
const reads = new Map<string, HeadscaleUser[]>();
function record(phase: string, evidence: Record<string, unknown>) {
  console.log(
    JSON.stringify({
      sequence: ++sequence,
      at: new Date().toISOString(),
      phase,
      ...evidence,
    }),
  );
}
function identities(users: readonly HeadscaleUser[]) {
  return users.map(({ id, name, email }) => ({ id, name, email: email ?? "" }));
}
function owners(users: readonly HeadscaleUser[], principal: string) {
  return users
    .filter((user) => userMatchesPolicyValue(user, principal, users))
    .map((user) => user.name);
}
const cleanup = createCleanup("G01 concurrency probe", [
  async () => {
    await networkA?.close();
  },
  async () => {
    await networkB?.close();
  },
  async () => {
    await fixture?.close();
  },
  () => {
    if (!fixture) return;
    const filter = `label=io.headscale-ui.tag-lifecycle=${fixture.project}`;
    const remaining = {
      containers: docker(
        "ps",
        "-a",
        "--filter",
        filter,
        "--format",
        "{{.Names}}",
      ),
      networks: docker(
        "network",
        "ls",
        "--filter",
        filter,
        "--format",
        "{{.Name}}",
      ),
      volumes: docker(
        "volume",
        "ls",
        "--filter",
        filter,
        "--format",
        "{{.Name}}",
      ),
    };
    assert.deepEqual(remaining, { containers: "", networks: "", volumes: "" });
    assert.equal(existsSync(fixture.directory), false);
    record("cleanup-confirmed", {
      project: fixture.project,
      remaining,
      temporaryDirectoryRemoved: true,
      proxyCloseAwaited: true,
    });
  },
]);

async function main() {
  assert.equal(process.env.HEADSCALE_TAG_LIFECYCLE_OWNER, undefined);
  assert.equal(process.env.HEADSCALE_TAG_LIFECYCLE_DIRECTORY, undefined);
  fixture = await createTagLifecycleFixture();
  secrets = [fixture.connection().apiKey];
  networkA = createSessionNetwork({ upstream: fixture.baseUrl });
  networkB = createSessionNetwork({ upstream: fixture.baseUrl });
  const a = networkA;
  const b = networkB;
  record("fixture-ready", {
    project: fixture.project,
    server: "Headscale 0.29.4",
    independentProxyEntries: true,
  });

  async function read(network: Network, phase: string) {
    const response = await fixture!.call<{ users: HeadscaleUser[] }>(
      "GET",
      "/api/v1/user",
      undefined,
      network.url,
    );
    assert.equal(response.status, 200, `${phase}: directory GET must succeed`);
    assert.ok(response.json?.users);
    const users = response.json.users;
    reads.set(phase, users);
    record(phase, {
      method: "GET",
      status: response.status,
      users: identities(users),
    });
    return users;
  }
  async function create(network: Network, candidate: Candidate, phase: string) {
    const response = await fixture!.call<{ user: HeadscaleUser }>(
      "POST",
      "/api/v1/user",
      candidate,
      network.url,
    );
    assert.equal(
      response.status,
      200,
      `${phase}: create must reach and be accepted by the real server`,
    );
    assert.ok(response.json?.user);
    record(phase, {
      method: "POST",
      status: response.status,
      user: identities([response.json.user])[0],
    });
    return response.json.user;
  }
  async function checkedCreate(
    network: Network,
    candidate: Candidate,
    phase: string,
  ) {
    const users = await read(network, `${phase}:fresh-GET`);
    const conflict = userCreationPrincipalConflict(candidate, users);
    record(`${phase}:current-helper-check`, { candidate, conflict });
    if (conflict) return null;
    return create(network, candidate, `${phase}:POST-accepted`);
  }

  const first = await checkedCreate(
    a,
    { name: "g01-control-a", email: "g01-control-a@example.test" },
    "distinct-A",
  );
  assert.ok(first);
  const second = await checkedCreate(
    b,
    { name: "g01-control-b", email: "g01-control-b@example.test" },
    "distinct-B",
  );
  assert.ok(second);
  assert.notEqual(first.id, second.id);
  const beforeSequential = b
    .getOperationCalls()
    .filter((call) => call.id === "user.create").length;
  const sequential = await checkedCreate(
    b,
    { name: "g01-sequential-duplicate", email: "g01-control-a@example.test" },
    "sequential-duplicate",
  );
  assert.equal(sequential, null);
  assert.equal(
    b.getOperationCalls().filter((call) => call.id === "user.create").length,
    beforeSequential,
  );
  const sequentialDirectory = await read(
    b,
    "sequential-control:live-directory",
  );
  assert.equal(
    sequentialDirectory.some(
      (user) => user.name === "g01-sequential-duplicate",
    ),
    false,
  );
  assert.deepEqual(owners(sequentialDirectory, "g01-control-a@example.test"), [
    "g01-control-a",
  ]);
  record("controls-PASS", {
    differentEmailsAccepted: true,
    sequentialConflictingCreateNotDispatched: true,
  });

  const email = "g01-parallel@example.test";
  const candidateA = { name: "g01-parallel-a", email };
  const candidateB = { name: "g01-parallel-b", email };
  assert.equal(
    sequentialDirectory.some((user) => user.email === email),
    false,
  );
  const gate = a.intercept({ method: "GET", pathPattern: "^/api/v1/user$" });
  record("race-A:fresh-GET-started", { method: "GET", candidate: candidateA });
  const pendingA = checkedCreate(a, candidateA, "race-A");
  // Attach an error handler before scheduling the other client, without changing the result.
  void pendingA.catch(() => {});
  await waitUntil(async () => gate.getSnapshot().captured, {
    timeoutMsg: "A's real directory response was not captured",
  });
  assert.deepEqual(gate.getSnapshot(), {
    id: gate.getSnapshot().id,
    hits: 1,
    upstreamRequests: 1,
    captured: true,
    released: false,
    finished: false,
  });
  record("race-A:upstream-response-captured-and-held", {
    gate: gate.getSnapshot(),
  });

  const createdB = await checkedCreate(b, candidateB, "race-B");
  assert.ok(createdB);
  const afterB = await read(b, "race-B:committed-directory-before-A-release");
  assert.deepEqual(owners(afterB, email), ["g01-parallel-b"]);
  const liveConflict = userCreationPrincipalConflict(candidateA, afterB);
  assert.deepEqual(liveConflict, { field: "email", principal: email });
  record("race-B:principal-unique-before-A-release", {
    principal: email,
    owners: owners(afterB, email),
    candidateAWithCurrentDirectory: liveConflict,
  });

  record("race-A:release-old-real-response", { gate: gate.getSnapshot() });
  await gate.release();
  const createdA = await pendingA;
  assert.ok(createdA);
  assert.notEqual(createdA.id, createdB.id);
  const directoryA = reads.get("race-A:fresh-GET");
  const directoryB = reads.get("race-B:fresh-GET");
  assert.ok(directoryA && directoryB);
  assert.deepEqual(identities(directoryA), identities(directoryB));
  assert.equal(
    directoryA.some((user) => user.id === createdB.id),
    false,
  );
  const final = await read(b, "race:final-live-directory");
  assert.deepEqual(
    final
      .filter((user) => user.email === email)
      .map((user) => user.name)
      .sort(),
    ["g01-parallel-a", "g01-parallel-b"],
  );
  assert.deepEqual(owners(final, email), []);
  assert.equal(policyPrincipalForUser(createdA, final), "g01-parallel-a@");
  assert.equal(policyPrincipalForUser(createdB, final), "g01-parallel-b@");
  assert.equal(
    a.getOperationCalls().filter((call) => call.id === "user.create").length,
    2,
  );
  assert.equal(
    b.getOperationCalls().filter((call) => call.id === "user.create").length,
    2,
  );
  record("race-confirmed", {
    samePreCommitDirectories: true,
    createdIds: [createdA.id, createdB.id],
    principal: email,
    ownersBeforeACommit: ["g01-parallel-b"],
    ownersAfterACommit: owners(final, email),
    fallbackPrincipals: [
      policyPrincipalForUser(createdA, final),
      policyPrincipalForUser(createdB, final),
    ],
    uniquePrincipalPreservationViolated: true,
    uiDoublePageTest: false,
    riskFixed: false,
  });
}

try {
  await main();
} catch (error) {
  console.error(
    tagLifecycleDiagnostics(
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error),
      secrets,
    ),
  );
  process.exitCode = 1;
} finally {
  await cleanup();
}
if (!process.exitCode)
  record("PASS", {
    meaning:
      "real control-plane concurrency risk confirmed; not a risk fix or a real UI double-page test",
  });
