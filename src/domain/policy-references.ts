import {
  isPolicyIdentityName,
  joinCommaList,
  type PolicyDesignerState,
  parseCommaList,
  serializePolicy,
  toMemberRef,
} from "./policy-designer";

export interface PolicyReferenceIssue {
  code:
    | "invalid-name"
    | "name-conflict"
    | "entity-not-found"
    | "unreadable-policy"
    | "unsupported-reference";
  paths: string[];
}
export type PolicyReferenceResult =
  | { ok: true; state: PolicyDesignerState }
  | { ok: false; issue: PolicyReferenceIssue };

function failure(code: PolicyReferenceIssue["code"], paths: string[]): PolicyReferenceResult {
  return { ok: false, issue: { code, paths } };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Headscale 0.29.4 reference positions are explicit. Opaque fields never receive string replacement.
function transform(
  state: PolicyDesignerState,
  oldNames: ReadonlySet<string>,
  newName: string | null,
) {
  const paths: string[] = [];
  const aliases = new Set<string>();
  // A rename onto a name that is already listed must not create "bob@, bob@".
  const unique = (values: string[]) => (newName === null ? values : [...new Set(values)]);
  const object = (value: unknown, allowed: readonly string[], path: string) => {
    if (!record(value)) {
      paths.push(path);
      return null;
    }
    for (const key of Object.keys(value)) if (!allowed.includes(key)) paths.push(`${path}.${key}`);
    return value;
  };
  const strings = (value: unknown, path: string): string[] => {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
      paths.push(path);
      return [];
    }
    return value;
  };
  const alias = (
    value: string,
    path: string,
    mode: "any" | "no-group" | "tag" | "user" | "owner" = "any",
  ) => {
    aliases.add(value);
    if (
      (value.startsWith("group:") &&
        (!isPolicyIdentityName(value, "group") || mode === "no-group")) ||
      (value.startsWith("tag:") && !isPolicyIdentityName(value, "tag")) ||
      (mode === "tag" && !value.startsWith("tag:")) ||
      (mode === "owner" &&
        !value.startsWith("group:") &&
        !value.startsWith("tag:") &&
        !value.includes("@")) ||
      (mode === "user" &&
        (value.startsWith("group:") || value.startsWith("tag:") || !value.includes("@"))) ||
      value !== value.trim() ||
      value.includes(",")
    )
      paths.push(path);
    return oldNames.has(value) ? newName : value;
  };
  const list = (
    value: unknown,
    path: string,
    mode: "any" | "no-group" | "tag" | "user" | "owner" = "any",
    required = false,
  ) => {
    const values = strings(value, path);
    if (required && values.length === 0) paths.push(path);
    return unique(
      values.flatMap((item, index) => {
        const next = alias(item, `${path}[${index}]`, mode);
        return next === null ? [] : [next];
      }),
    );
  };
  const scalar = (value: unknown, path: string) => {
    if (typeof value !== "string" || !value.trim()) {
      paths.push(path);
      return null;
    }
    return alias(value, path);
  };
  const destinations = (value: unknown, path: string) =>
    unique(
      strings(value, path).flatMap((item, index) => {
        const colon = item.lastIndexOf(":");
        const port = item.slice(colon + 1);
        if (colon < 1 || !/^\d+$/.test(port) || Number(port) > 65535) {
          paths.push(`${path}[${index}]`);
          return [item];
        }
        const next = alias(item.slice(0, colon), `${path}[${index}]`);
        return next === null ? [] : [`${next}:${port}`];
      }),
    );
  const entries = (
    value: unknown,
    path: string,
    visit: (entry: unknown, path: string) => Record<string, unknown> | null,
  ) => {
    if (!Array.isArray(value)) {
      paths.push(path);
      return [];
    }
    return value.flatMap((entry, index) => {
      const next = visit(entry, `${path}[${index}]`);
      return next === null ? [] : [next];
    });
  };
  const optionalStrings = (
    entry: Record<string, unknown>,
    names: readonly string[],
    path: string,
  ) => {
    for (const name of names) if (name in entry) strings(entry[name], `${path}.${name}`);
  };

  const groups = state.groups
    .map((group, index) => {
      aliases.add(group.name);
      const members = list(
        group.members.map((member) => member.value),
        `groups.${group.name}`,
        "user",
      ).map(toMemberRef);
      if (!isPolicyIdentityName(group.name, "group")) paths.push(`groups[${index}].name`);
      return {
        ...group,
        name: oldNames.has(group.name) && newName !== null ? newName : group.name,
        members,
      };
    })
    .filter((group) => newName !== null || !oldNames.has(group.name));
  const tagOwners = state.tagOwners
    .map((owner, index) => {
      aliases.add(owner.tag);
      if (!isPolicyIdentityName(owner.tag, "tag")) paths.push(`tagOwners[${index}].tag`);
      return {
        ...owner,
        tag: oldNames.has(owner.tag) && newName !== null ? newName : owner.tag,
        owners: list(
          owner.owners.map((member) => member.value),
          `tagOwners.${owner.tag}`,
          "owner",
        ).map(toMemberRef),
      };
    })
    .filter((owner) => newName !== null || !oldNames.has(owner.tag));
  const rules = state.rules.flatMap((rule, index) => {
    if (rule.extras) {
      const extra = object(rule.extras, ["proto"], `acls[${index}]`);
      if (extra && "proto" in extra && typeof extra.proto !== "string")
        paths.push(`acls[${index}].proto`);
    }
    const src = list(parseCommaList(rule.source), `acls[${index}].src`);
    const dst = list(parseCommaList(rule.destination), `acls[${index}].dst`);
    if (!rule.source.trim() || !rule.destination.trim() || !rule.ports.trim())
      paths.push(`acls[${index}]`);
    return src.length && dst.length
      ? [{ ...rule, source: joinCommaList(src), destination: joinCommaList(dst) }]
      : [];
  });
  const extras: Record<string, unknown> = {};
  for (const [section, value] of Object.entries(state.extras)) {
    switch (section) {
      case "hosts": {
        if (!record(value)) paths.push(section);
        else
          for (const [host, ip] of Object.entries(value))
            if (typeof ip !== "string") paths.push(`hosts.${host}`);
        extras[section] = value;
        break;
      }
      case "randomizeClientPort":
        if (typeof value !== "boolean") paths.push(section);
        extras[section] = value;
        break;
      case "autoApprovers": {
        const entry = object(value, ["routes", "exitNode"], section);
        if (!entry) break;
        const next = { ...entry };
        if ("routes" in entry) {
          if (!record(entry.routes)) paths.push("autoApprovers.routes");
          else
            next.routes = Object.fromEntries(
              Object.entries(entry.routes).map(([route, approvers]) => [
                route,
                list(approvers, `autoApprovers.routes.${route}`, "owner"),
              ]),
            );
        }
        if ("exitNode" in entry)
          next.exitNode = list(entry.exitNode, "autoApprovers.exitNode", "owner");
        extras[section] = next;
        break;
      }
      case "ssh":
        extras[section] = entries(value, section, (value, path) => {
          const entry = object(
            value,
            ["action", "src", "dst", "users", "checkPeriod", "acceptEnv"],
            path,
          );
          if (!entry) return null;
          if (entry.action !== "accept" && entry.action !== "check") paths.push(`${path}.action`);
          if (!strings(entry.users, `${path}.users`).length) paths.push(`${path}.users`);
          optionalStrings(entry, ["acceptEnv"], path);
          if ("checkPeriod" in entry && typeof entry.checkPeriod !== "string")
            paths.push(`${path}.checkPeriod`);
          const src = list(entry.src, `${path}.src`, "any", true);
          const dst = list(entry.dst, `${path}.dst`, "no-group", true);
          return src.length && dst.length ? { ...entry, src, dst } : null;
        });
        break;
      case "grants":
        extras[section] = entries(value, section, (value, path) => {
          const entry = object(value, ["src", "dst", "ip", "app", "via"], path);
          if (!entry) return null;
          optionalStrings(entry, ["ip"], path);
          if ("app" in entry && (!record(entry.app) || Object.keys(entry.app).length))
            paths.push(`${path}.app`);
          const src = list(entry.src, `${path}.src`, "any", true);
          const dst = list(entry.dst, `${path}.dst`, "any", true);
          const via = "via" in entry ? list(entry.via, `${path}.via`, "tag") : undefined;
          if (
            !src.length ||
            !dst.length ||
            (via && !via.length && strings(entry.via, `${path}.via`).length > 0)
          )
            return null;
          return { ...entry, src, dst, ...(via ? { via } : {}) };
        });
        break;
      case "nodeAttrs":
        extras[section] = entries(value, section, (value, path) => {
          const entry = object(value, ["target", "attr", "ipPool"], path);
          if (!entry) return null;
          optionalStrings(entry, ["attr", "ipPool"], path);
          const target = list(entry.target, `${path}.target`, "any", true);
          return target.length ? { ...entry, target } : null;
        });
        break;
      case "tests":
        extras[section] = entries(value, section, (value, path) => {
          const entry = object(value, ["src", "proto", "accept", "deny"], path);
          if (!entry) return null;
          if ("proto" in entry && typeof entry.proto !== "string") paths.push(`${path}.proto`);
          const src = scalar(entry.src, `${path}.src`);
          const accept = "accept" in entry ? destinations(entry.accept, `${path}.accept`) : [];
          const deny = "deny" in entry ? destinations(entry.deny, `${path}.deny`) : [];
          if (
            !("accept" in entry && strings(entry.accept, `${path}.accept`).length) &&
            !("deny" in entry && strings(entry.deny, `${path}.deny`).length)
          )
            paths.push(path);
          return src !== null && (accept.length || deny.length)
            ? {
                ...entry,
                src,
                ...("accept" in entry ? { accept } : {}),
                ...("deny" in entry ? { deny } : {}),
              }
            : null;
        });
        break;
      case "sshTests":
        extras[section] = entries(value, section, (value, path) => {
          const entry = object(value, ["src", "dst", "accept", "deny", "check"], path);
          if (!entry) return null;
          optionalStrings(entry, ["accept", "deny", "check"], path);
          const src = scalar(entry.src, `${path}.src`);
          const dst = list(entry.dst, `${path}.dst`, "any", true);
          return src !== null && dst.length ? { ...entry, src, dst } : null;
        });
        break;
      default:
        paths.push(section);
    }
  }
  return {
    state: { ...state, groups, tagOwners, rules, extras },
    paths: [...new Set(paths)],
    aliases,
  };
}

function update(
  state: PolicyDesignerState,
  kind: "group" | "tag",
  identity: string,
  newName: string | null,
): PolicyReferenceResult {
  if (state.error) return failure("unreadable-policy", []);
  const oldName =
    kind === "group" ? state.groups.find((group) => group.id === identity)?.name : identity;
  if (oldName === undefined) return failure("entity-not-found", ["groups"]);
  if (newName !== null && !isPolicyIdentityName(newName, kind))
    return failure("invalid-name", [kind === "group" ? "groups" : "tagOwners"]);
  if (kind === "group" && oldName === newName) return { ok: true, state };
  const result = transform(state, new Set([oldName]), newName);
  if (!result.aliases.has(oldName)) return failure("entity-not-found", ["tagOwners"]);
  if (oldName === newName) return { ok: true, state };
  if (newName !== null && result.aliases.has(newName))
    return failure("name-conflict", [kind === "group" ? "groups" : "tagOwners"]);
  if (result.paths.length) return failure("unsupported-reference", result.paths);
  return { ok: true, state: result.state };
}

export function renamePolicyGroup(
  state: PolicyDesignerState,
  groupId: string,
  newName: string,
): PolicyReferenceResult {
  return update(state, "group", groupId, newName.trim());
}
export function renamePolicyTag(
  state: PolicyDesignerState,
  oldTag: string,
  newTag: string,
): PolicyReferenceResult {
  return update(state, "tag", oldTag, newTag.trim());
}
export function removePolicyGroup(
  state: PolicyDesignerState,
  groupId: string,
): PolicyReferenceResult {
  return update(state, "group", groupId, null);
}
export function removePolicyTag(state: PolicyDesignerState, tag: string): PolicyReferenceResult {
  return update(state, "tag", tag, null);
}

// Every group, tag and user name the policy references in a supported position.
export function policyAliases(state: PolicyDesignerState): ReadonlySet<string> {
  return transform(state, new Set(), null).aliases;
}

export type UserReferencePlan =
  | { ok: true; state: PolicyDesignerState; sections: string[] }
  | { ok: false; issue: PolicyReferenceIssue; mentioned: boolean };

// Precondition: a readable, clean draft. Bare names are never rewritten because Headscale 0.29.4
// needs "@" for users and a bare string in acls/ssh can be a host alias. Strict like the group/tag
// operations: any unsupported shape blocks the whole rewrite. Deleting only narrows access.
export function retargetUserReferences(
  state: PolicyDesignerState,
  from: readonly string[],
  to: string | null,
): UserReferencePlan {
  if (state.error)
    return { ok: false, issue: { code: "unreadable-policy", paths: [] }, mentioned: false };
  const names = new Set(from.filter((value) => value.includes("@")));
  const result = transform(state, names, to);
  const mentioned = [...names].some((name) => result.aliases.has(name));
  if (result.paths.length)
    return {
      ok: false,
      issue: { code: "unsupported-reference", paths: result.paths },
      mentioned,
    };
  const before = serializePolicy(state);
  const after = serializePolicy(result.state);
  const sections = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (section) => JSON.stringify(before[section]) !== JSON.stringify(after[section]),
  );
  return { ok: true, state: result.state, sections };
}
