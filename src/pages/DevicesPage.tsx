import { useStore as useFormStore } from "@tanstack/react-form";
import {
  Link,
  type RouterHistory,
  useNavigate,
  useRouter,
  useSearch,
} from "@tanstack/react-router";
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
import { CopyButton } from "@/components/app/copy-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/app/dialog";
import { submitForm, useAppForm } from "@/components/app/form";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/app/native-select";
import { Notice } from "@/components/app/notice";
import { Tooltip } from "@/components/app/tooltip";
import { CreateKeyOutcomeNotice } from "@/components/CreateAuthKeyDialog";
import { authKeyDialogUser } from "@/components/create-auth-key-dialog";
import { TagField } from "@/components/TagField";
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
import type {
  LifecycleScope,
  TagReturnRecord,
} from "@/composables/tag-lifecycle-state";
import {
  type ActionFeedbackKey,
  useActionFeedback,
} from "@/composables/useActionFeedback";
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
import {
  AUTH_ID_PLACEHOLDER,
  normalizePublicLoginServer,
  parseAuthRequest,
} from "@/domain/auth-request";
import {
  isTimestampExpired,
  type NodeConnectionStatus,
  nodeConnectionStatus,
} from "@/domain/node-status";
import { parsePolicy } from "@/domain/policy-designer";
import {
  assignableTagsFromPolicy,
  type NodeTagBaseline,
  nodeTagBaseline,
  replaceTagInSet,
  sameNodeTagBaseline,
  sameTagSet,
  tagSetDiff,
} from "@/domain/tag-lifecycle";
import { useHeadscaleI18n } from "@/i18n";
import type { ProductCopy } from "@/i18n/product-copy";
import { cn } from "@/lib/utils";
import { downloadCsv } from "@/utils/csv";
import {
  isNodeTag,
  isValidNodeName,
  nodePendingRoutes,
  parseNodeTags,
} from "@/utils/node";
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

type TagDecision = {
  scope: LifecycleScope;
  node: NodeTagBaseline;
  policy: string;
};
type TagConfirmation = TagDecision & { tags: string[]; editVersion: number };

type AddDeviceStepInfo = {
  id: ReturnType<typeof useDeviceSetup>["step"];
  label: string;
  description: string;
};

function deviceSetupTitle(task: AddDeviceTask | null, copy: ProductCopy) {
  if (task === "pending") return copy.pendingRegistrationTitle;
  return task === "server"
    ? copy.addLinuxServerTitle
    : copy.addClientDeviceTitle;
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
          {
            id: "result",
            label: copy.wizardResult,
            description: copy.wizardStepResultDescription,
          },
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

function authRequestError(
  key: string,
  kind: "device" | "ssh",
  copy: ProductCopy,
) {
  const request = parseAuthRequest(key);
  if (!request) return copy.authRequestInvalid;
  if (kind === "device" && request.source === "auth-link")
    return copy.authRequestIsSshCheck;
  if (kind === "ssh" && request.source === "register-link")
    return copy.authRequestIsRegistration;
  return undefined;
}

export default function DevicesPage() {
  const session = useSession();
  const { stale } = useStore(session.drafts);
  const { copy } = useProductCopy();
  const { t } = useHeadscaleI18n();
  const { snapshot, nodeById: currentNode } = useSnapshot();
  const { isRefreshing: isRefreshingSnapshot, refresh: refreshDevices } =
    useSegment("fabric", "identity");
  const snapshotState = useStore(session.snapshot);
  const identityInventoryFailed =
    snapshotState.segmentStatus.identity === "error" ||
    Boolean(snapshotState.refreshErrors.identity);
  const { settings } = useHeadscaleClient();
  const { actionError, actionOutcome, clearActionFeedback, isActionPending } =
    useActionFeedback();
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
    pendingRegistrationForm: storedPendingRegistration,
  } = useDeviceSetup();
  const navigate = useNavigate();
  const history: RouterHistory = useRouter().history;
  const intent = useRouteIntent();
  const searchParams = useSearch({ strict: false }) as Record<string, unknown>;
  const migrationFrom =
    typeof searchParams.migrateFrom === "string"
      ? searchParams.migrateFrom
      : null;
  const migrationTo =
    typeof searchParams.migrateTo === "string" ? searchParams.migrateTo : null;
  const maintenanceReturn =
    typeof searchParams.maintenance === "string"
      ? searchParams.maintenance
      : null;
  const nodePopupIntent =
    intent.nodeId && (intent.popup === "node" || intent.popup === "tags")
      ? JSON.stringify([
          intent.nodeId,
          intent.popup,
          intent.from,
          migrationFrom,
          migrationTo,
          maintenanceReturn,
        ])
      : null;

  // The URL carries the filters, so a reload or a shared link lists the same machines.
  const urlSearch = intent.search ?? "";
  const urlFilter =
    MACHINE_FILTERS.find((filter) => filter === searchParams.filter) ?? "all";
  const ownerFilter = intent.userId;
  const [deviceSearch, setDeviceSearch] = useState(urlSearch);
  const [machineFilter, setMachineFilter] = useState<MachineFilter>(urlFilter);
  useEffect(() => setDeviceSearch(urlSearch), [urlSearch]);
  useEffect(() => setMachineFilter(urlFilter), [urlFilter]);

  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [selectedRenameNode, setSelectedRenameNode] =
    useState<HeadscaleNode | null>(null);
  const [selectedExpireNode, setSelectedExpireNode] =
    useState<HeadscaleNode | null>(null);
  const [expireAction, setExpireAction] = useState<"expire" | "disable">(
    "expire",
  );
  const [selectedRemoveNode, setSelectedRemoveNode] =
    useState<HeadscaleNode | null>(null);
  const [selectedTagsNode, setSelectedTagsNode] =
    useState<HeadscaleNode | null>(null);
  const [selectedDetailNode, setSelectedDetailNode] =
    useState<HeadscaleNode | null>(null);
  const dialogReturnFocus = useRef<Element | null | undefined>(null);
  function rememberActionTrigger(
    open: boolean,
    { trigger }: { trigger: Element | undefined },
  ) {
    if (open) dialogReturnFocus.current = trigger;
  }
  function returnDialogFocus() {
    // A menu item unmounts when it opens a dialog; retain the actual row trigger instead.
    const trigger = dialogReturnFocus.current;
    return trigger instanceof HTMLElement && trigger.isConnected
      ? trigger
      : true;
  }

  const [tagsSyncing, setTagsSyncing] = useState(false);
  const lifecycle = useStore(session.tagLifecycle);
  const [tagSearch, setTagSearch] = useState("");
  const [tagsBaseline, setTagsBaseline] = useState<TagDecision | null>(null);
  const [tagsConfirmation, setTagsConfirmation] =
    useState<TagConfirmation | null>(null);
  const [tagsReadError, setTagsReadError] = useState("");
  const [tagsNotice, setTagsNotice] = useState("");
  const [tagsResult, setTagsResult] = useState<
    "confirmed" | "refresh-failed" | null
  >(null);
  const tagEditVersion = useRef(0);
  const tagOperation = useRef(0);
  const mounted = useRef(true);
  const notificationOwner = useRef(0);
  function beginDeviceNotification() {
    const operation = ++notificationOwner.current;
    const ownsSession = session.snapshot.captureSession();
    const viewEpoch = session.drafts.getSnapshot().viewEpoch;
    return session.feedback.beginNotification({
      isCurrent: () =>
        mounted.current &&
        operation === notificationOwner.current &&
        ownsSession() &&
        viewEpoch === session.drafts.getSnapshot().viewEpoch,
    });
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      ++tagOperation.current;
    };
  }, []);
  const [setupTagSearch, setSetupTagSearch] = useState("");
  const [setupExpiration, setSetupExpiration] = useState("");
  const setupEditVersion = useRef(0);
  const [returnReadError, setReturnReadError] = useState<
    "failed" | "newer-edit" | null
  >(null);
  const [restoreNode, setRestoreNode] = useState<HeadscaleNode | null>(null);
  const [restoreReviewReady, setRestoreReviewReady] = useState(true);
  const restoreAttempt = useRef<"initial" | "review" | "submitted">("initial");
  const [authTargetUser, setAuthTargetUser] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [authPublicServer, setAuthPublicServer] = useState("");
  const [authServerConfirmed, setAuthServerConfirmed] = useState(false);
  const [authSourceConfirmed, setAuthSourceConfirmed] = useState(false);
  const [authBackupConfirmed, setAuthBackupConfirmed] = useState(false);
  const [authCheckScope, setAuthCheckScope] = useState<LifecycleScope | null>(
    null,
  );
  const [authReading, setAuthReading] = useState(false);
  const [authSafetyError, setAuthSafetyError] = useState("");
  const [authReadError, setAuthReadError] = useState("");
  const [authResult, setAuthResult] = useState<
    | "identity-observed"
    | "observation-conflict"
    | "uncertain"
    | "pending"
    | "refresh-failed"
    | null
  >(null);
  const [authObservedNode, setAuthObservedNode] =
    useState<HeadscaleNode | null>(null);
  const authOperation = useRef(0);
  const returnOrigin = useRef(history.location.pathname);
  const returnNavigation = useRef(0);
  const returningAttempt = useRef<{ id: string; navigation: number } | null>(
    null,
  );
  const departingReturn = useRef<{
    id: string;
    origin: string;
    leftOrigin: boolean;
  } | null>(null);
  const returnEdits = useRef<{
    id: string;
    tags: number;
    setup: number;
  } | null>(null);
  const [returnRetry, setReturnRetry] = useState(0);
  // Observe history synchronously: a lazy destination may never unmount this page before Back.
  useEffect(() => {
    let previous = history.location;
    const sourcePath = returnOrigin.current;
    return history.subscribe(({ location }) => {
      if (previous.pathname !== location.pathname) {
        ++returnNavigation.current;
        setReturnRetry((value) => value + 1);
      }
      if (
        previous.pathname === sourcePath &&
        location.pathname === sourcePath &&
        previous.href !== location.href &&
        session.tagLifecycle.getSnapshot().returnTo
      ) {
        // Back/replace can change the source filters without an input event. Our own restore
        // consumes the slot before replacing the query, so it does not invalidate itself.
        ++tagEditVersion.current;
        ++setupEditVersion.current;
      }
      previous = location;
      const departure = departingReturn.current;
      if (!departure) return;
      if (location.pathname !== departure.origin) departure.leftOrigin = true;
      else if (departure.leftOrigin) departingReturn.current = null;
    });
  }, [history, session.tagLifecycle]);

  function rememberReturnEdits(id: string) {
    const edits = {
      id,
      tags: tagEditVersion.current,
      setup: setupEditVersion.current,
    };
    returnEdits.current = edits;
    return edits;
  }
  function rememberTagDeparture(id: string) {
    const origin = returnOrigin.current;
    departingReturn.current = {
      id,
      origin,
      // Replacing a pending handoff may navigate to the same URL without another history event.
      leftOrigin: history.location.pathname !== origin,
    };
    rememberReturnEdits(id);
  }
  const [discardKeyAction, setDiscardKeyAction] = useState<
    "open" | "close" | AddDeviceStepInfo["id"] | null
  >(null);
  const discardKeyActionRef = useRef(discardKeyAction);
  discardKeyActionRef.current = discardKeyAction;
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

  const {
    formatDate,
    userLabel,
    nodeDisplayName,
    nodeOwner,
    nodeUser,
    nodeStatusLabel,
    hasVisibleUser,
  } = useDisplayHelpers();

  const visibleUsers = snapshot.users.filter((user) => hasVisibleUser(user));
  // Open drafts keep offering the users of the server they were started on.
  const [draftUsers, setDraftUsers] = useState<HeadscaleUser[]>([]);
  useEffect(() => {
    if (!stale) setDraftUsers(snapshot.users.filter(hasVisibleUser));
  }, [snapshot.users, stale, hasVisibleUser]);
  const registrationUserOptions = draftUsers.map((user) => ({
    value: user.id,
    label: `${userLabel(user)} (${user.name} · ${user.id})`,
  }));

  const { mutateDetailed } = useMutation();
  const createPreAuthKey = useCreatePreAuthKey();
  const quiet = useMutation({ skipRefresh: true });
  const anyAuthPending =
    isActionPending("register-pending-node") ||
    isActionPending("approve-auth-request") ||
    isActionPending("reject-auth-request");

  const renameForm = useAppForm({
    defaultValues: { name: "" },
    validators: {
      onDynamic: ({ value }) => ({
        fields: {
          name: isValidNodeName(value.name.trim())
            ? undefined
            : copy.invalidMachineName,
        },
      }),
    },
    onSubmit: async ({ value, formApi }) => {
      const name = value.name.trim();
      formApi.setFieldValue("name", name);
      if (
        !renameDialogOpen ||
        !selectedRenameNode ||
        isActionPending("rename-node")
      )
        return;
      if (name === nodeDisplayName(selectedRenameNode)) return;
      const notification = beginDeviceNotification();
      const renamed = await mutateDetailed("rename-node", {
        endpoint: "renameNode",
        input: { nodeId: selectedRenameNode.id, newName: name },
      });
      if (!["unknown", "possibly-applied"].includes(renamed.outcome.status))
        notification.publishMutation(
          renamed.outcome,
          "product.feedbackRequestConfirmed",
        );
      if (renamed.ok) closeRenameDialog();
    },
  });
  const renameDraft = useFormStore(
    renameForm.store,
    (state) => state.values.name,
  );
  const renameSubmitting = useFormStore(
    renameForm.store,
    (state) => state.isSubmitting,
  );

  const tagsForm = useAppForm({
    defaultValues: { tags: [] as string[], acknowledged: false },
    validators: {
      onDynamic: ({ value }) => ({
        fields: {
          tags:
            value.tags.length === 0
              ? copy.tagsRequiredForTaggedNode
              : undefined,
        },
      }),
    },
    onSubmit: async () => {
      await reviewTags();
    },
  });
  const tagsValues = useFormStore(tagsForm.store, (state) => state.values);
  const tagsSubmitting = useFormStore(
    tagsForm.store,
    (state) => state.isSubmitting,
  );

  const setupForm = useAppForm({
    defaultValues: {
      task: null as AddDeviceTask | null,
      user: "",
      reusable: false,
      ephemeral: false,
      aclTags: "",
      advertiseExitNode: false,
      expiryDays: "7",
    },
    listeners: {
      onChange: ({ fieldApi }) => {
        ++setupEditVersion.current;
        if (fieldApi.name === "expiryDays") setSetupExpiration("");
      },
    },
    validators: {
      onDynamic: ({ value }) => {
        const tags = parseNodeTags(value.aclTags);
        return {
          fields: {
            aclTags: tags.every(isNodeTag) ? undefined : copy.invalidTags,
            expiryDays:
              addDeviceStep === "generate" &&
              setupExpiration &&
              Date.parse(setupExpiration) <= Date.now()
                ? copy.setupExpiredReturn
                : undefined,
            user:
              addDeviceStep !== "preferences" &&
              value.user.trim() === "" &&
              tags.length === 0
                ? copy.inviteTagsRequired
                : undefined,
          },
        };
      },
    },
    onSubmit: async ({ value, formApi }) => {
      if (
        !deviceSetupDialogOpen ||
        value.task !== deviceSetupTask ||
        deviceSetupTask === "pending" ||
        anyAuthPending ||
        isActionPending("create-invite")
      )
        return;
      const tags = value.aclTags.trim();
      const user = value.user.trim();
      formApi.setFieldValue("aclTags", tags);
      formApi.setFieldValue("user", user);
      const { expiration } = commitExpiryDraft();
      if (addDeviceStep === "preferences" || addDeviceStep === "authKey") {
        setDeviceSetupState({
          step: addDeviceStep === "preferences" ? "authKey" : "generate",
        });
        return;
      }
      if (stale) return;
      if (session.deviceSetup.getSnapshot().lastCreatedInvite) {
        setDiscardKeyAction("generate");
        return;
      }
      await createPreAuthKey({
        user: user || undefined,
        reusable: value.reusable,
        ephemeral: value.ephemeral,
        expiration,
        aclTags: parseNodeTags(tags),
      });
    },
  });
  const inviteForm = useFormStore(setupForm.store, (state) => state.values);
  const setupSubmitting = useFormStore(
    setupForm.store,
    (state) => state.isSubmitting,
  );
  const advertiseExitNode = inviteForm.advertiseExitNode;
  useEffect(() => {
    if (stale) return;
    const user = setupForm.getFieldValue("user");
    if (user && !draftUsers.some((candidate) => candidate.id === user))
      setupForm.setFieldValue("user", draftUsers[0]?.id ?? "");
  }, [draftUsers, setupForm, stale]);

  const authForm = useAppForm({
    defaultValues: storedPendingRegistration,
    onSubmitMeta: "approved" as "approved" | "rejected",
    validators: {
      onDynamic: ({ value }) => ({
        fields: {
          key: authRequestError(value.key, value.kind, copy),
          user:
            value.kind === "device" && !value.user.trim()
              ? copy.noUsers
              : undefined,
        },
      }),
    },
    listeners: {
      onChange: ({ formApi, fieldApi }) => {
        setDeviceSetupState({
          pendingRegistrationForm: formApi.state.values,
          ...(fieldApi.name === "key" || fieldApi.name === "kind"
            ? { lastAuthDecision: null }
            : {}),
        });
        setAuthSourceConfirmed(false);
        setAuthCheckScope(null);
        setAuthSafetyError("");
        if (fieldApi.name === "user") {
          const chosen = draftUsers.find(
            (candidate) => candidate.id === formApi.state.values.user,
          );
          setAuthTargetUser(
            chosen ? { id: chosen.id, name: chosen.name } : null,
          );
        }
        if (fieldApi.name === "kind") clearAuthFeedback();
      },
    },
    onSubmit: async ({ value, formApi, meta }) => {
      if (
        !deviceSetupDialogOpen ||
        deviceSetupTask !== "pending" ||
        addDeviceStep !== "pending" ||
        anyAuthPending
      )
        return;
      const key = value.key.trim();
      const user = value.user.trim();
      formApi.setFieldValue("key", key);
      formApi.setFieldValue("user", user);
      // onDynamic 已用同一解析器校验，只有有效请求能进入提交回调。
      const request = parseAuthRequest(key) as NonNullable<
        ReturnType<typeof parseAuthRequest>
      >;
      if (value.kind === "device") await registerPendingNode(request.id);
      else await decideAuthRequest(meta, request.id);
    },
  });
  const pendingRegistrationForm = useFormStore(
    authForm.store,
    (state) => state.values,
  );
  const authSubmitting = useFormStore(
    authForm.store,
    (state) => state.isSubmitting,
  );

  const loginForm = useAppForm({
    defaultValues: { loginServer: loginServer ?? settings.baseUrl },
    validators: {
      onDynamic: ({ value }) => ({
        fields: {
          loginServer: isHttpUrl(value.loginServer)
            ? undefined
            : t("connectionInvalidUrl"),
        },
      }),
    },
    listeners: {
      onChange: ({ formApi }) =>
        setDeviceSetupState({ loginServer: formApi.state.values.loginServer }),
    },
    onSubmit: ({ value, formApi }) => {
      formApi.setFieldValue("loginServer", value.loginServer.trim());
    },
  });
  const loginServerUrl = useFormStore(
    loginForm.store,
    (state) => state.values.loginServer,
  );

  // 外部会话重置只同步持久字段，不能用整个草稿重置覆盖正在编辑的设备选项。
  useEffect(() => {
    for (const name of ["user", "key", "kind"] as const) {
      if (authForm.getFieldValue(name) !== storedPendingRegistration[name]) {
        authForm.setFieldValue(name, storedPendingRegistration[name], {
          dontRunListeners: true,
          dontUpdateMeta: true,
        });
      }
    }
  }, [authForm, storedPendingRegistration]);
  useEffect(() => {
    setupForm.setFieldValue("task", deviceSetupTask, {
      dontUpdateMeta: true,
      dontRunListeners: true,
    });
  }, [setupForm, deviceSetupTask]);
  useEffect(() => {
    setupForm.setFieldValue("expiryDays", String(authKeyExpiryDays), {
      dontUpdateMeta: true,
      dontRunListeners: true,
    });
  }, [setupForm, authKeyExpiryDays]);
  useEffect(() => {
    const value = loginServer ?? settings.baseUrl;
    if (loginForm.getFieldValue("loginServer") !== value) {
      loginForm.setFieldValue("loginServer", value, {
        dontRunListeners: true,
        dontUpdateMeta: true,
      });
    }
  }, [loginForm, loginServer, settings.baseUrl]);
  useEffect(() => {
    if (
      authTargetUser &&
      !draftUsers.some(
        (candidate) =>
          candidate.id === authTargetUser.id &&
          candidate.name === authTargetUser.name,
      )
    ) {
      setAuthSourceConfirmed(false);
      setAuthCheckScope(null);
      setAuthSafetyError(copy.restoreUserChanged);
    }
  }, [draftUsers, authTargetUser, copy.restoreUserChanged]);
  useEffect(() => {
    if (
      authCheckScope &&
      (!lifecycle.scope || !session.tagLifecycle.isCurrent(authCheckScope))
    ) {
      setAuthSourceConfirmed(false);
      setAuthServerConfirmed(false);
      setAuthCheckScope(null);
      setAuthSafetyError(copy.tagConfirmationStale);
    }
  }, [
    lifecycle.scope,
    authCheckScope,
    session.tagLifecycle,
    copy.tagConfirmationStale,
  ]);

  const ownerFilterUser = visibleUsers.find((user) => user.id === ownerFilter);
  const query = deviceSearch.trim().toLowerCase();
  const filteredNodes = snapshot.nodes.filter((node) => {
    const searchable = [
      node.name,
      node.givenName,
      ...(hasVisibleUser(node.user)
        ? [nodeUser(node)?.name, nodeUser(node)?.email, nodeOwner(node)]
        : []),
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
      ownerFilter === null ||
      (hasVisibleUser(node.user) && node.user.id === ownerFilter);

    return matchesSearch && matchesFilter && matchesOwner;
  });

  const hasMachineFilters =
    deviceSearch.trim() !== "" ||
    machineFilter !== "all" ||
    ownerFilter !== null;

  const wizardTags = parseNodeTags(inviteForm.aclTags);
  const policyText = snapshot.policy?.policy;
  // Unknown (not loaded or unreadable) policies give no hint rather than a false one.
  const definedTags = useMemo(() => {
    if (policyText === undefined) return null;
    const policy = parsePolicy(policyText);
    return policy.error
      ? null
      : new Set(policy.tagOwners.map((owner) => owner.tag));
  }, [policyText]);
  const loginServerValid = isHttpUrl(loginServerUrl);
  const installCommand =
    lastCreatedInvite && loginServerValid
      ? tailscaleUpCommand(loginServerUrl, lastCreatedInvite, advertiseExitNode)
      : "";

  const nextNodeTags = tagsValues.tags;
  const tagsOwnedNode =
    selectedTagsNode !== null && selectedTagsNode.tags.length > 0;
  const tagsWouldDropOwner = !tagsOwnedNode && nextNodeTags.length > 0;
  const tagsWouldClear = nextNodeTags.length === 0;
  const tagsOutcomeUnknown = ["unknown", "possibly-applied"].includes(
    actionOutcome("node-tags")?.status ?? "",
  );
  const canSaveTags = !tagsWouldClear && !stale && !tagsResult;
  useEffect(() => {
    if (
      tagsConfirmation &&
      (!lifecycle.scope ||
        !session.tagLifecycle.isCurrent(tagsConfirmation.scope))
    ) {
      setTagsConfirmation(null);
      tagsForm.setFieldValue("acknowledged", false);
      setTagsNotice(copy.tagConfirmationStale);
    }
  }, [
    lifecycle.scope,
    tagsConfirmation,
    session.tagLifecycle,
    tagsForm,
    copy.tagConfirmationStale,
  ]);

  const renameName = renameDraft.trim();
  const canRename =
    renameName !== "" &&
    selectedRenameNode !== null &&
    renameName !== nodeDisplayName(selectedRenameNode);

  const steps = addDeviceSteps(
    deviceSetupTask,
    pendingRegistrationForm.kind,
    copy,
  );
  const addDeviceStepIndex = Math.max(
    0,
    steps.findIndex((step) => step.id === addDeviceStep),
  );
  const nextStep = steps[addDeviceStepIndex + 1];

  const parsedAuthRequest = parseAuthRequest(pendingRegistrationForm.key);
  const authRequestHint = pendingRegistrationForm.key.trim()
    ? authRequestError(
        pendingRegistrationForm.key,
        pendingRegistrationForm.kind,
        copy,
      )
    : undefined;
  const canSubmitAuthRequest =
    parsedAuthRequest !== null && !authRequestHint && !anyAuthPending;
  const normalizedPublicServer = normalizePublicLoginServer(authPublicServer);
  const wrongAuthServer =
    parsedAuthRequest?.loginServer !== undefined &&
    parsedAuthRequest.loginServer !== normalizedPublicServer;
  const authOutcomeUnknown = ["unknown", "possibly-applied"].includes(
    actionOutcome("register-pending-node")?.status ?? "",
  );
  const validAuthTarget =
    authTargetUser &&
    draftUsers.some(
      (user) =>
        user.id === authTargetUser.id && user.name === authTargetUser.name,
    );
  const authSafetyReady =
    validAuthTarget &&
    authSourceConfirmed &&
    authServerConfirmed &&
    (!restoreNode || (authBackupConfirmed && restoreReviewReady)) &&
    Boolean(normalizedPublicServer) &&
    !wrongAuthServer &&
    authCheckScope &&
    session.tagLifecycle.isCurrent(authCheckScope);
  const registerAuthId =
    canSubmitAuthRequest && authSafetyReady && !authReading
      ? parsedAuthRequest.id
      : "";
  const decideAuthId = canSubmitAuthRequest ? parsedAuthRequest.id : "";
  const latest = useRef({ consumeDeviceQuery });
  latest.current = { consumeDeviceQuery };

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
    ++tagEditVersion.current;
    ++setupEditVersion.current;
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
    updateFilterQuery({
      search: undefined,
      filter: undefined,
      user: undefined,
    });
  }

  function setAuthKeyExpiryDays(value: number) {
    const days = Math.min(90, Math.max(1, value));
    setupForm.setFieldValue("expiryDays", String(days), {
      dontRunListeners: true,
    });
    const expiration =
      !setupExpiration ||
      days !== session.deviceSetup.getSnapshot().authKeyExpiryDays
        ? new Date(Date.now() + days * 86_400_000).toISOString()
        : setupExpiration;
    setSetupExpiration(expiration);
    setDeviceSetupState({ authKeyExpiryDays: days });
    return { days, expiration };
  }

  function commitExpiryDraft() {
    const days = Number.parseInt(setupForm.getFieldValue("expiryDays"), 10);
    return setAuthKeyExpiryDays(
      Number.isFinite(days)
        ? days
        : session.deviceSetup.getSnapshot().authKeyExpiryDays,
    );
  }

  // A generated key belongs to the options it was made with; going back makes them editable.
  function returnToAddDeviceStep(step: AddDeviceStepInfo["id"]) {
    if (lastCreatedInvite) {
      setDiscardKeyAction(step);
      return;
    }
    setDeviceSetupState({
      step,
      ...(step === "type" ? { task: null, lastRegisteredNode: null } : {}),
    });
  }

  function goToPreviousAddDeviceStep() {
    returnToAddDeviceStep(steps[addDeviceStepIndex - 1]?.id ?? "type");
  }

  function isAddDeviceStepComplete(index: number) {
    return index < addDeviceStepIndex;
  }

  function openDeviceSetupDialog() {
    if (wizardBusy) return;
    dialogReturnFocus.current = null;
    ++setupEditVersion.current;
    if (lastCreatedInvite) {
      setDiscardKeyAction("open");
      return;
    }
    setDeviceSetupState({
      task: null,
      step: "type",
      lastCreatedInvite: "",
      lastRegisteredNode: null,
      open: true,
    });
  }

  function prepareDeviceInvite(task: "server" | "client") {
    ++setupEditVersion.current;
    setSetupTagSearch("");
    setSetupExpiration(new Date(Date.now() + 7 * 86_400_000).toISOString());
    setRestoreNode(null);
    clearActionFeedback("create-invite");
    // Presets set every option: a client device is a person's own machine, a server is automated.
    if (wizardBusy) return;
    setupForm.reset(
      {
        task,
        user: draftUsers[0]?.id ?? "",
        reusable: task === "server",
        ephemeral: false,
        aclTags: task === "server" ? "tag:server" : "",
        advertiseExitNode: false,
        expiryDays: "7",
      },
      { keepDefaultValues: true },
    );
    setDeviceSetupState({
      task,
      step: "preferences",
      open: true,
      authKeyExpiryDays: 7,
      lastCreatedInvite: "",
      lastRegisteredNode: null,
    });
  }

  function clearAuthFeedback() {
    clearActionFeedback("register-pending-node");
    clearActionFeedback("approve-auth-request");
    clearActionFeedback("reject-auth-request");
  }

  function preparePendingRegistration() {
    if (wizardBusy) return;
    setRestoreNode(null);
    resetAuthChecks();
    authForm.reset(
      { user: "", key: "", kind: "device" },
      { keepDefaultValues: true },
    );
    clearAuthFeedback();
    setDeviceSetupState({
      task: "pending",
      step: "pending",
      open: true,
      lastCreatedInvite: "",
      lastRegisteredNode: null,
      pendingRegistrationForm: { user: "", key: "", kind: "device" },
    });
  }

  function resetAuthChecks() {
    ++authOperation.current;
    restoreAttempt.current = "initial";
    setRestoreReviewReady(true);
    setAuthTargetUser(null);
    setAuthPublicServer("");
    setAuthServerConfirmed(false);
    setAuthSourceConfirmed(false);
    setAuthBackupConfirmed(false);
    setAuthCheckScope(null);
    setAuthSafetyError("");
    setAuthReadError("");
    setAuthReading(false);
    setAuthResult(null);
    setAuthObservedNode(null);
  }

  function openPersonalRestore(node: HeadscaleNode) {
    preparePendingRegistration();
    setRestoreNode(node);
  }

  function beginPersonalRestoreAttempt() {
    if (!restoreNode || restoreAttempt.current === "initial") return;
    // Only explicit input starts another attempt, never form resets or renewed checkboxes.
    ++authOperation.current;
    restoreAttempt.current = "review";
    setRestoreReviewReady(false);
    setAuthSourceConfirmed(false);
    setAuthServerConfirmed(false);
    setAuthBackupConfirmed(false);
    setAuthCheckScope(null);
    setAuthSafetyError("");
    setAuthReadError("");
    setAuthResult(null);
    setAuthObservedNode(null);
    setDeviceSetupState({ lastRegisteredNode: null, lastAuthDecision: null });
    clearAuthFeedback();
    session.feedback.setActionOutcome("register-pending-node", {
      status: "not-dispatched",
      refresh: "not-requested",
    });
  }

  const wizardBusy =
    anyAuthPending ||
    authReading ||
    isActionPending("create-invite") ||
    setupSubmitting ||
    authSubmitting;

  // The dialog has no trigger, so Base UI only ever reports it closing. The created key is
  // shown only once, so dismissing it asks first; Done closes without asking.
  function requestCloseDeviceSetupDialog() {
    if (wizardBusy) return;
    if (lastCreatedInvite) setDiscardKeyAction("close");
    else closeDeviceSetupDialog();
  }

  function confirmDiscardKey() {
    const action = discardKeyActionRef.current;
    discardKeyActionRef.current = null;
    if (action === "close") {
      closeDeviceSetupDialog();
      return;
    }
    if (action === null) return;
    const step = action === "open" ? "type" : action;
    setDeviceSetupState({
      open: true,
      step,
      lastCreatedInvite: "",
      ...(step === "type" ? { task: null, lastRegisteredNode: null } : {}),
    });
    setDiscardKeyAction(null);
  }

  function closeDeviceSetupDialog() {
    ++authOperation.current;
    setAuthSourceConfirmed(false);
    setAuthServerConfirmed(false);
    setAuthCheckScope(null);
    setRestoreNode(null);
    setDiscardKeyAction(null);
    setDeviceSetupState({
      open: false,
      task: null,
      step: "type",
      lastCreatedInvite: "",
      lastRegisteredNode: null,
      lastAuthDecision: null,
      pendingRegistrationForm: { ...authForm.state.values, key: "" },
    });
    clearAuthFeedback();
    clearActionFeedback("create-invite");
  }

  // The new machine appears once the key or request is used, so Done reloads the list.
  function finishDeviceSetup() {
    closeDeviceSetupDialog();
    void refreshDevices();
  }

  function openAccessFromDeviceSetup(tag = "") {
    if (lastCreatedInvite || deviceSetupTask === "pending" || wizardBusy)
      return;
    const values = setupForm.state.values;
    const { days, expiration } = commitExpiryDraft();
    const saved = session.tagLifecycle.saveReturn({
      source: "setup",
      managedTag: tag,
      editVersion: setupEditVersion.current,
      filter: deviceSearch,
      task: deviceSetupTask,
      step: "preferences",
      advertiseExitNode: values.advertiseExitNode,
      loginServer: loginForm.getFieldValue("loginServer"),
      form: {
        userId: values.user,
        userName:
          draftUsers.find((user) => user.id === values.user)?.name ?? "",
        tags: parseNodeTags(values.aclTags),
        tagInput: setupTagSearch,
        reusable: values.reusable,
        ephemeral: values.ephemeral,
        expiration,
        expirationMode: "preset",
        expiryDays: String(days),
      },
    });
    if (!saved) return;
    rememberTagDeparture(saved.id);
    closeDeviceSetupDialog();
    void navigate({ to: "/access", search: tag ? { tag } : {} });
  }

  async function restoreTagReturn(record: TagReturnRecord) {
    if (record.source !== "device" && record.source !== "setup") return;
    if (history.location.pathname !== returnOrigin.current) return;
    const navigation = returnNavigation.current;
    if (
      returningAttempt.current?.id === record.id &&
      returningAttempt.current.navigation === navigation
    )
      return;
    const edits =
      returnEdits.current?.id === record.id
        ? returnEdits.current
        : rememberReturnEdits(record.id);
    if (
      edits.tags !== tagEditVersion.current ||
      edits.setup !== setupEditVersion.current
    ) {
      setReturnReadError("newer-edit");
      return;
    }
    const attempt = { id: record.id, navigation };
    returningAttempt.current = attempt;
    setReturnReadError(null);
    const ownsSession = session.snapshot.captureSession();
    const viewEpoch = session.drafts.getSnapshot().viewEpoch;
    const tagEdit = tagEditVersion.current;
    const setupEdit = setupEditVersion.current;
    const fresh = await session.snapshot.refreshSegments(
      record.source === "device"
        ? ["fabric", "policy"]
        : ["fabric", "policy", "identity"],
    );
    if (returningAttempt.current === attempt) returningAttempt.current = null;
    if (
      !mounted.current ||
      navigation !== returnNavigation.current ||
      !ownsSession() ||
      viewEpoch !== session.drafts.getSnapshot().viewEpoch ||
      session.tagLifecycle.getSnapshot().returnTo?.id !== record.id
    )
      return;
    if (
      tagEdit !== tagEditVersion.current ||
      setupEdit !== setupEditVersion.current
    ) {
      setReturnReadError("newer-edit");
      return;
    }
    if (!fresh) {
      setReturnReadError("failed");
      return;
    }
    if (record.source === "device") {
      const node = session.snapshot.nodeById(record.nodeId);
      const decision = node && tagDecision(node);
      if (!node || !decision) {
        setReturnReadError("failed");
        return;
      }
      // No asynchronous boundary separates the slot ownership check above from consumption.
      session.tagLifecycle.consumeReturn(record.id);
      setSelectedTagsNode(node);
      tagsForm.reset(
        { tags: [...record.tags], acknowledged: false },
        { keepDefaultValues: true },
      );
      setTagSearch(record.filter ?? "");
      setTagsBaseline(decision);
      setTagsConfirmation(null);
      setTagsNotice(
        sameNodeTagBaseline(record.baseline, decision.node)
          ? ""
          : copy.tagDecisionChanged,
      );
      setTagsReadError("");
    } else {
      // No asynchronous boundary separates the slot ownership check above from consumption.
      session.tagLifecycle.consumeReturn(record.id);
      setupForm.reset(
        {
          task: record.task,
          user: record.form.userId,
          aclTags: record.form.tags.join(", "),
          reusable: record.form.reusable,
          ephemeral: record.form.ephemeral,
          expiryDays: record.form.expiryDays,
          advertiseExitNode: record.advertiseExitNode,
        },
        { keepDefaultValues: true },
      );
      setSetupExpiration(record.form.expiration);
      setSetupTagSearch(record.form.tagInput);
      setDeviceSetupState({
        open: true,
        task: record.task,
        step: record.step,
        authKeyExpiryDays: Number.parseInt(record.form.expiryDays, 10),
        loginServer: record.loginServer,
        lastCreatedInvite: "",
        lastRegisteredNode: null,
      });
      const filter = record.filter ?? "";
      setDeviceSearch(filter);
      void navigate({
        to: "/devices",
        search: (current: Record<string, unknown>) => ({
          ...current,
          search: filter || undefined,
        }),
        replace: true,
      });
    }
  }

  const returnLatest = useRef(restoreTagReturn);
  returnLatest.current = restoreTagReturn;
  // A same-task Back must retry even when React never committed the destination URL.
  useEffect(() => {
    const record = lifecycle.returnTo;
    if (!record) {
      departingReturn.current = null;
      returnEdits.current = null;
      return;
    }
    if (
      intent.popup === "tags" ||
      departingReturn.current?.id === record.id ||
      (record.source !== "device" && record.source !== "setup") ||
      selectedTagsNode ||
      deviceSetupDialogOpen ||
      returnReadError
    )
      return;
    // Browser Back uses the same one-shot slot as the explicit Access return action.
    if (record.status === "managing")
      session.tagLifecycle.requestReturn(record.id);
    void returnLatest.current(record);
  }, [
    lifecycle.returnTo,
    intent.popup,
    returnRetry,
    selectedTagsNode,
    deviceSetupDialogOpen,
    returnReadError,
    session.tagLifecycle,
  ]);

  function originalDeviceMatch(node: HeadscaleNode, original: HeadscaleNode) {
    return original.machineKey
      ? node.machineKey === original.machineKey
      : node.id === original.id;
  }

  function observePersonalIdentity(
    original: HeadscaleNode,
    target: { id: string; name: string },
    approved?: HeadscaleNode,
  ) {
    const nodes = session.snapshot
      .getSnapshot()
      .snapshot.nodes.filter((node) => originalDeviceMatch(node, original));
    const observed = nodes.length === 1 ? nodes[0] : undefined;
    setAuthObservedNode(observed ?? null);
    if (approved && !originalDeviceMatch(approved, original)) {
      setAuthResult("uncertain");
      return;
    }
    if (!observed) {
      setAuthResult(approved ? "uncertain" : "observation-conflict");
      return;
    }
    setAuthResult(
      observed.user?.id === target.id &&
        observed.user.name === target.name &&
        observed.tags.length === 0
        ? "identity-observed"
        : approved
          ? "pending"
          : "observation-conflict",
    );
  }

  async function readPersonalIdentity() {
    if (!restoreNode || !authTargetUser || authReading) return;
    const original = restoreNode;
    const target = authTargetUser;
    const submitted = restoreAttempt.current === "submitted";
    const scope = session.tagLifecycle.captureScope();
    const ownsSession = session.snapshot.captureSession();
    const viewEpoch = session.drafts.getSnapshot().viewEpoch;
    const operation = ++authOperation.current;
    const notification = session.feedback.beginNotification({
      isCurrent: () =>
        mounted.current &&
        operation === authOperation.current &&
        ownsSession() &&
        viewEpoch === session.drafts.getSnapshot().viewEpoch,
    });
    setAuthReading(true);
    setAuthSafetyError("");
    setAuthReadError("");
    if (!submitted) {
      // A failed or superseded reread cannot be turned into approval by checking the boxes again.
      setRestoreReviewReady(false);
      setAuthSourceConfirmed(false);
      setAuthServerConfirmed(false);
      setAuthBackupConfirmed(false);
      setAuthCheckScope(null);
      setAuthResult(null);
      setAuthObservedNode(null);
    }
    const fresh = await session.snapshot.refreshSegments([
      "fabric",
      "identity",
    ]);
    if (!mounted.current || operation !== authOperation.current) return;
    setAuthReading(false);
    if (!ownsSession() || viewEpoch !== session.drafts.getSnapshot().viewEpoch)
      return;
    if (!fresh) {
      setAuthReadError(
        submitted
          ? copy.restoreObservationFailed
          : copy.restoreBaselineReadFailed,
      );
      notification.publish({
        tone: "error",
        title: "product.feedbackRefreshFailed",
      });
      return;
    }
    if (submitted) {
      observePersonalIdentity(
        original,
        target,
        session.deviceSetup.getSnapshot().lastRegisteredNode ?? undefined,
      );
      return;
    }
    // A failed fabric read can recover freshness once; any version/identity change or ABA
    // advances further or changes the bound fields, and still rejects this reread.
    const reviewScope =
      scope && !scope.versionFresh
        ? { ...scope, generation: scope.generation + 1, versionFresh: true }
        : scope;
    if (
      !reviewScope?.versionFresh ||
      !session.tagLifecycle.isCurrent(reviewScope) ||
      !session.drafts.isCurrent()
    ) {
      setAuthSafetyError(copy.tagConfirmationStale);
      return;
    }
    const user = session.snapshot.userById(target.id);
    if (!user || user.name !== target.name) {
      setAuthSafetyError(copy.restoreUserChanged);
      return;
    }
    const matches = original.machineKey
      ? session.snapshot
          .getSnapshot()
          .snapshot.nodes.filter(
            (node) => node.machineKey === original.machineKey,
          )
      : [];
    const current = matches.length === 1 ? matches[0] : undefined;
    if (!current) {
      setAuthResult("observation-conflict");
      setAuthSafetyError(copy.restoreBaselineUnavailable);
      return;
    }
    if (current.tags.length === 0) {
      observePersonalIdentity(original, target);
      if (current.user?.id !== target.id || current.user.name !== target.name)
        setAuthSafetyError(copy.restoreBaselineUnavailable);
      return;
    }
    if (
      current.user?.id !== original.user?.id ||
      current.user?.name !== original.user?.name
    ) {
      setAuthResult("observation-conflict");
      setAuthSafetyError(copy.restoreBaselineUnavailable);
      return;
    }
    setRestoreNode(current);
    setRestoreReviewReady(true);
    setAuthSafetyError(copy.restoreBaselineReread);
  }

  async function registerPendingNode(authId: string) {
    if (!authSafetyReady || !authTargetUser || !authCheckScope || authReading) {
      setAuthSafetyError(
        wrongAuthServer ? copy.restoreWrongServer : copy.restoreSourceRequired,
      );
      return;
    }
    const target = authTargetUser;
    const original = restoreNode;
    const scope = authCheckScope;
    const operation = ++authOperation.current;
    setAuthReading(true);
    const fresh = await session.snapshot.refreshSegments([
      "fabric",
      "identity",
    ]);
    if (!mounted.current || operation !== authOperation.current) return;
    setAuthReading(false);
    if (
      !fresh ||
      !session.tagLifecycle.isCurrent(scope) ||
      !session.drafts.isCurrent()
    ) {
      setAuthSafetyError(
        fresh ? copy.tagConfirmationStale : copy.tagFreshReadRequired,
      );
      setAuthSourceConfirmed(false);
      setAuthCheckScope(null);
      return;
    }
    const user = session.snapshot.userById(target.id);
    if (!user || user.name !== target.name) {
      setAuthSafetyError(copy.restoreUserChanged);
      setAuthSourceConfirmed(false);
      return;
    }
    if (
      original?.machineKey &&
      session.snapshot
        .getSnapshot()
        .snapshot.nodes.filter(
          (node) => node.machineKey === original.machineKey,
        ).length !== 1
    ) {
      setRestoreReviewReady(false);
      setAuthSafetyError(copy.tagDecisionChanged);
      setAuthSourceConfirmed(false);
      setAuthCheckScope(null);
      return;
    }
    const current = original && session.snapshot.nodeById(original.id);
    if (
      original &&
      (!current ||
        !sameNodeTagBaseline(
          nodeTagBaseline(original),
          nodeTagBaseline(current),
        ))
    ) {
      setAuthSafetyError(copy.tagDecisionChanged);
      setAuthSourceConfirmed(false);
      return;
    }
    // Consume locally before dispatch: late failures may already have consumed the server Auth ID.
    restoreAttempt.current = "submitted";
    const draft = { ...authForm.state.values, key: "" };
    authForm.reset(draft, { keepDefaultValues: true });
    setDeviceSetupState({
      pendingRegistrationForm: draft,
      lastRegisteredNode: null,
    });
    setAuthSourceConfirmed(false);
    setAuthCheckScope(null);
    const ownsSession = session.snapshot.captureSession();
    const notification = session.feedback.beginNotification({
      isCurrent: () =>
        mounted.current &&
        operation === authOperation.current &&
        ownsSession() &&
        scope.viewEpoch === session.drafts.getSnapshot().viewEpoch,
    });
    const registered = await quiet.mutateDetailed("register-pending-node", {
      endpoint: "authRegister",
      input: { user: target.name, authId },
    });
    if (
      !mounted.current ||
      operation !== authOperation.current ||
      !ownsSession() ||
      scope.viewEpoch !== session.drafts.getSnapshot().viewEpoch
    )
      return;
    if (!registered.ok) {
      if (!["unknown", "possibly-applied"].includes(registered.outcome.status))
        notification.publishMutation(registered.outcome);
      setAuthResult(null);
      return;
    }
    const node = normalizeHeadscaleNode(registered.result.node);
    setDeviceSetupState({ lastRegisteredNode: node });
    setAuthResult(
      original && !originalDeviceMatch(node, original)
        ? "uncertain"
        : "pending",
    );
    const refreshed = await session.snapshot.refreshSegments([
      "fabric",
      "identity",
    ]);
    if (
      !mounted.current ||
      operation !== authOperation.current ||
      !ownsSession() ||
      scope.viewEpoch !== session.drafts.getSnapshot().viewEpoch
    )
      return;
    if (!refreshed) setAuthResult("refresh-failed");
    else if (original) observePersonalIdentity(original, target, node);
    if (!original) setDeviceSetupState({ step: "result" });
  }

  async function decideAuthRequest(
    decision: "approved" | "rejected",
    authId: string,
  ) {
    const operation = ++authOperation.current;
    const ownsSession = session.snapshot.captureSession();
    const viewEpoch = session.drafts.getSnapshot().viewEpoch;
    const submittedDraft =
      session.deviceSetup.getSnapshot().pendingRegistrationForm;
    const ownsDraft = () =>
      session.deviceSetup.getSnapshot().pendingRegistrationForm ===
      submittedDraft;
    const isCurrent = () =>
      mounted.current &&
      operation === authOperation.current &&
      ownsSession() &&
      viewEpoch === session.drafts.getSnapshot().viewEpoch &&
      ownsDraft();
    const notification = session.feedback.beginNotification({ isCurrent });
    const done =
      decision === "approved"
        ? await quiet.mutateDetailed("approve-auth-request", {
            endpoint: "authApprove",
            input: { authId },
          })
        : await quiet.mutateDetailed("reject-auth-request", {
            endpoint: "authReject",
            input: { authId },
          });
    if (!["unknown", "possibly-applied"].includes(done.outcome.status))
      notification.publishMutation(done.outcome);
    if (done.ok) {
      if (isCurrent()) setDeviceSetupState({ lastAuthDecision: decision });
      // Clear the consumed request even after leaving, but never replace another owner's draft.
      if (ownsDraft()) {
        const draft = { ...submittedDraft, key: "" };
        authForm.reset(draft, { keepDefaultValues: true });
        setDeviceSetupState({ pendingRegistrationForm: draft });
      }
    }
  }

  function openNodeDetails(node: HeadscaleNode) {
    const token = nodeDetailGuard.next();
    setSelectedDetailNode(node);
    void nodeDetailGuard.refresh(token, () =>
      setSelectedDetailNode(currentNode(node.id) ?? null),
    );
  }

  // The dialog has no trigger, so Base UI only ever reports it closing.
  function closeNodeDetails() {
    nodeDetailGuard.cancel();
    setSelectedDetailNode(null);
    const fromPage = intent.from;
    if (fromPage && fromPage !== "devices") {
      const fromUser = fromPage === "members" ? intent.userId : null;
      void navigate({
        to: `/${fromPage}`,
        search: fromUser ? { user: fromUser } : {},
      });
    }
  }

  const consumedNodeQuery = useRef<string | null>(null);
  const seenNodeQuery = useRef<string | null>(null);
  const pendingTagWrite = isActionPending("node-tags");
  function consumeDeviceQuery(nodeId: string | null) {
    if (!nodeId || !nodePopupIntent) {
      consumedNodeQuery.current = null;
      seenNodeQuery.current = null;
      return;
    }
    if (seenNodeQuery.current !== nodePopupIntent) {
      seenNodeQuery.current = nodePopupIntent;
      setTagsConfirmation(null);
      tagsForm.setFieldValue("acknowledged", false);
    }
    if (consumedNodeQuery.current === nodePopupIntent) return;
    const target = snapshot.nodes.find((n) => n.id === nodeId);
    if (!target) return;
    // A new history intent waits for explicit dismissal rather than replacing unsent edits.
    if (
      selectedTagsNode &&
      (!tagsBaseline ||
        !sameTagSet(tagsForm.getFieldValue("tags"), tagsBaseline.node.tags) ||
        !closeTagsDialog())
    )
      return;
    nodeDetailGuard.cancel();
    setSelectedDetailNode(null);
    consumedNodeQuery.current = nodePopupIntent;
    dialogReturnFocus.current = null;
    if (intent.popup === "tags")
      openTagsDialog(
        target,
        migrationFrom !== null && migrationTo !== null
          ? { from: migrationFrom, to: migrationTo }
          : undefined,
      );
    else openNodeDetails(target);
  }

  // Retry only the restricted popup intent, including after a retained editor is dismissed.
  useEffect(
    () => latest.current.consumeDeviceQuery(intent.nodeId),
    [
      nodePopupIntent,
      snapshot.nodes,
      selectedTagsNode,
      tagsValues.tags,
      tagsBaseline,
      pendingTagWrite,
    ],
  );

  function openRenameDialog(node: HeadscaleNode) {
    ++notificationOwner.current;
    clearActionFeedback("rename-node");
    const token = renameDialogGuard.next();
    const draftAtOpen = nodeDisplayName(node);
    setSelectedRenameNode(node);
    renameForm.reset({ name: draftAtOpen }, { keepDefaultValues: true });
    setRenameDialogOpen(true);
    void renameDialogGuard.refresh(token, () => {
      const nextNode = currentNode(node.id);
      if (!nextNode) {
        closeRenameDialog();
        return;
      }
      setSelectedRenameNode(nextNode);
      if (
        !renameForm.state.isDirty &&
        renameForm.getFieldValue("name") === draftAtOpen
      ) {
        renameForm.reset(
          { name: nodeDisplayName(nextNode) },
          { keepDefaultValues: true },
        );
      }
    });
  }

  // The dialog has no trigger, so Base UI only ever reports it closing.
  function closeRenameDialog() {
    if (isActionPending("rename-node")) return;
    setRenameDialogOpen(false);
    ++notificationOwner.current;
    renameDialogGuard.cancel();
    setSelectedRenameNode(null);
    renameForm.reset();
    clearActionFeedback("rename-node");
  }

  function openExpireDialog(
    node: HeadscaleNode,
    action: "expire" | "disable" = "expire",
  ) {
    ++notificationOwner.current;
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
    ++notificationOwner.current;
    expireDialogGuard.cancel();
    setSelectedExpireNode(null);
    setExpireAction("expire");
    clearActionFeedback("expire-node");
  }

  function openRemoveDialog(node: HeadscaleNode) {
    ++notificationOwner.current;
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
    ++notificationOwner.current;
    removeDialogGuard.cancel();
    setSelectedRemoveNode(null);
    clearActionFeedback("remove-node");
  }

  function tagDecision(node: HeadscaleNode): TagDecision | null {
    const scope = session.tagLifecycle.captureScope();
    const policy = session.snapshot.getSnapshot().snapshot.policy;
    return scope && policy && !parsePolicy(policy.policy).error
      ? { scope, node: nodeTagBaseline(node), policy: policy.policy }
      : null;
  }

  function sameTagDecision(left: TagDecision, right: TagDecision) {
    return (
      session.tagLifecycle.isCurrent(left.scope) &&
      sameNodeTagBaseline(left.node, right.node) &&
      left.policy === right.policy
    );
  }

  function changeTags(tags: string[]) {
    ++tagEditVersion.current;
    tagsForm.setFieldValue("tags", tags);
    tagsForm.setFieldValue("acknowledged", false);
    setTagsConfirmation(null);
    setTagsResult(null);
    setTagsNotice("");
  }

  async function readTagDecision(
    nodeId: string,
    explicit = false,
  ): Promise<TagDecision | null> {
    const operation = ++tagOperation.current;
    const scope = session.tagLifecycle.captureScope();
    const ownsSession = session.snapshot.captureSession();
    const notification = explicit
      ? session.feedback.beginNotification({
          isCurrent: () =>
            mounted.current &&
            operation === tagOperation.current &&
            ownsSession() &&
            scope?.viewEpoch === session.drafts.getSnapshot().viewEpoch,
        })
      : null;
    setTagsSyncing(true);
    setTagsReadError("");
    const fresh = await session.snapshot.refreshSegments(["fabric", "policy"]);
    if (!mounted.current || operation !== tagOperation.current) return null;
    setTagsSyncing(false);
    if (
      !ownsSession() ||
      !scope ||
      scope.viewEpoch !== session.drafts.getSnapshot().viewEpoch ||
      !session.drafts.isCurrent()
    ) {
      setTagsReadError(copy.tagConfirmationStale);
      return null;
    }
    const node = session.snapshot.nodeById(nodeId);
    const decision = node && tagDecision(node);
    if (!fresh || !decision) {
      setTagsReadError(copy.tagFreshReadRequired);
      notification?.publish({
        tone: "error",
        title: "product.feedbackRefreshFailed",
      });
      setTagsConfirmation(null);
      return null;
    }
    setSelectedTagsNode(node);
    return decision;
  }

  async function reloadTags(nodeId: string) {
    const next = await readTagDecision(nodeId, true);
    if (!next) return;
    if (tagsBaseline && !sameTagDecision(tagsBaseline, next))
      setTagsNotice(copy.tagDecisionChanged);
    setTagsBaseline(next);
    setTagsConfirmation(null);
    tagsForm.setFieldValue("acknowledged", false);
  }

  function openTagsDialog(
    node: HeadscaleNode,
    replacement?: { from: string; to: string },
  ) {
    clearActionFeedback("node-tags");
    ++tagEditVersion.current;
    setSelectedTagsNode(node);
    setTagSearch("");
    setTagsBaseline(tagDecision(node));
    setTagsConfirmation(null);
    setTagsNotice("");
    setTagsResult(null);
    tagsForm.reset(
      { tags: [...node.tags], acknowledged: false },
      { keepDefaultValues: true },
    );
    const edit = tagEditVersion.current;
    void readTagDecision(node.id).then((next) => {
      if (!next) return;
      setTagsBaseline(next);
      if (edit !== tagEditVersion.current) return;
      if (replacement) {
        const declared = assignableTagsFromPolicy(
          session.snapshot.getSnapshot().snapshot.policy,
        );
        if (
          next.node.tags.includes(replacement.from) &&
          declared.includes(replacement.to)
        )
          tagsForm.setFieldValue(
            "tags",
            replaceTagInSet(next.node.tags, replacement.from, replacement.to),
          );
        else {
          tagsForm.setFieldValue("tags", [...next.node.tags]);
          tagsForm.setFieldValue("acknowledged", false);
          setTagsConfirmation(null);
          setTagsNotice(copy.tagDecisionChanged);
        }
      } else if (!sameTagSet(node.tags, next.node.tags)) {
        setTagsNotice(copy.tagDecisionChanged);
        tagsForm.setFieldValue("tags", [...next.node.tags]);
      }
    });
  }

  async function reviewTags() {
    if (
      !selectedTagsNode ||
      tagsSyncing ||
      isActionPending("node-tags") ||
      stale
    )
      return;
    const edit = tagEditVersion.current;
    const next = await readTagDecision(selectedTagsNode.id);
    if (!next || edit !== tagEditVersion.current) return;
    const changed = tagsBaseline && !sameTagDecision(tagsBaseline, next);
    setTagsBaseline(next);
    if (changed) {
      setTagsNotice(copy.tagDecisionChanged);
      setTagsConfirmation(null);
      tagsForm.setFieldValue("acknowledged", false);
      return;
    }
    const tags = [...new Set(tagsForm.getFieldValue("tags"))];
    if (sameTagSet(next.node.tags, tags)) {
      setTagsNotice(copy.tagNoChange);
      return;
    }
    const candidates = assignableTagsFromPolicy(
      session.snapshot.getSnapshot().snapshot.policy,
    );
    if (!tags.length || tags.some((tag) => !candidates.includes(tag))) {
      setTagsNotice(copy.tagNoOptions);
      return;
    }
    setTagsNotice("");
    setTagsConfirmation({ ...next, tags, editVersion: edit });
  }

  async function applyTags() {
    const confirmation = tagsConfirmation;
    if (
      !confirmation ||
      tagsSyncing ||
      isActionPending("node-tags") ||
      stale ||
      confirmation.editVersion !== tagEditVersion.current ||
      !session.tagLifecycle.isCurrent(confirmation.scope) ||
      (!confirmation.node.tags.length &&
        !tagsForm.getFieldValue("acknowledged"))
    )
      return;
    const next = await readTagDecision(confirmation.node.nodeId);
    if (!next || confirmation.editVersion !== tagEditVersion.current) return;
    if (!sameTagDecision(confirmation, next)) {
      setTagsBaseline(next);
      setTagsConfirmation(null);
      setTagsNotice(copy.tagDecisionChanged);
      tagsForm.setFieldValue("acknowledged", false);
      return;
    }
    const ownsSession = session.snapshot.captureSession();
    const operation = tagOperation.current;
    const notification = session.feedback.beginNotification({
      isCurrent: () =>
        mounted.current &&
        operation === tagOperation.current &&
        confirmation.editVersion === tagEditVersion.current &&
        ownsSession() &&
        confirmation.scope.viewEpoch === session.drafts.getSnapshot().viewEpoch,
    });
    const completed = await quiet.mutateDetailed("node-tags", {
      endpoint: "setTags",
      input: { nodeId: confirmation.node.nodeId, tags: confirmation.tags },
    });
    if (
      !mounted.current ||
      operation !== tagOperation.current ||
      confirmation.editVersion !== tagEditVersion.current ||
      !ownsSession() ||
      confirmation.scope.viewEpoch !== session.drafts.getSnapshot().viewEpoch
    )
      return;
    setTagsConfirmation(null);
    if (!completed.ok) {
      if (!["unknown", "possibly-applied"].includes(completed.outcome.status))
        notification.publishMutation(completed.outcome);
      return;
    }
    const node = normalizeHeadscaleNode(completed.result.node);
    session.snapshot.applyPatch({
      nodes: session.snapshot
        .getSnapshot()
        .snapshot.nodes.map((item) => (item.id === node.id ? node : item)),
    });
    setSelectedTagsNode(node);
    setTagsBaseline(tagDecision(node));
    setTagsResult("confirmed");
    const refreshed = await session.snapshot.refreshSegments([
      "fabric",
      "policy",
    ]);
    if (
      !mounted.current ||
      operation !== tagOperation.current ||
      confirmation.editVersion !== tagEditVersion.current ||
      !ownsSession() ||
      confirmation.scope.viewEpoch !== session.drafts.getSnapshot().viewEpoch
    )
      return;
    if (!refreshed) setTagsResult("refresh-failed");
    else {
      const observed = session.snapshot.nodeById(node.id);
      if (observed) {
        setSelectedTagsNode(observed);
        setTagsBaseline(tagDecision(observed));
      }
    }
  }

  function manageDeviceTags(tag = "") {
    if (
      !selectedTagsNode ||
      !tagsBaseline ||
      tagsSyncing ||
      isActionPending("node-tags")
    )
      return;
    const saved = session.tagLifecycle.saveReturn({
      source: "device",
      nodeId: selectedTagsNode.id,
      tags: [...tagsForm.getFieldValue("tags")],
      baseline: tagsBaseline.node,
      managedTag: tag,
      editVersion: tagEditVersion.current,
      filter: tagSearch,
    });
    if (!saved) return;
    rememberTagDeparture(saved.id);
    closeTagsDialog();
    void navigate({ to: "/access", search: tag ? { tag } : {} });
  }

  function closeTagsDialog() {
    if (isActionPending("node-tags")) return false;
    ++tagOperation.current;
    setTagsSyncing(false);
    setSelectedTagsNode(null);
    setTagsConfirmation(null);
    setTagsBaseline(null);
    tagsForm.reset();
    clearActionFeedback("node-tags");
    return true;
  }

  function dismissTagsDialog() {
    const pendingIntent =
      nodePopupIntent !== null && nodePopupIntent !== consumedNodeQuery.current;
    if (!closeTagsDialog()) return;
    if (!pendingIntent && intent.popup === "tags" && intent.from === "access")
      void navigate({
        to: "/access",
        search:
          typeof searchParams.maintenance === "string"
            ? { maintenance: searchParams.maintenance }
            : {},
      });
  }

  async function confirmExpireNode(node: HeadscaleNode) {
    const notification = beginDeviceNotification();
    const expired = await mutateDetailed("expire-node", {
      endpoint: "expireNode",
      input:
        expireAction === "disable"
          ? { nodeId: node.id, disableExpiry: true }
          : { nodeId: node.id },
    });
    if (!["unknown", "possibly-applied"].includes(expired.outcome.status))
      notification.publishMutation(
        expired.outcome,
        "product.feedbackRequestConfirmed",
      );
    if (expired.ok) closeExpireDialog();
  }

  async function confirmRemoveNode(node: HeadscaleNode) {
    const notification = beginDeviceNotification();
    const removed = await mutateDetailed("remove-node", {
      endpoint: "deleteNode",
      input: { nodeId: node.id },
    });
    if (!["unknown", "possibly-applied"].includes(removed.outcome.status))
      notification.publishMutation(
        removed.outcome,
        "product.feedbackRequestConfirmed",
      );
    if (removed.ok) closeRemoveDialog();
  }

  function renderActionDiagnostic(key: ActionFeedbackKey, id: string) {
    const error = actionError(key);
    const outcome = actionOutcome(key);
    const uncertain =
      outcome && ["unknown", "possibly-applied"].includes(outcome.status);
    if (!error && !uncertain) return null;
    const diagnostic = (
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">
          {copy.details}
        </summary>
        <p className="mt-2 break-words">{error}</p>
      </details>
    );
    return (
      <div key={id} data-testid={id}>
        {uncertain ? (
          <Notice tone="warning" title={copy.feedbackPossiblyApplied}>
            <p>{copy.writeOutcomeVerifyInDevices}</p>
            <Link
              to="/devices"
              className="underline underline-offset-4"
              data-testid={`${key}-verify`}
              onClick={() => {
                if (key === "node-tags") closeTagsDialog();
                else if (key === "rename-node") closeRenameDialog();
                else if (key === "expire-node") closeExpireDialog();
                else if (key === "remove-node") closeRemoveDialog();
                else closeDeviceSetupDialog();
              }}
            >
              {copy.viewMachines}
            </Link>
            {error && diagnostic}
          </Notice>
        ) : (
          diagnostic
        )}
      </div>
    );
  }

  // The routes page finds the machine from `?node=`.
  function jumpToRoutesForMachine(node: HeadscaleNode) {
    void navigate({ to: "/routes", search: { node: node.id } });
  }

  // Each route says its status in words, not only by colour.
  function routeBadge(
    route: string,
    approved: boolean,
    testId?: string,
    className?: string,
  ) {
    const status = approved
      ? copy.routeStatusApproved
      : copy.routeStatusPending;
    return (
      <Badge
        key={route}
        variant="outline"
        className={cn(
          className,
          approved ? approvedRouteClass() : pendingRouteClass(route),
        )}
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
    void navigate({
      to: "/members",
      search: {
        user: userId,
        from: "devices",
        popup: "user",
        returnSearch: new URL(history.location.href, "http://headscale.local")
          .search,
      },
    });
  }

  return (
    <section className="space-y-3 sm:space-y-4">
      {returnReadError && lifecycle.returnTo && (
        <section className="grid gap-2" data-testid="tag-return-read-error">
          <Notice tone="error">
            {returnReadError === "newer-edit"
              ? copy.tagReturnNewerEdit
              : copy.tagReturnReadFailed}
          </Notice>
          <Button
            type="button"
            variant="outline"
            data-testid="tag-return-retry"
            disabled={Boolean(selectedTagsNode) || deviceSetupDialogOpen}
            onClick={() => {
              const record = session.tagLifecycle.getSnapshot().returnTo;
              if (record) {
                rememberReturnEdits(record.id);
                void restoreTagReturn(record);
              }
            }}
          >
            {copy.tagReturnRetry}
          </Button>
          <Button
            type="button"
            variant="ghost"
            data-testid="tag-return-cancel"
            onClick={() => {
              session.tagLifecycle.cancelReturn();
              setReturnReadError(null);
            }}
          >
            {copy.cancel}
          </Button>
        </section>
      )}
      <setupForm.AppForm>
        <Dialog
          open={deviceSetupDialogOpen}
          onOpenChange={requestCloseDeviceSetupDialog}
        >
          <DialogContent
            className="flex flex-col overflow-hidden sm:max-w-[min(56rem,calc(100%-2rem))]"
            data-testid="add-device-dialog"
            initialFocus={() => wizardKeyCardRef.current ?? true}
            finalFocus={returnDialogFocus}
          >
            <DialogHeader>
              <DialogTitle>
                {restoreNode
                  ? copy.tagRestorePersonal
                  : deviceSetupTask
                    ? deviceSetupTitle(deviceSetupTask, copy)
                    : copy.addDevice}
              </DialogTitle>
              <DialogDescription>
                {restoreNode
                  ? copy.restorePersonalLead
                  : deviceSetupTask === "pending"
                    ? copy.pendingRegistrationLead
                    : copy.deviceSetupLead}
              </DialogDescription>
            </DialogHeader>

            {/* Only the steps scroll, so the footer stays reachable in a short window. */}
            <div
              className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 py-1"
              data-testid="add-device-wizard"
            >
              <div className="grid gap-4">
                {deviceSetupTask !== "pending" &&
                  setupExpiration &&
                  Date.parse(setupExpiration) <= Date.now() && (
                    <p
                      data-testid="setup-expiration-expired"
                      className="text-sm text-destructive"
                    >
                      {copy.setupExpiredReturn}
                    </p>
                  )}
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
                            isAddDeviceStepComplete(index)
                              ? "border-primary/40"
                              : "",
                          ],
                        )}
                        disabled={wizardBusy || index >= addDeviceStepIndex}
                        aria-current={
                          addDeviceStep === step.id ? "step" : undefined
                        }
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
                          <span className="truncate text-sm font-medium">
                            {step.label}
                          </span>
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
                    <div
                      className="grid gap-3 sm:grid-cols-3"
                      data-testid="add-device-options"
                    >
                      <Button
                        type="button"
                        variant="outline"
                        className="h-auto w-full items-start justify-start gap-3 whitespace-normal p-4 text-start"
                        data-testid="add-linux-device"
                        onClick={() => prepareDeviceInvite("server")}
                      >
                        <Server
                          className="mt-0.5 h-4 w-4 shrink-0"
                          aria-hidden="true"
                        />
                        <span className="grid min-w-0 gap-1">
                          <span className="font-medium">
                            {copy.linuxServer}
                          </span>
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
                        <Network
                          className="mt-0.5 h-4 w-4 shrink-0"
                          aria-hidden="true"
                        />
                        <span className="grid min-w-0 gap-1">
                          <span className="font-medium">
                            {copy.clientDevice}
                          </span>
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
                        <ShieldCheck
                          className="mt-0.5 h-4 w-4 shrink-0"
                          aria-hidden="true"
                        />
                        <span className="grid min-w-0 gap-1">
                          <span className="font-medium">
                            {copy.pendingRegistrationTitle}
                          </span>
                          <span className="text-xs leading-5 text-muted-foreground">
                            {copy.pendingRegistrationDescription}
                          </span>
                        </span>
                      </Button>
                    </div>
                  ) : deviceSetupTask === "pending" &&
                    addDeviceStep === "pending" ? (
                    <authForm.AppForm>
                      <authForm.Form
                        className="grid gap-4"
                        data-testid="pending-registration-flow"
                      >
                        <div className="grid gap-4">
                          <section className="grid gap-3 rounded-md border bg-background p-4">
                            <div>
                              <h3 className="text-sm font-semibold">
                                {copy.pendingRegistrationTitle}
                              </h3>
                              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                {copy.authRequestHelp}
                              </p>
                            </div>
                            {restoreNode && (
                              <section
                                className="grid gap-3 rounded-md border p-3"
                                data-testid="restore-personal-dialog"
                              >
                                <h3 className="font-medium">
                                  {nodeDisplayName(restoreNode)} ·{" "}
                                  {restoreNode.id}
                                </h3>
                                <dl
                                  data-testid="restore-baseline"
                                  className="grid gap-1 text-sm"
                                >
                                  <dt className="text-muted-foreground">
                                    {copy.owner}
                                  </dt>
                                  <dd>
                                    {restoreNode.user?.name ?? copy.unknown} ·{" "}
                                    {restoreNode.user?.id ?? copy.unknown}
                                  </dd>
                                  <dt className="text-muted-foreground">
                                    {copy.tags}
                                  </dt>
                                  <dd className="break-all">
                                    {restoreNode.tags.join(", ")}
                                  </dd>
                                </dl>
                                <p className="text-sm">
                                  {copy.restoreClientInstructions}
                                </p>
                                <code dir="ltr" className="break-all text-xs">
                                  tailscale up --advertise-tags= --force-reauth
                                </code>
                                <a
                                  href="https://headscale.net/stable/ref/tags/"
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-sm underline"
                                >
                                  {copy.learnMore}
                                </a>
                                <label className="flex items-start gap-2 text-sm">
                                  <input
                                    type="checkbox"
                                    data-testid="restore-backup-confirm"
                                    checked={authBackupConfirmed}
                                    disabled={wizardBusy}
                                    onChange={(event) =>
                                      setAuthBackupConfirmed(
                                        event.target.checked,
                                      )
                                    }
                                  />
                                  {copy.restoreBackup}
                                </label>
                                <p className="text-xs text-muted-foreground">
                                  {copy.restoreNoAutomatic}
                                </p>
                              </section>
                            )}
                            <authForm.AppField name="kind">
                              {(field) => (
                                <field.SelectField
                                  label={copy.authRequestKind}
                                  id="pending-registration-kind"
                                  data-testid="pending-registration-kind"
                                  disabled={wizardBusy || Boolean(restoreNode)}
                                >
                                  <NativeSelectOption value="device">
                                    {copy.authRequestKindDevice}
                                  </NativeSelectOption>
                                  <NativeSelectOption value="ssh">
                                    {copy.authRequestKindSsh}
                                  </NativeSelectOption>
                                </field.SelectField>
                              )}
                            </authForm.AppField>
                            {pendingRegistrationForm.kind === "device" ? (
                              <authForm.AppField name="user">
                                {(field) => (
                                  <field.SelectField
                                    label={copy.restoreTargetUser}
                                    id="pending-registration-user"
                                    data-testid={
                                      restoreNode
                                        ? "restore-user"
                                        : "pending-registration-user"
                                    }
                                    disabled={wizardBusy}
                                  >
                                    <NativeSelectOption value="">
                                      {copy.restoreChooseUser}
                                    </NativeSelectOption>
                                    {authTargetUser && !validAuthTarget && (
                                      <NativeSelectOption
                                        value={authTargetUser.id}
                                        disabled
                                      >
                                        {authTargetUser.name} ·{" "}
                                        {authTargetUser.id}
                                      </NativeSelectOption>
                                    )}
                                    {registrationUserOptions.map((user) => (
                                      <NativeSelectOption
                                        key={user.value}
                                        value={user.value}
                                      >
                                        {user.label}
                                      </NativeSelectOption>
                                    ))}
                                  </field.SelectField>
                                )}
                              </authForm.AppField>
                            ) : (
                              <p className="text-xs leading-5 text-muted-foreground">
                                {copy.sshCheckDescription}
                              </p>
                            )}
                            <authForm.AppField name="key">
                              {(field) => (
                                <div className="grid gap-2">
                                  <field.TextField
                                    label={copy.authRequestLabel}
                                    id="pending-node-key"
                                    data-testid={
                                      restoreNode
                                        ? "restore-auth-id"
                                        : "pending-node-key"
                                    }
                                    readOnly={wizardBusy}
                                    onInput={(event) => {
                                      if (event.currentTarget.value.trim())
                                        beginPersonalRestoreAttempt();
                                    }}
                                    placeholder={AUTH_ID_PLACEHOLDER}
                                    dir="ltr"
                                    className="font-mono"
                                    autoComplete="off"
                                    spellCheck={false}
                                    aria-invalid={Boolean(authRequestHint)}
                                    aria-describedby={
                                      authRequestHint &&
                                      !field.state.meta.errors.length
                                        ? "pending-node-key-hint"
                                        : undefined
                                    }
                                  />
                                  {authRequestHint &&
                                  !field.state.meta.errors.length ? (
                                    <p
                                      id="pending-node-key-hint"
                                      data-testid="pending-node-key-hint"
                                      className="text-xs leading-5 text-destructive"
                                    >
                                      {authRequestHint}
                                    </p>
                                  ) : null}
                                </div>
                              )}
                            </authForm.AppField>
                            {pendingRegistrationForm.kind === "device" ? (
                              <>
                                <div
                                  className="grid gap-3"
                                  data-testid="registration-safety"
                                >
                                  <Label htmlFor="restore-login-server">
                                    {copy.restorePublicServer}
                                  </Label>
                                  <Input
                                    id="restore-login-server"
                                    data-testid="restore-login-server"
                                    value={authPublicServer}
                                    dir="ltr"
                                    readOnly={wizardBusy}
                                    onChange={(event) => {
                                      setAuthPublicServer(event.target.value);
                                      setAuthServerConfirmed(false);
                                      setAuthSourceConfirmed(false);
                                      setAuthCheckScope(null);
                                    }}
                                  />
                                  <label className="flex items-start gap-2 text-sm">
                                    <input
                                      type="checkbox"
                                      data-testid="restore-server-confirm"
                                      checked={authServerConfirmed}
                                      disabled={
                                        wizardBusy || !normalizedPublicServer
                                      }
                                      onChange={(event) => {
                                        setAuthServerConfirmed(
                                          event.target.checked,
                                        );
                                        setAuthSourceConfirmed(false);
                                        setAuthCheckScope(null);
                                      }}
                                    />
                                    {copy.restoreServerConfirm}
                                  </label>
                                  <label className="flex items-start gap-2 text-sm">
                                    <input
                                      type="checkbox"
                                      data-testid="restore-source-confirm"
                                      checked={authSourceConfirmed}
                                      disabled={
                                        wizardBusy ||
                                        !authServerConfirmed ||
                                        !validAuthTarget ||
                                        !parsedAuthRequest ||
                                        wrongAuthServer
                                      }
                                      onChange={(event) => {
                                        setAuthSourceConfirmed(
                                          event.target.checked,
                                        );
                                        setAuthCheckScope(
                                          event.target.checked
                                            ? session.tagLifecycle.captureScope()
                                            : null,
                                        );
                                        setAuthSafetyError("");
                                      }}
                                    />
                                    {copy.restoreSourceConfirm}
                                  </label>
                                  {!authSourceConfirmed && (
                                    <p
                                      data-testid="auth-source-required"
                                      className="text-sm text-muted-foreground"
                                    >
                                      {copy.restoreSourceRequired}
                                    </p>
                                  )}
                                  {wrongAuthServer && (
                                    <p
                                      data-testid="restore-wrong-server"
                                      className="text-sm text-destructive"
                                    >
                                      {copy.restoreWrongServer}
                                    </p>
                                  )}
                                  <p className="text-xs text-muted-foreground">
                                    {copy.restoreNameRace}
                                  </p>
                                  {authSafetyError && (
                                    <div data-testid="restore-safety-error">
                                      <Notice
                                        tone={
                                          authSafetyError ===
                                          copy.restoreBaselineReread
                                            ? "info"
                                            : "error"
                                        }
                                      >
                                        {authSafetyError}
                                      </Notice>
                                    </div>
                                  )}
                                  {authReadError && (
                                    <div data-testid="restore-read-error">
                                      <Notice tone="error">
                                        {authReadError}
                                      </Notice>
                                    </div>
                                  )}
                                  {authTargetUser && (
                                    <p data-testid="restore-target">
                                      {authTargetUser.name} ·{" "}
                                      {authTargetUser.id}
                                    </p>
                                  )}
                                  {authResult && (
                                    <div data-testid="restore-result">
                                      <Notice
                                        tone={
                                          authResult === "identity-observed"
                                            ? "success"
                                            : "warning"
                                        }
                                      >
                                        {authResult === "uncertain"
                                          ? copy.restoreUncertain
                                          : authResult === "identity-observed"
                                            ? copy.restoreIdentityObserved
                                            : authResult === "refresh-failed"
                                              ? copy.restoreRefreshFailed
                                              : authResult ===
                                                  "observation-conflict"
                                                ? copy.tagObservedConflict
                                                : copy.restoreIdentityPending}
                                      </Notice>
                                    </div>
                                  )}
                                  {restoreNode && (
                                    <Button
                                      type="button"
                                      variant="outline"
                                      data-testid="restore-readonly-check"
                                      disabled={wizardBusy}
                                      onClick={() =>
                                        void readPersonalIdentity()
                                      }
                                    >
                                      {restoreAttempt.current === "submitted"
                                        ? copy.tagReadOnlyCheck
                                        : copy.restoreRereadForReview}
                                    </Button>
                                  )}
                                  {restoreNode &&
                                    (authResult || authOutcomeUnknown) && (
                                      <>
                                        <p
                                          data-testid="restore-connectivity"
                                          className="text-sm"
                                        >
                                          {copy.restoreConnectivity}
                                        </p>
                                        <p
                                          data-testid="restore-key-association"
                                          className="text-sm"
                                        >
                                          {authObservedNode &&
                                          !authObservedNode.preAuthKey
                                            ? copy.restoreAssociationCleared
                                            : copy.restoreAssociationPending}
                                        </p>
                                        {restoreNode.preAuthKey?.ephemeral && (
                                          <p
                                            data-testid="restore-ephemeral"
                                            className="text-sm"
                                          >
                                            {copy.restoreEphemeral}
                                          </p>
                                        )}
                                      </>
                                    )}
                                </div>
                                <authForm.SubmitButton
                                  className="w-fit"
                                  data-testid={
                                    restoreNode
                                      ? "restore-personal-confirm"
                                      : "register-pending-node"
                                  }
                                  busy={
                                    isActionPending("register-pending-node") ||
                                    authReading
                                  }
                                  disabled={registerAuthId === ""}
                                >
                                  {!authSubmitting && (
                                    <ShieldCheck
                                      className="h-4 w-4"
                                      aria-hidden="true"
                                    />
                                  )}
                                  {restoreNode
                                    ? copy.restoreApprove
                                    : copy.registerPendingNode}
                                </authForm.SubmitButton>
                                {renderActionDiagnostic(
                                  "register-pending-node",
                                  "register-pending-node-error",
                                )}
                              </>
                            ) : (
                              <>
                                <div className="flex flex-wrap gap-2">
                                  <authForm.SubmitButton
                                    data-testid="approve-ssh-check"
                                    busy={isActionPending(
                                      "approve-auth-request",
                                    )}
                                    disabled={decideAuthId === ""}
                                  >
                                    {copy.approveSshCheck}
                                  </authForm.SubmitButton>
                                  <authForm.SubmitButton
                                    type="button"
                                    variant="outline"
                                    data-testid="reject-ssh-check"
                                    busy={isActionPending(
                                      "reject-auth-request",
                                    )}
                                    disabled={decideAuthId === ""}
                                    onClick={() =>
                                      void submitForm(authForm, "rejected")
                                    }
                                  >
                                    {copy.rejectSshCheck}
                                  </authForm.SubmitButton>
                                </div>
                                {lastAuthDecision ? (
                                  <div data-testid="ssh-check-result">
                                    <Notice tone="success">
                                      {lastAuthDecision === "approved"
                                        ? copy.sshCheckApproved
                                        : copy.sshCheckRejected}
                                    </Notice>
                                  </div>
                                ) : null}
                                {(["approve", "reject"] as const).map(
                                  (action) =>
                                    renderActionDiagnostic(
                                      `${action}-auth-request`,
                                      `${action}-ssh-check-error`,
                                    ),
                                )}
                              </>
                            )}
                          </section>
                        </div>
                      </authForm.Form>
                    </authForm.AppForm>
                  ) : deviceSetupTask === "pending" &&
                    addDeviceStep === "result" ? (
                    <div
                      className="grid gap-2 rounded-md border bg-card p-4"
                      data-testid="registration-result"
                    >
                      {lastRegisteredNode ? (
                        <Notice
                          tone={
                            authResult === "refresh-failed"
                              ? "warning"
                              : "success"
                          }
                        >
                          <p className="font-medium">
                            {copy.registeredNode}:{" "}
                            {nodeDisplayName(lastRegisteredNode)}
                          </p>
                          {authResult === "refresh-failed" && (
                            <p>{copy.restoreRefreshFailed}</p>
                          )}
                        </Notice>
                      ) : null}
                    </div>
                  ) : (
                    <div className="grid gap-4" data-testid="device-setup-flow">
                      {addDeviceStep === "preferences" ? (
                        <setupForm.Form
                          id="device-setup-form"
                          className="grid gap-3"
                          data-testid="setup-device-step"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline">
                              {deviceSetupTask === "server"
                                ? copy.linuxServer
                                : copy.clientDevice}
                            </Badge>
                            <h2 className="text-lg font-semibold">
                              {copy.setupDevice}
                            </h2>
                          </div>
                          <div className="grid gap-4">
                            <div className="grid gap-2">
                              <div className="flex items-start justify-between gap-4">
                                <div>
                                  <h3
                                    id="setup-tags-title"
                                    className="text-sm font-semibold"
                                  >
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
                                  disabled={wizardBusy}
                                  onCheckedChange={(value) =>
                                    setupForm.setFieldValue(
                                      "aclTags",
                                      value ? "tag:server" : "",
                                    )
                                  }
                                />
                              </div>
                              <setupForm.AppField name="aclTags">
                                {(field) => (
                                  <TagField
                                    id="setup-tags"
                                    mode="key"
                                    value={parseNodeTags(field.state.value)}
                                    onChange={(tags) =>
                                      field.handleChange(tags.join(", "))
                                    }
                                    onBlur={field.handleBlur}
                                    options={
                                      definedTags ? [...definedTags] : []
                                    }
                                    declaredTags={
                                      definedTags ? [...definedTags] : null
                                    }
                                    search={setupTagSearch}
                                    onSearchChange={setSetupTagSearch}
                                    disabled={wizardBusy}
                                    aria-describedby="setup-tags-description"
                                    error={
                                      field.state.meta.isTouched
                                        ? field.state.meta.errors
                                            .map(String)
                                            .join(" ")
                                        : undefined
                                    }
                                    onManage={openAccessFromDeviceSetup}
                                    onRetry={() => {
                                      void session.snapshot.refreshSegments([
                                        "policy",
                                      ]);
                                    }}
                                  />
                                )}
                              </setupForm.AppField>
                            </div>
                            <div className="flex items-start justify-between gap-4">
                              <div>
                                <h3
                                  id="setup-ephemeral-title"
                                  className="text-sm font-semibold"
                                >
                                  {copy.ephemeral}
                                </h3>
                                <p
                                  id="setup-ephemeral-description"
                                  className="mt-1 text-xs leading-5 text-muted-foreground"
                                >
                                  {copy.ephemeralDescription}
                                </p>
                              </div>
                              <setupForm.Field name="ephemeral">
                                {(field) => (
                                  <Switch
                                    aria-labelledby="setup-ephemeral-title"
                                    aria-describedby="setup-ephemeral-description"
                                    checked={field.state.value}
                                    onCheckedChange={field.handleChange}
                                    onBlur={field.handleBlur}
                                    disabled={wizardBusy}
                                    data-testid="setup-ephemeral"
                                  />
                                )}
                              </setupForm.Field>
                            </div>
                            <div className="flex items-start justify-between gap-4">
                              <div>
                                <h3
                                  id="setup-exit-title"
                                  className="text-sm font-semibold"
                                >
                                  {copy.exitRoute}
                                </h3>
                                <p
                                  id="setup-exit-description"
                                  className="mt-1 text-xs leading-5 text-muted-foreground"
                                >
                                  {copy.exitNodeDescription}
                                </p>
                              </div>
                              <setupForm.Field name="advertiseExitNode">
                                {(field) => (
                                  <Switch
                                    aria-labelledby="setup-exit-title"
                                    aria-describedby="setup-exit-description"
                                    checked={field.state.value}
                                    onCheckedChange={field.handleChange}
                                    onBlur={field.handleBlur}
                                    disabled={wizardBusy}
                                    data-testid="setup-exit-node"
                                  />
                                )}
                              </setupForm.Field>
                            </div>
                          </div>
                        </setupForm.Form>
                      ) : addDeviceStep === "authKey" ? (
                        <setupForm.Form
                          id="device-setup-form"
                          className="grid gap-3"
                          data-testid="setup-auth-key-step"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline">
                              {deviceSetupTask === "server"
                                ? copy.linuxServer
                                : copy.clientDevice}
                            </Badge>
                            <h2 className="text-lg font-semibold">
                              {copy.setupAuthKey}
                            </h2>
                          </div>
                          <div className="grid gap-4">
                            <div className="grid gap-2">
                              <setupForm.AppField name="user">
                                {(field) => (
                                  <field.SelectField
                                    label={
                                      wizardTags.length
                                        ? copy.inviteCreatorLabel
                                        : copy.inviteOwner
                                    }
                                    id="setup-owner"
                                    data-testid="setup-owner"
                                    disabled={wizardBusy}
                                    aria-describedby={
                                      wizardTags.length
                                        ? "setup-owner-hint"
                                        : undefined
                                    }
                                  >
                                    {draftUsers.map((user) => (
                                      <NativeSelectOption
                                        key={user.id}
                                        value={user.id}
                                      >
                                        {
                                          authKeyDialogUser(user, copy.unknown)
                                            .label
                                        }
                                      </NativeSelectOption>
                                    ))}
                                    <NativeSelectOption value="">
                                      {copy.inviteNoOwner}
                                    </NativeSelectOption>
                                  </field.SelectField>
                                )}
                              </setupForm.AppField>
                              {wizardTags.length > 0 && (
                                <p
                                  id="setup-owner-hint"
                                  data-testid="setup-owner-hint"
                                  className="text-xs text-muted-foreground"
                                >
                                  {copy.taggedKeyCreatorHint}
                                </p>
                              )}
                            </div>
                            <div className="grid gap-2">
                              <div className="flex items-start justify-between gap-4">
                                <div>
                                  <h3
                                    id="setup-reusable-title"
                                    className="text-sm font-semibold"
                                  >
                                    {copy.reusable}
                                  </h3>
                                  <p
                                    id="setup-reusable-description"
                                    className="mt-1 text-xs leading-5 text-muted-foreground"
                                  >
                                    {copy.reusableDescription}
                                  </p>
                                </div>
                                <setupForm.Field name="reusable">
                                  {(field) => (
                                    <Switch
                                      aria-labelledby="setup-reusable-title"
                                      aria-describedby="setup-reusable-description"
                                      checked={field.state.value}
                                      onCheckedChange={field.handleChange}
                                      onBlur={field.handleBlur}
                                      disabled={wizardBusy}
                                      data-testid="setup-reusable"
                                    />
                                  )}
                                </setupForm.Field>
                              </div>
                              <p className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                                {copy.authKeyAutomationHint}
                              </p>
                            </div>
                            <div className="grid gap-2">
                              <Label htmlFor="setup-expiration">
                                {copy.inviteExpiration}
                              </Label>
                              <p className="text-xs leading-5 text-muted-foreground">
                                {copy.authKeyExpirationDescription}
                              </p>
                              <div className="flex flex-wrap items-center gap-2">
                                <div className="inline-flex h-9 items-center overflow-hidden rounded-md border bg-background">
                                  <setupForm.Field name="expiryDays">
                                    {(field) => (
                                      <Input
                                        id="setup-expiration"
                                        name={field.name}
                                        data-testid="setup-expiration"
                                        inputMode="numeric"
                                        className="h-9 w-14 rounded-none border-0 text-center"
                                        aria-describedby="setup-expiration-hint"
                                        value={field.state.value}
                                        readOnly={wizardBusy}
                                        onChange={(event) =>
                                          field.handleChange(event.target.value)
                                        }
                                        onBlur={() => {
                                          commitExpiryDraft();
                                          field.handleBlur();
                                        }}
                                      />
                                    )}
                                  </setupForm.Field>
                                  <button
                                    type="button"
                                    className="h-9 border-s px-3 text-sm disabled:opacity-50"
                                    data-testid="setup-expiration-decrement"
                                    aria-label={copy.decreaseDays}
                                    disabled={
                                      wizardBusy || authKeyExpiryDays <= 1
                                    }
                                    onClick={() =>
                                      setAuthKeyExpiryDays(
                                        commitExpiryDraft().days - 1,
                                      )
                                    }
                                  >
                                    -
                                  </button>
                                  <button
                                    type="button"
                                    className="h-9 border-s px-3 text-sm disabled:opacity-50"
                                    data-testid="setup-expiration-increment"
                                    aria-label={copy.increaseDays}
                                    disabled={
                                      wizardBusy || authKeyExpiryDays >= 90
                                    }
                                    onClick={() =>
                                      setAuthKeyExpiryDays(
                                        commitExpiryDraft().days + 1,
                                      )
                                    }
                                  >
                                    +
                                  </button>
                                </div>
                                <span className="text-sm text-muted-foreground">
                                  {copy.days}
                                </span>
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
                        </setupForm.Form>
                      ) : (
                        <section
                          className="grid gap-3"
                          data-testid="setup-generate-step"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline">
                              {deviceSetupTask === "server"
                                ? copy.linuxServer
                                : copy.clientDevice}
                            </Badge>
                            {wizardTags.length ? (
                              <Badge variant="outline">
                                {wizardTags.join(", ")}
                              </Badge>
                            ) : null}
                            {inviteForm.reusable ? (
                              <Badge variant="outline">{copy.reusable}</Badge>
                            ) : null}
                            {inviteForm.ephemeral ? (
                              <Badge variant="outline">{copy.ephemeral}</Badge>
                            ) : null}
                          </div>
                          <div className="grid gap-3">
                            <setupForm.SubmitButton
                              type="button"
                              className="w-fit"
                              data-testid="generate-install-script"
                              busy={isActionPending("create-invite")}
                              disabled={Boolean(stale)}
                              onClick={() => void submitForm(setupForm)}
                            >
                              {!setupSubmitting && (
                                <KeyRound
                                  className="h-4 w-4"
                                  aria-hidden="true"
                                />
                              )}
                              {copy.generateInstallCommand}
                            </setupForm.SubmitButton>
                            {stale || actionError("create-invite") ? (
                              <p
                                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                                data-testid="setup-generate-error"
                              >
                                {stale
                                  ? copy.tagConfirmationStale
                                  : actionError("create-invite")}
                              </p>
                            ) : null}
                            <CreateKeyOutcomeNotice
                              outcome={actionOutcome("create-invite")}
                            />
                            {lastCreatedInvite ? (
                              <fieldset
                                ref={wizardKeyCardRef}
                                tabIndex={-1}
                                aria-label={copy.authKeyCreated}
                                className="grid min-w-0 gap-3 rounded-md border bg-card p-4"
                                data-testid="created-invite"
                              >
                                <p
                                  data-testid="setup-awaiting-device"
                                  className="text-sm"
                                >
                                  {copy.setupKeyAwaitingDevice}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {copy.keyOneTimeNotice}
                                </p>
                                {actionOutcome("create-invite")?.status ===
                                  "confirmed" && identityInventoryFailed ? (
                                  <p
                                    data-testid="setup-created-refresh-failed"
                                    className="text-sm"
                                  >
                                    {copy.inviteCreateConfirmedRefreshFailed}
                                  </p>
                                ) : null}
                                <Button
                                  type="button"
                                  variant="outline"
                                  data-testid="setup-view-devices"
                                  onClick={finishDeviceSetup}
                                >
                                  {copy.devicesTitle}
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  data-testid="setup-refresh-devices"
                                  onClick={() => void refreshDevices()}
                                >
                                  {copy.refreshData}
                                </Button>
                                <div>
                                  <p className="text-sm font-medium">
                                    {copy.inviteKey}
                                  </p>
                                  <code className="mt-2 block break-all rounded-md bg-secondary px-2 py-1 text-xs">
                                    {lastCreatedInvite}
                                  </code>
                                </div>
                                <loginForm.AppForm>
                                  <loginForm.Form
                                    className="grid gap-2"
                                    data-testid="setup-login-server-form"
                                  >
                                    <loginForm.AppField name="loginServer">
                                      {(field) => (
                                        <>
                                          <field.TextField
                                            label={copy.loginServerUrl}
                                            id="setup-login-server"
                                            data-testid="setup-login-server"
                                            dir="ltr"
                                            className="font-mono"
                                            autoComplete="off"
                                            spellCheck={false}
                                            aria-invalid={!loginServerValid}
                                            aria-describedby={
                                              !field.state.meta.errors.length
                                                ? "setup-login-server-hint"
                                                : undefined
                                            }
                                          />
                                          {!field.state.meta.errors.length && (
                                            <p
                                              id="setup-login-server-hint"
                                              className={cn(
                                                "text-xs leading-5",
                                                loginServerValid
                                                  ? "text-muted-foreground"
                                                  : "text-destructive",
                                              )}
                                              data-testid={
                                                loginServerValid
                                                  ? undefined
                                                  : "setup-login-server-error"
                                              }
                                            >
                                              {loginServerValid
                                                ? copy.loginServerUrlHint
                                                : t("connectionInvalidUrl")}
                                            </p>
                                          )}
                                        </>
                                      )}
                                    </loginForm.AppField>
                                  </loginForm.Form>
                                </loginForm.AppForm>
                                {installCommand ? (
                                  <>
                                    <div>
                                      <p className="text-sm font-medium">
                                        {copy.installCommand}
                                      </p>
                                      <p className="mt-2 text-xs text-muted-foreground">
                                        {copy.connectionCommandHint}{" "}
                                        <a
                                          data-testid="setup-install-docs"
                                          href="https://tailscale.com/kb/1017/install"
                                          target="_blank"
                                          rel="noreferrer"
                                          className="underline underline-offset-4"
                                        >
                                          {copy.learnMore}
                                        </a>
                                      </p>
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
                                {deviceSetupTask === "client" && (
                                  <div
                                    data-testid="setup-mobile-help"
                                    className="grid gap-2 text-xs text-muted-foreground"
                                  >
                                    <p>{copy.mobileSetupHint}</p>
                                    <div className="flex gap-4">
                                      <a
                                        data-testid="setup-android-docs"
                                        href="https://headscale.net/stable/usage/connect/android/"
                                        target="_blank"
                                        rel="noreferrer"
                                        className="underline underline-offset-4"
                                      >
                                        Android
                                      </a>
                                      <a
                                        data-testid="setup-ios-docs"
                                        href="https://headscale.net/stable/usage/connect/apple/#ios"
                                        target="_blank"
                                        rel="noreferrer"
                                        className="underline underline-offset-4"
                                      >
                                        iOS
                                      </a>
                                    </div>
                                  </div>
                                )}
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
                  deviceSetupTask === "pending" ? (
                    <Button
                      type="button"
                      data-testid="add-device-next"
                      disabled={wizardBusy || !lastRegisteredNode}
                      onClick={() => setDeviceSetupState({ step: nextStep.id })}
                    >
                      {copy.nextStep}
                    </Button>
                  ) : (
                    <setupForm.SubmitButton
                      form="device-setup-form"
                      data-testid="add-device-next"
                      disabled={wizardBusy}
                    >
                      {copy.nextStep}
                    </setupForm.SubmitButton>
                  )
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
          </DialogContent>
        </Dialog>
      </setupForm.AppForm>
      <AlertDialog
        open={discardKeyAction !== null}
        onOpenChange={() => setDiscardKeyAction(null)}
      >
        <AlertDialogContent data-testid="discard-key-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.discardKeyTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {copy.discardKeyDescription}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="discard-key-cancel">
              {copy.cancel}
            </AlertDialogCancel>
            <Button
              variant="destructive"
              data-testid="discard-key-confirm"
              onClick={confirmDiscardKey}
            >
              {copy.discardKeyConfirm}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={Boolean(selectedDetailNode)}
        onOpenChange={closeNodeDetails}
      >
        <DialogContent
          className="max-h-[85vh] overflow-y-auto sm:max-w-3xl"
          data-testid="device-detail-dialog"
          finalFocus={returnDialogFocus}
        >
          {selectedDetailNode ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex min-w-0 items-center gap-2">
                  <Network
                    className="h-5 w-5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="truncate">
                    {nodeDisplayName(selectedDetailNode)}
                  </span>
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
                      {registerMethodLabel(
                        selectedDetailNode.registerMethod,
                        copy,
                      )}
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
                        onClick={() =>
                          openUserDetailsExternal(selectedDetailNode.user?.id)
                        }
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
                        {copy.lastSeen}:{" "}
                        {formatDate(selectedDetailNode.lastSeen)}
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
                    {selectedDetailNode.ipAddresses.map(
                      (address, addressIndex) => (
                        <Badge
                          key={address}
                          variant="outline"
                          className="border-slate-200 bg-muted/60 font-mono text-[11px] text-muted-foreground dark:border-slate-800"
                          data-testid={`device-detail-ip-${selectedDetailNode.id}-${addressIndex}`}
                        >
                          <bdi dir="ltr">{address}</bdi>
                        </Badge>
                      ),
                    )}
                  </div>
                </section>

                {selectedDetailNode.tags.length ? (
                  <section className="grid gap-2">
                    <h3 className="text-sm font-semibold">{copy.tags}</h3>
                    <div className="flex flex-wrap gap-1">
                      {selectedDetailNode.tags.map((tag) => (
                        <Badge
                          key={tag}
                          variant="outline"
                          className={deviceTagClass(tag)}
                        >
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
                        {selectedDetailNode.approvedRoutes.map((route) =>
                          routeBadge(route, true),
                        )}
                      </div>
                    </div>
                  ) : null}
                  {selectedDetailNode.availableRoutes.length === 0 &&
                  selectedDetailNode.approvedRoutes.length === 0 ? (
                    <span className="text-sm text-muted-foreground">
                      {copy.noRouteValues}
                    </span>
                  ) : null}
                </section>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={renameDialogOpen}
        onOpenChange={() => {
          if (!renameSubmitting) closeRenameDialog();
        }}
      >
        {selectedRenameNode ? (
          <DialogContent
            data-testid="rename-node-dialog"
            finalFocus={returnDialogFocus}
          >
            <DialogHeader>
              <DialogTitle>{copy.renameMachineTitle}</DialogTitle>
              <DialogDescription>
                {copy.renameMachineDescription}
              </DialogDescription>
            </DialogHeader>
            <renameForm.AppForm>
              <renameForm.Form
                className="grid gap-4"
                data-testid="rename-node-form"
              >
                <renameForm.AppField name="name">
                  {(field) => (
                    <field.TextField
                      label={copy.machineName}
                      id="rename-node-dialog-input"
                      errorId="rename-node-invalid"
                      data-testid="rename-node-dialog-input"
                      readOnly={isActionPending("rename-node")}
                      onKeyDown={(event) => {
                        // 输入法确认候选词的 Enter 不能触发表单提交。
                        if (
                          event.key === "Enter" &&
                          event.nativeEvent.isComposing
                        )
                          event.preventDefault();
                      }}
                    />
                  )}
                </renameForm.AppField>
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    data-testid="rename-node-cancel"
                    disabled={
                      isActionPending("rename-node") || renameSubmitting
                    }
                    onClick={closeRenameDialog}
                  >
                    {copy.cancel}
                  </Button>
                  <renameForm.SubmitButton
                    data-testid="rename-node-confirm"
                    busy={isActionPending("rename-node")}
                    disabled={!canRename}
                  >
                    {copy.saveName}
                  </renameForm.SubmitButton>
                </DialogFooter>
                {renderActionDiagnostic("rename-node", "rename-node-error")}
              </renameForm.Form>
            </renameForm.AppForm>
          </DialogContent>
        ) : null}
      </Dialog>

      <Dialog
        open={Boolean(selectedTagsNode)}
        onOpenChange={() => {
          if (!tagsSubmitting) dismissTagsDialog();
        }}
      >
        {selectedTagsNode ? (
          <DialogContent
            data-testid="node-tags-dialog"
            finalFocus={returnDialogFocus}
          >
            <DialogHeader>
              <DialogTitle>{copy.editNodeTagsTitle}</DialogTitle>
              <DialogDescription>
                {copy.editNodeTagsDescription}
              </DialogDescription>
            </DialogHeader>
            <tagsForm.AppForm>
              <tagsForm.Form
                className="grid gap-4"
                data-testid="node-tags-form"
              >
                <div className="grid gap-2">
                  <tagsForm.AppField name="tags">
                    {(field) => (
                      <>
                        <TagField
                          id="node-tags"
                          mode="device"
                          value={field.state.value}
                          onChange={changeTags}
                          onBlur={field.handleBlur}
                          options={assignableTagsFromPolicy(snapshot.policy)}
                          declaredTags={definedTags ? [...definedTags] : null}
                          search={tagSearch}
                          onSearchChange={setTagSearch}
                          loading={tagsSyncing}
                          disabled={
                            isActionPending("node-tags") || Boolean(stale)
                          }
                          aria-invalid={tagsWouldClear}
                          aria-describedby={
                            tagsWouldClear ? "node-tags-required" : undefined
                          }
                          error={
                            definedTags === null
                              ? copy.tagPolicyUnreadable
                              : undefined
                          }
                          onRetry={() => void reloadTags(selectedTagsNode.id)}
                          onManage={
                            intent.popup === "tags"
                              ? undefined
                              : manageDeviceTags
                          }
                        />
                        {tagsWouldClear ? (
                          <p
                            id="node-tags-required"
                            className="text-xs leading-5 text-destructive"
                            data-testid="node-tags-required"
                          >
                            {copy.tagsRequiredForTaggedNode}
                          </p>
                        ) : null}
                      </>
                    )}
                  </tagsForm.AppField>
                  <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                    {copy.replaceTagsWarning}
                  </p>
                </div>
                {tagsWouldDropOwner ? (
                  <div
                    className="grid gap-2"
                    data-testid="node-tags-owner-warning"
                  >
                    <Notice tone="warning">
                      <bdi>{nodeOwner(selectedTagsNode) || copy.unknown}</bdi> →{" "}
                      <bdi dir="ltr">{nextNodeTags.join(", ")}</bdi>
                      <span className="mt-2 block">
                        {copy.tagIdentityImpact}
                      </span>
                    </Notice>
                    <p
                      className="text-xs text-muted-foreground"
                      data-testid="node-tags-restore-help"
                    >
                      {copy.restorePersonalLead}
                    </p>
                    <a
                      href="https://headscale.net/stable/ref/tags/"
                      target="_blank"
                      rel="noreferrer"
                      className="w-fit text-xs underline"
                      data-testid="node-tags-restore-docs"
                    >
                      {copy.tagRestorePersonal} · {copy.learnMore}
                    </a>
                    <tagsForm.AppField name="acknowledged">
                      {(field) => (
                        <field.CheckboxField
                          label={copy.tagUserNodeAcknowledge}
                          fieldClassName="rounded-md border bg-background p-3 text-sm"
                          id="node-tags-acknowledge"
                          data-testid="node-tags-acknowledge"
                          disabled={tagsSyncing || isActionPending("node-tags")}
                        />
                      )}
                    </tagsForm.AppField>
                  </div>
                ) : null}
                {tagsReadError && (
                  <div data-testid="node-tags-read-error">
                    <Notice tone="error">{tagsReadError}</Notice>
                  </div>
                )}
                {tagsNotice && (
                  <div data-testid="node-tags-notice">
                    <Notice tone="info">{tagsNotice}</Notice>
                  </div>
                )}
                {tagsConfirmation && (
                  <section
                    className="grid gap-2 rounded-md border p-3"
                    data-testid="node-tags-review"
                  >
                    <h3 className="font-medium">{copy.tagCompleteSet}</h3>
                    <p>
                      {nodeDisplayName(selectedTagsNode)} ·{" "}
                      {selectedTagsNode.id}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {tagsConfirmation.tags.map((tag) => (
                        <bdi
                          key={tag}
                          dir="ltr"
                          className="break-all font-mono text-sm"
                        >
                          {tag}
                        </bdi>
                      ))}
                    </div>
                    <div
                      className="text-xs text-muted-foreground"
                      data-testid="node-tags-diff"
                    >
                      <p>
                        +{" "}
                        {tagSetDiff(
                          tagsConfirmation.node.tags,
                          tagsConfirmation.tags,
                        ).added.join(", ")}
                      </p>
                      <p>
                        −{" "}
                        {tagSetDiff(
                          tagsConfirmation.node.tags,
                          tagsConfirmation.tags,
                        ).removed.join(", ")}
                      </p>
                    </div>
                    {tagsWouldDropOwner && (
                      <p className="text-sm">{copy.tagIdentityImpact}</p>
                    )}
                    <Button
                      type="button"
                      data-testid="node-tags-apply"
                      disabled={
                        tagsSyncing ||
                        isActionPending("node-tags") ||
                        (tagsWouldDropOwner && !tagsValues.acknowledged)
                      }
                      onClick={() => void applyTags()}
                    >
                      {copy.tagApply}
                    </Button>
                  </section>
                )}
                {tagsResult && (
                  <div data-testid="node-tags-result">
                    <Notice
                      tone={tagsResult === "confirmed" ? "success" : "warning"}
                    >
                      {tagsResult === "confirmed"
                        ? copy.tagWriteConfirmed
                        : copy.tagRefreshFailed}
                    </Notice>
                  </div>
                )}
                {(tagsOutcomeUnknown || tagsResult) && (
                  <Button
                    type="button"
                    variant="outline"
                    data-testid="node-tags-reread"
                    disabled={tagsSyncing}
                    onClick={() => void reloadTags(selectedTagsNode.id)}
                  >
                    {copy.tagReadOnlyCheck}
                  </Button>
                )}
                {selectedTagsNode.tags.length > 0 && (
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto whitespace-normal"
                    data-testid="node-tags-restore"
                    disabled={tagsSyncing || isActionPending("node-tags")}
                    onClick={() => {
                      const node = selectedTagsNode;
                      closeTagsDialog();
                      openPersonalRestore(node);
                    }}
                  >
                    {copy.tagRestorePersonal}
                  </Button>
                )}
                {renderActionDiagnostic("node-tags", "node-tags-error")}
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    data-testid="node-tags-cancel"
                    disabled={isActionPending("node-tags") || tagsSubmitting}
                    onClick={dismissTagsDialog}
                  >
                    {copy.cancel}
                  </Button>
                  <tagsForm.SubmitButton
                    data-testid="node-tags-confirm"
                    busy={isActionPending("node-tags")}
                    disabled={tagsSyncing || !canSaveTags}
                  >
                    {copy.tagReview}
                  </tagsForm.SubmitButton>
                </DialogFooter>
              </tagsForm.Form>
            </tagsForm.AppForm>
          </DialogContent>
        ) : null}
      </Dialog>

      <AlertDialog
        open={selectedExpireNode !== null}
        onOpenChange={closeExpireDialog}
      >
        {selectedExpireNode ? (
          <AlertDialogContent
            data-testid="expire-node-dialog"
            finalFocus={returnDialogFocus}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>
                {expireAction === "disable"
                  ? copy.disableExpiryTitle
                  : copy.expireMachineTitle}
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
            {renderActionDiagnostic("expire-node", "expire-node-error")}
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
                  <LoaderCircle
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : null}
                {expireAction === "disable"
                  ? copy.disableExpiry
                  : copy.confirmExpire}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>

      <AlertDialog
        open={selectedRemoveNode !== null}
        onOpenChange={closeRemoveDialog}
      >
        {selectedRemoveNode ? (
          <AlertDialogContent
            data-testid="remove-node-dialog"
            finalFocus={returnDialogFocus}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>{copy.removeMachineTitle}</AlertDialogTitle>
              <AlertDialogDescription>
                {copy.removeMachineDescription}
                <span className="mt-2 block font-medium text-foreground">
                  {nodeDisplayName(selectedRemoveNode)}
                </span>
              </AlertDialogDescription>
            </AlertDialogHeader>
            {renderActionDiagnostic("remove-node", "remove-node-error")}
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
                  <LoaderCircle
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
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
              <p className="mt-2 text-sm text-muted-foreground">
                {copy.addFirstDeviceDescription}
              </p>
              <Button
                className="mt-4"
                data-testid="add-first-device"
                onClick={() => {
                  dialogReturnFocus.current = null;
                  if (lastCreatedInvite) openDeviceSetupDialog();
                  else prepareDeviceInvite("client");
                }}
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
                    onChange={(event) =>
                      changeMachineFilter(event.target.value as MachineFilter)
                    }
                    id="machine-filter"
                    data-testid="machine-filter"
                    className="[&_select]:ps-8"
                  >
                    <NativeSelectOption value="all">
                      {copy.allMachines}
                    </NativeSelectOption>
                    <NativeSelectOption value="online">
                      {copy.onlineOnly}
                    </NativeSelectOption>
                    <NativeSelectOption value="offline">
                      {copy.offlineOnly}
                    </NativeSelectOption>
                    <NativeSelectOption value="expired">
                      {copy.expiredOnly}
                    </NativeSelectOption>
                    <NativeSelectOption value="routes">
                      {copy.routeAdvertisers}
                    </NativeSelectOption>
                    <NativeSelectOption value="tagged">
                      {copy.taggedOnly}
                    </NativeSelectOption>
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
                      {ownerFilterUser
                        ? userLabel(ownerFilterUser)
                        : ownerFilter}
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
              <div className="flex items-center gap-2 sm:ms-auto">
                <p
                  className="me-auto whitespace-nowrap text-xs text-muted-foreground"
                  data-testid="machine-count"
                >
                  {filteredNodes.length} / {snapshot.nodes.length}
                </p>
                <Tooltip content={copy.refreshData}>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    data-testid="refresh-machines"
                    aria-label={copy.refreshData}
                    disabled={isRefreshingSnapshot}
                    onClick={refreshDevices}
                  >
                    {isRefreshingSnapshot ? (
                      <LoaderCircle
                        className="h-4 w-4 animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <RefreshCw className="h-4 w-4" aria-hidden="true" />
                    )}
                  </Button>
                </Tooltip>
                <Tooltip content={copy.exportData}>
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
                </Tooltip>
              </div>
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
            <Card
              className="w-full max-w-full min-w-0 overflow-x-auto"
              data-testid="machine-list"
            >
              <Table aria-label={copy.devicesTitle}>
                <TableHeader>
                  <TableRow>
                    <TableHead>{copy.devicesTableMachine}</TableHead>
                    <TableHead>{copy.devicesTableUser}</TableHead>
                    <TableHead>{copy.devicesTableRoutes}</TableHead>
                    <TableHead>{copy.devicesTableActivity}</TableHead>
                    <TableHead className="hidden lg:table-cell">
                      {copy.actions}
                    </TableHead>
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
                            onClick={() => {
                              dialogReturnFocus.current = null;
                              openNodeDetails(node);
                            }}
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
                          <DropdownMenu onOpenChange={rememberActionTrigger}>
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
                              <EllipsisVertical
                                className="h-4 w-4"
                                aria-hidden="true"
                              />
                            </DropdownMenuTrigger>
                            {/* Beside the trigger the menu can use the full window height. */}
                            <DropdownMenuContent
                              side="inline-end"
                              align="center"
                              className="w-64"
                              data-testid={`machine-actions-menu-mobile-${node.id}`}
                            >
                              <DropdownMenuGroup>
                                <DropdownMenuLabel>
                                  {copy.actions}
                                </DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  data-testid={`view-node-details-action-mobile-${node.id}`}
                                  onClick={() => openNodeDetails(node)}
                                >
                                  <FileCheck2
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                  />
                                  {copy.viewDetails}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  data-testid={`view-node-routes-action-mobile-${node.id}`}
                                  onClick={() => jumpToRoutesForMachine(node)}
                                >
                                  <Router
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                  />
                                  {copy.viewRoutes}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  data-testid={`rename-node-action-mobile-${node.id}`}
                                  onClick={() => openRenameDialog(node)}
                                >
                                  <Pencil
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                  />
                                  {copy.rename}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  data-testid={`edit-node-tags-action-mobile-${node.id}`}
                                  onClick={() => openTagsDialog(node)}
                                >
                                  <ShieldCheck
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                  />
                                  {copy.editTags}
                                </DropdownMenuItem>
                                {node.tags.length > 0 && (
                                  <DropdownMenuItem
                                    data-testid={`restore-personal-action-mobile-${node.id}`}
                                    onClick={() => openPersonalRestore(node)}
                                  >
                                    <ShieldCheck
                                      className="h-4 w-4"
                                      aria-hidden="true"
                                    />
                                    {copy.tagRestorePersonal}
                                  </DropdownMenuItem>
                                )}
                                {node.expiry ? (
                                  <DropdownMenuItem
                                    data-testid={`disable-expiry-node-action-mobile-${node.id}`}
                                    onClick={() =>
                                      openExpireDialog(node, "disable")
                                    }
                                  >
                                    <InfinityIcon
                                      className="h-4 w-4"
                                      aria-hidden="true"
                                    />
                                    {copy.disableExpiry}
                                  </DropdownMenuItem>
                                ) : null}
                                {isTimestampExpired(node.expiry) ? null : (
                                  <DropdownMenuItem
                                    data-testid={`expire-node-action-mobile-${node.id}`}
                                    onClick={() => openExpireDialog(node)}
                                  >
                                    <Clock
                                      className="h-4 w-4"
                                      aria-hidden="true"
                                    />
                                    {copy.expire}
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuItem
                                  variant="destructive"
                                  data-testid={`remove-node-action-mobile-${node.id}`}
                                  onClick={() => openRemoveDialog(node)}
                                >
                                  <Trash2
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                  />
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
                              onClick={() =>
                                openUserDetailsExternal(node.user?.id)
                              }
                            >
                              <bdi dir="auto">{nodeOwner(node)}</bdi>
                            </button>
                            <p className="text-xs text-muted-foreground">
                              <bdi dir="auto">
                                {nodeUser(node)?.email || nodeUser(node)?.name}
                              </bdi>
                            </p>
                          </div>
                        ) : (
                          <span
                            aria-hidden="true"
                            className="text-muted-foreground"
                          >
                            -
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-normal align-top lg:min-w-56 lg:whitespace-nowrap">
                        {nodePendingRoutes(node).length ? (
                          <Tooltip content={copy.viewRoutes}>
                            <button
                              type="button"
                              className="flex flex-wrap gap-1 rounded-md text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              data-testid={`device-pending-routes-${node.id}`}
                              onClick={() => jumpToRoutesForMachine(node)}
                            >
                              {nodePendingRoutes(node).map(
                                (route, routeIndex) =>
                                  routeBadge(
                                    route,
                                    false,
                                    `device-pending-route-${node.id}-${routeIndex}`,
                                    "cursor-pointer hover:opacity-90",
                                  ),
                              )}
                            </button>
                          </Tooltip>
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
                          <DropdownMenu onOpenChange={rememberActionTrigger}>
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
                              <EllipsisVertical
                                className="h-4 w-4"
                                aria-hidden="true"
                              />
                            </DropdownMenuTrigger>
                            {/* Beside the trigger the menu can use the full window height. */}
                            <DropdownMenuContent
                              side="inline-start"
                              align="center"
                              className="w-64"
                              data-testid={`machine-actions-menu-${node.id}`}
                            >
                              <DropdownMenuGroup>
                                <DropdownMenuLabel>
                                  {copy.actions}
                                </DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  data-testid={`view-node-details-action-${node.id}`}
                                  onClick={() => openNodeDetails(node)}
                                >
                                  <FileCheck2
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                  />
                                  {copy.viewDetails}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  data-testid={`view-node-routes-action-${node.id}`}
                                  onClick={() => jumpToRoutesForMachine(node)}
                                >
                                  <Router
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                  />
                                  {copy.viewRoutes}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  data-testid={`rename-node-action-${node.id}`}
                                  onClick={() => openRenameDialog(node)}
                                >
                                  <Pencil
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                  />
                                  {copy.rename}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  data-testid={`edit-node-tags-action-${node.id}`}
                                  onClick={() => openTagsDialog(node)}
                                >
                                  <ShieldCheck
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                  />
                                  {copy.editTags}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                {node.tags.length > 0 && (
                                  <DropdownMenuItem
                                    data-testid={`restore-personal-action-${node.id}`}
                                    onClick={() => openPersonalRestore(node)}
                                  >
                                    <ShieldCheck
                                      className="h-4 w-4"
                                      aria-hidden="true"
                                    />
                                    {copy.tagRestorePersonal}
                                  </DropdownMenuItem>
                                )}
                                {node.expiry ? (
                                  <DropdownMenuItem
                                    data-testid={`disable-expiry-node-action-${node.id}`}
                                    onClick={() =>
                                      openExpireDialog(node, "disable")
                                    }
                                  >
                                    <InfinityIcon
                                      className="h-4 w-4"
                                      aria-hidden="true"
                                    />
                                    {copy.disableExpiry}
                                  </DropdownMenuItem>
                                ) : null}
                                {isTimestampExpired(node.expiry) ? null : (
                                  <DropdownMenuItem
                                    data-testid={`expire-node-action-${node.id}`}
                                    onClick={() => openExpireDialog(node)}
                                  >
                                    <Clock
                                      className="h-4 w-4"
                                      aria-hidden="true"
                                    />
                                    {copy.expire}
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuItem
                                  variant="destructive"
                                  data-testid={`remove-node-action-${node.id}`}
                                  onClick={() => openRemoveDialog(node)}
                                >
                                  <Trash2
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                  />
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
                      <TableCell
                        colSpan={5}
                        className="py-6 text-sm text-muted-foreground"
                      >
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
