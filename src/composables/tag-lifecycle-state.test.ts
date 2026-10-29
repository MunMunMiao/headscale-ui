import { describe, expect, test } from "vitest";
import {
  createTagLifecycleStore,
  type LifecycleScope,
  type TagInviteDraft,
  type TagReturnDraft,
} from "./tag-lifecycle-state";

const scope: LifecycleScope = {
  generation: 0,
  profileId: "p1",
  baseUrl: "https://a.test",
  workerId: "worker",
  sessionId: "session",
  viewEpoch: 1,
  version: "v0.29.4",
  versionFresh: true,
};
const form: TagInviteDraft = {
  userId: "u1",
  userName: "alice",
  tags: ["tag:old", "tag:extra"],
  tagInput: "tag:pending",
  reusable: true,
  ephemeral: true,
  expiration: "2020-01-01T12:30:00.000Z",
  expirationMode: "custom",
  expiryDays: "19",
};
const baseline = {
  nodeId: "n1",
  machineKey: "public-machine",
  user: { id: "u1", name: "alice" },
  tags: ["tag:old"],
};
const drafts: TagReturnDraft[] = [
  {
    source: "device",
    managedTag: "tag:old",
    editVersion: 7,
    filter: "offline",
    nodeId: "n1",
    tags: ["tag:old", "tag:extra"],
    baseline,
  },
  { source: "invite", managedTag: "tag:old", editVersion: 7, form },
  {
    source: "member-invite",
    managedTag: "tag:old",
    editVersion: 7,
    memberId: "u1",
    form,
  },
  {
    source: "setup",
    managedTag: "tag:old",
    editVersion: 7,
    form,
    task: "server",
    step: "authKey",
    advertiseExitNode: true,
    loginServer: "https://login.test/prefix",
  },
];
function store() {
  const result = createTagLifecycleStore();
  result.bind(scope);
  return result;
}

test("maintenance input has an independent nonsecret slot and follows session invalidation", () => {
  const lifecycle = store();
  const saved = lifecycle.saveReturn(drafts[1]);
  const input = {
    tag: "tag:old",
    targetInput: "replacement",
    intent: "existing" as const,
    key: "must-not-retain",
  };
  lifecycle.rememberMaintenance(input);
  expect(lifecycle.getSnapshot().maintenanceDraft).toEqual({
    tag: "tag:old",
    targetInput: "replacement",
    intent: "existing",
  });
  expect(lifecycle.getSnapshot().returnTo).toEqual(saved);
  lifecycle.bind({ ...scope, version: "0.29.5" });
  expect(lifecycle.getSnapshot().maintenanceDraft?.targetInput).toBe(
    "replacement",
  );
  lifecycle.bind({ ...scope, sessionId: "another-session" });
  expect(lifecycle.getSnapshot().maintenanceDraft).toBeNull();
  lifecycle.bind(null);
  lifecycle.rememberMaintenance(input);
  expect(lifecycle.getSnapshot().maintenanceDraft).toBeNull();
});

describe("single nonsecret tag management return slot", () => {
  test.each(drafts)(
    "restores $source once with complete original selections and absolute expiry",
    (draft) => {
      const lifecycle = store();
      const saved = lifecycle.saveReturn(draft);
      expect(saved).toMatchObject({ ...draft, scope, status: "managing" });
      expect(lifecycle.requestReturn(saved?.id ?? "missing")).toBe(true);
      expect(lifecycle.consumeReturn(saved?.id ?? "missing")).toMatchObject({
        ...draft,
        status: "returning",
      });
      expect(lifecycle.consumeReturn(saved?.id ?? "missing")).toBeNull();
      expect(lifecycle.getSnapshot().returnTo).toBeNull();
    },
  );

  test("a newer handoff replaces rather than queues the old slot; cancel cannot clear another handoff", () => {
    const lifecycle = store();
    const first = lifecycle.saveReturn(drafts[0]);
    const second = lifecycle.saveReturn(drafts[1]);
    expect(second).not.toBeNull();
    expect(second?.id).not.toBe(first?.id);
    expect(lifecycle.consumeReturn(first?.id ?? "missing")).toBeNull();
    lifecycle.cancelReturn(first?.id);
    expect(lifecycle.getSnapshot().returnTo?.id).toBe(second?.id);
    lifecycle.cancelReturn(second?.id);
    expect(lifecycle.requestReturn(second?.id ?? "missing")).toBe(false);
    lifecycle.saveReturn(drafts[0]);
    lifecycle.cancelReturn();
    expect(lifecycle.getSnapshot().returnTo).toBeNull();
  });

  test("field projection excludes secret extensions at every retained object boundary", () => {
    const lifecycle = store();
    const original = {
      ...drafts[3],
      key: "TOP-SECRET",
      authId: "AUTH-SECRET",
      form: {
        ...form,
        tags: [...form.tags],
        key: "NESTED-SECRET",
        authId: "AUTH-SECRET",
      },
    };
    const saved = lifecycle.saveReturn(original as TagReturnDraft);
    expect(saved).not.toBeNull();
    expect(JSON.stringify(saved)).not.toContain("SECRET");
    original.form.tags.push("tag:later-edit");
    expect(JSON.stringify(lifecycle.getSnapshot().returnTo)).not.toContain(
      "tag:later-edit",
    );
    const extraBaseline = {
      ...drafts[0],
      baseline: {
        ...baseline,
        apiKey: "BASELINE-SECRET",
        user: { id: "u1", name: "alice", password: "USER-SECRET" },
      },
    };
    lifecycle.saveReturn(extraBaseline as TagReturnDraft);
    expect(JSON.stringify(lifecycle.getSnapshot())).not.toContain("SECRET");
  });

  test.each([
    "https://user:password@login.test",
    "https://login.test?authId=SECRET",
    "https://login.test/#key=SECRET",
    "https://login.test/auth/hskey-authreq-SECRET",
    "not-a-url",
  ])("does not retain non-public login-server input %s", (loginServer) => {
    const lifecycle = store();
    expect(
      lifecycle.saveReturn({ ...drafts[3], loginServer } as TagReturnDraft),
    ).toBeNull();
  });

  test.each([
    { profileId: "p2" },
    { baseUrl: "https://b.test" },
    { workerId: "other-worker" },
    { sessionId: "re-unlocked" },
    { viewEpoch: 2 },
  ])(
    "identity/view change %j clears return and rejects old confirmations even after changing back",
    (patch) => {
      const lifecycle = store();
      const first = lifecycle.saveReturn(drafts[0]);
      lifecycle.bind({ ...scope, ...patch });
      expect(lifecycle.isCurrent(scope)).toBe(false);
      expect(lifecycle.getSnapshot().returnTo).toBeNull();
      lifecycle.bind(scope);
      expect(lifecycle.consumeReturn(first?.id ?? "missing")).toBeNull();
    },
  );

  test("version change or failed version read invalidates confirmation but retains nonsecret input", () => {
    const lifecycle = store();
    const first = lifecycle.saveReturn(drafts[1]);
    lifecycle.bind({ ...scope, version: "dev" });
    expect(lifecycle.isCurrent(scope)).toBe(false);
    expect(lifecycle.getSnapshot().returnTo).toMatchObject({
      id: first?.id,
      form,
    });
    const dev = lifecycle.captureScope();
    expect(lifecycle.isCurrent(dev)).toBe(true);
    lifecycle.bind({ ...scope, version: "dev", versionFresh: false });
    expect(lifecycle.isCurrent(dev)).toBe(false);
    const unknownVersion = lifecycle.captureScope();
    expect(lifecycle.isCurrent(unknownVersion)).toBe(true);
    lifecycle.bind(null);
    expect(lifecycle.captureScope()).toBeNull();
    expect(lifecycle.isCurrent(unknownVersion)).toBe(false);
    expect(lifecycle.saveReturn(drafts[0])).toBeNull();
  });
});

test.each([
  "https://login.example/auth/headscale",
  "https://hskey-gateway.example",
])(
  "accepts a public login-server base %s without a substring blacklist",
  (loginServer) => {
    expect(
      store().saveReturn({ ...drafts[3], loginServer } as TagReturnDraft),
    ).toMatchObject({
      loginServer,
    });
  },
);

test.each([
  `https://login.example/%61uth/%68skey-authreq-${"x".repeat(24)}`,
  `https://login.example/register/hskey-authreq-${"x".repeat(24)}`,
  "https://login.example/%zz",
])(
  "rejects decoded authentication material or malformed encoding %s",
  (loginServer) => {
    expect(
      store().saveReturn({ ...drafts[3], loginServer } as TagReturnDraft),
    ).toBeNull();
  },
);

test("setup can retain an unspecified public login server without retaining authentication material", () => {
  const lifecycle = store();
  expect(
    lifecycle.saveReturn({ ...drafts[3], loginServer: null } as TagReturnDraft),
  ).toMatchObject({ loginServer: null });
});

test("scope ABA never revives a prior confirmation, while unchanged binding and input return still work", () => {
  const lifecycle = store();
  const captured = lifecycle.captureScope();
  expect.assert(captured);
  const saved = lifecycle.saveReturn(drafts[1]);
  lifecycle.bind({ ...scope, versionFresh: false });
  lifecycle.bind(scope);
  expect(lifecycle.isCurrent(captured)).toBe(false);
  const next = lifecycle.captureScope();
  expect.assert(next);
  lifecycle.bind(scope);
  expect(lifecycle.isCurrent(next)).toBe(true);
  expect(lifecycle.requestReturn(saved?.id ?? "missing")).toBe(true);
  expect(lifecycle.consumeReturn(saved?.id ?? "missing")).toMatchObject({
    form,
    scope: next,
  });
});
