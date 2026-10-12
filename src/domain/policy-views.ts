import {
  classifyMember,
  createPolicyId,
  createRule,
  joinCommaList,
  type PolicyDesignerState,
  type PolicyMemberKind,
  type PolicyRule,
  parseCommaList,
} from "./policy-designer";

export type ServiceId = "ssh" | "web" | "rdp" | "ping" | "dns" | "all" | string;

export interface ServicePreset {
  id: ServiceId;
  ports: string[];
  isCustom?: boolean;
}

const SERVICE_PRESETS: ServicePreset[] = [
  { id: "all", ports: ["*"] },
  { id: "ssh", ports: ["22"] },
  { id: "web", ports: ["80", "443"] },
  { id: "rdp", ports: ["3389"] },
  { id: "dns", ports: ["53"] },
];

export function parsePortsToServices(ports: string): {
  presets: ServiceId[];
  custom: string;
} {
  const tokens = parseCommaList(ports);
  if (tokens.length === 0) {
    return { presets: [], custom: "" };
  }

  if (tokens.length === 1 && tokens[0] === "*") {
    return { presets: ["all"], custom: "" };
  }

  const matched = new Set<ServiceId>();
  const remaining = new Set(tokens);

  for (const preset of SERVICE_PRESETS) {
    if (preset.id === "all") continue;
    if (preset.ports.every((p) => remaining.has(p))) {
      matched.add(preset.id);
      for (const p of preset.ports) {
        remaining.delete(p);
      }
    }
  }

  return {
    presets: Array.from(matched),
    custom: joinCommaList(Array.from(remaining)),
  };
}

export function servicesToPortsString(presets: readonly ServiceId[], custom: string): string {
  if (presets.includes("all")) {
    return "*";
  }

  const ports: string[] = [];
  for (const id of presets) {
    const preset = SERVICE_PRESETS.find((p) => p.id === id);
    if (preset) {
      ports.push(...preset.ports);
    }
  }

  const customTokens = parseCommaList(custom);
  for (const token of customTokens) {
    if (!ports.includes(token)) {
      ports.push(token);
    }
  }

  return ports.length > 0 ? joinCommaList(ports) : "";
}

export interface TagAccessor {
  who: string;
  whoKind: PolicyMemberKind;
  services: ServiceId[];
  customPorts: string;
  ruleIds: string[];
  readOnly?: boolean;
}

export function getTagAccessors(state: PolicyDesignerState, tagName: string): TagAccessor[] {
  const buckets = new Map<string, TagAccessor>();

  for (const rule of state.rules) {
    const dstTargets = parseCommaList(rule.destination);
    if (!dstTargets.includes(tagName)) {
      continue;
    }

    const sources = parseCommaList(rule.source);
    for (const who of sources) {
      const existing = buckets.get(who);
      const { presets, custom } = parsePortsToServices(rule.ports);

      if (!existing) {
        buckets.set(who, {
          who,
          whoKind: classifyMember(who),
          services: presets,
          customPorts: custom,
          ruleIds: [rule.id],
          readOnly: Boolean(rule.extras && Object.keys(rule.extras).length > 0),
        });
        continue;
      }

      const mergedServices = new Set([...existing.services, ...presets]);
      const mergedCustom = joinCommaList([
        ...parseCommaList(existing.customPorts),
        ...parseCommaList(custom),
      ]);
      buckets.set(who, {
        who,
        whoKind: existing.whoKind,
        services: Array.from(mergedServices),
        customPorts: mergedCustom,
        ruleIds: [...existing.ruleIds, rule.id],
        readOnly: existing.readOnly || Boolean(rule.extras && Object.keys(rule.extras).length > 0),
      });
    }
  }

  return Array.from(buckets.values());
}

export interface GroupAccess {
  tagName: string;
  services: ServiceId[];
  customPorts: string;
}

export function getGroupAccess(state: PolicyDesignerState, groupName: string): GroupAccess[] {
  const buckets = new Map<string, GroupAccess>();

  for (const rule of state.rules) {
    const sources = parseCommaList(rule.source);
    if (!sources.includes(groupName)) {
      continue;
    }

    const destinations = parseCommaList(rule.destination);
    for (const dest of destinations) {
      if (!dest.startsWith("tag:")) {
        continue;
      }

      const { presets, custom } = parsePortsToServices(rule.ports);
      const existing = buckets.get(dest);
      if (!existing) {
        buckets.set(dest, { tagName: dest, services: presets, customPorts: custom });
      } else {
        existing.services = Array.from(new Set([...existing.services, ...presets]));
        existing.customPorts = joinCommaList([
          ...parseCommaList(existing.customPorts),
          ...parseCommaList(custom),
        ]);
      }
    }
  }

  return Array.from(buckets.values());
}

export function setTagAccessor(
  state: PolicyDesignerState,
  tagName: string,
  who: string,
  ports: string,
): PolicyDesignerState {
  if (!tagName.trim() || !who.trim()) {
    return state;
  }

  if (
    getTagAccessors(state, tagName).some((accessor) => accessor.who === who && accessor.readOnly)
  ) {
    throw new Error("ACL extensions cannot be safely edited through aggregated tag access.");
  }

  const next = removeTagAccessor(state, tagName, who);
  if (!ports.trim()) {
    return next;
  }

  const rule = createRule(who, tagName, ports);
  return { ...next, rules: [...next.rules, rule] };
}

export function removeTagAccessor(
  state: PolicyDesignerState,
  tagName: string,
  who: string,
): PolicyDesignerState {
  const filteredRules: PolicyRule[] = [];

  for (const rule of state.rules) {
    const sources = parseCommaList(rule.source);
    const destinations = parseCommaList(rule.destination);

    if (!destinations.includes(tagName) || !sources.includes(who)) {
      filteredRules.push(rule);
      continue;
    }

    const remainingSources = sources.filter((s) => s !== who);
    const remainingDestinations = destinations.filter((d) => d !== tagName);

    // S x D minus (who, tag) == S x (D - tag) union (S - who) x {tag}. The first part keeps the id;
    // both empty drops the rule.
    const parts: PolicyRule[] = [];
    if (remainingDestinations.length > 0) {
      parts.push({ ...rule, destination: joinCommaList(remainingDestinations) });
    }
    if (remainingSources.length > 0) {
      parts.push({
        ...rule,
        id: parts.length > 0 ? createPolicyId() : rule.id,
        source: joinCommaList(remainingSources),
        destination: tagName,
      });
    }
    filteredRules.push(...parts);
  }

  return { ...state, rules: filteredRules };
}

export interface OpenAccessWarning {
  ruleId: string;
  source: string;
  destination: string;
  ports: string;
}

const ALL_ADDRESS_CIDRS = ["0.0.0.0/0", "::/0"];

export function hasOnlyDefaultAccess(state: PolicyDesignerState): boolean {
  if (state.rules.some((rule) => rule.extras && Object.keys(rule.extras).length > 0)) {
    return false;
  }
  if (
    state.rules.length === 1 &&
    state.rules[0].source.trim() === "*" &&
    state.rules[0].destination.trim() === "*" &&
    state.rules[0].ports.trim() === "*"
  ) {
    return true;
  }

  const destinations = new Set<string>();
  for (const rule of state.rules) {
    const sources = parseCommaList(rule.source);
    const targets = parseCommaList(rule.destination);
    if (
      rule.ports.trim() !== "*" ||
      !ALL_ADDRESS_CIDRS.every((cidr) => sources.includes(cidr)) ||
      !sources.every((source) => ALL_ADDRESS_CIDRS.includes(source)) ||
      targets.length === 0 ||
      !targets.every((target) => ALL_ADDRESS_CIDRS.includes(target))
    ) {
      return false;
    }
    for (const target of targets) destinations.add(target);
  }
  return ALL_ADDRESS_CIDRS.every((cidr) => destinations.has(cidr));
}

export function getOpenAccessWarnings(state: PolicyDesignerState): OpenAccessWarning[] {
  const warnings: OpenAccessWarning[] = [];

  for (const rule of state.rules) {
    const isOpen = (value: string) => value === "*" || ALL_ADDRESS_CIDRS.includes(value);
    const hasOpenSource = parseCommaList(rule.source).some(isOpen);
    const hasOpenDestination = parseCommaList(rule.destination).some(isOpen);
    if (hasOpenSource || hasOpenDestination) {
      warnings.push({
        ruleId: rule.id,
        source: rule.source,
        destination: rule.destination,
        ports: rule.ports,
      });
    }
  }

  return warnings;
}

export interface IpRule {
  ruleId: string;
  source: string;
  destination: string;
  ports: string;
}

const TAG_PATTERN = /^tag:/;

export function updateIpRule(
  state: PolicyDesignerState,
  ruleId: string,
  patch: Partial<Pick<PolicyRule, "source" | "destination" | "ports">>,
): PolicyDesignerState {
  return {
    ...state,
    rules: state.rules.map((rule) => (rule.id === ruleId ? { ...rule, ...patch } : rule)),
  };
}

export function getIpRules(state: PolicyDesignerState): IpRule[] {
  const rules: IpRule[] = [];
  for (const rule of state.rules) {
    const destinations = parseCommaList(rule.destination);
    if (destinations.length === 0) continue;

    const allTagged = destinations.every((dest) => TAG_PATTERN.test(dest));
    if (!allTagged) {
      rules.push({
        ruleId: rule.id,
        source: rule.source,
        destination: rule.destination,
        ports: rule.ports,
      });
    }
  }
  return rules;
}

export function listTagsFromState(state: PolicyDesignerState): string[] {
  const seen = new Set<string>();

  // Blank tag names never reach a state: parsePolicy rejects them and upsertTagOwner validates names.
  for (const owner of state.tagOwners) {
    seen.add(owner.tag);
  }
  for (const rule of state.rules) {
    for (const dest of parseCommaList(rule.destination)) {
      if (dest.startsWith("tag:")) seen.add(dest);
    }
    for (const src of parseCommaList(rule.source)) {
      if (src.startsWith("tag:")) seen.add(src);
    }
  }

  return Array.from(seen).sort();
}

export function stripTagPrefix(tag: string): string {
  return tag.startsWith("tag:") ? tag.slice(4) : tag;
}

export function stripGroupPrefix(group: string): string {
  return group.startsWith("group:") ? group.slice(6) : group;
}

export function withTagPrefix(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("tag:") ? trimmed : `tag:${trimmed}`;
}

export function withGroupPrefix(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("group:") ? trimmed : `group:${trimmed}`;
}
