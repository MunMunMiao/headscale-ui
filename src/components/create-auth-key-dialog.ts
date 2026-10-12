import type { ProductCopy } from "@/i18n/product-copy";

export interface AuthKeyDialogUserOption {
  id: string;
  label: string;
}

export type AuthKeyDialogDefaults = {
  user: string;
  reusable: boolean;
  ephemeral: boolean;
  aclTags: string;
};

export interface AuthKeyDialogPayload {
  /** Absent for an owner-less, tag-only key. */
  user?: string;
  reusable: boolean;
  ephemeral: boolean;
  expiration: string;
  aclTags: string[];
}

export interface AuthKeyDialogLabels {
  title: string;
  description: string;
  owner: string;
  expiration: string;
  aclTags: string;
  reusable: string;
  ephemeral: string;
  cancel: string;
  submit: string;
  time: string;
  hour: string;
  minute: string;
}

export function isoToDateTimeLocal(value: string) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localDate.toISOString().slice(0, 16);
}

export function dateTimeLocalToIso(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toISOString();
}

export const AUTH_KEY_EXPIRY_DAYS = 7;
export const API_KEY_EXPIRY_DAYS = 90;

export function defaultExpirationLocal(days: number, now = Date.now()) {
  return isoToDateTimeLocal(new Date(now + days * 86_400_000).toISOString());
}

export function isFutureExpiration(local: string, now = Date.now()) {
  return new Date(local).getTime() > now;
}

export function toAuthKeyDefaults(payload: AuthKeyDialogPayload): AuthKeyDialogDefaults {
  return {
    user: payload.user ?? "",
    reusable: payload.reusable,
    ephemeral: payload.ephemeral,
    aclTags: payload.aclTags.join(", "),
  };
}

export function authKeyDialogLabels(copy: ProductCopy): AuthKeyDialogLabels {
  return {
    title: copy.createInvite,
    description: copy.invitesSubtitle,
    owner: copy.inviteOwner,
    expiration: copy.inviteExpiration,
    aclTags: copy.aclTags,
    reusable: copy.reusable,
    ephemeral: copy.ephemeral,
    cancel: copy.cancel,
    submit: copy.createInvite,
    time: copy.time,
    hour: copy.hour,
    minute: copy.minute,
  };
}
