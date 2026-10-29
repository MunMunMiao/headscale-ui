import { parse as parseJsonc } from "jsonc-parser";
import type { HeadscaleNode, PolicyReading, PreAuthKey } from "@/api/contracts";
import { isNodeTag } from "@/utils/node";
import { isTimestampExpired } from "./node-status";
import {
  isPolicyIdentityName,
  type PolicyDesignerState,
  parsePolicy,
} from "./policy-designer";
import { policyAliases, retargetUserReferences } from "./policy-references";

export type TagReadState = "ready" | "loading" | "error" | "unknown";
export type TagReadStates = Record<
  "policy" | "fabric" | "identity",
  TagReadState
>;
export type TagSource = "definition" | "node" | "key" | "reference";
export type RegistrationKeyStatus = {
  registration: "available" | "exhausted" | "expired" | "deleted" | "unknown";
  oldDeployment: "possible" | "lookup-blocked" | "unknown";
};
export type TagKeyDependency = RegistrationKeyStatus & { id: string };
export interface TagObservation {
  tag: string;
  definition: "declared" | "undeclared" | "unknown";
  sources: TagSource[];
  nodeIds: string[];
  keys: TagKeyDependency[];
  referencePaths: string[];
  policyCompatible: boolean;
  deviceCompatible: boolean;
}
export interface TagInventory {
  tags: TagObservation[];
  assignableTags: string[];
  unknownSources: (keyof TagReadStates | "references")[];
  referenceIssues: string[];
}
export interface TagObservationInput {
  policy: PolicyReading | null;
  nodes: readonly HeadscaleNode[];
  preAuthKeys: readonly PreAuthKey[];
  readState?: TagReadStates;
  now?: number;
}
export interface NodeTagBaseline {
  nodeId: string;
  machineKey: string | null;
  user: { id: string; name: string } | null;
  tags: string[];
}
export interface TagOwnerDependency {
  principal: string;
  path: string[];
  kind: "direct" | "group" | "tag";
  cycle: boolean;
  missing: boolean;
}

export function assignableTagsFromPolicy(
  policy: PolicyReading | null,
): string[] {
  return parsePolicy(policy?.policy ?? "")
    .tagOwners.map((entry) => entry.tag)
    .filter(isNodeTag)
    .sort();
}

function referencePaths(state: PolicyDesignerState, raw: string) {
  const paths = new Map<string, string[]>();
  const aclPositions: { rule: number; destination: number }[] = [];
  const add = (value: unknown, path: string, withPort = false) => {
    if (typeof value !== "string") return;
    const tag = withPort ? value.slice(0, value.lastIndexOf(":")) : value;
    if (!tag.startsWith("tag:")) return;
    paths.set(tag, [...(paths.get(tag) ?? []), path]);
  };
  const list = (value: unknown, path: string, withPort = false) => {
    if (Array.isArray(value))
      value.forEach((item, index) => {
        add(item, `${path}[${index}]`, withPort);
      });
  };
  for (const group of state.groups)
    list(
      group.members.map((member) => member.value),
      `groups.${group.name}`,
    );
  for (const owner of state.tagOwners)
    list(
      owner.owners.map((member) => member.value),
      `tagOwners.${owner.tag}`,
    );
  if (!state.error) {
    // The designer expands multi-destination ACLs; source locations belong to the readback text.
    const acls: { src: string[]; dst: string[] }[] =
      parseJsonc(raw, undefined, { allowTrailingComma: true })?.acls ?? [];
    acls.forEach((rule, index) => {
      list(rule.src, `acls[${index}].src`);
      list(rule.dst, `acls[${index}].dst`, true);
      aclPositions.push(
        ...rule.dst.map((_, destination) => ({ rule: index, destination })),
      );
    });
  }
  const sections = {
    ssh: ["src", "dst"],
    grants: ["src", "dst", "via"],
    nodeAttrs: ["target"],
    tests: ["src", "accept", "deny"],
    sshTests: ["src", "dst"],
  };
  for (const [section, fields] of Object.entries(sections)) {
    const entries = state.extras[section];
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry: unknown, index) => {
      if (!entry || typeof entry !== "object") return;
      for (const field of fields) {
        const value = (entry as Record<string, unknown>)[field];
        const path = `${section}[${index}].${field}`;
        if (typeof value === "string") add(value, path);
        else list(value, path, section === "tests" && field !== "src");
      }
    });
  }
  const approvers = state.extras.autoApprovers;
  if (approvers && typeof approvers === "object") {
    const { routes, exitNode } = approvers as Record<string, unknown>;
    list(exitNode, "autoApprovers.exitNode");
    if (routes && typeof routes === "object")
      for (const [route, values] of Object.entries(routes))
        list(values, `autoApprovers.routes.${route}`);
  }
  return { paths, aclPositions };
}

/** A display projection of independent reads, not a transaction or a runtime-policy proof. */
export function observeTags(input: TagObservationInput): TagInventory {
  const policy = parsePolicy(input.policy?.policy ?? "");
  const reads = input.readState ?? {
    policy: input.policy ? "ready" : "unknown",
    fabric: "ready",
    identity: "ready",
  };
  const readable = input.policy !== null && !policy.error;
  const knownPolicy = readable && reads.policy === "ready";
  const { paths: references, aclPositions } = referencePaths(
    policy,
    input.policy?.policy ?? "",
  );
  const names = new Set(
    [...policyAliases(policy)].filter((name) => name.startsWith("tag:")),
  );
  for (const node of input.nodes) for (const tag of node.tags) names.add(tag);
  for (const key of input.preAuthKeys)
    for (const tag of key.aclTags) names.add(tag);
  // The existing reference transformer validates supported shapes without changing any aliases.
  const inspection = retargetUserReferences(policy, [], null);
  const referenceIssues = inspection.ok
    ? []
    : [
        ...new Set(
          inspection.issue.paths.map((path) =>
            path.replace(
              /^acls\[(\d+)\](\.dst\[0\])?/,
              (_match, index, destination) => {
                const original = aclPositions[Number(index)];
                return `acls[${original.rule}]${destination ? `.dst[${original.destination}]` : ""}`;
              },
            ),
          ),
        ),
      ];
  const unknownSources: TagInventory["unknownSources"] = [];
  for (const source of ["policy", "fabric", "identity"] as const)
    if (reads[source] !== "ready" || (source === "policy" && !readable))
      unknownSources.push(source);
  if (referenceIssues.length) unknownSources.push("references");
  return {
    tags: [...names].sort().map((tag) => {
      const declared = policy.tagOwners.some((entry) => entry.tag === tag);
      const nodeIds = input.nodes
        .filter((node) => node.tags.includes(tag))
        .map((node) => node.id);
      const keys = input.preAuthKeys
        .filter((key) => key.aclTags.includes(tag))
        .map((key) => ({
          id: key.id,
          ...registrationKeyStatus(
            reads.identity === "ready" ? key : null,
            input.now,
          ),
        }));
      const paths = references.get(tag) ?? [];
      const sources: TagSource[] = [];
      if (declared) sources.push("definition");
      if (nodeIds.length) sources.push("node");
      if (keys.length) sources.push("key");
      if (paths.length) sources.push("reference");
      return {
        tag,
        definition: knownPolicy
          ? declared
            ? ("declared" as const)
            : ("undeclared" as const)
          : ("unknown" as const),
        sources,
        nodeIds,
        keys,
        referencePaths: paths,
        policyCompatible: isPolicyIdentityName(tag, "tag"),
        deviceCompatible: isNodeTag(tag),
      };
    }),
    assignableTags: assignableTagsFromPolicy(input.policy),
    unknownSources,
    referenceIssues,
  };
}

export function registrationKeyStatus(
  key: Pick<PreAuthKey, "used" | "reusable" | "expiration"> | null,
  now = Date.now(),
  deleted = false,
): RegistrationKeyStatus {
  if (deleted)
    return { registration: "deleted", oldDeployment: "lookup-blocked" };
  if (!key) return { registration: "unknown", oldDeployment: "unknown" };
  const registration =
    key.expiration && !Number.isFinite(Date.parse(key.expiration))
      ? "unknown"
      : isTimestampExpired(key.expiration, now)
        ? "expired"
        : key.used && !key.reusable
          ? "exhausted"
          : "available";
  return { registration, oldDeployment: "possible" };
}

export function sameTagSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every((tag) => b.has(tag));
}

export function replaceTagInSet(
  tags: readonly string[],
  from: string,
  to: string,
): string[] {
  return [...new Set(tags.map((tag) => (tag === from ? to : tag)))];
}

export function tagSetDiff(
  before: readonly string[],
  after: readonly string[],
) {
  return {
    added: [...new Set(after)].filter((tag) => !before.includes(tag)),
    removed: [...new Set(before)].filter((tag) => !after.includes(tag)),
    unchanged: [...new Set(after)].filter((tag) => before.includes(tag)),
  };
}

export function nodeTagBaseline(node: HeadscaleNode): NodeTagBaseline {
  return {
    nodeId: node.id,
    machineKey: node.machineKey ?? null,
    user: node.user ? { id: node.user.id, name: node.user.name } : null,
    tags: [...node.tags],
  };
}

export function sameNodeTagBaseline(
  left: NodeTagBaseline,
  right: NodeTagBaseline,
): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.machineKey === right.machineKey &&
    left.user?.id === right.user?.id &&
    left.user?.name === right.user?.name &&
    sameTagSet(left.tags, right.tags)
  );
}

/** Visits declared edges once with representative paths; it does not enumerate paths or evaluate authorization. */
export function tagOwnerDependencies(
  state: PolicyDesignerState,
  tag: string,
): TagOwnerDependency[] {
  const result: TagOwnerDependency[] = [];
  const expanded = new Set([tag]);
  const walk = (
    principal: string,
    path: string[],
    kind: TagOwnerDependency["kind"],
  ) => {
    const group = principal.startsWith("group:");
    const nested = principal.startsWith("tag:");
    const members = group
      ? state.groups.find((entry) => entry.name === principal)?.members
      : nested
        ? state.tagOwners.find((entry) => entry.tag === principal)?.owners
        : undefined;
    const cycle = path.includes(principal);
    const next = [...path, principal];
    const relation =
      kind === "direct" ? (group ? "group" : nested ? "tag" : kind) : kind;
    result.push({
      principal,
      path: next,
      kind: relation,
      cycle,
      missing: (group || nested) && !members,
    });
    if (!cycle && members && !expanded.has(principal)) {
      expanded.add(principal);
      for (const member of members) walk(member.value, next, relation);
    }
  };
  for (const owner of state.tagOwners.find((entry) => entry.tag === tag)
    ?.owners ?? [])
    walk(owner.value, [tag], "direct");
  return result;
}
