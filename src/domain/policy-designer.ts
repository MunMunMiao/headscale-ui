import { getNodeValue, type ParseError, parseTree, printParseErrorCode } from "jsonc-parser";
import type { PrincipalIndex } from "./principal";

export type PolicyMemberKind = "user" | "group" | "tag" | "host" | "raw";

export interface PolicyMemberRef {
  kind: PolicyMemberKind;
  value: string;
}

export interface PolicyGroup {
  id: string;
  name: string;
  members: PolicyMemberRef[];
}

export interface PolicyTagOwner {
  id: string;
  tag: string;
  owners: PolicyMemberRef[];
}

export interface PolicyRule {
  id: string;
  action: "accept";
  source: string;
  destination: string;
  ports: string;
  extras?: Record<string, unknown>;
}

export interface PolicyDesignerState {
  rules: PolicyRule[];
  groups: PolicyGroup[];
  tagOwners: PolicyTagOwner[];
  extras: Record<string, unknown>;
  error?: string;
}

export interface OrphanReference {
  kind: "group-member" | "tag-owner";
  containerId: string;
  containerName: string;
  value: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]*$/;
const CIDR_PATTERN = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;
const IPV6_CIDR_PATTERN = /^([0-9a-fA-F:]+)\/\d{1,3}$/;

export function classifyMember(value: string): PolicyMemberKind {
  if (value.startsWith("group:")) return "group";
  if (value.startsWith("tag:")) return "tag";
  if (value.startsWith("host:")) return "host";
  if (EMAIL_PATTERN.test(value)) return "user";
  if (CIDR_PATTERN.test(value)) return "raw";
  if (IPV6_CIDR_PATTERN.test(value)) return "raw";
  return "raw";
}

export function toMemberRef(value: string): PolicyMemberRef {
  const trimmed = value.trim();
  return { kind: classifyMember(trimmed), value: trimmed };
}

export function parseMemberList(value: unknown): PolicyMemberRef[] {
  const raw = listFromUnknown(value);
  return raw.map(toMemberRef);
}

export function serializeMembers(members: PolicyMemberRef[]): string[] {
  return members.map((m) => m.value);
}

function listFromUnknown(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.length > 0 && item.trim() === item)
  );
}

function destinationParts(
  values: string[],
): Array<{ destination: string; ports: string }> | undefined {
  const result: Array<{ destination: string; ports: string }> = [];
  for (const value of values) {
    const separator = value.lastIndexOf(":");
    const destination = value.slice(0, separator);
    const ports = value.slice(separator + 1);
    if (separator <= 0 || !ports.trim() || destination.includes(",")) {
      return;
    }
    result.push({ destination, ports });
  }
  return result;
}

export function parseCommaList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function joinCommaList(values: readonly string[]): string {
  return values
    .map((item) => item.trim())
    .filter(Boolean)
    .join(",");
}

function serializeDestination(destination: string, ports: string): string[] {
  return parseCommaList(destination).map((target) => `${target}:${ports.trim()}`);
}

let counter = 0;
export function createPolicyId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  counter += 1;
  return `policy-${Date.now()}-${counter}`;
}

function defaultRule(): PolicyRule {
  // Headscale 0.29 limits "*" to tailnet addresses; an absent policy allows all IPs.
  return {
    id: createPolicyId(),
    action: "accept",
    source: "0.0.0.0/0, ::/0",
    destination: "0.0.0.0/0, ::/0",
    ports: "*",
  };
}

export function emptyState(): PolicyDesignerState {
  return {
    rules: [defaultRule()],
    groups: [],
    tagOwners: [],
    extras: {},
  };
}

function invalidState(error: string): PolicyDesignerState {
  return { rules: [], groups: [], tagOwners: [], extras: {}, error };
}

function isMemberMap(value: unknown): boolean {
  return (
    value == null ||
    (isPlainObject(value) &&
      Object.entries(value).every(
        ([name, members]) => name.length > 0 && name.trim() === name && isStringList(members),
      ))
  );
}

export function parsePolicy(raw: string): PolicyDesignerState {
  if (!raw?.trim()) {
    return emptyState();
  }

  const errors: ParseError[] = [];
  const tree = parseTree(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const first = errors[0];
    return invalidState(`${printParseErrorCode(first.error)} at offset ${first.offset}`);
  }
  const parsed: unknown = tree && getNodeValue(tree);
  if (!isPlainObject(parsed)) {
    return invalidState("Policy root must be an object.");
  }

  const { acls, groups, tagOwners, ...extras } = parsed;
  if (acls != null && !Array.isArray(acls)) {
    return invalidState("Policy acls cannot be represented safely.");
  }
  if (extras.grants != null && !Array.isArray(extras.grants)) {
    return invalidState("Policy grants cannot be represented safely.");
  }
  if (!isMemberMap(groups) || !isMemberMap(tagOwners)) {
    return invalidState("Policy groups and tagOwners must contain arrays of member strings.");
  }

  const rules: PolicyRule[] = [];
  for (const node of Array.isArray(acls) ? acls : []) {
    if (!isPlainObject(node)) {
      return invalidState("Policy ACL rules must be objects.");
    }
    const { action, src, dst, ...ruleExtras } = node;
    if (
      action !== "accept" ||
      !isStringList(src) ||
      src.length === 0 ||
      src.some((source) => source.includes(",")) ||
      !isStringList(dst) ||
      dst.length === 0
    ) {
      return invalidState(
        "Policy ACL action, sources, or destinations cannot be represented safely.",
      );
    }
    const destinations = destinationParts(dst);
    if (!destinations) {
      return invalidState("Policy ACL destinations must include an explicit port selection.");
    }
    rules.push(
      ...destinations.map(
        (destination): PolicyRule => ({
          id: createPolicyId(),
          action,
          source: src.join(", "),
          destination: destination.destination,
          ports: destination.ports,
          ...(Object.keys(ruleExtras).length > 0 ? { extras: ruleExtras } : {}),
        }),
      ),
    );
  }

  const groupsList: PolicyGroup[] = isPlainObject(groups)
    ? Object.entries(groups as Record<string, unknown>).map(([name, members]) => ({
        id: createPolicyId(),
        name,
        members: parseMemberList(members),
      }))
    : [];

  const tagOwnersList: PolicyTagOwner[] = isPlainObject(tagOwners)
    ? Object.entries(tagOwners as Record<string, unknown>).map(([tag, owners]) => ({
        id: createPolicyId(),
        tag,
        owners: parseMemberList(owners),
      }))
    : [];

  return {
    rules: Array.isArray(acls) || Array.isArray(extras.grants) ? rules : [defaultRule()],
    groups: groupsList,
    tagOwners: tagOwnersList,
    extras,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function serializePolicy(state: PolicyDesignerState): Record<string, unknown> {
  if (state.error) {
    throw new Error(state.error);
  }
  if (
    state.rules.some(
      (rule) =>
        parseCommaList(rule.source).length === 0 ||
        parseCommaList(rule.destination).length === 0 ||
        !rule.ports.trim(),
    )
  ) {
    throw new Error("Policy ACL sources, destinations, and ports must not be empty.");
  }
  const groups = Object.fromEntries(
    state.groups
      .filter((group) => group.name.trim())
      .map((group) => [group.name.trim(), serializeMembers(group.members)]),
  );
  const tagOwners = Object.fromEntries(
    state.tagOwners
      .filter((owner) => owner.tag.trim())
      .map((owner) => [owner.tag.trim(), serializeMembers(owner.owners)]),
  );
  // Match the parser's single-destination rows so a saved policy stays unchanged on reload.
  const acls = state.rules.flatMap((rule) =>
    serializeDestination(rule.destination, rule.ports).map((destination) => ({
      ...rule.extras,
      action: rule.action,
      src: parseCommaList(rule.source),
      dst: [destination],
    })),
  );

  return {
    ...state.extras,
    groups,
    tagOwners,
    acls,
  };
}

export function addMemberToGroup(
  state: PolicyDesignerState,
  groupId: string,
  member: PolicyMemberRef,
): PolicyDesignerState {
  return {
    ...state,
    groups: state.groups.map((group) =>
      group.id === groupId ? { ...group, members: addUniqueMember(group.members, member) } : group,
    ),
  };
}

export function removeMemberFromGroup(
  state: PolicyDesignerState,
  groupId: string,
  value: string,
): PolicyDesignerState {
  return {
    ...state,
    groups: state.groups.map((group) =>
      group.id === groupId
        ? { ...group, members: group.members.filter((m) => m.value !== value) }
        : group,
    ),
  };
}

export function addOwnerToTag(
  state: PolicyDesignerState,
  tagOwnerId: string,
  owner: PolicyMemberRef,
): PolicyDesignerState {
  return {
    ...state,
    tagOwners: state.tagOwners.map((tagOwner) =>
      tagOwner.id === tagOwnerId
        ? { ...tagOwner, owners: addUniqueMember(tagOwner.owners, owner) }
        : tagOwner,
    ),
  };
}

export function removeOwnerFromTag(
  state: PolicyDesignerState,
  tagOwnerId: string,
  value: string,
): PolicyDesignerState {
  return {
    ...state,
    tagOwners: state.tagOwners.map((tagOwner) =>
      tagOwner.id === tagOwnerId
        ? { ...tagOwner, owners: tagOwner.owners.filter((o) => o.value !== value) }
        : tagOwner,
    ),
  };
}

// The name-keyed variants resolve the container themselves and leave the state unchanged when it is
// missing or its name is one the editor cannot define (upsertGroup/upsertTagOwner refuse those).
export function addMemberToGroupByName(
  state: PolicyDesignerState,
  groupName: string,
  member: PolicyMemberRef,
): PolicyDesignerState {
  const group = state.groups.find((candidate) => candidate.name === groupName);
  return group
    ? upsertGroup(state, { ...group, members: addUniqueMember(group.members, member) })
    : state;
}

export function removeMemberFromGroupByName(
  state: PolicyDesignerState,
  groupName: string,
  value: string,
): PolicyDesignerState {
  const group = state.groups.find((candidate) => candidate.name === groupName);
  return group
    ? upsertGroup(state, { ...group, members: group.members.filter((m) => m.value !== value) })
    : state;
}

export function removeOwnerFromTagByName(
  state: PolicyDesignerState,
  tag: string,
  value: string,
): PolicyDesignerState {
  const entry = state.tagOwners.find((candidate) => candidate.tag === tag);
  return entry
    ? upsertTagOwner(state, { ...entry, owners: entry.owners.filter((o) => o.value !== value) })
    : state;
}

// Headscale 0.29.4: Group.Validate checks the "group:" prefix and Tag.Validate checks "tag:" plus an
// ASCII letter first. Whitespace, ',' (rules are comma-joined), '@' (parseAlias treats any alias with
// '@' as a user) and ':' (separates the destination port) are excluded on purpose so the editor
// fails closed; server-valid names using them stay unsupported for rename/delete.
export function isPolicyIdentityName(name: string, kind: "group" | "tag"): boolean {
  return kind === "group" ? /^group:[^\s,:@]+$/.test(name) : /^tag:[A-Za-z][^\s,:@]*$/.test(name);
}

export function upsertGroup(state: PolicyDesignerState, group: PolicyGroup): PolicyDesignerState {
  const name = group.name.trim();
  if (
    !isPolicyIdentityName(name, "group") ||
    state.groups.some((existing) => existing.name === name && existing.id !== group.id)
  ) {
    return state;
  }

  const next: PolicyGroup = { ...group, name };
  return {
    ...state,
    groups: state.groups.some((existing) => existing.id === group.id)
      ? state.groups.map((existing) => (existing.id === group.id ? next : existing))
      : [...state.groups, next],
  };
}

export function upsertTagOwner(
  state: PolicyDesignerState,
  owner: PolicyTagOwner,
): PolicyDesignerState {
  const tag = owner.tag.trim();
  if (
    !isPolicyIdentityName(tag, "tag") ||
    state.tagOwners.some((existing) => existing.tag === tag && existing.id !== owner.id)
  ) {
    return state;
  }

  const next: PolicyTagOwner = { ...owner, tag };
  return {
    ...state,
    tagOwners: state.tagOwners.some((existing) => existing.id === owner.id)
      ? state.tagOwners.map((existing) => (existing.id === owner.id ? next : existing))
      : [...state.tagOwners, next],
  };
}

export function removeRuleById(state: PolicyDesignerState, id: string): PolicyDesignerState {
  return { ...state, rules: state.rules.filter((r) => r.id !== id) };
}

export function createRule(source: string, destination: string, ports: string): PolicyRule {
  return {
    id: createPolicyId(),
    action: "accept",
    source: source || "*",
    destination: destination || "*",
    ports: ports || "*",
  };
}

export function createGroup(name: string, members: PolicyMemberRef[] = []): PolicyGroup {
  return { id: createPolicyId(), name, members };
}

export function createTagOwner(tag: string, owners: PolicyMemberRef[] = []): PolicyTagOwner {
  return { id: createPolicyId(), tag, owners };
}

// A bare value (no prefix, no CIDR/wildcard) that should be looked up against
// the user list. Captures non-email user references that `classifyMember`
// otherwise lumps into "raw" — without this, `"alice"` written directly in the
// policy would silently bypass orphan detection.
//
// Trade-off: a bare value that *looks* like a username but is actually meant
// as something else (e.g. someone typed `myhost` instead of `host:myhost`)
// will be reported as a stale reference. We accept that — the surrounding
// policy editor never produces such bare values; if they exist in the source
// JSON they were either typos or migrated from an older format, and surfacing
// them in the orphan banner gives the operator a chance to fix them.
function isBarePrincipalCandidate(value: string): boolean {
  if (value.length === 0) return false;
  if (value.includes(":")) return false; // autogroup:/host:/group:/tag:/ipv6
  if (value.includes("/")) return false; // CIDR
  if (value.includes("*")) return false; // wildcard
  if (/^\d+(\.\d+){3}$/.test(value)) return false; // bare IPv4 literal
  return true;
}

export function findOrphanReferences(
  state: PolicyDesignerState,
  knownUsers: PrincipalIndex,
): OrphanReference[] {
  const groupNameSet = new Set(state.groups.map((g) => g.name));

  const orphans: OrphanReference[] = [];
  for (const group of state.groups) {
    for (const member of group.members) {
      if (member.kind === "user" && !knownUsers.has(member.value)) {
        orphans.push({
          kind: "group-member",
          containerId: group.id,
          containerName: group.name,
          value: member.value,
        });
      } else if (member.kind === "group" && !groupNameSet.has(member.value)) {
        orphans.push({
          kind: "group-member",
          containerId: group.id,
          containerName: group.name,
          value: member.value,
        });
      } else if (
        member.kind === "raw" &&
        isBarePrincipalCandidate(member.value) &&
        !knownUsers.has(member.value)
      ) {
        orphans.push({
          kind: "group-member",
          containerId: group.id,
          containerName: group.name,
          value: member.value,
        });
      }
    }
  }
  for (const tagOwner of state.tagOwners) {
    for (const owner of tagOwner.owners) {
      if (owner.kind === "user" && !knownUsers.has(owner.value)) {
        orphans.push({
          kind: "tag-owner",
          containerId: tagOwner.id,
          containerName: tagOwner.tag,
          value: owner.value,
        });
      } else if (owner.kind === "group" && !groupNameSet.has(owner.value)) {
        orphans.push({
          kind: "tag-owner",
          containerId: tagOwner.id,
          containerName: tagOwner.tag,
          value: owner.value,
        });
      } else if (
        owner.kind === "raw" &&
        isBarePrincipalCandidate(owner.value) &&
        !knownUsers.has(owner.value)
      ) {
        orphans.push({
          kind: "tag-owner",
          containerId: tagOwner.id,
          containerName: tagOwner.tag,
          value: owner.value,
        });
      }
    }
  }
  return orphans;
}

// Drops every reported reference from its container. Unlike upsertGroup/upsertTagOwner this does not
// require the container's name to satisfy the editor's naming rule: a stale reference inside an
// entry the editor cannot define is still removed.
export function removeOrphanReferences(
  state: PolicyDesignerState,
  orphans: readonly OrphanReference[],
): PolicyDesignerState {
  const isOrphan = (kind: OrphanReference["kind"], containerId: string, value: string) =>
    orphans.some(
      (orphan) =>
        orphan.kind === kind && orphan.containerId === containerId && orphan.value === value,
    );
  return {
    ...state,
    groups: state.groups.map((group) => ({
      ...group,
      members: group.members.filter((m) => !isOrphan("group-member", group.id, m.value)),
    })),
    tagOwners: state.tagOwners.map((tagOwner) => ({
      ...tagOwner,
      owners: tagOwner.owners.filter((o) => !isOrphan("tag-owner", tagOwner.id, o.value)),
    })),
  };
}

function addUniqueMember(members: PolicyMemberRef[], member: PolicyMemberRef): PolicyMemberRef[] {
  if (members.some((m) => m.value === member.value)) {
    return members;
  }
  return [...members, member];
}
