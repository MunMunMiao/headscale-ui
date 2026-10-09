<script setup lang="ts">
import {
  Check,
  Clock,
  Copy,
  Download,
  EllipsisVertical,
  FileCheck2,
  Filter,
  KeyRound,
  LoaderCircle,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Router,
  Search,
  Server,
  ShieldCheck,
  Trash2,
  Wifi,
  WifiOff,
} from "lucide-vue-next";
import { computed, nextTick, onMounted, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import type { HeadscaleClient, HeadscaleNode, HeadscaleUser } from "@/api/types";
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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type ActionFeedbackKey, useActionFeedback } from "@/composables/useActionFeedback";
import { useDeviceSetup } from "@/composables/useDeviceSetup";
import { useDisplayHelpers } from "@/composables/useDisplayHelpers";
import { useMutation } from "@/composables/useMutation";
import { useProductCopy } from "@/composables/useProductCopy";
import { useRefreshGuard } from "@/composables/useRefreshGuard";
import { useRouteIntent } from "@/composables/useRouteIntent";
import { useSnapshot } from "@/composables/useSnapshot";
import { useSegment } from "@/composables/useSnapshotSegment";
import { isTimestampExpired as isExpired, nodeConnectionStatus } from "@/domain/node-status";
import { useHeadscaleI18n } from "@/i18n";
import { downloadCsv } from "@/utils/csv";
import { nodePendingRoutes } from "@/utils/node";
import {
  approvedRouteClass,
  deviceTagClass,
  isExitRoute,
  nodeStatusClass,
  pendingRouteClass,
} from "@/utils/status-class";

type MachineFilter = "all" | "online" | "offline" | "expired" | "routes" | "tagged";
type AddDeviceTask = "server" | "client" | "pending";

const { t } = useHeadscaleI18n();
const { copy } = useProductCopy();
const { snapshot, refreshSnapshot, nodeById: currentNode } = useSnapshot();
const { isRefreshing: isRefreshingSnapshot, refresh: refreshDevices } = useSegment(
  "fabric",
  "identity",
);
const { actionError, clearActionFeedback, isActionPending } = useActionFeedback();
const {
  open: deviceSetupDialogOpen,
  task: deviceSetupTask,
  step: addDeviceStep,
  authKeyExpiryDays,
  returnAfterInvite: returnToDeviceSetupAfterInvite,
  lastCreatedInvite,
  lastRegisteredNode,
  pendingRegistrationForm,
} = useDeviceSetup();
const router = useRouter();
const intent = useRouteIntent();

const deviceSearch = ref("");
const machineFilter = ref<MachineFilter>("all");
const copiedKey = ref("");

const renameDialogOpen = ref(false);
const expireDialogOpen = ref(false);
const removeDialogOpen = ref(false);
const inviteDialogOpen = ref(false);
const selectedRenameNode = ref<HeadscaleNode | null>(null);
const renameDraft = ref("");
const selectedExpireNode = ref<HeadscaleNode | null>(null);
const selectedRemoveNode = ref<HeadscaleNode | null>(null);
const selectedTagsNode = ref<HeadscaleNode | null>(null);
const selectedDetailNode = ref<HeadscaleNode | null>(null);

const inviteForm = reactive({
  user: "1",
  reusable: true,
  ephemeral: false,
  expiration: "2026-12-31T23:59:00Z",
  aclTags: "",
});
const tagsForm = reactive({
  tags: "",
});

const nodeDetailGuard = useRefreshGuard();
const renameDialogGuard = useRefreshGuard();
const expireDialogGuard = useRefreshGuard();
const removeDialogGuard = useRefreshGuard();

const visibleUsers = computed(() => snapshot.value.users.filter((user) => hasVisibleUser(user)));

const filteredNodes = computed(() => {
  const query = deviceSearch.value.trim().toLowerCase();
  return snapshot.value.nodes.filter((node) => {
    const searchable = [
      node.name,
      node.givenName,
      ...(hasVisibleUser(node.user) ? [node.user?.name, node.user?.email, nodeOwner(node)] : []),
      node.ipAddresses.join(" "),
      node.tags.join(" "),
      node.availableRoutes.join(" "),
      node.approvedRoutes.join(" "),
      node.registerMethod,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const matchesSearch = !query || searchable.includes(query);
    const matchesFilter =
      machineFilter.value === "all" ||
      (machineFilter.value === "online" && node.online) ||
      (machineFilter.value === "offline" && !node.online) ||
      (machineFilter.value === "expired" && isExpired(node.expiry)) ||
      (machineFilter.value === "routes" && node.availableRoutes.length > 0) ||
      (machineFilter.value === "tagged" && node.tags.length > 0);

    return matchesSearch && matchesFilter;
  });
});

const hasMachineFilters = computed(
  () => deviceSearch.value.trim() !== "" || machineFilter.value !== "all",
);

const installCommand = computed(() => {
  if (!lastCreatedInvite.value) {
    return "";
  }
  return `tailscale up --authkey ${lastCreatedInvite.value}`;
});

const deviceSetupTitle = computed(() => {
  if (deviceSetupTask.value === "pending") {
    return copy.value.pendingRegistrationTitle;
  }
  if (deviceSetupTask.value === "server") {
    return copy.value.addLinuxServerTitle;
  }
  return copy.value.addClientDeviceTitle;
});

const deviceSetupDescription = computed(() => {
  if (deviceSetupTask.value === "pending") {
    return copy.value.pendingRegistrationDescription;
  }
  return deviceSetupTask.value === "server"
    ? copy.value.linuxServerDescription
    : copy.value.clientDeviceDescription;
});

type AddDeviceStepInfo = { id: typeof addDeviceStep.value; label: string; description: string };

const addDeviceSteps = computed<AddDeviceStepInfo[]>(() => {
  if (deviceSetupTask.value === "pending") {
    return [
      {
        id: "pending",
        label: copy.value.pendingRegistrationTitle,
        description: copy.value.wizardStepPendingDescription,
      },
      {
        id: "result",
        label: copy.value.wizardResult,
        description: copy.value.wizardStepResultDescription,
      },
    ];
  }

  if (deviceSetupTask.value) {
    return [
      {
        id: "preferences",
        label: copy.value.setupDevice,
        description: copy.value.wizardStepPreferencesDescription,
      },
      {
        id: "authKey",
        label: copy.value.setupAuthKey,
        description: copy.value.wizardStepAuthKeyDescription,
      },
      {
        id: "generate",
        label: copy.value.generateInstallScript,
        description: copy.value.wizardStepGenerateDescription,
      },
    ];
  }

  return [];
});

const addDeviceStepIndex = computed(() => {
  const index = addDeviceSteps.value.findIndex((step) => step.id === addDeviceStep.value);
  return index === -1 ? 0 : index;
});

const canMoveAddDeviceNext = computed(() => {
  if (addDeviceStepIndex.value >= addDeviceSteps.value.length - 1) {
    return false;
  }
  if (addDeviceStep.value === "pending") {
    return Boolean(lastRegisteredNode.value);
  }
  return deviceSetupTask.value !== null;
});

const {
  formatDate,
  userLabel,
  nodeDisplayName,
  nodeOwner,
  nodeStatusLabel,
  hasVisibleUser,
  isTagManagedDeviceUser,
} = useDisplayHelpers();

function ensureWorkflowUser() {
  const firstUser = visibleUsers.value[0];
  if (!pendingRegistrationForm.user && firstUser) {
    pendingRegistrationForm.user = firstUser.name;
  }
  if (!inviteForm.user && firstUser) {
    inviteForm.user = firstUser.id;
  }
}

const { mutate, mutateWith } = useMutation();

function exportMachines() {
  downloadCsv(
    "headscale-machines.csv",
    filteredNodes.value.map((node) => ({
      name: nodeDisplayName(node),
      owner: nodeOwner(node),
      status: nodeStatusLabel(node),
      addresses: node.ipAddresses.join(" "),
      tags: node.tags.join(" "),
      routes: node.approvedRoutes.join(" "),
      lastSeen: node.lastSeen,
      expires: node.expiry,
    })),
  );
}

function clearMachineFilters() {
  deviceSearch.value = "";
  machineFilter.value = "all";
}

async function copyInviteKey(value: string) {
  await navigator.clipboard.writeText(value);
  copiedKey.value = value;
  window.setTimeout(() => {
    copiedKey.value = "";
  }, 1200);
}

function syncInviteExpirationFromDays() {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + authKeyExpiryDays.value);
  inviteForm.expiration = expiresAt.toISOString();
}

function setAuthKeyExpiryDays(value: number) {
  const nextValue = Number.isFinite(value) ? value : 7;
  authKeyExpiryDays.value = Math.min(90, Math.max(1, Math.round(nextValue)));
  syncInviteExpirationFromDays();
}

function goToNextAddDeviceStep() {
  if (!canMoveAddDeviceNext.value) {
    return;
  }
  addDeviceStep.value =
    addDeviceSteps.value[addDeviceStepIndex.value + 1]?.id ?? addDeviceStep.value;
}

function goToPreviousAddDeviceStep() {
  if (addDeviceStepIndex.value <= 0) {
    deviceSetupTask.value = null;
    addDeviceStep.value = "type";
    lastCreatedInvite.value = "";
    lastRegisteredNode.value = null;
    return;
  }
  addDeviceStep.value = addDeviceSteps.value[addDeviceStepIndex.value - 1]?.id ?? "type";
}

function goToAddDeviceStep(index: number) {
  if (index > addDeviceStepIndex.value) {
    return;
  }
  addDeviceStep.value = addDeviceSteps.value[index]?.id ?? addDeviceStep.value;
}

function isAddDeviceStepComplete(index: number) {
  return index < addDeviceStepIndex.value;
}

function finishAddDeviceFlow() {
  handleDeviceSetupDialogOpen(false);
}

function openDeviceSetupDialog() {
  deviceSetupTask.value = null;
  addDeviceStep.value = "type";
  lastCreatedInvite.value = "";
  lastRegisteredNode.value = null;
  deviceSetupDialogOpen.value = true;
}

function prepareDeviceInvite(task: AddDeviceTask) {
  if (task === "pending") {
    preparePendingRegistration();
    return;
  }
  deviceSetupTask.value = task;
  addDeviceStep.value = "preferences";
  deviceSetupDialogOpen.value = true;
  inviteForm.reusable = task === "server";
  inviteForm.ephemeral = task === "client";
  inviteForm.aclTags = task === "server" ? "tag:server" : "";
  ensureWorkflowUser();
  setAuthKeyExpiryDays(7);
  lastCreatedInvite.value = "";
  lastRegisteredNode.value = null;
}

function preparePendingRegistration() {
  clearActionFeedback("register-pending-node");
  deviceSetupTask.value = "pending";
  addDeviceStep.value = "pending";
  deviceSetupDialogOpen.value = true;
  ensureWorkflowUser();
  lastCreatedInvite.value = "";
  lastRegisteredNode.value = null;
}

function handleDeviceSetupDialogOpen(open: boolean) {
  if (!open && isActionPending("register-pending-node")) {
    return;
  }
  deviceSetupDialogOpen.value = open;
  if (!open) {
    returnToDeviceSetupAfterInvite.value = false;
    deviceSetupTask.value = null;
    addDeviceStep.value = "type";
    lastCreatedInvite.value = "";
    lastRegisteredNode.value = null;
    clearActionFeedback("register-pending-node");
  }
}

function openInviteDialogFromDeviceSetup() {
  returnToDeviceSetupAfterInvite.value = true;
  addDeviceStep.value = "generate";
  deviceSetupDialogOpen.value = false;
  openInviteDialog();
}

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

function openInviteDialog() {
  clearActionFeedback("create-invite");
  inviteDialogOpen.value = true;
}

function handleInviteDialogOpen(open: boolean) {
  if (!open && isActionPending("create-invite")) {
    return;
  }
  inviteDialogOpen.value = open;
  if (!open) {
    clearActionFeedback("create-invite");
    if (returnToDeviceSetupAfterInvite.value) {
      returnToDeviceSetupAfterInvite.value = false;
      deviceSetupDialogOpen.value = deviceSetupTask.value !== null;
    }
  }
}

async function createInvite(payload: AuthKeyDialogPayload) {
  inviteForm.user = payload.user;
  inviteForm.reusable = payload.reusable;
  inviteForm.ephemeral = payload.ephemeral;
  inviteForm.expiration = payload.expiration;
  inviteForm.aclTags = payload.aclTags;
  lastCreatedInvite.value = "";
  const created = await mutateWith("create-invite", (client) => client.createPreAuthKey(payload));
  if (created.ok) {
    lastCreatedInvite.value = created.result.preAuthKey.key;
    handleInviteDialogOpen(false);
  }
}

function openAccessFromDeviceSetup() {
  handleDeviceSetupDialogOpen(false);
  void router.push({ name: "access" });
}

async function registerPendingNode() {
  lastRegisteredNode.value = null;
  const registered = await mutateWith("register-pending-node", (client) =>
    client.registerNode({
      user: pendingRegistrationForm.user,
      key: pendingRegistrationForm.key,
    }),
  );
  if (registered.ok) {
    lastRegisteredNode.value = registered.result.node;
    addDeviceStep.value = "result";
  }
}

function openNodeDetails(node: HeadscaleNode) {
  const token = nodeDetailGuard.next();
  selectedDetailNode.value = node;
  void nodeDetailGuard.refresh(token, () => {
    if (selectedDetailNode.value?.id !== node.id) return;
    selectedDetailNode.value = currentNode(node.id) ?? null;
  });
}

function handleNodeDetailsOpen(open: boolean) {
  if (!open) {
    nodeDetailGuard.cancel();
    selectedDetailNode.value = null;
    const fromPage = intent.from.value;
    if (fromPage && fromPage !== "devices") {
      const fromUser = fromPage === "members" ? intent.userId.value : null;
      void router.push(
        fromUser ? { name: fromPage, query: { user: fromUser } } : { name: fromPage },
      );
    }
  }
}

function consumeDeviceQuery() {
  if (intent.search.value !== null) deviceSearch.value = intent.search.value;
  if (!intent.nodeId.value || intent.popup.value !== "node") return;
  const target = snapshot.value.nodes.find((n) => n.id === intent.nodeId.value);
  if (target) openNodeDetails(target);
}

onMounted(consumeDeviceQuery);
watch(() => [intent.nodeId.value, intent.search.value], consumeDeviceQuery);

function openRenameDialog(node: HeadscaleNode) {
  clearActionFeedback("rename-node");
  const token = renameDialogGuard.next();
  const draftAtOpen = nodeDisplayName(node);
  selectedRenameNode.value = node;
  renameDraft.value = draftAtOpen;
  renameDialogOpen.value = true;
  void renameDialogGuard.refresh(token, () => {
    if (!renameDialogOpen.value || selectedRenameNode.value?.id !== node.id) return;
    const nextNode = currentNode(node.id);
    if (!nextNode) {
      handleRenameDialogOpen(false);
      return;
    }
    selectedRenameNode.value = nextNode;
    if (renameDraft.value === draftAtOpen) {
      renameDraft.value = nodeDisplayName(nextNode);
    }
  });
}

function handleRenameDialogOpen(open: boolean) {
  if (!open && isActionPending("rename-node")) {
    return;
  }
  renameDialogOpen.value = open;
  if (!open) {
    renameDialogGuard.cancel();
    selectedRenameNode.value = null;
    renameDraft.value = "";
    clearActionFeedback("rename-node");
  }
}

function openExpireDialog(node: HeadscaleNode) {
  clearActionFeedback("expire-node");
  const token = expireDialogGuard.next();
  selectedExpireNode.value = node;
  expireDialogOpen.value = true;
  void expireDialogGuard.refresh(token, () => {
    if (!expireDialogOpen.value || selectedExpireNode.value?.id !== node.id) return;
    selectedExpireNode.value = currentNode(node.id) ?? null;
  });
}

function handleExpireDialogOpen(open: boolean) {
  if (!open && isActionPending("expire-node")) {
    return;
  }
  expireDialogOpen.value = open;
  if (!open) {
    expireDialogGuard.cancel();
    selectedExpireNode.value = null;
    clearActionFeedback("expire-node");
  }
}

function openRemoveDialog(node: HeadscaleNode) {
  clearActionFeedback("remove-node");
  const token = removeDialogGuard.next();
  selectedRemoveNode.value = node;
  removeDialogOpen.value = true;
  void removeDialogGuard.refresh(token, () => {
    if (!removeDialogOpen.value || selectedRemoveNode.value?.id !== node.id) return;
    selectedRemoveNode.value = currentNode(node.id) ?? null;
  });
}

function handleRemoveDialogOpen(open: boolean) {
  if (!open && isActionPending("remove-node")) {
    return;
  }
  removeDialogOpen.value = open;
  if (!open) {
    removeDialogGuard.cancel();
    selectedRemoveNode.value = null;
    clearActionFeedback("remove-node");
  }
}

function openTagsDialog(node: HeadscaleNode) {
  clearActionFeedback("node-tags");
  selectedTagsNode.value = node;
  tagsForm.tags = node.tags.join(", ");
}

function handleTagsDialogOpen(open: boolean) {
  if (!open && isActionPending("node-tags")) {
    return;
  }
  if (!open) {
    selectedTagsNode.value = null;
    tagsForm.tags = "";
    clearActionFeedback("node-tags");
  }
}

async function confirmSetNodeTags() {
  const node = selectedTagsNode.value;
  if (!node) {
    return;
  }
  const updated = await mutate("node-tags", (client) =>
    client.setTags({
      nodeId: node.id,
      tags: tagsForm.tags,
    }),
  );
  if (updated) {
    handleTagsDialogOpen(false);
  }
}

async function renameNode(node: HeadscaleNode) {
  return mutate("rename-node", (client) =>
    client.renameNode({
      nodeId: node.id,
      newName: renameDraft.value || nodeDisplayName(node),
    }),
  );
}

async function expireNode(node: HeadscaleNode) {
  return mutate("expire-node", (client) =>
    client.expireNode({ nodeId: node.id, expiry: new Date().toISOString() }),
  );
}

async function deleteNode(node: HeadscaleNode) {
  return mutate("remove-node", (client) => client.deleteNode({ nodeId: node.id }));
}

async function confirmRenameNode() {
  const node = selectedRenameNode.value;
  if (!node) {
    return;
  }
  const renamed = await renameNode(node);
  if (renamed) {
    handleRenameDialogOpen(false);
  }
}

async function confirmExpireNode() {
  const node = selectedExpireNode.value;
  if (!node) {
    return;
  }
  const expired = await expireNode(node);
  if (expired) {
    handleExpireDialogOpen(false);
  }
}

async function confirmRemoveNode() {
  const node = selectedRemoveNode.value;
  if (!node) {
    return;
  }
  const removed = await deleteNode(node);
  if (removed) {
    handleRemoveDialogOpen(false);
  }
}

async function jumpToRoutesForMachine(node: HeadscaleNode) {
  await router.push({ name: "routes" });
  await nextTick();
  document.querySelector<HTMLElement>(`[data-testid="route-node-${node.id}"]`)?.scrollIntoView({
    block: "center",
    inline: "nearest",
  });
}

function openUserDetailsExternal(user?: HeadscaleUser) {
  if (!hasVisibleUser(user)) {
    return;
  }
  void router.push({ name: "members", query: { user: user.id, from: "devices", popup: "user" } });
}
</script>

<template>
  <section class="space-y-3 sm:space-y-4">
    <Dialog :open="deviceSetupDialogOpen" @update:open="handleDeviceSetupDialogOpen">
      <DialogContent class="max-h-[min(90vh,760px)] overflow-y-auto sm:max-w-4xl" data-testid="add-device-dialog">
        <div class="grid gap-4" data-testid="add-device-wizard">
          <DialogHeader>
            <DialogTitle>{{ deviceSetupTask ? deviceSetupTitle : copy.addDevice }}</DialogTitle>
            <DialogDescription>
              <span class="block">{{ copy.deviceSetupLead }}</span>
              <span v-if="deviceSetupTask" class="mt-1 block">{{ deviceSetupDescription }}</span>
            </DialogDescription>
          </DialogHeader>

          <div class="grid gap-4">
            <nav
              v-if="deviceSetupTask"
              class="grid gap-2 sm:grid-cols-2 lg:grid-cols-4"
              :aria-label="copy.addDevice"
              data-testid="add-device-stepper"
            >
              <button
                v-for="(step, index) in addDeviceSteps"
                :key="step.id"
                type="button"
                class="flex min-w-0 items-start gap-2 rounded-md border bg-background px-3 py-2 text-start"
                :class="[
                  addDeviceStep === step.id
                    ? 'border-primary bg-primary/5 text-foreground'
                    : 'text-muted-foreground',
                  isAddDeviceStepComplete(index) ? 'border-primary/40' : '',
                ]"
                :disabled="index > addDeviceStepIndex"
                :aria-current="addDeviceStep === step.id ? 'step' : undefined"
                :data-testid="`add-device-step-${step.id}`"
                @click="goToAddDeviceStep(index)"
              >
                <span class="flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium">
                  <Check v-if="isAddDeviceStepComplete(index)" class="h-3 w-3" aria-hidden="true" />
                  <span v-else>{{ index + 1 }}</span>
                </span>
                <span class="grid min-w-0 gap-0.5">
                  <span class="truncate text-sm font-medium">{{ step.label }}</span>
                  <span class="line-clamp-2 text-xs leading-4 text-muted-foreground">{{ step.description }}</span>
                </span>
              </button>
            </nav>

            <div class="min-w-0">
              <div v-if="addDeviceStep === 'type'" class="grid gap-3 sm:grid-cols-3" data-testid="add-device-options">
                <Button
                  type="button"
                  variant="outline"
                  class="h-auto w-full items-start justify-start gap-3 whitespace-normal p-4 text-start"
                  data-testid="add-linux-device"
                  @click="prepareDeviceInvite('server')"
                >
                  <Server class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span class="grid min-w-0 gap-1">
                    <span class="font-medium">{{ copy.linuxServer }}</span>
                    <span class="text-xs leading-5 text-muted-foreground">{{ copy.linuxServerDescription }}</span>
                  </span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  class="h-auto w-full items-start justify-start gap-3 whitespace-normal p-4 text-start"
                  data-testid="add-client-device"
                  @click="prepareDeviceInvite('client')"
                >
                  <Network class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span class="grid min-w-0 gap-1">
                    <span class="font-medium">{{ copy.clientDevice }}</span>
                    <span class="text-xs leading-5 text-muted-foreground">{{ copy.clientDeviceDescription }}</span>
                  </span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  class="h-auto w-full items-start justify-start gap-3 whitespace-normal p-4 text-start"
                  data-testid="add-pending-node"
                  @click="preparePendingRegistration"
                >
                  <ShieldCheck class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span class="grid min-w-0 gap-1">
                    <span class="font-medium">{{ copy.pendingRegistrationTitle }}</span>
                    <span class="text-xs leading-5 text-muted-foreground">{{ copy.pendingRegistrationDescription }}</span>
                  </span>
                </Button>
              </div>

              <div
                v-else-if="deviceSetupTask === 'pending' && addDeviceStep === 'pending'"
                class="grid gap-4"
                data-testid="pending-registration-flow"
              >
                <div class="grid gap-4">
                  <section class="grid gap-3 rounded-md border bg-background p-4">
                    <div>
                      <h3 class="text-sm font-semibold">{{ copy.pendingNode }}</h3>
                      <p class="mt-1 text-xs leading-5 text-muted-foreground">{{ copy.pendingNodeDescription }}</p>
                    </div>
                    <div class="grid gap-2">
                      <Label for="pending-registration-user">{{ copy.inviteOwner }}</Label>
                      <NativeSelect id="pending-registration-user" v-model="pendingRegistrationForm.user" data-testid="pending-registration-user">
                        <NativeSelectOption v-for="user in visibleUsers" :key="user.id" :value="user.name">
                          {{ userLabel(user) }}
                        </NativeSelectOption>
                      </NativeSelect>
                    </div>
                    <div class="grid gap-2">
                      <Label for="pending-node-key">{{ copy.nodeRegistrationKey }}</Label>
                      <Input
                        id="pending-node-key"
                        v-model="pendingRegistrationForm.key"
                        data-testid="pending-node-key"
                        :placeholder="copy.nodeRegistrationKeyPlaceholder"
                      />
                    </div>
                    <Button type="button" class="w-fit" data-testid="register-pending-node" :disabled="isActionPending('register-pending-node')" @click="registerPendingNode">
                      <LoaderCircle v-if="isActionPending('register-pending-node')" class="h-4 w-4 animate-spin" aria-hidden="true" />
                      <ShieldCheck v-else class="h-4 w-4" aria-hidden="true" />
                      {{ copy.registerPendingNode }}
                    </Button>
                    <p
                      v-if="actionError('register-pending-node')"
                      role="alert"
                      class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                      data-testid="register-pending-node-error"
                    >
                      {{ actionError("register-pending-node") }}
                    </p>
                  </section>

                </div>
              </div>

              <div
                v-else-if="deviceSetupTask === 'pending' && addDeviceStep === 'result'"
                class="grid gap-2 rounded-md border bg-card p-4"
                data-testid="registration-result"
              >
                <p v-if="lastRegisteredNode" class="text-sm font-medium">
                  {{ copy.registeredNode }}: {{ nodeDisplayName(lastRegisteredNode) }}
                </p>
              </div>

              <div v-else-if="deviceSetupTask" class="grid gap-4" data-testid="device-setup-flow">
                <section v-if="addDeviceStep === 'preferences'" class="grid gap-3" data-testid="setup-device-step">
                  <div class="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{{ deviceSetupTask === "server" ? copy.linuxServer : copy.clientDevice }}</Badge>
                    <h2 class="text-lg font-semibold">{{ copy.setupDevice }}</h2>
                  </div>
                  <div class="grid gap-4">
                    <div class="grid gap-2">
                      <div class="flex items-start justify-between gap-4">
                        <div>
                          <h3 class="text-sm font-semibold">{{ copy.tags }}</h3>
                          <p class="mt-1 text-xs leading-5 text-muted-foreground">{{ copy.useTagsDescription }}</p>
                        </div>
                        <Switch
                          :model-value="inviteForm.aclTags.trim().length > 0"
                          data-testid="setup-tags-enabled"
                          @update:model-value="inviteForm.aclTags = $event ? 'tag:server' : ''"
                        />
                      </div>
                      <Input id="setup-tags" v-model="inviteForm.aclTags" data-testid="setup-tags" placeholder="tag:server" />
                      <button
                        type="button"
                        class="w-fit text-xs font-medium text-primary underline underline-offset-4"
                        data-testid="setup-manage-tags"
                        @click="openAccessFromDeviceSetup"
                      >
                        {{ copy.manageTags }}
                      </button>
                    </div>
                    <div class="flex items-start justify-between gap-4">
                      <div>
                        <h3 class="text-sm font-semibold">{{ copy.ephemeral }}</h3>
                        <p class="mt-1 text-xs leading-5 text-muted-foreground">{{ copy.ephemeralDescription }}</p>
                      </div>
                      <Switch v-model="inviteForm.ephemeral" data-testid="setup-ephemeral" />
                    </div>
                    <div class="flex items-start justify-between gap-4">
                      <div>
                        <h3 class="text-sm font-semibold">{{ copy.exitRoute }}</h3>
                        <p class="mt-1 text-xs leading-5 text-muted-foreground">{{ copy.exitNodeDescription }}</p>
                      </div>
                      <Switch data-testid="setup-exit-node" />
                    </div>
                  </div>
                </section>

                <section v-else-if="addDeviceStep === 'authKey'" class="grid gap-3" data-testid="setup-auth-key-step">
                  <div class="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{{ deviceSetupTask === "server" ? copy.linuxServer : copy.clientDevice }}</Badge>
                    <h2 class="text-lg font-semibold">{{ copy.setupAuthKey }}</h2>
                  </div>
                  <div class="grid gap-4">
                    <div class="grid gap-2">
                      <div class="flex items-start justify-between gap-4">
                        <div>
                          <h3 class="text-sm font-semibold">{{ copy.reusable }}</h3>
                          <p class="mt-1 text-xs leading-5 text-muted-foreground">{{ copy.reusableDescription }}</p>
                        </div>
                        <Switch v-model="inviteForm.reusable" data-testid="setup-reusable" />
                      </div>
                      <p class="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                        {{ copy.authKeyAutomationHint }}
                      </p>
                    </div>
                    <div class="grid gap-2">
                      <Label for="setup-expiration">{{ copy.inviteExpiration }}</Label>
                      <p class="text-xs leading-5 text-muted-foreground">{{ copy.authKeyExpirationDescription }}</p>
                      <div class="flex flex-wrap items-center gap-2">
                        <div class="inline-flex h-9 items-center overflow-hidden rounded-md border bg-background">
                          <Input
                            id="setup-expiration"
                            :model-value="String(authKeyExpiryDays)"
                            data-testid="setup-expiration"
                            inputmode="numeric"
                            class="h-9 w-14 rounded-none border-0 text-center"
                            @update:model-value="setAuthKeyExpiryDays(Number($event))"
                          />
                          <button
                            type="button"
                            class="h-9 border-s px-3 text-sm"
                            data-testid="setup-expiration-decrement"
                            @click="setAuthKeyExpiryDays(authKeyExpiryDays - 1)"
                          >
                            -
                          </button>
                          <button
                            type="button"
                            class="h-9 border-s px-3 text-sm"
                            data-testid="setup-expiration-increment"
                            @click="setAuthKeyExpiryDays(authKeyExpiryDays + 1)"
                          >
                            +
                          </button>
                        </div>
                        <span class="text-sm text-muted-foreground">{{ copy.days }}</span>
                      </div>
                      <p class="text-xs text-muted-foreground">{{ copy.mustBeBetweenDays }}</p>
                      <p class="rounded-md bg-muted/60 px-3 py-2 text-xs leading-5 text-muted-foreground">
                        {{ copy.keyExpiryHint }}
                      </p>
                    </div>
                  </div>
                </section>

                <section v-else-if="addDeviceStep === 'generate'" class="grid gap-3" data-testid="setup-generate-step">
                  <div class="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{{ deviceSetupTask === "server" ? copy.linuxServer : copy.clientDevice }}</Badge>
                    <Badge v-if="inviteForm.aclTags" variant="outline">{{ inviteForm.aclTags }}</Badge>
                    <Badge v-if="inviteForm.reusable" variant="outline">{{ copy.reusable }}</Badge>
                    <Badge v-if="inviteForm.ephemeral" variant="outline">{{ copy.ephemeral }}</Badge>
                  </div>
                  <div class="grid gap-3">
                    <Button class="w-fit" data-testid="generate-install-script" :disabled="inviteDialogOpen || isActionPending('create-invite')" @click="openInviteDialogFromDeviceSetup">
                      <KeyRound class="h-4 w-4" aria-hidden="true" />
                      {{ copy.generateInstallScript }}
                    </Button>
                    <div v-if="lastCreatedInvite" class="grid gap-3 rounded-md border bg-card p-4" data-testid="created-invite">
                      <div>
                        <p class="text-sm font-medium">{{ copy.inviteKey }}</p>
                        <code class="mt-2 block break-all rounded-md bg-secondary px-2 py-1 text-xs">{{ lastCreatedInvite }}</code>
                      </div>
                      <div>
                        <p class="text-sm font-medium">{{ copy.installCommand }}</p>
                        <code class="mt-2 block break-all rounded-md bg-secondary px-2 py-1 text-xs">{{ installCommand }}</code>
                      </div>
                      <Button size="sm" variant="outline" class="w-fit" data-testid="copy-setup-install-command" @click="copyInviteKey(installCommand)">
                        <Copy class="h-4 w-4" aria-hidden="true" />
                        {{ copiedKey === installCommand ? copy.copied : copy.copyCommand }}
                      </Button>
                    </div>
                  </div>
                </section>
              </div>
            </div>
          </div>

          <DialogFooter v-if="deviceSetupTask" class="gap-2 sm:justify-between">
            <Button type="button" variant="outline" data-testid="add-device-prev" @click="goToPreviousAddDeviceStep">
              {{ copy.previousStep }}
            </Button>
            <Button
              v-if="addDeviceStep === 'generate' || addDeviceStep === 'result'"
              type="button"
              data-testid="add-device-finish"
              @click="finishAddDeviceFlow"
            >
              {{ copy.finish }}
            </Button>
            <Button
              v-else
              type="button"
              data-testid="add-device-next"
              :disabled="!canMoveAddDeviceNext"
              @click="goToNextAddDeviceStep"
            >
              {{ copy.nextStep }}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>

    <Dialog :open="Boolean(selectedDetailNode)" @update:open="handleNodeDetailsOpen">
      <DialogContent class="max-h-[85vh] overflow-y-auto sm:max-w-3xl" data-testid="device-detail-dialog">
        <template v-if="selectedDetailNode">
          <DialogHeader>
            <DialogTitle class="flex min-w-0 items-center gap-2">
              <Network class="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span class="truncate">{{ nodeDisplayName(selectedDetailNode) }}</span>
            </DialogTitle>
            <DialogDescription>{{ copy.machineDetails }}</DialogDescription>
          </DialogHeader>

          <div class="grid gap-4">
            <div class="flex flex-wrap items-center gap-2">
              <Badge variant="outline" :class="nodeStatusClass(selectedDetailNode)" :data-testid="`device-detail-status-${selectedDetailNode.id}`">
                <Wifi v-if="selectedDetailNode.online" class="h-3 w-3" aria-hidden="true" />
                <WifiOff v-else class="h-3 w-3" aria-hidden="true" />
                {{ nodeStatusLabel(selectedDetailNode) }}
              </Badge>
              <Badge variant="outline">{{ copy.nodeId }}: {{ selectedDetailNode.id }}</Badge>
              <Badge v-if="selectedDetailNode.registerMethod" variant="outline">
                {{ selectedDetailNode.registerMethod }}
              </Badge>
            </div>

            <div class="grid gap-3 sm:grid-cols-2">
              <section class="grid gap-2 rounded-md border bg-background p-3">
                <h3 class="text-sm font-semibold">{{ copy.owner }}</h3>
                <button
                  v-if="hasVisibleUser(selectedDetailNode.user)"
                  type="button"
                  class="w-fit text-start text-sm font-medium text-primary underline underline-offset-4"
                  :data-testid="`device-detail-owner-${selectedDetailNode.id}`"
                  @click="openUserDetailsExternal(selectedDetailNode.user)"
                >
                  {{ nodeOwner(selectedDetailNode) }}
                </button>
                <span v-else class="text-sm text-muted-foreground">-</span>
              </section>

              <section class="grid gap-2 rounded-md border bg-background p-3">
                <h3 class="text-sm font-semibold">{{ copy.details }}</h3>
                <p class="text-sm text-muted-foreground">{{ copy.lastSeen }}: {{ formatDate(selectedDetailNode.lastSeen) }}</p>
                <p class="text-sm text-muted-foreground">{{ copy.expires }}: {{ formatDate(selectedDetailNode.expiry) }}</p>
              </section>
            </div>

            <section class="grid gap-2">
              <h3 class="text-sm font-semibold">{{ copy.addresses }}</h3>
              <div class="flex flex-wrap gap-1">
                <Badge
                  v-for="(address, addressIndex) in selectedDetailNode.ipAddresses"
                  :key="address"
                  variant="outline"
                  class="border-slate-200 bg-muted/60 font-mono text-[11px] text-muted-foreground dark:border-slate-800"
                  :data-testid="`device-detail-ip-${selectedDetailNode.id}-${addressIndex}`"
                >
                  {{ address }}
                </Badge>
              </div>
            </section>

            <section v-if="selectedDetailNode.tags.length" class="grid gap-2">
              <h3 class="text-sm font-semibold">{{ copy.tags }}</h3>
              <div class="flex flex-wrap gap-1">
                <Badge
                  v-for="tag in selectedDetailNode.tags"
                  :key="tag"
                  variant="outline"
                  :class="deviceTagClass(tag)"
                >
                  {{ tag }}
                </Badge>
              </div>
            </section>

            <section class="grid gap-2">
              <h3 class="text-sm font-semibold">{{ copy.routes }}</h3>
              <div class="flex flex-wrap gap-1">
                <Badge
                  v-for="route in nodePendingRoutes(selectedDetailNode)"
                  :key="route"
                  variant="outline"
                  :class="pendingRouteClass(route)"
                >
                  {{ route }}
                </Badge>
                <Badge
                  v-for="route in selectedDetailNode.approvedRoutes"
                  :key="route"
                  variant="outline"
                  :class="approvedRouteClass()"
                >
                  {{ route }}
                </Badge>
                <span
                  v-if="nodePendingRoutes(selectedDetailNode).length === 0 && selectedDetailNode.approvedRoutes.length === 0"
                  class="text-sm text-muted-foreground"
                >
                  {{ copy.noRouteValues }}
                </span>
              </div>
            </section>
          </div>

        </template>
      </DialogContent>
    </Dialog>

    <Dialog :open="renameDialogOpen" @update:open="handleRenameDialogOpen">
      <DialogContent v-if="selectedRenameNode" data-testid="rename-node-dialog">
        <DialogHeader>
          <DialogTitle>{{ copy.renameMachineTitle }}</DialogTitle>
          <DialogDescription>
            {{ copy.renameMachineDescription }}
          </DialogDescription>
        </DialogHeader>
        <div class="grid gap-2">
          <Label for="rename-node-dialog-input">{{ copy.machineName }}</Label>
          <Input
            id="rename-node-dialog-input"
            v-model="renameDraft"
            data-testid="rename-node-dialog-input"
            @keydown.enter.prevent="confirmRenameNode"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" data-testid="rename-node-cancel" :disabled="isActionPending('rename-node')" @click="handleRenameDialogOpen(false)">
            {{ copy.cancel }}
          </Button>
          <Button data-testid="rename-node-confirm" :disabled="isActionPending('rename-node')" @click="confirmRenameNode">
            <LoaderCircle v-if="isActionPending('rename-node')" class="h-4 w-4 animate-spin" aria-hidden="true" />
            {{ copy.saveName }}
          </Button>
        </DialogFooter>
        <p
          v-if="actionError('rename-node')"
          role="alert"
          class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="rename-node-error"
        >
          {{ actionError("rename-node") }}
        </p>
      </DialogContent>
    </Dialog>

    <Dialog :open="Boolean(selectedTagsNode)" @update:open="handleTagsDialogOpen">
      <DialogContent v-if="selectedTagsNode" data-testid="node-tags-dialog">
        <DialogHeader>
          <DialogTitle>{{ copy.editNodeTagsTitle }}</DialogTitle>
          <DialogDescription>
            {{ copy.editNodeTagsDescription }}
          </DialogDescription>
        </DialogHeader>
        <div class="grid gap-2">
          <Label for="node-tags-input">{{ copy.nodeTags }}</Label>
          <Input
            id="node-tags-input"
            v-model="tagsForm.tags"
            data-testid="node-tags-input"
            placeholder="tag:server, tag:router"
          />
          <p class="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            {{ copy.replaceTagsWarning }}
          </p>
        </div>
        <p
          v-if="actionError('node-tags')"
          role="alert"
          class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="node-tags-error"
        >
          {{ actionError("node-tags") }}
        </p>
        <DialogFooter>
          <Button type="button" variant="outline" data-testid="node-tags-cancel" :disabled="isActionPending('node-tags')" @click="handleTagsDialogOpen(false)">
            {{ copy.cancel }}
          </Button>
          <Button type="button" data-testid="node-tags-confirm" :disabled="isActionPending('node-tags')" @click="confirmSetNodeTags">
            <LoaderCircle v-if="isActionPending('node-tags')" class="h-4 w-4 animate-spin" aria-hidden="true" />
            {{ copy.saveTags }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <AlertDialog :open="expireDialogOpen" @update:open="handleExpireDialogOpen">
      <AlertDialogContent v-if="selectedExpireNode" data-testid="expire-node-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{{ copy.expireMachineTitle }}</AlertDialogTitle>
          <AlertDialogDescription>
            {{ copy.expireMachineDescription }}
            <span class="mt-2 block font-medium text-foreground">{{ nodeDisplayName(selectedExpireNode) }}</span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p
          v-if="actionError('expire-node')"
          role="alert"
          class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="expire-node-error"
        >
          {{ actionError("expire-node") }}
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="expire-node-cancel" :disabled="isActionPending('expire-node')">{{ copy.cancel }}</AlertDialogCancel>
          <Button variant="destructive" data-testid="expire-node-confirm" :disabled="isActionPending('expire-node')" @click="confirmExpireNode">
            <LoaderCircle v-if="isActionPending('expire-node')" class="h-4 w-4 animate-spin" aria-hidden="true" />
            {{ copy.confirmExpire }}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog :open="removeDialogOpen" @update:open="handleRemoveDialogOpen">
      <AlertDialogContent v-if="selectedRemoveNode" data-testid="remove-node-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{{ copy.removeMachineTitle }}</AlertDialogTitle>
          <AlertDialogDescription>
            {{ copy.removeMachineDescription }}
            <span class="mt-2 block font-medium text-foreground">{{ nodeDisplayName(selectedRemoveNode) }}</span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p
          v-if="actionError('remove-node')"
          role="alert"
          class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="remove-node-error"
        >
          {{ actionError("remove-node") }}
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="remove-node-cancel" :disabled="isActionPending('remove-node')">{{ copy.cancel }}</AlertDialogCancel>
          <Button variant="destructive" data-testid="remove-node-confirm" :disabled="isActionPending('remove-node')" @click="confirmRemoveNode">
            <LoaderCircle v-if="isActionPending('remove-node')" class="h-4 w-4 animate-spin" aria-hidden="true" />
            {{ copy.confirmRemove }}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <div class="grid gap-3" data-testid="machines-workbench">
      <div class="grid gap-2 sm:flex sm:items-start sm:justify-between sm:gap-3">
        <div>
          <h1 class="text-xl font-semibold">{{ copy.devicesTitle }}</h1>
          <p class="mt-1 text-xs text-muted-foreground sm:text-sm">
            {{ copy.devicesSubtitle }}
            <a
              href="https://tailscale.com/kb/1017/install"
              class="cursor-pointer font-medium text-primary underline underline-offset-4"
              data-testid="install-docs-link"
            >
              {{ copy.learnMore }}
            </a>
          </p>
        </div>
        <Button size="sm" class="w-fit" data-testid="add-device-toggle" @click="openDeviceSetupDialog">
          <Plus class="h-4 w-4" aria-hidden="true" />
          {{ copy.addDevice }}
        </Button>
      </div>

      <Card v-if="snapshot.nodes.length === 0" class="relative overflow-hidden bg-accent/35 p-5 sm:p-8" data-testid="machines-empty">
        <div class="relative z-10 max-w-md">
          <h2 class="text-lg font-semibold">{{ copy.addFirstDevice }}</h2>
          <p class="mt-2 text-sm text-muted-foreground">{{ copy.addFirstDeviceDescription }}</p>
          <Button class="mt-4" data-testid="add-first-device" @click="prepareDeviceInvite('client')">
            <Plus class="h-4 w-4" aria-hidden="true" />
            {{ copy.addDevice }}
          </Button>
        </div>
        <div class="pointer-events-none absolute bottom-0 end-0 hidden grid-cols-4 gap-0 p-4 sm:grid" aria-hidden="true">
          <span class="h-12 w-12 rounded-tl-full bg-primary/90" />
          <span class="h-12 w-12 rounded-full bg-primary/20" />
          <span class="h-12 w-12 rounded-br-full bg-primary/80" />
          <span class="h-12 w-12 bg-primary/10" />
          <span class="h-12 w-12 rounded-full bg-primary/80" />
          <span class="h-12 w-12 rounded-br-full bg-primary/25" />
          <span class="h-12 w-12 rounded-full bg-primary/90" />
          <span class="h-12 w-12 rounded-bl-full bg-primary/20" />
        </div>
      </Card>

      <div v-else class="min-w-0 space-y-2" data-testid="machine-table-shell">
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center" data-testid="machine-toolbar">
          <div class="w-full sm:max-w-sm">
            <Label for="device-search" class="sr-only">{{ copy.searchDevices }}</Label>
            <div class="relative">
              <Search class="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input id="device-search" v-model="deviceSearch" data-testid="device-search" class="ps-8" :placeholder="copy.searchDevices" />
            </div>
          </div>
          <div class="w-full sm:w-48">
            <Label for="machine-filter" class="sr-only">{{ copy.filters }}</Label>
            <div class="relative">
              <Filter class="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <NativeSelect id="machine-filter" v-model="machineFilter" data-testid="machine-filter" class="ps-8">
                <NativeSelectOption value="all">{{ copy.allMachines }}</NativeSelectOption>
                <NativeSelectOption value="online">{{ copy.onlineOnly }}</NativeSelectOption>
                <NativeSelectOption value="offline">{{ copy.offlineOnly }}</NativeSelectOption>
                <NativeSelectOption value="expired">{{ copy.expiredOnly }}</NativeSelectOption>
                <NativeSelectOption value="routes">{{ copy.routeAdvertisers }}</NativeSelectOption>
                <NativeSelectOption value="tagged">{{ copy.taggedOnly }}</NativeSelectOption>
              </NativeSelect>
            </div>
          </div>
          <p class="whitespace-nowrap text-xs text-muted-foreground sm:ms-auto">{{ filteredNodes.length }} / {{ snapshot.nodes.length }}</p>
          <Button
            type="button"
            variant="outline"
            size="icon"
            data-testid="refresh-machines"
            :aria-label="copy.refreshData"
            :title="copy.refreshData"
            :disabled="isRefreshingSnapshot"
            @click="refreshDevices"
          >
            <LoaderCircle v-if="isRefreshingSnapshot" class="h-4 w-4 animate-spin" aria-hidden="true" />
            <RefreshCw v-else class="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button type="button" variant="outline" size="icon" data-testid="export-machines" :aria-label="copy.exportData" @click="exportMachines">
            <Download class="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button v-if="hasMachineFilters" type="button" variant="ghost" class="w-full sm:w-fit" data-testid="clear-machine-filters" @click="clearMachineFilters">
            {{ copy.clearFilters }}
          </Button>
        </div>
        <Card class="w-full max-w-full min-w-0 overflow-x-auto" data-testid="machine-list">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{{ copy.devicesTableMachine }}</TableHead>
                <TableHead>{{ copy.devicesTableUser }}</TableHead>
                <TableHead>{{ copy.devicesTableRoutes }}</TableHead>
                <TableHead>{{ copy.devicesTableActivity }}</TableHead>
                <TableHead class="hidden md:table-cell">{{ copy.actions }}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow
                v-for="node in filteredNodes"
                :key="node.id"
                :data-testid="`device-${node.id}`"
              >
                <TableCell class="align-top md:min-w-64">
                  <div class="flex min-w-0 items-center gap-2">
                    <Network class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <button
                      type="button"
                      class="truncate font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      :data-testid="`device-detail-link-${node.id}`"
                      @click="openNodeDetails(node)"
                    >
                      {{ nodeDisplayName(node) }}
                    </button>
                  </div>
                  <div class="mt-2 flex flex-wrap gap-1">
                    <Badge
                      v-for="(address, addressIndex) in node.ipAddresses"
                      :key="address"
                      variant="outline"
                      class="border-slate-200 bg-muted/60 font-mono text-[11px] text-muted-foreground dark:border-slate-800"
                      :data-testid="`device-ip-${node.id}-${addressIndex}`"
                    >
                      {{ address }}
                    </Badge>
                  </div>
                  <div v-if="node.tags.length" class="mt-2 flex flex-wrap gap-1">
                    <Badge
                      v-for="(tag, tagIndex) in node.tags"
                      :key="tag"
                      variant="outline"
                      :class="deviceTagClass(tag)"
                      :data-testid="`device-tag-${node.id}-${tagIndex}`"
                    >
                      {{ tag }}
                    </Badge>
                  </div>
                  <div class="mt-2 md:hidden">
                    <DropdownMenu>
                      <DropdownMenuTrigger as-child>
                        <Button
                          variant="outline"
                          size="icon"
                          :aria-label="`${copy.actions}: ${nodeDisplayName(node)}`"
                          :data-testid="`machine-actions-trigger-mobile-${node.id}`"
                        >
                          <EllipsisVertical class="h-4 w-4" aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" class="w-64" :data-testid="`machine-actions-menu-mobile-${node.id}`">
                        <DropdownMenuLabel>{{ copy.actions }}</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem :data-testid="`view-node-details-action-mobile-${node.id}`" @click="openNodeDetails(node)">
                          <FileCheck2 class="h-4 w-4" aria-hidden="true" />
                          {{ copy.viewDetails }}
                        </DropdownMenuItem>
                        <DropdownMenuItem :data-testid="`view-node-routes-action-mobile-${node.id}`" @click="jumpToRoutesForMachine(node)">
                          <Router class="h-4 w-4" aria-hidden="true" />
                          {{ copy.viewRoutes }}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem :data-testid="`rename-node-action-mobile-${node.id}`" @click="openRenameDialog(node)">
                          <Pencil class="h-4 w-4" aria-hidden="true" />
                          {{ copy.rename }}
                        </DropdownMenuItem>
                        <DropdownMenuItem :data-testid="`edit-node-tags-action-mobile-${node.id}`" @click="openTagsDialog(node)">
                          <ShieldCheck class="h-4 w-4" aria-hidden="true" />
                          {{ copy.editTags }}
                        </DropdownMenuItem>
                        <DropdownMenuItem :data-testid="`expire-node-action-mobile-${node.id}`" @click="openExpireDialog(node)">
                          <Clock class="h-4 w-4" aria-hidden="true" />
                          {{ copy.expire }}
                        </DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" :data-testid="`remove-node-action-mobile-${node.id}`" @click="openRemoveDialog(node)">
                          <Trash2 class="h-4 w-4" aria-hidden="true" />
                          {{ copy.remove }}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </TableCell>
                <TableCell class="align-top md:min-w-40">
                  <div v-if="hasVisibleUser(node.user)">
                    <button
                      type="button"
                      class="text-start underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      :data-testid="`device-owner-link-${node.id}`"
                      @click="openUserDetailsExternal(node.user)"
                    >
                      <bdi dir="auto">{{ nodeOwner(node) }}</bdi>
                    </button>
                    <p class="text-xs text-muted-foreground"><bdi dir="auto">{{ node.user.email || node.user.name }}</bdi></p>
                  </div>
                  <span v-else aria-hidden="true" class="text-muted-foreground">-</span>
                </TableCell>
                <TableCell class="align-top md:min-w-56">
                  <button
                    v-if="nodePendingRoutes(node).length"
                    type="button"
                    class="flex flex-wrap gap-1 rounded-md text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    :data-testid="`device-pending-routes-${node.id}`"
                    @click="jumpToRoutesForMachine(node)"
                  >
                    <Badge
                      v-for="(route, routeIndex) in nodePendingRoutes(node)"
                      :key="route"
                      variant="outline"
                      class="cursor-pointer hover:opacity-90"
                      :class="pendingRouteClass(route)"
                      :data-testid="`device-pending-route-${node.id}-${routeIndex}`"
                    >
                      <bdi dir="ltr">{{ route }}</bdi>
                    </Badge>
                  </button>
                  <div
                    v-if="node.approvedRoutes.length"
                    class="flex flex-wrap gap-1"
                    :class="{ 'mt-2': nodePendingRoutes(node).length }"
                  >
                    <Badge
                      v-for="(route, routeIndex) in node.approvedRoutes"
                      :key="route"
                      variant="outline"
                      :class="approvedRouteClass()"
                      :data-testid="`device-approved-route-${node.id}-${routeIndex}`"
                    >
                      {{ route }}
                    </Badge>
                  </div>
                </TableCell>
                <TableCell class="align-top md:min-w-44">
                  <Badge
                    variant="outline"
                    :class="nodeStatusClass(node)"
                    :data-testid="`device-status-${node.id}`"
                  >
                    <Wifi v-if="node.online" class="h-3 w-3" aria-hidden="true" />
                    <WifiOff v-else class="h-3 w-3" aria-hidden="true" />
                    {{ nodeStatusLabel(node) }}
                  </Badge>
                  <p class="mt-2 text-xs text-muted-foreground">{{ copy.lastSeen }}: {{ formatDate(node.lastSeen) }}</p>
                  <p class="text-xs text-muted-foreground">{{ copy.expires }}: {{ formatDate(node.expiry) }}</p>
                </TableCell>
                <TableCell class="hidden align-top md:table-cell md:min-w-16">
                  <div class="flex justify-start">
                    <DropdownMenu>
                      <DropdownMenuTrigger as-child>
                        <Button
                          variant="outline"
                          size="icon"
                          :aria-label="`${copy.actions}: ${nodeDisplayName(node)}`"
                          :data-testid="`machine-actions-trigger-${node.id}`"
                        >
                          <EllipsisVertical class="h-4 w-4" aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" class="w-64" :data-testid="`machine-actions-menu-${node.id}`">
                        <DropdownMenuLabel>{{ copy.actions }}</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem :data-testid="`view-node-details-action-${node.id}`" @click="openNodeDetails(node)">
                          <FileCheck2 class="h-4 w-4" aria-hidden="true" />
                          {{ copy.viewDetails }}
                        </DropdownMenuItem>
                        <DropdownMenuItem :data-testid="`view-node-routes-action-${node.id}`" @click="jumpToRoutesForMachine(node)">
                          <Router class="h-4 w-4" aria-hidden="true" />
                          {{ copy.viewRoutes }}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem :data-testid="`rename-node-action-${node.id}`" @click="openRenameDialog(node)">
                          <Pencil class="h-4 w-4" aria-hidden="true" />
                          {{ copy.rename }}
                        </DropdownMenuItem>
                        <DropdownMenuItem :data-testid="`edit-node-tags-action-${node.id}`" @click="openTagsDialog(node)">
                          <ShieldCheck class="h-4 w-4" aria-hidden="true" />
                          {{ copy.editTags }}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem :data-testid="`expire-node-action-${node.id}`" @click="openExpireDialog(node)">
                          <Clock class="h-4 w-4" aria-hidden="true" />
                          {{ copy.expire }}
                        </DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" :data-testid="`remove-node-action-${node.id}`" @click="openRemoveDialog(node)">
                          <Trash2 class="h-4 w-4" aria-hidden="true" />
                          {{ copy.remove }}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </TableCell>
              </TableRow>
              <TableRow v-if="filteredNodes.length === 0">
                <TableCell colspan="5" class="py-6 text-sm text-muted-foreground">
                  {{ copy.noDevices }}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </Card>
      </div>
    </div>

    <CreateAuthKeyDialog
      :open="inviteDialogOpen"
      :users="authKeyDialogUsers"
      :defaults="authKeyDialogDefaults"
      :labels="authKeyDialogLabels"
      :is-submitting="isActionPending('create-invite')"
      :error="actionError('create-invite')"
      @update:open="handleInviteDialogOpen"
      @submit="createInvite"
    />
  </section>
</template>
