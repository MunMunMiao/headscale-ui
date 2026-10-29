import { useStore as useFormStore } from "@tanstack/react-form";
import { useNavigate } from "@tanstack/react-router";
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
  Trash2,
  Users,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { HeadscaleNode, HeadscaleUser } from "@/api/contracts";
import AssignMemberDialog, {
  type AssignMemberOption,
} from "@/components/AssignMemberDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/app/dialog";
import { useAppForm } from "@/components/app/form";
import CreateAuthKeyDialog, {
  CreateKeyOutcomeNotice,
} from "@/components/CreateAuthKeyDialog";
import {
  type AuthKeyDialogDefaults,
  type AuthKeyDialogDraft,
  type AuthKeyDialogPayload,
  authKeyDialogLabels,
  authKeyDialogUser,
  toAuthKeyDefaults,
} from "@/components/create-auth-key-dialog";
import AccessPolicyReview from "@/components/policy/AccessPolicyReview";
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
import {
  useCreatePreAuthKey,
  useInviteTagReturn,
} from "@/composables/useCreatePreAuthKey";
import { useDisplayHelpers } from "@/composables/useDisplayHelpers";
import { useMutation } from "@/composables/useMutation";
import {
  policyBlockedMessage,
  usePolicyDesigner,
} from "@/composables/usePolicyDesigner";
import { usePolicySave } from "@/composables/usePolicySave";
import { useProductCopy } from "@/composables/useProductCopy";
import { useRefreshGuard } from "@/composables/useRefreshGuard";
import { useRouteIntent } from "@/composables/useRouteIntent";
import { useSessionDraft } from "@/composables/useSessionDraft";
import { useSnapshot } from "@/composables/useSnapshot";
import { useSegment } from "@/composables/useSnapshotSegment";
import {
  addMemberToGroup,
  addOwnerToTag,
  type PolicyDesignerState,
  removeMemberFromGroup,
  removeOwnerFromTag,
  serializePolicy,
  toMemberRef,
} from "@/domain/policy-designer";
import { retargetUserReferences } from "@/domain/policy-references";
import {
  policyPrincipalForUser,
  PrincipalIndex,
  userCreationPrincipalConflict,
  userMatchesPolicyValue,
  userNamePrincipal,
  userPolicyPrincipals,
} from "@/domain/principal";
import { observeTags, registrationKeyStatus } from "@/domain/tag-lifecycle";
import { useHeadscaleI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { downloadCsv } from "@/utils/csv";
import { nodePendingRoutes } from "@/utils/node";
import { nodeStatusClass } from "@/utils/status-class";
import { isEmailLike, type UserNameIssue, userNameIssue } from "@/utils/user";

const EMPTY_MEMBER_FORM = { name: "", displayName: "", email: "" };
type MemberPolicyKind = "groups" | "tags" | "rename" | "delete" | "reference";

// Keep the dialog's promise to use the new name, but never give its references to another user.
function renamePolicyPrincipal(
  user: HeadscaleUser,
  users: readonly HeadscaleUser[],
  proposedName?: string,
): string {
  const current = users.find((candidate) => candidate.id === user.id);
  if (!current) return "";
  const target =
    proposedName === undefined ? current : { ...current, name: proposedName };
  const principal = userNamePrincipal(proposedName ?? user.name);
  return userMatchesPolicyValue(target, principal, users) ? principal : "";
}

interface UserPolicyReference {
  kind: "group" | "tagOwner";
  id: string;
  label: string;
  matchedValues: string[];
}

/** What a user delete or rename would change in the policy, derived from a clean draft. */
function userReferenceImpact(
  state: PolicyDesignerState,
  principals: string[],
  blocked: string | null,
  unsupportedLabel: string,
  references: UserPolicyReference[],
) {
  const plan =
    principals.length && !blocked
      ? retargetUserReferences(state, principals, null)
      : null;
  // Groups and tag owners are listed as labelled rows already.
  const sections = plan?.ok
    ? plan.sections.filter(
        (section) => section !== "groups" && section !== "tagOwners",
      )
    : [];
  const unsupported =
    plan && !plan.ok && plan.mentioned
      ? `${unsupportedLabel} ${plan.issue.paths.join(", ")}`
      : "";
  return {
    sections,
    blockedText: blocked ?? unsupported,
    hasReferences:
      references.length > 0 || sections.length > 0 || Boolean(unsupported),
  };
}

function ReferenceImpact({
  heading,
  blockedText,
  references,
  sections,
  sectionTestId,
}: {
  heading: string;
  blockedText: string;
  references: UserPolicyReference[];
  sections: string[];
  sectionTestId: string;
}) {
  return (
    <>
      <p className="text-sm font-medium">{heading}</p>
      {blockedText && <p className="text-sm text-destructive">{blockedText}</p>}
      <ul className="grid gap-1">
        {references.map((reference) => (
          <li
            key={`${reference.kind}-${reference.id}`}
            className="rounded-md border bg-background px-3 py-2 text-sm break-all"
          >
            {reference.label}
          </li>
        ))}
        {sections.map((section) => (
          <li
            key={section}
            data-testid={sectionTestId}
            dir="ltr"
            className="rounded-md border bg-background px-3 py-2 font-mono text-sm break-all"
          >
            {section}
          </li>
        ))}
      </ul>
    </>
  );
}

export default function MembersPage() {
  const session = useSession();
  const { policy: policyStore, snapshot: snapshotStore, drafts } = session;
  const { stale } = useStore(drafts);
  const { copy } = useProductCopy();
  const { t } = useHeadscaleI18n();
  const {
    snapshot,
    refreshSnapshot,
    userById: currentUser,
    isReady,
    refreshErrors,
    segmentStatus,
  } = useSnapshot();
  const { isRefreshing: isRefreshingSnapshot, refresh: refreshMembers } =
    useSegment("identity");
  const { isActionPending, actionError, actionOutcome, clearActionFeedback } =
    useActionFeedback();
  const {
    setState: setPolicyState,
    policyGroups,
    policyTagOwners,
    policyDesignerState,
    policyError,
    isPolicyDirty,
    assignMembershipsOpen,
    assignTagOwnershipsOpen,
  } = usePolicyDesigner();
  // A targeted policy write serialises the whole shared draft, so unsaved Access edits block it.
  const policyBlocked: string | null = policyError
    ? policyBlockedMessage(copy, policyError)
    : isPolicyDirty
      ? copy.policyUnsavedBlocked
      : null;

  useEffect(
    () => () => {
      setPolicyState({ assignMembershipsOpen: false });
      setPolicyState({ assignTagOwnershipsOpen: false });
    },
    [setPolicyState],
  );

  const navigate = useNavigate();
  const intent = useRouteIntent();

  const [userSearch, setUserSearch] = useState("");
  const [memberDialogOpen, setMemberDialogOpen] = useState(false);
  const [memberPreflightError, setMemberPreflightError] = useState("");
  const memberCreateGeneration = useRef(0);
  const [selectedRenameUser, setSelectedRenameUser] =
    useState<HeadscaleUser | null>(null);
  const [pendingDeleteUser, setPendingDeleteUser] =
    useState<HeadscaleUser | null>(null);
  const [selectedDetailUser, setSelectedDetailUser] =
    useState<HeadscaleUser | null>(null);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [restoredInvite, setRestoredInvite] =
    useState<AuthKeyDialogDraft | null>(null);
  const inviteContext = useRef(0);
  const inviteMemberId = useRef("");
  useEffect(
    () => () => {
      ++memberCreateGeneration.current;
      ++inviteContext.current;
    },
    [],
  );
  const [assignMembershipsTarget, setAssignMembershipsTarget] =
    useState<HeadscaleUser | null>(null);
  const [assignTagOwnershipsTarget, setAssignTagOwnershipsTarget] =
    useState<HeadscaleUser | null>(null);
  const membershipContext = useRef({ targetId: "", generation: 0 });
  const ownershipContext = useRef({ targetId: "", generation: 0 });
  const memberPolicyContext = useRef({ targetId: "", generation: 0 });
  function publicationContext(kind: MemberPolicyKind) {
    return kind === "groups"
      ? membershipContext.current
      : kind === "tags"
        ? ownershipContext.current
        : memberPolicyContext.current;
  }
  const [policySaveNotice, setPolicySaveNotice] = useState<
    "newer" | "context" | null
  >(null);
  const { scope: lifecycleScope } = useStore(session.tagLifecycle);
  const policyOutcomeUnknown = (
    ["save-policy", "assign-user-groups", "assign-user-tags"] as const
  ).some((key) =>
    ["unknown", "possibly-applied"].includes(actionOutcome(key)?.status ?? ""),
  );
  const [memberPublication, setMemberPublication] = useState<{
    kind: MemberPolicyKind;
    state: PolicyDesignerState;
    original: string;
    submitted: string;
    revision: number;
    context: { targetId: string; generation: number };
    userName: string;
    principals: string[];
    scope: typeof lifecycleScope;
  } | null>(null);
  // Scope notifications invalidate a review even when its local policy revision did not change.
  useEffect(() => {
    if (
      memberPublication &&
      !session.tagLifecycle.isCurrent(memberPublication.scope)
    ) {
      setMemberPublication(null);
      setPolicySaveNotice("context");
    }
  }, [memberPublication, lifecycleScope, session]);
  useEffect(
    () => () => {
      ++membershipContext.current.generation;
      ++ownershipContext.current.generation;
      ++memberPolicyContext.current.generation;
    },
    [],
  );

  const memberForm = useAppForm({
    defaultValues: EMPTY_MEMBER_FORM,
    onSubmit: ({ value }) => createMember(value),
  });
  const memberSubmitting = useFormStore(
    memberForm.store,
    (state) => state.isSubmitting,
  );
  const renameMemberForm = useAppForm({
    defaultValues: { name: "", updateReferences: true },
    onSubmit: ({ value }) => confirmRenameMember(value),
  });
  const renameValues = useFormStore(
    renameMemberForm.store,
    (state) => state.values,
  );
  const renameSubmitting = useFormStore(
    renameMemberForm.store,
    (state) => state.isSubmitting,
  );
  const updateReferencesOnRename = renameValues.updateReferences;
  const deleteMemberForm = useAppForm({
    defaultValues: { cleanup: true },
    onSubmit: ({ value }) => confirmDeleteMember(value.cleanup),
  });
  const cleanupPolicyOnDelete = useFormStore(
    deleteMemberForm.store,
    (state) => state.values.cleanup,
  );
  const deleteSubmitting = useFormStore(
    deleteMemberForm.store,
    (state) => state.isSubmitting,
  );
  // Retain the actual response identity; set means only the policy update is left.
  const [renamedUser, setRenamedUser] = useState<HeadscaleUser | null>(null);
  const [deletedUserId, setDeletedUserId] = useState<string | null>(null);
  // Keyed, so a reloaded policy (new ids) drops the confirmation instead of saving a no-op.
  const [pendingReferenceKey, setPendingReferenceKey] = useState<string | null>(
    null,
  );
  const detailDialogRef = useRef<HTMLDivElement>(null);
  const [inviteForm, setInviteForm] = useState<AuthKeyDialogDefaults>({
    user: "1",
    reusable: false,
    ephemeral: false,
    aclTags: "",
  });
  useSessionDraft(
    memberDialogOpen ||
      selectedRenameUser !== null ||
      pendingDeleteUser !== null ||
      inviteDialogOpen ||
      assignMembershipsOpen ||
      assignTagOwnershipsOpen,
  );

  const userDetailGuard = useRefreshGuard();
  const inviteDialogGuard = useRefreshGuard("identity");
  const inviteReturn = useInviteTagReturn(
    "member-invite",
    (record) => {
      const form = record.form;
      ++inviteContext.current;
      inviteMemberId.current = record.memberId ?? form.userId;
      setInviteForm(
        toAuthKeyDefaults({
          user: form.userId,
          reusable: form.reusable,
          ephemeral: form.ephemeral,
          expiration: form.expiration,
          aclTags: form.tags,
        }),
      );
      setRestoredInvite(form);
      setUserSearch(record.filter ?? "");
      setInviteDialogOpen(true);
    },
    inviteContext,
  );
  const tagInventory = observeTags({
    policy: snapshot.policy,
    nodes: snapshot.nodes,
    preAuthKeys: snapshot.preAuthKeys,
    readState: segmentStatus,
  });
  const declaredTags = tagInventory.unknownSources.includes("policy")
    ? null
    : tagInventory.tags
        .filter((tag) => tag.definition === "declared")
        .map((tag) => tag.tag);

  const isCreatingInvite = isActionPending("create-invite");

  const {
    formatDate,
    userLabel,
    nodeDisplayName,
    nodeStatusLabel,
    shortSecret,
    hasVisibleUser,
  } = useDisplayHelpers();

  function userAuthSource(user: HeadscaleUser) {
    return user.provider || user.providerId || "-";
  }

  const visibleUsers = snapshot.users.filter((user) => hasVisibleUser(user));

  // ponytail: unwindowed, unpaginated tables; fine to a few thousand rows, add windowing beyond that.
  const devicesByUser = new Map<string, HeadscaleNode[]>();
  for (const node of snapshot.nodes) {
    if (!hasVisibleUser(node.user)) continue;
    const devices = devicesByUser.get(node.user.id);
    if (devices) devices.push(node);
    else devicesByUser.set(node.user.id, [node]);
  }

  function userDevices(user: HeadscaleUser) {
    return devicesByUser.get(user.id) ?? [];
  }

  function activeAuthKeysForUser(user: HeadscaleUser) {
    return snapshot.preAuthKeys.filter(
      (key) =>
        key.user?.id === user.id &&
        registrationKeyStatus(key).registration === "available",
    );
  }

  function userPolicyReferences(principals: string[]): UserPolicyReference[] {
    const groupReferences: UserPolicyReference[] = policyGroups
      .map((group) => {
        const matched = group.members
          .filter((member) => principals.includes(member.value))
          .map((member) => member.value);
        return matched.length > 0
          ? {
              kind: "group" as const,
              id: group.id,
              label: `${copy.groups}: ${group.name}`,
              matchedValues: matched,
            }
          : null;
      })
      .filter((ref) => ref !== null);
    const tagOwnerReferences: UserPolicyReference[] = policyTagOwners
      .map((tagOwner) => {
        const matched = tagOwner.owners
          .filter((owner) => principals.includes(owner.value))
          .map((owner) => owner.value);
        return matched.length > 0
          ? {
              kind: "tagOwner" as const,
              id: tagOwner.id,
              label: `${copy.tagOwners}: ${tagOwner.tag}`,
              matchedValues: matched,
            }
          : null;
      })
      .filter((ref) => ref !== null);

    return [...groupReferences, ...tagOwnerReferences];
  }

  const query = userSearch.trim().toLowerCase();
  const filteredUsers = visibleUsers.filter((user) => {
    if (!query) return true;
    return [
      user.name,
      user.displayName,
      userLabel(user),
      user.email,
      user.provider,
      user.providerId,
      userAuthSource(user),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(query);
  });

  const selectedUserDevices = selectedDetailUser
    ? userDevices(selectedDetailUser)
    : [];
  const selectedUserActiveKeys = selectedDetailUser
    ? activeAuthKeysForUser(selectedDetailUser)
    : [];
  const selectedUserPolicyReferences = selectedDetailUser
    ? userPolicyReferences(
        userPolicyPrincipals(selectedDetailUser, snapshot.users),
      )
    : [];
  const pendingReference = selectedUserPolicyReferences.find(
    (reference) => `${reference.kind}-${reference.id}` === pendingReferenceKey,
  );

  const deletePrincipals = pendingDeleteUser
    ? userPolicyPrincipals(pendingDeleteUser, snapshot.users)
    : [];
  // Headscale refuses to delete a user who still owns machines; its auth keys do not block it.
  const deleteDevices = pendingDeleteUser ? userDevices(pendingDeleteUser) : [];
  const deleteActiveKeys = pendingDeleteUser
    ? activeAuthKeysForUser(pendingDeleteUser)
    : [];
  const deleteReferences = userPolicyReferences(deletePrincipals);
  const deleteImpact = userReferenceImpact(
    policyDesignerState,
    deletePrincipals,
    policyBlocked,
    copy.policyReferenceUnsupported,
    deleteReferences,
  );
  // A confirmed delete survives a failed directory refresh until this dialog is dismissed.
  const userDeleted =
    pendingDeleteUser !== null &&
    (deletedUserId === pendingDeleteUser.id ||
      !snapshot.users.some((user) => user.id === pendingDeleteUser.id));
  const cleanupPending =
    userDeleted &&
    cleanupPolicyOnDelete &&
    deleteImpact.hasReferences &&
    !isActionPending("delete-member") &&
    !isActionPending("save-policy");

  // Rewrite every spelling that resolves through this name, but retain stable email/provider aliases.
  const renameFrom = selectedRenameUser
    ? userNamePrincipal(selectedRenameUser.name)
    : "";
  const renamePrincipals = selectedRenameUser
    ? userPolicyPrincipals(selectedRenameUser, snapshot.users).filter(
        (value) => {
          const identity = value.replace(/@$/, "");
          return (
            value.includes("@") &&
            identity === selectedRenameUser.name.trim() &&
            identity !== selectedRenameUser.email?.trim() &&
            identity !== selectedRenameUser.providerId?.trim()
          );
        },
      )
    : [];
  const renameReferences = userPolicyReferences(renamePrincipals);
  const renameImpact = userReferenceImpact(
    policyDesignerState,
    renamePrincipals,
    policyBlocked,
    copy.policyReferenceUnsupported,
    renameReferences,
  );
  const renamePending =
    isActionPending("rename-member") || isActionPending("save-policy");
  // The server rename landed but the reference update did not: only the policy write is left.
  const renamePartial =
    renamedUser !== null &&
    renameImpact.hasReferences &&
    updateReferencesOnRename &&
    !renamePending;
  const renameName = renameValues.name.trim();
  const renameUnchanged = renameName === selectedRenameUser?.name;
  const renameUpdatesPolicy =
    updateReferencesOnRename &&
    renameImpact.hasReferences &&
    !renameImpact.blockedText;
  const renameTarget = renamedUser ?? selectedRenameUser;
  const renameTargetBlocked =
    renameUpdatesPolicy &&
    renameTarget !== null &&
    (renameTarget.id !== selectedRenameUser?.id ||
      !renamePolicyPrincipal(
        renameTarget,
        snapshot.users,
        renamedUser ? undefined : renameName,
      ));
  const renameConfirmDisabled =
    renamePending ||
    (renamedUser === null
      ? renameUnchanged
      : renamePartial && Boolean(renameImpact.blockedText));

  const userNameIssueText: Record<UserNameIssue, string> = {
    required: copy.userNameRequired,
    invalid: copy.userNameInvalid,
    taken: copy.userNameTaken,
  };

  const selectedUserPendingRoutesCount = selectedUserDevices.reduce(
    (total, node) => total + nodePendingRoutes(node).length,
    0,
  );

  const membershipPrincipals = assignMembershipsTarget
    ? userPolicyPrincipals(assignMembershipsTarget, snapshot.users)
    : [];
  const assignMembershipsOptions: AssignMemberOption[] = assignMembershipsTarget
    ? policyGroups.map((group) => ({
        id: group.id,
        name: group.name,
        assigned: group.members.some((member) =>
          membershipPrincipals.includes(member.value),
        ),
        hint: group.members.length
          ? group.members.map((m) => m.value).join(", ")
          : copy.noPolicyGroupMembers,
      }))
    : [];

  const ownershipPrincipals = assignTagOwnershipsTarget
    ? userPolicyPrincipals(assignTagOwnershipsTarget, snapshot.users)
    : [];
  const assignTagOwnershipsOptions: AssignMemberOption[] =
    assignTagOwnershipsTarget
      ? policyTagOwners.map((tagOwner) => ({
          id: tagOwner.id,
          name: tagOwner.tag,
          assigned: tagOwner.owners.some((owner) =>
            ownershipPrincipals.includes(owner.value),
          ),
          hint: tagOwner.owners.length
            ? tagOwner.owners.map((o) => o.value).join(", ")
            : copy.noPolicyTagOwnerEntries,
        }))
      : [];

  const authKeyDialogUsers = visibleUsers.map((user) =>
    authKeyDialogUser(user, copy.unknown),
  );

  const authKeyDialogDefaults = inviteForm;

  const { mutate, mutateWith } = useMutation();
  const createPreAuthKey = useCreatePreAuthKey();
  const { savePolicy } = usePolicySave();
  const latest = useRef({ consumeUserQuery, authKeyDialogUsers, inviteForm });
  latest.current = { consumeUserQuery, authKeyDialogUsers, inviteForm };

  function openMemberDialog() {
    ++memberCreateGeneration.current;
    setMemberPreflightError("");
    clearActionFeedback("create-member");
    setMemberDialogOpen(true);
    void refreshSnapshot();
  }

  function closeMemberDialog() {
    ++memberCreateGeneration.current;
    setMemberPreflightError("");
    setMemberDialogOpen(false);
    memberForm.reset();
    clearActionFeedback("create-member");
  }

  function handleMemberDialogOpen(open: boolean) {
    if (
      open ||
      memberForm.state.isSubmitting ||
      isActionPending("create-member")
    )
      return;
    closeMemberDialog();
  }

  async function createMember(value: typeof EMPTY_MEMBER_FORM) {
    // Enter 提交不一定触发 blur，写入前仍统一规范化并保留失败后的可编辑值。
    const input = {
      name: value.name.trim(),
      displayName: value.displayName.trim(),
      email: value.email.trim(),
    };
    memberForm.setFieldValue("name", input.name);
    memberForm.setFieldValue("displayName", input.displayName);
    memberForm.setFieldValue("email", input.email);
    setMemberPreflightError("");
    clearActionFeedback("create-member");
    if (!drafts.isCurrent()) {
      setMemberPreflightError(t("sessionChanged"));
      return;
    }
    const ownsSession = snapshotStore.captureSession();
    const viewEpoch = drafts.getSnapshot().viewEpoch;
    const generation = memberCreateGeneration.current;
    const fresh = await snapshotStore.refreshSegments(["identity"]);
    if (
      !ownsSession() ||
      generation !== memberCreateGeneration.current ||
      viewEpoch !== drafts.getSnapshot().viewEpoch ||
      !drafts.isCurrent()
    )
      return;
    if (!fresh) {
      setMemberPreflightError(copy.memberFreshReadRequired);
      return;
    }
    const conflict = userCreationPrincipalConflict(
      input,
      snapshotStore.getSnapshot().snapshot.users,
    );
    if (conflict) {
      memberForm.setFieldMeta(conflict.field, (meta) => ({
        ...meta,
        isTouched: true,
        errorMap: {
          ...meta.errorMap,
          onSubmit: `${copy.memberIdentityConflict} ${conflict.principal}`,
        },
      }));
      return;
    }
    const created = await mutate("create-member", {
      endpoint: "createUser",
      input,
    });
    if (
      created &&
      ownsSession() &&
      generation === memberCreateGeneration.current
    )
      closeMemberDialog();
  }

  function clearMemberIdentityError(field: "name" | "email") {
    memberForm.setFieldMeta(field, (meta) => ({
      ...meta,
      errorMap: { ...meta.errorMap, onSubmit: undefined },
    }));
  }

  function openUserDetails(user?: HeadscaleUser) {
    if (!hasVisibleUser(user)) return;
    const token = userDetailGuard.next();
    memberPolicyContext.current = {
      targetId: user.id,
      generation: memberPolicyContext.current.generation + 1,
    };
    setSelectedDetailUser(user);
    void userDetailGuard.refresh(token, () => {
      const nextUser = currentUser(user.id);
      setSelectedDetailUser(
        nextUser && hasVisibleUser(nextUser) ? nextUser : null,
      );
    });
  }

  // Leaving the details for another action never returns to the source page.
  function dismissUserDetails() {
    ++memberPolicyContext.current.generation;
    setMemberPublication(null);
    userDetailGuard.cancel();
    setSelectedDetailUser(null);
    setPendingReferenceKey(null);
  }

  // The dialog has no trigger, so Base UI only reports dismissal.
  function closeUserDetails() {
    dismissUserDetails();
    const fromPage = intent.from;
    if (fromPage && fromPage !== "members") {
      void navigate({ to: `/${fromPage}`, search: intent.returnSearch ?? {} });
    }
  }

  function openRenameMemberDialog(user: HeadscaleUser) {
    memberPolicyContext.current = {
      targetId: user.id,
      generation: memberPolicyContext.current.generation + 1,
    };
    setMemberPublication(null);
    setPolicySaveNotice(null);
    clearActionFeedback("rename-member");
    clearActionFeedback("save-policy");
    setRenamedUser(null);
    setSelectedRenameUser(user);
    renameMemberForm.reset(
      { name: user.name, updateReferences: true },
      { keepDefaultValues: true },
    );
  }

  // Only auto-open the user detail dialog when the navigation explicitly asks for
  // it via `?popup=user` (e.g., from invite-owner-link). Plain `?user=…` from a
  // route-user-link keeps the table visible so the user can browse first.
  const consumedUserQuery = useRef<string | null>(null);
  function consumeUserQuery(userId: string | null) {
    if (!userId || intent.popup !== "user") {
      consumedUserQuery.current = null;
      return;
    }
    if (consumedUserQuery.current === userId) return;
    const target = snapshot.users.find((u) => u.id === userId);
    if (target) {
      consumedUserQuery.current = userId;
      openUserDetails(target);
    }
  }

  // Retry query consumption after the initial user snapshot arrives.
  useEffect(
    () => latest.current.consumeUserQuery(intent.userId),
    [intent.userId, intent.popup, snapshot.users],
  );

  function closeRenameDialog() {
    ++memberPolicyContext.current.generation;
    setMemberPublication(null);
    setSelectedRenameUser(null);
    setRenamedUser(null);
    renameMemberForm.reset();
    clearActionFeedback("rename-member");
    clearActionFeedback("save-policy");
  }

  function handleRenameMemberDialogOpen(open: boolean) {
    if (open || renameMemberForm.state.isSubmitting || renamePending) return;
    closeRenameDialog();
  }

  // Server first: Headscale decides whether the name is acceptable, then one policy write follows.
  // After a failed policy write the user is already renamed, so a retry only repeats that write.
  async function confirmRenameMember(value: {
    name: string;
    updateReferences: boolean;
  }) {
    const user = selectedRenameUser;
    if (!user || renameConfirmDisabled) return;
    const renameName = value.name.trim();
    renameMemberForm.setFieldValue("name", renameName);
    const renameUpdatesPolicy =
      value.updateReferences &&
      renameImpact.hasReferences &&
      !renameImpact.blockedText;
    const isCurrentSession = snapshotStore.captureSession();
    const context = { ...memberPolicyContext.current };
    const scope = session.tagLifecycle.captureScope();
    let target = renamedUser ?? user;
    // A directory update can arrive before React disables the button. Check the live store too.
    if (
      renameUpdatesPolicy &&
      !renamePolicyPrincipal(
        target,
        snapshotStore.getSnapshot().snapshot.users,
        renamedUser ? undefined : renameName,
      )
    )
      return;
    if (renamedUser === null) {
      const renamed = await mutateWith("rename-member", {
        endpoint: "renameUser",
        input: { id: user.id, newName: renameName },
      });
      if (
        !renamed.ok ||
        !isCurrentSession() ||
        context.generation !== memberPolicyContext.current.generation
      )
        return;
      target = renamed.result.user;
      setRenamedUser(target);
    }
    if (!session.tagLifecycle.isCurrent(scope)) return;
    if (renameUpdatesPolicy) {
      // The response and refreshed directory, not the requested spelling, own the migration target.
      const to = renamePolicyPrincipal(
        target,
        snapshotStore.getSnapshot().snapshot.users,
      );
      if (target.id !== user.id || !to) return;
      if (to !== renameFrom) {
        const plan = retargetUserReferences(
          policyStore.policyDesignerState,
          renamePrincipals,
          to,
        );
        if (!plan.ok) return;
        reviewMemberPolicy("rename", target, plan.state);
        return;
      }
    }
    closeRenameDialog();
  }

  function requestDeleteMember(user: HeadscaleUser) {
    memberPolicyContext.current = {
      targetId: user.id,
      generation: memberPolicyContext.current.generation + 1,
    };
    setMemberPublication(null);
    setPolicySaveNotice(null);
    clearActionFeedback("delete-member");
    clearActionFeedback("save-policy");
    deleteMemberForm.reset(
      { cleanup: !policyError },
      { keepDefaultValues: true },
    );
    setDeletedUserId(null);
    setPendingDeleteUser(user);
  }

  function closeDeleteDialog() {
    ++memberPolicyContext.current.generation;
    setMemberPublication(null);
    setDeletedUserId(null);
    setPendingDeleteUser(null);
    clearActionFeedback("delete-member");
    clearActionFeedback("save-policy");
  }

  function handleDeleteMemberDialogOpen(open: boolean) {
    if (
      open ||
      deleteMemberForm.state.isSubmitting ||
      isActionPending("delete-member") ||
      isActionPending("save-policy")
    )
      return;
    closeDeleteDialog();
  }

  async function confirmDeleteMember(cleanupPolicy: boolean) {
    const user = pendingDeleteUser;
    // The confirm button is disabled in this state; the live policy store is the authority.
    const cleanupBlocked =
      cleanupPolicy &&
      (policyStore.getSnapshot().policyError || deleteImpact.blockedText);
    if (!user || cleanupBlocked || deleteDevices.length > 0) return;
    const cleanup = cleanupPolicy && deleteImpact.hasReferences;
    const isCurrentSession = snapshotStore.captureSession();
    const context = { ...memberPolicyContext.current };
    const scope = session.tagLifecycle.captureScope();
    setPolicySaveNotice(null);

    // Headscale alone decides whether a user can be deleted (it refuses users that still own
    // nodes), so delete first: a rejected delete must leave the live policy untouched. After a
    // failed cleanup the user is already gone, so a retry only repeats the cleanup.
    if (deletedUserId !== user.id && currentUser(user.id)) {
      if (
        !(await mutate("delete-member", {
          endpoint: "deleteUser",
          input: { id: user.id },
        })) ||
        !isCurrentSession() ||
        context.generation !== memberPolicyContext.current.generation
      )
        return;
      setDeletedUserId(user.id);
    }
    // Verify the directory with reads, never by replaying a confirmed destructive write.
    if (
      cleanup &&
      snapshotStore.getSnapshot().segmentStatus.identity !== "ready" &&
      !(await snapshotStore.refreshSegments(["identity"]))
    )
      return;
    if (
      !isCurrentSession() ||
      !session.tagLifecycle.isCurrent(scope) ||
      context.generation !== memberPolicyContext.current.generation
    )
      return;
    if (cleanup) {
      reviewMemberPolicy("delete", user, policyStore.policyDesignerState);
      return;
    }
    closeDeleteDialog();
  }

  function removeUserFromPolicyReference(
    user: HeadscaleUser,
    reference: UserPolicyReference,
  ) {
    setPendingReferenceKey(null);
    let next = policyDesignerState;
    if (reference.kind === "group") {
      for (const value of reference.matchedValues) {
        next = removeMemberFromGroup(next, reference.id, value);
      }
    } else {
      for (const value of reference.matchedValues) {
        next = removeOwnerFromTag(next, reference.id, value);
      }
    }
    reviewMemberPolicy("reference", user, next);
  }

  function openAssignMembershipsDialog(user: HeadscaleUser) {
    if (policyStore.getSnapshot().policyError) return;
    clearActionFeedback("assign-user-groups");
    membershipContext.current = {
      targetId: user.id,
      generation: membershipContext.current.generation + 1,
    };
    setPolicySaveNotice(null);
    setAssignMembershipsTarget(user);
    setPolicyState({ assignMembershipsOpen: true });
  }

  // The dialog has no trigger, so Base UI only reports dismissal.
  function closeAssignMembershipsDialog() {
    ++membershipContext.current.generation;
    setPolicyState({ assignMembershipsOpen: false });
    clearActionFeedback("assign-user-groups");
    setAssignMembershipsTarget(null);
    setMemberPublication(null);
  }

  function openAssignTagOwnershipsDialog(user: HeadscaleUser) {
    if (policyStore.getSnapshot().policyError) return;
    clearActionFeedback("assign-user-tags");
    ownershipContext.current = {
      targetId: user.id,
      generation: ownershipContext.current.generation + 1,
    };
    setPolicySaveNotice(null);
    setAssignTagOwnershipsTarget(user);
    setPolicyState({ assignTagOwnershipsOpen: true });
  }

  // The dialog has no trigger, so Base UI only reports dismissal.
  function closeAssignTagOwnershipsDialog() {
    ++ownershipContext.current.generation;
    setPolicyState({ assignTagOwnershipsOpen: false });
    clearActionFeedback("assign-user-tags");
    setAssignTagOwnershipsTarget(null);
    setMemberPublication(null);
  }

  function reviewMemberPolicy(
    kind: MemberPolicyKind,
    target: HeadscaleUser,
    next: PolicyDesignerState,
  ) {
    const scope = session.tagLifecycle.captureScope();
    if (
      !drafts.isCurrent() ||
      !scope ||
      policyStore.isPolicySaving ||
      policyStore.isPolicyDirty ||
      policyStore.getSnapshot().policyError ||
      memberPublication
    )
      return;
    const users = snapshotStore.getSnapshot().snapshot.users;
    const index = PrincipalIndex.fromUsers(users);
    const principals = userPolicyPrincipals(target, users).filter(
      (principal) => kind !== "delete" || !index.has(principal),
    );
    if (
      ((kind === "groups" || kind === "tags" || kind === "delete") &&
        !principals.length) ||
      (kind === "delete" && users.some((user) => user.id === target.id))
    ) {
      setPolicySaveNotice("context");
      return;
    }
    // A recovery read may transfer only some aliases; review cleanup against its live directory.
    const cleanup =
      kind === "delete" ? retargetUserReferences(next, principals, null) : null;
    if (cleanup && !cleanup.ok) return;
    const state = structuredClone(cleanup?.state ?? next);
    setPolicySaveNotice(null);
    setMemberPublication({
      kind,
      state,
      original: policyStore.getSnapshot().policyDraft,
      submitted: JSON.stringify(serializePolicy(state), null, 2),
      revision: policyStore.getSnapshot().editRevision,
      context: { ...publicationContext(kind) },
      userName: target.name,
      principals,
      scope,
    });
  }

  async function confirmMemberPublication() {
    if (!memberPublication || policyStore.isPolicySaving) return;
    const reviewed = memberPublication;
    const sameContext = () => {
      const current = publicationContext(reviewed.kind);
      return (
        current.targetId === reviewed.context.targetId &&
        current.generation === reviewed.context.generation
      );
    };
    const users = snapshotStore.getSnapshot().snapshot.users;
    const user = users.find((user) => user.id === reviewed.context.targetId);
    const index = PrincipalIndex.fromUsers(users);
    const sameUser =
      reviewed.kind === "delete"
        ? !user &&
          reviewed.principals.every((principal) => !index.has(principal))
        : user?.name === reviewed.userName &&
          reviewed.principals.every((principal) =>
            userMatchesPolicyValue(user, principal, users),
          );
    if (
      !drafts.isCurrent() ||
      !session.tagLifecycle.isCurrent(reviewed.scope) ||
      !sameContext() ||
      !sameUser
    ) {
      setMemberPublication(null);
      setPolicySaveNotice("context");
      return;
    }
    if (
      reviewed.revision !== policyStore.getSnapshot().editRevision ||
      policyStore.isPolicyDirty
    ) {
      setMemberPublication(null);
      setPolicySaveNotice("newer");
      return;
    }
    setMemberPublication(null);
    const saved = await savePolicy(
      reviewed.kind === "groups"
        ? "assign-user-groups"
        : reviewed.kind === "tags"
          ? "assign-user-tags"
          : "save-policy",
      reviewed.state,
      { targeted: true },
    );
    if (!session.tagLifecycle.isCurrent(reviewed.scope) || !drafts.isCurrent())
      return;
    if (!saved.ok) {
      if (
        sameContext() &&
        snapshotStore.getSnapshot().snapshot.policy?.policy !==
          reviewed.original
      )
        setMemberPublication(reviewed);
      return;
    }
    if (saved.hasNewerEdits) setPolicySaveNotice("newer");
    if (!sameContext()) {
      setPolicySaveNotice("context");
      return;
    }
    if (reviewed.kind === "rename") closeRenameDialog();
    else if (reviewed.kind === "delete") closeDeleteDialog();
    else if (!saved.hasNewerEdits && reviewed.kind === "groups")
      closeAssignMembershipsDialog();
    else if (!saved.hasNewerEdits && reviewed.kind === "tags")
      closeAssignTagOwnershipsDialog();
  }

  // The menu items are disabled for users without a policy principal, so the principal is non-empty.
  function applyAssignMemberships(
    target: HeadscaleUser,
    selectedGroupIds: string[],
  ) {
    const principal = policyPrincipalForUser(target, snapshot.users);
    const principals = userPolicyPrincipals(target, snapshot.users);
    const selectedSet = new Set(selectedGroupIds);
    let next = policyDesignerState;
    for (const group of next.groups) {
      const isSelected = selectedSet.has(group.id);
      const hasMember = group.members.some((m) => principals.includes(m.value));
      if (isSelected && !hasMember) {
        next = addMemberToGroup(next, group.id, toMemberRef(principal));
      } else if (!isSelected && hasMember) {
        for (const member of group.members.filter((m) =>
          principals.includes(m.value),
        )) {
          next = removeMemberFromGroup(next, group.id, member.value);
        }
      }
    }
    reviewMemberPolicy("groups", target, next);
  }

  // The menu items are disabled for users without a policy principal, so the principal is non-empty.
  function applyAssignTagOwnerships(
    target: HeadscaleUser,
    selectedTagOwnerIds: string[],
  ) {
    const principal = policyPrincipalForUser(target, snapshot.users);
    const principals = userPolicyPrincipals(target, snapshot.users);
    const selectedSet = new Set(selectedTagOwnerIds);
    let next = policyDesignerState;
    for (const tagOwner of next.tagOwners) {
      const isSelected = selectedSet.has(tagOwner.id);
      const hasOwner = tagOwner.owners.some((o) =>
        principals.includes(o.value),
      );
      if (isSelected && !hasOwner) {
        next = addOwnerToTag(next, tagOwner.id, toMemberRef(principal));
      } else if (!isSelected && hasOwner) {
        for (const owner of tagOwner.owners.filter((o) =>
          principals.includes(o.value),
        )) {
          next = removeOwnerFromTag(next, tagOwner.id, owner.value);
        }
      }
    }
    reviewMemberPolicy("tags", target, next);
  }

  function openInviteDialogForUser(user: HeadscaleUser) {
    const token = inviteDialogGuard.next();
    ++inviteContext.current;
    inviteMemberId.current = user.id;
    setRestoredInvite(null);
    setInviteForm((current) => ({ ...current, user: user.id }));
    dismissUserDetails();
    clearActionFeedback("create-invite");
    setInviteDialogOpen(true);
    void inviteDialogGuard.refresh(token, () => {});
  }

  // The dialog has no trigger, so Base UI only reports dismissal.
  function closeInviteDialog() {
    if (isActionPending("create-invite")) return;
    ++inviteContext.current;
    setInviteDialogOpen(false);
    setRestoredInvite(null);
    clearActionFeedback("create-invite");
    inviteDialogGuard.cancel();
  }

  async function createInvite(payload: AuthKeyDialogPayload) {
    const context = inviteContext.current;
    const ownsSession = session.snapshot.captureSession();
    const viewEpoch = session.drafts.getSnapshot().viewEpoch;
    setInviteForm(toAuthKeyDefaults(payload));
    const created = await createPreAuthKey(payload);
    if (
      created &&
      context === inviteContext.current &&
      ownsSession() &&
      viewEpoch === session.drafts.getSnapshot().viewEpoch
    ) {
      closeInviteDialog();
      void navigate({ to: "/invites" });
    }
  }

  function manageInviteTags(form: AuthKeyDialogDraft, tag?: string) {
    ++inviteContext.current;
    if (!inviteReturn.manageTags(form, tag, userSearch, inviteMemberId.current))
      return;
    setInviteDialogOpen(false);
    inviteDialogGuard.cancel();
  }

  function exportUsers() {
    downloadCsv(
      "headscale-users.csv",
      ["name", "email", "provider", "machines", "joined", "id", "username"],
      filteredUsers.map((user) => ({
        name: userLabel(user),
        email: user.email,
        provider: user.provider || user.providerId,
        machines: userDevices(user).length,
        joined: user.createdAt,
        id: user.id,
        username: user.name,
      })),
    );
  }

  // An exact owner filter: a text search would also match other users and hostnames.
  function jumpToMachinesForUser(user: HeadscaleUser) {
    dismissUserDetails();
    void navigate({ to: "/devices", search: { user: user.id } });
  }

  function openNodeDetailsFromTable(node: HeadscaleNode) {
    // From the member table row's device-tag chip: jump to devices, open dialog,
    // and on close bounce the user back to /members.
    const query: Record<string, string> = {
      node: node.id,
      from: "members",
      popup: "node",
    };
    void navigate({ to: "/devices", search: query });
  }

  function openNodeDetailsFromDialog(node: HeadscaleNode) {
    // From inside the user-detail-dialog: jump to devices, open dialog, and on
    // close keep the user on /devices (so they can keep exploring machines).
    dismissUserDetails();
    const query: Record<string, string> = { node: node.id, popup: "node" };
    void navigate({ to: "/devices", search: query });
  }

  return (
    <section className="space-y-3 lg:space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{copy.membersTitle}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {copy.membersSubtitle}
        </p>
      </div>

      {policySaveNotice && (
        <p
          data-testid="policy-save-notice"
          className="text-sm text-muted-foreground"
        >
          {policySaveNotice === "newer"
            ? copy.policySavedNewerEdits
            : copy.policySaveContextChanged}
        </p>
      )}

      {policyBlocked && (
        <p
          data-testid={
            policyError ? "members-policy-read-only" : "members-policy-unsaved"
          }
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {policyBlocked}
        </p>
      )}

      <Dialog open={memberDialogOpen} onOpenChange={handleMemberDialogOpen}>
        <DialogContent
          data-testid="member-create-dialog"
          className="sm:max-w-xl"
        >
          <DialogHeader>
            <DialogTitle>{copy.addMember}</DialogTitle>
            <DialogDescription>
              {copy.createMemberDescription}
            </DialogDescription>
          </DialogHeader>
          <memberForm.AppForm>
            <memberForm.Form className="grid gap-3" data-testid="member-form">
              <memberForm.AppField
                name="name"
                listeners={{ onChange: () => clearMemberIdentityError("name") }}
                validators={{
                  onDynamic: ({ value }) => {
                    const issue = userNameIssue(
                      value.trim(),
                      snapshotStore.getSnapshot().snapshot.users,
                    );
                    return issue ? userNameIssueText[issue] : undefined;
                  },
                }}
              >
                {(field) => (
                  <field.TextField
                    id="member-name"
                    data-testid="member-name"
                    label={copy.memberName}
                    autoComplete="off"
                    required
                  />
                )}
              </memberForm.AppField>
              <memberForm.AppField name="displayName">
                {(field) => (
                  <field.TextField
                    id="member-display"
                    data-testid="member-display"
                    label={
                      <>
                        {copy.displayName}{" "}
                        <span className="font-normal text-muted-foreground">
                          {copy.optionalField}
                        </span>
                      </>
                    }
                  />
                )}
              </memberForm.AppField>
              <memberForm.AppField
                name="email"
                listeners={{
                  onChange: () => clearMemberIdentityError("email"),
                }}
                validators={{
                  onDynamic: ({ value }) =>
                    value.trim() && !isEmailLike(value.trim())
                      ? copy.emailInvalid
                      : undefined,
                }}
              >
                {(field) => (
                  <field.TextField
                    id="member-email"
                    data-testid="member-email"
                    type="email"
                    autoComplete="off"
                    label={
                      <>
                        {copy.email}{" "}
                        <span className="font-normal text-muted-foreground">
                          {copy.optionalField}
                        </span>
                      </>
                    }
                  />
                )}
              </memberForm.AppField>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  data-testid="cancel-create-member"
                  disabled={
                    memberSubmitting || isActionPending("create-member")
                  }
                  onClick={() => handleMemberDialogOpen(false)}
                >
                  {copy.cancel}
                </Button>
                <memberForm.SubmitButton
                  data-testid="create-member"
                  busy={isActionPending("create-member")}
                >
                  {!memberSubmitting && !isActionPending("create-member") && (
                    <Plus className="h-4 w-4" aria-hidden="true" />
                  )}
                  {copy.createMember}
                </memberForm.SubmitButton>
              </DialogFooter>
              {memberPreflightError || actionError("create-member") ? (
                <p
                  className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  data-testid="create-member-error"
                >
                  {memberPreflightError || actionError("create-member")}
                </p>
              ) : null}
            </memberForm.Form>
          </memberForm.AppForm>
        </DialogContent>
      </Dialog>

      <div className="space-y-2" data-testid="user-table-shell">
        <div
          className="flex flex-col gap-2 sm:flex-row sm:items-center"
          data-testid="user-toolbar"
        >
          <div className="w-full sm:max-w-sm">
            <Label htmlFor="user-search" className="sr-only">
              {copy.searchUsers}
            </Label>
            <div className="relative">
              <Search
                className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={userSearch}
                onChange={(event) => {
                  ++inviteContext.current;
                  setUserSearch(event.target.value);
                }}
                id="user-search"
                data-testid="user-search"
                className="ps-8"
                placeholder={copy.searchUsers}
              />
            </div>
          </div>
          <p
            data-testid="user-count"
            className="whitespace-nowrap text-xs text-muted-foreground sm:ms-auto"
          >
            {filteredUsers.length} / {visibleUsers.length}
          </p>
          <Button
            type="button"
            variant="outline"
            size="icon"
            data-testid="refresh-users"
            aria-label={copy.refreshData}
            title={copy.refreshData}
            disabled={isRefreshingSnapshot}
            onClick={refreshMembers}
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
          <Button
            type="button"
            variant="outline"
            size="icon"
            data-testid="export-users"
            aria-label={copy.exportData}
            title={copy.exportData}
            disabled={filteredUsers.length === 0}
            onClick={exportUsers}
          >
            <Download className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button data-testid="open-create-member" onClick={openMemberDialog}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {copy.addMember}
          </Button>
        </div>
        <Card className="min-w-0 overflow-hidden" data-testid="user-table">
          <Table aria-label={copy.membersTitle}>
            <TableHeader>
              <TableRow>
                <TableHead>{copy.membersTitle}</TableHead>
                <TableHead data-testid="member-devices-header">
                  {copy.memberDevices}
                </TableHead>
                <TableHead>{copy.joined}</TableHead>
                <TableHead>{copy.authSource}</TableHead>
                <TableHead className="hidden lg:table-cell">
                  {copy.actions}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredUsers.map((user) => {
                const devices = userDevices(user);
                return (
                  <TableRow key={user.id} data-testid={`member-${user.name}`}>
                    <TableCell className="align-top md:min-w-56">
                      <button
                        type="button"
                        className="font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        data-testid={`member-detail-link-${user.name}`}
                        onClick={() => openUserDetails(user)}
                      >
                        {userLabel(user)}
                      </button>
                      {user.name && userLabel(user) !== user.name ? (
                        // Policies and the CLI refer to the user by this name.
                        <p
                          className="mt-1 break-all font-mono text-xs text-muted-foreground"
                          data-testid={`member-username-${user.name}`}
                        >
                          {user.name}
                        </p>
                      ) : null}
                      <p className="mt-1 break-all text-sm text-muted-foreground">
                        {user.email || userAuthSource(user)}
                      </p>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              variant="outline"
                              size="icon"
                              className="mt-2 lg:hidden"
                              data-testid={`member-actions-trigger-mobile-${user.name}`}
                              aria-label={`${copy.actions}: ${userLabel(user)}`}
                            />
                          }
                        >
                          <EllipsisVertical
                            className="h-4 w-4"
                            aria-hidden="true"
                          />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="start"
                          className="w-64"
                          data-testid={`member-actions-menu-mobile-${user.name}`}
                        >
                          <DropdownMenuGroup>
                            <DropdownMenuLabel>
                              {copy.actions}
                            </DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              data-testid={`view-member-details-mobile-${user.name}`}
                              onClick={() => openUserDetails(user)}
                            >
                              <FileCheck2
                                className="h-4 w-4"
                                aria-hidden="true"
                              />
                              {copy.viewDetails}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              data-testid={`view-member-machines-mobile-${user.name}`}
                              onClick={() => jumpToMachinesForUser(user)}
                            >
                              <Network className="h-4 w-4" aria-hidden="true" />
                              {copy.viewMachines}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              data-testid={`create-invite-for-member-mobile-${user.name}`}
                              onClick={() => openInviteDialogForUser(user)}
                            >
                              <KeyRound
                                className="h-4 w-4"
                                aria-hidden="true"
                              />
                              {copy.createInvite}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              data-testid={`rename-member-mobile-${user.name}`}
                              onClick={() => openRenameMemberDialog(user)}
                            >
                              <Pencil className="h-4 w-4" aria-hidden="true" />
                              {copy.renameMember}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              data-testid={`assign-member-groups-mobile-${user.name}`}
                              disabled={
                                Boolean(policyBlocked) ||
                                !policyPrincipalForUser(user, snapshot.users)
                              }
                              onClick={() => openAssignMembershipsDialog(user)}
                            >
                              <Users className="h-4 w-4" aria-hidden="true" />
                              {copy.addUserToGroup}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              data-testid={`assign-member-tags-mobile-${user.name}`}
                              disabled={
                                Boolean(policyBlocked) ||
                                !policyPrincipalForUser(user, snapshot.users)
                              }
                              onClick={() =>
                                openAssignTagOwnershipsDialog(user)
                              }
                            >
                              <ShieldCheck
                                className="h-4 w-4"
                                aria-hidden="true"
                              />
                              {copy.grantTagToUser}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              data-testid={`delete-member-mobile-${user.name}`}
                              onClick={() => requestDeleteMember(user)}
                            >
                              <Trash2 className="h-4 w-4" aria-hidden="true" />
                              {copy.deleteMember}
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                    <TableCell className="align-top md:min-w-28">
                      {devices.length ? (
                        <div
                          className="grid justify-items-start gap-1"
                          data-testid={`member-device-tags-${user.name}`}
                        >
                          {devices.map((node) => (
                            <button
                              key={node.id}
                              type="button"
                              className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              data-testid={`member-device-tag-${user.name}-${node.id}`}
                              onClick={() => openNodeDetailsFromTable(node)}
                            >
                              <Badge
                                variant="outline"
                                className={cn(
                                  "cursor-pointer",
                                  nodeStatusClass(node),
                                )}
                              >
                                {nodeDisplayName(node)}{" "}
                                <span className="font-normal opacity-80">
                                  {nodeStatusLabel(node)}
                                </span>
                              </Badge>
                            </button>
                          ))}
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
                    <TableCell className="align-top text-sm text-muted-foreground md:min-w-40">
                      {formatDate(user.createdAt)}
                    </TableCell>
                    <TableCell
                      className="align-top md:min-w-36"
                      data-testid={`member-auth-source-${user.name}`}
                    >
                      {userAuthSource(user)}
                    </TableCell>
                    <TableCell className="hidden align-top lg:table-cell lg:min-w-16">
                      <div className="flex justify-start">
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                variant="outline"
                                size="icon"
                                data-testid={`member-actions-trigger-${user.name}`}
                                aria-label={`${copy.actions}: ${userLabel(user)}`}
                              />
                            }
                          >
                            <EllipsisVertical
                              className="h-4 w-4"
                              aria-hidden="true"
                            />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="end"
                            className="w-64"
                            data-testid={`member-actions-menu-${user.name}`}
                          >
                            <DropdownMenuGroup>
                              <DropdownMenuLabel>
                                {copy.actions}
                              </DropdownMenuLabel>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                data-testid={`view-member-details-${user.name}`}
                                onClick={() => openUserDetails(user)}
                              >
                                <FileCheck2
                                  className="h-4 w-4"
                                  aria-hidden="true"
                                />
                                {copy.viewDetails}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                data-testid={`view-member-machines-${user.name}`}
                                onClick={() => jumpToMachinesForUser(user)}
                              >
                                <Network
                                  className="h-4 w-4"
                                  aria-hidden="true"
                                />
                                {copy.viewMachines}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                data-testid={`create-invite-for-member-${user.name}`}
                                onClick={() => openInviteDialogForUser(user)}
                              >
                                <KeyRound
                                  className="h-4 w-4"
                                  aria-hidden="true"
                                />
                                {copy.createInvite}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                data-testid={`rename-member-${user.name}`}
                                onClick={() => openRenameMemberDialog(user)}
                              >
                                <Pencil
                                  className="h-4 w-4"
                                  aria-hidden="true"
                                />
                                {copy.renameMember}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                data-testid={`assign-member-groups-${user.name}`}
                                disabled={
                                  Boolean(policyBlocked) ||
                                  !policyPrincipalForUser(user, snapshot.users)
                                }
                                onClick={() =>
                                  openAssignMembershipsDialog(user)
                                }
                              >
                                <Users className="h-4 w-4" aria-hidden="true" />
                                {copy.addUserToGroup}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                data-testid={`assign-member-tags-${user.name}`}
                                disabled={
                                  Boolean(policyBlocked) ||
                                  !policyPrincipalForUser(user, snapshot.users)
                                }
                                onClick={() =>
                                  openAssignTagOwnershipsDialog(user)
                                }
                              >
                                <ShieldCheck
                                  className="h-4 w-4"
                                  aria-hidden="true"
                                />
                                {copy.grantTagToUser}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                variant="destructive"
                                data-testid={`delete-member-${user.name}`}
                                onClick={() => requestDeleteMember(user)}
                              >
                                <Trash2
                                  className="h-4 w-4"
                                  aria-hidden="true"
                                />
                                {copy.deleteMember}
                              </DropdownMenuItem>
                            </DropdownMenuGroup>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {filteredUsers.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="py-6 text-sm whitespace-normal text-muted-foreground"
                    data-testid="members-state"
                  >
                    {visibleUsers.length ? (
                      copy.noUsersMatch
                    ) : refreshErrors.identity ? (
                      <span className="flex flex-wrap items-center gap-3">
                        {copy.membersLoadFailed}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          data-testid="retry-members"
                          disabled={isRefreshingSnapshot}
                          onClick={refreshMembers}
                        >
                          {t("tryAgain")}
                        </Button>
                      </span>
                    ) : isReady ? (
                      copy.noUsersYet
                    ) : (
                      <span className="flex items-center gap-2">
                        <LoaderCircle
                          className="h-4 w-4 animate-spin"
                          aria-hidden="true"
                        />
                        {copy.membersLoading}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </Card>
      </div>

      {(inviteReturn.restoreFailed || inviteReturn.newerEdit) && (
        <div
          className="grid gap-2 rounded-md border p-3"
          data-testid={
            inviteReturn.newerEdit
              ? "invite-return-newer"
              : "invite-return-error"
          }
        >
          <p>
            {inviteReturn.newerEdit
              ? copy.tagReturnNewerEdit
              : copy.inviteReturnReadFailed}
          </p>
          <Button
            type="button"
            variant="outline"
            data-testid="invite-return-retry"
            disabled={inviteReturn.restoring || inviteDialogOpen}
            onClick={inviteReturn.retryRestore}
          >
            {copy.inviteRetryReturn}
          </Button>
          <Button
            type="button"
            variant="ghost"
            data-testid="invite-return-discard"
            disabled={inviteReturn.restoring || inviteDialogOpen}
            onClick={inviteReturn.discardReturn}
          >
            {copy.discardDialogChanges}
          </Button>
        </div>
      )}
      <CreateAuthKeyDialog
        paused={stale !== null}
        open={inviteDialogOpen}
        users={authKeyDialogUsers}
        defaults={authKeyDialogDefaults}
        labels={authKeyDialogLabels(copy)}
        error={actionError("create-invite")}
        restoredDraft={restoredInvite}
        tagOptions={declaredTags ?? []}
        declaredTags={declaredTags}
        tagReadError={refreshErrors.policy}
        onRetryTags={() => void snapshotStore.refreshSegments(["policy"])}
        onManageTags={manageInviteTags}
        outcome={
          <CreateKeyOutcomeNotice outcome={actionOutcome("create-invite")} />
        }
        onOpenChange={closeInviteDialog}
        isSubmitting={isCreatingInvite}
        onSubmit={createInvite}
      />

      <Dialog
        open={Boolean(selectedDetailUser)}
        onOpenChange={closeUserDetails}
      >
        <DialogContent
          ref={detailDialogRef}
          // The first control sits below the fold; focusing it would scroll the title away.
          initialFocus={detailDialogRef}
          className="max-h-[85vh] overflow-y-auto sm:max-w-3xl"
          data-testid="user-detail-dialog"
        >
          {selectedDetailUser ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex min-w-0 items-center gap-2">
                  <CircleUserRound
                    className="h-5 w-5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="truncate">
                    {userLabel(selectedDetailUser)}
                  </span>
                </DialogTitle>
                <DialogDescription>{copy.userDetails}</DialogDescription>
              </DialogHeader>

              <div className="grid gap-4">
                <div className="grid gap-2 sm:grid-cols-3">
                  <div className="rounded-md border bg-background p-3">
                    <p className="text-xs text-muted-foreground">
                      {copy.userId}
                    </p>
                    <p className="mt-1 text-sm font-medium">
                      {selectedDetailUser.id}
                    </p>
                  </div>
                  <div className="rounded-md border bg-background p-3">
                    <p className="text-xs text-muted-foreground">
                      {copy.deviceCount}
                    </p>
                    <p className="mt-1 text-sm font-medium">
                      {selectedUserDevices.length}
                    </p>
                  </div>
                  <div className="rounded-md border bg-background p-3">
                    <p className="text-xs text-muted-foreground">
                      {copy.pendingRoutes}
                    </p>
                    <p className="mt-1 text-sm font-medium">
                      {selectedUserPendingRoutesCount}
                    </p>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <section className="grid gap-2 rounded-md border bg-background p-3">
                    <h3 className="text-sm font-semibold">{copy.details}</h3>
                    <p
                      className="break-all text-sm text-muted-foreground"
                      data-testid="user-detail-username"
                    >
                      {copy.memberName}: {selectedDetailUser.name || "-"}
                    </p>
                    <p className="break-all text-sm text-muted-foreground">
                      {copy.email}: {selectedDetailUser.email || "-"}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {copy.authSource}: {userAuthSource(selectedDetailUser)}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {copy.joined}: {formatDate(selectedDetailUser.createdAt)}
                    </p>
                  </section>

                  <section className="grid gap-2 rounded-md border bg-background p-3">
                    <h3 className="text-sm font-semibold">
                      {copy.activeAuthKeys}
                    </h3>
                    {selectedUserActiveKeys.length ? (
                      <div className="grid gap-1">
                        {selectedUserActiveKeys.map((key) => (
                          <code
                            key={key.id}
                            className="w-fit rounded bg-secondary px-1.5 py-0.5 text-xs"
                          >
                            {shortSecret(key.key)}
                          </code>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {copy.noActiveAuthKeys}
                      </p>
                    )}
                  </section>
                </div>

                <section className="grid gap-2">
                  <h3 className="text-sm font-semibold">
                    {copy.personalDevices}
                  </h3>
                  {selectedUserDevices.length ? (
                    <div className="grid gap-2">
                      {selectedUserDevices.map((node) => (
                        <button
                          key={node.id}
                          type="button"
                          className="grid gap-2 rounded-md border bg-background p-3 text-start hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          data-testid={`user-detail-device-${node.id}`}
                          onClick={() => openNodeDetailsFromDialog(node)}
                        >
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">
                              {nodeDisplayName(node)}
                            </span>
                            <Badge
                              variant="outline"
                              className={nodeStatusClass(node)}
                            >
                              {nodeStatusLabel(node)}
                            </Badge>
                          </span>
                          <span className="flex flex-wrap gap-1">
                            {node.ipAddresses.map((address) => (
                              <Badge
                                key={address}
                                variant="outline"
                                className="border-slate-200 bg-muted/60 font-mono text-[11px] text-muted-foreground dark:border-slate-800"
                              >
                                <bdi dir="ltr">{address}</bdi>
                              </Badge>
                            ))}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {copy.noPersonalDevices}
                    </p>
                  )}
                </section>

                <section className="grid gap-2">
                  <h3 className="text-sm font-semibold">
                    {copy.policyReferences}
                  </h3>
                  {policyBlocked ? (
                    <p className="text-sm text-destructive">{policyBlocked}</p>
                  ) : null}
                  {policyError ? null : selectedUserPolicyReferences.length ? (
                    <div className="flex flex-wrap gap-1">
                      {selectedUserPolicyReferences.map((reference) => (
                        <Badge
                          key={`${reference.kind}-${reference.id}`}
                          variant="outline"
                          className="gap-1 py-0 pe-0"
                          data-testid={`user-policy-reference-${reference.kind}-${reference.id}`}
                        >
                          <span className="break-all">{reference.label}</span>
                          <button
                            type="button"
                            className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            aria-label={`${copy.removeFromReference}: ${reference.label}`}
                            disabled={
                              Boolean(policyBlocked) ||
                              isActionPending("save-policy")
                            }
                            data-testid={`remove-user-policy-reference-${reference.kind}-${reference.id}`}
                            onClick={() =>
                              setPendingReferenceKey(
                                `${reference.kind}-${reference.id}`,
                              )
                            }
                          >
                            <Trash2 className="h-3 w-3" aria-hidden="true" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {copy.noPolicyReferences}
                    </p>
                  )}
                  {pendingReference ? (
                    <div
                      className="grid gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm"
                      data-testid="remove-user-policy-reference-confirm"
                    >
                      <p>{copy.removeReferenceDescription}</p>
                      <p className="break-all font-medium">
                        {pendingReference.label}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          data-testid="confirm-remove-user-policy-reference"
                          disabled={
                            Boolean(policyBlocked) ||
                            isActionPending("save-policy")
                          }
                          onClick={() =>
                            removeUserFromPolicyReference(
                              selectedDetailUser,
                              pendingReference,
                            )
                          }
                        >
                          {copy.remove}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          data-testid="cancel-remove-user-policy-reference"
                          onClick={() => setPendingReferenceKey(null)}
                        >
                          {copy.cancel}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </section>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      {assignMembershipsTarget ? (
        <AssignMemberDialog
          open={assignMembershipsOpen && !policyError}
          title={copy.assignMembershipsTitle}
          description={copy.assignMembershipsDescription}
          options={assignMembershipsOptions}
          testidPrefix="assign-user-groups"
          error={
            stale || !lifecycleScope
              ? copy.tagConfirmationStale
              : (policyBlocked ?? actionError("assign-user-groups"))
          }
          notice={
            policyOutcomeUnknown
              ? `${t("sessionOutcomeUnknown")} ${copy.writeOutcomeVerifyInAccess}`
              : policySaveNotice === "newer"
                ? copy.policySavedNewerEdits
                : policySaveNotice === "context"
                  ? copy.policySaveContextChanged
                  : ""
          }
          onOpenChange={closeAssignMembershipsDialog}
          onSelectionChange={() => {
            ++membershipContext.current.generation;
          }}
          applyLabel={copy.applyAssignment}
          cancelLabel={copy.cancelAssignment}
          emptyLabel={copy.noGroupsAvailable}
          assignedLabel={copy.assignedBadgeLabel}
          isSubmitting={isActionPending("assign-user-groups")}
          onApply={(ids) =>
            applyAssignMemberships(assignMembershipsTarget, ids)
          }
        />
      ) : null}

      {assignTagOwnershipsTarget ? (
        <AssignMemberDialog
          open={assignTagOwnershipsOpen && !policyError}
          title={copy.assignTagOwnershipsTitle}
          description={copy.assignTagOwnershipsDescription}
          options={assignTagOwnershipsOptions}
          testidPrefix="assign-user-tags"
          error={
            stale || !lifecycleScope
              ? copy.tagConfirmationStale
              : (policyBlocked ?? actionError("assign-user-tags"))
          }
          notice={
            policyOutcomeUnknown
              ? `${t("sessionOutcomeUnknown")} ${copy.writeOutcomeVerifyInAccess}`
              : policySaveNotice === "newer"
                ? copy.policySavedNewerEdits
                : policySaveNotice === "context"
                  ? copy.policySaveContextChanged
                  : ""
          }
          onOpenChange={closeAssignTagOwnershipsDialog}
          onSelectionChange={() => {
            ++ownershipContext.current.generation;
          }}
          applyLabel={copy.applyAssignment}
          cancelLabel={copy.cancelAssignment}
          emptyLabel={copy.noTagsAvailable}
          assignedLabel={copy.assignedBadgeLabel}
          isSubmitting={isActionPending("assign-user-tags")}
          onApply={(ids) =>
            applyAssignTagOwnerships(assignTagOwnershipsTarget, ids)
          }
        />
      ) : null}

      {memberPublication && (
        <AccessPolicyReview
          original={memberPublication.original}
          submitted={memberPublication.submitted}
          latest={snapshot.policy?.policy}
          error={actionError(
            memberPublication.kind === "groups"
              ? "assign-user-groups"
              : memberPublication.kind === "tags"
                ? "assign-user-tags"
                : "save-policy",
          )}
          disabled={
            stale !== null || !lifecycleScope || policyStore.isPolicySaving
          }
          onConfirm={() => void confirmMemberPublication()}
          onCancel={() => setMemberPublication(null)}
        />
      )}

      <Dialog
        open={Boolean(selectedRenameUser)}
        onOpenChange={handleRenameMemberDialogOpen}
      >
        {selectedRenameUser ? (
          <DialogContent data-testid="rename-member-dialog">
            <renameMemberForm.AppForm>
              <renameMemberForm.Form
                className="grid gap-4"
                data-testid="rename-member-form"
              >
                <DialogHeader>
                  <DialogTitle>{copy.renameMemberTitle}</DialogTitle>
                  <DialogDescription>
                    {copy.renameMemberDescription}
                  </DialogDescription>
                </DialogHeader>
                <renameMemberForm.AppField
                  name="name"
                  validators={{
                    onDynamic: ({ value }) => {
                      if (renamedUser) return undefined;
                      const issue = userNameIssue(
                        value.trim(),
                        snapshotStore.getSnapshot().snapshot.users,
                        selectedRenameUser.id,
                      );
                      return issue ? userNameIssueText[issue] : undefined;
                    },
                  }}
                >
                  {(field) => (
                    <field.TextField
                      id="rename-member-name"
                      data-testid="rename-member-name"
                      label={copy.memberName}
                      disabled={renamedUser !== null}
                      autoComplete="off"
                      required
                    />
                  )}
                </renameMemberForm.AppField>
                {renameImpact.hasReferences ? (
                  <div
                    className="grid gap-2"
                    data-testid="rename-member-policy-impact"
                  >
                    <ReferenceImpact
                      heading={copy.userImpactOnDeleteHeading}
                      blockedText={renameImpact.blockedText}
                      references={renameReferences}
                      sections={renameImpact.sections}
                      sectionTestId="rename-member-policy-section"
                    />
                    {renameTargetBlocked ? (
                      <p
                        className="text-sm text-destructive"
                        data-testid="rename-member-target-error"
                      >
                        {copy.renameMemberPrincipalConflict}
                      </p>
                    ) : null}
                    <renameMemberForm.Field name="updateReferences">
                      {(field) => (
                        <label
                          htmlFor="rename-member-update-policy"
                          className="flex items-start gap-2 text-sm"
                        >
                          <Checkbox
                            id="rename-member-update-policy"
                            name={field.name}
                            checked={
                              field.state.value && !renameImpact.blockedText
                            }
                            onCheckedChange={field.handleChange}
                            onBlur={field.handleBlur}
                            disabled={
                              renameSubmitting ||
                              renamePending ||
                              renamePartial ||
                              Boolean(renameImpact.blockedText)
                            }
                            data-testid="rename-member-update-policy"
                          />
                          <span>{copy.renameUpdateReferencesOption}</span>
                        </label>
                      )}
                    </renameMemberForm.Field>
                  </div>
                ) : null}
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    data-testid="rename-member-cancel"
                    disabled={renameSubmitting || renamePending}
                    onClick={() => handleRenameMemberDialogOpen(false)}
                  >
                    {renamePartial ? copy.finish : copy.cancel}
                  </Button>
                  <renameMemberForm.SubmitButton
                    data-testid="confirm-rename-member"
                    busy={renamePending}
                    disabled={renameConfirmDisabled || renameTargetBlocked}
                  >
                    {renamePartial ? t("tryAgain") : copy.saveMemberName}
                  </renameMemberForm.SubmitButton>
                </DialogFooter>
                {renamePartial ? (
                  <p
                    className="text-sm text-muted-foreground"
                    data-testid="rename-member-policy-pending"
                  >
                    {copy.renameMemberPolicyPending}
                  </p>
                ) : null}
                {actionError("rename-member") ? (
                  <p
                    className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                    data-testid="rename-member-error"
                  >
                    {actionError("rename-member")}
                  </p>
                ) : null}
                {actionError("save-policy") ? (
                  <p
                    className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                    data-testid="rename-member-policy-error"
                  >
                    {actionError("save-policy")}
                  </p>
                ) : null}
              </renameMemberForm.Form>
            </renameMemberForm.AppForm>
          </DialogContent>
        ) : null}
      </Dialog>

      <AlertDialog
        open={Boolean(pendingDeleteUser)}
        onOpenChange={handleDeleteMemberDialogOpen}
      >
        {pendingDeleteUser ? (
          <AlertDialogContent data-testid="delete-member-dialog">
            <deleteMemberForm.AppForm>
              <deleteMemberForm.Form
                className="grid gap-4"
                data-testid="delete-member-form"
              >
                <AlertDialogHeader>
                  <AlertDialogTitle>{copy.deleteMemberTitle}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {copy.deleteMemberDescription}
                    <span className="mt-2 block font-medium text-foreground">
                      {userLabel(pendingDeleteUser)}
                    </span>
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <div
                  className="grid gap-1 text-sm"
                  data-testid="delete-member-summary"
                >
                  <p>
                    {copy.memberDevices}: {deleteDevices.length}
                  </p>
                  <p>
                    {copy.activeAuthKeys}: {deleteActiveKeys.length}
                  </p>
                </div>
                {deleteDevices.length ? (
                  <div
                    className="grid gap-1 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                    data-testid="delete-member-devices"
                  >
                    <p>{copy.deleteMemberOwnsDevices}</p>
                    <ul className="list-disc ps-5">
                      {deleteDevices.map((node) => (
                        <li key={node.id} className="break-all">
                          {nodeDisplayName(node)}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {deleteImpact.hasReferences || policyBlocked ? (
                  <div
                    className="grid gap-2"
                    data-testid="delete-member-policy-impact"
                  >
                    <ReferenceImpact
                      heading={
                        policyError
                          ? copy.userPolicyReferencesUnknown
                          : copy.userImpactOnDeleteHeading
                      }
                      blockedText={deleteImpact.blockedText}
                      references={deleteReferences}
                      sections={deleteImpact.sections}
                      sectionTestId="delete-member-policy-section"
                    />
                    <deleteMemberForm.AppField name="cleanup">
                      {(field) => (
                        <field.CheckboxField
                          id="delete-member-cleanup-policy"
                          data-testid="delete-member-cleanup-policy"
                          label={copy.cleanupReferencesOption}
                          disabled={
                            deleteSubmitting ||
                            isActionPending("delete-member") ||
                            isActionPending("save-policy") ||
                            Boolean(
                              deleteImpact.blockedText &&
                              !cleanupPolicyOnDelete,
                            ) ||
                            userDeleted
                          }
                        />
                      )}
                    </deleteMemberForm.AppField>
                  </div>
                ) : null}
                <AlertDialogFooter>
                  <AlertDialogCancel
                    data-testid="cancel-delete-member"
                    disabled={
                      deleteSubmitting ||
                      isActionPending("delete-member") ||
                      isActionPending("save-policy")
                    }
                  >
                    {cleanupPending ? copy.finish : copy.cancel}
                  </AlertDialogCancel>
                  <deleteMemberForm.SubmitButton
                    variant={cleanupPending ? "default" : "destructive"}
                    data-testid="confirm-delete-member"
                    busy={
                      isActionPending("delete-member") ||
                      isActionPending("save-policy")
                    }
                    disabled={
                      deleteDevices.length > 0 ||
                      Boolean(deleteImpact.blockedText && cleanupPolicyOnDelete)
                    }
                  >
                    {cleanupPending ? t("tryAgain") : copy.confirmDeleteMember}
                  </deleteMemberForm.SubmitButton>
                </AlertDialogFooter>
                {cleanupPending ? (
                  <p
                    className="text-sm text-muted-foreground"
                    data-testid="delete-member-cleanup-pending"
                  >
                    {copy.deleteMemberCleanupPending}
                  </p>
                ) : null}
                {actionError("delete-member") ? (
                  <p
                    className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                    data-testid="delete-member-error"
                  >
                    {actionError("delete-member")}
                  </p>
                ) : null}
                {actionError("save-policy") ? (
                  <p
                    className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                    data-testid="delete-member-policy-error"
                  >
                    {actionError("save-policy")}
                  </p>
                ) : null}
              </deleteMemberForm.Form>
            </deleteMemberForm.AppForm>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </section>
  );
}
