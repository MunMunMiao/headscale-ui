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
}

export interface PolicyDesignerState {
  rules: PolicyRule[];
  groups: PolicyGroup[];
  tagOwners: PolicyTagOwner[];
  extras: Record<string, unknown>;
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

function listToText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(String).join(", ");
  }
  if (typeof value === "string") {
    return value;
  }
  return "";
}

function destinationParts(value: unknown): Array<{ destination: string; ports: string }> {
  const destinations = Array.isArray(value)
    ? value.map(String)
    : typeof value === "string"
      ? [value]
      : ["*:*"];
  return (destinations.length > 0 ? destinations : ["*:*"]).map((destination) => {
    const separator = destination.lastIndexOf(":");
    if (separator <= 0) {
      return { destination, ports: "*" };
    }
    return {
      destination: destination.slice(0, separator),
      ports: destination.slice(separator + 1) || "*",
    };
  });
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
  const resolvedPorts = ports.trim() || "*";
  return parseCommaList(destination || "*").map((target) => `${target}:${resolvedPorts}`);
}

let counter = 0;
function createPolicyId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  counter += 1;
  return `policy-${Date.now()}-${counter}`;
}

function defaultRule(): PolicyRule {
  return {
    id: createPolicyId(),
    action: "accept",
    source: "*",
    destination: "*",
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

export function parsePolicy(raw: string): PolicyDesignerState {
  if (!raw?.trim()) {
    return emptyState();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyState();
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return emptyState();
  }

  const root = parsed as {
    acls?: unknown;
    groups?: unknown;
    tagOwners?: unknown;
    [key: string]: unknown;
  };
  const { acls, groups, tagOwners, ...extras } = root;

  const rules: PolicyRule[] = Array.isArray(acls)
    ? acls.flatMap((rule) => {
        const node = (rule && typeof rule === "object" ? rule : {}) as {
          action?: unknown;
          src?: unknown;
          dst?: unknown;
        };
        return destinationParts(node.dst).map((dst) => ({
          id: createPolicyId(),
          action: "accept" as const,
          source: listToText(node.src) || "*",
          destination: dst.destination || "*",
          ports: dst.ports || "*",
        }));
      })
    : [];

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
    rules: Array.isArray(acls) ? rules : [defaultRule()],
    groups: groupsList,
    tagOwners: tagOwnersList,
    extras,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function serializePolicy(state: PolicyDesignerState): Record<string, unknown> {
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
  const acls = state.rules.map((rule) => ({
    action: rule.action,
    src: parseCommaList(rule.source),
    dst: serializeDestination(rule.destination, rule.ports),
  }));

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

export function upsertGroup(state: PolicyDesignerState, group: PolicyGroup): PolicyDesignerState {
  const name = group.name.trim();
  if (!name) {
    return state;
  }

  const next: PolicyGroup = { ...group, name };
  return {
    ...state,
    groups: [
      ...state.groups.filter((existing) => existing.name !== name && existing.id !== group.id),
      next,
    ],
  };
}

export function upsertTagOwner(
  state: PolicyDesignerState,
  owner: PolicyTagOwner,
): PolicyDesignerState {
  const tag = owner.tag.trim();
  if (!tag) {
    return state;
  }

  const next: PolicyTagOwner = { ...owner, tag };
  return {
    ...state,
    tagOwners: [
      ...state.tagOwners.filter((existing) => existing.tag !== tag && existing.id !== owner.id),
      next,
    ],
  };
}

export function removeGroupById(state: PolicyDesignerState, id: string): PolicyDesignerState {
  return { ...state, groups: state.groups.filter((g) => g.id !== id) };
}

export function removeTagOwnerById(state: PolicyDesignerState, id: string): PolicyDesignerState {
  return { ...state, tagOwners: state.tagOwners.filter((t) => t.id !== id) };
}

export function addRule(state: PolicyDesignerState, rule: PolicyRule): PolicyDesignerState {
  return { ...state, rules: [...state.rules, rule] };
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

export function findReferencesToValues(
  state: PolicyDesignerState,
  values: string[],
): { groupIds: string[]; tagOwnerIds: string[]; groupNames: string[]; tagNames: string[] } {
  const set = new Set(values);
  const matchingGroups = state.groups.filter((g) => g.members.some((m) => set.has(m.value)));
  const matchingTagOwners = state.tagOwners.filter((t) => t.owners.some((o) => set.has(o.value)));
  return {
    groupIds: matchingGroups.map((g) => g.id),
    tagOwnerIds: matchingTagOwners.map((t) => t.id),
    groupNames: matchingGroups.map((g) => g.name),
    tagNames: matchingTagOwners.map((t) => t.tag),
  };
}

export function removeReferencesToValues(
  state: PolicyDesignerState,
  values: string[],
): PolicyDesignerState {
  if (values.length === 0) return state;
  const set = new Set(values);
  return {
    ...state,
    groups: state.groups.map((g) => ({
      ...g,
      members: g.members.filter((m) => !set.has(m.value)),
    })),
    tagOwners: state.tagOwners.map((t) => ({
      ...t,
      owners: t.owners.filter((o) => !set.has(o.value)),
    })),
  };
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

function addUniqueMember(members: PolicyMemberRef[], member: PolicyMemberRef): PolicyMemberRef[] {
  if (members.some((m) => m.value === member.value)) {
    return members;
  }
  return [...members, member];
}
