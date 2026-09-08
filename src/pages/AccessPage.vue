<script setup lang="ts">
import {
  Database,
  Eraser,
  FileCheck2,
  Laptop,
  LoaderCircle,
  Network,
  Plus,
  Search,
  Server,
  ShieldAlert,
  Tag,
  Trash2,
  Users,
  UserX,
  X,
} from "lucide-vue-next";
import { computed, reactive, ref, watch } from "vue";
import MemberMultiSelect, { type MemberOption } from "@/components/MemberMultiSelect.vue";
import IpRuleRow from "@/components/policy/IpRuleRow.vue";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type ActionFeedbackKey, useActionFeedback } from "@/composables/useActionFeedback";
import { useMutation } from "@/composables/useMutation";
import { usePolicyDesigner } from "@/composables/usePolicyDesigner";
import { useProductCopy } from "@/composables/useProductCopy";
import { useSnapshot } from "@/composables/useSnapshot";
import {
  createGroup,
  createTagOwner,
  findOrphanReferences,
  joinCommaList,
  type PolicyDesignerState,
  type PolicyGroup,
  parseCommaList,
  parsePolicy,
  removeGroupById,
  removeTagOwnerById,
  serializePolicy,
  toMemberRef,
  upsertGroup,
  upsertTagOwner,
} from "@/domain/policy-designer";
import { applyTemplate, POLICY_TEMPLATES, type PolicyTemplate } from "@/domain/policy-templates";
import {
  getGroupAccess,
  getIpRules,
  getOpenAccessWarnings,
  getTagAccessors,
  parsePortsToServices,
  removeTagAccessor,
  type ServiceId,
  servicesToPortsString,
  setTagAccessor,
  stripGroupPrefix,
  stripTagPrefix,
  type TagAccessor,
  updateIpRule,
  withGroupPrefix,
  withTagPrefix,
} from "@/domain/policy-views";
import {
  PrincipalIndex,
  policyPrincipalForUser,
  toPrincipal,
  userMatchesPolicyValue,
} from "@/domain/principal";
import { useHeadscaleI18n } from "@/i18n";
import { type CountMessage, formatCount } from "@/i18n/plural";

const { locale, meta } = useHeadscaleI18n();
const { copy } = useProductCopy();
const { snapshot } = useSnapshot();
const { isActionPending, actionError } = useActionFeedback();
const {
  policyRules,
  policyGroups,
  policyTagOwners,
  policyDesignerState,
  policyDraft,
  policyPayload,
  tagDetailOpen,
  tagDetailCurrent,
  teamDetailOpen,
  teamDetailCurrent,
  highRiskConfirmOpen,
  pendingHighRiskAction,
  policyRemovalDialogOpen,
  pendingPolicyRemoval,
  commitState,
} = usePolicyDesigner();

const tagSearchQuery = ref("");

const visibleUsers = computed(() =>
  snapshot.value.users.filter((user) => user.name !== "tagged-devices"),
);

const knownUserIndex = computed(() => PrincipalIndex.fromUsers(snapshot.value.users));

const allTags = computed<string[]>(() => {
  const seen = new Set<string>();
  for (const owner of policyTagOwners.value) {
    if (owner.tag) seen.add(owner.tag);
  }
  for (const rule of policyRules.value) {
    for (const dest of parseCommaList(rule.destination)) {
      if (dest.startsWith("tag:")) seen.add(dest);
    }
    for (const src of parseCommaList(rule.source)) {
      if (src.startsWith("tag:")) seen.add(src);
    }
  }
  for (const node of snapshot.value.nodes) {
    for (const t of node.tags) {
      if (t.startsWith("tag:")) seen.add(t);
    }
  }
  return Array.from(seen).sort();
});

interface TagMeta {
  tagName: string;
  displayName: string;
  owners: string[];
  accessors: TagAccessor[];
  deviceCount: number;
}

const tagsWithMeta = computed<TagMeta[]>(() =>
  allTags.value.map((tagName) => {
    const ownerEntry = policyTagOwners.value.find((o) => o.tag === tagName);
    return {
      tagName,
      displayName: stripTagPrefix(tagName),
      owners: ownerEntry ? ownerEntry.owners.map((o) => o.value) : [],
      accessors: getTagAccessors(policyDesignerState.value, tagName),
      deviceCount: snapshot.value.nodes.filter((node) => node.tags.includes(tagName)).length,
    };
  }),
);

const filteredTagsWithMeta = computed(() => {
  const q = tagSearchQuery.value.trim().toLowerCase();
  if (!q) return tagsWithMeta.value;
  return tagsWithMeta.value.filter((t) => {
    if (t.displayName.toLowerCase().includes(q)) return true;
    if (t.tagName.toLowerCase().includes(q)) return true;
    if (t.accessors.some((a) => a.who.toLowerCase().includes(q))) return true;
    if (t.owners.some((o) => o.toLowerCase().includes(q))) return true;
    return false;
  });
});

interface TeamMeta {
  group: PolicyGroup;
  displayName: string;
  accessRows: ReturnType<typeof getGroupAccess>;
}

const teamsWithMeta = computed<TeamMeta[]>(() =>
  policyGroups.value.map((group) => ({
    group,
    displayName: stripGroupPrefix(group.name),
    accessRows: getGroupAccess(policyDesignerState.value, group.name),
  })),
);

const openAccessWarnings = computed(() => getOpenAccessWarnings(policyDesignerState.value));
const orphanRefs = computed(() =>
  findOrphanReferences(policyDesignerState.value, knownUserIndex.value),
);
const ipRules = computed(() => getIpRules(policyDesignerState.value));
const editingIpRuleId = ref<string | null>(null);

function isDefaultRule(rule: { source: string; destination: string; ports: string }) {
  return rule.source === "*" && rule.destination === "*" && rule.ports === "*";
}

const isEmptyState = computed(() => {
  if (policyGroups.value.length > 0 || policyTagOwners.value.length > 0) {
    return false;
  }
  if (policyRules.value.length === 0) {
    return true;
  }
  return policyRules.value.length === 1 && isDefaultRule(policyRules.value[0]);
});

const currentTagMeta = computed(() =>
  tagDetailCurrent.value
    ? tagsWithMeta.value.find((t) => t.tagName === tagDetailCurrent.value)
    : undefined,
);

const currentTeamMeta = computed(() =>
  teamDetailCurrent.value
    ? teamsWithMeta.value.find((t) => t.group.name === teamDetailCurrent.value)
    : undefined,
);

const tagNameDraft = ref("");
const teamNameDraft = ref("");

watch(tagDetailOpen, (open) => {
  if (open) {
    tagNameDraft.value = currentTagMeta.value?.displayName ?? "";
  } else {
    tagNameDraft.value = "";
  }
});

watch(teamDetailOpen, (open) => {
  if (open) {
    teamNameDraft.value = currentTeamMeta.value?.displayName ?? "";
  } else {
    teamNameDraft.value = "";
  }
});

const SERVICE_DEFS: {
  id: ServiceId;
  labelKey: keyof typeof copy.value;
  hintKey: keyof typeof copy.value;
}[] = [
  { id: "ssh", labelKey: "svcSshLabel", hintKey: "svcSshHint" },
  { id: "web", labelKey: "svcWebLabel", hintKey: "svcWebHint" },
  { id: "rdp", labelKey: "svcRdpLabel", hintKey: "svcRdpHint" },
  { id: "dns", labelKey: "svcDnsLabel", hintKey: "svcDnsHint" },
];

function memberKindGroupLabel(kind: PolicyMemberKind): string {
  if (kind === "group") return copy.value.optionGroupTeams;
  if (kind === "user") return copy.value.optionGroupUsers;
  if (kind === "tag") return copy.value.optionGroupLabels;
  return copy.value.optionGroupSpecial;
}

function pluralize(count: number, key: CountMessage) {
  return formatCount(locale.value, key, count);
}

const orphanValueSet = computed(() => new Set(orphanRefs.value.map((r) => r.value)));

function isOrphanValue(value: string) {
  return orphanValueSet.value.has(value);
}

function whoDisplayLabel(value: string): string {
  if (value === "*") return copy.value.allUsersChoice;
  if (value.startsWith("group:")) return stripGroupPrefix(value);
  if (value.startsWith("tag:")) return stripTagPrefix(value);
  return value;
}

function whoDisplayKind(value: string): string {
  if (value === "*") return copy.value.optionGroupSpecial;
  if (value.startsWith("group:")) return copy.value.optionGroupTeams;
  if (value.startsWith("tag:")) return copy.value.optionGroupLabels;
  return copy.value.optionGroupUsers;
}

function serviceSummary(services: ServiceId[], customPorts: string): string {
  const parts: string[] = [];
  if (services.includes("all")) {
    return copy.value.svcAllLabel;
  }
  for (const id of services) {
    const def = SERVICE_DEFS.find((d) => d.id === id);
    if (def) parts.push(copy.value[def.labelKey] as string);
  }
  if (customPorts) parts.push(customPorts);
  return parts.length > 0 ? parts.join(" · ") : copy.value.svcCustomLabel;
}

function tagIcon(tagName: string) {
  const lower = tagName.toLowerCase();
  if (lower.includes("server")) return Server;
  if (lower.includes("work") || lower.includes("laptop")) return Laptop;
  if (lower.includes("db") || lower.includes("data")) return Database;
  if (lower.includes("net") || lower.includes("router")) return Network;
  return Tag;
}

function userPickerOptions(selectedValues: readonly string[], groupOrder: number): MemberOption[] {
  const opts: MemberOption[] = [];
  for (const user of visibleUsers.value) {
    const id = policyPrincipalForUser(user);
    if (!id) continue;
    if (selectedValues.some((value) => userMatchesPolicyValue(user, value))) continue;
    opts.push({
      value: id,
      label: user.displayName || user.name || id,
      description: user.email || undefined,
      group: copy.value.optionGroupUsers,
      groupOrder,
    });
  }
  return opts;
}

function buildAccessOptions(selectedValues: readonly string[]): MemberOption[] {
  const opts: MemberOption[] = [];
  const takenGroups = new Set(selectedValues.map((value) => toPrincipal(value)));
  for (const group of policyGroups.value) {
    if (takenGroups.has(toPrincipal(group.name))) continue;
    opts.push({
      value: group.name,
      label: stripGroupPrefix(group.name),
      description: pluralize(group.members.length, "teamMembers"),
      group: copy.value.optionGroupTeams,
      groupOrder: 1,
    });
  }
  opts.push(...userPickerOptions(selectedValues, 2));
  return opts;
}

const accessorOptionsForCurrentTag = computed<MemberOption[]>(() =>
  buildAccessOptions((currentTagMeta.value?.accessors ?? []).map((a) => a.who)),
);

const ownerOptionsForCurrentTag = computed<MemberOption[]>(() =>
  buildAccessOptions(currentTagMeta.value?.owners ?? []),
);

const memberOptionsForCurrentTeam = computed<MemberOption[]>(() =>
  userPickerOptions(
    (currentTeamMeta.value?.group.members ?? []).map((member) => member.value),
    1,
  ),
);

function openCreateTeam() {
  teamDetailCurrent.value = "";
  teamDetailOpen.value = true;
}

function openTeamDetailFor(group: PolicyGroup) {
  teamDetailCurrent.value = group.name;
  teamDetailOpen.value = true;
}

function commitTeamName() {
  const display = teamNameDraft.value.trim();
  if (!display) return;
  const fullName = withGroupPrefix(display);

  if (!teamDetailCurrent.value) {
    const newGroup = createGroup(fullName, []);
    commitState(upsertGroup(policyDesignerState.value, newGroup));
    teamDetailCurrent.value = fullName;
    return;
  }

  if (teamDetailCurrent.value === fullName) return;

  const old = policyGroups.value.find((g) => g.name === teamDetailCurrent.value);
  if (!old) return;

  let next = removeGroupById(policyDesignerState.value, old.id);
  next = upsertGroup(next, { ...old, name: fullName });
  next = renameInRules(next, teamDetailCurrent.value, fullName);
  commitState(next);
  teamDetailCurrent.value = fullName;
}

function renameInRules(
  state: PolicyDesignerState,
  oldName: string,
  newName: string,
): PolicyDesignerState {
  return {
    ...state,
    rules: state.rules.map((rule) => {
      const sources = parseCommaList(rule.source).map((s) => (s === oldName ? newName : s));
      const destinations = parseCommaList(rule.destination).map((d) =>
        d === oldName ? newName : d,
      );
      return {
        ...rule,
        source: joinCommaList(sources) || rule.source,
        destination: joinCommaList(destinations) || rule.destination,
      };
    }),
  };
}

function addTeamMember(values: string[]) {
  if (!teamDetailCurrent.value) return;
  const value = values[0];
  if (!value) return;
  const group = policyGroups.value.find((g) => g.name === teamDetailCurrent.value);
  if (!group) return;
  if (group.members.some((m) => m.value === value)) return;
  const updated: PolicyGroup = {
    ...group,
    members: [...group.members, toMemberRef(value)],
  };
  commitState(upsertGroup(policyDesignerState.value, updated));
}

function removeTeamMember(value: string) {
  if (!teamDetailCurrent.value) return;
  const group = policyGroups.value.find((g) => g.name === teamDetailCurrent.value);
  if (!group) return;
  const updated: PolicyGroup = {
    ...group,
    members: group.members.filter((m) => m.value !== value),
  };
  commitState(upsertGroup(policyDesignerState.value, updated));
}

function openCreateTag() {
  tagDetailCurrent.value = "";
  tagDetailOpen.value = true;
}

function openTagDetailFor(tagName: string) {
  tagDetailCurrent.value = tagName;
  tagDetailOpen.value = true;
}

function commitTagName() {
  const display = tagNameDraft.value.trim();
  if (!display) return;
  const fullName = withTagPrefix(display);

  if (!tagDetailCurrent.value) {
    const newOwner = createTagOwner(fullName, []);
    commitState(upsertTagOwner(policyDesignerState.value, newOwner));
    tagDetailCurrent.value = fullName;
    return;
  }

  if (tagDetailCurrent.value === fullName) return;

  let next = policyDesignerState.value;
  const existing = policyTagOwners.value.find((o) => o.tag === tagDetailCurrent.value);
  if (existing) {
    next = removeTagOwnerById(next, existing.id);
    next = upsertTagOwner(next, { ...existing, tag: fullName });
  }
  next = renameInRules(next, tagDetailCurrent.value, fullName);
  commitState(next);
  tagDetailCurrent.value = fullName;
}

function ensureTagOwnerEntry(tagName: string): PolicyDesignerState {
  if (policyTagOwners.value.some((o) => o.tag === tagName)) {
    return policyDesignerState.value;
  }
  return upsertTagOwner(policyDesignerState.value, createTagOwner(tagName, []));
}

function addLabelManager(values: string[]) {
  if (!tagDetailCurrent.value) return;
  const value = values[0];
  if (!value) return;
  let next = ensureTagOwnerEntry(tagDetailCurrent.value);
  const entry = next.tagOwners.find((o) => o.tag === tagDetailCurrent.value);
  if (!entry) return;
  if (entry.owners.some((o) => o.value === value)) return;
  const updated = {
    ...entry,
    owners: [...entry.owners, toMemberRef(value)],
  };
  next = upsertTagOwner(next, updated);
  commitState(next);
}

function removeLabelManager(value: string) {
  if (!tagDetailCurrent.value) return;
  const entry = policyTagOwners.value.find((o) => o.tag === tagDetailCurrent.value);
  if (!entry) return;
  const updated = {
    ...entry,
    owners: entry.owners.filter((o) => o.value !== value),
  };
  commitState(upsertTagOwner(policyDesignerState.value, updated));
}

function tagAccessorByWho(who: string): TagAccessor | undefined {
  if (!tagDetailCurrent.value) return undefined;
  return currentTagMeta.value?.accessors.find((a) => a.who === who);
}

function addAccessor(values: string[]) {
  if (!tagDetailCurrent.value) return;
  const value = values[0];
  if (!value) return;
  if (tagAccessorByWho(value)) return;
  const isHighRisk = value === "*";
  const run = () => {
    commitState(setTagAccessor(policyDesignerState.value, tagDetailCurrent.value, value, "22"));
  };
  if (isHighRisk) {
    pendingHighRiskAction.value = run;
    highRiskConfirmOpen.value = true;
  } else {
    run();
  }
}

function removeAccessor(who: string) {
  if (!tagDetailCurrent.value) return;
  commitState(removeTagAccessor(policyDesignerState.value, tagDetailCurrent.value, who));
}

function toggleAccessorService(who: string, serviceId: ServiceId) {
  if (!tagDetailCurrent.value) return;
  const accessor = tagAccessorByWho(who);
  if (!accessor) return;

  let nextServices = [...accessor.services];
  if (serviceId === "all") {
    nextServices = nextServices.includes("all") ? [] : ["all"];
  } else if (nextServices.includes(serviceId)) {
    nextServices = nextServices.filter((s) => s !== serviceId);
  } else {
    nextServices = nextServices.filter((s) => s !== "all").concat(serviceId);
  }

  applyAccessorServices(who, nextServices, accessor.customPorts);
}

function applyAccessorServices(who: string, services: ServiceId[], custom: string) {
  if (!tagDetailCurrent.value) return;
  const ports = servicesToPortsString(services, custom);
  if (!ports) {
    commitState(removeTagAccessor(policyDesignerState.value, tagDetailCurrent.value, who));
    return;
  }

  const isHighRisk = ports === "*" || who === "*";
  const run = () => {
    commitState(setTagAccessor(policyDesignerState.value, tagDetailCurrent.value, who, ports));
  };
  if (isHighRisk) {
    pendingHighRiskAction.value = run;
    highRiskConfirmOpen.value = true;
  } else {
    run();
  }
}

const customPortDrafts = reactive<Record<string, string>>({});

watch(currentTagMeta, (meta) => {
  for (const a of meta?.accessors ?? []) {
    if (customPortDrafts[a.who] === undefined) {
      customPortDrafts[a.who] = a.customPorts;
    }
  }
});

function commitCustomPorts(who: string) {
  const accessor = tagAccessorByWho(who);
  if (!accessor) return;
  applyAccessorServices(who, accessor.services, customPortDrafts[who] ?? "");
}

function confirmHighRisk() {
  const fn = pendingHighRiskAction.value;
  if (fn) fn();
  pendingHighRiskAction.value = null;
  highRiskConfirmOpen.value = false;
}

function cancelHighRisk() {
  pendingHighRiskAction.value = null;
  highRiskConfirmOpen.value = false;
}

function requestRemoveTeam(group: PolicyGroup) {
  pendingPolicyRemoval.value = {
    kind: "group",
    id: group.id,
    label: stripGroupPrefix(group.name),
  };
  policyRemovalDialogOpen.value = true;
}

function requestRemoveTag(tagName: string) {
  const entry = policyTagOwners.value.find((o) => o.tag === tagName);
  pendingPolicyRemoval.value = {
    kind: "tagOwner",
    id: entry?.id ?? `inline-${tagName}`,
    label: stripTagPrefix(tagName),
  };
  policyRemovalDialogOpen.value = true;
}

function handlePolicyRemovalDialogOpen(open: boolean) {
  policyRemovalDialogOpen.value = open;
  if (open) return;
  window.setTimeout(() => {
    if (!policyRemovalDialogOpen.value) {
      pendingPolicyRemoval.value = null;
    }
  });
}

function confirmRemovePolicyItem() {
  const target = pendingPolicyRemoval.value;
  if (!target) return;

  let next = policyDesignerState.value;
  if (target.kind === "group") {
    const group = policyGroups.value.find((g) => g.id === target.id);
    if (group) {
      next = removeGroupById(next, group.id);
      next = stripValueFromRules(next, group.name);
      next = stripValueFromMembers(next, group.name);
    }
  } else if (target.kind === "tagOwner") {
    const entry = policyTagOwners.value.find((o) => o.id === target.id);
    if (entry) {
      next = removeTagOwnerById(next, entry.id);
      next = stripValueFromRules(next, entry.tag);
    } else {
      const tagName = withTagPrefix(target.label);
      next = stripValueFromRules(next, tagName);
    }
  }
  commitState(next);
  pendingPolicyRemoval.value = null;
  policyRemovalDialogOpen.value = false;
}

function stripValueFromRules(state: PolicyDesignerState, value: string): PolicyDesignerState {
  return {
    ...state,
    rules: state.rules
      .map((rule) => {
        const sources = parseCommaList(rule.source).filter((s) => s !== value);
        const destinations = parseCommaList(rule.destination).filter((d) => d !== value);
        return {
          ...rule,
          source: sources.length > 0 ? joinCommaList(sources) : "",
          destination: destinations.length > 0 ? joinCommaList(destinations) : "",
        };
      })
      .filter((r) => r.source && r.destination),
  };
}

function stripValueFromMembers(state: PolicyDesignerState, value: string): PolicyDesignerState {
  return {
    ...state,
    groups: state.groups.map((g) => ({
      ...g,
      members: g.members.filter((m) => m.value !== value),
    })),
    tagOwners: state.tagOwners.map((t) => ({
      ...t,
      owners: t.owners.filter((o) => o.value !== value),
    })),
  };
}

function removeIpRule(ruleId: string) {
  commitState({
    ...policyDesignerState.value,
    rules: policyDesignerState.value.rules.filter((r) => r.id !== ruleId),
  });
  if (editingIpRuleId.value === ruleId) editingIpRuleId.value = null;
}

function onUpdateIpRule(
  ruleId: string,
  patch: { source: string; destination: string; ports: string },
) {
  commitState(updateIpRule(policyDesignerState.value, ruleId, patch));
  editingIpRuleId.value = null;
}

function useTemplate(template: PolicyTemplate) {
  commitState(applyTemplate(policyDesignerState.value, template));
}

const { mutate } = useMutation({ skipRefresh: true });

async function savePolicy() {
  const nextDraft = JSON.stringify(policyPayload.value, null, 2);
  const ok = await mutate("save-policy" as ActionFeedbackKey, (client) =>
    client.setPolicy({ policy: nextDraft }),
  );
  // Only adopt the new "saved baseline" if the server actually accepted it.
  // Otherwise the dirty signal must stay so the user knows the change didn't
  // land and `saveAndClose` does not silently dismiss the dialog.
  if (ok) policyDraft.value = nextDraft;
}

// `policyDraft` originates from the server snapshot in whatever JSON shape the
// backend chose; `policyPayload` is rebuilt from the in-memory state with our
// own key ordering. Compare them through one round-trip of parse+serialize so
// pure formatting/key-order differences don't read as dirty.
//
// Important: an empty draft (fresh Headscale instance with no saved policy)
// still has to participate in the comparison — otherwise users on a blank
// policy could add a team and never see the unsaved indicator. `parsePolicy`
// already collapses `""` to `emptyState()`, which canonicalizes identically
// to a freshly-loaded empty state.
const isPolicyDirty = computed(() => {
  try {
    const draftCanonical = JSON.stringify(serializePolicy(parsePolicy(policyDraft.value)));
    const currentCanonical = JSON.stringify(serializePolicy(policyDesignerState.value));
    return draftCanonical !== currentCanonical;
  } catch {
    return true;
  }
});

type PendingClose = "tag" | "team" | null;
const pendingDialogClose = ref<PendingClose>(null);
const unsavedConfirmOpen = ref(false);

function attemptDialogClose(which: Exclude<PendingClose, null>) {
  if (isPolicyDirty.value) {
    pendingDialogClose.value = which;
    unsavedConfirmOpen.value = true;
    return;
  }
  if (which === "tag") tagDetailOpen.value = false;
  else teamDetailOpen.value = false;
}

function handleTagDialogOpen(open: boolean) {
  if (open) {
    tagDetailOpen.value = true;
    return;
  }
  attemptDialogClose("tag");
}

function handleTeamDialogOpen(open: boolean) {
  if (open) {
    teamDetailOpen.value = true;
    return;
  }
  attemptDialogClose("team");
}

// The footer "Done" button is a deliberate close — share the dirty-check path
// with Escape / outside-click so the user can't accidentally walk away from
// unsaved policy edits.
function finishPolicyDialog(which: "tag" | "team") {
  attemptDialogClose(which);
}

function closePendingDialog() {
  const which = pendingDialogClose.value;
  if (which === "tag") tagDetailOpen.value = false;
  else if (which === "team") teamDetailOpen.value = false;
  pendingDialogClose.value = null;
}

function discardAndClose() {
  unsavedConfirmOpen.value = false;
  // Revert in-memory edits back to the last saved snapshot so "close without
  // saving" really means discarded — otherwise the changes linger on the page
  // (and in the dirty badge) the next time the user opens the dialog.
  // `parsePolicy("")` is well-defined (returns `emptyState`), so a blank draft
  // — fresh Headscale instance — still gets a real reset, not a no-op.
  commitState(parsePolicy(policyDraft.value));
  closePendingDialog();
}

async function saveAndClose() {
  unsavedConfirmOpen.value = false;
  await savePolicy();
  if (!isPolicyDirty.value) closePendingDialog();
  else pendingDialogClose.value = null;
}

const cleanupOrphanRefsOpen = ref(false);

function cleanupOrphanRefs() {
  const orphans = orphanRefs.value;
  if (orphans.length === 0) {
    cleanupOrphanRefsOpen.value = false;
    return;
  }
  let next = policyDesignerState.value;
  for (const orphan of orphans) {
    if (orphan.kind === "group-member") {
      const group = next.groups.find((g) => g.id === orphan.containerId);
      if (!group) continue;
      next = upsertGroup(next, {
        ...group,
        members: group.members.filter((m) => m.value !== orphan.value),
      });
    } else {
      const owner = next.tagOwners.find((t) => t.id === orphan.containerId);
      if (!owner) continue;
      next = upsertTagOwner(next, {
        ...owner,
        owners: owner.owners.filter((o) => o.value !== orphan.value),
      });
    }
  }
  commitState(next);
  cleanupOrphanRefsOpen.value = false;
}
</script>

<template>
  <section class="space-y-3 sm:space-y-5" :dir="meta.dir">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold">{{ copy.resourceAccessTitle }}</h1>
        <p class="mt-1 text-sm text-muted-foreground">{{ copy.resourceAccessSubtitle }}</p>
      </div>
      <div class="flex items-center gap-2">
        <Badge
          v-if="isPolicyDirty && !isActionPending('save-policy')"
          variant="outline"
          class="border-amber-400/60 bg-amber-50/60 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300"
          data-testid="save-policy-dirty-badge"
        >
          <span
            class="me-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500"
            aria-hidden="true"
          />
          {{ copy.unsavedChangesBadge }}
        </Badge>
        <Button
          size="sm"
          data-testid="save-policy"
          :disabled="isActionPending('save-policy')"
          @click="savePolicy"
        >
          <LoaderCircle
            v-if="isActionPending('save-policy')"
            class="h-4 w-4 animate-spin"
            aria-hidden="true"
          />
          <FileCheck2 v-else class="h-4 w-4" aria-hidden="true" />
          {{ copy.savePolicy }}
        </Button>
      </div>
    </div>

    <p
      v-if="actionError('save-policy')"
      role="alert"
      class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      data-testid="save-policy-error"
    >
      {{ actionError("save-policy") }}
    </p>

    <div
      v-if="openAccessWarnings.length > 0"
      class="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      data-testid="open-access-banner"
    >
      <ShieldAlert class="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
      <div class="grid gap-0.5">
        <p class="font-medium">{{ copy.openAccessBannerTitle }}</p>
        <p class="text-xs">
          {{ pluralize(openAccessWarnings.length, "openAccessWarnings") }}
        </p>
      </div>
    </div>

    <div
      v-if="orphanRefs.length > 0"
      class="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
      data-testid="orphan-ref-banner"
    >
      <ShieldAlert class="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
      <div class="grid gap-0.5 flex-1">
        <p class="font-medium">{{ copy.orphanRefBannerTitle }}</p>
        <p class="text-xs">
          {{ pluralize(orphanRefs.length, "orphanReferences") }}
        </p>
      </div>
      <Button
        size="sm"
        variant="outline"
        class="shrink-0 border-amber-400/60 bg-background hover:bg-amber-100/60 dark:hover:bg-amber-500/20"
        data-testid="cleanup-orphan-refs"
        @click="cleanupOrphanRefsOpen = true"
      >
        <Eraser class="h-4 w-4" aria-hidden="true" />
        {{ pluralize(orphanRefs.length, "cleanupOrphans") }}
      </Button>
    </div>

    <div
      v-if="isEmptyState"
      class="rounded-md border bg-card p-6"
      data-testid="resource-access-empty"
    >
      <div class="text-center">
        <h2 class="text-lg font-semibold">{{ copy.resourceAccessEmptyTitle }}</h2>
        <p class="mt-1 text-sm text-muted-foreground">{{ copy.resourceAccessEmptyHint }}</p>
      </div>

      <p class="mt-5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {{ copy.templatesSectionTitle }}
      </p>
      <div class="mt-2 grid gap-3 md:grid-cols-3">
        <Card
          v-for="template in POLICY_TEMPLATES"
          :key="template.id"
          class="p-3 flex flex-col gap-2"
          :data-testid="`template-card-${template.id}`"
        >
          <p class="font-medium">{{ copy[template.titleKey as keyof typeof copy] }}</p>
          <p class="text-xs text-muted-foreground flex-1">
            {{ copy[template.descriptionKey as keyof typeof copy] }}
          </p>
          <Button
            size="sm"
            variant="outline"
            :data-testid="`template-apply-${template.id}`"
            @click="useTemplate(template)"
          >
            {{ copy.applyTemplate }}
          </Button>
        </Card>
      </div>

      <div class="mt-5 flex flex-wrap justify-center gap-2">
        <Button data-testid="empty-create-team" @click="openCreateTeam">
          <Plus class="h-4 w-4" aria-hidden="true" />
          {{ copy.newTeam }}
        </Button>
        <Button variant="outline" data-testid="empty-create-tag" @click="openCreateTag">
          <Plus class="h-4 w-4" aria-hidden="true" />
          {{ copy.newDeviceLabel }}
        </Button>
      </div>
    </div>

    <Card v-else class="p-4" data-testid="teams-section">
      <div class="flex items-center justify-between gap-2">
        <h2 class="text-base font-semibold flex items-center gap-2">
          <Users class="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {{ copy.teamsSection }}
          <Badge variant="secondary" class="ms-1">{{ policyGroups.length }}</Badge>
        </h2>
        <Button size="sm" data-testid="new-team" @click="openCreateTeam">
          <Plus class="h-4 w-4" aria-hidden="true" />
          {{ copy.newTeam }}
        </Button>
      </div>

      <div v-if="policyGroups.length === 0" class="mt-3 rounded-md border border-dashed bg-background/50 px-4 py-6 text-center text-sm text-muted-foreground">
        <p class="font-medium text-foreground">{{ copy.noTeamsYet }}</p>
        <p class="mt-1 text-xs">{{ copy.noTeamsHint }}</p>
      </div>

      <div v-else class="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <Card
          v-for="team in teamsWithMeta"
          :key="team.group.id"
          class="p-3 cursor-pointer hover:bg-accent/30 transition-colors"
          :data-testid="`team-card-${team.group.name}`"
          @click="openTeamDetailFor(team.group)"
        >
          <div class="flex items-start justify-between gap-2">
            <div class="grid gap-0.5 min-w-0">
              <p class="font-medium break-all">{{ team.displayName }}</p>
              <p class="text-xs text-muted-foreground">
                {{ pluralize(team.group.members.length, "teamMembers") }}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              :data-testid="`team-remove-${team.group.name}`"
              @click.stop="requestRemoveTeam(team.group)"
            >
              <Trash2 class="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
          <div v-if="team.group.members.length > 0" class="mt-2 flex flex-wrap gap-1">
            <Badge
              v-for="member in team.group.members.slice(0, 4)"
              :key="member.value"
              variant="outline"
              class="text-xs"
            >
              {{ whoDisplayLabel(member.value) }}
            </Badge>
            <Badge
              v-if="team.group.members.length > 4"
              variant="outline"
              class="text-xs"
            >
              +{{ team.group.members.length - 4 }}
            </Badge>
          </div>
        </Card>
      </div>
    </Card>

    <Card v-if="!isEmptyState" class="p-4" data-testid="device-labels-section">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="text-base font-semibold flex items-center gap-2 me-auto">
          <Tag class="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {{ copy.deviceLabelsSection }}
          <Badge variant="secondary" class="ms-1">{{ allTags.length }}</Badge>
        </h2>
        <div class="relative w-full sm:w-64">
          <Search
            class="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            v-model="tagSearchQuery"
            :placeholder="copy.searchDeviceLabels"
            data-testid="tag-search"
            class="ps-8"
          />
        </div>
        <Button size="sm" data-testid="new-device-label" @click="openCreateTag">
          <Plus class="h-4 w-4" aria-hidden="true" />
          {{ copy.newDeviceLabel }}
        </Button>
      </div>

      <div v-if="allTags.length === 0" class="mt-3 rounded-md border border-dashed bg-background/50 px-4 py-6 text-center text-sm text-muted-foreground">
        <p class="font-medium text-foreground">{{ copy.noDeviceLabelsYet }}</p>
        <p class="mt-1 text-xs">{{ copy.noDeviceLabelsHint }}</p>
      </div>

      <div v-else class="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <Card
          v-for="t in filteredTagsWithMeta"
          :key="t.tagName"
          class="p-3 cursor-pointer hover:border-primary/50 transition-colors"
          :data-testid="`tag-card-${t.tagName}`"
          @click="openTagDetailFor(t.tagName)"
        >
          <div class="flex items-start justify-between gap-2">
            <div class="flex items-start gap-2 min-w-0">
              <component
                :is="tagIcon(t.tagName)"
                class="h-5 w-5 mt-0.5 text-muted-foreground shrink-0"
                aria-hidden="true"
              />
              <div class="grid gap-0.5 min-w-0">
                <p class="font-medium break-all">{{ t.displayName }}</p>
                <p class="text-xs text-muted-foreground">
                  {{ pluralize(t.deviceCount, "devicesTagged") }}
                </p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              :data-testid="`tag-remove-${t.tagName}`"
              @click.stop="requestRemoveTag(t.tagName)"
            >
              <Trash2 class="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>

          <div class="mt-3 space-y-3 text-sm">
            <div>
              <p class="text-xs font-medium text-muted-foreground">
                {{ copy.tagAccessorsSection }}
              </p>
              <p
                v-if="t.accessors.length === 0"
                class="mt-1 text-xs text-muted-foreground italic"
              >
                {{ copy.noAccessors }}
              </p>
              <ul v-else class="mt-1 grid gap-1">
                <li
                  v-for="a in t.accessors.slice(0, 3)"
                  :key="a.who"
                  class="flex items-center gap-1.5"
                >
                  <Badge
                    variant="outline"
                    :title="isOrphanValue(a.who) ? copy.orphanReferenceTooltip : undefined"
                    :class="[
                      'inline-flex items-center gap-1 text-xs break-all',
                      isOrphanValue(a.who)
                        ? 'cursor-help border-amber-300/60 bg-amber-50/60 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300'
                        : '',
                    ]"
                  >
                    <UserX
                      v-if="isOrphanValue(a.who)"
                      class="h-3 w-3 shrink-0"
                      aria-hidden="true"
                    />
                    {{ whoDisplayLabel(a.who) }}
                  </Badge>
                  <span class="text-xs text-muted-foreground">
                    · {{ serviceSummary(a.services, a.customPorts) }}
                  </span>
                </li>
                <li v-if="t.accessors.length > 3" class="text-xs text-muted-foreground">
                  + {{ t.accessors.length - 3 }} …
                </li>
              </ul>
            </div>

            <div>
              <p class="text-xs font-medium text-muted-foreground">
                {{ copy.labelManagersLabel }}
              </p>
              <p
                v-if="t.owners.length === 0"
                class="mt-1 text-xs text-muted-foreground italic"
              >
                {{ copy.noLabelManagers }}
              </p>
              <div v-else class="mt-1 flex flex-wrap gap-1">
                <Badge
                  v-for="owner in t.owners.slice(0, 3)"
                  :key="owner"
                  :variant="isOrphanValue(owner) ? 'outline' : 'secondary'"
                  :title="isOrphanValue(owner) ? copy.orphanReferenceTooltip : undefined"
                  :class="[
                    'inline-flex items-center gap-1 text-xs break-all',
                    isOrphanValue(owner)
                      ? 'cursor-help border-amber-300/60 bg-amber-50/60 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300'
                      : '',
                  ]"
                >
                  <UserX
                    v-if="isOrphanValue(owner)"
                    class="h-3 w-3 shrink-0"
                    aria-hidden="true"
                  />
                  {{ whoDisplayLabel(owner) }}
                </Badge>
                <Badge
                  v-if="t.owners.length > 3"
                  variant="secondary"
                  class="text-xs"
                >
                  + {{ t.owners.length - 3 }}
                </Badge>
              </div>
            </div>
          </div>
        </Card>
      </div>
    </Card>

    <Card v-if="ipRules.length > 0" class="p-4" data-testid="ip-rules-section">
      <div class="flex items-start justify-between gap-2">
        <div>
          <h2 class="text-base font-semibold">
            {{ copy.ipRulesSectionTitle }}
            <Badge variant="outline" class="ms-1">{{ ipRules.length }}</Badge>
          </h2>
          <p class="mt-1 text-xs text-muted-foreground">{{ copy.ipRulesSectionHint }}</p>
        </div>
      </div>

      <div class="mt-3 grid gap-1">
        <IpRuleRow
          v-for="rule in ipRules"
          :key="rule.ruleId"
          :rule="rule"
          :is-editing="editingIpRuleId === rule.ruleId"
          @edit-start="editingIpRuleId = rule.ruleId"
          @edit-cancel="editingIpRuleId = null"
          @update="(patch) => onUpdateIpRule(rule.ruleId, patch)"
          @remove="removeIpRule(rule.ruleId)"
        />
      </div>
    </Card>

    <!-- Tag detail dialog -->
    <Dialog :open="tagDetailOpen" @update:open="handleTagDialogOpen">
      <DialogContent
        class="sm:max-w-2xl flex flex-col gap-0 p-0 max-h-[85vh] overflow-hidden"
        data-testid="tag-detail-dialog"
      >
        <DialogHeader class="shrink-0 px-6 py-4 border-b">
          <DialogTitle>
            {{ copy.tagDetailDialogTitle }}
            <span v-if="currentTagMeta" class="font-normal text-muted-foreground">
              · {{ currentTagMeta.displayName }}
            </span>
          </DialogTitle>
          <DialogDescription>
            {{ copy.tagDetailDialogSubtitle }}
          </DialogDescription>
          <p v-if="currentTagMeta" class="mt-1 text-xs text-muted-foreground">
            {{ pluralize(currentTagMeta.deviceCount, "devicesTagged") }}
          </p>
        </DialogHeader>

        <div class="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
          <div>
            <Label for="tag-name-input">{{ copy.deviceLabelName }}</Label>
            <div class="mt-2 flex gap-2">
              <Input
                id="tag-name-input"
                v-model="tagNameDraft"
                data-testid="tag-name-input"
                :placeholder="copy.deviceLabelNameHint"
                @blur="commitTagName"
                @keydown.enter.prevent="commitTagName"
              />
              <Button
                v-if="!tagDetailCurrent"
                type="button"
                variant="outline"
                :disabled="!tagNameDraft.trim()"
                data-testid="tag-name-confirm"
                @click="commitTagName"
              >
                {{ copy.confirm }}
              </Button>
            </div>
            <p class="mt-1 text-xs text-muted-foreground">{{ copy.deviceLabelNameHint }}</p>
          </div>

          <fieldset
            v-if="tagDetailCurrent"
            class="grid gap-2 rounded-md border p-3"
            data-testid="tag-accessors-section"
          >
            <legend class="px-1 text-sm font-medium">{{ copy.tagAccessorsSection }}</legend>

            <div v-if="currentTagMeta && currentTagMeta.accessors.length === 0" class="text-xs text-muted-foreground italic">
              {{ copy.noAccessors }}
            </div>

            <div
              v-else
              class="grid gap-2 max-h-80 overflow-y-auto pe-1"
              data-testid="tag-accessors-list"
            >
              <div
                v-for="a in currentTagMeta?.accessors ?? []"
                :key="a.who"
                class="grid gap-2 rounded-md border bg-background p-2"
                :data-testid="`tag-accessor-row-${a.who}`"
              >
                <div class="flex items-center justify-between gap-2">
                  <div class="flex items-center gap-2 min-w-0">
                    <Badge
                      :variant="isOrphanValue(a.who) ? 'outline' : 'secondary'"
                      :title="isOrphanValue(a.who) ? copy.orphanReferenceTooltip : undefined"
                      :class="[
                        'text-xs',
                        isOrphanValue(a.who)
                          ? 'cursor-help border-amber-300/60 bg-amber-50/60 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300'
                          : '',
                      ]"
                    >
                      {{ isOrphanValue(a.who) ? copy.orphanReferenceBadge : whoDisplayKind(a.who) }}
                    </Badge>
                    <bdi dir="auto" class="font-medium break-all">{{ whoDisplayLabel(a.who) }}</bdi>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    :aria-label="copy.removeAccessor"
                    :data-testid="`tag-accessor-remove-${a.who}`"
                    @click="removeAccessor(a.who)"
                  >
                    <Trash2 class="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
                <div class="flex flex-wrap gap-3 text-sm">
                  <label
                    v-for="def in SERVICE_DEFS"
                    :key="def.id"
                    class="flex items-center gap-1.5 cursor-pointer"
                  >
                    <Checkbox
                      :model-value="a.services.includes(def.id)"
                      :data-testid="`tag-accessor-svc-${a.who}-${def.id}`"
                      @update:model-value="toggleAccessorService(a.who, def.id)"
                    />
                    <span>{{ copy[def.labelKey] }}</span>
                  </label>
                  <label class="flex items-center gap-1.5 cursor-pointer">
                    <Checkbox
                      :model-value="a.services.includes('all')"
                      :data-testid="`tag-accessor-svc-${a.who}-all`"
                      @update:model-value="toggleAccessorService(a.who, 'all')"
                    />
                    <span>{{ copy.svcAllLabel }}</span>
                  </label>
                </div>
                <div class="grid gap-1.5">
                  <Label class="text-xs">{{ copy.svcCustomLabel }}</Label>
                  <Input
                    v-model="customPortDrafts[a.who]"
                    class="h-8 text-xs"
                    :placeholder="copy.svcCustomPlaceholder"
                    :data-testid="`tag-accessor-custom-${a.who}`"
                    @blur="commitCustomPorts(a.who)"
                    @keydown.enter.prevent="commitCustomPorts(a.who)"
                  />
                </div>
              </div>
            </div>

            <MemberMultiSelect
              single
              :model-value="[]"
              :options="accessorOptionsForCurrentTag"
              :trigger-label="copy.addAccessor"
              :search-placeholder="copy.selectAccessorSearchPlaceholder"
              :empty-text="copy.selectAccessorEmpty"
              testid="tag-add-accessor"
              @update:model-value="addAccessor"
            />
          </fieldset>

          <fieldset
            v-if="tagDetailCurrent"
            class="grid gap-2 rounded-md border p-3"
            data-testid="tag-owners-section"
          >
            <legend class="px-1 text-sm font-medium">{{ copy.tagOwnersSection }}</legend>

            <div
              v-if="(currentTagMeta?.owners ?? []).length === 0"
              class="text-xs text-muted-foreground italic"
            >
              {{ copy.noLabelManagers }}
            </div>
            <div
              v-else
              class="grid gap-1 max-h-64 overflow-y-auto pe-1"
              data-testid="tag-owners-list"
            >
              <div
                v-for="owner in currentTagMeta?.owners ?? []"
                :key="owner"
                class="flex items-center justify-between gap-2 rounded-md border bg-background p-2"
                :data-testid="`tag-owner-row-${owner}`"
              >
                <div class="flex items-center gap-2 min-w-0">
                  <Badge
                    :variant="isOrphanValue(owner) ? 'outline' : 'secondary'"
                    :title="isOrphanValue(owner) ? copy.orphanReferenceTooltip : undefined"
                    :class="[
                      'text-xs',
                      isOrphanValue(owner)
                        ? 'cursor-help border-amber-300/60 bg-amber-50/60 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300'
                        : '',
                    ]"
                  >
                    {{ isOrphanValue(owner) ? copy.orphanReferenceBadge : whoDisplayKind(owner) }}
                  </Badge>
                  <span class="font-medium break-all">{{ whoDisplayLabel(owner) }}</span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  :aria-label="copy.removeLabelManager"
                  :data-testid="`tag-owner-remove-${owner}`"
                  @click="removeLabelManager(owner)"
                >
                  <Trash2 class="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </div>

            <MemberMultiSelect
              single
              :model-value="[]"
              :options="ownerOptionsForCurrentTag"
              :trigger-label="copy.addLabelManager"
              :search-placeholder="copy.selectLabelManagerSearchPlaceholder"
              :empty-text="copy.selectLabelManagerEmpty"
              testid="tag-add-owner"
              @update:model-value="addLabelManager"
            />
          </fieldset>
        </div>

        <DialogFooter
          class="shrink-0 px-6 py-4 border-t flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
        >
          <p
            v-if="isPolicyDirty"
            class="flex items-center gap-1.5 rounded-md border border-amber-400/60 bg-amber-50/60 px-2 py-1 text-xs text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300 sm:text-start"
            data-testid="tag-dialog-unsaved-hint"
          >
            <span
              class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500"
              aria-hidden="true"
            />
            {{ copy.changesAutoSaveHint }}
          </p>
          <span v-else class="text-xs text-muted-foreground">&nbsp;</span>
          <Button data-testid="tag-detail-close" @click="finishPolicyDialog('tag')">
            {{ copy.finish }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Team detail dialog -->
    <Dialog :open="teamDetailOpen" @update:open="handleTeamDialogOpen">
      <DialogContent
        class="sm:max-w-2xl flex flex-col gap-0 p-0 max-h-[85vh] overflow-hidden"
        data-testid="team-detail-dialog"
      >
        <DialogHeader class="shrink-0 px-6 py-4 border-b">
          <DialogTitle>
            {{ copy.teamDetailDialogTitle }}
            <span v-if="currentTeamMeta" class="font-normal text-muted-foreground">
              · {{ currentTeamMeta.displayName }}
            </span>
          </DialogTitle>
          <DialogDescription>{{ copy.teamNameHint }}</DialogDescription>
        </DialogHeader>

        <div class="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
          <div>
            <Label for="team-name-input">{{ copy.teamName }}</Label>
            <div class="mt-2 flex gap-2">
              <Input
                id="team-name-input"
                v-model="teamNameDraft"
                data-testid="team-name-input"
                :placeholder="copy.teamNameHint"
                @blur="commitTeamName"
                @keydown.enter.prevent="commitTeamName"
              />
              <Button
                v-if="!teamDetailCurrent"
                type="button"
                variant="outline"
                :disabled="!teamNameDraft.trim()"
                data-testid="team-name-confirm"
                @click="commitTeamName"
              >
                {{ copy.confirm }}
              </Button>
            </div>
          </div>

          <fieldset
            v-if="teamDetailCurrent"
            class="grid gap-2 rounded-md border p-3"
            data-testid="team-members-section"
          >
            <legend class="px-1 text-sm font-medium">{{ copy.teamMembersSection }}</legend>

            <div v-if="(currentTeamMeta?.group.members ?? []).length === 0" class="text-xs text-muted-foreground italic">
              —
            </div>
            <div
              v-else
              class="grid gap-1 max-h-64 overflow-y-auto pe-1"
              data-testid="team-members-list"
            >
              <div
                v-for="m in currentTeamMeta?.group.members ?? []"
                :key="m.value"
                class="flex items-center justify-between gap-2 rounded-md border bg-background p-2"
                :data-testid="`team-member-row-${m.value}`"
              >
                <div class="flex items-center gap-2 min-w-0">
                  <Badge
                    :variant="isOrphanValue(m.value) ? 'outline' : 'secondary'"
                    :title="isOrphanValue(m.value) ? copy.orphanReferenceTooltip : undefined"
                    :class="[
                      'text-xs',
                      isOrphanValue(m.value)
                        ? 'cursor-help border-amber-300/60 bg-amber-50/60 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300'
                        : '',
                    ]"
                  >
                    {{ isOrphanValue(m.value) ? copy.orphanReferenceBadge : whoDisplayKind(m.value) }}
                  </Badge>
                  <bdi dir="auto" class="font-medium break-all">{{ whoDisplayLabel(m.value) }}</bdi>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  :aria-label="copy.removeTeamMember"
                  :data-testid="`team-member-remove-${m.value}`"
                  @click="removeTeamMember(m.value)"
                >
                  <X class="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </div>

            <MemberMultiSelect
              single
              :model-value="[]"
              :options="memberOptionsForCurrentTeam"
              :trigger-label="copy.addMemberToTeam"
              :search-placeholder="copy.selectMemberSearchPlaceholder"
              :empty-text="copy.selectMemberEmpty"
              testid="team-add-member"
              @update:model-value="addTeamMember"
            />
          </fieldset>

          <fieldset
            v-if="teamDetailCurrent"
            class="grid gap-2 rounded-md border p-3"
            data-testid="team-access-view"
          >
            <legend class="px-1 text-sm font-medium">{{ copy.teamAccessView }}</legend>
            <p class="text-xs text-muted-foreground">{{ copy.teamAccessViewHint }}</p>
            <div v-if="(currentTeamMeta?.accessRows ?? []).length === 0" class="text-xs text-muted-foreground italic">
              {{ copy.noTeamAccess }}
            </div>
            <div
              v-else
              class="grid gap-1 max-h-64 overflow-y-auto pe-1"
              data-testid="team-access-list"
            >
              <div
                v-for="row in currentTeamMeta?.accessRows ?? []"
                :key="row.tagName"
                class="flex items-center justify-between gap-2 rounded-md border bg-background p-2 text-sm"
                :data-testid="`team-access-row-${row.tagName}`"
              >
                <span class="break-all">{{ stripTagPrefix(row.tagName) }}</span>
                <span class="text-xs text-muted-foreground">
                  {{ serviceSummary(row.services, row.customPorts) }}
                </span>
              </div>
            </div>
          </fieldset>
        </div>

        <DialogFooter
          class="shrink-0 px-6 py-4 border-t flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
        >
          <p
            v-if="isPolicyDirty"
            class="flex items-center gap-1.5 rounded-md border border-amber-400/60 bg-amber-50/60 px-2 py-1 text-xs text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300 sm:text-start"
            data-testid="team-dialog-unsaved-hint"
          >
            <span
              class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500"
              aria-hidden="true"
            />
            {{ copy.changesAutoSaveHint }}
          </p>
          <span v-else class="text-xs text-muted-foreground">&nbsp;</span>
          <Button data-testid="team-detail-close" @click="finishPolicyDialog('team')">
            {{ copy.finish }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- High risk confirm -->
    <AlertDialog v-model:open="highRiskConfirmOpen">
      <AlertDialogContent data-testid="high-risk-confirm-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{{ copy.highRiskConfirmTitle }}</AlertDialogTitle>
          <AlertDialogDescription>
            {{ copy.highRiskConfirmDescription }}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="high-risk-cancel" @click="cancelHighRisk">
            {{ copy.cancel }}
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="high-risk-confirm"
            class="bg-destructive text-white hover:bg-destructive/90"
            @click="confirmHighRisk"
          >
            {{ copy.proceed ?? "Proceed" }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <!-- Removal confirm -->
    <AlertDialog
      :open="policyRemovalDialogOpen"
      @update:open="handlePolicyRemovalDialogOpen"
    >
      <AlertDialogContent data-testid="remove-policy-item-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{{ copy.confirmRemovePolicyItemTitle }}</AlertDialogTitle>
          <AlertDialogDescription>
            {{ copy.confirmRemovePolicyItemDescription }}
            <span
              v-if="pendingPolicyRemoval"
              class="mt-2 block break-all font-medium text-foreground"
            >
              {{ pendingPolicyRemoval.label }}
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="cancel-remove-policy-item">{{
            copy.cancel
          }}</AlertDialogCancel>
          <AlertDialogAction
            data-testid="confirm-remove-policy-item"
            class="bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40"
            @click="confirmRemovePolicyItem"
          >
            {{ copy.removeItem }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <!-- Unsaved-changes confirm when closing a policy dialog -->
    <AlertDialog v-model:open="unsavedConfirmOpen">
      <AlertDialogContent data-testid="unsaved-changes-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{{ copy.unsavedChangesTitle }}</AlertDialogTitle>
          <AlertDialogDescription>{{ copy.unsavedChangesBody }}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="unsaved-changes-keep-editing">{{
            copy.cancel
          }}</AlertDialogCancel>
          <Button
            type="button"
            variant="outline"
            data-testid="unsaved-changes-discard"
            @click="discardAndClose"
          >
            {{ copy.unsavedChangesCloseAnyway }}
          </Button>
          <Button
            type="button"
            data-testid="unsaved-changes-save"
            :disabled="isActionPending('save-policy')"
            @click="saveAndClose"
          >
            <LoaderCircle
              v-if="isActionPending('save-policy')"
              class="h-4 w-4 animate-spin"
              aria-hidden="true"
            />
            {{ copy.unsavedChangesSaveAndClose }}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <!-- Clean up orphan references confirm -->
    <AlertDialog v-model:open="cleanupOrphanRefsOpen">
      <AlertDialogContent data-testid="cleanup-orphans-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{{ copy.cleanupOrphanRefsConfirm }}</AlertDialogTitle>
          <AlertDialogDescription>
            {{ copy.cleanupOrphanRefsConfirmBody }}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="cleanup-orphans-cancel">{{
            copy.cancel
          }}</AlertDialogCancel>
          <AlertDialogAction
            data-testid="cleanup-orphans-confirm"
            @click="cleanupOrphanRefs"
          >
            {{ pluralize(orphanRefs.length, "cleanupOrphans") }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

  </section>
</template>
