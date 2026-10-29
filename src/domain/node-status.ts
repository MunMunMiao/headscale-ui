import type { HeadscaleNode } from "@/api/contracts";

export type NodeConnectionStatus = "online" | "offline" | "expired";

export function isTimestampExpired(value?: string | null, now = Date.now()) {
  return Boolean(value && Date.parse(value) < now);
}

export function nodeConnectionStatus(
  node: Pick<HeadscaleNode, "online" | "expiry">,
  now = Date.now(),
): NodeConnectionStatus {
  if (node.online) {
    return "online";
  }

  if (isTimestampExpired(node.expiry, now)) {
    return "expired";
  }

  return "offline";
}

const MAX_TIMER_MS = 2 ** 31 - 1;

/** Delay until the nearest expiry instant has passed (expired means `t < now`), or null when none is ahead. */
export function msUntilNextExpiry(
  values: Iterable<string | null | undefined>,
  now: number,
): number | null {
  let nearest = Number.POSITIVE_INFINITY;
  for (const value of values) {
    const time = value ? Date.parse(value) : Number.NaN;
    if (time >= now && time < nearest) nearest = time;
  }
  return Number.isFinite(nearest)
    ? Math.min(nearest - now + 1, MAX_TIMER_MS)
    : null;
}
