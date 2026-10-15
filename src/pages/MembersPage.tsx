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
import AssignMemberDialog, { type AssignMemberOption } from "@/components/AssignMemberDialog";
import CreateAuthKeyDialog from "@/components/CreateAuthKeyDialog";
import {
  type AuthKeyDialogDefaults,
  type AuthKeyDialogPayload,
  authKeyDialogLabels,
  authKeyDialogUser,
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
import { useCreatePreAuthKey } from "@/composables/useCreatePreAuthKey";
import { useDisplayHelpers } from "@/composables/useDisplayHelpers";
import { useMutation } from "@/composables/useMutation";
import { policyBlockedMessage, usePolicyDesigner } from "@/composables/usePolicyDesigner";
import { usePolicySave } from "@/composables/usePolicySave";
import { useProductCopy } from "@/composables/useProductCopy";
import { useRefreshGuard } from "@/composables/useRefreshGuard";
import { useRouteIntent } from "@/composables/useRouteIntent";
import { useSessionDraft } from "@/composables/useSessionDraft";
import { useSnapshot } from "@/composables/useSnapshot";
import { useSegment } from "@/composables/useSnapshotSegment";
import { isTimestampExpired as isExpired } from "@/domain/node-status";
import {
  addMemberToGroup,
  addOwnerToTag,
  type PolicyDesignerState,
  removeMemberFromGroup,
  removeOwnerFromTag,
  toMemberRef,
} from "@/domain/policy-designer";
import { retargetUserReferences } from "@/domain/policy-references";
import {
  policyPrincipalForUser,
  userNamePrincipal,
  userPolicyPrincipals,
} from "@/domain/principal";
import { useHeadscaleI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { downloadCsv } from "@/utils/csv";
import { nodePendingRoutes } from "@/utils/node";
import { nodeStatusClass } from "@/utils/status-class";
import { isEmailLike, type UserNameIssue, userNameIssue } from "@/utils/user";

const EMPTY_MEMBER_FORM = { name: "", displayName: "", email: "" };

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
    principals.length && !blocked ? retargetUserReferences(state, principals, null) : null;
  // Groups and tag owners are listed as labelled rows already.
  const sections = plan?.ok
    ? plan.sections.filter((section) => section !== "groups" && section !== "tagOwners")
    : [];
  const unsupported =
    plan && !plan.ok && plan.mentioned ? `${unsupportedLabel} ${plan.issue.paths.join(", ")}` : "";
  return {
    sections,
    blockedText: blocked ?? unsupported,
    hasReferences: references.length > 0 || sections.length > 0 || Boolean(unsupported),
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
  const { policy: policyStore, snapshot: snapshotStore, drafts } = useSession();
  const { stale } = useStore(drafts);
  const { copy } = useProductCopy();
  const { t } = useHeadscaleI18n();
  const {
    snapshot,
    refreshSnapshot,
    userById: currentUser,
    isReady,
    refreshErrors,
  } = useSnapshot();
  const { isRefreshing: isRefreshingSnapshot, refresh: refreshMembers } = useSegment("identity");
  const { isActionPending, actionError, clearActionFeedback } = useActionFeedback();
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
  const [selectedRenameUser, setSelectedRenameUser] = useState<HeadscaleUser | null>(null);
  const [pendingDeleteUser, setPendingDeleteUser] = useState<HeadscaleUser | null>(null);
  const [cleanupPolicyOnDelete, setCleanupPolicyOnDelete] = useState(true);
  const [updateReferencesOnRename, setUpdateReferencesOnRename] = useState(true);
  const [selectedDetailUser, setSelectedDetailUser] = useState<HeadscaleUser | null>(null);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [assignMembershipsTarget, setAssignMembershipsTarget] = useState<HeadscaleUser | null>(
    null,
  );
  const [assignTagOwnershipsTarget, setAssignTagOwnershipsTarget] = useState<HeadscaleUser | null>(
    null,
  );
  const membershipContext = useRef({ targetId: "", generation: 0 });
  const ownershipContext = useRef({ targetId: "", generation: 0 });
  const [policySaveNotice, setPolicySaveNotice] = useState<"newer" | "context" | null>(null);
  useEffect(
    () => () => {
      ++membershipContext.current.generation;
      ++ownershipContext.current.generation;
    },
    [],
  );

  const [memberForm, setMemberForm] = useState(EMPTY_MEMBER_FORM);
  // Field errors appear after the first submit attempt, then follow the input.
  const [createAttempted, setCreateAttempted] = useState(false);
  const [renameMemberForm, setRenameMemberForm] = useState({
    name: "",
  });
  // The name the server accepted in this dialog; set means only the policy update is left.
  const [renamedTo, setRenamedTo] = useState<string | null>(null);
  // Keyed, so a reloaded policy (new ids) drops the confirmation instead of saving a no-op.
  const [pendingReferenceKey, setPendingReferenceKey] = useState<string | null>(null);
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
  const inviteDialogGuard = useRefreshGuard();

  const isCreatingInvite = isActionPending("create-invite");

  const { formatDate, userLabel, nodeDisplayName, nodeStatusLabel, shortSecret, hasVisibleUser } =
    useDisplayHelpers();

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
      (key) => key.user?.id === user.id && !key.used && !isExpired(key.expiration),
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

  const selectedUserDevices = selectedDetailUser ? userDevices(selectedDetailUser) : [];
  const selectedUserActiveKeys = selectedDetailUser
    ? activeAuthKeysForUser(selectedDetailUser)
    : [];
  const selectedUserPolicyReferences = selectedDetailUser
    ? userPolicyReferences(userPolicyPrincipals(selectedDetailUser))
    : [];
  const pendingReference = selectedUserPolicyReferences.find(
    (reference) => `${reference.kind}-${reference.id}` === pendingReferenceKey,
  );

  const deletePrincipals = pendingDeleteUser ? userPolicyPrincipals(pendingDeleteUser) : [];
  // Headscale refuses to delete a user who still owns machines; its auth keys do not block it.
  const deleteDevices = pendingDeleteUser ? userDevices(pendingDeleteUser) : [];
  const deleteActiveKeys = pendingDeleteUser ? activeAuthKeysForUser(pendingDeleteUser) : [];
  const deleteReferences = userPolicyReferences(deletePrincipals);
  const deleteImpact = userReferenceImpact(
    policyDesignerState,
    deletePrincipals,
    policyBlocked,
    copy.policyReferenceUnsupported,
    deleteReferences,
  );
  // Derived, not stored: the user is gone from the snapshot but the policy cleanup has not landed.
  const userDeleted =
    pendingDeleteUser !== null && !snapshot.users.some((user) => user.id === pendingDeleteUser.id);
  const cleanupPending =
    userDeleted &&
    cleanupPolicyOnDelete &&
    deleteImpact.hasReferences &&
    !isActionPending("delete-member") &&
    !isActionPending("save-policy");

  // A rename only rewrites `name@`; email and provider principals keep resolving.
  const renameFrom = selectedRenameUser ? userNamePrincipal(selectedRenameUser.name) : "";
  const renamePrincipals = renameFrom ? [renameFrom] : [];
  const renameReferences = userPolicyReferences(renamePrincipals);
  const renameImpact = userReferenceImpact(
    policyDesignerState,
    renamePrincipals,
    policyBlocked,
    copy.policyReferenceUnsupported,
    renameReferences,
  );
  const renamePending = isActionPending("rename-member") || isActionPending("save-policy");
  // The server rename landed but the reference update did not: only the policy write is left.
  const renamePartial =
    renamedTo !== null && renameImpact.hasReferences && updateReferencesOnRename && !renamePending;
  const renameName = renameMemberForm.name.trim();
  const renameUnchanged = renameName === selectedRenameUser?.name;
  const renameNameIssue =
    selectedRenameUser && renamedTo === null && !renameUnchanged
      ? userNameIssue(renameName, snapshot.users, selectedRenameUser.id)
      : null;
  const renameConfirmDisabled =
    renamePending ||
    (renamedTo === null
      ? renameUnchanged || renameNameIssue !== null
      : renamePartial && Boolean(renameImpact.blockedText));

  const memberName = memberForm.name.trim();
  const memberEmail = memberForm.email.trim();
  const memberNameIssue = userNameIssue(memberName, snapshot.users);
  const memberEmailInvalid = memberEmail !== "" && !isEmailLike(memberEmail);
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
    ? userPolicyPrincipals(assignMembershipsTarget)
    : [];
  const assignMembershipsOptions: AssignMemberOption[] = assignMembershipsTarget
    ? policyGroups.map((group) => ({
        id: group.id,
        name: group.name,
        assigned: group.members.some((member) => membershipPrincipals.includes(member.value)),
        hint: group.members.length
          ? group.members.map((m) => m.value).join(", ")
          : copy.noPolicyGroupMembers,
      }))
    : [];

  const ownershipPrincipals = assignTagOwnershipsTarget
    ? userPolicyPrincipals(assignTagOwnershipsTarget)
    : [];
  const assignTagOwnershipsOptions: AssignMemberOption[] = assignTagOwnershipsTarget
    ? policyTagOwners.map((tagOwner) => ({
        id: tagOwner.id,
        name: tagOwner.tag,
        assigned: tagOwner.owners.some((owner) => ownershipPrincipals.includes(owner.value)),
        hint: tagOwner.owners.length
          ? tagOwner.owners.map((o) => o.value).join(", ")
          : copy.noPolicyTagOwnerEntries,
      }))
    : [];

  const authKeyDialogUsers = visibleUsers.map((user) => authKeyDialogUser(user, copy.unknown));

  const authKeyDialogDefaults = inviteForm;

  const { mutate, mutateWith } = useMutation();
  const createPreAuthKey = useCreatePreAuthKey();
  const { savePolicy } = usePolicySave();
  const latest = useRef({ consumeUserQuery, authKeyDialogUsers, inviteForm });
  latest.current = { consumeUserQuery, authKeyDialogUsers, inviteForm };

  function openMemberDialog() {
    clearActionFeedback("create-member");
    setMemberDialogOpen(true);
    void refreshSnapshot();
  }

  // The dialog has no trigger, so Base UI only reports dismissal. Closing discards the input.
  function closeMemberDialog() {
    if (isActionPending("create-member")) return;
    setMemberDialogOpen(false);
    setMemberForm(EMPTY_MEMBER_FORM);
    setCreateAttempted(false);
    clearActionFeedback("create-member");
  }

  // Headscale accepts names a policy cannot use and reports duplicates as raw database errors.
  async function createMember() {
    if (memberNameIssue || memberEmailInvalid) {
      setCreateAttempted(true);
      document.getElementById(memberNameIssue ? "member-name" : "member-email")?.focus();
      return;
    }
    const created = await mutate("create-member", {
      endpoint: "createUser",
      input: { name: memberName, displayName: memberForm.displayName, email: memberEmail },
    });
    if (created) closeMemberDialog();
  }

  function openUserDetails(user?: HeadscaleUser) {
    if (!hasVisibleUser(user)) return;
    const token = userDetailGuard.next();
    setSelectedDetailUser(user);
    void userDetailGuard.refresh(token, () => {
      const nextUser = currentUser(user.id);
      setSelectedDetailUser(nextUser && hasVisibleUser(nextUser) ? nextUser : null);
    });
  }

  // Leaving the details for another action never returns to the source page.
  function dismissUserDetails() {
    userDetailGuard.cancel();
    setSelectedDetailUser(null);
    setPendingReferenceKey(null);
  }

  // The dialog has no trigger, so Base UI only reports dismissal.
  function closeUserDetails() {
    dismissUserDetails();
    const fromPage = intent.from;
    if (fromPage && fromPage !== "members") {
      void navigate({ to: `/${fromPage}` });
    }
  }

  function openRenameMemberDialog(user: HeadscaleUser) {
    setPolicySaveNotice(null);
    clearActionFeedback("rename-member");
    clearActionFeedback("save-policy");
    setUpdateReferencesOnRename(true);
    setRenamedTo(null);
    setSelectedRenameUser(user);
    setRenameMemberForm((current) => ({ ...current, name: user.name }));
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry query consumption after the initial user snapshot arrives.
  useEffect(
    () => latest.current.consumeUserQuery(intent.userId),
    [intent.userId, intent.popup, snapshot.users],
  );

  function closeRenameDialog() {
    setSelectedRenameUser(null);
    setRenamedTo(null);
    setRenameMemberForm((current) => ({ ...current, name: "" }));
    clearActionFeedback("rename-member");
    clearActionFeedback("save-policy");
  }

  function handleRenameMemberDialogOpen(open: boolean) {
    if (open || renamePending) return;
    closeRenameDialog();
  }

  // Server first: Headscale decides whether the name is acceptable, then one policy write follows.
  // After a failed policy write the user is already renamed, so a retry only repeats that write.
  async function confirmRenameMember() {
    const user = selectedRenameUser;
    if (!user || renameConfirmDisabled) return;
    const isCurrentSession = snapshotStore.captureSession();
    let newName = renamedTo;
    if (newName === null) {
      const renamed = await mutateWith("rename-member", {
        endpoint: "renameUser",
        input: { id: user.id, newName: renameName },
      });
      if (!renamed.ok || !isCurrentSession()) return;
      newName = renamed.result.user.name;
      setRenamedTo(newName);
    }
    if (updateReferencesOnRename && renameImpact.hasReferences && !renameImpact.blockedText) {
      const to = userNamePrincipal(newName);
      if (to && to !== renameFrom) {
        const plan = retargetUserReferences(policyStore.policyDesignerState, [renameFrom], to);
        if (!plan.ok) return;
        const saved = await savePolicy("save-policy", plan.state, { targeted: true });
        if (!saved.ok) return;
        if (saved.hasNewerEdits) setPolicySaveNotice("newer");
      }
    }
    closeRenameDialog();
  }

  function requestDeleteMember(user: HeadscaleUser) {
    setPolicySaveNotice(null);
    clearActionFeedback("delete-member");
    clearActionFeedback("save-policy");
    setCleanupPolicyOnDelete(true);
    setPendingDeleteUser(user);
  }

  function closeDeleteDialog() {
    setPendingDeleteUser(null);
    clearActionFeedback("delete-member");
    clearActionFeedback("save-policy");
  }

  function handleDeleteMemberDialogOpen(open: boolean) {
    if (open || isActionPending("delete-member") || isActionPending("save-policy")) return;
    closeDeleteDialog();
  }

  async function confirmDeleteMember() {
    const user = pendingDeleteUser;
    // The confirm button is disabled in this state; the live policy store is the authority.
    const cleanupBlocked =
      cleanupPolicyOnDelete && (policyStore.getSnapshot().policyError || deleteImpact.blockedText);
    if (!user || cleanupBlocked) return;
    const cleanup = cleanupPolicyOnDelete && deleteImpact.hasReferences;
    setPolicySaveNotice(null);

    // Headscale alone decides whether a user can be deleted (it refuses users that still own
    // nodes), so delete first: a rejected delete must leave the live policy untouched. After a
    // failed cleanup the user is already gone, so a retry only repeats the cleanup.
    if (currentUser(user.id)) {
      if (!(await mutate("delete-member", { endpoint: "deleteUser", input: { id: user.id } })))
        return;
    }
    if (cleanup) {
      // Rebuild from the live draft; the targeted save refuses it if Access edits appeared meanwhile.
      const plan = retargetUserReferences(policyStore.policyDesignerState, deletePrincipals, null);
      if (!plan.ok) return;
      const saved = await savePolicy("save-policy", plan.state, { targeted: true });
      if (!saved.ok) return;
      if (saved.hasNewerEdits) setPolicySaveNotice("newer");
    }
    closeDeleteDialog();
  }

  async function removeUserFromPolicyReference(reference: UserPolicyReference) {
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
    setPolicySaveNotice(null);
    const saved = await savePolicy("save-policy", next, { targeted: true });
    if (saved.ok && saved.hasNewerEdits) setPolicySaveNotice("newer");
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
  }

  // The menu items are disabled for users without a policy principal, so the principal is non-empty.
  async function applyAssignMemberships(target: HeadscaleUser, selectedGroupIds: string[]) {
    const principal = policyPrincipalForUser(target);

    const context = { ...membershipContext.current };
    const isCurrentSession = snapshotStore.captureSession();
    const principals = userPolicyPrincipals(target);
    const selectedSet = new Set(selectedGroupIds);
    let next = policyDesignerState;
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
    setPolicySaveNotice(null);
    const saved = await savePolicy("assign-user-groups", next, { targeted: true });
    if (!saved.ok || !isCurrentSession()) return;
    if (saved.hasNewerEdits) {
      setPolicySaveNotice("newer");
      return;
    }
    if (
      context.targetId !== membershipContext.current.targetId ||
      context.generation !== membershipContext.current.generation
    ) {
      setPolicySaveNotice("context");
      return;
    }
    closeAssignMembershipsDialog();
  }

  // The menu items are disabled for users without a policy principal, so the principal is non-empty.
  async function applyAssignTagOwnerships(target: HeadscaleUser, selectedTagOwnerIds: string[]) {
    const principal = policyPrincipalForUser(target);

    const context = { ...ownershipContext.current };
    const isCurrentSession = snapshotStore.captureSession();
    const principals = userPolicyPrincipals(target);
    const selectedSet = new Set(selectedTagOwnerIds);
    let next = policyDesignerState;
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
    setPolicySaveNotice(null);
    const saved = await savePolicy("assign-user-tags", next, { targeted: true });
    if (!saved.ok || !isCurrentSession()) return;
    if (saved.hasNewerEdits) {
      setPolicySaveNotice("newer");
      return;
    }
    if (
      context.targetId !== ownershipContext.current.targetId ||
      context.generation !== ownershipContext.current.generation
    ) {
      setPolicySaveNotice("context");
      return;
    }
    closeAssignTagOwnershipsDialog();
  }

  function openInviteDialogForUser(user: HeadscaleUser) {
    const token = inviteDialogGuard.next();
    setInviteForm((current) => ({ ...current, user: user.id }));
    dismissUserDetails();
    clearActionFeedback("create-invite");
    setInviteDialogOpen(true);
    void inviteDialogGuard.refresh(token, () => {
      if (!latest.current.authKeyDialogUsers.some((u) => u.id === latest.current.inviteForm.user)) {
        setInviteForm((current) => ({
          ...current,
          user: latest.current.authKeyDialogUsers[0]?.id ?? "",
        }));
      }
    });
  }

  // The dialog has no trigger, so Base UI only reports dismissal.
  function closeInviteDialog() {
    if (isActionPending("create-invite")) return;
    setInviteDialogOpen(false);
    clearActionFeedback("create-invite");
    inviteDialogGuard.cancel();
  }

  async function createInvite(payload: AuthKeyDialogPayload) {
    setInviteForm(toAuthKeyDefaults(payload));
    if (await createPreAuthKey(payload)) {
      closeInviteDialog();
      void navigate({ to: "/invites" });
    }
  }

  function exportUsers() {
    downloadCsv(
      "headscale-users.csv",
      ["name", "email", "provider", "machines", "joined"],
      filteredUsers.map((user) => ({
        name: userLabel(user),
        email: user.email,
        provider: user.provider || user.providerId,
        machines: userDevices(user).length,
        joined: user.createdAt,
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
    const query: Record<string, string> = { node: node.id, from: "members", popup: "node" };
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
        <p className="mt-1 text-sm text-muted-foreground">{copy.membersSubtitle}</p>
      </div>

      {policySaveNotice && (
        <p role="status" data-testid="policy-save-notice" className="text-sm text-muted-foreground">
          {policySaveNotice === "newer"
            ? copy.policySavedNewerEdits
            : copy.policySaveContextChanged}
        </p>
      )}

      {policyBlocked && (
        <p
          role="alert"
          data-testid={policyError ? "members-policy-read-only" : "members-policy-unsaved"}
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {policyBlocked}
        </p>
      )}

      <Dialog open={memberDialogOpen} onOpenChange={closeMemberDialog}>
        <DialogContent data-testid="member-create-dialog" className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{copy.addMember}</DialogTitle>
            <DialogDescription>{copy.createMemberDescription}</DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-3"
            data-testid="member-form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              createMember();
            }}
          >
            <div>
              <Label htmlFor="member-name">{copy.memberName}</Label>
              <Input
                value={memberForm.name}
                onChange={(event) =>
                  setMemberForm((current) => ({ ...current, name: event.target.value }))
                }
                id="member-name"
                data-testid="member-name"
                className="mt-2"
                autoComplete="off"
                required
                aria-invalid={createAttempted && memberNameIssue !== null}
                aria-describedby={
                  createAttempted && memberNameIssue ? "member-name-error" : undefined
                }
              />
              {createAttempted && memberNameIssue ? (
                <p
                  id="member-name-error"
                  data-testid="member-name-error"
                  className="mt-1 text-sm text-destructive"
                >
                  {userNameIssueText[memberNameIssue]}
                </p>
              ) : null}
            </div>
            <div>
              <Label htmlFor="member-display">
                {copy.displayName}{" "}
                <span className="font-normal text-muted-foreground">{copy.optionalField}</span>
              </Label>
              <Input
                value={memberForm.displayName}
                onChange={(event) =>
                  setMemberForm((current) => ({ ...current, displayName: event.target.value }))
                }
                id="member-display"
                data-testid="member-display"
                className="mt-2"
              />
            </div>
            <div>
              <Label htmlFor="member-email">
                {copy.email}{" "}
                <span className="font-normal text-muted-foreground">{copy.optionalField}</span>
              </Label>
              <Input
                value={memberForm.email}
                onChange={(event) =>
                  setMemberForm((current) => ({ ...current, email: event.target.value }))
                }
                id="member-email"
                data-testid="member-email"
                type="email"
                className="mt-2"
                autoComplete="off"
                aria-invalid={createAttempted && memberEmailInvalid}
                aria-describedby={
                  createAttempted && memberEmailInvalid ? "member-email-error" : undefined
                }
              />
              {createAttempted && memberEmailInvalid ? (
                <p
                  id="member-email-error"
                  data-testid="member-email-error"
                  className="mt-1 text-sm text-destructive"
                >
                  {copy.emailInvalid}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                data-testid="cancel-create-member"
                disabled={isActionPending("create-member")}
                onClick={closeMemberDialog}
              >
                {copy.cancel}
              </Button>
              <Button
                type="submit"
                data-testid="create-member"
                disabled={isActionPending("create-member")}
              >
                {isActionPending("create-member") ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Plus className="h-4 w-4" aria-hidden="true" />
                )}
                {copy.createMember}
              </Button>
            </DialogFooter>
            {actionError("create-member") ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                data-testid="create-member-error"
              >
                {actionError("create-member")}
              </p>
            ) : null}
          </form>
        </DialogContent>
      </Dialog>

      <div className="space-y-2" data-testid="user-table-shell">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center" data-testid="user-toolbar">
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
                onChange={(event) => setUserSearch(event.target.value)}
                id="user-search"
                data-testid="user-search"
                className="ps-8"
                placeholder={copy.searchUsers}
              />
            </div>
          </div>
          <p
            role="status"
            data-testid="user-count"
            className="whitespace-nowrap text-xs text-muted-foreground sm:ms-auto"
          >
            <span aria-hidden="true">
              {filteredUsers.length} / {visibleUsers.length}
            </span>
            <span className="sr-only">
              {t("usersShown", { shown: filteredUsers.length, total: visibleUsers.length })}
            </span>
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
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
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
                <TableHead data-testid="member-devices-header">{copy.memberDevices}</TableHead>
                <TableHead>{copy.joined}</TableHead>
                <TableHead>{copy.authSource}</TableHead>
                <TableHead className="hidden lg:table-cell">{copy.actions}</TableHead>
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
                          <EllipsisVertical className="h-4 w-4" aria-hidden="true" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="start"
                          className="w-64"
                          data-testid={`member-actions-menu-mobile-${user.name}`}
                        >
                          <DropdownMenuGroup>
                            <DropdownMenuLabel>{copy.actions}</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              data-testid={`view-member-details-mobile-${user.name}`}
                              onClick={() => openUserDetails(user)}
                            >
                              <FileCheck2 className="h-4 w-4" aria-hidden="true" />
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
                              <KeyRound className="h-4 w-4" aria-hidden="true" />
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
                              disabled={Boolean(policyBlocked) || !policyPrincipalForUser(user)}
                              onClick={() => openAssignMembershipsDialog(user)}
                            >
                              <Users className="h-4 w-4" aria-hidden="true" />
                              {copy.addUserToGroup}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              data-testid={`assign-member-tags-mobile-${user.name}`}
                              disabled={Boolean(policyBlocked) || !policyPrincipalForUser(user)}
                              onClick={() => openAssignTagOwnershipsDialog(user)}
                            >
                              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
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
                                className={cn("cursor-pointer", nodeStatusClass(node))}
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
                        <span aria-hidden="true" className="text-muted-foreground">
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
                            <EllipsisVertical className="h-4 w-4" aria-hidden="true" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="end"
                            className="w-64"
                            data-testid={`member-actions-menu-${user.name}`}
                          >
                            <DropdownMenuGroup>
                              <DropdownMenuLabel>{copy.actions}</DropdownMenuLabel>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                data-testid={`view-member-details-${user.name}`}
                                onClick={() => openUserDetails(user)}
                              >
                                <FileCheck2 className="h-4 w-4" aria-hidden="true" />
                                {copy.viewDetails}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                data-testid={`view-member-machines-${user.name}`}
                                onClick={() => jumpToMachinesForUser(user)}
                              >
                                <Network className="h-4 w-4" aria-hidden="true" />
                                {copy.viewMachines}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                data-testid={`create-invite-for-member-${user.name}`}
                                onClick={() => openInviteDialogForUser(user)}
                              >
                                <KeyRound className="h-4 w-4" aria-hidden="true" />
                                {copy.createInvite}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                data-testid={`rename-member-${user.name}`}
                                onClick={() => openRenameMemberDialog(user)}
                              >
                                <Pencil className="h-4 w-4" aria-hidden="true" />
                                {copy.renameMember}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                data-testid={`assign-member-groups-${user.name}`}
                                disabled={Boolean(policyBlocked) || !policyPrincipalForUser(user)}
                                onClick={() => openAssignMembershipsDialog(user)}
                              >
                                <Users className="h-4 w-4" aria-hidden="true" />
                                {copy.addUserToGroup}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                data-testid={`assign-member-tags-${user.name}`}
                                disabled={Boolean(policyBlocked) || !policyPrincipalForUser(user)}
                                onClick={() => openAssignTagOwnershipsDialog(user)}
                              >
                                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                                {copy.grantTagToUser}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                variant="destructive"
                                data-testid={`delete-member-${user.name}`}
                                onClick={() => requestDeleteMember(user)}
                              >
                                <Trash2 className="h-4 w-4" aria-hidden="true" />
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
                      <span role="status" className="flex items-center gap-2">
                        <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
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

      <CreateAuthKeyDialog
        paused={stale !== null}
        open={inviteDialogOpen}
        users={authKeyDialogUsers}
        defaults={authKeyDialogDefaults}
        labels={authKeyDialogLabels(copy)}
        error={actionError("create-invite")}
        onOpenChange={closeInviteDialog}
        isSubmitting={isCreatingInvite}
        onSubmit={createInvite}
      />

      <Dialog open={Boolean(selectedDetailUser)} onOpenChange={closeUserDetails}>
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
                  <span className="truncate">{userLabel(selectedDetailUser)}</span>
                </DialogTitle>
                <DialogDescription>{copy.userDetails}</DialogDescription>
              </DialogHeader>

              <div className="grid gap-4">
                <div className="grid gap-2 sm:grid-cols-3">
                  <div className="rounded-md border bg-background p-3">
                    <p className="text-xs text-muted-foreground">{copy.userId}</p>
                    <p className="mt-1 text-sm font-medium">{selectedDetailUser.id}</p>
                  </div>
                  <div className="rounded-md border bg-background p-3">
                    <p className="text-xs text-muted-foreground">{copy.deviceCount}</p>
                    <p className="mt-1 text-sm font-medium">{selectedUserDevices.length}</p>
                  </div>
                  <div className="rounded-md border bg-background p-3">
                    <p className="text-xs text-muted-foreground">{copy.pendingRoutes}</p>
                    <p className="mt-1 text-sm font-medium">{selectedUserPendingRoutesCount}</p>
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
                    <h3 className="text-sm font-semibold">{copy.activeAuthKeys}</h3>
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
                      <p className="text-sm text-muted-foreground">{copy.noActiveAuthKeys}</p>
                    )}
                  </section>
                </div>

                <section className="grid gap-2">
                  <h3 className="text-sm font-semibold">{copy.personalDevices}</h3>
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
                            <span className="font-medium">{nodeDisplayName(node)}</span>
                            <Badge variant="outline" className={nodeStatusClass(node)}>
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
                    <p className="text-sm text-muted-foreground">{copy.noPersonalDevices}</p>
                  )}
                </section>

                <section className="grid gap-2">
                  <h3 className="text-sm font-semibold">{copy.policyReferences}</h3>
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
                            disabled={Boolean(policyBlocked) || isActionPending("save-policy")}
                            data-testid={`remove-user-policy-reference-${reference.kind}-${reference.id}`}
                            onClick={() =>
                              setPendingReferenceKey(`${reference.kind}-${reference.id}`)
                            }
                          >
                            <Trash2 className="h-3 w-3" aria-hidden="true" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">{copy.noPolicyReferences}</p>
                  )}
                  {pendingReference ? (
                    <div
                      className="grid gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm"
                      data-testid="remove-user-policy-reference-confirm"
                    >
                      <p>{copy.removeReferenceDescription}</p>
                      <p className="break-all font-medium">{pendingReference.label}</p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          data-testid="confirm-remove-user-policy-reference"
                          disabled={Boolean(policyBlocked) || isActionPending("save-policy")}
                          onClick={() => removeUserFromPolicyReference(pendingReference)}
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
          error={actionError("assign-user-groups")}
          notice={
            policySaveNotice === "newer"
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
          onApply={(ids) => applyAssignMemberships(assignMembershipsTarget, ids)}
        />
      ) : null}

      {assignTagOwnershipsTarget ? (
        <AssignMemberDialog
          open={assignTagOwnershipsOpen && !policyError}
          title={copy.assignTagOwnershipsTitle}
          description={copy.assignTagOwnershipsDescription}
          options={assignTagOwnershipsOptions}
          testidPrefix="assign-user-tags"
          error={actionError("assign-user-tags")}
          notice={
            policySaveNotice === "newer"
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
          onApply={(ids) => applyAssignTagOwnerships(assignTagOwnershipsTarget, ids)}
        />
      ) : null}

      <Dialog open={Boolean(selectedRenameUser)} onOpenChange={handleRenameMemberDialogOpen}>
        {selectedRenameUser ? (
          <DialogContent data-testid="rename-member-dialog">
            <DialogHeader>
              <DialogTitle>{copy.renameMemberTitle}</DialogTitle>
              <DialogDescription>{copy.renameMemberDescription}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="rename-member-name">{copy.memberName}</Label>
              <Input
                id="rename-member-name"
                value={renameMemberForm.name}
                disabled={renamedTo !== null}
                onChange={(event) =>
                  setRenameMemberForm((current) => ({ ...current, name: event.target.value }))
                }
                data-testid="rename-member-name"
                autoComplete="off"
                required
                aria-invalid={renameNameIssue !== null}
                aria-describedby={renameNameIssue ? "rename-member-name-error" : undefined}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    confirmRenameMember();
                  }
                }}
              />
              {renameNameIssue ? (
                <p
                  id="rename-member-name-error"
                  data-testid="rename-member-name-error"
                  className="text-sm text-destructive"
                >
                  {userNameIssueText[renameNameIssue]}
                </p>
              ) : null}
            </div>
            {renameImpact.hasReferences ? (
              <div className="grid gap-2" data-testid="rename-member-policy-impact">
                <ReferenceImpact
                  heading={copy.userImpactOnDeleteHeading}
                  blockedText={renameImpact.blockedText}
                  references={renameReferences}
                  sections={renameImpact.sections}
                  sectionTestId="rename-member-policy-section"
                />
                <label
                  htmlFor="rename-member-update-policy"
                  className="flex items-start gap-2 text-sm"
                >
                  <Checkbox
                    id="rename-member-update-policy"
                    checked={updateReferencesOnRename && !renameImpact.blockedText}
                    onCheckedChange={setUpdateReferencesOnRename}
                    disabled={renamePending || renamePartial || Boolean(renameImpact.blockedText)}
                    data-testid="rename-member-update-policy"
                  />
                  <span>{copy.renameUpdateReferencesOption}</span>
                </label>
              </div>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                data-testid="rename-member-cancel"
                disabled={renamePending}
                onClick={() => handleRenameMemberDialogOpen(false)}
              >
                {renamePartial ? copy.finish : copy.cancel}
              </Button>
              <Button
                type="button"
                data-testid="confirm-rename-member"
                disabled={renameConfirmDisabled}
                onClick={confirmRenameMember}
              >
                {renamePending ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : null}
                {renamePartial ? t("tryAgain") : copy.saveMemberName}
              </Button>
            </DialogFooter>
            {renamePartial ? (
              <p
                role="status"
                className="text-sm text-muted-foreground"
                data-testid="rename-member-policy-pending"
              >
                {copy.renameMemberPolicyPending}
              </p>
            ) : null}
            {actionError("rename-member") ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                data-testid="rename-member-error"
              >
                {actionError("rename-member")}
              </p>
            ) : null}
            {actionError("save-policy") ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                data-testid="rename-member-policy-error"
              >
                {actionError("save-policy")}
              </p>
            ) : null}
          </DialogContent>
        ) : null}
      </Dialog>

      <AlertDialog open={Boolean(pendingDeleteUser)} onOpenChange={handleDeleteMemberDialogOpen}>
        {pendingDeleteUser ? (
          <AlertDialogContent data-testid="delete-member-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>{copy.deleteMemberTitle}</AlertDialogTitle>
              <AlertDialogDescription>
                {copy.deleteMemberDescription}
                <span className="mt-2 block font-medium text-foreground">
                  {userLabel(pendingDeleteUser)}
                </span>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="grid gap-1 text-sm" data-testid="delete-member-summary">
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
              <div className="grid gap-2" data-testid="delete-member-policy-impact">
                <ReferenceImpact
                  heading={copy.userImpactOnDeleteHeading}
                  blockedText={deleteImpact.blockedText}
                  references={deleteReferences}
                  sections={deleteImpact.sections}
                  sectionTestId="delete-member-policy-section"
                />
                <label
                  htmlFor="delete-member-cleanup-policy"
                  className="flex items-start gap-2 text-sm"
                >
                  <Checkbox
                    id="delete-member-cleanup-policy"
                    checked={cleanupPolicyOnDelete}
                    onCheckedChange={setCleanupPolicyOnDelete}
                    disabled={
                      isActionPending("delete-member") ||
                      isActionPending("save-policy") ||
                      userDeleted
                    }
                    data-testid="delete-member-cleanup-policy"
                  />
                  <span>{copy.cleanupReferencesOption}</span>
                </label>
              </div>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel
                data-testid="cancel-delete-member"
                disabled={isActionPending("delete-member") || isActionPending("save-policy")}
              >
                {cleanupPending ? copy.finish : copy.cancel}
              </AlertDialogCancel>
              <Button
                type="button"
                variant={cleanupPending ? "default" : "destructive"}
                data-testid="confirm-delete-member"
                disabled={
                  deleteDevices.length > 0 ||
                  Boolean(deleteImpact.blockedText && cleanupPolicyOnDelete) ||
                  isActionPending("delete-member") ||
                  isActionPending("save-policy")
                }
                onClick={confirmDeleteMember}
              >
                {isActionPending("delete-member") || isActionPending("save-policy") ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : null}
                {cleanupPending ? t("tryAgain") : copy.confirmDeleteMember}
              </Button>
            </AlertDialogFooter>
            {cleanupPending ? (
              <p
                role="status"
                className="text-sm text-muted-foreground"
                data-testid="delete-member-cleanup-pending"
              >
                {copy.deleteMemberCleanupPending}
              </p>
            ) : null}
            {actionError("delete-member") ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                data-testid="delete-member-error"
              >
                {actionError("delete-member")}
              </p>
            ) : null}
            {actionError("save-policy") ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                data-testid="delete-member-policy-error"
              >
                {actionError("save-policy")}
              </p>
            ) : null}
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </section>
  );
}
