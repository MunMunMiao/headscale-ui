import { describe, expect, test } from "vitest";
import type { HeadscaleUser } from "@/api/contracts";
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
  userCreationPrincipalConflict,
  userMatchesPolicyValue,
  userNamePrincipal,
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
    if (selectedValues.some((value) => userMatchesPolicyValue(user, value)))
      continue;
    opts.push(id);
  }
  return opts;
}

describe("toPrincipal", () => {
  test("trims whitespace without changing case", () => {
    expect(toPrincipal("  Alice@Example.COM  ")).toBe("Alice@Example.COM");
    expect(toPrincipal("Bob")).toBe("Bob");
  });

  test("keeps case-distinct groups independently selectable", () => {
    const selected = new Set([toPrincipal(" group:Ops ")]);
    expect(selected.has(toPrincipal("group:Ops"))).toBe(true);
    expect(selected.has(toPrincipal("group:ops"))).toBe(false);
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

  test("fromUsers mirrors Headscale suffix resolution and exact provider identifiers", () => {
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

describe("Headscale 0.29.4 identity resolution", () => {
  test("keeps alice and the legal name alice@ distinct when choosing or matching a principal", () => {
    const alice = makeUser({ id: "1", name: "alice" });
    const trailingAt = makeUser({ id: "2", name: "alice@" });
    expect(policyPrincipalForUser(alice)).toBe("alice@");
    expect(policyPrincipalForUser(trailingAt)).toBe("alice@@");
    expect(userNamePrincipal("alice@")).toBe("alice@@");
    expect(userMatchesPolicyValue(trailingAt, "alice@")).toBe(false);
    expect(userMatchesPolicyValue(trailingAt, "alice@@")).toBe(true);
    expect(userMatchesPolicyValue(alice, "alice@@")).toBe(false);
    expect(
      userPickerOptionValues([alice, trailingAt], ["alice@"]).sort(),
    ).toEqual(["alice@@"]);
  });

  test.each([
    { name: "alice@corp" },
    { email: "alice@example.com" },
    { providerId: "https://idp.example/Subject@corp" },
  ])(
    "matches both spellings of an internal-@ identity %j without changing case",
    (fields) => {
      const user = makeUser(fields);
      const raw = Object.values(fields)[0];
      expect(userMatchesPolicyValue(user, raw)).toBe(true);
      expect(userMatchesPolicyValue(user, `${raw}@`)).toBe(true);
      expect(userMatchesPolicyValue(user, `${raw}@@`)).toBe(false);
      expect(userMatchesPolicyValue(user, `${raw.toUpperCase()}@`)).toBe(false);
    },
  );

  test("a provider identifier takes precedence over another account's name or email", () => {
    const local = makeUser({
      id: "1",
      name: "alice",
      email: "shared@example.com",
    });
    const oidc = makeUser({
      id: "2",
      name: "oidc-alice",
      providerId: "shared@example.com",
    });
    const users = [local, oidc];
    expect(userMatchesPolicyValue(local, "shared@example.com@", users)).toBe(
      false,
    );
    expect(userMatchesPolicyValue(oidc, "shared@example.com@", users)).toBe(
      true,
    );
    expect(policyPrincipalForUser(local, users)).toBe("alice@");
    expect(userPolicyPrincipals(local, users)).not.toContain(
      "shared@example.com",
    );
    expect(userPolicyPrincipals(oidc, users)).toContain("shared@example.com@");
  });

  test("ambiguous email/name aliases cannot assign or clean up either account", () => {
    const first = makeUser({
      id: "1",
      name: "first",
      email: "shared@example.com",
    });
    const second = makeUser({ id: "2", name: "shared@example.com" });
    const users = [first, second];
    expect(userMatchesPolicyValue(first, "shared@example.com", users)).toBe(
      false,
    );
    expect(userMatchesPolicyValue(second, "shared@example.com@", users)).toBe(
      false,
    );
    expect(policyPrincipalForUser(first, users)).toBe("first@");
    expect(policyPrincipalForUser(second, users)).toBe("");
    // An ambiguous identity exists; it must not be mislabelled a deleted user for orphan cleanup.
    expect(PrincipalIndex.fromUsers(users).has("shared@example.com@")).toBe(
      true,
    );
  });

  test.each([
    { email: "alice@example.com@" },
    { providerId: "https://idp.example/Subject@" },
  ])(
    "encodes an identity ending in @ without consuming its literal suffix %j",
    (fields) => {
      const user = makeUser(fields);
      const raw = Object.values(fields)[0];
      expect(policyPrincipalForUser(user)).toBe(`${raw}@`);
      expect(userMatchesPolicyValue(user, raw)).toBe(false);
      expect(userMatchesPolicyValue(user, `${raw}@`)).toBe(true);
    },
  );
});

describe("Headscale 0.29.4 identity resolution", () => {
  test("keeps alice and the legal name alice@ distinct when encoding and matching", () => {
    const alice = makeUser({ id: "1", name: "alice" });
    const suffixed = makeUser({ id: "2", name: "alice@" });
    expect(policyPrincipalForUser(alice)).toBe("alice@");
    expect(policyPrincipalForUser(suffixed)).toBe("alice@@");
    expect(userNamePrincipal(suffixed.name)).toBe("alice@@");
    expect(userPolicyPrincipals(suffixed)).toEqual(["alice@@"]);
    expect(userMatchesPolicyValue(suffixed, "alice@")).toBe(false);
    expect(userMatchesPolicyValue(suffixed, "alice@@")).toBe(true);
    expect(userMatchesPolicyValue(alice, "alice@@")).toBe(false);
    expect(PrincipalIndex.fromUsers([suffixed]).has("alice@")).toBe(false);
    expect(PrincipalIndex.fromUsers([suffixed]).has("alice@@")).toBe(true);
  });

  test.each([
    [{ name: "ops@corp" }, "ops@corp", "ops@corp@"],
    [{ email: "alice@example.com" }, "alice@example.com", "alice@example.com@"],
    [
      { providerId: "https://idp.example/Subject" },
      "https://idp.example/Subject",
      "https://idp.example/Subject@",
    ],
    [{ providerId: "urn:subject@idp" }, "urn:subject@idp", "urn:subject@idp@"],
  ])(
    "recognizes both suffix forms of %j without folding case",
    (fields, bare, suffixed) => {
      const user = makeUser(fields);
      expect(userPolicyPrincipals(user)).toContain(bare);
      expect(userPolicyPrincipals(user)).toContain(suffixed);
      expect(userMatchesPolicyValue(user, ` ${suffixed} `)).toBe(true);
      expect(userMatchesPolicyValue(user, `${suffixed}@`)).toBe(false);
      expect(userMatchesPolicyValue(user, suffixed.toUpperCase())).toBe(false);
    },
  );

  test("does not strip the identifier's own trailing @ from email or providerId", () => {
    for (const fields of [
      { email: "alice@example.com@" },
      { providerId: "urn:subject@" },
    ]) {
      const user = makeUser(fields);
      const value = "email" in fields ? fields.email : fields.providerId;
      expect.assert(value);
      expect(policyPrincipalForUser(user)).toBe(`${value}@`);
      expect(userMatchesPolicyValue(user, value)).toBe(false);
      expect(userMatchesPolicyValue(user, `${value}@`)).toBe(true);
    }
  });

  test("a provider identifier takes precedence over another user's name or email", () => {
    const local = makeUser({
      id: "1",
      name: "alice",
      email: "shared@example.com",
    });
    const oidc = makeUser({
      id: "2",
      name: "oidc-user",
      providerId: "shared@example.com",
    });
    const users = [local, oidc];
    expect(userMatchesPolicyValue(local, "shared@example.com@", users)).toBe(
      false,
    );
    expect(userMatchesPolicyValue(oidc, "shared@example.com@", users)).toBe(
      true,
    );
    expect(policyPrincipalForUser(local, users)).toBe("alice@");
    expect(userPolicyPrincipals(local, users)).toEqual(["alice", "alice@"]);
  });

  test("ambiguous name/email aliases are not assigned to either user", () => {
    const alice = makeUser({
      id: "1",
      name: "alice",
      email: "shared@example.com",
    });
    const bob = makeUser({ id: "2", name: "bob", email: "shared@example.com" });
    const users = [alice, bob];
    expect(userMatchesPolicyValue(alice, "shared@example.com", users)).toBe(
      false,
    );
    expect(userMatchesPolicyValue(bob, "shared@example.com@", users)).toBe(
      false,
    );
    expect(policyPrincipalForUser(alice, users)).toBe("alice@");
    expect(policyPrincipalForUser(bob, users)).toBe("bob@");
    expect(policyPrincipalForUser({ ...alice, name: "" }, users)).toBe("");
  });

  test("recognizes a retained rename/delete target without confusing its current snapshot record", () => {
    const old = makeUser({ id: "1", name: "alice@" });
    expect(
      userPolicyPrincipals(old, [makeUser({ id: "1", name: "new-name" })]),
    ).toEqual(["alice@@"]);
    expect(userPolicyPrincipals(old, [])).toEqual(["alice@@"]);
  });
});

describe("policyPrincipalForUser", () => {
  test("appends @ for CLI usernames that have no email", () => {
    expect(
      policyPrincipalForUser(makeUser({ name: "test-user", email: "" })),
    ).toBe("test-user@");
    expect(policyPrincipalForUser(makeUser({ name: "admin-test" }))).toBe(
      "admin-test@",
    );
  });

  test("prefers email when present and leaves emails unchanged", () => {
    expect(
      policyPrincipalForUser(
        makeUser({ email: "alice@example.com", name: "alice" }),
      ),
    ).toBe("alice@example.com");
  });

  test("keeps OIDC names that already contain @", () => {
    expect(
      policyPrincipalForUser(
        makeUser({ email: "", name: "alice@idp.example" }),
      ),
    ).toBe("alice@idp.example");
  });

  test("appends @ to a non-email identifier that Headscale still requires", () => {
    expect(
      policyPrincipalForUser(
        makeUser({ email: "not-an-email", name: "alice" }),
      ),
    ).toBe("not-an-email@");
  });

  test("skips blank fields and trims the chosen identifier", () => {
    expect(
      policyPrincipalForUser(makeUser({ email: "   ", name: "  alice  " })),
    ).toBe("alice@");
    expect(
      policyPrincipalForUser(
        makeUser({ email: " ", name: " ", providerId: " " }),
      ),
    ).toBe("");
  });

  test("falls back to providerId when name and email are empty", () => {
    expect(
      policyPrincipalForUser(
        makeUser({
          name: "",
          email: "",
          providerId: "https://idp.example/Sub",
        }),
      ),
    ).toBe("https://idp.example/Sub@");
    expect(
      policyPrincipalForUser(
        makeUser({ name: "", email: "", providerId: "user@idp" }),
      ),
    ).toBe("user@idp");
  });

  test("returns empty when the user has no usable identifier", () => {
    expect(
      policyPrincipalForUser(makeUser({ name: "", email: "", providerId: "" })),
    ).toBe("");
    expect(policyPrincipalForUser(makeUser({ name: "  ", email: "  " }))).toBe(
      "",
    );
  });
});

describe("userNamePrincipal", () => {
  test("suffixes a plain name once and keeps names that already contain @", () => {
    expect(userNamePrincipal(" alice ")).toBe("alice@");
    expect(userNamePrincipal("alice@corp.com")).toBe("alice@corp.com");
  });

  test("is empty for a blank name", () => {
    expect(userNamePrincipal("  ")).toBe("");
  });
});

describe("userPolicyPrincipals / userMatchesPolicyValue", () => {
  test("recognizes provider-only identities and deduplicates shared aliases without changing case", () => {
    const providerOnly = makeUser({
      providerId: " https://idp.example/Subject ",
    });
    expect(userPolicyPrincipals(providerOnly)).toEqual([
      "https://idp.example/Subject",
      "https://idp.example/Subject@",
    ]);
    expect(
      userMatchesPolicyValue(providerOnly, "https://idp.example/Subject@"),
    ).toBe(true);
    expect(
      userMatchesPolicyValue(providerOnly, "https://idp.example/subject@"),
    ).toBe(false);
    expect(
      userPolicyPrincipals(makeUser({ name: "alice", providerId: "alice" })),
    ).toEqual(["alice", "alice@"]);
  });
  test("includes name and name@ so existing tagOwners round-trip", () => {
    expect(
      userPolicyPrincipals(makeUser({ name: "test-user", email: "" })),
    ).toEqual(["test-user", "test-user@"]);
    expect(
      userMatchesPolicyValue(
        makeUser({ name: "test-user", email: "" }),
        "test-user@",
      ),
    ).toBe(true);
    expect(
      userMatchesPolicyValue(
        makeUser({ name: "test-user", email: "" }),
        "test-user",
      ),
    ).toBe(true);
  });

  test("matches both email and name@ aliases for a user that has both", () => {
    const alice = makeUser({ email: "alice@example.com", name: "alice" });
    expect(userPolicyPrincipals(alice)).toEqual([
      "alice@example.com",
      "alice@example.com@",
      "alice",
      "alice@",
    ]);
    expect(userMatchesPolicyValue(alice, "alice@example.com")).toBe(true);
    expect(userMatchesPolicyValue(alice, "alice@")).toBe(true);
    expect(userMatchesPolicyValue(alice, "ghost@")).toBe(false);
  });

  test("does not treat whitespace as a match", () => {
    expect(userMatchesPolicyValue(makeUser({ name: "alice" }), "  ")).toBe(
      false,
    );
    expect(userMatchesPolicyValue(makeUser({ name: "alice" }), "")).toBe(false);
  });
});

describe("userCreationPrincipalConflict", () => {
  test("allows an omitted email and an empty directory", () => {
    expect(userCreationPrincipalConflict({ name: "carol" }, [])).toBeNull();
    expect(
      userCreationPrincipalConflict({ name: "carol" }, [
        makeUser({ name: "alice" }),
      ]),
    ).toBeNull();
  });

  test.each([
    [
      "alice-copy",
      "alice@example.test",
      { field: "email", principal: "alice@example.test" },
    ],
    [
      "alice@example.test",
      "bob@example.test",
      { field: "name", principal: "alice@example.test" },
    ],
    ["carol", "alice", { field: "email", principal: "alice" }],
    ["alice", "", { field: "name", principal: "alice" }],
    [
      "  carol  ",
      "  alice@example.test  ",
      { field: "email", principal: "alice@example.test" },
    ],
    ["carol", "carol@example.test", null],
    ["carol", "", null],
    ["Alice", "Alice@example.test", null],
    ["alice@", "alice@example.test@", null],
  ] as const)(
    "checks candidate %s / %s without changing existing owners",
    (name, email, expected) => {
      const users = [
        makeUser({ id: "1", name: "alice", email: "alice@example.test" }),
      ];
      expect(userCreationPrincipalConflict({ name, email }, users)).toEqual(
        expected,
      );
    },
  );

  test.each(["name", "email"] as const)(
    "keeps an existing provider's precedence over a new %s alias",
    (field) => {
      const users = [
        makeUser({ id: "1", name: "local", email: "shared@example.test" }),
        makeUser({
          id: "2",
          name: "oidc-user",
          providerId: "shared@example.test",
        }),
      ];
      expect(
        userCreationPrincipalConflict(
          { name: "carol", email: "", [field]: "shared@example.test" },
          users,
        ),
      ).toBeNull();
    },
  );

  test.each(["", "shared@example.test"])(
    "does not rewrite or globally block an already ambiguous directory for email %s",
    (email) => {
      const users = [
        makeUser({ id: "1", name: "alice", email: "shared@example.test" }),
        makeUser({ id: "2", name: "shared@example.test" }),
      ];
      const before = structuredClone(users);
      expect(
        userCreationPrincipalConflict({ name: "carol", email }, users),
      ).toBeNull();
      expect(users).toEqual(before);
    },
  );

  test("strips exactly one policy suffix when identifying the conflicting field", () => {
    const users = [
      makeUser({ id: "1", name: "alice@", email: "alice@example.test@" }),
    ];
    expect(
      userCreationPrincipalConflict(
        { name: "alice", email: "alice@example.test" },
        users,
      ),
    ).toBeNull();
    expect(
      userCreationPrincipalConflict(
        { name: "carol", email: "alice@example.test@" },
        users,
      ),
    ).toEqual({
      field: "email",
      principal: "alice@example.test@@",
    });
    expect(
      userCreationPrincipalConflict({ name: "alice@", email: "" }, users),
    ).toEqual({
      field: "name",
      principal: "alice@@",
    });
  });

  test("does not modify either the candidate or the existing users", () => {
    const candidate = Object.freeze({
      name: "  carol  ",
      email: "  alice@example.test  ",
    });
    const users = Object.freeze([
      Object.freeze(
        makeUser({ id: "1", name: " alice ", email: " alice@example.test " }),
      ),
    ]);
    expect(userCreationPrincipalConflict(candidate, users)).toEqual({
      field: "email",
      principal: "alice@example.test",
    });
    expect(candidate).toEqual({
      name: "  carol  ",
      email: "  alice@example.test  ",
    });
    expect(users[0]).toMatchObject({
      name: " alice ",
      email: " alice@example.test ",
    });
  });
});

describe("issue #7 picker, orphans, and serializePolicy", () => {
  test("userPickerOptions skip tagged-devices even if the helper would suffix it", () => {
    const tagged = makeUser({
      name: "tagged-devices",
      email: "",
      provider: "system",
    });
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
      createTagOwner("tag:issue7", [
        toMemberRef("deleted-user@"),
        toMemberRef(cliPrincipal),
      ]),
    );
    state = upsertGroup(
      state,
      createGroup("group:issue7", [
        toMemberRef("deleted-user@"),
        toMemberRef(cliPrincipal),
      ]),
    );

    const orphans = findOrphanReferences(state, index);
    expect(
      orphans.map((item) => ({ kind: item.kind, value: item.value })),
    ).toEqual([
      { kind: "group-member", value: "deleted-user@" },
      { kind: "tag-owner", value: "deleted-user@" },
    ]);
    expect(index.has("deleted-user@")).toBe(false);
    expect(index.has(cliPrincipal)).toBe(true);

    const principals = userPolicyPrincipals(cliUser);
    expect(principals).toContain(cliUser.name);
    expect(principals).toContain(cliPrincipal);
    expect(
      state.tagOwners[0]?.owners.some((owner) =>
        principals.includes(owner.value),
      ),
    ).toBe(true);
    expect(
      state.groups[0]?.members.some((member) =>
        principals.includes(member.value),
      ),
    ).toBe(true);
    expect(userMatchesPolicyValue(cliUser, cliPrincipal)).toBe(true);
    expect(userMatchesPolicyValue(cliUser, cliUser.name)).toBe(true);
  });

  test("email writes stay canonical while name@ still matches as assigned", () => {
    const alice = makeUser({ name: "alice", email: "alice@example.com" });
    const principal = policyPrincipalForUser(alice);
    expect(principal).toBe("alice@example.com");
    expect(userPolicyPrincipals(alice)).toEqual([
      "alice@example.com",
      "alice@example.com@",
      "alice",
      "alice@",
    ]);
    expect(userMatchesPolicyValue(alice, "alice@")).toBe(true);

    let state = emptyState();
    state = upsertTagOwner(
      state,
      createTagOwner("tag:issue7-mail", [toMemberRef(principal)]),
    );
    expect(serializePolicy(state).tagOwners).toEqual({
      "tag:issue7-mail": ["alice@example.com"],
    });
  });

  test("name that already contains @ is not double-suffixed in serializePolicy", () => {
    const user = makeUser({ name: "alice@idp.example", email: "" });
    const principal = policyPrincipalForUser(user);
    expect(principal).toBe("alice@idp.example");
    let state = emptyState();
    state = upsertTagOwner(
      state,
      createTagOwner("tag:issue7-idp", [toMemberRef(principal)]),
    );
    expect(serializePolicy(state).tagOwners).toEqual({
      "tag:issue7-idp": ["alice@idp.example"],
    });
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
