import { useNavigate, useSearch } from "@tanstack/react-router";
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
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { HeadscaleNode, HeadscaleUser } from "@/api/contracts";
import { normalizeHeadscaleNode } from "@/api/contracts";
import { type AuthKeyDialogDefaults, authKeyDialogUser } from "@/components/create-auth-key-dialog";
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
import {
  isTimestampExpired,
  type NodeConnectionStatus,
  nodeConnectionStatus,
} from "@/domain/node-status";
import { parsePolicy } from "@/domain/policy-designer";
import { useHeadscaleI18n } from "@/i18n";
import type { ProductCopy } from "@/i18n/product-copy";
import { cn } from "@/lib/utils";
import { downloadCsv } from "@/utils/csv";
import { isNodeTag, isValidNodeName, nodePendingRoutes, parseNodeTags } from "@/utils/node";
import {
  approvedRouteClass,
  deviceTagClass,
  isExitRoute,
  nodeStatusClass,
  pendingRouteClass,
} from "@/utils/status-class";
import { isHttpUrl, tailscaleUpCommand } from "@/utils/strings";

type MachineFilter = "all" | NodeConnectionStatus | "routes" | "tagged";
const MACHINE_FILTERS: readonly MachineFilter[] = [
  "all",
  "online",
  "offline",
  "expired",
  "routes",
  "tagged",
];

type AddDeviceStepInfo = {
  id: ReturnType<typeof useDeviceSetup>["step"];
  label: string;
  description: string;
};

function deviceSetupTitle(task: AddDeviceTask | null, copy: ProductCopy) {
  if (task === "pending") return copy.pendingRegistrationTitle;
  return task === "server" ? copy.addLinuxServerTitle : copy.addClientDeviceTitle;
}

function addDeviceSteps(
  task: AddDeviceTask | null,
  kind: "device" | "ssh",
  copy: ProductCopy,
): AddDeviceStepInfo[] {
  if (task === "pending") {
    const pending: AddDeviceStepInfo = {
      id: "pending",
      label: copy.pendingRegistrationTitle,
      description: copy.wizardStepPendingDescription,
    };
    // An SSH check is decided in place; only a registration has a machine to show afterwards.
    return kind === "ssh"
      ? [pending]
      : [
          pending,
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
        label: copy.generateInstallCommand,
        description: copy.wizardStepGenerateDescription,
      },
    ];
  }
  return [];
}

function registerMethodLabel(method: string, copy: ProductCopy) {
  const labels: Record<string, string> = {
    REGISTER_METHOD_AUTH_KEY: copy.registerMethodAuthKey,
    REGISTER_METHOD_CLI: copy.registerMethodCli,
    REGISTER_METHOD_OIDC: copy.registerMethodOidc,
  };
  return labels[method] ?? copy.unknown;
}

export default function DevicesPage() {
  const { stale } = useStore(useSession().drafts);
  const { copy } = useProductCopy();
  const { t } = useHeadscaleI18n();
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
    loginServer,
    lastCreatedInvite,
    lastRegisteredNode,
    lastAuthDecision,
    pendingRegistrationForm,
  } = useDeviceSetup();
  const navigate = useNavigate();
  const intent = useRouteIntent();
  const searchParams = useSearch({ strict: false }) as Record<string, unknown>;

  // The URL carries the filters, so a reload or a shared link lists the same machines.
  const urlSearch = intent.search ?? "";
  const urlFilter = MACHINE_FILTERS.find((filter) => filter === searchParams.filter) ?? "all";
  const ownerFilter = intent.userId;
  const [deviceSearch, setDeviceSearch] = useState(urlSearch);
  const [machineFilter, setMachineFilter] = useState<MachineFilter>(urlFilter);
  useEffect(() => setDeviceSearch(urlSearch), [urlSearch]);
  useEffect(() => setMachineFilter(urlFilter), [urlFilter]);

  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [selectedRenameNode, setSelectedRenameNode] = useState<HeadscaleNode | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameInvalid, setRenameInvalid] = useState(false);
  const [selectedExpireNode, setSelectedExpireNode] = useState<HeadscaleNode | null>(null);
  const [expireAction, setExpireAction] = useState<"expire" | "disable">("expire");
  const [selectedRemoveNode, setSelectedRemoveNode] = useState<HeadscaleNode | null>(null);
  const [selectedTagsNode, setSelectedTagsNode] = useState<HeadscaleNode | null>(null);
  const [selectedDetailNode, setSelectedDetailNode] = useState<HeadscaleNode | null>(null);

  const [inviteForm, setInviteForm] = useState<AuthKeyDialogDefaults>({
    user: "",
    reusable: false,
    ephemeral: false,
    aclTags: "",
  });
  const [tagsForm, setTagsForm] = useState({
    tags: "",
  });
  const [tagsSyncing, setTagsSyncing] = useState(false);
  const [tagsAcknowledged, setTagsAcknowledged] = useState(false);
  const [tagsInvalid, setTagsInvalid] = useState(false);
  const [advertiseExitNode, setAdvertiseExitNode] = useState(false);
  // Typed days stay text until the field is left, so clearing it does not snap to a bound.
  const [expiryDraft, setExpiryDraft] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<"tags" | "owner" | null>(null);
  const [discardKeyOpen, setDiscardKeyOpen] = useState(false);
  const wizardKeyCardRef = useRef<HTMLFieldSetElement>(null);
  useRevealCreatedInvite(wizardKeyCardRef, deviceSetupDialogOpen);
  useSessionDraft(
    renameDialogOpen ||
      selectedExpireNode !== null ||
      selectedRemoveNode !== null ||
      selectedTagsNode !== null ||
      deviceSetupDialogOpen,
  );

  const nodeDetailGuard = useRefreshGuard();
  const renameDialogGuard = useRefreshGuard();
  const expireDialogGuard = useRefreshGuard();
  const removeDialogGuard = useRefreshGuard();
  const tagsDialogGuard = useRefreshGuard();

  const { formatDate, userLabel, nodeDisplayName, nodeOwner, nodeStatusLabel, hasVisibleUser } =
    useDisplayHelpers();

  const visibleUsers = snapshot.users.filter((user) => hasVisibleUser(user));
  // Open drafts keep offering the users of the server they were started on.
  const [draftUsers, setDraftUsers] = useState<HeadscaleUser[]>([]);
  useEffect(() => {
    if (!stale) setDraftUsers(snapshot.users.filter(hasVisibleUser));
  }, [snapshot.users, stale, hasVisibleUser]);
  const registrationUserOptions = draftUsers.map((user) => ({
    value: user.name,
    label: userLabel(user),
  }));

  const ownerFilterUser = visibleUsers.find((user) => user.id === ownerFilter);
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
    const matchesOwner =
      ownerFilter === null || (hasVisibleUser(node.user) && node.user.id === ownerFilter);

    return matchesSearch && matchesFilter && matchesOwner;
  });

  const hasMachineFilters =
    deviceSearch.trim() !== "" || machineFilter !== "all" || ownerFilter !== null;

  const wizardTags = parseNodeTags(inviteForm.aclTags);
  // A chosen owner that is no longer listed falls back to the first one, as the select shows.
  const wizardOwner =
    inviteForm.user === "" || draftUsers.some((user) => user.id === inviteForm.user)
      ? inviteForm.user
      : (draftUsers[0]?.id ?? "");
  const policyText = snapshot.policy?.policy;
  // Unknown (not loaded or unreadable) policies give no hint rather than a false one.
  const definedTags = useMemo(() => {
    if (policyText === undefined) return null;
    const policy = parsePolicy(policyText);
    return policy.error ? null : new Set(policy.tagOwners.map((owner) => owner.tag));
  }, [policyText]);
  const undefinedTags = definedTags
    ? wizardTags.filter((tag) => isNodeTag(tag) && !definedTags.has(tag))
    : [];
  const loginServerUrl = loginServer ?? settings.baseUrl;
  const loginServerValid = isHttpUrl(loginServerUrl);
  const installCommand =
    lastCreatedInvite && loginServerValid
      ? tailscaleUpCommand(loginServerUrl, lastCreatedInvite, advertiseExitNode)
      : "";

  const nextNodeTags = parseNodeTags(tagsForm.tags);
  const tagsOwnedNode = selectedTagsNode !== null && selectedTagsNode.tags.length > 0;
  // Headscale moves a tagged machine from its user to its tags and refuses to remove every tag.
  const tagsWouldDropOwner = !tagsOwnedNode && nextNodeTags.length > 0;
  const tagsWouldClear = tagsOwnedNode && nextNodeTags.length === 0;
  const canSaveTags = !tagsWouldClear && (!tagsWouldDropOwner || tagsAcknowledged);

  const renameName = renameDraft.trim();
  const canRename =
    renameName !== "" &&
    selectedRenameNode !== null &&
    renameName !== nodeDisplayName(selectedRenameNode);

  const steps = addDeviceSteps(deviceSetupTask, pendingRegistrationForm.kind, copy);
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
  const latest = useRef({ consumeDeviceQuery, renameDraft });
  latest.current = { consumeDeviceQuery, renameDraft };

  function exportMachines() {
    downloadCsv(
      "headscale-machines.csv",
      [
        "name",
        "owner",
        "status",
        "addresses",
        "tags",
        "advertisedRoutes",
        "approvedRoutes",
        "lastSeen",
        "expires",
      ],
      filteredNodes.map((node) => ({
        name: nodeDisplayName(node),
        owner: nodeOwner(node),
        status: nodeStatusLabel(node),
        addresses: node.ipAddresses.join(" "),
        tags: node.tags.join(" "),
        advertisedRoutes: node.availableRoutes.join(" "),
        approvedRoutes: node.approvedRoutes.join(" "),
        lastSeen: node.lastSeen,
        expires: node.expiry,
      })),
    );
  }

  function updateFilterQuery(patch: Record<string, string | undefined>) {
    void navigate({
      to: ".",
      search: (current: Record<string, unknown>) => ({ ...current, ...patch }),
      replace: true,
    });
  }

  function changeDeviceSearch(value: string) {
    setDeviceSearch(value);
    updateFilterQuery({ search: value || undefined });
  }

  function changeMachineFilter(value: MachineFilter) {
    setMachineFilter(value);
    updateFilterQuery({ filter: value === "all" ? undefined : value });
  }

  function clearMachineFilters() {
    setDeviceSearch("");
    setMachineFilter("all");
    updateFilterQuery({ search: undefined, filter: undefined, user: undefined });
  }

  function setAuthKeyExpiryDays(value: number) {
    setDeviceSetupState({ authKeyExpiryDays: Math.min(90, Math.max(1, value)) });
  }

  function commitExpiryDraft() {
    if (expiryDraft === null) return;
    const days = Number.parseInt(expiryDraft, 10);
    if (Number.isFinite(days)) setAuthKeyExpiryDays(days);
    setExpiryDraft(null);
  }

  // A generated key belongs to the options it was made with; going back makes them editable.
  function returnToAddDeviceStep(step: AddDeviceStepInfo["id"]) {
    setDeviceSetupState({ step, lastCreatedInvite: "" });
  }

  function goToPreviousAddDeviceStep() {
    const previousStep = steps[addDeviceStepIndex - 1];
    if (!previousStep) {
      setDeviceSetupState({
        task: null,
        step: "type",
        lastCreatedInvite: "",
        lastRegisteredNode: null,
      });
      return;
    }
    returnToAddDeviceStep(previousStep.id);
  }

  function goToNextAddDeviceStep(step: AddDeviceStepInfo["id"]) {
    if (addDeviceStep === "preferences" && !wizardTags.every(isNodeTag)) {
      setSetupError("tags");
      return;
    }
    if (addDeviceStep === "authKey" && wizardOwner === "" && wizardTags.length === 0) {
      setSetupError("owner");
      return;
    }
    setDeviceSetupState({ step });
  }

  function changeInviteForm(patch: Partial<AuthKeyDialogDefaults>) {
    setSetupError(null);
    setInviteForm((current) => ({ ...current, ...patch }));
  }

  function isAddDeviceStepComplete(index: number) {
    return index < addDeviceStepIndex;
  }

  function openDeviceSetupDialog() {
    setDeviceSetupState({
      task: null,
      step: "type",
      lastCreatedInvite: "",
      lastRegisteredNode: null,
      open: true,
    });
  }

  function prepareDeviceInvite(task: "server" | "client") {
    clearActionFeedback("create-invite");
    // Presets set every option: a client device is a person's own machine, a server is automated.
    setInviteForm({
      user: draftUsers[0]?.id ?? "",
      reusable: task === "server",
      ephemeral: false,
      aclTags: task === "server" ? "tag:server" : "",
    });
    setAdvertiseExitNode(false);
    setExpiryDraft(null);
    setSetupError(null);
    setDeviceSetupState({
      task,
      step: "preferences",
      open: true,
      authKeyExpiryDays: 7,
      lastCreatedInvite: "",
      lastRegisteredNode: null,
    });
  }

  async function generateDeviceKey() {
    await createPreAuthKey({
      user: wizardOwner || undefined,
      reusable: inviteForm.reusable,
      ephemeral: inviteForm.ephemeral,
      expiration: new Date(Date.now() + authKeyExpiryDays * 86_400_000).toISOString(),
      aclTags: wizardTags,
    });
  }

  function clearAuthFeedback() {
    clearActionFeedback("register-pending-node");
    clearActionFeedback("approve-auth-request");
    clearActionFeedback("reject-auth-request");
  }

  function preparePendingRegistration() {
    clearAuthFeedback();
    setDeviceSetupState({
      task: "pending",
      step: "pending",
      open: true,
      lastCreatedInvite: "",
      lastRegisteredNode: null,
    });
  }

  const wizardBusy = anyAuthPending || isActionPending("create-invite");

  // The dialog has no trigger, so Base UI only ever reports it closing. The created key is
  // shown only once, so dismissing it asks first; Done closes without asking.
  function requestCloseDeviceSetupDialog() {
    if (wizardBusy) return;
    if (lastCreatedInvite) setDiscardKeyOpen(true);
    else closeDeviceSetupDialog();
  }

  function closeDeviceSetupDialog() {
    setDiscardKeyOpen(false);
    setDeviceSetupState({
      open: false,
      task: null,
      step: "type",
      lastCreatedInvite: "",
      lastRegisteredNode: null,
      lastAuthDecision: null,
    });
    clearAuthFeedback();
    clearActionFeedback("create-invite");
  }

  // The new machine appears once the key or request is used, so Done reloads the list.
  function finishDeviceSetup() {
    closeDeviceSetupDialog();
    void refreshDevices();
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
    setRenameInvalid(false);
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
    setTagsAcknowledged(false);
    setTagsInvalid(false);
    clearActionFeedback("node-tags");
  }

  async function confirmSetNodeTags(node: HeadscaleNode) {
    if (!nextNodeTags.every(isNodeTag)) {
      setTagsInvalid(true);
      return;
    }
    const updated = await mutate("node-tags", {
      endpoint: "setTags",
      input: {
        nodeId: node.id,
        tags: nextNodeTags,
      },
    });
    if (updated) {
      closeTagsDialog();
    }
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
    if (!canRename) return;
    if (!isValidNodeName(renameName)) {
      setRenameInvalid(true);
      return;
    }
    const renamed = await mutate("rename-node", {
      endpoint: "renameNode",
      input: { nodeId: node.id, newName: renameName },
    });
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

  // The routes page finds the machine from `?node=`.
  function jumpToRoutesForMachine(node: HeadscaleNode) {
    void navigate({ to: "/routes", search: { node: node.id } });
  }

  // Each route says its status in words, not only by colour.
  function routeBadge(route: string, approved: boolean, testId?: string, className?: string) {
    const status = approved ? copy.routeStatusApproved : copy.routeStatusPending;
    return (
      <Badge
        key={route}
        variant="outline"
        className={cn(className, approved ? approvedRouteClass() : pendingRouteClass(route))}
        data-testid={testId}
      >
        <bdi dir="ltr">{route}</bdi>
        <span className="text-[10px] font-normal opacity-80">
          {isExitRoute(route) ? `${copy.routeStatusExit} · ${status}` : status}
        </span>
      </Badge>
    );
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
      <Dialog open={deviceSetupDialogOpen} onOpenChange={requestCloseDeviceSetupDialog}>
        <DialogContent
          className="flex flex-col overflow-hidden sm:max-w-[min(56rem,calc(100%-2rem))]"
          data-testid="add-device-dialog"
          initialFocus={() => wizardKeyCardRef.current ?? true}
        >
          <DialogHeader>
            <DialogTitle>
              {deviceSetupTask ? deviceSetupTitle(deviceSetupTask, copy) : copy.addDevice}
            </DialogTitle>
            <DialogDescription>
              {deviceSetupTask === "pending" ? copy.pendingRegistrationLead : copy.deviceSetupLead}
            </DialogDescription>
          </DialogHeader>

          {/* Only the steps scroll, so the footer stays reachable in a short window. */}
          <div
            className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 py-1"
            data-testid="add-device-wizard"
          >
            <div className="grid gap-4">
              {deviceSetupTask ? (
                <nav
                  className="grid gap-2 sm:auto-cols-fr sm:grid-flow-col"
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
                      disabled={index >= addDeviceStepIndex}
                      aria-current={addDeviceStep === step.id ? "step" : undefined}
                      data-testid={`add-device-step-${step.id}`}
                      onClick={() => returnToAddDeviceStep(step.id)}
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
                              role="alert"
                              data-testid="pending-node-key-hint"
                              className="text-xs leading-5 text-destructive"
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
                                  changeInviteForm({ aclTags: value ? "tag:server" : "" })
                                }
                              />
                            </div>
                            <Input
                              value={inviteForm.aclTags}
                              onChange={(event) =>
                                changeInviteForm({ aclTags: event.target.value })
                              }
                              id="setup-tags"
                              data-testid="setup-tags"
                              placeholder="tag:server"
                              aria-invalid={setupError === "tags" ? true : undefined}
                              aria-describedby={
                                setupError === "tags" ? "setup-tags-error" : undefined
                              }
                            />
                            {setupError === "tags" ? (
                              <p
                                id="setup-tags-error"
                                role="alert"
                                className="text-xs leading-5 text-destructive"
                                data-testid="setup-tags-error"
                              >
                                {copy.invalidTags}
                              </p>
                            ) : null}
                            {undefinedTags.length > 0 ? (
                              <p
                                className="rounded-md bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
                                data-testid="setup-tags-undefined"
                              >
                                {t("undefinedTags", { tags: undefinedTags.join(", ") })}
                              </p>
                            ) : null}
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
                              onCheckedChange={(value) => changeInviteForm({ ephemeral: value })}
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
                            <Label htmlFor="setup-owner">{copy.inviteOwner}</Label>
                            <NativeSelect
                              id="setup-owner"
                              data-testid="setup-owner"
                              value={wizardOwner}
                              onChange={(event) => changeInviteForm({ user: event.target.value })}
                              aria-invalid={setupError === "owner" ? true : undefined}
                              aria-describedby={
                                setupError === "owner" ? "setup-owner-error" : undefined
                              }
                            >
                              {draftUsers.map((user) => (
                                <NativeSelectOption key={user.id} value={user.id}>
                                  {authKeyDialogUser(user, copy.unknown).label}
                                </NativeSelectOption>
                              ))}
                              <NativeSelectOption value="">{copy.inviteNoOwner}</NativeSelectOption>
                            </NativeSelect>
                            {setupError === "owner" ? (
                              <p
                                id="setup-owner-error"
                                role="alert"
                                className="text-xs leading-5 text-destructive"
                                data-testid="setup-owner-error"
                              >
                                {copy.inviteTagsRequired}
                              </p>
                            ) : null}
                          </div>
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
                                onCheckedChange={(value) => changeInviteForm({ reusable: value })}
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
                                  aria-describedby="setup-expiration-hint"
                                  value={expiryDraft ?? String(authKeyExpiryDays)}
                                  onChange={(event) => setExpiryDraft(event.target.value)}
                                  onBlur={commitExpiryDraft}
                                />
                                <button
                                  type="button"
                                  className="h-9 border-s px-3 text-sm disabled:opacity-50"
                                  data-testid="setup-expiration-decrement"
                                  aria-label={copy.decreaseDays}
                                  disabled={authKeyExpiryDays <= 1}
                                  onClick={() => setAuthKeyExpiryDays(authKeyExpiryDays - 1)}
                                >
                                  -
                                </button>
                                <button
                                  type="button"
                                  className="h-9 border-s px-3 text-sm disabled:opacity-50"
                                  data-testid="setup-expiration-increment"
                                  aria-label={copy.increaseDays}
                                  disabled={authKeyExpiryDays >= 90}
                                  onClick={() => setAuthKeyExpiryDays(authKeyExpiryDays + 1)}
                                >
                                  +
                                </button>
                              </div>
                              <span className="text-sm text-muted-foreground">{copy.days}</span>
                            </div>
                            <p
                              id="setup-expiration-hint"
                              className="text-xs text-muted-foreground"
                              data-testid="setup-expiration-hint"
                            >
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
                          {wizardTags.length ? (
                            <Badge variant="outline">{wizardTags.join(", ")}</Badge>
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
                            disabled={isActionPending("create-invite")}
                            onClick={() => void generateDeviceKey()}
                          >
                            {isActionPending("create-invite") ? (
                              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                            ) : (
                              <KeyRound className="h-4 w-4" aria-hidden="true" />
                            )}
                            {copy.generateInstallCommand}
                          </Button>
                          {actionError("create-invite") ? (
                            <p
                              role="alert"
                              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                              data-testid="setup-generate-error"
                            >
                              {actionError("create-invite")}
                            </p>
                          ) : null}
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
                              <div className="grid gap-2">
                                <Label htmlFor="setup-login-server">{copy.loginServerUrl}</Label>
                                <Input
                                  id="setup-login-server"
                                  data-testid="setup-login-server"
                                  value={loginServerUrl}
                                  onChange={(event) =>
                                    setDeviceSetupState({ loginServer: event.target.value })
                                  }
                                  dir="ltr"
                                  className="font-mono"
                                  autoComplete="off"
                                  spellCheck={false}
                                  aria-invalid={loginServerValid ? undefined : true}
                                  aria-describedby="setup-login-server-hint"
                                />
                                {loginServerValid ? (
                                  <p
                                    id="setup-login-server-hint"
                                    className="text-xs leading-5 text-muted-foreground"
                                  >
                                    {copy.loginServerUrlHint}
                                  </p>
                                ) : (
                                  <p
                                    id="setup-login-server-hint"
                                    role="alert"
                                    className="text-xs leading-5 text-destructive"
                                    data-testid="setup-login-server-error"
                                  >
                                    {t("connectionInvalidUrl")}
                                  </p>
                                )}
                              </div>
                              {installCommand ? (
                                <>
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
                                </>
                              ) : null}
                            </fieldset>
                          ) : null}
                        </div>
                      </section>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {deviceSetupTask ? (
            <DialogFooter className="gap-2 sm:justify-between">
              <Button
                type="button"
                variant="outline"
                data-testid="add-device-prev"
                disabled={wizardBusy}
                onClick={goToPreviousAddDeviceStep}
              >
                {copy.previousStep}
              </Button>
              {nextStep ? (
                <Button
                  type="button"
                  data-testid="add-device-next"
                  disabled={addDeviceStep === "pending" && !lastRegisteredNode}
                  onClick={() => goToNextAddDeviceStep(nextStep.id)}
                >
                  {copy.nextStep}
                </Button>
              ) : (
                <Button
                  type="button"
                  data-testid="add-device-finish"
                  disabled={wizardBusy}
                  onClick={finishDeviceSetup}
                >
                  {copy.finish}
                </Button>
              )}
            </DialogFooter>
          ) : null}

          <AlertDialog open={discardKeyOpen} onOpenChange={setDiscardKeyOpen}>
            <AlertDialogContent data-testid="discard-key-dialog">
              <AlertDialogHeader>
                <AlertDialogTitle>{copy.discardKeyTitle}</AlertDialogTitle>
                <AlertDialogDescription>{copy.discardKeyDescription}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel data-testid="discard-key-cancel">
                  {copy.cancel}
                </AlertDialogCancel>
                <Button
                  variant="destructive"
                  data-testid="discard-key-confirm"
                  onClick={closeDeviceSetupDialog}
                >
                  {copy.discardKeyConfirm}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
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
                    <Badge
                      variant="outline"
                      data-testid={`device-detail-register-method-${selectedDetailNode.id}`}
                    >
                      {copy.registerMethod}:{" "}
                      {registerMethodLabel(selectedDetailNode.registerMethod, copy)}
                    </Badge>
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
                    {/* Headscale's last seen is the last disconnect, which reads stale while online. */}
                    {selectedDetailNode.online ? null : (
                      <p className="text-sm text-muted-foreground">
                        {copy.lastSeen}: {formatDate(selectedDetailNode.lastSeen)}
                      </p>
                    )}
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
                  {nodePendingRoutes(selectedDetailNode).length ? (
                    <div
                      className="grid gap-1"
                      data-testid={`device-detail-pending-routes-${selectedDetailNode.id}`}
                    >
                      <h4 className="text-xs font-medium text-muted-foreground">
                        {copy.pendingRoutes}
                      </h4>
                      <div className="flex flex-wrap gap-1">
                        {nodePendingRoutes(selectedDetailNode).map((route) =>
                          routeBadge(route, false),
                        )}
                      </div>
                    </div>
                  ) : null}
                  {selectedDetailNode.approvedRoutes.length ? (
                    <div
                      className="grid gap-1"
                      data-testid={`device-detail-approved-routes-${selectedDetailNode.id}`}
                    >
                      <h4 className="text-xs font-medium text-muted-foreground">
                        {copy.approvedRoutes}
                      </h4>
                      <div className="flex flex-wrap gap-1">
                        {selectedDetailNode.approvedRoutes.map((route) => routeBadge(route, true))}
                      </div>
                    </div>
                  ) : null}
                  {selectedDetailNode.availableRoutes.length === 0 &&
                  selectedDetailNode.approvedRoutes.length === 0 ? (
                    <span className="text-sm text-muted-foreground">{copy.noRouteValues}</span>
                  ) : null}
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
                onChange={(event) => {
                  setRenameInvalid(false);
                  setRenameDraft(event.target.value);
                }}
                data-testid="rename-node-dialog-input"
                aria-invalid={renameInvalid || undefined}
                aria-describedby={renameInvalid ? "rename-node-invalid" : undefined}
                onKeyDown={(event) => {
                  // The Enter that confirms an input method candidate is not a submit.
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void confirmRenameNode(selectedRenameNode);
                  }
                }}
              />
              {renameInvalid ? (
                <p
                  id="rename-node-invalid"
                  role="alert"
                  className="text-xs leading-5 text-destructive"
                  data-testid="rename-node-invalid"
                >
                  {copy.invalidMachineName}
                </p>
              ) : null}
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
                disabled={isActionPending("rename-node") || !canRename}
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
            <form
              className="grid gap-4"
              data-testid="node-tags-form"
              onSubmit={(event) => {
                event.preventDefault();
                void confirmSetNodeTags(selectedTagsNode);
              }}
            >
              <div className="grid gap-2">
                <Label htmlFor="node-tags-input">{copy.nodeTags}</Label>
                <Input
                  value={tagsForm.tags}
                  onChange={(event) => {
                    setTagsInvalid(false);
                    setTagsForm((current) => ({ ...current, tags: event.target.value }));
                  }}
                  id="node-tags-input"
                  data-testid="node-tags-input"
                  readOnly={tagsSyncing}
                  aria-busy={tagsSyncing || undefined}
                  aria-invalid={tagsInvalid || tagsWouldClear || undefined}
                  aria-describedby={
                    tagsInvalid
                      ? "node-tags-invalid"
                      : tagsWouldClear
                        ? "node-tags-required"
                        : undefined
                  }
                  placeholder="tag:server, tag:router"
                />
                {tagsInvalid ? (
                  <p
                    id="node-tags-invalid"
                    role="alert"
                    className="text-xs leading-5 text-destructive"
                    data-testid="node-tags-invalid"
                  >
                    {copy.invalidTags}
                  </p>
                ) : null}
                {tagsWouldClear ? (
                  <p
                    id="node-tags-required"
                    role="alert"
                    className="text-xs leading-5 text-destructive"
                    data-testid="node-tags-required"
                  >
                    {copy.tagsRequiredForTaggedNode}
                  </p>
                ) : null}
                <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                  {copy.replaceTagsWarning}
                </p>
              </div>
              {tagsWouldDropOwner ? (
                <div className="grid gap-2" data-testid="node-tags-owner-warning">
                  <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
                    {t("tagUserNodeWarning", {
                      owner: nodeOwner(selectedTagsNode) || copy.unknown,
                    })}
                  </p>
                  <label
                    className="flex items-start gap-2 rounded-md border bg-background p-3 text-sm"
                    htmlFor="node-tags-acknowledge"
                  >
                    <Checkbox
                      checked={tagsAcknowledged}
                      onCheckedChange={(value) => setTagsAcknowledged(value)}
                      id="node-tags-acknowledge"
                      data-testid="node-tags-acknowledge"
                    />
                    <span>{copy.tagUserNodeAcknowledge}</span>
                  </label>
                </div>
              ) : null}
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
                  type="submit"
                  data-testid="node-tags-confirm"
                  disabled={isActionPending("node-tags") || tagsSyncing || !canSaveTags}
                >
                  {isActionPending("node-tags") ? (
                    <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : null}
                  {copy.saveTags}
                </Button>
              </DialogFooter>
            </form>
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
                target="_blank"
                rel="noreferrer"
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
              className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center"
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
                    onChange={(event) => changeDeviceSearch(event.target.value)}
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
                    onChange={(event) => changeMachineFilter(event.target.value as MachineFilter)}
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
              {ownerFilter !== null ? (
                <Badge
                  variant="outline"
                  className="h-7 w-fit gap-1 pe-1"
                  data-testid="owner-filter-chip"
                >
                  <span>
                    {copy.owner}:{" "}
                    <bdi dir="auto">
                      {ownerFilterUser ? userLabel(ownerFilterUser) : ownerFilter}
                    </bdi>
                  </span>
                  <button
                    type="button"
                    className="rounded-sm p-0.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={copy.removeOwnerFilter}
                    onClick={() => updateFilterQuery({ user: undefined })}
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                </Badge>
              ) : null}
              <p
                role="status"
                className="whitespace-nowrap text-xs text-muted-foreground sm:ms-auto"
                data-testid="machine-count"
              >
                <span aria-hidden="true">
                  {filteredNodes.length} / {snapshot.nodes.length}
                </span>
                <span className="sr-only">
                  {t("machineCount", {
                    shown: filteredNodes.length,
                    total: snapshot.nodes.length,
                  })}
                </span>
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
                    <TableHead className="hidden lg:table-cell">{copy.actions}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredNodes.map((node) => (
                    <TableRow key={node.id} data-testid={`device-${node.id}`}>
                      <TableCell className="whitespace-normal align-top lg:min-w-64 lg:whitespace-nowrap">
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
                        <div className="mt-2 lg:hidden">
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
                            {/* Beside the trigger the menu can use the full window height. */}
                            <DropdownMenuContent
                              side="inline-end"
                              align="center"
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
                                {isTimestampExpired(node.expiry) ? null : (
                                  <DropdownMenuItem
                                    data-testid={`expire-node-action-mobile-${node.id}`}
                                    onClick={() => openExpireDialog(node)}
                                  >
                                    <Clock className="h-4 w-4" aria-hidden="true" />
                                    {copy.expire}
                                  </DropdownMenuItem>
                                )}
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
                      <TableCell className="whitespace-normal align-top lg:min-w-40 lg:whitespace-nowrap">
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
                      <TableCell className="whitespace-normal align-top lg:min-w-56 lg:whitespace-nowrap">
                        {nodePendingRoutes(node).length ? (
                          <button
                            type="button"
                            className="flex flex-wrap gap-1 rounded-md text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            data-testid={`device-pending-routes-${node.id}`}
                            title={copy.viewRoutes}
                            onClick={() => jumpToRoutesForMachine(node)}
                          >
                            {nodePendingRoutes(node).map((route, routeIndex) =>
                              routeBadge(
                                route,
                                false,
                                `device-pending-route-${node.id}-${routeIndex}`,
                                "cursor-pointer hover:opacity-90",
                              ),
                            )}
                          </button>
                        ) : null}
                        {node.approvedRoutes.length ? (
                          <div
                            className={cn("flex flex-wrap gap-1", {
                              "mt-2": nodePendingRoutes(node).length,
                            })}
                          >
                            {node.approvedRoutes.map((route, routeIndex) =>
                              routeBadge(
                                route,
                                true,
                                `device-approved-route-${node.id}-${routeIndex}`,
                              ),
                            )}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="whitespace-normal align-top lg:min-w-44 lg:whitespace-nowrap">
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
                        {node.online ? null : (
                          <p className="mt-2 text-xs text-muted-foreground">
                            {copy.lastSeen}: {formatDate(node.lastSeen)}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {copy.expires}: {formatDate(node.expiry)}
                        </p>
                      </TableCell>
                      <TableCell className="hidden align-top lg:table-cell lg:min-w-16">
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
                            {/* Beside the trigger the menu can use the full window height. */}
                            <DropdownMenuContent
                              side="inline-start"
                              align="center"
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
                                {isTimestampExpired(node.expiry) ? null : (
                                  <DropdownMenuItem
                                    data-testid={`expire-node-action-${node.id}`}
                                    onClick={() => openExpireDialog(node)}
                                  >
                                    <Clock className="h-4 w-4" aria-hidden="true" />
                                    {copy.expire}
                                  </DropdownMenuItem>
                                )}
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
    </section>
  );
}
