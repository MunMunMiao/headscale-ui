<script setup lang="ts">
import {
  CircleUserRound,
  Download,
  EllipsisVertical,
  FileCheck2,
  KeyRound,
  LoaderCircle,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Users,
} from "lucide-vue-next";
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import type { HeadscaleClient, HeadscaleNode, HeadscaleUser, PreAuthKey } from "@/api/types";
import AssignMemberDialog, { type AssignMemberOption } from "@/components/AssignMemberDialog.vue";
import CreateAuthKeyDialog from "@/components/CreateAuthKeyDialog.vue";
import type {
  AuthKeyDialogDefaults,
  AuthKeyDialogLabels,
  AuthKeyDialogPayload,
} from "@/components/create-auth-key-dialog";
import {
  AlertDialog,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type ActionFeedbackKey, useActionFeedback } from "@/composables/useActionFeedback";
import { useDisplayHelpers } from "@/composables/useDisplayHelpers";
import { useMutation } from "@/composables/useMutation";
import { usePolicyDesigner } from "@/composables/usePolicyDesigner";
import { useProductCopy } from "@/composables/useProductCopy";
import { useRefreshGuard } from "@/composables/useRefreshGuard";
import { useRouteIntent } from "@/composables/useRouteIntent";
import { useSnapshot } from "@/composables/useSnapshot";
import { useSegment } from "@/composables/useSnapshotSegment";
import { isTimestampExpired as isExpired, nodeConnectionStatus } from "@/domain/node-status";
import {
  addMemberToGroup,
  addOwnerToTag,
  removeMemberFromGroup,
  removeOwnerFromTag,
  removeReferencesToValues,
  serializePolicy,
  toMemberRef,
} from "@/domain/policy-designer";
import { policyPrincipalForUser, userPolicyPrincipals } from "@/domain/principal";
import { useHeadscaleI18n } from "@/i18n";
import { downloadCsv } from "@/utils/csv";
import { nodePendingRoutes } from "@/utils/node";
import { nodeStatusClass } from "@/utils/status-class";

type UserFilter = "all" | "owner" | "member" | "service";

interface UserPolicyReference {
  kind: "group" | "tagOwner";
  id: string;
  label: string;
  matchedValues: string[];
}

const { t, locale } = useHeadscaleI18n();
const { copy } = useProductCopy();
const { snapshot, refreshSnapshot, userById: currentUser } = useSnapshot();
const { isRefreshing: isRefreshingSnapshot, refresh: refreshMembers } = useSegment("identity");
const { isActionPending, actionError, clearActionFeedback } = useActionFeedback();
const {
  policyDraft,
  policyGroups,
  policyTagOwners,
  policyDesignerState,
  commitState: commitPolicyState,
} = usePolicyDesigner();

const router = useRouter();
const intent = useRouteIntent();

const userSearch = ref("");
const userFilter = ref<UserFilter>("all");
const memberDialogOpen = ref(false);
const selectedRenameUser = ref<HeadscaleUser | null>(null);
const pendingDeleteUser = ref<HeadscaleUser | null>(null);
const cleanupPolicyOnDelete = ref(true);
const selectedDetailUser = ref<HeadscaleUser | null>(null);
const inviteDialogOpen = ref(false);
const assignMembershipsOpen = ref(false);
const assignTagOwnershipsOpen = ref(false);
const assignMembershipsTarget = ref<HeadscaleUser | null>(null);
const assignTagOwnershipsTarget = ref<HeadscaleUser | null>(null);

const memberForm = reactive({
  name: "",
  displayName: "",
  email: "",
});
const renameMemberForm = reactive({
  name: "",
});
const inviteForm = reactive({
  user: "1",
  reusable: true,
  ephemeral: false,
  expiration: "2026-12-31T23:59:00Z",
  aclTags: "",
});

const userDetailGuard = useRefreshGuard();
const inviteDialogGuard = useRefreshGuard();

const isCreatingInvite = computed(() => isActionPending("create-invite"));

const {
  formatDate,
  userLabel,
  nodeDisplayName,
  nodeStatusLabel,
  shortSecret,
  hasVisibleUser,
  isTagManagedDeviceUser,
} = useDisplayHelpers();

function userAuthSource(user: HeadscaleUser) {
  return user.provider || user.providerId || "-";
}

function userRoleKind(user: HeadscaleUser): Exclude<UserFilter, "all"> {
  if (userAuthSource(user).toLowerCase() === "system" || user.name.includes("tagged")) {
    return "service";
  }
  if (user.id === "1") {
    return "owner";
  }
  return "member";
}

function userRole(user: HeadscaleUser) {
  const role = userRoleKind(user);
  if (role === "service") {
    return copy.value.roleServiceAccount;
  }
  if (role === "owner") {
    return copy.value.roleOwner;
  }
  return copy.value.roleMember;
}

function userDevices(user: HeadscaleUser) {
  return snapshot.value.nodes.filter(
    (node) => hasVisibleUser(node.user) && node.user.id === user.id,
  );
}

function userDeviceCount(user: HeadscaleUser) {
  return userDevices(user).length;
}

function activeAuthKeysForUser(user: HeadscaleUser) {
  return snapshot.value.preAuthKeys.filter(
    (key) => key.user?.id === user.id && !key.used && !isExpired(key.expiration),
  );
}

function userPolicyReferences(user: HeadscaleUser): UserPolicyReference[] {
  const principals = userPolicyPrincipals(user);
  const groupReferences: UserPolicyReference[] = policyGroups.value
    .map((group) => {
      const matched = group.members
        .filter((member) => principals.includes(member.value))
        .map((member) => member.value);
      return matched.length > 0
        ? {
            kind: "group" as const,
            id: group.id,
            label: `${copy.value.groups}: ${group.name}`,
            matchedValues: matched,
          }
        : null;
    })
    .filter((ref): ref is UserPolicyReference => Boolean(ref));
  const tagOwnerReferences: UserPolicyReference[] = policyTagOwners.value
    .map((tagOwner) => {
      const matched = tagOwner.owners
        .filter((owner) => principals.includes(owner.value))
        .map((owner) => owner.value);
      return matched.length > 0
        ? {
            kind: "tagOwner" as const,
            id: tagOwner.id,
            label: `${copy.value.tagOwners}: ${tagOwner.tag}`,
            matchedValues: matched,
          }
        : null;
    })
    .filter((ref): ref is UserPolicyReference => Boolean(ref));

  return [...groupReferences, ...tagOwnerReferences];
}

const visibleUsers = computed(() => snapshot.value.users.filter((user) => hasVisibleUser(user)));

const filteredUsers = computed(() => {
  const query = userSearch.value.trim().toLowerCase();
  return visibleUsers.value.filter((user) => {
    const role = userRoleKind(user);
    const roleLabel = userRole(user);
    const searchable = [
      user.name,
      user.displayName,
      userLabel(user),
      user.email,
      user.provider,
      user.providerId,
      userAuthSource(user),
      role,
      roleLabel,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const matchesSearch = !query || searchable.includes(query);
    const matchesFilter =
      userFilter.value === "all" ||
      (userFilter.value === "owner" && role === "owner") ||
      (userFilter.value === "member" && role === "member") ||
      (userFilter.value === "service" && role === "service");

    return matchesSearch && matchesFilter;
  });
});

const selectedUserDevices = computed(() =>
  selectedDetailUser.value ? userDevices(selectedDetailUser.value) : [],
);
const selectedUserActiveKeys = computed(() =>
  selectedDetailUser.value ? activeAuthKeysForUser(selectedDetailUser.value) : [],
);
const selectedUserPolicyReferences = computed(() =>
  selectedDetailUser.value ? userPolicyReferences(selectedDetailUser.value) : [],
);
const pendingDeleteUserReferences = computed(() =>
  pendingDeleteUser.value ? userPolicyReferences(pendingDeleteUser.value) : [],
);
const selectedUserPendingRoutesCount = computed(() =>
  selectedUserDevices.value.reduce((total, node) => total + nodePendingRoutes(node).length, 0),
);

const assignMembershipsOptions = computed<AssignMemberOption[]>(() => {
  const target = assignMembershipsTarget.value;
  if (!target) return [];
  const principals = userPolicyPrincipals(target);
  return policyGroups.value.map((group) => ({
    id: group.id,
    name: group.name,
    assigned: group.members.some((member) => principals.includes(member.value)),
    hint: group.members.length
      ? group.members.map((m) => m.value).join(", ")
      : copy.value.noPolicyGroupMembers,
  }));
});

const assignTagOwnershipsOptions = computed<AssignMemberOption[]>(() => {
  const target = assignTagOwnershipsTarget.value;
  if (!target) return [];
  const principals = userPolicyPrincipals(target);
  return policyTagOwners.value.map((tagOwner) => ({
    id: tagOwner.id,
    name: tagOwner.tag,
    assigned: tagOwner.owners.some((owner) => principals.includes(owner.value)),
    hint: tagOwner.owners.length
      ? tagOwner.owners.map((o) => o.value).join(", ")
      : copy.value.noPolicyTagOwnerEntries,
  }));
});

const authKeyDialogUsers = computed(() =>
  visibleUsers.value.map((user) => ({
    id: user.id,
    label: userLabel(user),
  })),
);

const authKeyDialogDefaults = computed<AuthKeyDialogDefaults>(() => ({
  user: inviteForm.user,
  reusable: inviteForm.reusable,
  ephemeral: inviteForm.ephemeral,
  expiration: inviteForm.expiration,
  aclTags: inviteForm.aclTags,
}));

const authKeyDialogLabels = computed<AuthKeyDialogLabels>(() => ({
  title: copy.value.createInvite,
  description: copy.value.invitesSubtitle,
  owner: copy.value.inviteOwner,
  expiration: copy.value.inviteExpiration,
  aclTags: copy.value.aclTags,
  reusable: copy.value.reusable,
  ephemeral: copy.value.ephemeral,
  cancel: copy.value.cancel,
  submit: copy.value.createInvite,
  noUsers: copy.value.noUsers,
  time: copy.value.time,
  hour: copy.value.hour,
  minute: copy.value.minute,
}));

const { mutate, mutateWith } = useMutation();

function openMemberDialog() {
  clearActionFeedback("create-member");
  memberDialogOpen.value = true;
  void refreshSnapshot();
}

function handleMemberDialogOpen(open: boolean) {
  if (!open && isActionPending("create-member")) {
    return;
  }
  memberDialogOpen.value = open;
  if (!open) {
    clearActionFeedback("create-member");
  }
}

async function createMember() {
  const created = await mutate("create-member", (client) =>
    client.createUser({
      name: memberForm.name,
      displayName: memberForm.displayName,
      email: memberForm.email,
    }),
  );
  if (!created) {
    return;
  }
  memberForm.name = "";
  memberForm.displayName = "";
  memberForm.email = "";
  handleMemberDialogOpen(false);
}

function openUserDetails(user?: HeadscaleUser) {
  if (!hasVisibleUser(user)) {
    return;
  }
  const token = userDetailGuard.next();
  selectedDetailUser.value = user;
  void userDetailGuard.refresh(token, () => {
    if (selectedDetailUser.value?.id !== user.id) return;
    const nextUser = currentUser(user.id);
    selectedDetailUser.value = nextUser && hasVisibleUser(nextUser) ? nextUser : null;
  });
}

function handleUserDetailsOpen(open: boolean) {
  if (!open) {
    userDetailGuard.cancel();
    selectedDetailUser.value = null;
    const fromPage = intent.from.value;
    if (fromPage && fromPage !== "members") {
      void router.push({ name: fromPage });
    }
  }
}

function openRenameMemberDialog(user: HeadscaleUser) {
  clearActionFeedback("rename-member");
  selectedRenameUser.value = user;
  renameMemberForm.name = user.name;
}

// Only auto-open the user detail dialog when the navigation explicitly asks for
// it via `?popup=user` (e.g., from invite-owner-link). Plain `?user=…` from a
// route-user-link keeps the table visible so the user can browse first.
function consumeUserQuery() {
  if (!intent.userId.value || intent.popup.value !== "user") return;
  const target = snapshot.value.users.find((u) => u.id === intent.userId.value);
  if (target) openUserDetails(target);
}

onMounted(consumeUserQuery);
watch(() => intent.userId.value, consumeUserQuery);

function handleRenameMemberDialogOpen(open: boolean) {
  if (!open && isActionPending("rename-member")) {
    return;
  }
  if (!open) {
    selectedRenameUser.value = null;
    renameMemberForm.name = "";
    clearActionFeedback("rename-member");
  }
}

async function confirmRenameMember() {
  const user = selectedRenameUser.value;
  if (!user) {
    return;
  }
  const renamed = await mutate("rename-member", (client) =>
    client.renameUser({
      id: user.id,
      newName: renameMemberForm.name,
    }),
  );
  if (renamed) {
    handleRenameMemberDialogOpen(false);
  }
}

function requestDeleteMember(user: HeadscaleUser) {
  clearActionFeedback("delete-member");
  cleanupPolicyOnDelete.value = true;
  pendingDeleteUser.value = user;
}

function handleDeleteMemberDialogOpen(open: boolean) {
  if (!open && isActionPending("delete-member")) {
    return;
  }
  if (!open) {
    pendingDeleteUser.value = null;
    clearActionFeedback("delete-member");
  }
}

async function confirmDeleteMember() {
  const user = pendingDeleteUser.value;
  if (!user) {
    return;
  }

  if (cleanupPolicyOnDelete.value && pendingDeleteUserReferences.value.length > 0) {
    const principals = userPolicyPrincipals(user);
    const cleaned = removeReferencesToValues(policyDesignerState.value, principals);
    commitPolicyState(cleaned);
    const saved = await mutate("save-policy", (client) =>
      client.setPolicy({ policy: JSON.stringify(serializePolicy(cleaned), null, 2) }),
    );
    if (!saved) {
      return;
    }
    policyDraft.value = saved.policy;
  }

  const deleted = await mutate("delete-member", (client) => client.deleteUser({ id: user.id }));
  if (deleted) {
    handleDeleteMemberDialogOpen(false);
  }
}

async function removeUserFromPolicyReference(user: HeadscaleUser, reference: UserPolicyReference) {
  let next = policyDesignerState.value;
  if (reference.kind === "group") {
    for (const value of reference.matchedValues) {
      next = removeMemberFromGroup(next, reference.id, value);
    }
  } else {
    for (const value of reference.matchedValues) {
      next = removeOwnerFromTag(next, reference.id, value);
    }
  }
  commitPolicyState(next);
  const saved = await mutate("save-policy", (client) =>
    client.setPolicy({ policy: JSON.stringify(serializePolicy(next), null, 2) }),
  );
  if (saved) {
    policyDraft.value = saved.policy;
  }
  void user;
}

function openAssignMembershipsDialog(user: HeadscaleUser) {
  assignMembershipsTarget.value = user;
  assignMembershipsOpen.value = true;
}

function handleAssignMembershipsDialogOpen(open: boolean) {
  assignMembershipsOpen.value = open;
  if (!open) {
    assignMembershipsTarget.value = null;
  }
}

function openAssignTagOwnershipsDialog(user: HeadscaleUser) {
  assignTagOwnershipsTarget.value = user;
  assignTagOwnershipsOpen.value = true;
}

function handleAssignTagOwnershipsDialogOpen(open: boolean) {
  assignTagOwnershipsOpen.value = open;
  if (!open) {
    assignTagOwnershipsTarget.value = null;
  }
}

async function applyAssignMemberships(selectedGroupIds: string[]) {
  const target = assignMembershipsTarget.value;
  if (!target) return;
  const principal = policyPrincipalForUser(target);
  if (!principal) return;

  const principals = userPolicyPrincipals(target);
  const selectedSet = new Set(selectedGroupIds);
  let next = policyDesignerState.value;
  for (const group of next.groups) {
    const isSelected = selectedSet.has(group.id);
    const hasMember = group.members.some((m) => principals.includes(m.value));
    if (isSelected && !hasMember) {
      next = addMemberToGroup(next, group.id, toMemberRef(principal));
    } else if (!isSelected && hasMember) {
      for (const member of group.members.filter((m) => principals.includes(m.value))) {
        next = removeMemberFromGroup(next, group.id, member.value);
      }
    }
  }
  commitPolicyState(next);
  const saved = await mutate("assign-user-groups", (client) =>
    client.setPolicy({ policy: JSON.stringify(serializePolicy(next), null, 2) }),
  );
  if (saved) {
    policyDraft.value = saved.policy;
    handleAssignMembershipsDialogOpen(false);
  }
}

async function applyAssignTagOwnerships(selectedTagOwnerIds: string[]) {
  const target = assignTagOwnershipsTarget.value;
  if (!target) return;
  const principal = policyPrincipalForUser(target);
  if (!principal) return;

  const principals = userPolicyPrincipals(target);
  const selectedSet = new Set(selectedTagOwnerIds);
  let next = policyDesignerState.value;
  for (const tagOwner of next.tagOwners) {
    const isSelected = selectedSet.has(tagOwner.id);
    const hasOwner = tagOwner.owners.some((o) => principals.includes(o.value));
    if (isSelected && !hasOwner) {
      next = addOwnerToTag(next, tagOwner.id, toMemberRef(principal));
    } else if (!isSelected && hasOwner) {
      for (const owner of tagOwner.owners.filter((o) => principals.includes(o.value))) {
        next = removeOwnerFromTag(next, tagOwner.id, owner.value);
      }
    }
  }
  commitPolicyState(next);
  const saved = await mutate("assign-user-tags", (client) =>
    client.setPolicy({ policy: JSON.stringify(serializePolicy(next), null, 2) }),
  );
  if (saved) {
    policyDraft.value = saved.policy;
    handleAssignTagOwnershipsDialogOpen(false);
  }
}

function openInviteDialogForUser(user: HeadscaleUser) {
  const token = inviteDialogGuard.next();
  inviteForm.user = user.id;
  handleUserDetailsOpen(false);
  clearActionFeedback("create-invite");
  inviteDialogOpen.value = true;
  void inviteDialogGuard.refresh(token, () => {
    if (!inviteDialogOpen.value) return;
    if (!authKeyDialogUsers.value.some((u) => u.id === inviteForm.user)) {
      inviteForm.user = authKeyDialogUsers.value[0]?.id ?? "";
    }
  });
}

function handleInviteDialogOpen(open: boolean) {
  if (!open && isActionPending("create-invite")) {
    return;
  }
  inviteDialogOpen.value = open;
  if (!open) {
    clearActionFeedback("create-invite");
    inviteDialogGuard.cancel();
  }
}

async function createInvite(payload: AuthKeyDialogPayload) {
  inviteForm.user = payload.user;
  inviteForm.reusable = payload.reusable;
  inviteForm.ephemeral = payload.ephemeral;
  inviteForm.expiration = payload.expiration;
  inviteForm.aclTags = payload.aclTags;
  const created = await mutateWith("create-invite", (client) => client.createPreAuthKey(payload));
  if (created.ok) {
    handleInviteDialogOpen(false);
    void router.push({ name: "invites" });
  }
}

function exportUsers() {
  downloadCsv(
    "headscale-users.csv",
    filteredUsers.value.map((user) => ({
      name: userLabel(user),
      email: user.email,
      role: userRole(user),
      provider: userAuthSource(user),
      machines: userDeviceCount(user),
      joined: user.createdAt,
    })),
  );
}

function jumpToMachinesForUser(user: HeadscaleUser) {
  handleUserDetailsOpen(false);
  void router.push({
    name: "devices",
    query: { search: user.email || user.name || userLabel(user) },
  });
}

function openNodeDetailsFromTable(node: HeadscaleNode) {
  // From the member table row's device-tag chip: jump to devices, open dialog,
  // and on close bounce the user back to /members.
  const query: Record<string, string> = { node: node.id, from: "members", popup: "node" };
  void router.push({ name: "devices", query });
}

function openNodeDetailsFromDialog(node: HeadscaleNode) {
  // From inside the user-detail-dialog: jump to devices, open dialog, and on
  // close keep the user on /devices (so they can keep exploring machines).
  selectedDetailUser.value = null;
  const query: Record<string, string> = { node: node.id, popup: "node" };
  void router.push({ name: "devices", query });
}
</script>

<template>
  <section class="space-y-3 lg:space-y-4">
    <div>
      <h1 class="text-2xl font-semibold">{{ copy.membersTitle }}</h1>
      <p class="mt-1 text-sm text-muted-foreground">{{ copy.membersSubtitle }}</p>
    </div>

    <Dialog :open="memberDialogOpen" @update:open="handleMemberDialogOpen">
      <DialogContent data-testid="member-create-dialog" class="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{{ copy.addMember }}</DialogTitle>
          <DialogDescription>
            {{ copy.membersSubtitle }}
          </DialogDescription>
        </DialogHeader>
        <form class="grid gap-3" data-testid="member-form" @submit.prevent="createMember">
          <div>
            <Label for="member-name">{{ copy.memberName }}</Label>
            <Input id="member-name" v-model="memberForm.name" data-testid="member-name" class="mt-2" required />
          </div>
          <div>
            <Label for="member-display">{{ copy.displayName }}</Label>
            <Input id="member-display" v-model="memberForm.displayName" data-testid="member-display" class="mt-2" />
          </div>
          <div>
            <Label for="member-email">{{ copy.email }}</Label>
            <Input id="member-email" v-model="memberForm.email" data-testid="member-email" class="mt-2" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" data-testid="cancel-create-member" :disabled="isActionPending('create-member')" @click="handleMemberDialogOpen(false)">
              {{ copy.cancel }}
            </Button>
            <Button type="submit" data-testid="create-member" :disabled="isActionPending('create-member')">
              <LoaderCircle v-if="isActionPending('create-member')" class="h-4 w-4 animate-spin" aria-hidden="true" />
              <Plus v-else class="h-4 w-4" aria-hidden="true" />
              {{ copy.createMember }}
            </Button>
          </DialogFooter>
          <p
            v-if="actionError('create-member')"
            role="alert"
            class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            data-testid="create-member-error"
          >
            {{ actionError("create-member") }}
          </p>
        </form>
      </DialogContent>
    </Dialog>

    <div class="space-y-2" data-testid="user-table-shell">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center" data-testid="user-toolbar">
        <div class="w-full sm:max-w-sm">
          <Label for="user-search" class="sr-only">{{ copy.searchUsers }}</Label>
          <div class="relative">
            <Search class="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input id="user-search" v-model="userSearch" data-testid="user-search" class="ps-8" :placeholder="copy.searchUsers" />
          </div>
        </div>
        <div class="w-full sm:w-44">
          <Label for="user-filter" class="sr-only">{{ copy.filters }}</Label>
          <div class="relative">
            <SlidersHorizontal class="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <NativeSelect id="user-filter" v-model="userFilter" data-testid="user-filter" class="ps-8">
              <NativeSelectOption value="all">{{ copy.allUsers }}</NativeSelectOption>
              <NativeSelectOption value="owner">{{ copy.owners }}</NativeSelectOption>
              <NativeSelectOption value="member">{{ copy.members }}</NativeSelectOption>
              <NativeSelectOption value="service">{{ copy.serviceAccounts }}</NativeSelectOption>
            </NativeSelect>
          </div>
        </div>
        <p class="whitespace-nowrap text-xs text-muted-foreground sm:ms-auto">{{ filteredUsers.length }} / {{ visibleUsers.length }}</p>
        <Button
          type="button"
          variant="outline"
          size="icon"
          data-testid="refresh-users"
          :aria-label="copy.refreshData"
          :title="copy.refreshData"
          :disabled="isRefreshingSnapshot"
          @click="refreshMembers"
        >
          <LoaderCircle v-if="isRefreshingSnapshot" class="h-4 w-4 animate-spin" aria-hidden="true" />
          <RefreshCw v-else class="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button type="button" variant="outline" size="icon" data-testid="export-users" :aria-label="copy.exportData" @click="exportUsers">
          <Download class="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button data-testid="open-create-member" @click="openMemberDialog">
          <Plus class="h-4 w-4" aria-hidden="true" />
          {{ copy.addMember }}
        </Button>
      </div>
      <Card class="min-w-0 overflow-hidden" data-testid="user-table">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{{ copy.membersTitle }}</TableHead>
              <TableHead>{{ copy.role }}</TableHead>
              <TableHead data-testid="member-devices-header">{{ copy.memberDevices }}</TableHead>
              <TableHead>{{ copy.joined }}</TableHead>
              <TableHead>{{ copy.authSource }}</TableHead>
              <TableHead class="hidden md:table-cell">{{ copy.actions }}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="user in filteredUsers" :key="user.id" :data-testid="`member-${user.name}`">
              <TableCell class="align-top md:min-w-56">
                <button
                  type="button"
                  class="font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  :data-testid="`member-detail-link-${user.name}`"
                  @click="openUserDetails(user)"
                >
                  {{ userLabel(user) }}
                </button>
                <p class="mt-1 break-all text-sm text-muted-foreground">{{ user.email || userAuthSource(user) }}</p>
                <DropdownMenu>
                  <DropdownMenuTrigger as-child>
                    <Button
                      variant="outline"
                      size="icon"
                      class="mt-2 md:hidden"
                      :data-testid="`member-actions-trigger-mobile-${user.name}`"
                      :aria-label="`${copy.actions}: ${userLabel(user)}`"
                    >
                      <EllipsisVertical class="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" class="w-64" :data-testid="`member-actions-menu-mobile-${user.name}`">
                    <DropdownMenuLabel>{{ copy.actions }}</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem :data-testid="`view-member-details-mobile-${user.name}`" @click="openUserDetails(user)">
                      <FileCheck2 class="h-4 w-4" aria-hidden="true" />
                      {{ copy.viewDetails }}
                    </DropdownMenuItem>
                    <DropdownMenuItem :data-testid="`view-member-machines-mobile-${user.name}`" @click="jumpToMachinesForUser(user)">
                      <Network class="h-4 w-4" aria-hidden="true" />
                      {{ copy.viewMachines }}
                    </DropdownMenuItem>
                    <DropdownMenuItem :data-testid="`create-invite-for-member-mobile-${user.name}`" @click="openInviteDialogForUser(user)">
                      <KeyRound class="h-4 w-4" aria-hidden="true" />
                      {{ copy.createInvite }}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem :data-testid="`rename-member-mobile-${user.name}`" @click="openRenameMemberDialog(user)">
                      <Pencil class="h-4 w-4" aria-hidden="true" />
                      {{ copy.renameMember }}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      :data-testid="`assign-member-groups-mobile-${user.name}`"
                      :disabled="!policyPrincipalForUser(user)"
                      @click="openAssignMembershipsDialog(user)"
                    >
                      <Users class="h-4 w-4" aria-hidden="true" />
                      {{ copy.addUserToGroup }}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      :data-testid="`assign-member-tags-mobile-${user.name}`"
                      :disabled="!policyPrincipalForUser(user)"
                      @click="openAssignTagOwnershipsDialog(user)"
                    >
                      <ShieldCheck class="h-4 w-4" aria-hidden="true" />
                      {{ copy.grantTagToUser }}
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" :data-testid="`delete-member-mobile-${user.name}`" @click="requestDeleteMember(user)">
                      <Trash2 class="h-4 w-4" aria-hidden="true" />
                      {{ copy.deleteMember }}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
              <TableCell class="align-top md:min-w-32">
                <Badge variant="outline">{{ userRole(user) }}</Badge>
              </TableCell>
              <TableCell class="align-top md:min-w-28">
                <div v-if="userDevices(user).length" class="grid justify-items-start gap-1" :data-testid="`member-device-tags-${user.name}`">
                  <button
                    v-for="node in userDevices(user)"
                    :key="node.id"
                    type="button"
                    class="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    :data-testid="`member-device-tag-${user.name}-${node.id}`"
                    @click="openNodeDetailsFromTable(node)"
                  >
                    <Badge variant="outline" :class="nodeStatusClass(node)" class="cursor-pointer">
                      {{ nodeDisplayName(node) }}
                    </Badge>
                  </button>
                </div>
                <span v-else aria-hidden="true" class="text-muted-foreground">-</span>
              </TableCell>
              <TableCell class="align-top text-sm text-muted-foreground md:min-w-40">{{ formatDate(user.createdAt) }}</TableCell>
              <TableCell class="align-top md:min-w-36" :data-testid="`member-auth-source-${user.name}`">{{ userAuthSource(user) }}</TableCell>
              <TableCell class="hidden align-top md:table-cell md:min-w-16">
                <div class="flex justify-start">
                  <DropdownMenu>
                    <DropdownMenuTrigger as-child>
                      <Button
                        variant="outline"
                        size="icon"
                        :data-testid="`member-actions-trigger-${user.name}`"
                        :aria-label="`${copy.actions}: ${userLabel(user)}`"
                      >
                        <EllipsisVertical class="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" class="w-64" :data-testid="`member-actions-menu-${user.name}`">
                      <DropdownMenuLabel>{{ copy.actions }}</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem :data-testid="`view-member-details-${user.name}`" @click="openUserDetails(user)">
                        <FileCheck2 class="h-4 w-4" aria-hidden="true" />
                        {{ copy.viewDetails }}
                      </DropdownMenuItem>
                      <DropdownMenuItem :data-testid="`view-member-machines-${user.name}`" @click="jumpToMachinesForUser(user)">
                        <Network class="h-4 w-4" aria-hidden="true" />
                        {{ copy.viewMachines }}
                      </DropdownMenuItem>
                      <DropdownMenuItem :data-testid="`create-invite-for-member-${user.name}`" @click="openInviteDialogForUser(user)">
                        <KeyRound class="h-4 w-4" aria-hidden="true" />
                        {{ copy.createInvite }}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem :data-testid="`rename-member-${user.name}`" @click="openRenameMemberDialog(user)">
                        <Pencil class="h-4 w-4" aria-hidden="true" />
                        {{ copy.renameMember }}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        :data-testid="`assign-member-groups-${user.name}`"
                        :disabled="!policyPrincipalForUser(user)"
                        @click="openAssignMembershipsDialog(user)"
                      >
                        <Users class="h-4 w-4" aria-hidden="true" />
                        {{ copy.addUserToGroup }}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        :data-testid="`assign-member-tags-${user.name}`"
                        :disabled="!policyPrincipalForUser(user)"
                        @click="openAssignTagOwnershipsDialog(user)"
                      >
                        <ShieldCheck class="h-4 w-4" aria-hidden="true" />
                        {{ copy.grantTagToUser }}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" :data-testid="`delete-member-${user.name}`" @click="requestDeleteMember(user)">
                        <Trash2 class="h-4 w-4" aria-hidden="true" />
                        {{ copy.deleteMember }}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </TableCell>
            </TableRow>
            <TableRow v-if="filteredUsers.length === 0">
              <TableCell colspan="6" class="py-6 text-sm text-muted-foreground">
                {{ copy.noUsersMatch }}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Card>
    </div>

    <CreateAuthKeyDialog
      :open="inviteDialogOpen"
      :users="authKeyDialogUsers"
      :defaults="authKeyDialogDefaults"
      :labels="authKeyDialogLabels"
      :is-submitting="isCreatingInvite"
      :error="actionError('create-invite')"
      @update:open="handleInviteDialogOpen"
      @submit="createInvite"
    />

    <Dialog :open="Boolean(selectedDetailUser)" @update:open="handleUserDetailsOpen">
      <DialogContent class="max-h-[85vh] overflow-y-auto sm:max-w-3xl" data-testid="user-detail-dialog">
        <template v-if="selectedDetailUser">
          <DialogHeader>
            <DialogTitle class="flex min-w-0 items-center gap-2">
              <CircleUserRound class="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span class="truncate">{{ userLabel(selectedDetailUser) }}</span>
            </DialogTitle>
            <DialogDescription>{{ copy.userDetails }}</DialogDescription>
          </DialogHeader>

          <div class="grid gap-4">
            <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <div class="rounded-md border bg-background p-3">
                <p class="text-xs text-muted-foreground">{{ copy.userId }}</p>
                <p class="mt-1 text-sm font-medium">{{ selectedDetailUser.id }}</p>
              </div>
              <div class="rounded-md border bg-background p-3">
                <p class="text-xs text-muted-foreground">{{ copy.role }}</p>
                <p class="mt-1 text-sm font-medium">{{ userRole(selectedDetailUser) }}</p>
              </div>
              <div class="rounded-md border bg-background p-3">
                <p class="text-xs text-muted-foreground">{{ copy.deviceCount }}</p>
                <p class="mt-1 text-sm font-medium">{{ selectedUserDevices.length }}</p>
              </div>
              <div class="rounded-md border bg-background p-3">
                <p class="text-xs text-muted-foreground">{{ copy.pendingRoutes }}</p>
                <p class="mt-1 text-sm font-medium">{{ selectedUserPendingRoutesCount }}</p>
              </div>
            </div>

            <div class="grid gap-3 sm:grid-cols-2">
              <section class="grid gap-2 rounded-md border bg-background p-3">
                <h3 class="text-sm font-semibold">{{ copy.details }}</h3>
                <p class="break-all text-sm text-muted-foreground">{{ copy.email }}: {{ selectedDetailUser.email || copy.unknown }}</p>
                <p class="text-sm text-muted-foreground">{{ copy.authSource }}: {{ userAuthSource(selectedDetailUser) }}</p>
                <p class="text-sm text-muted-foreground">{{ copy.joined }}: {{ formatDate(selectedDetailUser.createdAt) }}</p>
              </section>

              <section class="grid gap-2 rounded-md border bg-background p-3">
                <h3 class="text-sm font-semibold">{{ copy.activeAuthKeys }}</h3>
                <div v-if="selectedUserActiveKeys.length" class="grid gap-1">
                  <code
                    v-for="key in selectedUserActiveKeys"
                    :key="key.id"
                    class="w-fit rounded bg-secondary px-1.5 py-0.5 text-xs"
                  >
                    {{ shortSecret(key.key) }}
                  </code>
                </div>
                <p v-else class="text-sm text-muted-foreground">{{ copy.noAuthKeys }}</p>
              </section>
            </div>

            <section class="grid gap-2">
              <h3 class="text-sm font-semibold">{{ copy.personalDevices }}</h3>
              <div v-if="selectedUserDevices.length" class="grid gap-2">
                <button
                  v-for="node in selectedUserDevices"
                  :key="node.id"
                  type="button"
                  class="grid gap-2 rounded-md border bg-background p-3 text-start hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  :data-testid="`user-detail-device-${node.id}`"
                  @click="openNodeDetailsFromDialog(node)"
                >
                  <span class="flex flex-wrap items-center gap-2">
                    <span class="font-medium">{{ nodeDisplayName(node) }}</span>
                    <Badge variant="outline" :class="nodeStatusClass(node)">{{ nodeStatusLabel(node) }}</Badge>
                  </span>
                  <span class="flex flex-wrap gap-1">
                    <Badge
                      v-for="address in node.ipAddresses"
                      :key="address"
                      variant="outline"
                      class="border-slate-200 bg-muted/60 font-mono text-[11px] text-muted-foreground dark:border-slate-800"
                    >
                      {{ address }}
                    </Badge>
                  </span>
                </button>
              </div>
              <p v-else class="text-sm text-muted-foreground">{{ copy.noPersonalDevices }}</p>
            </section>

            <section class="grid gap-2">
              <h3 class="text-sm font-semibold">{{ copy.policyReferences }}</h3>
              <div v-if="selectedUserPolicyReferences.length" class="flex flex-wrap gap-1">
                <Badge
                  v-for="reference in selectedUserPolicyReferences"
                  :key="`${reference.kind}-${reference.id}`"
                  variant="outline"
                  class="gap-1 pe-1"
                  :data-testid="`user-policy-reference-${reference.kind}-${reference.id}`"
                >
                  <span class="break-all">{{ reference.label }}</span>
                  <button
                    type="button"
                    class="rounded-sm p-0.5 text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    :aria-label="copy.removeFromReference"
                    :disabled="isActionPending('save-policy')"
                    :data-testid="`remove-user-policy-reference-${reference.kind}-${reference.id}`"
                    @click="removeUserFromPolicyReference(selectedDetailUser, reference)"
                  >
                    <Trash2 class="h-3 w-3" aria-hidden="true" />
                  </button>
                </Badge>
              </div>
              <p v-else class="text-sm text-muted-foreground">{{ copy.noPolicyReferences }}</p>
            </section>
          </div>

        </template>
      </DialogContent>
    </Dialog>

    <AssignMemberDialog
      :open="assignMembershipsOpen"
      :title="copy.assignMembershipsTitle"
      :description="copy.assignMembershipsDescription"
      :options="assignMembershipsOptions"
      :apply-label="copy.applyAssignment"
      :cancel-label="copy.cancelAssignment"
      :empty-label="copy.noGroupsAvailable"
      :assigned-label="copy.assignedBadgeLabel"
      testid-prefix="assign-user-groups"
      :is-submitting="isActionPending('assign-user-groups')"
      :error="actionError('assign-user-groups')"
      @update:open="handleAssignMembershipsDialogOpen"
      @apply="applyAssignMemberships"
    />

    <AssignMemberDialog
      :open="assignTagOwnershipsOpen"
      :title="copy.assignTagOwnershipsTitle"
      :description="copy.assignTagOwnershipsDescription"
      :options="assignTagOwnershipsOptions"
      :apply-label="copy.applyAssignment"
      :cancel-label="copy.cancelAssignment"
      :empty-label="copy.noTagsAvailable"
      :assigned-label="copy.assignedBadgeLabel"
      testid-prefix="assign-user-tags"
      :is-submitting="isActionPending('assign-user-tags')"
      :error="actionError('assign-user-tags')"
      @update:open="handleAssignTagOwnershipsDialogOpen"
      @apply="applyAssignTagOwnerships"
    />

    <Dialog :open="Boolean(selectedRenameUser)" @update:open="handleRenameMemberDialogOpen">
      <DialogContent v-if="selectedRenameUser" data-testid="rename-member-dialog">
        <DialogHeader>
          <DialogTitle>{{ copy.renameMemberTitle }}</DialogTitle>
          <DialogDescription>{{ copy.renameMemberDescription }}</DialogDescription>
        </DialogHeader>
        <div class="grid gap-2">
          <Label for="rename-member-name">{{ copy.memberName }}</Label>
          <Input
            id="rename-member-name"
            v-model="renameMemberForm.name"
            data-testid="rename-member-name"
            @keydown.enter.prevent="confirmRenameMember"
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" data-testid="rename-member-cancel" :disabled="isActionPending('rename-member')" @click="handleRenameMemberDialogOpen(false)">
            {{ copy.cancel }}
          </Button>
          <Button type="button" data-testid="confirm-rename-member" :disabled="isActionPending('rename-member')" @click="confirmRenameMember">
            <LoaderCircle v-if="isActionPending('rename-member')" class="h-4 w-4 animate-spin" aria-hidden="true" />
            {{ copy.saveMemberName }}
          </Button>
        </DialogFooter>
        <p
          v-if="actionError('rename-member')"
          role="alert"
          class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="rename-member-error"
        >
          {{ actionError("rename-member") }}
        </p>
      </DialogContent>
    </Dialog>

    <AlertDialog :open="Boolean(pendingDeleteUser)" @update:open="handleDeleteMemberDialogOpen">
      <AlertDialogContent v-if="pendingDeleteUser" data-testid="delete-member-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{{ copy.deleteMemberTitle }}</AlertDialogTitle>
          <AlertDialogDescription>
            {{ copy.deleteMemberDescription }}
            <span class="mt-2 block font-medium text-foreground">{{ userLabel(pendingDeleteUser) }}</span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div
          v-if="pendingDeleteUserReferences.length"
          class="grid gap-2"
          data-testid="delete-member-policy-impact"
        >
          <p class="text-sm font-medium">{{ copy.userImpactOnDeleteHeading }}</p>
          <ul class="grid gap-1">
            <li
              v-for="reference in pendingDeleteUserReferences"
              :key="`${reference.kind}-${reference.id}`"
              class="rounded-md border bg-background px-3 py-2 text-sm break-all"
            >
              {{ reference.label }}
            </li>
          </ul>
          <label class="flex items-start gap-2 text-sm">
            <Checkbox
              v-model="cleanupPolicyOnDelete"
              :disabled="isActionPending('delete-member') || isActionPending('save-policy')"
              data-testid="delete-member-cleanup-policy"
            />
            <span>{{ copy.cleanupReferencesOption }}</span>
          </label>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="cancel-delete-member" :disabled="isActionPending('delete-member') || isActionPending('save-policy')">{{ copy.cancel }}</AlertDialogCancel>
          <Button type="button" variant="destructive" data-testid="confirm-delete-member" :disabled="isActionPending('delete-member') || isActionPending('save-policy')" @click="confirmDeleteMember">
            <LoaderCircle v-if="isActionPending('delete-member') || isActionPending('save-policy')" class="h-4 w-4 animate-spin" aria-hidden="true" />
            {{ copy.confirmDeleteMember }}
          </Button>
        </AlertDialogFooter>
        <p
          v-if="actionError('delete-member')"
          role="alert"
          class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="delete-member-error"
        >
          {{ actionError("delete-member") }}
        </p>
        <p
          v-if="actionError('save-policy')"
          role="alert"
          class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="delete-member-policy-error"
        >
          {{ actionError("save-policy") }}
        </p>
      </AlertDialogContent>
    </AlertDialog>
  </section>
</template>
