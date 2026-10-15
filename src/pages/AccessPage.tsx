import {
  Database,
  Eraser,
  FileCheck2,
  Laptop,
  LoaderCircle,
  Network,
  Plus,
  RotateCcw,
  Search,
  Server,
  ShieldAlert,
  ShieldCheck,
  Tag,
  Trash2,
  Users,
  UserX,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import MemberPicker, { type MemberOption } from "@/components/MemberPicker";
import IpRuleRow from "@/components/policy/IpRuleRow";
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
import { useSession, useStore } from "@/composables/session-context";
import { useActionFeedback } from "@/composables/useActionFeedback";
import { useMutation } from "@/composables/useMutation";
import {
  POLICY_FILE_MODE_WITHOUT_PATH,
  policyBlockedMessage,
  usePolicyDesigner,
} from "@/composables/usePolicyDesigner";
import { usePolicySave } from "@/composables/usePolicySave";
import { useProductCopy } from "@/composables/useProductCopy";
import { useSessionDraft } from "@/composables/useSessionDraft";
import { useSnapshot } from "@/composables/useSnapshot";
import {
  addMemberToGroupByName,
  createGroup,
  createRule,
  createTagOwner,
  findOrphanReferences,
  isPolicyIdentityName,
  type PolicyDesignerState,
  type PolicyGroup,
  parsePolicy,
  removeMemberFromGroupByName,
  removeOrphanReferences,
  removeOwnerFromTagByName,
  removeRuleById,
  toMemberRef,
  upsertGroup,
  upsertTagOwner,
} from "@/domain/policy-designer";
import {
  type PolicyReferenceIssue,
  type PolicyReferenceResult,
  policyAliases,
  removePolicyGroup,
  removePolicyTag,
  renamePolicyGroup,
  renamePolicyTag,
} from "@/domain/policy-references";
import {
  applyTemplate,
  POLICY_TEMPLATES,
  type PolicyTemplate,
  rulesReplacedByTemplate,
} from "@/domain/policy-templates";
import {
  getGroupAccess,
  getIpRules,
  getOpenAccessWarnings,
  getTagAccessors,
  hasOnlyDefaultAccess,
  type IpRule,
  listTagsFromState,
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
import { cn } from "@/lib/utils";

// The add-rule form reuses the IP rule editor with a rule that is not in the policy yet.
const NEW_IP_RULE: IpRule = { ruleId: "new", source: "", destination: "", ports: "" };

export default function AccessPage() {
  const { policy: policyStore, snapshot: snapshotStore, client } = useSession();
  const { locale, meta } = useHeadscaleI18n();
  const { copy } = useProductCopy();
  const { snapshot } = useSnapshot();
  const { isActionPending, actionError, clearActionFeedback } = useActionFeedback();
  const {
    policyRules,
    policyGroups,
    policyTagOwners,
    policyDesignerState,
    policyDraft,
    policyError,
    policyPayload,
    isPolicyDirty,
    isPolicyEditing,
    isPolicySaving,
    editRevision,
    editingIpRuleId,
    tagDetailOpen,
    tagDetailCurrent,
    teamDetailOpen,
    teamDetailCurrent,
    highRiskConfirmOpen,
    pendingHighRiskAction,
    policyRemovalDialogOpen,
    pendingPolicyRemoval,
    commitState,
    closeAccessEditors,
    setState: setPolicyState,
  } = usePolicyDesigner();

  useEffect(() => closeAccessEditors, [closeAccessEditors]);

  // A dry run: no save ticket, no refresh, no draft or dirty-state change.
  const { mutate: runCheck } = useMutation({ skipRefresh: true });
  // A check result, passed or failed, only describes the draft text it was run on.
  const [checked, setChecked] = useState<{ text: string; ok: boolean } | null>(null);
  // Byte-identical to the text a save would submit. Without a payload the check button is
  // disabled, so the "null" text this yields is never sent.
  const draftText = JSON.stringify(policyPayload, null, 2);
  const { identity } = useStore(client);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A result must not carry over to another server or session.
  useEffect(() => setChecked(null), [identity]);
  async function checkDraft() {
    setChecked(null);
    const text = draftText;
    const ok = await runCheck("check-policy", { endpoint: "checkPolicy", input: { policy: text } });
    setChecked({ text, ok });
  }
  const checkResult = checked?.text === draftText ? checked : null;

  const [tagSearchQuery, setTagSearchQuery] = useState("");

  const visibleUsers = snapshot.users.filter((user) => user.name !== "tagged-devices");
  const knownUserIndex = PrincipalIndex.fromUsers(snapshot.users);

  const allTags = Array.from(
    new Set([
      ...listTagsFromState(policyDesignerState),
      ...snapshot.nodes.flatMap((node) => node.tags).filter((tag) => tag.startsWith("tag:")),
    ]),
  ).sort();

  interface TagMeta {
    tagName: string;
    displayName: string;
    owners: string[];
    accessors: TagAccessor[];
    deviceCount: number;
    // Carried by devices but never named by the policy, so rename and delete have nothing to change.
    deviceOnly: boolean;
  }

  const aliases = policyAliases(policyDesignerState);
  const deviceCountFor = (tagName: string) =>
    snapshot.nodes.filter((node) => node.tags.includes(tagName)).length;
  const tagsWithMeta: TagMeta[] = allTags.map((tagName) => {
    const ownerEntry = policyTagOwners.find((o) => o.tag === tagName);
    return {
      tagName,
      displayName: stripTagPrefix(tagName),
      owners: ownerEntry ? ownerEntry.owners.map((o) => o.value) : [],
      accessors: getTagAccessors(policyDesignerState, tagName),
      deviceCount: deviceCountFor(tagName),
      deviceOnly: !aliases.has(tagName),
    };
  });

  const query = tagSearchQuery.trim().toLowerCase();
  const filteredTagsWithMeta = query
    ? tagsWithMeta.filter(
        (t) =>
          t.displayName.toLowerCase().includes(query) ||
          t.tagName.toLowerCase().includes(query) ||
          t.accessors.some((a) => a.who.toLowerCase().includes(query)) ||
          t.owners.some((o) => o.toLowerCase().includes(query)),
      )
    : tagsWithMeta;

  interface TeamMeta {
    group: PolicyGroup;
    displayName: string;
    accessRows: ReturnType<typeof getGroupAccess>;
  }

  const teamsWithMeta: TeamMeta[] = policyGroups.map((group) => ({
    group,
    displayName: stripGroupPrefix(group.name),
    accessRows: getGroupAccess(policyDesignerState, group.name),
  }));

  const openAccessWarnings = getOpenAccessWarnings(policyDesignerState);
  const orphanRefs = findOrphanReferences(policyDesignerState, knownUserIndex);
  const ipRules = getIpRules(policyDesignerState);

  const hasGrants = Array.isArray(policyDesignerState.extras.grants);
  // Headscale ACLs are an allow-list: without ACLs or grants nothing can connect.
  const allowsNothing = policyRules.length === 0 && !hasGrants;

  const isEmptyState =
    !hasGrants &&
    policyGroups.length === 0 &&
    policyTagOwners.length === 0 &&
    (policyRules.length === 0 || hasOnlyDefaultAccess(policyDesignerState));

  const currentTagMeta = tagDetailCurrent
    ? tagsWithMeta.find((t) => t.tagName === tagDetailCurrent)
    : undefined;
  const currentTeamMeta = teamDetailCurrent
    ? teamsWithMeta.find((t) => t.group.name === teamDetailCurrent)
    : undefined;

  const [tagNameDraft, setTagNameDraft] = useState("");
  const [teamNameDraft, setTeamNameDraft] = useState("");
  const closeGeneration = useRef(0);
  // Stamped with the edit revision it was raised at; any later edit, discard or load hides it.
  const [saveNotice, setSaveNotice] = useState<{
    kind: "newer" | "context";
    revision: number;
  } | null>(null);
  const saving = isActionPending("save-policy") || isPolicySaving;
  const [identityIssue, setIdentityIssue] = useState<PolicyReferenceIssue | null>(null);
  function identityErrorText(issue: PolicyReferenceIssue, kind: "group" | "tag") {
    const messages = {
      "invalid-name": kind === "group" ? copy.teamNameInvalid : copy.labelNameInvalid,
      "name-conflict": copy.policyReferenceNameConflict,
      "entity-not-found": copy.policyReferenceEntityMissing,
      "unreadable-policy": copy.policyReadOnlyError,
      "unsupported-reference": copy.policyReferenceUnsupported,
    };
    return `${messages[issue.code]}${issue.paths.length ? ` ${issue.paths.join(", ")}` : ""}`;
  }
  function applyIdentityResult(result: PolicyReferenceResult) {
    if (!result.ok) {
      setIdentityIssue(result.issue);
      return false;
    }
    setIdentityIssue(null);
    commitState(result.state);
    return true;
  }
  // Runs on every keystroke, so a stale error never outlives the text it was about. A rename can
  // still be refused on commit for references this cannot see.
  function nameIssue(
    kind: "group" | "tag",
    draft: string,
    current: string,
  ): PolicyReferenceIssue | null {
    const fullName = kind === "group" ? withGroupPrefix(draft) : withTagPrefix(draft);
    if (!fullName || fullName === current) return null;
    if (!isPolicyIdentityName(fullName, kind)) return { code: "invalid-name", paths: [] };
    const taken = current
      ? aliases.has(fullName)
      : kind === "group"
        ? policyGroups.some((group) => group.name === fullName)
        : allTags.includes(fullName);
    return taken ? { code: "name-conflict", paths: [] } : null;
  }

  useEffect(
    () => () => {
      ++closeGeneration.current;
    },
    [],
  );

  useEffect(() => {
    ++closeGeneration.current;
    setTagNameDraft(tagDetailOpen ? stripTagPrefix(tagDetailCurrent) : "");
  }, [tagDetailOpen, tagDetailCurrent]);

  useEffect(() => {
    ++closeGeneration.current;
    setTeamNameDraft(teamDetailOpen ? stripGroupPrefix(teamDetailCurrent) : "");
  }, [teamDetailOpen, teamDetailCurrent]);

  // Port drafts are text typed by the user (or retained under "all") that is not in the
  // policy. They live only while one tag dialog is open and are scoped to (tag, principal).
  const portDraftKey = (who: string) => JSON.stringify([tagDetailCurrent, who]);
  const [customPortDrafts, setCustomPortDrafts] = useState<Record<string, string>>({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: Drafts reset whenever the tag dialog opens, closes or switches tag.
  useEffect(() => {
    setCustomPortDrafts({});
  }, [tagDetailOpen, tagDetailCurrent]);

  function setPortDraft(key: string, value: string | undefined) {
    setCustomPortDrafts(({ [key]: _dropped, ...rest }) =>
      value === undefined ? rest : { ...rest, [key]: value },
    );
  }

  function customPortsFor(accessor: TagAccessor) {
    return customPortDrafts[portDraftKey(accessor.who)] ?? accessor.customPorts;
  }

  const SERVICE_DEFS = [
    { id: "ssh", labelKey: "svcSshLabel", hintKey: "svcSshHint" },
    { id: "web", labelKey: "svcWebLabel", hintKey: "svcWebHint" },
    { id: "rdp", labelKey: "svcRdpLabel", hintKey: "svcRdpHint" },
    { id: "dns", labelKey: "svcDnsLabel", hintKey: "svcDnsHint" },
  ] as const;

  function pluralize(count: number, key: CountMessage) {
    return formatCount(locale, key, count);
  }

  const orphanValueSet = new Set(orphanRefs.map((r) => r.value));

  function isOrphanValue(value: string) {
    return orphanValueSet.has(value);
  }

  function whoDisplayLabel(value: string): string {
    if (value === "*") return copy.allUsersChoice;
    if (value.startsWith("group:")) return stripGroupPrefix(value);
    if (value.startsWith("tag:")) return stripTagPrefix(value);
    return value;
  }

  function whoDisplayKind(value: string): string {
    if (value === "*") return copy.optionGroupSpecial;
    if (value.startsWith("group:")) return copy.optionGroupTeams;
    if (value.startsWith("tag:")) return copy.optionGroupLabels;
    return copy.optionGroupUsers;
  }

  function serviceSummary(services: ServiceId[], customPorts: string): string {
    if (services.includes("all")) {
      return copy.svcAllLabel;
    }
    // Service ids only come from the policy-views presets, which SERVICE_DEFS lists in full.
    const parts: string[] = services.flatMap((id) =>
      SERVICE_DEFS.filter((def) => def.id === id).map((def) => copy[def.labelKey]),
    );
    if (customPorts) parts.push(customPorts);
    return parts.length > 0 ? parts.join(" · ") : copy.svcCustomLabel;
  }

  function tagIcon(tagName: string) {
    const lower = tagName.toLowerCase();
    if (lower.includes("server")) return Server;
    if (lower.includes("work") || lower.includes("laptop")) return Laptop;
    if (lower.includes("db") || lower.includes("data")) return Database;
    if (lower.includes("net") || lower.includes("router")) return Network;
    return Tag;
  }

  function userPickerOptions(
    selectedValues: readonly string[],
    groupOrder: number,
  ): MemberOption[] {
    const opts: MemberOption[] = [];
    for (const user of visibleUsers) {
      const id = policyPrincipalForUser(user);
      if (!id) continue;
      if (selectedValues.some((value) => userMatchesPolicyValue(user, value))) continue;
      opts.push({
        value: id,
        label: user.displayName || user.name || id,
        description: user.email || undefined,
        group: copy.optionGroupUsers,
        groupOrder,
      });
    }
    return opts;
  }

  function buildAccessOptions(selectedValues: readonly string[]): MemberOption[] {
    const opts: MemberOption[] = [];
    const takenGroups = new Set(selectedValues.map((value) => toPrincipal(value)));
    for (const group of policyGroups) {
      if (takenGroups.has(toPrincipal(group.name))) continue;
      opts.push({
        value: group.name,
        label: stripGroupPrefix(group.name),
        description: pluralize(group.members.length, "teamMembers"),
        group: copy.optionGroupTeams,
        groupOrder: 1,
      });
    }
    opts.push(...userPickerOptions(selectedValues, 2));
    return opts;
  }

  const tagOwnerValues = currentTagMeta?.owners ?? [];
  const teamMembers = currentTeamMeta?.group.members ?? [];
  const teamAccessRows = currentTeamMeta?.accessRows ?? [];
  const accessorOptionsForCurrentTag = buildAccessOptions(
    (currentTagMeta?.accessors ?? []).map((a) => a.who),
  );
  const ownerOptionsForCurrentTag = buildAccessOptions(tagOwnerValues);
  const memberOptionsForCurrentTeam = userPickerOptions(
    teamMembers.map((member) => member.value),
    1,
  );

  // The dialog's opening state: closing without saving reverts to it, and a dialog that was
  // never edited closes without a prompt even while the page holds unsaved edits.
  const dialogBase = useRef<{ revision: number; state: PolicyDesignerState } | null>(null);
  function markDialogOpened() {
    dialogBase.current = {
      revision: policyStore.getSnapshot().editRevision,
      state: policyStore.policyDesignerState,
    };
  }

  function openCreateTeam() {
    markDialogOpened();
    setIdentityIssue(null);
    ++closeGeneration.current;
    setPolicyState({ teamDetailCurrent: "" });
    setPolicyState({ teamDetailOpen: true });
  }

  function openTeamDetailFor(group: PolicyGroup) {
    markDialogOpened();
    setIdentityIssue(null);
    ++closeGeneration.current;
    setPolicyState({ teamDetailCurrent: group.name });
    setPolicyState({ teamDetailOpen: true });
  }

  function commitTeamName() {
    const fullName = withGroupPrefix(teamNameDraft);
    const issue = nameIssue("group", teamNameDraft, teamDetailCurrent);
    setIdentityIssue(issue);
    // A blank name, or blurring an existing team without editing its name, is not an edit.
    if (issue || !fullName || teamDetailCurrent === fullName) return;

    if (!teamDetailCurrent) {
      const newGroup = createGroup(fullName, []);
      commitState(upsertGroup(policyDesignerState, newGroup));
      setPolicyState({ teamDetailCurrent: fullName });
      return;
    }

    const old = policyGroups.find((g) => g.name === teamDetailCurrent);
    if (!old) return;

    if (!applyIdentityResult(renamePolicyGroup(policyDesignerState, old.id, fullName))) return;
    setPolicyState({ teamDetailCurrent: fullName });
  }

  function addTeamMember(value: string) {
    commitState(addMemberToGroupByName(policyDesignerState, teamDetailCurrent, toMemberRef(value)));
  }

  function removeTeamMember(value: string) {
    commitState(removeMemberFromGroupByName(policyDesignerState, teamDetailCurrent, value));
  }

  function openCreateTag() {
    markDialogOpened();
    setIdentityIssue(null);
    ++closeGeneration.current;
    setPolicyState({ tagDetailCurrent: "" });
    setPolicyState({ tagDetailOpen: true });
  }

  function openTagDetailFor(tagName: string) {
    markDialogOpened();
    setIdentityIssue(null);
    ++closeGeneration.current;
    setPolicyState({ tagDetailCurrent: tagName });
    setPolicyState({ tagDetailOpen: true });
  }

  function commitTagName() {
    const fullName = withTagPrefix(tagNameDraft);
    const issue = nameIssue("tag", tagNameDraft, tagDetailCurrent);
    setIdentityIssue(issue);
    if (issue || !fullName || tagDetailCurrent === fullName) return;

    if (!tagDetailCurrent) {
      const newOwner = createTagOwner(fullName, []);
      commitState(upsertTagOwner(policyDesignerState, newOwner));
      setPolicyState({ tagDetailCurrent: fullName });
      return;
    }

    if (!applyIdentityResult(renamePolicyTag(policyDesignerState, tagDetailCurrent, fullName)))
      return;
    setPolicyState({ tagDetailCurrent: fullName });
  }

  function ensureTagOwnerEntry(tagName: string): PolicyDesignerState {
    if (policyTagOwners.some((o) => o.tag === tagName)) {
      return policyDesignerState;
    }
    return upsertTagOwner(policyDesignerState, createTagOwner(tagName, []));
  }

  function addLabelManager(value: string) {
    let next = ensureTagOwnerEntry(tagDetailCurrent);
    const entry = next.tagOwners.find((o) => o.tag === tagDetailCurrent);
    if (!entry) {
      // The editor cannot define this label's name, so it cannot hold an owner entry for it.
      setIdentityIssue({ code: "invalid-name", paths: [] });
      return;
    }
    const updated = {
      ...entry,
      owners: [...entry.owners, toMemberRef(value)],
    };
    next = upsertTagOwner(next, updated);
    commitState(next);
  }

  function removeLabelManager(value: string) {
    commitState(removeOwnerFromTagByName(policyDesignerState, tagDetailCurrent, value));
  }

  function addAccessor(value: string) {
    // The picker lists every policy group, and a group named "*" would grant access to everyone.
    if (value === "*") return;
    commitState(setTagAccessor(policyDesignerState, tagDetailCurrent, value, "22"));
  }

  function removeAccessor(who: string) {
    setPortDraft(portDraftKey(who), undefined);
    commitState(removeTagAccessor(policyDesignerState, tagDetailCurrent, who));
  }

  // Read-only accessors render disabled controls, so these handlers only run for editable rows.
  function toggleAccessorService(accessor: TagAccessor, serviceId: ServiceId) {
    let nextServices = [...accessor.services];
    if (serviceId === "all") {
      nextServices = nextServices.includes("all") ? [] : ["all"];
    } else if (nextServices.includes(serviceId)) {
      nextServices = nextServices.filter((s) => s !== serviceId);
    } else {
      nextServices = nextServices.filter((s) => s !== "all").concat(serviceId);
    }

    applyAccessorServices(accessor.who, nextServices, customPortsFor(accessor));
  }

  function applyAccessorServices(who: string, services: ServiceId[], custom: string) {
    const ports = servicesToPortsString(services, custom);
    const key = portDraftKey(who);
    if (!ports) {
      setPortDraft(key, undefined);
      commitState(removeTagAccessor(policyDesignerState, tagDetailCurrent, who));
      return;
    }

    const isHighRisk = ports === "*" || who === "*";
    const run = () => {
      commitState(setTagAccessor(policyDesignerState, tagDetailCurrent, who, ports));
      // Only "*" drops the custom ports from the policy, so only then is the text retained.
      setPortDraft(key, ports === "*" ? custom : undefined);
    };
    if (isHighRisk) {
      setPolicyState({ pendingHighRiskAction: run });
      setPolicyState({ highRiskConfirmOpen: true });
    } else {
      run();
    }
  }

  function commitCustomPorts(accessor: TagAccessor) {
    const draft = customPortDrafts[portDraftKey(accessor.who)];
    // Nothing typed, or the same effective ports: a plain blur must not rewrite the policy.
    if (draft === undefined) return;
    if (
      servicesToPortsString(accessor.services, draft) ===
      servicesToPortsString(accessor.services, accessor.customPorts)
    )
      return;
    applyAccessorServices(accessor.who, accessor.services, draft);
  }

  function confirmHighRisk() {
    const fn = pendingHighRiskAction;
    if (fn) fn();
    setPolicyState({ pendingHighRiskAction: null });
    setPolicyState({ highRiskConfirmOpen: false });
  }

  function cancelHighRisk() {
    setPolicyState({ pendingHighRiskAction: null });
    setPolicyState({ highRiskConfirmOpen: false });
  }

  function requestRemoveTeam(group: PolicyGroup) {
    setPolicyState({
      pendingPolicyRemoval: {
        kind: "group",
        id: group.id,
        label: stripGroupPrefix(group.name),
      },
    });
    setPolicyState({ policyRemovalDialogOpen: true });
  }

  function requestRemoveTag(tagName: string) {
    const entry = policyTagOwners.find((o) => o.tag === tagName);
    setPolicyState({
      pendingPolicyRemoval: {
        kind: "tagOwner",
        id: entry?.id ?? `inline-${tagName}`,
        label: stripTagPrefix(tagName),
      },
    });
    setPolicyState({ policyRemovalDialogOpen: true });
  }

  // The dialog has no trigger, so Base UI only ever asks to close it.
  function closePolicyRemovalDialog() {
    setPolicyState({ policyRemovalDialogOpen: false });
    window.setTimeout(() => {
      if (!policyStore.getSnapshot().policyRemovalDialogOpen) {
        setPolicyState({ pendingPolicyRemoval: null });
      }
    });
  }

  function requestRemoveIpRule(rule: IpRule) {
    setPolicyState({
      pendingPolicyRemoval: {
        kind: "rule",
        id: rule.ruleId,
        label: `${rule.source} → ${rule.destination} · ${rule.ports}`,
      },
    });
    setPolicyState({ policyRemovalDialogOpen: true });
  }

  const removalKind = pendingPolicyRemoval?.kind === "group" ? "group" : "tag";
  const removalTag =
    pendingPolicyRemoval?.kind === "tagOwner"
      ? (policyTagOwners.find((owner) => owner.id === pendingPolicyRemoval.id)?.tag ??
        withTagPrefix(pendingPolicyRemoval.label))
      : "";
  const removalPreview: PolicyReferenceResult | null =
    pendingPolicyRemoval?.kind === "group"
      ? removePolicyGroup(policyDesignerState, pendingPolicyRemoval.id)
      : pendingPolicyRemoval?.kind === "rule"
        ? { ok: true, state: removeRuleById(policyDesignerState, pendingPolicyRemoval.id) }
        : removalTag
          ? removePolicyTag(policyDesignerState, removalTag)
          : null;
  const removalNext = removalPreview?.ok ? removalPreview.state : null;
  // Headscale keeps a deleted label on the devices that carry it.
  const removalDevices = removalTag ? deviceCountFor(removalTag) : 0;
  // Only built for a removal that previews cleanly; the confirm button is disabled otherwise.
  const confirmRemovePolicyItem = removalNext
    ? () => {
        setIdentityIssue(null);
        commitState(removalNext);
        setPolicyState({ pendingPolicyRemoval: null });
        setPolicyState({ policyRemovalDialogOpen: false });
      }
    : undefined;
  const affected = (before: readonly unknown[], after: readonly unknown[]) =>
    before.filter(
      (entry) => !after.some((candidate) => JSON.stringify(candidate) === JSON.stringify(entry)),
    ).length;
  const extraImpact = (section: string) => {
    const before = policyDesignerState.extras[section];
    const after = removalNext?.extras[section];
    return affected(Array.isArray(before) ? before : [], Array.isArray(after) ? after : []);
  };
  // A single rule's removal has no references to count; its consequence is stated instead.
  const removalImpact =
    removalNext && pendingPolicyRemoval?.kind !== "rule"
      ? {
          rules:
            affected(policyRules, removalNext.rules) +
            extraImpact("ssh") +
            extraImpact("grants") +
            extraImpact("nodeAttrs"),
          tests: extraImpact("tests") + extraImpact("sshTests"),
        }
      : null;

  function onUpdateIpRule(
    ruleId: string,
    patch: { source: string; destination: string; ports: string },
  ) {
    commitState(updateIpRule(policyDesignerState, ruleId, patch));
    setPolicyState({ editingIpRuleId: null });
  }

  const addIpRuleButton = useRef<HTMLButtonElement>(null);
  function closeNewIpRule() {
    setPolicyState({ editingIpRuleId: null });
    addIpRuleButton.current?.focus();
  }

  function addIpRule({
    source,
    destination,
    ports,
  }: {
    source: string;
    destination: string;
    ports: string;
  }) {
    commitState({
      ...policyDesignerState,
      rules: [...policyDesignerState.rules, createRule(source, destination, ports)],
    });
    closeNewIpRule();
  }

  // A template that replaces rules (the open default) is applied only after a confirmation.
  const [pendingTemplate, setPendingTemplate] = useState<PolicyTemplate | null>(null);
  const replacedRules = pendingTemplate
    ? rulesReplacedByTemplate(policyDesignerState, pendingTemplate)
    : [];
  function applyPolicyTemplate(template: PolicyTemplate) {
    if (rulesReplacedByTemplate(policyDesignerState, template).length > 0) {
      setPendingTemplate(template);
      return;
    }
    commitState(applyTemplate(policyDesignerState, template));
  }
  function confirmPolicyTemplate() {
    if (pendingTemplate) commitState(applyTemplate(policyDesignerState, pendingTemplate));
    setPendingTemplate(null);
  }

  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  function discardPolicyChanges() {
    setDiscardConfirmOpen(false);
    clearActionFeedback("save-policy");
    setPolicyState({ editingIpRuleId: null });
    // A server policy withheld during the edits is applied once the draft is clean again.
    commitState(parsePolicy(policyDraft));
  }

  const { savePolicy: savePolicyDocument } = usePolicySave();

  function showSaveNotice(kind: "newer" | "context") {
    setSaveNotice({ kind, revision: policyStore.getSnapshot().editRevision });
  }

  async function savePolicy() {
    setSaveNotice(null);
    const result = await savePolicyDocument("save-policy", policyStore.policyDesignerState);
    if (result.ok) {
      // The server now holds every edit made so far, so reverting to the open-time state would undo them.
      dialogBase.current = null;
      if (result.hasNewerEdits) showSaveNotice("newer");
    }
    return result;
  }

  const saveMessage = actionError("save-policy");
  const saveNoticeText =
    saveNotice?.revision === editRevision
      ? saveNotice.kind === "newer"
        ? copy.policySavedNewerEdits
        : copy.policySaveContextChanged
      : "";
  const hasSaveFeedback = Boolean(saveMessage || saveNoticeText);

  function renderSaveFeedback(prefix: "" | "dialog-") {
    return (
      <>
        {saveNoticeText && (
          <p
            role="status"
            data-testid={`${prefix}policy-save-notice`}
            className="text-sm text-muted-foreground"
          >
            {saveNoticeText}
          </p>
        )}
        {saveMessage && (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            data-testid={`${prefix}save-policy-error`}
          >
            {saveMessage}
          </p>
        )}
      </>
    );
  }

  type PendingClose = "tag" | "team" | null;
  const [pendingDialogClose, setPendingDialogClose] = useState<PendingClose>(null);
  const [unsavedConfirmOpen, setUnsavedConfirmOpen] = useState(false);

  // "Done": the dialog's edits stay in the page draft, which the page-level Save publishes.
  function closeDialog(which: Exclude<PendingClose, null>) {
    ++closeGeneration.current;
    setPolicyState(which === "tag" ? { tagDetailOpen: false } : { teamDetailOpen: false });
  }

  // X, Escape and the backdrop (the dialogs have no trigger, so Base UI only ever asks to close
  // them): edits made in this dialog need an explicit choice.
  function attemptDialogClose(which: Exclude<PendingClose, null>) {
    if (saving) return;
    const base = dialogBase.current;
    if (isPolicyDirty && (!base || base.revision !== policyStore.getSnapshot().editRevision)) {
      ++closeGeneration.current;
      setPendingDialogClose(which);
      setUnsavedConfirmOpen(true);
      return;
    }
    closeDialog(which);
  }

  function closePendingDialog() {
    // Only the unsaved-changes dialog calls this, and it opens together with pendingDialogClose.
    closeDialog(pendingDialogClose === "tag" ? "tag" : "team");
    setPendingDialogClose(null);
  }

  function discardAndClose() {
    setUnsavedConfirmOpen(false);
    clearActionFeedback("save-policy");
    // Revert only this dialog session's edits, so page-level edits made before it opened
    // survive. Without a baseline (or after a save) fall back to the last saved snapshot.
    // `parsePolicy("")` is well-defined (returns `emptyState`), so a blank draft still resets.
    commitState(dialogBase.current?.state ?? parsePolicy(policyDraft));
    closePendingDialog();
  }

  async function saveAndClose() {
    setUnsavedConfirmOpen(false);
    const context = {
      targetId: pendingDialogClose === "tag" ? tagDetailCurrent : teamDetailCurrent,
      generation: closeGeneration.current,
    };
    const isCurrentSession = snapshotStore.captureSession();
    const saved = await savePolicy();
    if (!isCurrentSession()) return;
    const current = policyStore.getSnapshot();
    const targetId =
      pendingDialogClose === "tag" ? current.tagDetailCurrent : current.teamDetailCurrent;
    if (context.generation !== closeGeneration.current || context.targetId !== targetId) {
      if (saved.ok) showSaveNotice("context");
      return;
    }
    if (saved.ok && !saved.hasNewerEdits && !policyStore.isPolicyDirty) closePendingDialog();
    else setPendingDialogClose(null);
  }

  const [cleanupOrphanRefsOpen, setCleanupOrphanRefsOpen] = useState(false);
  useSessionDraft(
    isPolicyDirty ||
      isPolicyEditing ||
      tagDetailOpen ||
      teamDetailOpen ||
      highRiskConfirmOpen ||
      policyRemovalDialogOpen ||
      unsavedConfirmOpen ||
      cleanupOrphanRefsOpen ||
      pendingTemplate !== null ||
      discardConfirmOpen,
  );

  function cleanupOrphanRefs() {
    commitState(removeOrphanReferences(policyDesignerState, orphanRefs));
    setCleanupOrphanRefsOpen(false);
  }

  function TagIcon({
    tagName,
    ...props
  }: {
    tagName: string;
    className: string;
    "aria-hidden": "true";
  }) {
    const Icon = tagIcon(tagName);
    return <Icon {...props} />;
  }
  if (policyError) {
    const fileMode = policyError === POLICY_FILE_MODE_WITHOUT_PATH;
    return (
      <section className="space-y-3 sm:space-y-5" dir={meta.dir}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{copy.resourceAccessTitle}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{copy.resourceAccessSubtitle}</p>
          </div>
          <Button size="sm" data-testid="save-policy" disabled>
            <FileCheck2 className="h-4 w-4" aria-hidden="true" />
            {copy.savePolicy}
          </Button>
        </div>
        <p
          data-testid="policy-read-only-notice"
          role={fileMode ? "status" : "alert"}
          className={
            fileMode
              ? "rounded-md border bg-muted/40 px-3 py-2 text-sm"
              : "rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          }
        >
          {policyBlockedMessage(copy, policyError)}
        </p>
      </section>
    );
  }
  return (
    <section className="space-y-3 sm:space-y-5" dir={meta.dir}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{copy.resourceAccessTitle}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{copy.resourceAccessSubtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          {isPolicyDirty && !isActionPending("save-policy") && (
            <Badge
              variant="outline"
              className="border-amber-400/60 bg-amber-50/60 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300"
              data-testid="save-policy-dirty-badge"
            >
              <span
                className="me-1 inline-block h-1.5 w-1.5 motion-safe:animate-pulse rounded-full bg-amber-500"
                aria-hidden="true"
              />
              {copy.unsavedChangesBadge}
            </Badge>
          )}
          {isPolicyDirty && (
            <Button
              size="sm"
              variant="outline"
              data-testid="discard-policy-changes"
              disabled={saving}
              onClick={() => setDiscardConfirmOpen(true)}
            >
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              {copy.discardPolicyChanges}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            data-testid="check-policy"
            disabled={
              !policyPayload || isActionPending("check-policy") || isActionPending("save-policy")
            }
            onClick={() => void checkDraft()}
          >
            {isActionPending("check-policy") ? (
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            )}
            {copy.checkPolicy}
          </Button>
          <Button
            size="sm"
            data-testid="save-policy"
            disabled={!policyPayload || !isPolicyDirty || isActionPending("save-policy")}
            onClick={() => savePolicy()}
          >
            {isActionPending("save-policy") ? (
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <FileCheck2 className="h-4 w-4" aria-hidden="true" />
            )}
            {copy.savePolicy}
          </Button>
        </div>
      </div>

      {!tagDetailOpen && !teamDetailOpen && renderSaveFeedback("")}

      {checkResult?.ok && (
        <p
          role="status"
          data-testid="policy-check-passed"
          className="text-sm text-muted-foreground"
        >
          {copy.policyCheckPassed}
        </p>
      )}

      {checkResult && actionError("check-policy") && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="check-policy-error"
        >
          {actionError("check-policy")}
        </p>
      )}

      {hasGrants && (
        <p
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
          data-testid="grants-preserved-notice"
        >
          {copy.grantsPreservedHint}
        </p>
      )}

      {openAccessWarnings.length > 0 && (
        <div
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="open-access-banner"
        >
          <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
          <div className="grid gap-0.5">
            <p className="font-medium">{copy.openAccessBannerTitle}</p>
            <p className="text-xs">{pluralize(openAccessWarnings.length, "openAccessWarnings")}</p>
          </div>
        </div>
      )}

      {allowsNothing && (
        <div
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="deny-all-banner"
        >
          <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
          <div className="grid gap-0.5">
            <p className="font-medium">{copy.denyAllBannerTitle}</p>
            <p className="text-xs">{copy.denyAllBannerBody}</p>
          </div>
        </div>
      )}

      {orphanRefs.length > 0 && (
        <div
          className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
          data-testid="orphan-ref-banner"
        >
          <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
          <div className="grid gap-0.5 flex-1">
            <p className="font-medium">{copy.orphanRefBannerTitle}</p>
            <p className="text-xs">{pluralize(orphanRefs.length, "orphanReferences")}</p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0 border-amber-400/60 bg-background hover:bg-amber-100/60 dark:hover:bg-amber-500/20"
            data-testid="cleanup-orphan-refs"
            onClick={() => setCleanupOrphanRefsOpen(true)}
          >
            <Eraser className="h-4 w-4" aria-hidden="true" />
            {pluralize(orphanRefs.length, "cleanupOrphans")}
          </Button>
        </div>
      )}

      {isEmptyState ? (
        <div className="rounded-md border bg-card p-6" data-testid="resource-access-empty">
          <div className="text-center">
            <h2 className="text-lg font-semibold">{copy.resourceAccessEmptyTitle}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{copy.resourceAccessEmptyHint}</p>
          </div>

          <p className="mt-5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {copy.templatesSectionTitle}
          </p>
          <div className="mt-2 grid gap-3 md:grid-cols-3">
            {POLICY_TEMPLATES.map((template) => (
              <Card
                key={template.id}
                className="p-3 flex flex-col gap-2"
                data-testid={`template-card-${template.id}`}
              >
                <p className="font-medium">
                  {copy[template.titleKey as keyof typeof copy] as string}
                </p>
                <p className="text-xs text-muted-foreground flex-1">
                  {copy[template.descriptionKey as keyof typeof copy] as string}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid={`template-apply-${template.id}`}
                  onClick={() => applyPolicyTemplate(template)}
                >
                  {copy.applyTemplate}
                </Button>
              </Card>
            ))}
          </div>

          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <Button data-testid="empty-create-team" onClick={() => openCreateTeam()}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              {copy.newTeam}
            </Button>
            <Button
              variant="outline"
              data-testid="empty-create-tag"
              onClick={() => openCreateTag()}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              {copy.newDeviceLabel}
            </Button>
          </div>
        </div>
      ) : (
        <Card className="p-4" data-testid="teams-section">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              {copy.teamsSection}
              <Badge variant="secondary" className="ms-1">
                {policyGroups.length}
              </Badge>
            </h2>
            <Button size="sm" data-testid="new-team" onClick={() => openCreateTeam()}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              {copy.newTeam}
            </Button>
          </div>

          {policyGroups.length === 0 ? (
            <div className="mt-3 rounded-md border border-dashed bg-background/50 px-4 py-6 text-center text-sm text-muted-foreground">
              <p className="font-medium text-foreground">{copy.noTeamsYet}</p>
              <p className="mt-1 text-xs">{copy.noTeamsHint}</p>
            </div>
          ) : (
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {teamsWithMeta.map((team) => (
                <Card
                  key={team.group.id}
                  className="p-3 cursor-pointer hover:bg-accent/30 transition-colors"
                  data-testid={`team-card-${team.group.name}`}
                  onClick={() => openTeamDetailFor(team.group)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="grid gap-0.5 min-w-0">
                      {/* No onClick: the click bubbles to the Card, and Enter/Space produce a click. */}
                      <button
                        type="button"
                        data-testid={`team-open-${team.group.name}`}
                        className="text-start font-medium break-all rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      >
                        {team.displayName}
                      </button>
                      <p className="text-xs text-muted-foreground">
                        {pluralize(team.group.members.length, "teamMembers")}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`${copy.removeTeam} ${team.displayName}`}
                      data-testid={`team-remove-${team.group.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        requestRemoveTeam(team.group);
                      }}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                  {team.group.members.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {team.group.members.slice(0, 4).map((member) => (
                        <Badge key={member.value} variant="outline" className="text-xs">
                          {whoDisplayLabel(member.value)}
                        </Badge>
                      ))}
                      {team.group.members.length > 4 && (
                        <Badge variant="outline" className="text-xs">
                          {pluralize(team.group.members.length - 4, "moreItems")}
                        </Badge>
                      )}
                    </div>
                  ) : (
                    <p
                      className="mt-2 text-xs text-amber-700 dark:text-amber-300"
                      data-testid={`team-empty-warning-${team.group.name}`}
                    >
                      {copy.emptyTeamWarning}
                    </p>
                  )}
                </Card>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Tags already on devices stay visible even while the policy itself is still empty. */}
      {(!isEmptyState || allTags.length > 0) && (
        <Card className="p-4" data-testid="device-labels-section">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold flex items-center gap-2 me-auto">
              <Tag className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              {copy.deviceLabelsSection}
              <Badge variant="secondary" className="ms-1">
                {allTags.length}
              </Badge>
            </h2>
            <div className="relative w-full sm:w-64">
              <Search
                className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                type="search"
                aria-label={copy.searchDeviceLabels}
                placeholder={copy.searchDeviceLabels}
                data-testid="tag-search"
                className="ps-8"
                value={tagSearchQuery}
                onChange={(event) => setTagSearchQuery(event.target.value)}
              />
            </div>
            <Button size="sm" data-testid="new-device-label" onClick={() => openCreateTag()}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              {copy.newDeviceLabel}
            </Button>
          </div>

          {allTags.length === 0 ? (
            <div className="mt-3 rounded-md border border-dashed bg-background/50 px-4 py-6 text-center text-sm text-muted-foreground">
              <p className="font-medium text-foreground">{copy.noDeviceLabelsYet}</p>
              <p className="mt-1 text-xs">{copy.noDeviceLabelsHint}</p>
            </div>
          ) : filteredTagsWithMeta.length === 0 ? (
            <div
              className="mt-3 flex flex-wrap items-center justify-center gap-2 rounded-md border border-dashed bg-background/50 px-4 py-6 text-sm text-muted-foreground"
              data-testid="tag-search-empty"
            >
              <p role="status">{copy.noDeviceLabelsMatch}</p>
              <Button
                size="sm"
                variant="outline"
                data-testid="tag-search-clear"
                onClick={() => setTagSearchQuery("")}
              >
                {copy.clearSearch}
              </Button>
            </div>
          ) : (
            <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {filteredTagsWithMeta.map((t) => (
                <Card
                  key={t.tagName}
                  className="p-3 cursor-pointer hover:border-primary/50 transition-colors"
                  data-testid={`tag-card-${t.tagName}`}
                  onClick={() => openTagDetailFor(t.tagName)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2 min-w-0">
                      <TagIcon
                        className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0"
                        aria-hidden="true"
                        tagName={t.tagName}
                      />
                      <div className="grid gap-0.5 min-w-0">
                        {/* No onClick: the click bubbles to the Card, and Enter/Space produce a click. */}
                        <button
                          type="button"
                          data-testid={`tag-open-${t.tagName}`}
                          className="text-start font-medium break-all rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        >
                          {t.displayName}
                        </button>
                        <p className="text-xs text-muted-foreground">
                          {pluralize(t.deviceCount, "devicesTagged")}
                        </p>
                        {t.deviceOnly && (
                          <Badge variant="outline" className="w-fit text-xs">
                            {copy.deviceOnlyLabelBadge}
                          </Badge>
                        )}
                      </div>
                    </div>
                    {!t.deviceOnly && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`${copy.removeDeviceLabel} ${t.displayName}`}
                        data-testid={`tag-remove-${t.tagName}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          requestRemoveTag(t.tagName);
                        }}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    )}
                  </div>

                  <div className="mt-3 space-y-3 text-sm">
                    <div>
                      <p className="text-xs font-medium text-muted-foreground">
                        {copy.tagAccessorsSection}
                      </p>
                      {t.accessors.length === 0 ? (
                        <p className="mt-1 text-xs text-muted-foreground italic">
                          {copy.noAccessors}
                        </p>
                      ) : (
                        <ul className="mt-1 grid gap-1">
                          {t.accessors.slice(0, 3).map((a) => (
                            <li key={a.who} className="flex items-center gap-1.5">
                              <Badge
                                variant="outline"
                                title={
                                  isOrphanValue(a.who) ? copy.orphanReferenceTooltip : undefined
                                }
                                className={cn([
                                  "inline-flex items-center gap-1 text-xs break-all",
                                  isOrphanValue(a.who)
                                    ? "cursor-help border-amber-300/60 bg-amber-50/60 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300"
                                    : "",
                                ])}
                              >
                                {isOrphanValue(a.who) && (
                                  <UserX className="h-3 w-3 shrink-0" aria-hidden="true" />
                                )}
                                {whoDisplayLabel(a.who)}
                                {isOrphanValue(a.who) && (
                                  <span className="sr-only"> ({copy.orphanReferenceBadge})</span>
                                )}
                              </Badge>
                              <span className="text-xs text-muted-foreground">
                                · {serviceSummary(a.services, a.customPorts)}
                              </span>
                            </li>
                          ))}
                          {t.accessors.length > 3 && (
                            <li className="text-xs text-muted-foreground">
                              {pluralize(t.accessors.length - 3, "moreItems")}
                            </li>
                          )}
                        </ul>
                      )}
                    </div>

                    <div>
                      <p className="text-xs font-medium text-muted-foreground">
                        {copy.labelManagersLabel}
                      </p>
                      {t.owners.length === 0 ? (
                        <p className="mt-1 text-xs text-muted-foreground italic">
                          {copy.noLabelManagers}
                        </p>
                      ) : (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {t.owners.slice(0, 3).map((owner) => (
                            <Badge
                              key={owner}
                              variant={isOrphanValue(owner) ? "outline" : "secondary"}
                              title={isOrphanValue(owner) ? copy.orphanReferenceTooltip : undefined}
                              className={cn([
                                "inline-flex items-center gap-1 text-xs break-all",
                                isOrphanValue(owner)
                                  ? "cursor-help border-amber-300/60 bg-amber-50/60 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300"
                                  : "",
                              ])}
                            >
                              {isOrphanValue(owner) && (
                                <UserX className="h-3 w-3 shrink-0" aria-hidden="true" />
                              )}
                              {whoDisplayLabel(owner)}
                              {isOrphanValue(owner) && (
                                <span className="sr-only"> ({copy.orphanReferenceBadge})</span>
                              )}
                            </Badge>
                          ))}
                          {t.owners.length > 3 && (
                            <Badge variant="secondary" className="text-xs">
                              {pluralize(t.owners.length - 3, "moreItems")}
                            </Badge>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </Card>
      )}

      <Card className="p-4" data-testid="ip-rules-section">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold">
              {copy.ipRulesSectionTitle}
              <Badge variant="outline" className="ms-1">
                {ipRules.length}
              </Badge>
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">{copy.ipRulesSectionHint}</p>
          </div>
          <Button
            ref={addIpRuleButton}
            size="sm"
            variant="outline"
            data-testid="add-ip-rule"
            onClick={() => setPolicyState({ editingIpRuleId: NEW_IP_RULE.ruleId })}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {copy.addIpRule}
          </Button>
        </div>

        <div className="mt-3 grid gap-1">
          {ipRules.length === 0 && editingIpRuleId !== NEW_IP_RULE.ruleId && (
            <p className="text-xs text-muted-foreground italic">{copy.noIpRules}</p>
          )}
          {ipRules.map((rule) => (
            <IpRuleRow
              key={rule.ruleId}
              rule={rule}
              onEditStart={() => setPolicyState({ editingIpRuleId: rule.ruleId })}
              onEditCancel={() => setPolicyState({ editingIpRuleId: null })}
              onRemove={() => requestRemoveIpRule(rule)}
              onUpdate={(patch) => onUpdateIpRule(rule.ruleId, patch)}
              isEditing={editingIpRuleId === rule.ruleId}
            />
          ))}
          {editingIpRuleId === NEW_IP_RULE.ruleId && (
            <IpRuleRow
              rule={NEW_IP_RULE}
              onEditCancel={closeNewIpRule}
              onUpdate={addIpRule}
              isEditing
            />
          )}
        </div>
      </Card>

      <Dialog open={tagDetailOpen} onOpenChange={() => attemptDialogClose("tag")}>
        <DialogContent
          className="sm:max-w-2xl flex flex-col gap-0 p-0 max-h-[85vh] overflow-hidden"
          data-testid="tag-detail-dialog"
        >
          <DialogHeader className="shrink-0 px-6 py-4 border-b">
            <DialogTitle>
              {copy.tagDetailDialogTitle}
              {currentTagMeta && (
                <span className="font-normal text-muted-foreground">
                  {" · "}
                  {currentTagMeta.displayName}
                </span>
              )}
            </DialogTitle>
            <DialogDescription>{copy.tagDetailDialogSubtitle}</DialogDescription>
            {currentTagMeta && (
              <p className="mt-1 text-xs text-muted-foreground">
                {pluralize(currentTagMeta.deviceCount, "devicesTagged")}
              </p>
            )}
          </DialogHeader>

          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
            <div>
              <Label htmlFor="tag-name-input">{copy.deviceLabelName}</Label>
              <div className="mt-2 flex gap-2">
                <Input
                  id="tag-name-input"
                  data-testid="tag-name-input"
                  placeholder={copy.deviceLabelNameHint}
                  readOnly={currentTagMeta?.deviceOnly}
                  aria-invalid={identityIssue ? true : undefined}
                  aria-describedby={identityIssue ? "tag-name-error" : undefined}
                  value={tagNameDraft}
                  onChange={(event) => {
                    ++closeGeneration.current;
                    setTagNameDraft(event.target.value);
                    setIdentityIssue(nameIssue("tag", event.target.value, tagDetailCurrent));
                  }}
                  onBlur={() => commitTagName()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitTagName();
                    }
                  }}
                />
                {!tagDetailCurrent && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!tagNameDraft.trim() || identityIssue !== null}
                    data-testid="tag-name-confirm"
                    onClick={commitTagName}
                  >
                    {copy.confirm}
                  </Button>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{copy.deviceLabelNameHint}</p>
              <p className="mt-1 text-xs text-muted-foreground">{copy.policyTagRenameScope}</p>
              {currentTagMeta?.deviceOnly && (
                <p
                  className="mt-1 text-xs text-amber-700 dark:text-amber-300"
                  data-testid="tag-device-only-hint"
                >
                  {copy.deviceOnlyLabelHint}
                </p>
              )}
              {identityIssue && (
                <p
                  id="tag-name-error"
                  role="alert"
                  data-testid="tag-policy-reference-error"
                  className="mt-2 text-sm text-destructive"
                >
                  {identityErrorText(identityIssue, "tag")}
                </p>
              )}
            </div>

            {tagDetailCurrent && (
              <fieldset
                className="grid gap-2 rounded-md border p-3"
                data-testid="tag-accessors-section"
              >
                <legend className="px-1 text-sm font-medium">{copy.tagAccessorsSection}</legend>

                {currentTagMeta && currentTagMeta.accessors.length === 0 ? (
                  <div className="text-xs text-muted-foreground italic">{copy.noAccessors}</div>
                ) : (
                  <div
                    className="grid gap-2 max-h-80 overflow-y-auto pe-1"
                    data-testid="tag-accessors-list"
                  >
                    {(currentTagMeta?.accessors ?? []).map((a) => (
                      <fieldset
                        key={a.who}
                        aria-label={whoDisplayLabel(a.who)}
                        className="grid min-w-0 gap-2 rounded-md border bg-background p-2"
                        data-testid={`tag-accessor-row-${a.who}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <Badge
                              variant={isOrphanValue(a.who) ? "outline" : "secondary"}
                              title={isOrphanValue(a.who) ? copy.orphanReferenceTooltip : undefined}
                              className={cn([
                                "text-xs",
                                isOrphanValue(a.who)
                                  ? "cursor-help border-amber-300/60 bg-amber-50/60 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300"
                                  : "",
                              ])}
                            >
                              {isOrphanValue(a.who)
                                ? copy.orphanReferenceBadge
                                : whoDisplayKind(a.who)}
                            </Badge>
                            <bdi dir="auto" className="font-medium break-all">
                              {whoDisplayLabel(a.who)}
                            </bdi>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label={`${copy.removeAccessor} ${whoDisplayLabel(a.who)}`}
                            data-testid={`tag-accessor-remove-${a.who}`}
                            onClick={() => removeAccessor(a.who)}
                          >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                          </Button>
                        </div>
                        <div className="flex flex-wrap gap-3 text-sm">
                          {SERVICE_DEFS.map((def) => (
                            <label
                              key={def.id}
                              htmlFor={`tag-accessor-svc-${a.who}-${def.id}`}
                              className="flex items-center gap-1.5 cursor-pointer"
                            >
                              <Checkbox
                                id={`tag-accessor-svc-${a.who}-${def.id}`}
                                data-testid={`tag-accessor-svc-${a.who}-${def.id}`}
                                checked={a.services.includes(def.id)}
                                disabled={a.readOnly}
                                onCheckedChange={() => toggleAccessorService(a, def.id)}
                              />
                              <span>{copy[def.labelKey]}</span>
                            </label>
                          ))}
                          <label
                            htmlFor={`tag-accessor-svc-${a.who}-all`}
                            className="flex items-center gap-1.5 cursor-pointer"
                          >
                            <Checkbox
                              id={`tag-accessor-svc-${a.who}-all`}
                              data-testid={`tag-accessor-svc-${a.who}-all`}
                              checked={a.services.includes("all")}
                              disabled={a.readOnly}
                              onCheckedChange={() => toggleAccessorService(a, "all")}
                            />
                            <span>{copy.svcAllLabel}</span>
                          </label>
                        </div>
                        <div className="grid gap-1.5">
                          <Label htmlFor={`tag-accessor-custom-${a.who}`} className="text-xs">
                            {copy.svcCustomLabel}
                          </Label>
                          <Input
                            id={`tag-accessor-custom-${a.who}`}
                            dir="ltr"
                            className="h-8 text-xs"
                            placeholder={copy.svcCustomPlaceholder}
                            data-testid={`tag-accessor-custom-${a.who}`}
                            disabled={a.readOnly}
                            value={customPortsFor(a)}
                            onChange={(event) => {
                              ++closeGeneration.current;
                              setPortDraft(portDraftKey(a.who), event.target.value);
                            }}
                            onBlur={() => commitCustomPorts(a)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                commitCustomPorts(a);
                              }
                            }}
                          />
                        </div>
                        {a.readOnly && (
                          <p className="text-xs text-muted-foreground">
                            {copy.policyAdvancedRuleHint}
                          </p>
                        )}
                      </fieldset>
                    ))}
                  </div>
                )}

                <MemberPicker
                  options={accessorOptionsForCurrentTag}
                  testid="tag-add-accessor"
                  onPick={addAccessor}
                  triggerLabel={copy.addAccessor}
                  searchPlaceholder={copy.selectAccessorSearchPlaceholder}
                  emptyText={copy.selectAccessorEmpty}
                />
              </fieldset>
            )}

            {tagDetailCurrent && (
              <fieldset
                className="grid gap-2 rounded-md border p-3"
                data-testid="tag-owners-section"
              >
                <legend className="px-1 text-sm font-medium">{copy.tagOwnersSection}</legend>

                {tagOwnerValues.length === 0 ? (
                  <div className="text-xs text-muted-foreground italic">{copy.noLabelManagers}</div>
                ) : (
                  <div
                    className="grid gap-1 max-h-64 overflow-y-auto pe-1"
                    data-testid="tag-owners-list"
                  >
                    {tagOwnerValues.map((owner) => (
                      <div
                        key={owner}
                        className="flex items-center justify-between gap-2 rounded-md border bg-background p-2"
                        data-testid={`tag-owner-row-${owner}`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <Badge
                            variant={isOrphanValue(owner) ? "outline" : "secondary"}
                            title={isOrphanValue(owner) ? copy.orphanReferenceTooltip : undefined}
                            className={cn([
                              "text-xs",
                              isOrphanValue(owner)
                                ? "cursor-help border-amber-300/60 bg-amber-50/60 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300"
                                : "",
                            ])}
                          >
                            {isOrphanValue(owner)
                              ? copy.orphanReferenceBadge
                              : whoDisplayKind(owner)}
                          </Badge>
                          <span className="font-medium break-all">{whoDisplayLabel(owner)}</span>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`${copy.removeLabelManager} ${whoDisplayLabel(owner)}`}
                          data-testid={`tag-owner-remove-${owner}`}
                          onClick={() => removeLabelManager(owner)}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                <MemberPicker
                  options={ownerOptionsForCurrentTag}
                  testid="tag-add-owner"
                  onPick={addLabelManager}
                  triggerLabel={copy.addLabelManager}
                  searchPlaceholder={copy.selectLabelManagerSearchPlaceholder}
                  emptyText={copy.selectLabelManagerEmpty}
                />
              </fieldset>
            )}
          </div>

          {hasSaveFeedback && (
            <div className="shrink-0 border-t px-6 py-3">{renderSaveFeedback("dialog-")}</div>
          )}
          <DialogFooter className="shrink-0 px-6 py-4 border-t flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            {isPolicyDirty ? (
              <p
                className="flex items-center gap-1.5 rounded-md border border-amber-400/60 bg-amber-50/60 px-2 py-1 text-xs text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300 sm:text-start"
                data-testid="tag-dialog-unsaved-hint"
              >
                <span
                  className="inline-block h-1.5 w-1.5 motion-safe:animate-pulse rounded-full bg-amber-500"
                  aria-hidden="true"
                />
                {copy.dialogChangesKeptHint}
              </p>
            ) : (
              <span className="text-xs text-muted-foreground">&nbsp;</span>
            )}
            <Button
              data-testid="tag-detail-close"
              disabled={saving}
              onClick={() => closeDialog("tag")}
            >
              {saving && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {copy.finish}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={teamDetailOpen} onOpenChange={() => attemptDialogClose("team")}>
        <DialogContent
          className="sm:max-w-2xl flex flex-col gap-0 p-0 max-h-[85vh] overflow-hidden"
          data-testid="team-detail-dialog"
        >
          <DialogHeader className="shrink-0 px-6 py-4 border-b">
            <DialogTitle>
              {copy.teamDetailDialogTitle}
              {currentTeamMeta && (
                <span className="font-normal text-muted-foreground">
                  {" · "}
                  {currentTeamMeta.displayName}
                </span>
              )}
            </DialogTitle>
            <DialogDescription>{copy.teamNameHint}</DialogDescription>
          </DialogHeader>

          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
            <div>
              <Label htmlFor="team-name-input">{copy.teamName}</Label>
              <div className="mt-2 flex gap-2">
                <Input
                  id="team-name-input"
                  data-testid="team-name-input"
                  placeholder={copy.teamNameHint}
                  aria-invalid={identityIssue ? true : undefined}
                  aria-describedby={identityIssue ? "team-name-error" : undefined}
                  value={teamNameDraft}
                  onChange={(event) => {
                    ++closeGeneration.current;
                    setTeamNameDraft(event.target.value);
                    setIdentityIssue(nameIssue("group", event.target.value, teamDetailCurrent));
                  }}
                  onBlur={() => commitTeamName()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitTeamName();
                    }
                  }}
                />
                {!teamDetailCurrent && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!teamNameDraft.trim() || identityIssue !== null}
                    data-testid="team-name-confirm"
                    onClick={commitTeamName}
                  >
                    {copy.confirm}
                  </Button>
                )}
              </div>
            </div>

            {identityIssue && (
              <p
                id="team-name-error"
                role="alert"
                data-testid="team-policy-reference-error"
                className="text-sm text-destructive"
              >
                {identityErrorText(identityIssue, "group")}
              </p>
            )}
            {teamDetailCurrent && (
              <fieldset
                className="grid gap-2 rounded-md border p-3"
                data-testid="team-members-section"
              >
                <legend className="px-1 text-sm font-medium">{copy.teamMembersSection}</legend>

                {teamMembers.length === 0 ? (
                  <div className="text-xs text-muted-foreground italic">
                    {copy.noPolicyGroupMembers}
                  </div>
                ) : (
                  <div
                    className="grid gap-1 max-h-64 overflow-y-auto pe-1"
                    data-testid="team-members-list"
                  >
                    {teamMembers.map((m) => (
                      <div
                        key={m.value}
                        className="flex items-center justify-between gap-2 rounded-md border bg-background p-2"
                        data-testid={`team-member-row-${m.value}`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <Badge
                            variant={isOrphanValue(m.value) ? "outline" : "secondary"}
                            title={isOrphanValue(m.value) ? copy.orphanReferenceTooltip : undefined}
                            className={cn([
                              "text-xs",
                              isOrphanValue(m.value)
                                ? "cursor-help border-amber-300/60 bg-amber-50/60 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300"
                                : "",
                            ])}
                          >
                            {isOrphanValue(m.value)
                              ? copy.orphanReferenceBadge
                              : whoDisplayKind(m.value)}
                          </Badge>
                          <bdi dir="auto" className="font-medium break-all">
                            {whoDisplayLabel(m.value)}
                          </bdi>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`${copy.removeTeamMember} ${whoDisplayLabel(m.value)}`}
                          data-testid={`team-member-remove-${m.value}`}
                          onClick={() => removeTeamMember(m.value)}
                        >
                          <X className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                <MemberPicker
                  options={memberOptionsForCurrentTeam}
                  testid="team-add-member"
                  onPick={addTeamMember}
                  triggerLabel={copy.addMemberToTeam}
                  searchPlaceholder={copy.selectMemberSearchPlaceholder}
                  emptyText={copy.selectMemberEmpty}
                />
              </fieldset>
            )}

            {teamDetailCurrent && (
              <fieldset className="grid gap-2 rounded-md border p-3" data-testid="team-access-view">
                <legend className="px-1 text-sm font-medium">{copy.teamAccessView}</legend>
                <p className="text-xs text-muted-foreground">{copy.teamAccessViewHint}</p>
                {teamAccessRows.length === 0 ? (
                  <div className="text-xs text-muted-foreground italic">{copy.noTeamAccess}</div>
                ) : (
                  <div
                    className="grid gap-1 max-h-64 overflow-y-auto pe-1"
                    data-testid="team-access-list"
                  >
                    {teamAccessRows.map((row) => (
                      <div
                        key={row.tagName}
                        className="flex items-center justify-between gap-2 rounded-md border bg-background p-2 text-sm"
                        data-testid={`team-access-row-${row.tagName}`}
                      >
                        <span className="break-all">{stripTagPrefix(row.tagName)}</span>
                        <span className="text-xs text-muted-foreground">
                          {serviceSummary(row.services, row.customPorts)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </fieldset>
            )}
          </div>

          {hasSaveFeedback && (
            <div className="shrink-0 border-t px-6 py-3">{renderSaveFeedback("dialog-")}</div>
          )}
          <DialogFooter className="shrink-0 px-6 py-4 border-t flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            {isPolicyDirty ? (
              <p
                className="flex items-center gap-1.5 rounded-md border border-amber-400/60 bg-amber-50/60 px-2 py-1 text-xs text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300 sm:text-start"
                data-testid="team-dialog-unsaved-hint"
              >
                <span
                  className="inline-block h-1.5 w-1.5 motion-safe:animate-pulse rounded-full bg-amber-500"
                  aria-hidden="true"
                />
                {copy.dialogChangesKeptHint}
              </p>
            ) : (
              <span className="text-xs text-muted-foreground">&nbsp;</span>
            )}
            <Button
              data-testid="team-detail-close"
              disabled={saving}
              onClick={() => closeDialog("team")}
            >
              {saving && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {copy.finish}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={highRiskConfirmOpen}
        onOpenChange={(open) => setPolicyState({ highRiskConfirmOpen: open })}
      >
        <AlertDialogContent data-testid="high-risk-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.highRiskConfirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>{copy.highRiskConfirmDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="high-risk-cancel" onClick={() => cancelHighRisk()}>
              {copy.cancel}
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="high-risk-confirm"
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => confirmHighRisk()}
            >
              {copy.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={policyRemovalDialogOpen} onOpenChange={closePolicyRemovalDialog}>
        <AlertDialogContent data-testid="remove-policy-item-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.confirmRemovePolicyItemTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {copy.confirmRemovePolicyItemDescription}
              {pendingPolicyRemoval && (
                <span className="mt-2 block break-all font-medium text-foreground">
                  <bdi dir={pendingPolicyRemoval.kind === "rule" ? "ltr" : "auto"}>
                    {pendingPolicyRemoval.label}
                  </bdi>
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removalPreview && !removalPreview.ok && (
            <p role="alert" data-testid="policy-removal-error" className="text-sm text-destructive">
              {identityErrorText(removalPreview.issue, removalKind)}
            </p>
          )}
          {pendingPolicyRemoval?.kind === "rule" && (
            <p data-testid="policy-removal-consequence" className="text-sm text-muted-foreground">
              {copy.removeIpRuleConsequence}
            </p>
          )}
          {removalDevices > 0 && (
            <p data-testid="policy-removal-devices" className="text-sm text-muted-foreground">
              {pluralize(removalDevices, "labelRemovalDevices")}
            </p>
          )}
          {removalImpact && (
            <p data-testid="policy-removal-impact" className="text-sm text-muted-foreground">
              {copy.policyIdentityRemovalImpact
                .replace("{rules}", String(removalImpact.rules))
                .replace("{tests}", String(removalImpact.tests))}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="cancel-remove-policy-item">
              {copy.cancel}
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirm-remove-policy-item"
              disabled={!removalNext}
              className="bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40"
              onClick={confirmRemovePolicyItem}
            >
              {copy.removeItem}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={unsavedConfirmOpen} onOpenChange={(open) => setUnsavedConfirmOpen(open)}>
        <AlertDialogContent data-testid="unsaved-changes-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.unsavedChangesTitle}</AlertDialogTitle>
            <AlertDialogDescription>{copy.dialogUnsavedChangesBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="unsaved-changes-keep-editing">
              {copy.cancel}
            </AlertDialogCancel>
            <Button
              type="button"
              variant="outline"
              data-testid="unsaved-changes-discard"
              disabled={saving}
              onClick={() => discardAndClose()}
            >
              {copy.discardDialogChanges}
            </Button>
            <Button
              type="button"
              data-testid="unsaved-changes-save"
              disabled={saving}
              onClick={() => saveAndClose()}
            >
              {saving && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {copy.unsavedChangesSaveAndClose}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={cleanupOrphanRefsOpen}
        onOpenChange={(open) => setCleanupOrphanRefsOpen(open)}
      >
        <AlertDialogContent data-testid="cleanup-orphans-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.cleanupOrphanRefsConfirm}</AlertDialogTitle>
            <AlertDialogDescription>{copy.cleanupOrphanRefsConfirmBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="cleanup-orphans-cancel">
              {copy.cancel}
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="cleanup-orphans-confirm"
              onClick={() => cleanupOrphanRefs()}
            >
              {pluralize(orphanRefs.length, "cleanupOrphans")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* No trigger, so Base UI only ever asks to close it. */}
      <AlertDialog open={pendingTemplate !== null} onOpenChange={() => setPendingTemplate(null)}>
        <AlertDialogContent data-testid="template-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.templateReplaceTitle}</AlertDialogTitle>
            <AlertDialogDescription>{copy.templateReplaceBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="grid gap-1 text-sm" data-testid="template-confirm-removed">
            {replacedRules.map((rule) => (
              <li key={rule.id} className="break-all rounded-md border px-3 py-2 font-mono text-xs">
                <bdi dir="ltr">
                  {rule.source} → {rule.destination} · {rule.ports}
                </bdi>
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="template-confirm-cancel">
              {copy.cancel}
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="template-confirm-apply"
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => confirmPolicyTemplate()}
            >
              {copy.templateReplaceConfirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={discardConfirmOpen} onOpenChange={setDiscardConfirmOpen}>
        <AlertDialogContent data-testid="discard-policy-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.discardPolicyChangesTitle}</AlertDialogTitle>
            <AlertDialogDescription>{copy.discardPolicyChangesBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="discard-policy-cancel">{copy.cancel}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="discard-policy-confirm"
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={saving}
              onClick={() => discardPolicyChanges()}
            >
              {copy.discardPolicyChanges}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
