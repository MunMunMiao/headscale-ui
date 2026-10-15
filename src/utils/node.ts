import type { HeadscaleNode } from "@/api/contracts";
import { nodeConnectionStatus } from "@/domain/node-status";
import { isExitRoute } from "./status-class";
import { hasVisibleUser, userLabel } from "./user";

export function nodeDisplayName(node: HeadscaleNode): string {
  return node.givenName || node.name;
}

/** Tags as an admin types them: separated by commas, spaces or newlines. */
export function parseNodeTags(value: string): string[] {
  return value.split(/[\s,]+/).filter(Boolean);
}

/** Headscale only accepts `tag:` followed by a name. */
export function isNodeTag(tag: string): boolean {
  return tag.startsWith("tag:") && tag.length > "tag:".length;
}

// Headscale stores a machine name as one DNS label.
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export function isValidNodeName(name: string): boolean {
  return DNS_LABEL.test(name);
}

/** Routes the node has advertised but the admin hasn't approved yet. */
export function nodePendingRoutes(node: HeadscaleNode): string[] {
  return node.availableRoutes.filter((route) => !node.approvedRoutes.includes(route));
}

/**
 * Approved routes to submit when revoking `route`. Headscale's SetApprovedRoutes re-adds both
 * exit prefixes when either is submitted, so exit routes can only be revoked as a pair.
 */
export function nodeRevocationTargets(node: HeadscaleNode, route: string): string[] {
  return node.approvedRoutes.filter((r) => r === route || (isExitRoute(route) && isExitRoute(r)));
}

/**
 * Owner label for a node, "" if owner is the tag-managed pseudo-user or missing.
 * The fallback string is only used when there is a visible user but no readable name.
 */
export function nodeOwner(node: HeadscaleNode, unknownFallback: string): string {
  if (!hasVisibleUser(node.user)) return "";
  return userLabel(node.user, unknownFallback);
}

export interface NodeStatusLabels {
  online: string;
  offline: string;
  expired: string;
}

export function nodeStatusLabel(node: HeadscaleNode, labels: NodeStatusLabels): string {
  const status = nodeConnectionStatus(node);
  return labels[status];
}
