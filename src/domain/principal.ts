import type { HeadscaleUser } from "@/api/contracts";

export type Principal = string & { readonly __brand: "Principal" };

export function toPrincipal(raw: string): Principal {
  return raw.trim() as Principal;
}

// Headscale 0.29.4 removes exactly one trailing @, even when it is part of the identity.
function withUserSuffix(value: string): string {
  return value.includes("@") && !value.endsWith("@") ? value : `${value}@`;
}

/** The principal that refers to a user by name (`name@`), or "" for a blank name. */
export function userNamePrincipal(name: string): string {
  const value = name.trim();
  return value ? withUserSuffix(value) : "";
}

type PolicyUser = Pick<HeadscaleUser, "name" | "email" | "providerId"> &
  Partial<Pick<HeadscaleUser, "id">>;

export function policyPrincipalForUser(
  user: PolicyUser,
  users?: readonly PolicyUser[],
): string {
  for (const raw of [user.email, user.name, user.providerId]) {
    const value = raw?.trim();
    if (!value) continue;
    const principal = withUserSuffix(value);
    if (userMatchesPolicyValue(user, principal, users)) return principal;
  }
  return "";
}

export function userPolicyPrincipals(
  user: PolicyUser,
  users?: readonly PolicyUser[],
): string[] {
  const values: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const value = raw.trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    values.push(value);
  };

  for (const raw of [user.email, user.name, user.providerId]) {
    const value = raw?.trim();
    if (!value) continue;
    // A raw trailing @ belongs to another identity after Headscale strips it.
    if (!value.endsWith("@")) add(value);
    add(`${value}@`);
  }
  return values.filter((value) => userMatchesPolicyValue(user, value, users));
}

export function userMatchesPolicyValue(
  user: PolicyUser,
  value: string,
  users: readonly PolicyUser[] = [user],
): boolean {
  const needle = value.trim().replace(/@$/, "");
  if (!needle) return false;
  // A retained rename/delete target replaces its newer snapshot record, not a second user.
  const candidates = [
    user,
    ...users.filter(
      (candidate) =>
        candidate !== user && (!user.id || candidate.id !== user.id),
    ),
  ];
  const provider = candidates.find(
    (candidate) => candidate.providerId?.trim() === needle,
  );
  if (provider) return provider === user;
  const matches = candidates.filter(
    (candidate) =>
      candidate.email?.trim() === needle || candidate.name.trim() === needle,
  );
  return matches.length === 1 && matches[0] === user;
}

export interface UserCreationPrincipalConflict {
  field: "name" | "email";
  principal: string;
}

export function userCreationPrincipalConflict(
  candidate: Pick<HeadscaleUser, "name" | "email">,
  users: readonly HeadscaleUser[],
): UserCreationPrincipalConflict | null {
  const pending: PolicyUser = {
    name: candidate.name.trim(),
    email: candidate.email?.trim() ?? "",
    providerId: "",
  };
  const next = [...users, pending];
  for (const user of users) {
    for (const principal of userPolicyPrincipals(user, users)) {
      if (!userMatchesPolicyValue(user, principal, next)) {
        const identifier = principal.trim().replace(/@$/, "");
        return {
          field: pending.email === identifier ? "email" : "name",
          principal,
        };
      }
    }
  }
  return null;
}

export class PrincipalIndex {
  private readonly known = new Set<string>();

  constructor(values: Iterable<string>) {
    for (const v of values) {
      const value = v.trim();
      if (value) this.known.add(value);
    }
  }

  static fromUsers(users: readonly HeadscaleUser[]): PrincipalIndex {
    const values: string[] = [];
    for (const user of users) {
      const email = user.email?.trim();
      if (email) values.push(email);
      const name = user.name.trim();
      if (name) values.push(name);
      const providerId = user.providerId?.trim();
      if (providerId) values.push(providerId);
    }
    return new PrincipalIndex(values);
  }

  has(value: string): boolean {
    return this.known.has(value.trim().replace(/@$/, ""));
  }
}
