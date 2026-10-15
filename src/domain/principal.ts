import type { HeadscaleUser } from "@/api/contracts";

export type Principal = string & { readonly __brand: "Principal" };

export function toPrincipal(raw: string): Principal {
  return raw.trim().toLowerCase() as Principal;
}

// Callers pass a trimmed, non-empty identifier.
function withUserSuffix(value: string): string {
  return value.includes("@") ? value : `${value}@`;
}

/** The principal that refers to a user by name (`name@`), or "" for a blank name. */
export function userNamePrincipal(name: string): string {
  const value = name.trim();
  return value ? withUserSuffix(value) : "";
}

export function policyPrincipalForUser(
  user: Pick<HeadscaleUser, "name" | "email" | "providerId">,
): string {
  const email = user.email?.trim();
  if (email) return withUserSuffix(email);
  const name = user.name.trim();
  if (name) return withUserSuffix(name);
  const providerId = user.providerId?.trim();
  if (providerId) return withUserSuffix(providerId);
  return "";
}

export function userPolicyPrincipals(
  user: Pick<HeadscaleUser, "name" | "email" | "providerId">,
): string[] {
  const values: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const value = raw.trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    values.push(value);
  };

  const email = user.email?.trim();
  if (email) {
    add(email);
    add(withUserSuffix(email));
  }
  const name = user.name.trim();
  if (name) {
    add(name);
    add(withUserSuffix(name));
  }
  const providerId = user.providerId?.trim();
  if (providerId) {
    add(providerId);
    add(withUserSuffix(providerId));
  }
  return values;
}

export function userMatchesPolicyValue(
  user: Pick<HeadscaleUser, "name" | "email" | "providerId">,
  value: string,
): boolean {
  const needle = value.trim();
  if (!needle) return false;
  return userPolicyPrincipals(user).includes(needle);
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
