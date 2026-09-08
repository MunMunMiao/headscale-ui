import { describe, expect, test } from "bun:test";
import type { HeadscaleUser } from "@/api/types";
import { hasVisibleUser, isTagManagedDeviceUser } from "@/utils/user";
import {
  createGroup,
  createTagOwner,
  emptyState,
  findOrphanReferences,
  serializePolicy,
  toMemberRef,
  upsertGroup,
  upsertTagOwner,
} from "./policy-designer";
import {
  PrincipalIndex,
  policyPrincipalForUser,
  toPrincipal,
  userMatchesPolicyValue,
  userPolicyPrincipals,
} from "./principal";

function makeUser(over: Partial<HeadscaleUser>): HeadscaleUser {
  return {
    id: "1",
    name: "",
    displayName: "",
    email: "",
    providerId: "",
    provider: "",
    createdAt: "",
    profilePicUrl: "",
    ...over,
  } as HeadscaleUser;
}

function userPickerOptionValues(
  users: readonly HeadscaleUser[],
  selectedValues: readonly string[],
): string[] {
  const visibleUsers = users.filter((user) => user.name !== "tagged-devices");
  const opts: string[] = [];
  for (const user of visibleUsers) {
    const id = policyPrincipalForUser(user);
    if (!id) continue;
    if (selectedValues.some((value) => userMatchesPolicyValue(user, value))) continue;
    opts.push(id);
  }
  return opts;
}

describe("toPrincipal", () => {
  test("normalizes whitespace and case", () => {
    expect(toPrincipal("  Alice@Example.COM  ")).toBe("alice@example.com");
    expect(toPrincipal("Bob")).toBe("bob");
  });
});

describe("PrincipalIndex", () => {
  test("trims whitespace but keeps Headscale's case-sensitive matching", () => {
    const index = new PrincipalIndex(["Alice@Example.COM", "  bob  "]);
    expect(index.has("alice@example.com")).toBe(false);
    expect(index.has(" Alice@Example.COM ")).toBe(true);
    expect(index.has("BOB")).toBe(false);
    expect(index.has(" bob ")).toBe(true);
    expect(index.has("carol")).toBe(false);
  });

  test("ignores empty strings", () => {
    const index = new PrincipalIndex(["", "alice@example.com", ""]);
    expect(index.has("")).toBe(false);
    expect(index.has("alice@example.com")).toBe(true);
  });

  test("fromUsers harvests both email and name", () => {
    const index = PrincipalIndex.fromUsers([
      makeUser({ email: "alice@example.com", name: "alice" }),
      makeUser({ email: "", name: "bob" }),
      makeUser({ email: "carol@example.com", name: "" }),
    ]);
    expect(index.has("ALICE@example.com")).toBe(false);
    expect(index.has("alice@example.com")).toBe(true);
    expect(index.has("alice")).toBe(true);
    expect(index.has("BOB")).toBe(false);
    expect(index.has("bob@")).toBe(true);
    expect(index.has("carol@example.com")).toBe(true);
    expect(index.has("nobody")).toBe(false);
  });

  test("fromUsers recognizes email, name, and name@ aliases", () => {
    const index = PrincipalIndex.fromUsers([
      makeUser({ email: " Alice@Example.COM ", name: " Alice " }),
      makeUser({ email: "", name: " corp " }),
    ]);

    expect(index.has("Alice@Example.COM")).toBe(true);
    expect(index.has("Alice@Example.COM@")).toBe(true);
    expect(index.has(" Alice ")).toBe(true);
    expect(index.has(" Alice@ ")).toBe(true);
    expect(index.has("alice@example.com")).toBe(false);
    expect(index.has("CORP@")).toBe(false);
    expect(index.has("corp@")).toBe(true);
    expect(index.has("corp@@")).toBe(false);
    expect(index.has("ghost@")).toBe(false);
  });

  test("fromUsers mirrors Headscale v0.28 suffix resolution and exact provider identifiers", () => {
    const index = PrincipalIndex.fromUsers([
      makeUser({
        email: "alice@example.com",
        name: "alice@idp.example",
        providerId: "https://idp.example/Subject",
      }),
      makeUser({ name: "bob", providerId: "urn:bob@idp" }),
    ]);

    expect(index.has("alice@idp.example")).toBe(true);
    expect(index.has("alice@idp.example@")).toBe(true);
    expect(index.has("alice@example.com@")).toBe(true);
    expect(index.has("https://idp.example/Subject@")).toBe(true);
    expect(index.has("https://idp.example/subject@")).toBe(false);
    expect(index.has("urn:bob@idp")).toBe(true);
    expect(index.has("urn:bob@idp@")).toBe(true);
  });
});

describe("policyPrincipalForUser", () => {
  test("appends @ for CLI usernames that have no email", () => {
    expect(policyPrincipalForUser(makeUser({ name: "test-user", email: "" }))).toBe("test-user@");
    expect(policyPrincipalForUser(makeUser({ name: "admin-test" }))).toBe("admin-test@");
  });

  test("prefers email when present and leaves emails unchanged", () => {
    expect(policyPrincipalForUser(makeUser({ email: "alice@example.com", name: "alice" }))).toBe(
      "alice@example.com",
    );
  });

  test("keeps OIDC names that already contain @", () => {
    expect(policyPrincipalForUser(makeUser({ email: "", name: "alice@idp.example" }))).toBe(
      "alice@idp.example",
    );
  });

  test("appends @ to a non-email identifier that Headscale still requires", () => {
    expect(policyPrincipalForUser(makeUser({ email: "not-an-email", name: "alice" }))).toBe(
      "not-an-email@",
    );
  });

  test("falls back to providerId when name and email are empty", () => {
    expect(
      policyPrincipalForUser(
        makeUser({ name: "", email: "", providerId: "https://idp.example/Sub" }),
      ),
    ).toBe("https://idp.example/Sub@");
    expect(policyPrincipalForUser(makeUser({ name: "", email: "", providerId: "user@idp" }))).toBe(
      "user@idp",
    );
  });

  test("returns empty when the user has no usable identifier", () => {
    expect(policyPrincipalForUser(makeUser({ name: "", email: "", providerId: "" }))).toBe("");
    expect(policyPrincipalForUser(makeUser({ name: "  ", email: "  " }))).toBe("");
  });
});

describe("userPolicyPrincipals / userMatchesPolicyValue", () => {
  test("includes name and name@ so existing tagOwners round-trip", () => {
    expect(userPolicyPrincipals(makeUser({ name: "test-user", email: "" }))).toEqual([
      "test-user",
      "test-user@",
    ]);
    expect(userMatchesPolicyValue(makeUser({ name: "test-user", email: "" }), "test-user@")).toBe(
      true,
    );
    expect(userMatchesPolicyValue(makeUser({ name: "test-user", email: "" }), "test-user")).toBe(
      true,
    );
  });

  test("matches both email and name@ aliases for a user that has both", () => {
    const alice = makeUser({ email: "alice@example.com", name: "alice" });
    expect(userPolicyPrincipals(alice)).toEqual(["alice@example.com", "alice", "alice@"]);
    expect(userMatchesPolicyValue(alice, "alice@example.com")).toBe(true);
    expect(userMatchesPolicyValue(alice, "alice@")).toBe(true);
    expect(userMatchesPolicyValue(alice, "ghost@")).toBe(false);
  });

  test("does not treat whitespace as a match", () => {
    expect(userMatchesPolicyValue(makeUser({ name: "alice" }), "  ")).toBe(false);
    expect(userMatchesPolicyValue(makeUser({ name: "alice" }), "")).toBe(false);
  });
});

describe("issue #7 picker, orphans, and serializePolicy", () => {
  test("userPickerOptions skip tagged-devices even if the helper would suffix it", () => {
    const tagged = makeUser({ name: "tagged-devices", email: "", provider: "system" });
    const cliUser = makeUser({ name: "test-user", email: "" });
    const taggedPrincipal = policyPrincipalForUser(tagged);
    const cliPrincipal = policyPrincipalForUser(cliUser);

    expect(isTagManagedDeviceUser(tagged)).toBe(true);
    expect(hasVisibleUser(tagged)).toBe(false);
    expect(hasVisibleUser(cliUser)).toBe(true);

    const options = userPickerOptionValues([tagged, cliUser], []);
    expect(options).toEqual([cliPrincipal]);
    expect(options).not.toContain("tagged-devices");
    expect(options).not.toContain(taggedPrincipal);

    let state = emptyState();
    state = upsertTagOwner(
      state,
      createTagOwner(
        "tag:issue7",
        options.map((value) => toMemberRef(value)),
      ),
    );
    state = upsertGroup(
      state,
      createGroup(
        "group:issue7",
        options.map((value) => toMemberRef(value)),
      ),
    );
    const serialized = serializePolicy(state);
    expect(serialized.tagOwners).toEqual({ "tag:issue7": [cliPrincipal] });
    expect(serialized.groups).toEqual({ "group:issue7": [cliPrincipal] });
  });

  test("findOrphanReferences flags deleted-user@ against remaining CLI users", () => {
    const cliUser = makeUser({ name: "test-user", email: "" });
    const remaining = [cliUser];
    const cliPrincipal = policyPrincipalForUser(cliUser);
    const index = PrincipalIndex.fromUsers(remaining);
    let state = emptyState();
    state = upsertTagOwner(
      state,
      createTagOwner("tag:issue7", [toMemberRef("deleted-user@"), toMemberRef(cliPrincipal)]),
    );
    state = upsertGroup(
      state,
      createGroup("group:issue7", [toMemberRef("deleted-user@"), toMemberRef(cliPrincipal)]),
    );

    const orphans = findOrphanReferences(state, index);
    expect(orphans.map((item) => ({ kind: item.kind, value: item.value }))).toEqual([
      { kind: "group-member", value: "deleted-user@" },
      { kind: "tag-owner", value: "deleted-user@" },
    ]);
    expect(index.has("deleted-user@")).toBe(false);
    expect(index.has(cliPrincipal)).toBe(true);

    const principals = userPolicyPrincipals(cliUser);
    expect(principals).toContain(cliUser.name);
    expect(principals).toContain(cliPrincipal);
    expect(state.tagOwners[0]?.owners.some((owner) => principals.includes(owner.value))).toBe(true);
    expect(state.groups[0]?.members.some((member) => principals.includes(member.value))).toBe(true);
    expect(userMatchesPolicyValue(cliUser, cliPrincipal)).toBe(true);
    expect(userMatchesPolicyValue(cliUser, cliUser.name)).toBe(true);
  });

  test("email writes stay canonical while name@ still matches as assigned", () => {
    const alice = makeUser({ name: "alice", email: "alice@example.com" });
    const principal = policyPrincipalForUser(alice);
    expect(principal).toBe("alice@example.com");
    expect(userPolicyPrincipals(alice)).toEqual(["alice@example.com", "alice", "alice@"]);
    expect(userMatchesPolicyValue(alice, "alice@")).toBe(true);

    let state = emptyState();
    state = upsertTagOwner(state, createTagOwner("tag:issue7-mail", [toMemberRef(principal)]));
    expect(serializePolicy(state).tagOwners).toEqual({ "tag:issue7-mail": ["alice@example.com"] });
  });

  test("name that already contains @ is not double-suffixed in serializePolicy", () => {
    const user = makeUser({ name: "alice@idp.example", email: "" });
    const principal = policyPrincipalForUser(user);
    expect(principal).toBe("alice@idp.example");
    let state = emptyState();
    state = upsertTagOwner(state, createTagOwner("tag:issue7-idp", [toMemberRef(principal)]));
    expect(serializePolicy(state).tagOwners).toEqual({ "tag:issue7-idp": ["alice@idp.example"] });
  });

  test("picker skips an already assigned CLI name@ without duplicating serializePolicy src", () => {
    const cliUser = makeUser({ name: "acl-cli", email: "" });
    const principal = policyPrincipalForUser(cliUser);
    expect(userPickerOptionValues([cliUser], [principal])).toEqual([]);
    expect(userPickerOptionValues([cliUser], [cliUser.name])).toEqual([]);
    expect(userMatchesPolicyValue(cliUser, principal)).toBe(true);
    expect(userMatchesPolicyValue(cliUser, cliUser.name)).toBe(true);
  });
});
