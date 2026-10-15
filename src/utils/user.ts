import type { HeadscaleUser } from "@/api/contracts";

const TAG_MANAGED_USER_NAME = "tagged-devices";

export function isTagManagedDeviceUser(user?: HeadscaleUser | null): boolean {
  return user?.name === TAG_MANAGED_USER_NAME;
}

export function hasVisibleUser(user?: HeadscaleUser | null): user is HeadscaleUser {
  return Boolean(user && !isTagManagedDeviceUser(user));
}

export type UserNameIssue = "required" | "invalid" | "taken";

// Headscale accepts any name, but a policy cannot refer to one with whitespace or control characters.
const UNUSABLE_NAME_CHARACTER = /[\s\p{Cc}]/u;

/** Why a (trimmed) user name cannot be used; names match case-sensitively, as in Headscale. */
export function userNameIssue(
  name: string,
  users: readonly HeadscaleUser[],
  exceptId?: string,
): UserNameIssue | null {
  if (!name) return "required";
  if (UNUSABLE_NAME_CHARACTER.test(name)) return "invalid";
  if (users.some((user) => user.name === name && user.id !== exceptId)) return "taken";
  return null;
}

// ponytail: shape check only (x@y.z); the mail server is the real validator.
export function isEmailLike(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function userLabel(user: HeadscaleUser | null | undefined, fallback: string): string {
  return user?.displayName || user?.name || user?.email || fallback;
}
