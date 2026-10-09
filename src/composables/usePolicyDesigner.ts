import { type ComputedRef, computed, type Ref, reactive, ref } from "vue";
import {
  createGroup as createPolicyGroup,
  createTagOwner as createPolicyTagOwner,
  type PolicyDesignerState,
  type PolicyGroup,
  type PolicyMemberRef,
  type PolicyRule,
  type PolicyTagOwner,
  parsePolicy,
  removeGroupById,
  removeRuleById,
  removeTagOwnerById,
  serializePolicy,
  toMemberRef,
  upsertGroup,
  upsertTagOwner,
} from "@/domain/policy-designer";

type PolicyWorkspaceTab = "rules" | "groups" | "tags" | "review";
export type PolicyBuilderSlot = "source" | "destination" | "ports";
type PolicyRemovalTarget = {
  kind: "rule" | "group" | "tagOwner";
  id: string;
  label: string;
};
export type PolicyChoice = {
  id: string;
  slot: PolicyBuilderSlot;
  label: string;
  value: string;
  description: string;
};
export type PolicyListChoice = {
  id: string;
  label: string;
  value: string;
  description: string;
};

interface PolicyRuleForm {
  source: string;
  destination: string;
  ports: string;
}

interface PolicyGroupForm {
  name: string;
  members: PolicyMemberRef[];
}

interface PolicyTagOwnerForm {
  tag: string;
  owners: PolicyMemberRef[];
}

interface UsePolicyDesignerReturn {
  policyDraft: Ref<string>;
  policyRules: Ref<PolicyRule[]>;
  policyGroups: Ref<PolicyGroup[]>;
  policyTagOwners: Ref<PolicyTagOwner[]>;
  policyExtraSections: Ref<Record<string, unknown>>;
  activePolicyTab: Ref<PolicyWorkspaceTab>;
  policyRuleDialogOpen: Ref<boolean>;
  policyGroupDialogOpen: Ref<boolean>;
  policyTagOwnerDialogOpen: Ref<boolean>;
  policyRemovalDialogOpen: Ref<boolean>;
  pendingPolicyRemoval: Ref<PolicyRemovalTarget | null>;
  policyRuleForm: PolicyRuleForm;
  policyGroupForm: PolicyGroupForm;
  policyTagOwnerForm: PolicyTagOwnerForm;
  policyGroupMemberSelection: Ref<string>;
  policyTagOwnerSelection: Ref<string>;
  policyRuleSearch: Ref<string>;
  policyGroupSearch: Ref<string>;
  policyTagOwnerSearch: Ref<string>;
  policyGroupEditing: Ref<PolicyGroup | null>;
  policyTagOwnerEditing: Ref<PolicyTagOwner | null>;
  // Resource-centric dialog state
  tagDetailOpen: Ref<boolean>;
  tagDetailCurrent: Ref<string>;
  teamDetailOpen: Ref<boolean>;
  teamDetailCurrent: Ref<string>;
  highRiskConfirmOpen: Ref<boolean>;
  pendingHighRiskAction: Ref<(() => void) | null>;
  policyDesignerState: ComputedRef<PolicyDesignerState>;
  policyPayload: ComputedRef<Record<string, unknown>>;
  isPolicyDirty: ComputedRef<boolean>;
  editingIpRuleId: Ref<string | null>;
  assignMembershipsOpen: Ref<boolean>;
  assignTagOwnershipsOpen: Ref<boolean>;
  isPolicyEditing: ComputedRef<boolean>;
  policyExtraSectionKeys: ComputedRef<string[]>;
  policyRiskCount: ComputedRef<number>;
  filteredPolicyGroups: ComputedRef<PolicyGroup[]>;
  filteredPolicyTagOwners: ComputedRef<PolicyTagOwner[]>;
  load(policyText: string): void;
  closeAccessEditors(): void;
  commitState(next: PolicyDesignerState): void;
  addPolicyRule(): void;
  addPolicyGroup(): void;
  addPolicyTagOwner(): void;
  removeRule(id: string): void;
  removeGroup(id: string): void;
  removeTagOwner(id: string): void;
  policyChoiceId(slot: PolicyBuilderSlot, value: string): string;
  isPolicyRuleHighRisk(rule: Pick<PolicyRule, "source" | "destination" | "ports">): boolean;
  addUniqueMemberRef(current: PolicyMemberRef[], value: string): PolicyMemberRef[];
}

function createPolicyEntityId(): string {
  return crypto.randomUUID();
}

function policyChoiceId(slot: PolicyBuilderSlot, value: string): string {
  const normalized = value
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return `${slot}-${normalized || "any"}`;
}

function isPolicyRuleHighRisk(rule: Pick<PolicyRule, "source" | "destination" | "ports">): boolean {
  return rule.source.trim() === "*" && rule.destination.trim() === "*" && rule.ports.trim() === "*";
}

function addUniqueMemberRef(current: PolicyMemberRef[], value: string): PolicyMemberRef[] {
  const trimmed = value.trim();
  if (!trimmed || current.some((m) => m.value === trimmed)) {
    return current;
  }
  return [...current, toMemberRef(trimmed)];
}

let instance: UsePolicyDesignerReturn | null = null;

/** Internal: invoked by `__testing.ts` only. */
export const policyDesignerTestingHandle = {
  reset() {
    instance = null;
  },
};

export function usePolicyDesigner(): UsePolicyDesignerReturn {
  if (instance) return instance;

  const policyDraft = ref("");
  const policyRules = ref<PolicyRule[]>([]);
  const policyGroups = ref<PolicyGroup[]>([]);
  const policyTagOwners = ref<PolicyTagOwner[]>([]);
  const policyExtraSections = ref<Record<string, unknown>>({});
  const activePolicyTab = ref<PolicyWorkspaceTab>("rules");

  const policyRuleDialogOpen = ref(false);
  const policyGroupDialogOpen = ref(false);
  const policyTagOwnerDialogOpen = ref(false);
  const policyRemovalDialogOpen = ref(false);
  const pendingPolicyRemoval = ref<PolicyRemovalTarget | null>(null);

  const policyRuleForm = reactive<PolicyRuleForm>({
    source: "*",
    destination: "*",
    ports: "*",
  });
  const policyGroupForm = reactive<PolicyGroupForm>({
    name: "group:ops",
    members: [toMemberRef("alice@example.com")],
  });
  const policyTagOwnerForm = reactive<PolicyTagOwnerForm>({
    tag: "tag:server",
    owners: [toMemberRef("group:ops")],
  });
  const policyGroupMemberSelection = ref("");
  const policyTagOwnerSelection = ref("");

  const policyRuleSearch = ref("");
  const policyGroupSearch = ref("");
  const policyTagOwnerSearch = ref("");
  const policyGroupEditing = ref<PolicyGroup | null>(null);
  const policyTagOwnerEditing = ref<PolicyTagOwner | null>(null);

  const tagDetailOpen = ref(false);
  const tagDetailCurrent = ref("");
  const teamDetailOpen = ref(false);
  const teamDetailCurrent = ref("");
  const highRiskConfirmOpen = ref(false);
  const pendingHighRiskAction = ref<(() => void) | null>(null);
  const editingIpRuleId = ref<string | null>(null);
  const assignMembershipsOpen = ref(false);
  const assignTagOwnershipsOpen = ref(false);
  const isPolicyEditing = computed(
    () =>
      editingIpRuleId.value !== null ||
      assignMembershipsOpen.value ||
      assignTagOwnershipsOpen.value ||
      tagDetailOpen.value ||
      teamDetailOpen.value ||
      policyRuleDialogOpen.value ||
      policyGroupDialogOpen.value ||
      policyTagOwnerDialogOpen.value ||
      policyRemovalDialogOpen.value ||
      highRiskConfirmOpen.value,
  );

  const policyDesignerState = computed<PolicyDesignerState>(() => ({
    rules: policyRules.value,
    groups: policyGroups.value,
    tagOwners: policyTagOwners.value,
    extras: policyExtraSections.value,
  }));
  const policyPayload = computed(() => serializePolicy(policyDesignerState.value));
  const isPolicyDirty = computed(() => {
    try {
      // Normalize server formatting and key order, including an absent policy.
      const baseline = JSON.stringify(serializePolicy(parsePolicy(policyDraft.value)));
      return baseline !== JSON.stringify(policyPayload.value);
    } catch {
      return true;
    }
  });
  const policyExtraSectionKeys = computed(() => Object.keys(policyExtraSections.value).sort());
  const policyRiskCount = computed(() => {
    let count = 0;
    for (const rule of policyRules.value) {
      if (isPolicyRuleHighRisk(rule)) {
        count += 1;
      }
    }
    return count;
  });

  const filteredPolicyGroups = computed(() => {
    const query = policyGroupSearch.value.trim().toLowerCase();
    if (!query) {
      return policyGroups.value;
    }
    return policyGroups.value.filter((group) =>
      [group.name, ...group.members.map((m) => m.value)].join(" ").toLowerCase().includes(query),
    );
  });

  const filteredPolicyTagOwners = computed(() => {
    const query = policyTagOwnerSearch.value.trim().toLowerCase();
    if (!query) {
      return policyTagOwners.value;
    }
    return policyTagOwners.value.filter((tagOwner) =>
      [tagOwner.tag, ...tagOwner.owners.map((o) => o.value)]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  });

  function load(policyText: string) {
    closeAccessEditors();
    assignMembershipsOpen.value = false;
    assignTagOwnershipsOpen.value = false;
    const state = parsePolicy(policyText);
    policyRules.value = state.rules;
    policyGroups.value = state.groups;
    policyTagOwners.value = state.tagOwners;
    policyExtraSections.value = state.extras;
    policyDraft.value = policyText;
  }

  function closeAccessEditors() {
    editingIpRuleId.value = null;
    tagDetailOpen.value = false;
    tagDetailCurrent.value = "";
    teamDetailOpen.value = false;
    teamDetailCurrent.value = "";
    policyRuleDialogOpen.value = false;
    policyGroupDialogOpen.value = false;
    policyTagOwnerDialogOpen.value = false;
    policyRemovalDialogOpen.value = false;
    pendingPolicyRemoval.value = null;
    policyGroupEditing.value = null;
    policyTagOwnerEditing.value = null;
    highRiskConfirmOpen.value = false;
    pendingHighRiskAction.value = null;
  }

  function commitState(next: PolicyDesignerState) {
    policyRules.value = next.rules;
    policyGroups.value = next.groups;
    policyTagOwners.value = next.tagOwners;
    policyExtraSections.value = next.extras;
  }

  function addPolicyRule() {
    policyRules.value = [
      ...policyRules.value,
      {
        id: createPolicyEntityId(),
        action: "accept" as const,
        source: policyRuleForm.source || "*",
        destination: policyRuleForm.destination || "*",
        ports: policyRuleForm.ports || "*",
      },
    ];
    policyRuleDialogOpen.value = false;
  }

  function addPolicyGroup() {
    const name = policyGroupForm.name.trim();
    if (!name) {
      return;
    }
    const editing = policyGroupEditing.value;
    const group: PolicyGroup = editing
      ? { ...editing, name, members: [...policyGroupForm.members] }
      : createPolicyGroup(name, [...policyGroupForm.members]);
    commitState(upsertGroup(policyDesignerState.value, group));
    policyGroupDialogOpen.value = false;
    policyGroupEditing.value = null;
  }

  function addPolicyTagOwner() {
    const tag = policyTagOwnerForm.tag.trim();
    if (!tag) {
      return;
    }
    const editing = policyTagOwnerEditing.value;
    const tagOwner: PolicyTagOwner = editing
      ? { ...editing, tag, owners: [...policyTagOwnerForm.owners] }
      : createPolicyTagOwner(tag, [...policyTagOwnerForm.owners]);
    commitState(upsertTagOwner(policyDesignerState.value, tagOwner));
    policyTagOwnerDialogOpen.value = false;
    policyTagOwnerEditing.value = null;
  }

  function removeRule(id: string) {
    commitState(removeRuleById(policyDesignerState.value, id));
  }

  function removeGroup(id: string) {
    commitState(removeGroupById(policyDesignerState.value, id));
  }

  function removeTagOwner(id: string) {
    commitState(removeTagOwnerById(policyDesignerState.value, id));
  }

  instance = {
    policyDraft,
    policyRules,
    policyGroups,
    policyTagOwners,
    policyExtraSections,
    activePolicyTab,
    policyRuleDialogOpen,
    policyGroupDialogOpen,
    policyTagOwnerDialogOpen,
    policyRemovalDialogOpen,
    pendingPolicyRemoval,
    policyRuleForm,
    policyGroupForm,
    policyTagOwnerForm,
    policyGroupMemberSelection,
    policyTagOwnerSelection,
    policyRuleSearch,
    policyGroupSearch,
    policyTagOwnerSearch,
    policyGroupEditing,
    policyTagOwnerEditing,
    tagDetailOpen,
    tagDetailCurrent,
    teamDetailOpen,
    teamDetailCurrent,
    highRiskConfirmOpen,
    pendingHighRiskAction,
    policyDesignerState,
    policyPayload,
    isPolicyDirty,
    editingIpRuleId,
    assignMembershipsOpen,
    assignTagOwnershipsOpen,
    isPolicyEditing,
    policyExtraSectionKeys,
    policyRiskCount,
    filteredPolicyGroups,
    filteredPolicyTagOwners,
    load,
    closeAccessEditors,
    commitState,
    addPolicyRule,
    addPolicyGroup,
    addPolicyTagOwner,
    removeRule,
    removeGroup,
    removeTagOwner,
    policyChoiceId,
    isPolicyRuleHighRisk,
    addUniqueMemberRef,
  };
  return instance;
}
