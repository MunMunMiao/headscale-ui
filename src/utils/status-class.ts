import type { HeadscaleNode, PreAuthKey } from "@/api/contracts";
import {
  isTimestampExpired as isExpired,
  nodeConnectionStatus,
} from "@/domain/node-status";
import { registrationKeyStatus } from "@/domain/tag-lifecycle";

export function isExitRoute(route: string): boolean {
  return route === "0.0.0.0/0" || route === "::/0";
}

/* ----------------------------------------------------------------------------
 * Palette table — every status badge in the app picks one of these triplets.
 * Listing them once next to each other makes mismatches and dark-mode drift
 * obvious at a glance. Functions below are thin selectors over this table.
 * -------------------------------------------------------------------------- */

const PALETTES = {
  emerald:
    "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300",
  rose: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300",
  slate:
    "border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-300",
  slateMuted:
    "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-300",
  sky: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-300",
  teal: "border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-900/60 dark:bg-teal-950/40 dark:text-teal-300",
  violet:
    "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900/60 dark:bg-violet-950/40 dark:text-violet-300",
  amber:
    "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300",
  cyan: "border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-900/60 dark:bg-cyan-950/40 dark:text-cyan-300",
  fuchsia:
    "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700 dark:border-fuchsia-900/60 dark:bg-fuchsia-950/40 dark:text-fuchsia-300",
  pink: "border-pink-200 bg-pink-50 text-pink-700 dark:border-pink-900/60 dark:bg-pink-950/40 dark:text-pink-300",
  indigo:
    "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-900/60 dark:bg-indigo-950/40 dark:text-indigo-300",
} as const;

export function nodeStatusClass(node: HeadscaleNode): string {
  const status = nodeConnectionStatus(node);
  return status === "online"
    ? PALETTES.emerald
    : status === "expired"
      ? PALETTES.rose
      : PALETTES.slate;
}

export function keyStatusClass(key: PreAuthKey): string {
  return {
    available: PALETTES.emerald,
    exhausted: PALETTES.sky,
    expired: PALETTES.rose,
    unknown: PALETTES.amber,
    deleted: PALETTES.slate,
  }[registrationKeyStatus(key).registration];
}

export function apiKeyStatusClass(key: { expiration?: string | null }): string {
  return isExpired(key.expiration) ? PALETTES.rose : PALETTES.emerald;
}

export function keyKindClass(key: PreAuthKey): string {
  return key.reusable ? PALETTES.teal : PALETTES.violet;
}

export function keyEphemeralClass(): string {
  return PALETTES.amber;
}

export function approvedRouteClass(): string {
  return PALETTES.emerald;
}

export function pendingRouteClass(route: string): string {
  return isExitRoute(route) ? PALETTES.rose : PALETTES.amber;
}

/**
 * Tag → palette mapping, walked top-to-bottom. First matching keyword wins.
 * Device variant adds workstation/desktop & database synonyms; auth-key variant
 * keeps a narrower set so the badge palette doesn't get too noisy.
 */
const DEVICE_TAG_RULES: ReadonlyArray<readonly [readonly string[], string]> = [
  [["server"], PALETTES.cyan],
  [["workstation", "desktop"], PALETTES.fuchsia],
  [["mobile", "phone"], PALETTES.pink],
  [["db", "database"], PALETTES.indigo],
];

const KEY_TAG_RULES: ReadonlyArray<readonly [readonly string[], string]> = [
  [["server"], PALETTES.cyan],
  [["mobile"], PALETTES.pink],
  [["db"], PALETTES.indigo],
];

function matchTag(
  tag: string,
  rules: typeof DEVICE_TAG_RULES,
  fallback: string,
): string {
  const lowered = tag.toLowerCase();
  for (const [keywords, palette] of rules) {
    if (keywords.some((kw) => lowered.includes(kw))) return palette;
  }
  return fallback;
}

export function deviceTagClass(tag: string): string {
  return matchTag(tag, DEVICE_TAG_RULES, PALETTES.emerald);
}

export function keyTagClass(tag: string): string {
  return matchTag(tag, KEY_TAG_RULES, PALETTES.slateMuted);
}
