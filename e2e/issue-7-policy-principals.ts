import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type { HeadscaleUser } from "../src/api/types";
import {
  createGroup,
  createTagOwner,
  emptyState,
  findOrphanReferences,
  parsePolicy,
  serializePolicy,
  toMemberRef,
  upsertGroup,
  upsertTagOwner,
} from "../src/domain/policy-designer";
import { setTagAccessor } from "../src/domain/policy-views";
import {
  PrincipalIndex,
  policyPrincipalForUser,
  userMatchesPolicyValue,
  userPolicyPrincipals,
} from "../src/domain/principal";

const root = fileURLToPath(new URL("..", import.meta.url));
const baseUrl = process.env.HEADSCALE_E2E_URL?.replace(/\/$/, "");
const apiKey = process.env.HEADSCALE_E2E_API_KEY ?? process.env.VITE_HEADSCALE_E2E_API_KEY;
const composeProject = process.env.HEADSCALE_E2E_COMPOSE_PROJECT;
const composeFile = process.env.HEADSCALE_E2E_COMPOSE_FILE ?? "e2e/docker-compose.yml";

type PolicyDoc = {
  acls?: Array<{ action?: string; src?: string[]; dst?: string[] }>;
  groups?: Record<string, string[]>;
  tagOwners?: Record<string, string[]>;
};

if (!baseUrl || !apiKey) {
  throw new Error("HEADSCALE_E2E_URL and HEADSCALE_E2E_API_KEY are required");
}
if (!composeProject) {
  throw new Error("HEADSCALE_E2E_COMPOSE_PROJECT is required");
}

function log(story: string, message: string, extra?: unknown) {
  if (extra === undefined) {
    console.log(`[issue7][${story}] ${message}`);
    return;
  }
  console.log(`[issue7][${story}] ${message}`, extra);
}

function cli(args: string[]) {
  const result = Bun.spawnSync({
    cmd: [
      "docker",
      "compose",
      "-p",
      composeProject,
      "-f",
      composeFile,
      "exec",
      "-T",
      "headscale",
      ...args,
    ],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  log("cli", args.join(" "), { exitCode: result.exitCode, stdout, stderr });
  return { exitCode: result.exitCode ?? 1, stdout, stderr };
}

async function request(method: string, path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { ok: response.ok, status: response.status, text };
}

function alreadyExists(text: string): boolean {
  return /already exists|duplicate|UNIQUE constraint/i.test(text);
}

async function listUsers(): Promise<HeadscaleUser[]> {
  const response = await request("GET", "/api/v1/user");
  log("users", `GET /api/v1/user ${response.status}`, response.text);
  const payload = JSON.parse(response.text) as { users?: HeadscaleUser[] };
  return payload.users ?? [];
}

async function findUser(name: string): Promise<HeadscaleUser | undefined> {
  return (await listUsers()).find((user) => user.name === name);
}

async function createUser(
  story: string,
  name: string,
  email?: string,
): Promise<{ user?: HeadscaleUser; createLog: string }> {
  const extra = email ? ["--email", email] : [];
  let created = cli(["headscale", "users", "create", name, ...extra]);
  if (created.exitCode !== 0 && email) {
    created = cli(["headscale", "users", "create", name, "-e", email]);
  }
  if (created.exitCode !== 0 && !alreadyExists(`${created.stdout}\n${created.stderr}`)) {
    const body: Record<string, string> = { name };
    if (email) body.email = email;
    const posted = await request("POST", "/api/v1/user", body);
    log(story, `POST /api/v1/user ${name}`, { status: posted.status, body: posted.text });
    if (!posted.ok && !alreadyExists(posted.text)) {
      return {
        createLog: `cli exit ${created.exitCode} stdout=${created.stdout} stderr=${created.stderr} post=${posted.status} ${posted.text}`,
      };
    }
  }
  const user = await findUser(name);
  log(story, `live user ${name}`, user);
  return { user, createLog: `${created.stdout}\n${created.stderr}` };
}

async function putPolicy(story: string, policy: unknown) {
  const serialized = typeof policy === "string" ? policy : JSON.stringify(policy);
  const response = await request("PUT", "/api/v1/policy", { policy: serialized });
  log(story, `PUT /api/v1/policy ${response.status}`, response.text);
  return response;
}

async function getPolicy(
  story: string,
): Promise<{ status: number; text: string; parsed: PolicyDoc }> {
  const response = await request("GET", "/api/v1/policy");
  log(story, `GET /api/v1/policy ${response.status}`, response.text);
  const envelope = JSON.parse(response.text) as { policy?: unknown };
  const parsed =
    typeof envelope.policy === "string"
      ? (JSON.parse(envelope.policy) as PolicyDoc)
      : ((envelope.policy ?? {}) as PolicyDoc);
  return { status: response.status, text: response.text, parsed };
}

function putSerialized(story: string, state: ReturnType<typeof emptyState>) {
  return putPolicy(story, serializePolicy(state));
}

function expect2xx(status: number) {
  expect(status).toBeGreaterThanOrEqual(200);
  expect(status).toBeLessThan(300);
}

function expectRejected(status: number) {
  // Live Headscale maps policy parse failures (gRPC code 2) to HTTP 500, not 4xx.
  expect(status).toBeGreaterThanOrEqual(400);
}

function tokens(list: string[] | undefined): string[] {
  return Array.isArray(list) ? list.map(String) : [];
}

test(
  "issue 7 live policy principals against Headscale",
  async () => {
    const version = await request("GET", "/version");
    log("image", "GET /version", { status: version.status, body: version.text });

    const testUserCreated = await createUser("s1", "test-user");
    const testUser = testUserCreated.user;
    expect(testUser).toBeTruthy();
    expect((testUser?.email ?? "").trim()).toBe("");
    expect(testUser?.name).toBe("test-user");

    const reproduce = await putPolicy("s1", {
      tagOwners: { "tag:issue7": ["test-user"] },
      acls: [],
    });
    let story1 = reproduce;
    if (!/invalid owner format|Invalid Owner/i.test(reproduce.text)) {
      story1 = await putPolicy("s1", {
        tagOwners: { "tag:issue7": ["test-user"] },
        acls: [{ action: "accept", src: ["*"], dst: ["*:*"] }],
      });
    }
    expectRejected(story1.status);
    expect(story1.text).toMatch(/invalid owner format|Invalid Owner/i);
    expect(story1.text).toMatch(/test-user/);
    expect(story1.ok).toBe(false);

    const liveTestUser = (await findUser("test-user")) ?? testUser;
    expect(liveTestUser).toBeTruthy();
    if (!liveTestUser) throw new Error("test-user missing after create");
    const cliPrincipal = policyPrincipalForUser(liveTestUser);
    log("s2", "policyPrincipalForUser(test-user)", cliPrincipal);
    expect(cliPrincipal).toBe("test-user@");

    let state = emptyState();
    state = upsertTagOwner(state, createTagOwner("tag:issue7", [toMemberRef(cliPrincipal)]));
    const tagOwnerPut = await putSerialized("s2", state);
    expect2xx(tagOwnerPut.status);
    const afterTagOwner = await getPolicy("s2");
    expect2xx(afterTagOwner.status);
    expect(tokens(afterTagOwner.parsed.tagOwners?.["tag:issue7"])).toEqual([cliPrincipal]);
    expect(tokens(afterTagOwner.parsed.tagOwners?.["tag:issue7"])).not.toContain("test-user");
    const cliPrincipals = userPolicyPrincipals(liveTestUser);
    expect(cliPrincipals).toContain(liveTestUser.name);
    expect(cliPrincipals).toContain(cliPrincipal);
    expect(
      tokens(afterTagOwner.parsed.tagOwners?.["tag:issue7"]).some((value) =>
        cliPrincipals.includes(value),
      ),
    ).toBe(true);
    expect(userMatchesPolicyValue(liveTestUser, cliPrincipal)).toBe(true);
    expect(userMatchesPolicyValue(liveTestUser, liveTestUser.name)).toBe(true);

    state = emptyState();
    state = upsertGroup(state, createGroup("group:issue7", [toMemberRef(cliPrincipal)]));
    state = upsertTagOwner(state, createTagOwner("tag:issue7", [toMemberRef(cliPrincipal)]));
    state = setTagAccessor(state, "tag:issue7", cliPrincipal, "*");
    const groupAclPut = await putSerialized("s3s4", state);
    expect2xx(groupAclPut.status);
    const afterGroupAcl = await getPolicy("s3s4");
    expect2xx(afterGroupAcl.status);
    expect(tokens(afterGroupAcl.parsed.groups?.["group:issue7"])).toEqual([cliPrincipal]);
    expect(tokens(afterGroupAcl.parsed.groups?.["group:issue7"])).not.toContain("test-user");
    const aclSrc = (afterGroupAcl.parsed.acls ?? []).flatMap((rule) => tokens(rule.src));
    expect(aclSrc).toContain(cliPrincipal);
    expect(aclSrc).not.toContain("test-user");

    const aliceCreated = await createUser("s5", "alice", "alice@example.com");
    const alice = aliceCreated.user;
    expect(alice).toBeTruthy();
    expect((alice?.email ?? "").trim()).toBe("alice@example.com");
    if (!alice) throw new Error("alice missing after create");
    const alicePrincipal = policyPrincipalForUser(alice);
    log("s5", "policyPrincipalForUser(alice)", alicePrincipal);
    expect(alicePrincipal).toBe("alice@example.com");
    expect(alicePrincipal).not.toBe("alice@");
    state = emptyState();
    state = upsertTagOwner(state, createTagOwner("tag:issue7-mail", [toMemberRef(alicePrincipal)]));
    state = upsertGroup(state, createGroup("group:issue7-mail", [toMemberRef(alicePrincipal)]));
    state = setTagAccessor(state, "tag:issue7-mail", alicePrincipal, "22");
    const emailPut = await putSerialized("s5", state);
    expect2xx(emailPut.status);
    const afterEmail = await getPolicy("s5");
    expect(tokens(afterEmail.parsed.tagOwners?.["tag:issue7-mail"])).toEqual(["alice@example.com"]);
    expect(tokens(afterEmail.parsed.groups?.["group:issue7-mail"])).toEqual(["alice@example.com"]);
    expect(tokens(afterEmail.parsed.tagOwners?.["tag:issue7-mail"])).not.toContain("alice@");
    expect(tokens(afterEmail.parsed.groups?.["group:issue7-mail"])).not.toContain("alice@");
    expect((afterEmail.parsed.acls ?? []).flatMap((rule) => tokens(rule.src))).toContain(
      "alice@example.com",
    );
    expect(userPolicyPrincipals(alice)).toContain("alice@example.com");
    expect(userMatchesPolicyValue(alice, "alice@")).toBe(true);

    const idpCreated = await createUser("s6", "alice@idp.example");
    const idpHelperUser: Pick<HeadscaleUser, "name" | "email" | "providerId"> = idpCreated.user ?? {
      name: "alice@idp.example",
      email: "",
      providerId: "",
    };
    const idpPrincipal = policyPrincipalForUser(idpHelperUser);
    log("s6", "policyPrincipalForUser(alice@idp.example)", {
      principal: idpPrincipal,
      live: idpCreated.user,
      createLog: idpCreated.createLog,
    });
    expect(idpPrincipal).toBe("alice@idp.example");
    expect(idpPrincipal).not.toBe("alice@idp.example@");
    if (idpCreated.user) {
      expect((idpCreated.user.email ?? "").trim()).toBe("");
      state = emptyState();
      state = upsertTagOwner(state, createTagOwner("tag:issue7-idp", [toMemberRef(idpPrincipal)]));
      state = upsertGroup(state, createGroup("group:issue7-idp", [toMemberRef(idpPrincipal)]));
      state = setTagAccessor(state, "tag:issue7-idp", idpPrincipal, "22");
      const idpPut = await putSerialized("s6", state);
      expect2xx(idpPut.status);
      const afterIdp = await getPolicy("s6");
      expect(tokens(afterIdp.parsed.tagOwners?.["tag:issue7-idp"])).toEqual(["alice@idp.example"]);
      expect(tokens(afterIdp.parsed.groups?.["group:issue7-idp"])).toEqual(["alice@idp.example"]);
      expect(tokens(afterIdp.parsed.tagOwners?.["tag:issue7-idp"])).not.toContain(
        "alice@idp.example@",
      );
    } else {
      log("s6", "skip live PUT; Headscale rejected alice@idp.example create", idpCreated.createLog);
    }

    const opsCreated = await createUser("s7", "ops");
    const opsUser = opsCreated.user;
    expect(opsUser).toBeTruthy();
    if (!opsUser) throw new Error("ops missing after create");
    const opsPrincipal = policyPrincipalForUser(opsUser);
    state = emptyState();
    state = upsertGroup(state, createGroup("group:ops", [toMemberRef(opsPrincipal)]));
    state = upsertTagOwner(
      state,
      createTagOwner("tag:issue7-mix", [toMemberRef("group:ops"), toMemberRef(cliPrincipal)]),
    );
    state = setTagAccessor(state, "tag:issue7-mix", "group:ops", "*");
    const mixedPut = await putSerialized("s7", state);
    expect2xx(mixedPut.status);
    const afterMixed = await getPolicy("s7");
    const mixedOwners = tokens(afterMixed.parsed.tagOwners?.["tag:issue7-mix"]);
    expect(mixedOwners).toContain("group:ops");
    expect(mixedOwners).toContain(cliPrincipal);
    expect(mixedOwners).not.toContain("test-user");
    expect(mixedOwners).not.toContain("ops");
    expect(tokens(afterMixed.parsed.groups?.["group:ops"])).toEqual([opsPrincipal]);

    const inventory = await listUsers();
    log(
      "s8",
      "GET /api/v1/user inventory",
      inventory.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        provider: user.provider,
      })),
    );
    expect(inventory.some((user) => user.name === "tagged-devices")).toBe(false);

    const remainingUser = liveTestUser;
    const deletedCreated = await createUser("s9", "deleted-user");
    const deletedUser = deletedCreated.user;
    expect(deletedUser).toBeTruthy();
    if (!deletedUser) throw new Error("deleted-user missing after create");
    const deletedPrincipal = policyPrincipalForUser(deletedUser);
    state = emptyState();
    state = upsertGroup(
      state,
      createGroup("group:ops", [toMemberRef(cliPrincipal), toMemberRef(deletedPrincipal)]),
    );
    state = upsertTagOwner(
      state,
      createTagOwner("tag:issue7", [toMemberRef(cliPrincipal), toMemberRef(deletedPrincipal)]),
    );
    const seedOrphan = await putSerialized("s9", state);
    expect2xx(seedOrphan.status);
    const destroyed = cli(["headscale", "users", "destroy", "--name", "deleted-user", "--force"]);
    if (destroyed.exitCode !== 0) {
      cli(["headscale", "users", "destroy", "deleted-user", "--force"]);
    }
    const remaining = await listUsers();
    expect(remaining.some((user) => user.name === "deleted-user")).toBe(false);
    const afterDelete = await getPolicy("s9");
    const orphans = findOrphanReferences(
      parsePolicy(JSON.stringify(afterDelete.parsed)),
      PrincipalIndex.fromUsers(remaining),
    );
    log("s9", "findOrphanReferences", orphans);
    expect(
      orphans.some((item) => item.kind === "tag-owner" && item.value === deletedPrincipal),
    ).toBe(true);
    expect(
      orphans.some((item) => item.kind === "group-member" && item.value === deletedPrincipal),
    ).toBe(true);
    expect(orphans.some((item) => item.value === cliPrincipal)).toBe(false);
    expect(PrincipalIndex.fromUsers(remaining).has(deletedPrincipal)).toBe(false);
    expect(PrincipalIndex.fromUsers(remaining).has(cliPrincipal)).toBe(true);
    expect(
      tokens(afterDelete.parsed.tagOwners?.["tag:issue7"]).some((value) =>
        userPolicyPrincipals(remainingUser).includes(value),
      ),
    ).toBe(true);
    expect(userMatchesPolicyValue(remainingUser, cliPrincipal)).toBe(true);
  },
  { timeout: 120_000 },
);
