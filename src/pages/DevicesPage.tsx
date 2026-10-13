import { useNavigate } from "@tanstack/react-router";
import {
  Check,
  Clock,
  Download,
  EllipsisVertical,
  FileCheck2,
  Filter,
  InfinityIcon,
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
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { HeadscaleNode } from "@/api/contracts";
import { normalizeHeadscaleNode } from "@/api/contracts";
import CreateAuthKeyDialog from "@/components/CreateAuthKeyDialog";
import {
  type AuthKeyDialogDefaults,
  type AuthKeyDialogPayload,
  authKeyDialogLabels,
  toAuthKeyDefaults,
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
import { CopyButton } from "@/components/ui/copy-button";
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
  DropdownMenuGroup,
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
import { useSession, useStore } from "@/composables/session-context";
import { useActionFeedback } from "@/composables/useActionFeedback";
import { useCreatePreAuthKey } from "@/composables/useCreatePreAuthKey";
import {
  type AddDeviceTask,
  useDeviceSetup,
  useRevealCreatedInvite,
} from "@/composables/useDeviceSetup";
import { useDisplayHelpers } from "@/composables/useDisplayHelpers";
import { useHeadscaleClient } from "@/composables/useHeadscaleClient";
import { useMutation } from "@/composables/useMutation";
import { useProductCopy } from "@/composables/useProductCopy";
import { useRefreshGuard } from "@/composables/useRefreshGuard";
import { useRouteIntent } from "@/composables/useRouteIntent";
import { useSessionDraft } from "@/composables/useSessionDraft";
import { useSnapshot } from "@/composables/useSnapshot";
import { useSegment } from "@/composables/useSnapshotSegment";
import { AUTH_ID_PLACEHOLDER, parseAuthRequest } from "@/domain/auth-request";
import { type NodeConnectionStatus, nodeConnectionStatus } from "@/domain/node-status";
import type { ProductCopy } from "@/i18n/product-copy";
import { cn } from "@/lib/utils";
import { downloadCsv } from "@/utils/csv";
import { nodePendingRoutes } from "@/utils/node";
import {
  approvedRouteClass,
  deviceTagClass,
  nodeStatusClass,
  pendingRouteClass,
} from "@/utils/status-class";
import { parseList, tailscaleUpCommand } from "@/utils/strings";
import { userLabel as userOptionLabel } from "@/utils/user";

type MachineFilter = "all" | NodeConnectionStatus | "routes" | "tagged";

type AddDeviceStepInfo = {
  id: ReturnType<typeof useDeviceSetup>["step"];
  label: string;
  description: string;
};

function deviceSetupTitle(task: AddDeviceTask | null, copy: ProductCopy) {
  if (task === "pending") return copy.pendingRegistrationTitle;
  return task === "server" ? copy.addLinuxServerTitle : copy.addClientDeviceTitle;
}

function deviceSetupDescription(task: AddDeviceTask | null, copy: ProductCopy) {
  if (task === "pending") return copy.pendingRegistrationDescription;
  return task === "server" ? copy.linuxServerDescription : copy.clientDeviceDescription;
}

function addDeviceSteps(task: AddDeviceTask | null, copy: ProductCopy): AddDeviceStepInfo[] {
  if (task === "pending") {
    return [
      {
        id: "pending",
        label: copy.pendingRegistrationTitle,
        description: copy.wizardStepPendingDescription,
      },
      { id: "result", label: copy.wizardResult, description: copy.wizardStepResultDescription },
    ];
  }
  if (task) {
    return [
      {
        id: "preferences",
        label: copy.setupDevice,
        description: copy.wizardStepPreferencesDescription,
      },
      {
        id: "authKey",
        label: copy.setupAuthKey,
        description: copy.wizardStepAuthKeyDescription,
      },
      {
        id: "generate",
        label: copy.generateInstallScript,
        description: copy.wizardStepGenerateDescription,
      },
    ];
  }
  return [];
}

export default function DevicesPage() {
  const { stale } = useStore(useSession().drafts);
  const { copy } = useProductCopy();
  const { snapshot, nodeById: currentNode } = useSnapshot();
  const { isRefreshing: isRefreshingSnapshot, refresh: refreshDevices } = useSegment(
    "fabric",
    "identity",
  );
  const { settings } = useHeadscaleClient();
  const { actionError, clearActionFeedback, isActionPending } = useActionFeedback();
  const {
    setState: setDeviceSetupState,
    open: deviceSetupDialogOpen,
    task: deviceSetupTask,
    step: addDeviceStep,
    authKeyExpiryDays,
    returnAfterInvite: returnToDeviceSetupAfterInvite,
    lastCreatedInvite,
    lastRegisteredNode,
    lastAuthDecision,
    pendingRegistrationForm,
  } = useDeviceSetup();
  const navigate = useNavigate();
  const intent = useRouteIntent();

  const [deviceSearch, setDeviceSearch] = useState("");
  const [machineFilter, setMachineFilter] = useState<MachineFilter>("all");

  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [selectedRenameNode, setSelectedRenameNode] = useState<HeadscaleNode | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [selectedExpireNode, setSelectedExpireNode] = useState<HeadscaleNode | null>(null);
  const [expireAction, setExpireAction] = useState<"expire" | "disable">("expire");
  const [selectedRemoveNode, setSelectedRemoveNode] = useState<HeadscaleNode | null>(null);
  const [selectedTagsNode, setSelectedTagsNode] = useState<HeadscaleNode | null>(null);
  const [selectedDetailNode, setSelectedDetailNode] = useState<HeadscaleNode | null>(null);

  const [inviteForm, setInviteForm] = useState<AuthKeyDialogDefaults>({
    user: "1",
    reusable: true,
    ephemeral: false,
    aclTags: "",
  });
  const [tagsForm, setTagsForm] = useState({
    tags: "",
  });
  const [tagsSyncing, setTagsSyncing] = useState(false);
  const [advertiseExitNode, setAdvertiseExitNode] = useState(false);
  const wizardKeyCardRef = useRef<HTMLFieldSetElement>(null);
  useRevealCreatedInvite(wizardKeyCardRef, deviceSetupDialogOpen);
  useSessionDraft(
    renameDialogOpen ||
      selectedExpireNode !== null ||
      selectedRemoveNode !== null ||
      selectedTagsNode !== null ||
      inviteDialogOpen ||
      deviceSetupDialogOpen ||
      returnToDeviceSetupAfterInvite,
  );

  const nodeDetailGuard = useRefreshGuard();
  const renameDialogGuard = useRefreshGuard();
  const expireDialogGuard = useRefreshGuard();
  const removeDialogGuard = useRefreshGuard();
  const tagsDialogGuard = useRefreshGuard();

  const { formatDate, userLabel, nodeDisplayName, nodeOwner, nodeStatusLabel, hasVisibleUser } =
    useDisplayHelpers();

  const visibleUsers = snapshot.users.filter((user) => hasVisibleUser(user));
  const [registrationUserOptions, setRegistrationUserOptions] = useState<
    { value: string; label: string }[]
  >([]);
  useEffect(() => {
    if (!stale)
      setRegistrationUserOptions(
        snapshot.users.filter(hasVisibleUser).map((user) => ({
          value: user.name,
          label: userOptionLabel(user, copy.unknown),
        })),
      );
  }, [snapshot.users, stale, hasVisibleUser, copy.unknown]);

  const query = deviceSearch.trim().toLowerCase();
  const filteredNodes = snapshot.nodes.filter((node) => {
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
      machineFilter === "all" ||
      (machineFilter === "routes" && node.availableRoutes.length > 0) ||
      (machineFilter === "tagged" && node.tags.length > 0) ||
      machineFilter === nodeConnectionStatus(node);

    return matchesSearch && matchesFilter;
  });

  const hasMachineFilters = deviceSearch.trim() !== "" || machineFilter !== "all";

  const installCommand = lastCreatedInvite
    ? tailscaleUpCommand(settings.baseUrl, lastCreatedInvite, advertiseExitNode)
    : "";

  const steps = addDeviceSteps(deviceSetupTask, copy);
  const addDeviceStepIndex = Math.max(
    0,
    steps.findIndex((step) => step.id === addDeviceStep),
  );
  const nextStep = steps[addDeviceStepIndex + 1];

  const { mutate, mutateWith } = useMutation();
  const createPreAuthKey = useCreatePreAuthKey();
  // A successful approve or reject must not turn into a failure because a refresh failed.
  const quiet = useMutation({ skipRefresh: true });
  // The stored name may no longer exist; the select and the write always use the one it shows.
  const registrationUser = registrationUserOptions.some(
    (option) => option.value === pendingRegistrationForm.user,
  )
    ? pendingRegistrationForm.user
    : (registrationUserOptions[0]?.value ?? "");
  const parsedAuthRequest = parseAuthRequest(pendingRegistrationForm.key);
  const authRequestHint =
    pendingRegistrationForm.key.trim() === ""
      ? null
      : !parsedAuthRequest
        ? "invalid"
        : pendingRegistrationForm.kind === "device" && parsedAuthRequest.source === "auth-link"
          ? "isSshCheck"
          : pendingRegistrationForm.kind === "ssh" && parsedAuthRequest.source === "register-link"
            ? "isRegistration"
            : null;
  const anyAuthPending =
    isActionPending("register-pending-node") ||
    isActionPending("approve-auth-request") ||
    isActionPending("reject-auth-request");
  const canSubmitAuthRequest =
    parsedAuthRequest !== null && authRequestHint === null && !anyAuthPending;
  const registerAuthId =
    canSubmitAuthRequest && registrationUser !== "" ? parsedAuthRequest.id : "";
  const decideAuthId = canSubmitAuthRequest ? parsedAuthRequest.id : "";
  const latest = useRef({ consumeDeviceQuery, renameDraft, deviceSetupTask });
  latest.current = { consumeDeviceQuery, renameDraft, deviceSetupTask };

  function exportMachines() {
    downloadCsv(
      "headscale-machines.csv",
      ["name", "owner", "status", "addresses", "tags", "routes", "lastSeen", "expires"],
      filteredNodes.map((node) => ({
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
    setDeviceSearch("");
    setMachineFilter("all");
  }

  function setAuthKeyExpiryDays(value: number) {
    const nextValue = Number.isFinite(value) ? value : 7;
    setDeviceSetupState({ authKeyExpiryDays: Math.min(90, Math.max(1, Math.round(nextValue))) });
  }

  function goToPreviousAddDeviceStep() {
    const previousStep = steps[addDeviceStepIndex - 1];
    if (!previousStep) {
      setDeviceSetupState({ task: null });
      setDeviceSetupState({ step: "type" });
      setDeviceSetupState({ lastCreatedInvite: "" });
      setDeviceSetupState({ lastRegisteredNode: null });
      return;
    }
    setDeviceSetupState({ step: previousStep.id });
  }

  function isAddDeviceStepComplete(index: number) {
    return index < addDeviceStepIndex;
  }

  function openDeviceSetupDialog() {
    setDeviceSetupState({ task: null });
    setDeviceSetupState({ step: "type" });
    setDeviceSetupState({ lastCreatedInvite: "" });
    setDeviceSetupState({ lastRegisteredNode: null });
    setDeviceSetupState({ open: true });
  }

  function prepareDeviceInvite(task: "server" | "client") {
    setDeviceSetupState({ task: task });
    setDeviceSetupState({ step: "preferences" });
    setDeviceSetupState({ open: true });
    setInviteForm((current) => ({ ...current, reusable: task === "server" }));
    setInviteForm((current) => ({ ...current, ephemeral: task === "client" }));
    setInviteForm((current) => ({ ...current, aclTags: task === "server" ? "tag:server" : "" }));
    setAdvertiseExitNode(false);
    setAuthKeyExpiryDays(7);
    setDeviceSetupState({ lastCreatedInvite: "" });
    setDeviceSetupState({ lastRegisteredNode: null });
  }

  function clearAuthFeedback() {
    clearActionFeedback("register-pending-node");
    clearActionFeedback("approve-auth-request");
    clearActionFeedback("reject-auth-request");
  }

  function preparePendingRegistration() {
    clearAuthFeedback();
    setDeviceSetupState({ task: "pending" });
    setDeviceSetupState({ step: "pending" });
    setDeviceSetupState({ open: true });
    setDeviceSetupState({ lastCreatedInvite: "" });
    setDeviceSetupState({ lastRegisteredNode: null });
  }

  // The dialog has no trigger, so Base UI only ever reports it closing.
  function closeDeviceSetupDialog() {
    if (anyAuthPending) return;
    setDeviceSetupState({ open: false });
    setDeviceSetupState({ returnAfterInvite: false });
    setDeviceSetupState({ task: null });
    setDeviceSetupState({ step: "type" });
    setDeviceSetupState({ lastCreatedInvite: "" });
    setDeviceSetupState({ lastRegisteredNode: null, lastAuthDecision: null });
    clearAuthFeedback();
  }

  function openInviteDialogFromDeviceSetup() {
    setDeviceSetupState({ returnAfterInvite: true });
    setDeviceSetupState({ step: "generate" });
    setDeviceSetupState({ open: false });
    openInviteDialog();
  }

  const authKeyDialogUsers = visibleUsers.map((user) => ({
    id: user.id,
    label: userLabel(user),
  }));

  function openInviteDialog() {
    clearActionFeedback("create-invite");
    setInviteDialogOpen(true);
  }

  // The dialog has no trigger, so Base UI only ever reports it closing. It is opened only from
  // the device setup wizard, which is why closing it always returns there.
  function closeInviteDialog() {
    if (isActionPending("create-invite")) return;
    setInviteDialogOpen(false);
    clearActionFeedback("create-invite");
    setDeviceSetupState({ returnAfterInvite: false });
    setDeviceSetupState({ open: latest.current.deviceSetupTask !== null });
  }

  async function createInvite(payload: AuthKeyDialogPayload) {
    setInviteForm(toAuthKeyDefaults(payload));
    if (await createPreAuthKey(payload)) closeInviteDialog();
  }

  function openAccessFromDeviceSetup() {
    closeDeviceSetupDialog();
    void navigate({ to: "/access" });
  }

  async function registerPendingNode(authId: string) {
    setDeviceSetupState({ lastRegisteredNode: null });
    const registered = await mutateWith("register-pending-node", {
      endpoint: "authRegister",
      input: { user: registrationUser, authId },
    });
    if (registered.ok) {
      setDeviceSetupState({ lastRegisteredNode: normalizeHeadscaleNode(registered.result.node) });
      setDeviceSetupState({ step: "result" });
      setPendingRegistrationForm((current) => ({ ...current, key: "" }));
    }
  }

  async function decideAuthRequest(decision: "approved" | "rejected", authId: string) {
    const done =
      decision === "approved"
        ? await quiet.mutate("approve-auth-request", { endpoint: "authApprove", input: { authId } })
        : await quiet.mutate("reject-auth-request", { endpoint: "authReject", input: { authId } });
    if (done) {
      setDeviceSetupState({ lastAuthDecision: decision });
      setPendingRegistrationForm((current) => ({ ...current, key: "" }));
    }
  }

  function openNodeDetails(node: HeadscaleNode) {
    const token = nodeDetailGuard.next();
    setSelectedDetailNode(node);
    void nodeDetailGuard.refresh(token, () => setSelectedDetailNode(currentNode(node.id) ?? null));
  }

  // The dialog has no trigger, so Base UI only ever reports it closing.
  function closeNodeDetails() {
    nodeDetailGuard.cancel();
    setSelectedDetailNode(null);
    const fromPage = intent.from;
    if (fromPage && fromPage !== "devices") {
      const fromUser = fromPage === "members" ? intent.userId : null;
      void navigate({ to: `/${fromPage}`, search: fromUser ? { user: fromUser } : {} });
    }
  }

  const consumedNodeQuery = useRef<string | null>(null);
  function consumeDeviceQuery(nodeId: string | null) {
    if (!nodeId || intent.popup !== "node") {
      consumedNodeQuery.current = null;
      return;
    }
    if (consumedNodeQuery.current === nodeId) return;
    const target = snapshot.nodes.find((n) => n.id === nodeId);
    if (target) {
      consumedNodeQuery.current = nodeId;
      openNodeDetails(target);
    }
  }

  useEffect(() => {
    if (intent.search !== null) setDeviceSearch(intent.search);
  }, [intent.search]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry query consumption after the initial node snapshot arrives.
  useEffect(
    () => latest.current.consumeDeviceQuery(intent.nodeId),
    [intent.nodeId, intent.popup, snapshot.nodes],
  );

  function openRenameDialog(node: HeadscaleNode) {
    clearActionFeedback("rename-node");
    const token = renameDialogGuard.next();
    const draftAtOpen = nodeDisplayName(node);
    setSelectedRenameNode(node);
    setRenameDraft(draftAtOpen);
    setRenameDialogOpen(true);
    void renameDialogGuard.refresh(token, () => {
      const nextNode = currentNode(node.id);
      if (!nextNode) {
        closeRenameDialog();
        return;
      }
      setSelectedRenameNode(nextNode);
      if (latest.current.renameDraft === draftAtOpen) {
        setRenameDraft(nodeDisplayName(nextNode));
      }
    });
  }

  // The dialog has no trigger, so Base UI only ever reports it closing.
  function closeRenameDialog() {
    if (isActionPending("rename-node")) return;
    setRenameDialogOpen(false);
    renameDialogGuard.cancel();
    setSelectedRenameNode(null);
    setRenameDraft("");
    clearActionFeedback("rename-node");
  }

  function openExpireDialog(node: HeadscaleNode, action: "expire" | "disable" = "expire") {
    clearActionFeedback("expire-node");
    const token = expireDialogGuard.next();
    setSelectedExpireNode(node);
    setExpireAction(action);
    void expireDialogGuard.refresh(token, () => {
      const next = currentNode(node.id);
      if (!next) {
        closeExpireDialog();
        return;
      }
      setSelectedExpireNode(next);
    });
  }

  // The dialog has no trigger, so Base UI only ever reports it closing.
  function closeExpireDialog() {
    if (isActionPending("expire-node")) return;
    expireDialogGuard.cancel();
    setSelectedExpireNode(null);
    setExpireAction("expire");
    clearActionFeedback("expire-node");
  }

  function openRemoveDialog(node: HeadscaleNode) {
    clearActionFeedback("remove-node");
    const token = removeDialogGuard.next();
    setSelectedRemoveNode(node);
    void removeDialogGuard.refresh(token, () => {
      const next = currentNode(node.id);
      if (!next) {
        closeRemoveDialog();
        return;
      }
      setSelectedRemoveNode(next);
    });
  }

  // The dialog has no trigger, so Base UI only ever reports it closing.
  function closeRemoveDialog() {
    if (isActionPending("remove-node")) return;
    removeDialogGuard.cancel();
    setSelectedRemoveNode(null);
    clearActionFeedback("remove-node");
  }

  function openTagsDialog(node: HeadscaleNode) {
    clearActionFeedback("node-tags");
    const token = tagsDialogGuard.next();
    setSelectedTagsNode(node);
    setTagsForm({ tags: node.tags.join(", ") });
    setTagsSyncing(true);
    void tagsDialogGuard.refresh(token, () => {
      setTagsSyncing(false);
      const next = currentNode(node.id);
      if (!next) {
        closeTagsDialog();
        return;
      }
      setSelectedTagsNode(next);
      setTagsForm({ tags: next.tags.join(", ") });
    });
  }

  // The dialog has no trigger, so Base UI only ever reports it closing.
  function closeTagsDialog() {
    if (isActionPending("node-tags")) return;
    tagsDialogGuard.cancel();
    setTagsSyncing(false);
    setSelectedTagsNode(null);
    setTagsForm({ tags: "" });
    clearActionFeedback("node-tags");
  }

  async function confirmSetNodeTags(node: HeadscaleNode) {
    const updated = await mutate("node-tags", {
      endpoint: "setTags",
      input: {
        nodeId: node.id,
        tags: parseList(tagsForm.tags),
      },
    });
    if (updated) {
      closeTagsDialog();
    }
  }

  async function renameNode(node: HeadscaleNode) {
    return mutate("rename-node", {
      endpoint: "renameNode",
      input: {
        nodeId: node.id,
        newName: renameDraft || nodeDisplayName(node),
      },
    });
  }

  async function expireNode(node: HeadscaleNode) {
    return mutate("expire-node", {
      endpoint: "expireNode",
      input:
        expireAction === "disable" ? { nodeId: node.id, disableExpiry: true } : { nodeId: node.id },
    });
  }

  async function deleteNode(node: HeadscaleNode) {
    return mutate("remove-node", { endpoint: "deleteNode", input: { nodeId: node.id } });
  }

  async function confirmRenameNode(node: HeadscaleNode) {
    const renamed = await renameNode(node);
    if (renamed) {
      closeRenameDialog();
    }
  }

  async function confirmExpireNode(node: HeadscaleNode) {
    const expired = await expireNode(node);
    if (expired) {
      closeExpireDialog();
    }
  }

  async function confirmRemoveNode(node: HeadscaleNode) {
    const removed = await deleteNode(node);
    if (removed) {
      closeRemoveDialog();
    }
  }

  async function jumpToRoutesForMachine(node: HeadscaleNode) {
    await navigate({ to: "/routes" });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    document.querySelector<HTMLElement>(`[data-testid="route-node-${node.id}"]`)?.scrollIntoView({
      block: "center",
      inline: "nearest",
    });
  }

  function openUserDetailsExternal(userId?: string) {
    void navigate({ to: "/members", search: { user: userId, from: "devices", popup: "user" } });
  }

  function setPendingRegistrationForm(
    update: (current: typeof pendingRegistrationForm) => typeof pendingRegistrationForm,
  ) {
    setDeviceSetupState((current) => ({
      pendingRegistrationForm: update(current.pendingRegistrationForm),
    }));
  }

  return (
    <section className="space-y-3 sm:space-y-4">
      <Dialog open={deviceSetupDialogOpen} onOpenChange={closeDeviceSetupDialog}>
        <DialogContent
          className="max-h-[min(90vh,760px)] overflow-y-auto sm:max-w-4xl"
          data-testid="add-device-dialog"
          initialFocus={() => wizardKeyCardRef.current ?? true}
        >
          <div className="grid gap-4" data-testid="add-device-wizard">
            <DialogHeader>
              <DialogTitle>
                {deviceSetupTask ? deviceSetupTitle(deviceSetupTask, copy) : copy.addDevice}
              </DialogTitle>
              <DialogDescription>
                <span className="block">{copy.deviceSetupLead}</span>
                {deviceSetupTask ? (
                  <span className="mt-1 block">
                    {deviceSetupDescription(deviceSetupTask, copy)}
                  </span>
                ) : null}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4">
              {deviceSetupTask ? (
                <nav
                  className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4"
                  aria-label={copy.addDevice}
                  data-testid="add-device-stepper"
                >
                  {steps.map((step, index) => (
                    <button
                      key={step.id}
                      type="button"
                      className={cn(
                        "flex min-w-0 items-start gap-2 rounded-md border bg-background px-3 py-2 text-start",
                        [
                          addDeviceStep === step.id
                            ? "border-primary bg-primary/5 text-foreground"
                            : "text-muted-foreground",
                          isAddDeviceStepComplete(index) ? "border-primary/40" : "",
                        ],
                      )}
                      disabled={index > addDeviceStepIndex}
                      aria-current={addDeviceStep === step.id ? "step" : undefined}
                      data-testid={`add-device-step-${step.id}`}
                      onClick={() => setDeviceSetupState({ step: step.id })}
                    >
                      <span className="flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium">
                        {isAddDeviceStepComplete(index) ? (
                          <Check className="h-3 w-3" aria-hidden="true" />
                        ) : (
                          <span>{index + 1}</span>
                        )}
                      </span>
                      <span className="grid min-w-0 gap-0.5">
                        <span className="truncate text-sm font-medium">{step.label}</span>
                        <span className="line-clamp-2 text-xs leading-4 text-muted-foreground">
                          {step.description}
                        </span>
                      </span>
                    </button>
                  ))}
                </nav>
              ) : null}
              <div className="min-w-0">
                {deviceSetupTask === null ? (
                  <div className="grid gap-3 sm:grid-cols-3" data-testid="add-device-options">
                    <Button
                      type="button"
                      variant="outline"
                      className="h-auto w-full items-start justify-start gap-3 whitespace-normal p-4 text-start"
                      data-testid="add-linux-device"
                      onClick={() => prepareDeviceInvite("server")}
                    >
                      <Server className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className="grid min-w-0 gap-1">
                        <span className="font-medium">{copy.linuxServer}</span>
                        <span className="text-xs leading-5 text-muted-foreground">
                          {copy.linuxServerDescription}
                        </span>
                      </span>
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-auto w-full items-start justify-start gap-3 whitespace-normal p-4 text-start"
                      data-testid="add-client-device"
                      onClick={() => prepareDeviceInvite("client")}
                    >
                      <Network className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className="grid min-w-0 gap-1">
                        <span className="font-medium">{copy.clientDevice}</span>
                        <span className="text-xs leading-5 text-muted-foreground">
                          {copy.clientDeviceDescription}
                        </span>
                      </span>
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-auto w-full items-start justify-start gap-3 whitespace-normal p-4 text-start"
                      data-testid="add-pending-node"
                      onClick={preparePendingRegistration}
                    >
                      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className="grid min-w-0 gap-1">
                        <span className="font-medium">{copy.pendingRegistrationTitle}</span>
                        <span className="text-xs leading-5 text-muted-foreground">
                          {copy.pendingRegistrationDescription}
                        </span>
                      </span>
                    </Button>
                  </div>
                ) : deviceSetupTask === "pending" && addDeviceStep === "pending" ? (
                  <div className="grid gap-4" data-testid="pending-registration-flow">
                    <div className="grid gap-4">
                      <section className="grid gap-3 rounded-md border bg-background p-4">
                        <div>
                          <h3 className="text-sm font-semibold">{copy.pendingRegistrationTitle}</h3>
                          <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            {copy.authRequestHelp}
                          </p>
                        </div>
                        <div className="grid gap-2">
                          <Label htmlFor="pending-registration-kind">{copy.authRequestKind}</Label>
                          <NativeSelect
                            value={pendingRegistrationForm.kind}
                            onChange={(event) => {
                              clearAuthFeedback();
                              setDeviceSetupState({ lastAuthDecision: null });
                              setPendingRegistrationForm((current) => ({
                                ...current,
                                kind: event.target.value === "ssh" ? "ssh" : "device",
                              }));
                            }}
                            id="pending-registration-kind"
                            data-testid="pending-registration-kind"
                            disabled={anyAuthPending}
                          >
                            <NativeSelectOption value="device">
                              {copy.authRequestKindDevice}
                            </NativeSelectOption>
                            <NativeSelectOption value="ssh">
                              {copy.authRequestKindSsh}
                            </NativeSelectOption>
                          </NativeSelect>
                        </div>
                        {pendingRegistrationForm.kind === "device" ? (
                          <div className="grid gap-2">
                            <Label htmlFor="pending-registration-user">{copy.inviteOwner}</Label>
                            <NativeSelect
                              value={registrationUser}
                              onChange={(event) =>
                                setPendingRegistrationForm((current) => ({
                                  ...current,
                                  user: event.target.value,
                                }))
                              }
                              id="pending-registration-user"
                              data-testid="pending-registration-user"
                              disabled={anyAuthPending}
                            >
                              {registrationUserOptions.length === 0 ? (
                                <NativeSelectOption value="" disabled>
                                  {copy.noUsers}
                                </NativeSelectOption>
                              ) : null}
                              {registrationUserOptions.map((user) => (
                                <NativeSelectOption key={user.value} value={user.value}>
                                  {user.label}
                                </NativeSelectOption>
                              ))}
                            </NativeSelect>
                          </div>
                        ) : (
                          <p className="text-xs leading-5 text-muted-foreground">
                            {copy.sshCheckDescription}
                          </p>
                        )}
                        <div className="grid gap-2">
                          <Label htmlFor="pending-node-key">{copy.authRequestLabel}</Label>
                          <Input
                            value={pendingRegistrationForm.key}
                            onChange={(event) => {
                              setDeviceSetupState({ lastAuthDecision: null });
                              setPendingRegistrationForm((current) => ({
                                ...current,
                                key: event.target.value,
                              }));
                            }}
                            id="pending-node-key"
                            data-testid="pending-node-key"
                            readOnly={anyAuthPending}
                            placeholder={AUTH_ID_PLACEHOLDER}
                            dir="ltr"
                            className="font-mono"
                            autoComplete="off"
                            spellCheck={false}
                            aria-invalid={authRequestHint ? true : undefined}
                            aria-describedby={authRequestHint ? "pending-node-key-hint" : undefined}
                          />
                          {authRequestHint ? (
                            <p
                              id="pending-node-key-hint"
                              data-testid="pending-node-key-hint"
                              className="text-xs leading-5 text-muted-foreground"
                            >
                              {authRequestHint === "invalid"
                                ? copy.authRequestInvalid
                                : authRequestHint === "isSshCheck"
                                  ? copy.authRequestIsSshCheck
                                  : copy.authRequestIsRegistration}
                            </p>
                          ) : null}
                        </div>
                        {pendingRegistrationForm.kind === "device" ? (
                          <>
                            <Button
                              type="button"
                              className="w-fit"
                              data-testid="register-pending-node"
                              disabled={registerAuthId === ""}
                              onClick={() => void registerPendingNode(registerAuthId)}
                            >
                              {isActionPending("register-pending-node") ? (
                                <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                              ) : (
                                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                              )}
                              {copy.registerPendingNode}
                            </Button>
                            {actionError("register-pending-node") ? (
                              <p
                                role="alert"
                                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                                data-testid="register-pending-node-error"
                              >
                                {actionError("register-pending-node")}
                              </p>
                            ) : null}
                          </>
                        ) : (
                          <>
                            <div className="flex flex-wrap gap-2">
                              <Button
                                type="button"
                                data-testid="approve-ssh-check"
                                disabled={decideAuthId === ""}
                                onClick={() => void decideAuthRequest("approved", decideAuthId)}
                              >
                                {isActionPending("approve-auth-request") ? (
                                  <LoaderCircle
                                    className="h-4 w-4 animate-spin"
                                    aria-hidden="true"
                                  />
                                ) : null}
                                {copy.approveSshCheck}
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                data-testid="reject-ssh-check"
                                disabled={decideAuthId === ""}
                                onClick={() => void decideAuthRequest("rejected", decideAuthId)}
                              >
                                {isActionPending("reject-auth-request") ? (
                                  <LoaderCircle
                                    className="h-4 w-4 animate-spin"
                                    aria-hidden="true"
                                  />
                                ) : null}
                                {copy.rejectSshCheck}
                              </Button>
                            </div>
                            {lastAuthDecision ? (
                              <p
                                role="status"
                                className="text-sm font-medium"
                                data-testid="ssh-check-result"
                              >
                                {lastAuthDecision === "approved"
                                  ? copy.sshCheckApproved
                                  : copy.sshCheckRejected}
                              </p>
                            ) : null}
                            {(["approve", "reject"] as const).map((action) =>
                              actionError(`${action}-auth-request`) ? (
                                <p
                                  key={action}
                                  role="alert"
                                  className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                                  data-testid={`${action}-ssh-check-error`}
                                >
                                  {actionError(`${action}-auth-request`)}
                                </p>
                              ) : null,
                            )}
                          </>
                        )}
                      </section>
                    </div>
                  </div>
                ) : deviceSetupTask === "pending" && addDeviceStep === "result" ? (
                  <div
                    className="grid gap-2 rounded-md border bg-card p-4"
                    data-testid="registration-result"
                  >
                    {lastRegisteredNode ? (
                      <p className="text-sm font-medium">
                        {copy.registeredNode}: {nodeDisplayName(lastRegisteredNode)}
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <div className="grid gap-4" data-testid="device-setup-flow">
                    {addDeviceStep === "preferences" ? (
                      <section className="grid gap-3" data-testid="setup-device-step">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline">
                            {deviceSetupTask === "server" ? copy.linuxServer : copy.clientDevice}
                          </Badge>
                          <h2 className="text-lg font-semibold">{copy.setupDevice}</h2>
                        </div>
                        <div className="grid gap-4">
                          <div className="grid gap-2">
                            <div className="flex items-start justify-between gap-4">
                              <div>
                                <h3 id="setup-tags-title" className="text-sm font-semibold">
                                  {copy.tags}
                                </h3>
                                <p
                                  id="setup-tags-description"
                                  className="mt-1 text-xs leading-5 text-muted-foreground"
                                >
                                  {copy.useTagsDescription}
                                </p>
                              </div>
                              <Switch
                                aria-labelledby="setup-tags-title"
                                aria-describedby="setup-tags-description"
                                data-testid="setup-tags-enabled"
                                checked={inviteForm.aclTags.trim().length > 0}
                                onCheckedChange={(value) =>
                                  setInviteForm((current) => ({
                                    ...current,
                                    aclTags: value ? "tag:server" : "",
                                  }))
                                }
                              />
                            </div>
                            <Input
                              value={inviteForm.aclTags}
                              onChange={(event) =>
                                setInviteForm((current) => ({
                                  ...current,
                                  aclTags: event.target.value,
                                }))
                              }
                              id="setup-tags"
                              data-testid="setup-tags"
                              placeholder="tag:server"
                            />
                            <button
                              type="button"
                              className="w-fit text-xs font-medium text-primary underline underline-offset-4"
                              data-testid="setup-manage-tags"
                              onClick={openAccessFromDeviceSetup}
                            >
                              {copy.manageTags}
                            </button>
                          </div>
                          <div className="flex items-start justify-between gap-4">
                            <div>
                              <h3 id="setup-ephemeral-title" className="text-sm font-semibold">
                                {copy.ephemeral}
                              </h3>
                              <p
                                id="setup-ephemeral-description"
                                className="mt-1 text-xs leading-5 text-muted-foreground"
                              >
                                {copy.ephemeralDescription}
                              </p>
                            </div>
                            <Switch
                              aria-labelledby="setup-ephemeral-title"
                              aria-describedby="setup-ephemeral-description"
                              checked={inviteForm.ephemeral}
                              onCheckedChange={(value) =>
                                setInviteForm((current) => ({ ...current, ephemeral: value }))
                              }
                              data-testid="setup-ephemeral"
                            />
                          </div>
                          <div className="flex items-start justify-between gap-4">
                            <div>
                              <h3 id="setup-exit-title" className="text-sm font-semibold">
                                {copy.exitRoute}
                              </h3>
                              <p
                                id="setup-exit-description"
                                className="mt-1 text-xs leading-5 text-muted-foreground"
                              >
                                {copy.exitNodeDescription}
                              </p>
                            </div>
                            <Switch
                              aria-labelledby="setup-exit-title"
                              aria-describedby="setup-exit-description"
                              checked={advertiseExitNode}
                              onCheckedChange={setAdvertiseExitNode}
                              data-testid="setup-exit-node"
                            />
                          </div>
                        </div>
                      </section>
                    ) : addDeviceStep === "authKey" ? (
                      <section className="grid gap-3" data-testid="setup-auth-key-step">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline">
                            {deviceSetupTask === "server" ? copy.linuxServer : copy.clientDevice}
                          </Badge>
                          <h2 className="text-lg font-semibold">{copy.setupAuthKey}</h2>
                        </div>
                        <div className="grid gap-4">
                          <div className="grid gap-2">
                            <div className="flex items-start justify-between gap-4">
                              <div>
                                <h3 id="setup-reusable-title" className="text-sm font-semibold">
                                  {copy.reusable}
                                </h3>
                                <p
                                  id="setup-reusable-description"
                                  className="mt-1 text-xs leading-5 text-muted-foreground"
                                >
                                  {copy.reusableDescription}
                                </p>
                              </div>
                              <Switch
                                aria-labelledby="setup-reusable-title"
                                aria-describedby="setup-reusable-description"
                                checked={inviteForm.reusable}
                                onCheckedChange={(value) =>
                                  setInviteForm((current) => ({ ...current, reusable: value }))
                                }
                                data-testid="setup-reusable"
                              />
                            </div>
                            <p className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                              {copy.authKeyAutomationHint}
                            </p>
                          </div>
                          <div className="grid gap-2">
                            <Label htmlFor="setup-expiration">{copy.inviteExpiration}</Label>
                            <p className="text-xs leading-5 text-muted-foreground">
                              {copy.authKeyExpirationDescription}
                            </p>
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="inline-flex h-9 items-center overflow-hidden rounded-md border bg-background">
                                <Input
                                  id="setup-expiration"
                                  data-testid="setup-expiration"
                                  inputMode="numeric"
                                  className="h-9 w-14 rounded-none border-0 text-center"
                                  value={String(authKeyExpiryDays)}
                                  onChange={(event) =>
                                    setAuthKeyExpiryDays(Number(event.target.value))
                                  }
                                />
                                <button
                                  type="button"
                                  className="h-9 border-s px-3 text-sm"
                                  data-testid="setup-expiration-decrement"
                                  onClick={() => setAuthKeyExpiryDays(authKeyExpiryDays - 1)}
                                >
                                  -
                                </button>
                                <button
                                  type="button"
                                  className="h-9 border-s px-3 text-sm"
                                  data-testid="setup-expiration-increment"
                                  onClick={() => setAuthKeyExpiryDays(authKeyExpiryDays + 1)}
                                >
                                  +
                                </button>
                              </div>
                              <span className="text-sm text-muted-foreground">{copy.days}</span>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {copy.mustBeBetweenDays}
                            </p>
                            <p className="rounded-md bg-muted/60 px-3 py-2 text-xs leading-5 text-muted-foreground">
                              {copy.keyExpiryHint}
                            </p>
                          </div>
                        </div>
                      </section>
                    ) : (
                      <section className="grid gap-3" data-testid="setup-generate-step">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline">
                            {deviceSetupTask === "server" ? copy.linuxServer : copy.clientDevice}
                          </Badge>
                          {inviteForm.aclTags ? (
                            <Badge variant="outline">{inviteForm.aclTags}</Badge>
                          ) : null}
                          {inviteForm.reusable ? (
                            <Badge variant="outline">{copy.reusable}</Badge>
                          ) : null}
                          {inviteForm.ephemeral ? (
                            <Badge variant="outline">{copy.ephemeral}</Badge>
                          ) : null}
                        </div>
                        <div className="grid gap-3">
                          <Button
                            className="w-fit"
                            data-testid="generate-install-script"
                            disabled={inviteDialogOpen || isActionPending("create-invite")}
                            onClick={openInviteDialogFromDeviceSetup}
                          >
                            <KeyRound className="h-4 w-4" aria-hidden="true" />
                            {copy.generateInstallScript}
                          </Button>
                          {lastCreatedInvite ? (
                            <fieldset
                              ref={wizardKeyCardRef}
                              tabIndex={-1}
                              aria-label={copy.authKeyCreated}
                              className="grid min-w-0 gap-3 rounded-md border bg-card p-4"
                              data-testid="created-invite"
                            >
                              <div>
                                <p className="text-sm font-medium">{copy.inviteKey}</p>
                                <code className="mt-2 block break-all rounded-md bg-secondary px-2 py-1 text-xs">
                                  {lastCreatedInvite}
                                </code>
                              </div>
                              <div>
                                <p className="text-sm font-medium">{copy.installCommand}</p>
                                <code className="mt-2 block break-all rounded-md bg-secondary px-2 py-1 text-xs">
                                  {installCommand}
                                </code>
                              </div>
                              <CopyButton
                                size="sm"
                                variant="outline"
                                className="w-fit"
                                data-testid="copy-setup-install-command"
                                value={installCommand}
                              >
                                {copy.copyCommand}
                              </CopyButton>
                            </fieldset>
                          ) : null}
                        </div>
                      </section>
                    )}
                  </div>
                )}
              </div>
            </div>

            {deviceSetupTask ? (
              <DialogFooter className="gap-2 sm:justify-between">
                <Button
                  type="button"
                  variant="outline"
                  data-testid="add-device-prev"
                  onClick={goToPreviousAddDeviceStep}
                >
                  {copy.previousStep}
                </Button>
                {nextStep ? (
                  <Button
                    type="button"
                    data-testid="add-device-next"
                    disabled={addDeviceStep === "pending" && !lastRegisteredNode}
                    onClick={() => setDeviceSetupState({ step: nextStep.id })}
                  >
                    {copy.nextStep}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    data-testid="add-device-finish"
                    onClick={closeDeviceSetupDialog}
                  >
                    {copy.finish}
                  </Button>
                )}
              </DialogFooter>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(selectedDetailNode)} onOpenChange={closeNodeDetails}>
        <DialogContent
          className="max-h-[85vh] overflow-y-auto sm:max-w-3xl"
          data-testid="device-detail-dialog"
        >
          {selectedDetailNode ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex min-w-0 items-center gap-2">
                  <Network className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="truncate">{nodeDisplayName(selectedDetailNode)}</span>
                </DialogTitle>
                <DialogDescription>{copy.machineDetails}</DialogDescription>
              </DialogHeader>

              <div className="grid gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant="outline"
                    className={nodeStatusClass(selectedDetailNode)}
                    data-testid={`device-detail-status-${selectedDetailNode.id}`}
                  >
                    {selectedDetailNode.online ? (
                      <Wifi className="h-3 w-3" aria-hidden="true" />
                    ) : (
                      <WifiOff className="h-3 w-3" aria-hidden="true" />
                    )}
                    {nodeStatusLabel(selectedDetailNode)}
                  </Badge>
                  <Badge variant="outline">
                    {copy.nodeId}: {selectedDetailNode.id}
                  </Badge>
                  {selectedDetailNode.registerMethod ? (
                    <Badge variant="outline">{selectedDetailNode.registerMethod}</Badge>
                  ) : null}
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <section className="grid gap-2 rounded-md border bg-background p-3">
                    <h3 className="text-sm font-semibold">{copy.owner}</h3>
                    {hasVisibleUser(selectedDetailNode.user) ? (
                      <button
                        type="button"
                        className="w-fit text-start text-sm font-medium text-primary underline underline-offset-4"
                        data-testid={`device-detail-owner-${selectedDetailNode.id}`}
                        onClick={() => openUserDetailsExternal(selectedDetailNode.user?.id)}
                      >
                        {nodeOwner(selectedDetailNode)}
                      </button>
                    ) : (
                      <span className="text-sm text-muted-foreground">-</span>
                    )}
                  </section>

                  <section className="grid gap-2 rounded-md border bg-background p-3">
                    <h3 className="text-sm font-semibold">{copy.details}</h3>
                    <p className="text-sm text-muted-foreground">
                      {copy.lastSeen}: {formatDate(selectedDetailNode.lastSeen)}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {copy.expires}: {formatDate(selectedDetailNode.expiry)}
                    </p>
                  </section>
                </div>

                <section className="grid gap-2">
                  <h3 className="text-sm font-semibold">{copy.addresses}</h3>
                  <div className="flex flex-wrap gap-1">
                    {selectedDetailNode.ipAddresses.map((address, addressIndex) => (
                      <Badge
                        key={address}
                        variant="outline"
                        className="border-slate-200 bg-muted/60 font-mono text-[11px] text-muted-foreground dark:border-slate-800"
                        data-testid={`device-detail-ip-${selectedDetailNode.id}-${addressIndex}`}
                      >
                        <bdi dir="ltr">{address}</bdi>
                      </Badge>
                    ))}
                  </div>
                </section>

                {selectedDetailNode.tags.length ? (
                  <section className="grid gap-2">
                    <h3 className="text-sm font-semibold">{copy.tags}</h3>
                    <div className="flex flex-wrap gap-1">
                      {selectedDetailNode.tags.map((tag) => (
                        <Badge key={tag} variant="outline" className={deviceTagClass(tag)}>
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </section>
                ) : null}
                <section className="grid gap-2">
                  <h3 className="text-sm font-semibold">{copy.routes}</h3>
                  <div className="flex flex-wrap gap-1">
                    {nodePendingRoutes(selectedDetailNode).map((route) => (
                      <Badge key={route} variant="outline" className={pendingRouteClass(route)}>
                        <bdi dir="ltr">{route}</bdi>
                      </Badge>
                    ))}
                    {selectedDetailNode.approvedRoutes.map((route) => (
                      <Badge key={route} variant="outline" className={approvedRouteClass()}>
                        <bdi dir="ltr">{route}</bdi>
                      </Badge>
                    ))}
                    {nodePendingRoutes(selectedDetailNode).length === 0 &&
                    selectedDetailNode.approvedRoutes.length === 0 ? (
                      <span className="text-sm text-muted-foreground">{copy.noRouteValues}</span>
                    ) : null}
                  </div>
                </section>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={renameDialogOpen} onOpenChange={closeRenameDialog}>
        {selectedRenameNode ? (
          <DialogContent data-testid="rename-node-dialog">
            <DialogHeader>
              <DialogTitle>{copy.renameMachineTitle}</DialogTitle>
              <DialogDescription>{copy.renameMachineDescription}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="rename-node-dialog-input">{copy.machineName}</Label>
              <Input
                id="rename-node-dialog-input"
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
                data-testid="rename-node-dialog-input"
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void confirmRenameNode(selectedRenameNode);
                  }
                }}
              />
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                data-testid="rename-node-cancel"
                disabled={isActionPending("rename-node")}
                onClick={closeRenameDialog}
              >
                {copy.cancel}
              </Button>
              <Button
                data-testid="rename-node-confirm"
                disabled={isActionPending("rename-node")}
                onClick={() => void confirmRenameNode(selectedRenameNode)}
              >
                {isActionPending("rename-node") ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : null}
                {copy.saveName}
              </Button>
            </DialogFooter>
            {actionError("rename-node") ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                data-testid="rename-node-error"
              >
                {actionError("rename-node")}
              </p>
            ) : null}
          </DialogContent>
        ) : null}
      </Dialog>

      <Dialog open={Boolean(selectedTagsNode)} onOpenChange={closeTagsDialog}>
        {selectedTagsNode ? (
          <DialogContent data-testid="node-tags-dialog">
            <DialogHeader>
              <DialogTitle>{copy.editNodeTagsTitle}</DialogTitle>
              <DialogDescription>{copy.editNodeTagsDescription}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="node-tags-input">{copy.nodeTags}</Label>
              <Input
                value={tagsForm.tags}
                onChange={(event) =>
                  setTagsForm((current) => ({ ...current, tags: event.target.value }))
                }
                id="node-tags-input"
                data-testid="node-tags-input"
                readOnly={tagsSyncing}
                aria-busy={tagsSyncing || undefined}
                placeholder="tag:server, tag:router"
              />
              <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                {copy.replaceTagsWarning}
              </p>
            </div>
            {actionError("node-tags") ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                data-testid="node-tags-error"
              >
                {actionError("node-tags")}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                data-testid="node-tags-cancel"
                disabled={isActionPending("node-tags")}
                onClick={closeTagsDialog}
              >
                {copy.cancel}
              </Button>
              <Button
                type="button"
                data-testid="node-tags-confirm"
                disabled={isActionPending("node-tags") || tagsSyncing}
                onClick={() => void confirmSetNodeTags(selectedTagsNode)}
              >
                {isActionPending("node-tags") ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : null}
                {copy.saveTags}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>

      <AlertDialog open={selectedExpireNode !== null} onOpenChange={closeExpireDialog}>
        {selectedExpireNode ? (
          <AlertDialogContent data-testid="expire-node-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {expireAction === "disable" ? copy.disableExpiryTitle : copy.expireMachineTitle}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {expireAction === "disable"
                  ? copy.disableExpiryDescription
                  : copy.expireMachineDescription}
                <span className="mt-2 block font-medium text-foreground">
                  {nodeDisplayName(selectedExpireNode)}
                </span>
              </AlertDialogDescription>
            </AlertDialogHeader>
            {actionError("expire-node") ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                data-testid="expire-node-error"
              >
                {actionError("expire-node")}
              </p>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel
                data-testid="expire-node-cancel"
                disabled={isActionPending("expire-node")}
              >
                {copy.cancel}
              </AlertDialogCancel>
              <Button
                variant={expireAction === "disable" ? "default" : "destructive"}
                data-testid="expire-node-confirm"
                disabled={isActionPending("expire-node")}
                onClick={() => void confirmExpireNode(selectedExpireNode)}
              >
                {isActionPending("expire-node") ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : null}
                {expireAction === "disable" ? copy.disableExpiry : copy.confirmExpire}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>

      <AlertDialog open={selectedRemoveNode !== null} onOpenChange={closeRemoveDialog}>
        {selectedRemoveNode ? (
          <AlertDialogContent data-testid="remove-node-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>{copy.removeMachineTitle}</AlertDialogTitle>
              <AlertDialogDescription>
                {copy.removeMachineDescription}
                <span className="mt-2 block font-medium text-foreground">
                  {nodeDisplayName(selectedRemoveNode)}
                </span>
              </AlertDialogDescription>
            </AlertDialogHeader>
            {actionError("remove-node") ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                data-testid="remove-node-error"
              >
                {actionError("remove-node")}
              </p>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel
                data-testid="remove-node-cancel"
                disabled={isActionPending("remove-node")}
              >
                {copy.cancel}
              </AlertDialogCancel>
              <Button
                variant="destructive"
                data-testid="remove-node-confirm"
                disabled={isActionPending("remove-node")}
                onClick={() => void confirmRemoveNode(selectedRemoveNode)}
              >
                {isActionPending("remove-node") ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : null}
                {copy.confirmRemove}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>

      <div className="grid gap-3" data-testid="machines-workbench">
        <div className="grid gap-2 sm:flex sm:items-start sm:justify-between sm:gap-3">
          <div>
            <h1 className="text-xl font-semibold">{copy.devicesTitle}</h1>
            <p className="mt-1 text-xs text-muted-foreground sm:text-sm">
              {copy.devicesSubtitle}{" "}
              <a
                href="https://tailscale.com/kb/1017/install"
                className="cursor-pointer font-medium text-primary underline underline-offset-4"
                data-testid="install-docs-link"
              >
                {copy.learnMore}
              </a>
            </p>
          </div>
          <Button
            size="sm"
            className="w-fit"
            data-testid="add-device-toggle"
            onClick={openDeviceSetupDialog}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {copy.addDevice}
          </Button>
        </div>

        {snapshot.nodes.length === 0 ? (
          <Card
            className="relative overflow-hidden bg-accent/35 p-5 sm:p-8"
            data-testid="machines-empty"
          >
            <div className="relative z-10 max-w-md">
              <h2 className="text-lg font-semibold">{copy.addFirstDevice}</h2>
              <p className="mt-2 text-sm text-muted-foreground">{copy.addFirstDeviceDescription}</p>
              <Button
                className="mt-4"
                data-testid="add-first-device"
                onClick={() => prepareDeviceInvite("client")}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                {copy.addDevice}
              </Button>
            </div>
            <div
              className="pointer-events-none absolute bottom-0 end-0 hidden grid-cols-4 gap-0 p-4 sm:grid"
              aria-hidden="true"
            >
              <span className="h-12 w-12 rounded-tl-full bg-primary/90" />
              <span className="h-12 w-12 rounded-full bg-primary/20" />
              <span className="h-12 w-12 rounded-br-full bg-primary/80" />
              <span className="h-12 w-12 bg-primary/10" />
              <span className="h-12 w-12 rounded-full bg-primary/80" />
              <span className="h-12 w-12 rounded-br-full bg-primary/25" />
              <span className="h-12 w-12 rounded-full bg-primary/90" />
              <span className="h-12 w-12 rounded-bl-full bg-primary/20" />
            </div>
          </Card>
        ) : (
          <div className="min-w-0 space-y-2" data-testid="machine-table-shell">
            <div
              className="flex flex-col gap-2 sm:flex-row sm:items-center"
              data-testid="machine-toolbar"
            >
              <div className="w-full sm:max-w-sm">
                <Label htmlFor="device-search" className="sr-only">
                  {copy.searchDevices}
                </Label>
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <Input
                    value={deviceSearch}
                    onChange={(event) => setDeviceSearch(event.target.value)}
                    id="device-search"
                    data-testid="device-search"
                    className="ps-8"
                    placeholder={copy.searchDevices}
                  />
                </div>
              </div>
              <div className="w-full sm:w-48">
                <Label htmlFor="machine-filter" className="sr-only">
                  {copy.filters}
                </Label>
                <div className="relative">
                  <Filter
                    className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <NativeSelect
                    value={machineFilter}
                    onChange={(event) => setMachineFilter(event.target.value as MachineFilter)}
                    id="machine-filter"
                    data-testid="machine-filter"
                    className="ps-8"
                  >
                    <NativeSelectOption value="all">{copy.allMachines}</NativeSelectOption>
                    <NativeSelectOption value="online">{copy.onlineOnly}</NativeSelectOption>
                    <NativeSelectOption value="offline">{copy.offlineOnly}</NativeSelectOption>
                    <NativeSelectOption value="expired">{copy.expiredOnly}</NativeSelectOption>
                    <NativeSelectOption value="routes">{copy.routeAdvertisers}</NativeSelectOption>
                    <NativeSelectOption value="tagged">{copy.taggedOnly}</NativeSelectOption>
                  </NativeSelect>
                </div>
              </div>
              <p className="whitespace-nowrap text-xs text-muted-foreground sm:ms-auto">
                {filteredNodes.length} / {snapshot.nodes.length}
              </p>
              <Button
                type="button"
                variant="outline"
                size="icon"
                data-testid="refresh-machines"
                aria-label={copy.refreshData}
                title={copy.refreshData}
                disabled={isRefreshingSnapshot}
                onClick={refreshDevices}
              >
                {isRefreshingSnapshot ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                )}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                data-testid="export-machines"
                aria-label={copy.exportData}
                onClick={exportMachines}
              >
                <Download className="h-4 w-4" aria-hidden="true" />
              </Button>
              {hasMachineFilters ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full sm:w-fit"
                  data-testid="clear-machine-filters"
                  onClick={clearMachineFilters}
                >
                  {copy.clearFilters}
                </Button>
              ) : null}
            </div>
            <Card className="w-full max-w-full min-w-0 overflow-x-auto" data-testid="machine-list">
              <Table aria-label={copy.devicesTitle}>
                <TableHeader>
                  <TableRow>
                    <TableHead>{copy.devicesTableMachine}</TableHead>
                    <TableHead>{copy.devicesTableUser}</TableHead>
                    <TableHead>{copy.devicesTableRoutes}</TableHead>
                    <TableHead>{copy.devicesTableActivity}</TableHead>
                    <TableHead className="hidden md:table-cell">{copy.actions}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredNodes.map((node) => (
                    <TableRow key={node.id} data-testid={`device-${node.id}`}>
                      <TableCell className="align-top md:min-w-64">
                        <div className="flex min-w-0 items-center gap-2">
                          <Network
                            className="h-4 w-4 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                          />
                          <button
                            type="button"
                            className="truncate font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            data-testid={`device-detail-link-${node.id}`}
                            onClick={() => openNodeDetails(node)}
                          >
                            {nodeDisplayName(node)}
                          </button>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {node.ipAddresses.map((address, addressIndex) => (
                            <Badge
                              key={address}
                              variant="outline"
                              className="border-slate-200 bg-muted/60 font-mono text-[11px] text-muted-foreground dark:border-slate-800"
                              data-testid={`device-ip-${node.id}-${addressIndex}`}
                            >
                              <bdi dir="ltr">{address}</bdi>
                            </Badge>
                          ))}
                        </div>
                        {node.tags.length ? (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {node.tags.map((tag, tagIndex) => (
                              <Badge
                                key={tag}
                                variant="outline"
                                className={deviceTagClass(tag)}
                                data-testid={`device-tag-${node.id}-${tagIndex}`}
                              >
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        ) : null}
                        <div className="mt-2 md:hidden">
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              render={
                                <Button
                                  variant="outline"
                                  size="icon"
                                  aria-label={`${copy.actions}: ${nodeDisplayName(node)}`}
                                  data-testid={`machine-actions-trigger-mobile-${node.id}`}
                                />
                              }
                            >
                              <EllipsisVertical className="h-4 w-4" aria-hidden="true" />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                              align="start"
                              className="w-64"
                              data-testid={`machine-actions-menu-mobile-${node.id}`}
                            >
                              <DropdownMenuGroup>
                                <DropdownMenuLabel>{copy.actions}</DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  data-testid={`view-node-details-action-mobile-${node.id}`}
                                  onClick={() => openNodeDetails(node)}
                                >
                                  <FileCheck2 className="h-4 w-4" aria-hidden="true" />
                                  {copy.viewDetails}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  data-testid={`view-node-routes-action-mobile-${node.id}`}
                                  onClick={() => jumpToRoutesForMachine(node)}
                                >
                                  <Router className="h-4 w-4" aria-hidden="true" />
                                  {copy.viewRoutes}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  data-testid={`rename-node-action-mobile-${node.id}`}
                                  onClick={() => openRenameDialog(node)}
                                >
                                  <Pencil className="h-4 w-4" aria-hidden="true" />
                                  {copy.rename}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  data-testid={`edit-node-tags-action-mobile-${node.id}`}
                                  onClick={() => openTagsDialog(node)}
                                >
                                  <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                                  {copy.editTags}
                                </DropdownMenuItem>
                                {node.expiry ? (
                                  <DropdownMenuItem
                                    data-testid={`disable-expiry-node-action-mobile-${node.id}`}
                                    onClick={() => openExpireDialog(node, "disable")}
                                  >
                                    <InfinityIcon className="h-4 w-4" aria-hidden="true" />
                                    {copy.disableExpiry}
                                  </DropdownMenuItem>
                                ) : null}
                                <DropdownMenuItem
                                  data-testid={`expire-node-action-mobile-${node.id}`}
                                  onClick={() => openExpireDialog(node)}
                                >
                                  <Clock className="h-4 w-4" aria-hidden="true" />
                                  {copy.expire}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  variant="destructive"
                                  data-testid={`remove-node-action-mobile-${node.id}`}
                                  onClick={() => openRemoveDialog(node)}
                                >
                                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                                  {copy.remove}
                                </DropdownMenuItem>
                              </DropdownMenuGroup>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </TableCell>
                      <TableCell className="align-top md:min-w-40">
                        {hasVisibleUser(node.user) ? (
                          <div>
                            <button
                              type="button"
                              className="text-start underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              data-testid={`device-owner-link-${node.id}`}
                              onClick={() => openUserDetailsExternal(node.user?.id)}
                            >
                              <bdi dir="auto">{nodeOwner(node)}</bdi>
                            </button>
                            <p className="text-xs text-muted-foreground">
                              <bdi dir="auto">{node.user.email || node.user.name}</bdi>
                            </p>
                          </div>
                        ) : (
                          <span aria-hidden="true" className="text-muted-foreground">
                            -
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="align-top md:min-w-56">
                        {nodePendingRoutes(node).length ? (
                          <button
                            type="button"
                            className="flex flex-wrap gap-1 rounded-md text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            data-testid={`device-pending-routes-${node.id}`}
                            onClick={() => jumpToRoutesForMachine(node)}
                          >
                            {nodePendingRoutes(node).map((route, routeIndex) => (
                              <Badge
                                key={route}
                                variant="outline"
                                className={cn(
                                  "cursor-pointer hover:opacity-90",
                                  pendingRouteClass(route),
                                )}
                                data-testid={`device-pending-route-${node.id}-${routeIndex}`}
                              >
                                <bdi dir="ltr">{route}</bdi>
                              </Badge>
                            ))}
                          </button>
                        ) : null}
                        {node.approvedRoutes.length ? (
                          <div
                            className={cn("flex flex-wrap gap-1", {
                              "mt-2": nodePendingRoutes(node).length,
                            })}
                          >
                            {node.approvedRoutes.map((route, routeIndex) => (
                              <Badge
                                key={route}
                                variant="outline"
                                className={approvedRouteClass()}
                                data-testid={`device-approved-route-${node.id}-${routeIndex}`}
                              >
                                <bdi dir="ltr">{route}</bdi>
                              </Badge>
                            ))}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="align-top md:min-w-44">
                        <Badge
                          variant="outline"
                          className={nodeStatusClass(node)}
                          data-testid={`device-status-${node.id}`}
                        >
                          {node.online ? (
                            <Wifi className="h-3 w-3" aria-hidden="true" />
                          ) : (
                            <WifiOff className="h-3 w-3" aria-hidden="true" />
                          )}
                          {nodeStatusLabel(node)}
                        </Badge>
                        <p className="mt-2 text-xs text-muted-foreground">
                          {copy.lastSeen}: {formatDate(node.lastSeen)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {copy.expires}: {formatDate(node.expiry)}
                        </p>
                      </TableCell>
                      <TableCell className="hidden align-top md:table-cell md:min-w-16">
                        <div className="flex justify-start">
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              render={
                                <Button
                                  variant="outline"
                                  size="icon"
                                  aria-label={`${copy.actions}: ${nodeDisplayName(node)}`}
                                  data-testid={`machine-actions-trigger-${node.id}`}
                                />
                              }
                            >
                              <EllipsisVertical className="h-4 w-4" aria-hidden="true" />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                              align="end"
                              className="w-64"
                              data-testid={`machine-actions-menu-${node.id}`}
                            >
                              <DropdownMenuGroup>
                                <DropdownMenuLabel>{copy.actions}</DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  data-testid={`view-node-details-action-${node.id}`}
                                  onClick={() => openNodeDetails(node)}
                                >
                                  <FileCheck2 className="h-4 w-4" aria-hidden="true" />
                                  {copy.viewDetails}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  data-testid={`view-node-routes-action-${node.id}`}
                                  onClick={() => jumpToRoutesForMachine(node)}
                                >
                                  <Router className="h-4 w-4" aria-hidden="true" />
                                  {copy.viewRoutes}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  data-testid={`rename-node-action-${node.id}`}
                                  onClick={() => openRenameDialog(node)}
                                >
                                  <Pencil className="h-4 w-4" aria-hidden="true" />
                                  {copy.rename}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  data-testid={`edit-node-tags-action-${node.id}`}
                                  onClick={() => openTagsDialog(node)}
                                >
                                  <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                                  {copy.editTags}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                {node.expiry ? (
                                  <DropdownMenuItem
                                    data-testid={`disable-expiry-node-action-${node.id}`}
                                    onClick={() => openExpireDialog(node, "disable")}
                                  >
                                    <InfinityIcon className="h-4 w-4" aria-hidden="true" />
                                    {copy.disableExpiry}
                                  </DropdownMenuItem>
                                ) : null}
                                <DropdownMenuItem
                                  data-testid={`expire-node-action-${node.id}`}
                                  onClick={() => openExpireDialog(node)}
                                >
                                  <Clock className="h-4 w-4" aria-hidden="true" />
                                  {copy.expire}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  variant="destructive"
                                  data-testid={`remove-node-action-${node.id}`}
                                  onClick={() => openRemoveDialog(node)}
                                >
                                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                                  {copy.remove}
                                </DropdownMenuItem>
                              </DropdownMenuGroup>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {filteredNodes.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="py-6 text-sm text-muted-foreground">
                        {copy.noDevices}
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </Card>
          </div>
        )}
      </div>

      <CreateAuthKeyDialog
        paused={stale !== null}
        open={inviteDialogOpen}
        users={authKeyDialogUsers}
        defaults={inviteForm}
        expirationDays={authKeyExpiryDays}
        labels={authKeyDialogLabels(copy)}
        finalFocus={false}
        error={actionError("create-invite")}
        onOpenChange={closeInviteDialog}
        isSubmitting={isActionPending("create-invite")}
        onSubmit={createInvite}
      />
    </section>
  );
}
